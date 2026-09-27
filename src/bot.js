import fs from 'node:fs';
import path from 'node:path';
import { formatUnits, getAddress, Wallet } from 'ethers';
import { createProviders, verifyProviders } from './rpc/providers.js';
import { FablesAdapter, lifecycleEventType, lifecycleLiquidity } from './adapters/fables.js';
import { RebalanceExecutor } from './adapters/executor.js';
import { V4QuoterAdapter } from './adapters/quoter.js';
import { fetchFablesPoolStats } from './adapters/fables-stats.js';
import { buildUsdPriceMap } from './analytics/prices.js';
import { PortfolioAnalytics } from './analytics/portfolio.js';
import { PointsTracker } from './analytics/points-tracker.js';
import { buildDepositPlan } from './analytics/rebalance-plan.js';
import { evaluatePosition, outOfRangeExcursionPct } from './strategy.js';
import { LedgerStore } from './ledger.js';
import { StateStore } from './state.js';
import { normalizeRuntimeIntervals } from './config.js';
import { persistRuntimeCredentials } from './runtime-credentials.js';
import { DEFAULT_RPC_URL, ZERO_ADDRESS } from './constants.js';
import { isLpOutOfRange } from './math/ticks.js';
import { log, registerSensitiveValues } from './logger.js';

export class AutoLpBot {
  constructor(config) {
    this.config = config;
    this.baseExecutionTarget = {
      mode: config.targetMode,
      poolIds: [...(config.targetPoolIds || [])],
      symbols: [...(config.targetSymbols || [])]
    };
    registerSensitiveValues([...(config.rpcUrls || []), config.privateKey || '']);
    this.baseDataDir = config.dataDir;
    this.baseStateFile = config.stateFile;
    this.preferenceState = new StateStore(path.join(this.baseDataDir, 'dashboard-settings.json'));
    const savedIntervals = this.preferenceState.getSetting('runtimeIntervals', null);
    if (savedIntervals) Object.assign(this.config, normalizeRuntimeIntervals({ ...this.getRuntimeIntervals(), ...savedIntervals }));
    this.initialWalletAddress = config.walletAddress.toLowerCase();
    const savedWalletDir = path.join(this.baseDataDir, 'wallets', this.initialWalletAddress);
    const savedWalletState = path.join(savedWalletDir, 'bot-state.json');
    if (fs.existsSync(savedWalletState)) {
      this.config.dataDir = savedWalletDir;
      this.config.stateFile = savedWalletState;
    }
    this.walletProfiles = new Map([[this.initialWalletAddress, {
      address: config.walletAddress,
      privateKey: config.privateKey || '',
      type: config.privateKey ? 'environment' : 'watch-only',
      importedAt: null
    }]]);
    this.walletImportState = config.walletAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()
      ? { status: 'failed', address: config.walletAddress, error: '尚未設定有效的監控錢包地址' }
      : { status: 'scanning', address: config.walletAddress, error: null };
    this.providers = createProviders(config);
    this.state = new StateStore(config.stateFile);
    this.applyStoredExecutionTarget();
    this.ledger = new LedgerStore(config.dataDir);
    this.fables = new FablesAdapter(this.providers.readProvider, config);
    this.quoter = new V4QuoterAdapter(this.providers.readProvider);
    this.analytics = new PortfolioAnalytics(config, this.ledger, this.state);
    this.points = new PointsTracker(config, this.ledger, this.state);
    this.market = { refreshedAt: 0, pools: [], prices: new Map(), latestBlock: 0, fablesStats: null };
    this.rpcHealth = [];
    this.executionPaused = true;
    this.state.setSetting('executionPaused', true);
    this.snapshot = this.ledger.readSnapshot();
    this.running = false;
    this.cycleActive = false;
    this.pointsSimulationTimer = null;
    this.blockTimeCache = new Map();
    this.executor = new RebalanceExecutor(
      this.providers.readProvider,
      this.providers.writeProvider,
      config,
      this.fables,
      this.ledger,
      (address) => this.market.prices.get(String(address).toLowerCase()) || 0,
      this.state
    );
  }

  async initialize() {
    this.rpcHealth = await verifyProviders(this.providers.rawProviders, this.config.chainId);
    log('info', 'rpc.health', { endpoints: this.rpcHealth.map((x) => ({ index: x.index, ok: x.ok, chainId: x.chainId })) });
    await this.refreshMarket(true);
  }

  setExecutionPaused(value, source = 'system') {
    const next = Boolean(value);
    if (!next) {
      const activeExecution = this.state.getSetting('activeRebalanceExecution', null);
      const terminal = new Set(['completed', 'failed']);
      if (activeExecution?.phase && !terminal.has(activeExecution.phase)) {
        throw new Error(`Cannot resume while rebalance execution requires review: ${activeExecution.phase}`);
      }
    }
    this.executionPaused = next;
    this.state.setSetting('executionPaused', this.executionPaused);
    this.ledger.append('execution.control', { paused: this.executionPaused, source });
    if (this.snapshot?.bot) this.snapshot.bot.executionPaused = this.executionPaused;
    log('warn', 'execution.control', { paused: this.executionPaused, source });
  }

  async controlStatus() {
    const activeExecution = this.state.getSetting('activeRebalanceExecution', null);
    const signerConfigured = Boolean(this.config.privateKey);
    const guardConfigured = Boolean(this.config.eip7702GuardAddress);
    const guardVerifiedFlag = Boolean(this.config.eip7702GuardVerified);
    let guardRuntimeReady = false;
    let guardError = null;
    if (guardConfigured && guardVerifiedFlag) {
      try {
        await this.executor.assertAtomicGuardReady();
        guardRuntimeReady = true;
      } catch (error) {
        guardError = error.shortMessage || error.message;
      }
    }
    const topologyCooldownUntil = Number(this.state.getSetting('walletTopologyCooldownUntil', 0) || 0);
    const recoveryRequired = activeExecution?.phase === 'recovery_required';
    const terminalExecution = new Set(['completed', 'failed']);
    const executionBusy = Boolean(activeExecution?.phase && !terminalExecution.has(activeExecution.phase));
    const liveReady = !this.config.dryRun
      && this.config.enableLiveWrites
      && this.config.enableAutoRedeploy
      && signerConfigured
      && guardConfigured
      && guardVerifiedFlag
      && guardRuntimeReady
      && !this.executionPaused
      && !this.cycleActive
      && !executionBusy
      && !recoveryRequired;
    const startBlockers = [];
    const selectedTargetPoolId = this.getSelectedExecutionTargetPoolId();
    if (!selectedTargetPoolId) startBlockers.push('target-required');
    else if (!this.market.pools.some((pool) => pool.id.toLowerCase() === selectedTargetPoolId)) startBlockers.push('target-unavailable');
    const selectedPool = this.snapshot?.pools?.find((pool) => pool.id.toLowerCase() === selectedTargetPoolId);
    const activeLp = Boolean(selectedPool?.positions?.some((position) => BigInt(position.shares || 0) > 0n));
    if (!this.config.walletAddress || this.config.walletAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      startBlockers.push('wallet-address-missing');
    } else if (this.walletImportState.status !== 'ready') {
      startBlockers.push(`wallet-${this.walletImportState.status || 'not-ready'}`);
    }
    if (!this.rpcHealth.some((item) => item.ok && Number(item.chainId) === this.config.chainId)) startBlockers.push('rpc-not-ready');
    if (this.cycleActive) startBlockers.push('cycle-active');
    if (recoveryRequired) startBlockers.push('recovery-required');
    else if (executionBusy) startBlockers.push('execution-busy');
    if (!this.config.dryRun) {
      if (!activeLp) startBlockers.push('active-lp-required');
      const snapshotAge = Date.now() - Number(this.snapshot?.generatedAt || 0);
      if (snapshotAge > Math.max(120_000, this.config.pollIntervalMs * 3)) startBlockers.push('wallet-snapshot-stale');
      if (!this.config.enableLiveWrites) startBlockers.push('live-writes-disabled');
      if (!this.config.enableAutoRedeploy) startBlockers.push('auto-redeploy-disabled');
      if (!signerConfigured) startBlockers.push('signer-required');
      if (!guardConfigured || !guardVerifiedFlag || !guardRuntimeReady) startBlockers.push('guard-not-ready');
    }

    return {
      generatedAt: Date.now(),
      mode: this.config.dryRun ? 'dry-run' : 'live',
      walletAddress: this.config.walletAddress,
      walletImportState: this.walletImportState,
      walletProfiles: [...this.walletProfiles.values()].map((profile) => ({
        address: profile.address,
        type: profile.type,
        signerConfigured: Boolean(profile.privateKey),
        importedAt: profile.importedAt,
        active: profile.address.toLowerCase() === this.config.walletAddress.toLowerCase()
      })),
      rpc: {
        customConfigured: this.config.rpcUrls.some((url) => url !== DEFAULT_RPC_URL),
        endpointCount: this.config.rpcUrls.length,
        chainId: this.config.chainId
      },
      runtimeIntervals: this.getRuntimeIntervals(),
      targetMode: this.config.targetMode,
      selectedExecutionTargetPoolId: selectedTargetPoolId || null,
      dryRun: this.config.dryRun,
      liveWrites: this.config.enableLiveWrites,
      autoRedeploy: this.config.enableAutoRedeploy,
      executionPaused: this.executionPaused,
      cycleActive: this.cycleActive,
      signerConfigured,
      credentialPersistenceEnabled: Boolean(this.config.persistRuntimeCredentials),
      guard: {
        address: this.config.eip7702GuardAddress || null,
        configured: guardConfigured,
        verifiedFlag: guardVerifiedFlag,
        runtimeReady: guardRuntimeReady,
        error: guardError
      },
      activeRebalanceExecution: activeExecution,
      recoveryRequired,
      executionBusy,
      topologyCooldownUntil,
      liveReady,
      startReadiness: { ready: startBlockers.length === 0, blockers: startBlockers },
      limits: {
        maxGasGwei: this.config.maxGasGwei,
        withdrawSlippageBps: this.config.withdrawSlippageBps,
        swapSlippageBps: this.config.swapSlippageBps,
        depositSlippageBps: this.config.depositSlippageBps,
        minRebalanceIntervalSec: this.config.minRebalanceIntervalSec,
        maxRebalancesPerHour: this.config.maxRebalancesPerHour
      },
      strategy: {
        absoluteInRangeHold: true,
        tightWidthBps: this.config.tightWidthBps,
        rangePreset: this.config.rangePreset,
        ...rangePolicySnapshot(this.config)
      }
    };
  }

  getRuntimeIntervals() {
    return {
      marketRefreshMs: this.config.marketRefreshMs,
      rangeCheckIntervalMs: this.config.rangeCheckIntervalMs,
      pointsSimulationIntervalMs: this.config.pointsSimulationIntervalMs
    };
  }

  setRuntimeIntervals(values = {}) {
    const previous = this.getRuntimeIntervals();
    const intervals = normalizeRuntimeIntervals({ ...this.getRuntimeIntervals(), ...values });
    Object.assign(this.config, intervals);
    this.preferenceState.setSetting('runtimeIntervals', intervals);
    if (intervals.marketRefreshMs !== previous.marketRefreshMs) this.market.refreshedAt = 0;
    if (intervals.pointsSimulationIntervalMs !== previous.pointsSimulationIntervalMs) {
      this.points?.invalidate();
      this.updatePointsSnapshot(true);
      this.schedulePointsSimulation();
    }
    log('info', 'dashboard.intervals_updated', intervals);
    return intervals;
  }

  updatePointsSnapshot(force = false) {
    const points = this.points.snapshot({ force });
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, points };
      this.ledger.writeSnapshot(this.snapshot);
    }
    return points;
  }

  schedulePointsSimulation() {
    if (this.pointsSimulationTimer) clearTimeout(this.pointsSimulationTimer);
    this.pointsSimulationTimer = null;
    if (!this.running) return;
    this.pointsSimulationTimer = setTimeout(async () => {
      this.pointsSimulationTimer = null;
      if (!this.running) return;
      try {
        const tracker = this.points;
        await tracker.refreshEvidence({
          address: this.config.walletAddress,
          provider: this.providers.readProvider,
          pools: this.market.pools,
          prices: this.market.prices
        });
        if (this.running && tracker === this.points) this.updatePointsSnapshot(true);
      }
      catch (error) { log('warn', 'points.simulation_failed', { error: error.message }); }
      this.schedulePointsSimulation();
    }, this.config.pointsSimulationIntervalMs);
    this.pointsSimulationTimer.unref?.();
  }

  async setRpcEndpoint(value) {
    if (this.cycleActive) throw new Error('Wait for the current monitor cycle before changing RPC');
    const endpoint = String(value || '').trim();
    if (endpoint.length > 2048) throw new Error('RPC endpoint is too long');
    let parsed;
    try { parsed = new URL(endpoint); }
    catch { throw new Error('Enter a valid Robinhood Chain RPC URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('RPC must use HTTP(S) and must not include URL username or password');
    }

    const urls = endpoint === DEFAULT_RPC_URL ? [endpoint] : [endpoint, DEFAULT_RPC_URL];
    const nextProviders = createProviders({ ...this.config, rpcUrls: urls });
    const health = await verifyProviders(nextProviders.rawProviders, this.config.chainId);
    if (!health[0]?.ok || health[0].chainId !== this.config.chainId) {
      throw new Error('RPC endpoint did not verify as Robinhood Chain (chain ID 4663)');
    }

    persistRuntimeCredentials({
      rpcUrls: urls,
      walletAddress: this.config.walletAddress,
      privateKey: this.config.privateKey
    }, { enabled: this.config.persistRuntimeCredentials });

    this.config.rpcUrls = urls;
    registerSensitiveValues([...urls, ...[...this.walletProfiles.values()].map((profile) => profile.privateKey)]);
    this.providers = nextProviders;
    this.rpcHealth = health;
    this.fables = new FablesAdapter(this.providers.readProvider, this.config);
    this.quoter = new V4QuoterAdapter(this.providers.readProvider);
    this.executor = this.createExecutor();
    this.market.refreshedAt = 0;
    await this.refreshMarket(true);
    return { ok: true, chainId: this.config.chainId, endpointCount: urls.length };
  }

  async mountWallet(addressValue, privateKey, type) {
    if (this.cycleActive) throw new Error('Wait for the current monitor cycle before mounting another wallet');
    const activeExecution = this.state.getSetting('activeRebalanceExecution', null);
    if (activeExecution?.phase && !new Set(['completed', 'failed']).has(activeExecution.phase)) {
      throw new Error('Resolve the active wallet recovery journal before switching wallets');
    }

    let address;
    try { address = getAddress(addressValue); }
    catch { throw new Error('Wallet address did not validate'); }
    if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new Error('Zero address cannot be used as a monitoring wallet');
    }
    let normalizedKey = '';
    if (privateKey) {
      try {
        const signer = new Wallet(privateKey);
        if (signer.address.toLowerCase() !== address.toLowerCase()) {
          throw new Error('address mismatch');
        }
        normalizedKey = signer.privateKey;
      } catch {
        throw new Error('Wallet signer did not validate for this address');
      }
    }

    const profile = {
      address,
      privateKey: normalizedKey,
      type,
      importedAt: Date.now()
    };
    persistRuntimeCredentials({
      rpcUrls: this.config.rpcUrls,
      walletAddress: profile.address,
      privateKey: profile.privateKey
    }, { enabled: this.config.persistRuntimeCredentials });
    this.walletProfiles.set(address.toLowerCase(), profile);
    registerSensitiveValues([
      ...(this.config.rpcUrls || []),
      ...[...this.walletProfiles.values()].map((item) => item.privateKey)
    ]);
    this.activateWalletProfile(profile);
    return { ok: true, address, status: this.walletImportState.status };
  }

  switchWallet(addressValue) {
    if (this.cycleActive) throw new Error('Wait for the current monitor cycle before switching wallets');
    const profile = this.walletProfiles.get(String(addressValue || '').toLowerCase());
    if (!profile) throw new Error('Wallet is not mounted in this session');
    persistRuntimeCredentials({
      rpcUrls: this.config.rpcUrls,
      walletAddress: profile.address,
      privateKey: profile.privateKey
    }, { enabled: this.config.persistRuntimeCredentials });
    this.activateWalletProfile(profile);
    return { ok: true, address: profile.address, status: this.walletImportState.status };
  }

  setWatchedPool(poolId, watch) {
    const normalized = String(poolId || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('Invalid pool ID');
    if (!this.market.pools.some((pool) => pool.id.toLowerCase() === normalized)) {
      throw new Error('Pool is not present in the current Fables registry');
    }
    const ids = new Set((this.state.getSetting('watchedPoolIds', []) || []).map((id) => String(id).toLowerCase()));
    if (watch) ids.add(normalized);
    else ids.delete(normalized);
    this.state.setSetting('watchedPoolIds', [...ids].sort());
    return [...ids];
  }

  getSelectedExecutionTargetPoolId() {
    return String(this.state?.getSetting('selectedExecutionTargetPoolId', '') || '').toLowerCase();
  }

  applyStoredExecutionTarget() {
    const selectedPoolId = this.getSelectedExecutionTargetPoolId();
    if (selectedPoolId && !/^0x[0-9a-f]{64}$/.test(selectedPoolId)) {
      throw new Error('Stored execution target pool is invalid; refusing to start');
    }
    this.config.targetMode = selectedPoolId ? 'allowlist' : this.baseExecutionTarget.mode;
    this.config.targetPoolIds = selectedPoolId ? [selectedPoolId] : [...this.baseExecutionTarget.poolIds];
    this.config.targetSymbols = selectedPoolId ? [] : [...this.baseExecutionTarget.symbols];
  }

  setExecutionTargetPool(poolId = '') {
    if (this.cycleActive) throw new Error('Wait for the current monitor cycle before changing the execution target');
    const normalized = String(poolId || '').trim().toLowerCase();
    if (normalized && !/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('Invalid pool ID');
    const pool = normalized ? this.market.pools.find((item) => item.id.toLowerCase() === normalized) : null;
    if (normalized && !pool) throw new Error('Pool is not present in the current Fables registry');

    this.state.setSetting('selectedExecutionTargetPoolId', normalized);
    this.applyStoredExecutionTarget();
    log('info', 'dashboard.execution_target_updated', {
      poolId: normalized || null,
      pair: pool ? `${pool.token0.symbol}/${pool.token1.symbol}` : null,
      targetMode: this.config.targetMode
    });
    return {
      poolId: normalized || null,
      pair: pool ? `${pool.token0.symbol}/${pool.token1.symbol}` : null,
      targetMode: this.config.targetMode
    };
  }

  async startExecution(source = 'dashboard') {
    const status = await this.controlStatus();
    if (!status.startReadiness.ready) {
      return { ok: false, blockers: status.startReadiness.blockers };
    }
    this.setExecutionPaused(false, source);
    return { ok: true, executionPaused: false, mode: status.mode };
  }

  activateWalletProfile(profile) {
    this.config.walletAddress = profile.address;
    this.config.privateKey = profile.privateKey || '';
    this.config.dryRun = true;
    this.config.enableLiveWrites = false;
    this.config.enableAutoRedeploy = false;
    this.executionPaused = true;

    const lowerAddress = profile.address.toLowerCase();
    const walletDir = path.join(this.baseDataDir, 'wallets', lowerAddress);
    if (lowerAddress === this.initialWalletAddress && !fs.existsSync(path.join(walletDir, 'bot-state.json'))) {
      this.config.dataDir = this.baseDataDir;
      this.config.stateFile = this.baseStateFile;
    } else {
      this.config.dataDir = walletDir;
      this.config.stateFile = path.join(walletDir, 'bot-state.json');
    }
    this.state = new StateStore(this.config.stateFile);
    this.applyStoredExecutionTarget();
    this.ledger = new LedgerStore(this.config.dataDir);
    this.analytics = new PortfolioAnalytics(this.config, this.ledger, this.state);
    this.points = new PointsTracker(this.config, this.ledger, this.state);
    this.state.setSetting('executionPaused', true);
    this.fables.positionCandidates.clear();
    this.market.refreshedAt = 0;
    this.snapshot = this.ledger.readSnapshot();
    this.walletImportState = { status: 'scanning', address: profile.address, error: null };
    this.executor = this.createExecutor();

    const address = profile.address.toLowerCase();
    void this.runOnce({ executeRebalances: false, source: 'wallet-import' })
      .then(() => {
        if (this.config.walletAddress.toLowerCase() === address) {
          this.walletImportState = { status: 'ready', address: profile.address, error: null };
        }
      })
      .catch(() => {
        if (this.config.walletAddress.toLowerCase() === address) {
          this.walletImportState = { status: 'failed', address: profile.address, error: 'Initial scan failed; check RPC health and logs' };
        }
      });
  }

  createExecutor() {
    return new RebalanceExecutor(
      this.providers.readProvider,
      this.providers.writeProvider,
      this.config,
      this.fables,
      this.ledger,
      (address) => this.market.prices.get(String(address).toLowerCase()) || 0,
      this.state
    );
  }

  async manualRebalance(poolId, positionId, source = 'dashboard') {
    poolId = String(poolId || '').toLowerCase();
    positionId = String(positionId || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(poolId)) throw new Error('Invalid poolId');
    if (!/^0x[0-9a-f]{64}$/.test(positionId)) throw new Error('Invalid positionId');
    if (this.cycleActive) throw new Error('A monitoring/execution cycle is already running');
    if (this.executionPaused) throw new Error('Execution is paused; resume before manual rebalance');

    const snapshot = await this.runOnce({ executeRebalances: false, source: 'manual-preflight' });
    if (this.cycleActive) throw new Error('Monitoring cycle did not release execution lock');

    const activePoolIds = new Set((snapshot?.bot?.activePoolIds || []).map((x) => String(x).toLowerCase()));
    if (!activePoolIds.has(poolId)) throw new Error('Requested pool is not an active wallet LP pool');

    const pool = this.market.pools.find((x) => String(x.id).toLowerCase() === poolId);
    const position = pool?.positions?.find((x) => String(x.id).toLowerCase() === positionId);
    if (!pool || !position) throw new Error('Requested LP position is not active after fresh chain scan');
    if (position.outside !== true) throw new Error('Absolute in-range hold: manual withdrawal is forbidden while LP is in range');
    if (position.shouldRebalance !== true) {
      throw new Error('Position is OOR but has not satisfied the configured rebalance policy yet');
    }

    this.cycleActive = true;
    try {
      if (this.config.targetMode === 'wallet-active') {
        const stable = await this.revalidateTopologyBeforeExecution(snapshot.blockNumber, [{ pool, position }]);
        if (!stable) throw new Error('Wallet LP topology changed during manual preflight');
      }
      this.ledger.append('rebalance.manual_requested', {
        source,
        poolId: pool.id,
        positionId: position.id,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        dryRun: this.config.dryRun
      });
      const result = await this.maybeRebalance(pool, position, { source, throwOnFailure: true });
      return result || { status: 'blocked', reason: 'manual rebalance was blocked by a safety gate' };
    } finally {
      this.cycleActive = false;
    }
  }

  async refreshMarket(force = false) {
    if (!force && Date.now() - this.market.refreshedAt < this.config.marketRefreshMs) return this.market;
    const latestBlock = await this.providers.readProvider.getBlockNumber();
    const discovered = await this.fables.discoverAllPools();
    const pools = await this.fables.hydratePoolStates(discovered);
    const prices = buildUsdPriceMap(pools, this.config.usdgAddress);
    let fablesStats = null;
    try { fablesStats = await fetchFablesPoolStats(); }
    catch (error) { log('warn', 'fables.stats_unavailable', { error: error.message }); }
    this.market = { refreshedAt: Date.now(), pools, prices, latestBlock, fablesStats };
    await this.scanGlobalPoolFees(pools, latestBlock);
    log('info', 'market.refreshed', {
      block: latestBlock,
      pools: pools.length,
      pricedAssets: prices.size,
      targetMode: this.config.targetMode,
      targetPools: this.config.targetMode === 'wallet-active' ? null : this.fables.targetPools(pools).length
    });
    return this.market;
  }

  async runOnce(options = {}) {
    const executeRebalances = options.executeRebalances !== false;
    if (this.cycleActive) {
      log('warn', 'cycle.skipped', { reason: 'previous cycle still running' });
      return this.snapshot;
    }
    this.cycleActive = true;
    try {
      await this.refreshMarket(false);
      const latestBlock = await this.providers.readProvider.getBlockNumber();
      this.market.latestBlock = latestBlock;
      const selection = await this.resolveTargetPools(latestBlock);
      const targetPools = selection.pools;
      const accountingPools = selection.accountingPools || targetPools;
      if (!targetPools.length) {
        // No active LP is an execution state, not a reason to freeze accounting.
        // Continue through the normal wallet-balance/portfolio path using known
        // historical pools so a manual full withdrawal is reflected immediately.
        log('warn', 'wallet_pool.none_active', {
          targetMode: this.config.targetMode,
          block: latestBlock,
          accountingPools: accountingPools.map((pool) => pool.id)
        });
      }

      for (const pool of targetPools) {
        pool.state = await this.fables.readPoolState(pool);
        const cursorKey = `positionLogs:${pool.id}`;
        const candidatesKey = `positionCandidates:${pool.id}`;
        const knownCandidates = this.state.getSetting(candidatesKey, []) || [];
        const candidates = this.fables.positionCandidates.get(pool.id) || new Set(this.config.positionIds);
        for (const id of knownCandidates) {
          if (/^0x[0-9a-f]{64}$/i.test(String(id))) candidates.add(String(id).toLowerCase());
        }
        this.fables.positionCandidates.set(pool.id, candidates);
        const fallbackCursor = this.config.targetMode === 'wallet-active'
          ? Math.max(this.config.logFromBlock, latestBlock - this.config.reorgLookbackBlocks)
          : this.config.logFromBlock;
        const previousCursor = this.state.getCursor(cursorKey, fallbackCursor);
        const fromBlock = Math.max(this.config.logFromBlock, previousCursor - this.config.reorgLookbackBlocks);
        const result = await this.fables.discoverPositions(pool, fromBlock, latestBlock);
        pool.positions = result.positions;
        this.state.setSetting(candidatesKey, [...this.fables.positionCandidates.get(pool.id)].sort());
        await this.recordLifecycleLogs(pool, result.lifecycleLogs);
        this.state.setCursor(cursorKey, latestBlock + 1);
        for (const position of pool.positions) {
          await this.decoratePosition(pool, position);
          this.trackFeeAccrual(pool, position);
        }
      }

      const uniqueTokens = uniqueTargetTokens(accountingPools);
      const walletBalances = await this.fables.readWalletBalances(uniqueTokens);
      const portfolio = this.analytics.build({
        targetPools,
        walletBalances,
        prices: this.market.prices,
        trackedTokens: uniqueTokens
      });
      await this.attachRebalanceQuotes(targetPools, portfolio);
      const points = this.points.snapshot();
      if (this.config.walletAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
        this.walletImportState = { status: 'ready', address: this.config.walletAddress, error: null };
      }
      const snapshot = {
        generatedAt: Date.now(),
        blockNumber: latestBlock,
        markets: this.market.pools.map((pool) => snapshotMarket(
          pool,
          this.market.fablesStats?.pools?.get(pool.id) || null,
          new Set((this.state.getSetting('watchedPoolIds', []) || []).map((id) => String(id).toLowerCase())).has(pool.id.toLowerCase()),
          this.market.fablesStats
        )),
        bot: {
          version: '0.6.0',
          wallet: this.config.walletAddress,
          walletImportState: this.walletImportState,
          dryRun: this.config.dryRun,
          liveWrites: this.config.enableLiveWrites,
          autoRedeploy: this.config.enableAutoRedeploy,
          executionPaused: this.executionPaused,
          lastAction: this.state.getSetting('lastAction', null),
          targetMode: this.config.targetMode,
          activePoolIds: targetPools.map((pool) => pool.id),
          accountingPoolIds: accountingPools.map((pool) => pool.id),
          watchedPoolIds: this.state.getSetting('watchedPoolIds', []) || [],
          topologyCooldownUntil: this.state.getSetting('walletTopologyCooldownUntil', 0),
          targetSymbols: this.config.targetSymbols,
          swapSlippageBps: this.config.swapSlippageBps,
          rangePolicy: rangePolicySnapshot(this.config),
          absoluteInRangeHold: true,
          activeRebalanceExecution: this.state.getSetting('activeRebalanceExecution', null)
        },
        rpcHealth: this.rpcHealth,
        portfolio,
        points,
        prices: Object.fromEntries(this.market.prices),
        walletBalances: Object.fromEntries(Object.entries(walletBalances).map(([k, v]) => [k, { amount: v.amount }])),
        pools: targetPools.map(snapshotPool)
      };
      this.snapshot = snapshot;
      this.ledger.writeSnapshot(snapshot);
      this.recordPortfolioSnapshot(snapshot);

      const pendingRebalances = targetPools.flatMap((pool) =>
        (pool.positions || [])
          .filter((position) => position.outside === true && position.shouldRebalance === true)
          .map((position) => ({ pool, position }))
      );
      if (!executeRebalances) return snapshot;
      if (pendingRebalances.length && this.config.targetMode === 'wallet-active') {
        const stable = await this.revalidateTopologyBeforeExecution(latestBlock, pendingRebalances);
        if (!stable) return snapshot;
      }
      for (const { pool, position } of pendingRebalances) {
        await this.maybeRebalance(pool, position);
      }
      return snapshot;
    } finally {
      this.cycleActive = false;
    }
  }

  async resolveTargetPools(latestBlock) {
    if (this.config.targetMode !== 'wallet-active') {
      const pools = this.fables.targetPools(this.market.pools);
      return { pools, accountingPools: pools, discovery: null };
    }
    if (this.config.walletAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      return { pools: [], accountingPools: [], discovery: null };
    }

    const cursorKey = 'walletPoolDiscovery';
    const previousCursor = this.state.getCursor(cursorKey, this.config.walletPoolDiscoveryFromBlock);
    const fromBlock = Math.max(
      this.config.walletPoolDiscoveryFromBlock,
      previousCursor - this.config.reorgLookbackBlocks
    );
    const knownRangeKeys = this.state.getSetting('walletRangeCandidates', []);
    const result = await this.fables.discoverWalletActivePools(
      this.market.pools,
      fromBlock,
      latestBlock,
      knownRangeKeys
    );

    this.state.setCursor(cursorKey, latestBlock + 1);
    this.state.setSetting('walletRangeCandidates', result.knownRangeKeys);

    const previousIds = (this.state.getSetting('activeWalletPoolIds', []) || []).map((x) => String(x).toLowerCase()).sort();
    const currentIds = result.activePoolIds.map((x) => String(x).toLowerCase()).sort();
    const previousRanges = (this.state.getSetting('activeWalletRangeKeys', []) || []).map((x) => String(x).toLowerCase()).sort();
    const currentRanges = result.activeRangeKeys.map((x) => String(x).toLowerCase()).sort();
    const poolsChanged = !sameStringArray(previousIds, currentIds);
    const rangesChanged = !sameStringArray(previousRanges, currentRanges);
    if (poolsChanged || rangesChanged) {
      const previousSet = new Set(previousIds);
      const currentSet = new Set(currentIds);
      const previousRangeSet = new Set(previousRanges);
      const currentRangeSet = new Set(currentRanges);
      const added = currentIds.filter((id) => !previousSet.has(id));
      const removed = previousIds.filter((id) => !currentSet.has(id));
      const addedRanges = currentRanges.filter((id) => !previousRangeSet.has(id));
      const removedRanges = previousRanges.filter((id) => !currentRangeSet.has(id));
      const cooldownUntil = Date.now() + this.config.manualTopologyCooldownSec * 1000;
      this.state.setSetting('activeWalletPoolIds', currentIds);
      this.state.setSetting('activeWalletRangeKeys', currentRanges);
      this.state.setSetting('walletTopologyCooldownUntil', cooldownUntil);
      this.ledger.append('wallet.lp_topology_changed', {
        poolsChanged,
        rangesChanged,
        added,
        removed,
        addedRanges,
        removedRanges,
        activePoolIds: currentIds,
        activeRangeKeys: currentRanges,
        cooldownUntil,
        cooldownSec: this.config.manualTopologyCooldownSec
      });
      log('warn', 'wallet.lp_topology_changed', {
        poolsChanged,
        rangesChanged,
        added,
        removed,
        addedRanges,
        removedRanges,
        activePoolIds: currentIds,
        cooldownUntil
      });
    }

    return { pools: result.activePools, accountingPools: result.knownPools || result.activePools, discovery: result };
  }

  async revalidateTopologyBeforeExecution(snapshotBlock, pendingRebalances = []) {
    const beforePoolIds = (this.state.getSetting('activeWalletPoolIds', []) || [])
      .map((x) => String(x).toLowerCase()).sort();
    const beforeRangeKeys = (this.state.getSetting('activeWalletRangeKeys', []) || [])
      .map((x) => String(x).toLowerCase()).sort();
    const latest = await this.providers.readProvider.getBlockNumber();
    if (latest <= snapshotBlock) return true;

    const verification = await this.resolveTargetPools(latest);
    const afterPoolIds = (verification.discovery?.activePoolIds || [])
      .map((x) => String(x).toLowerCase()).sort();
    const afterRangeKeys = (verification.discovery?.activeRangeKeys || [])
      .map((x) => String(x).toLowerCase()).sort();
    const stable = sameStringArray(beforePoolIds, afterPoolIds)
      && sameStringArray(beforeRangeKeys, afterRangeKeys);

    if (!stable) {
      for (const { pool, position } of pendingRebalances) {
        this.ledger.append('rebalance.blocked', {
          positionId: position.id,
          poolId: pool.id,
          reason: 'wallet topology changed during cycle',
          snapshotBlock,
          verificationBlock: latest,
          beforePoolIds,
          afterPoolIds,
          beforeRangeKeys,
          afterRangeKeys
        });
      }
      log('warn', 'rebalance.topology_race_blocked', {
        snapshotBlock,
        verificationBlock: latest,
        beforePoolIds,
        afterPoolIds,
        beforeRangeKeys,
        afterRangeKeys
      });
      return false;
    }
    return true;
  }

  async attachRebalanceQuotes(targetPools, portfolio) {
    for (const metric of portfolio.positions || []) {
      // Chain quote/deposit planning is only needed once the hysteresis policy has
      // actually made the position execution-eligible. Waiting OOR positions keep
      // their analytical inventory plan but do not burn RPC quota on transient quotes.
      if (!metric.outside || !metric.shouldRebalance || !metric.rebalancePlan || !metric.target) continue;
      const pool = targetPools.find((x) => x.id === metric.poolId);
      if (!pool) continue;
      let quote = null;
      try {
        if (metric.rebalancePlan.direction !== 'none' && metric.rebalancePlan.amountIn > 0) {
          quote = await this.quoter.quoteExactInputSingle(
            pool,
            metric.rebalancePlan.tokenIn,
            metric.rebalancePlan.amountIn,
            this.config.swapSlippageBps
          );
          metric.rebalanceQuote = quote;
        }
        metric.depositPlan = buildDepositPlan({
          amount0: metric.amount0 + metric.owed0,
          amount1: metric.amount1 + metric.owed1,
          inventoryPlan: metric.rebalancePlan,
          quote,
          sqrtPriceX96: pool.state.sqrtPriceX96,
          tickLower: metric.target.tickLower,
          tickUpper: metric.target.tickUpper,
          decimals0: pool.token0.decimals,
          decimals1: pool.token1.decimals,
          slippageBps: this.config.depositSlippageBps,
          liquidityReserveBps: this.config.depositLiquidityReserveBps
        });
        const position = (pool.positions || []).find((x) => x.id.toLowerCase() === metric.id.toLowerCase());
        if (position) {
          position.rebalancePlan = metric.rebalancePlan;
          position.rebalanceQuote = quote;
          position.depositPlan = metric.depositPlan;
        }
      } catch (error) {
        metric.rebalanceQuoteError = error.message;
        metric.depositPlan = null;
        log('warn', 'rebalance.plan_failed', { positionId: metric.id, poolId: metric.poolId, error: error.message });
      }
    }
  }

  recordPortfolioSnapshot(snapshot) {
    const now = snapshot.generatedAt;
    const last = Number(this.state.getSetting('lastPortfolioSnapshotAt', 0) || 0);
    if (last && now - last < this.config.portfolioSnapshotIntervalMs) return;
    this.ledger.append('portfolio.snapshot', {
      blockNumber: snapshot.blockNumber,
      currentValueUsd: snapshot.portfolio.currentValueUsd,
      hodlValueUsd: snapshot.portfolio.hodlValueUsd,
      netPnlUsd: snapshot.portfolio.netPnlUsd,
      excessVsHodlUsd: snapshot.portfolio.excessVsHodlUsd,
      ilUsd: snapshot.portfolio.currentIlUsd,
      feeUsd: snapshot.portfolio.trackedFeeUsd,
      gasUsd: snapshot.portfolio.gasUsd,
      estimatedPoints: snapshot.points.estimatedTotal
    }, now);
    this.state.setSetting('lastPortfolioSnapshotAt', now);
  }

  async decoratePosition(pool, position) {
    const stateKey = positionStateKey(pool, position);
    const stored = this.state.getPosition(stateKey);
    const nowMs = Date.now();
    const evaluation = evaluatePosition({
      currentTick: pool.state.tick,
      tickSpacing: pool.key.tickSpacing,
      position,
      widthBps: this.config.tightWidthBps,
      rangePreset: this.config.rangePreset,
      edgeBufferTicks: this.config.edgeBufferTicks,
      lastEvaluationAt: Number(stored.lastRangeEvaluationAt || 0),
      outOfRangeSince: Number(stored.outOfRangeSince || 0),
      deepConfirmationsSeen: Number(stored.deepOutOfRangeConfirmations || stored.outOfRangeConfirmations || 0),
      checkIntervalMs: this.config.rangeCheckIntervalMs,
      shallowThresholdPct: this.config.oorShallowThresholdPct,
      maxWaitMs: this.config.oorMaxWaitMs,
      deepConfirmationsRequired: this.config.oorDeepConfirmations,
      cooldownUntil: stored.cooldownUntil || 0,
      nowMs
    });
    Object.assign(position, {
      outside: evaluation.outside,
      nearEdge: Boolean(evaluation.nearEdge),
      excursionPct: evaluation.excursionPct,
      confirmations: evaluation.deepConfirmations,
      deepConfirmations: evaluation.deepConfirmations,
      outOfRangeSince: evaluation.outOfRangeSince,
      outOfRangeElapsedMin: evaluation.outOfRangeElapsedMs / 60000,
      evaluationDue: evaluation.evaluationDue,
      lastRangeEvaluationAt: evaluation.evaluatedAt,
      nextRangeEvaluationAt: evaluation.nextEvaluationAt,
      cooldownActive: evaluation.cooldownActive,
      shouldRebalance: !pool.state.paused && evaluation.shouldRebalance,
      rebalanceReason: !pool.state.paused ? evaluation.rebalanceReason : null,
      executionBlockedReason: pool.state.paused ? 'fables pool paused' : null,
      target: evaluation.target
    });
    this.state.setPosition(stateKey, {
      outOfRangeConfirmations: evaluation.deepConfirmations,
      deepOutOfRangeConfirmations: evaluation.deepConfirmations,
      outOfRangeSince: evaluation.outOfRangeSince,
      lastRangeEvaluationAt: evaluation.evaluatedAt,
      lastExcursionPct: evaluation.excursionPct,
      lastTick: pool.state.tick,
      lastSeenAt: nowMs,
      lastRange: [position.tickLower, position.tickUpper]
    });
    log(evaluation.outside ? 'warn' : 'info', 'position.status', {
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      id: position.id,
      tick: pool.state.tick,
      range: [position.tickLower, position.tickUpper],
      outside: evaluation.outside,
      excursionPct: evaluation.excursionPct,
      outOfRangeElapsedMin: evaluation.outOfRangeElapsedMs / 60000,
      deepConfirmations: evaluation.deepConfirmations,
      evaluationDue: evaluation.evaluationDue,
      shouldRebalance: !pool.state.paused && evaluation.shouldRebalance,
      rebalanceReason: !pool.state.paused ? evaluation.rebalanceReason : null,
      executionBlockedReason: pool.state.paused ? 'fables pool paused' : null,
      target: evaluation.target
    });
  }

  trackFeeAccrual(pool, position) {
    const key = `feeState:${positionStateKey(pool, position)}`;
    const previous = this.state.getSetting(key, null);
    const current = { owed0: position.owed0.toString(), owed1: position.owed1.toString(), shares: position.shares.toString(), at: Date.now() };
    this.state.setSetting(key, current);
    if (!previous || String(previous.shares) !== position.shares.toString()) return;
    const prev0 = BigInt(previous.owed0 || 0);
    const prev1 = BigInt(previous.owed1 || 0);
    const d0 = position.owed0 - prev0;
    const d1 = position.owed1 - prev1;
    if (d0 > 0n || d1 > 0n) {
      const amount0 = d0 > 0n ? Number(formatUnits(d0, pool.token0.decimals)) : 0;
      const amount1 = d1 > 0n ? Number(formatUnits(d1, pool.token1.decimals)) : 0;
      const feeUsd = amount0 * this.priceOf(pool.token0.address) + amount1 * this.priceOf(pool.token1.address);
      this.ledger.append('fee.accrual', {
        positionId: position.id,
        poolId: pool.id,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        amount0,
        amount1,
        symbol0: pool.token0.symbol,
        symbol1: pool.token1.symbol,
        feeUsd
      });
    } else if (d0 < 0n || d1 < 0n) {
      this.ledger.append('fee.owed_decrease', {
        positionId: position.id,
        poolId: pool.id,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        previousOwed0: prev0.toString(),
        previousOwed1: prev1.toString(),
        currentOwed0: position.owed0.toString(),
        currentOwed1: position.owed1.toString(),
        note: 'Claim, withdraw, checkpoint, or accounting reset detected'
      });
    }
  }

  async maybeRebalance(pool, position, options = {}) {
    const source = options.source || 'automatic';
    const throwOnFailure = Boolean(options.throwOnFailure);
    // ABSOLUTE RULE: never auto-withdraw an LP that is currently in its original range.
    // Re-read the chain immediately before any executor path is allowed to proceed.
    if (position.outside !== true || position.shouldRebalance !== true) {
      this.ledger.append('rebalance.blocked', {
        positionId: position.id,
        poolId: pool.id,
        reason: 'absolute in-range hold / position not OOR-eligible'
      });
      return { status: 'blocked', reason: 'position-not-oor-eligible' };
    }
    if (!(await this.assertStillOutOfRangeBeforeRebalance(pool, position))) {
      return { status: 'blocked', reason: 'latest-chain-state-not-eligible' };
    }

    const topologyCooldownUntil = Number(this.state.getSetting('walletTopologyCooldownUntil', 0) || 0);
    if (Date.now() < topologyCooldownUntil) {
      this.ledger.append('rebalance.blocked', {
        positionId: position.id,
        poolId: pool.id,
        reason: 'wallet topology cooldown',
        cooldownUntil: topologyCooldownUntil
      });
      return { status: 'blocked', reason: 'wallet-topology-cooldown' };
    }
    if (this.executionPaused) {
      this.ledger.append('rebalance.blocked', { positionId: position.id, reason: 'execution paused', source });
      return { status: 'blocked', reason: 'execution-paused' };
    }

    const minIntervalMs = Math.max(0, Number(this.config.minRebalanceIntervalSec || 0) * 1000);
    if (minIntervalMs > 0) {
      const recentForInterval = this.state.recentRebalances(minIntervalMs);
      const latestSuccessful = recentForInterval.reduce(
        (latest, entry) => Number(entry.ts || 0) > Number(latest?.ts || 0) ? entry : latest,
        null
      );
      if (latestSuccessful && Date.now() - Number(latestSuccessful.ts) < minIntervalMs) {
        this.ledger.append('rebalance.blocked', {
          positionId: position.id,
          poolId: pool.id,
          reason: 'global minimum rebalance interval',
          source,
          previousPositionId: latestSuccessful.positionId || null,
          previousPoolId: latestSuccessful.poolId || null,
          previousRebalanceAt: latestSuccessful.ts,
          minIntervalSec: this.config.minRebalanceIntervalSec
        });
        return { status: 'blocked', reason: 'global-min-rebalance-interval' };
      }
    }

    if (this.state.recentRebalances().length >= this.config.maxRebalancesPerHour) {
      this.ledger.append('rebalance.blocked', { positionId: position.id, reason: 'hourly rate limit', source });
      return { status: 'blocked', reason: 'hourly-rate-limit' };
    }
    const plan = {
      pool,
      position,
      currentTick: pool.state.tick,
      target: position.target,
      inventoryPlan: position.rebalancePlan || null,
      quote: position.rebalanceQuote || null,
      depositPlan: position.depositPlan || null
    };
    try {
      const result = await this.executor.execute(plan);

      // Dry-run is observation only. Never mutate the strategy state as though the
      // on-chain position moved, otherwise cooldown/rate-limit/OOR timers diverge
      // from the wallet's real LP.
      if (result.status === 'dry-run') {
        this.state.setSetting(
          'lastAction',
          `dry-run ${pool.token0.symbol}/${pool.token1.symbol} ${position.id.slice(0, 10)}…`
        );
        return result;
      }

      // Only a fully completed state machine may commit a rebalance to strategy state.
      if (result.status !== 'completed') {
        this.ledger.append('rebalance.uncommitted', {
          positionId: position.id,
          poolId: pool.id,
          status: result.status,
          reason: 'executor did not report a fully completed withdraw-swap-deposit cycle'
        });
        return result;
      }

      const cooldownUntil = Date.now() + this.config.minRebalanceIntervalSec * 1000;
      this.state.setPosition(positionStateKey(pool, position), {
        cooldownUntil,
        outOfRangeConfirmations: 0,
        deepOutOfRangeConfirmations: 0,
        outOfRangeSince: 0,
        lastRangeEvaluationAt: 0
      });
      this.state.recordRebalance({
        ts: Date.now(), positionId: position.id, poolId: pool.id, result: result.status,
        currentTick: pool.state.tick, target: position.target
      });
      this.state.setSetting(
        'lastAction',
        `completed ${pool.token0.symbol}/${pool.token1.symbol} ${position.id.slice(0, 10)}…`
      );
      return result;
    } catch (error) {
      this.ledger.append('rebalance.failed', { positionId: position.id, poolId: pool.id, error: error.message });
      const activeExecution = this.state.getSetting('activeRebalanceExecution', null);
      if (activeExecution?.phase === 'recovery_required') {
        this.setExecutionPaused(true, 'rebalance_recovery_required');
        this.ledger.append('rebalance.auto_paused', {
          positionId: position.id,
          poolId: pool.id,
          executionId: activeExecution.id || null,
          reason: 'capital moved but execution did not complete'
        });
      }
      log('error', 'rebalance.failed', { positionId: position.id, error: error.message, source });
      if (throwOnFailure) throw error;
      return { status: 'failed', error: error.message };
    }
  }

  async assertStillOutOfRangeBeforeRebalance(pool, position) {
    const latestState = await this.fables.readPoolState(pool);
    const outside = isLpOutOfRange(latestState.tick, position.tickLower, position.tickUpper);
    pool.state = latestState;

    if (latestState.paused) {
      this.ledger.append('rebalance.blocked', {
        positionId: position.id,
        poolId: pool.id,
        reason: 'fables pool paused',
        latestTick: latestState.tick
      });
      log('warn', 'rebalance.pool_paused', {
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        positionId: position.id,
        latestTick: latestState.tick
      });
      return false;
    }

    if (outside) {
      const excursionPct = outOfRangeExcursionPct(
        latestState.tick,
        position.tickLower,
        position.tickUpper
      );
      if (
        position.rebalanceReason === 'deep_oor_confirmed'
        && excursionPct <= this.config.oorShallowThresholdPct
      ) {
        const stateKey = positionStateKey(pool, position);
        this.state.setPosition(stateKey, {
          outOfRangeConfirmations: 0,
          deepOutOfRangeConfirmations: 0,
          lastExcursionPct: excursionPct,
          lastTick: latestState.tick
        });
        this.ledger.append('rebalance.blocked', {
          positionId: position.id,
          poolId: pool.id,
          reason: 'deep OOR faded below threshold before execution',
          latestTick: latestState.tick,
          excursionPct,
          thresholdPct: this.config.oorShallowThresholdPct
        });
        log('info', 'rebalance.deep_oor_faded', {
          pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
          positionId: position.id,
          latestTick: latestState.tick,
          excursionPct
        });
        return false;
      }
      return true;
    }

    const stateKey = positionStateKey(pool, position);
    this.state.setPosition(stateKey, {
      outOfRangeConfirmations: 0,
      deepOutOfRangeConfirmations: 0,
      outOfRangeSince: 0,
      lastRangeEvaluationAt: Date.now(),
      lastTick: latestState.tick
    });
    this.ledger.append('rebalance.blocked', {
      positionId: position.id,
      poolId: pool.id,
      reason: 'absolute in-range hold',
      latestTick: latestState.tick,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper
    });
    log('info', 'rebalance.in_range_hold', {
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      positionId: position.id,
      latestTick: latestState.tick,
      range: [position.tickLower, position.tickUpper]
    });
    return false;
  }

  async scanGlobalPoolFees(pools, latestBlock) {
    const poolsPerHook = new Map();
    for (const pool of pools) {
      const hook = pool.key.hooks.toLowerCase();
      poolsPerHook.set(hook, (poolsPerHook.get(hook) || 0) + 1);
    }
    for (const pool of pools) {
      if (!pool.state || pool.token0.decimals == null || pool.token1.decimals == null) continue;
      const hook = pool.key.hooks.toLowerCase();
      if ((poolsPerHook.get(hook) || 0) > 1) {
        this.ledger.appendUnique(
          `shared-hook-fee-unattributed:${hook}`,
          'pool.fee_unattributed',
          {
            hook: pool.key.hooks,
            poolCount: poolsPerHook.get(hook),
            reason: 'FeesCollected has no verified PoolKey attribution for shared hooks; skip pair-level totals to avoid double counting'
          }
        );
        continue;
      }
      const cursorKey = `poolFees:${pool.id}`;
      const storedCursor = this.state.getCursor(cursorKey, 0);
      const initial = this.config.feeLogFromBlock > 0 ? this.config.feeLogFromBlock : latestBlock;
      const fromBlock = storedCursor > 0
        ? Math.max(initial, storedCursor - this.config.reorgLookbackBlocks)
        : initial;
      if (fromBlock > latestBlock) continue;
      let events;
      try { events = await this.fables.scanPoolFees(pool, fromBlock, latestBlock); }
      catch (error) {
        log('warn', 'pool_fee.scan_failed', { poolId: pool.id, fromBlock, latestBlock, error: error.message });
        continue;
      }
      for (const event of events) {
        const ts = await this.blockTimestamp(event.blockNumber);
        const amount0 = Number(formatUnits(event.amount0, pool.token0.decimals));
        const amount1 = Number(formatUnits(event.amount1, pool.token1.decimals));
        const feeUsd = amount0 * this.priceOf(pool.token0.address) + amount1 * this.priceOf(pool.token1.address);
        this.ledger.appendUnique(`poolfee:${pool.id}:${event.transactionHash}:${event.index}`, 'pool.fee', {
          poolId: pool.id,
          pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
          hash: event.transactionHash,
          blockNumber: event.blockNumber,
          amount0,
          amount1,
          symbol0: pool.token0.symbol,
          symbol1: pool.token1.symbol,
          feeUsd
        }, ts);
      }
      this.state.setCursor(cursorKey, latestBlock + 1);
    }
  }

  async recordLifecycleLogs(pool, logs) {
    for (const entry of logs) {
      const kind = lifecycleEventType(entry);
      if (!kind) continue;
      const rangeId = entry.topics?.[2]?.toLowerCase();
      const eventKey = `lifecycle:${entry.transactionHash}:${Number(entry.index ?? 0)}`;
      if (this.ledger.seenKeys.has(eventKey)) continue;
      const ts = await this.blockTimestamp(entry.blockNumber);
      let gasEth = 0; let gasUsd = 0; let txFrom = null;
      try {
        const [receipt, tx] = await Promise.all([
          this.providers.readProvider.getTransactionReceipt(entry.transactionHash),
          this.providers.readProvider.getTransaction(entry.transactionHash)
        ]);
        txFrom = tx?.from || null;
        if (receipt && tx && tx.from?.toLowerCase() === this.config.walletAddress.toLowerCase()) {
          const gasPrice = receipt.gasPrice || tx.gasPrice || 0n;
          gasEth = Number(formatUnits(receipt.gasUsed * gasPrice, 18));
          gasUsd = gasEth * this.priceOf(ZERO_ADDRESS);
        }
      } catch {}
      this.ledger.appendUnique(eventKey, `lp.${kind}`, {
        poolId: pool.id,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        positionId: rangeId,
        hash: entry.transactionHash,
        blockNumber: entry.blockNumber,
        liquidity: lifecycleLiquidity(entry).toString(),
        txFrom,
        gasEth,
        gasUsd
      }, ts);
    }
  }

  async blockTimestamp(blockNumber) {
    if (this.blockTimeCache.has(blockNumber)) return this.blockTimeCache.get(blockNumber);
    const block = await this.providers.readProvider.getBlock(blockNumber);
    const ms = block ? Number(block.timestamp) * 1000 : Date.now();
    this.blockTimeCache.set(blockNumber, ms);
    if (this.blockTimeCache.size > 2000) this.blockTimeCache.delete(this.blockTimeCache.keys().next().value);
    return ms;
  }

  priceOf(address) {
    return Number(this.market.prices.get(String(address).toLowerCase()) || 0);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.initialize();
    this.walletImportState = this.config.walletAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()
      ? { status: 'failed', address: this.config.walletAddress, error: '尚未設定有效的監控錢包地址' }
      : { status: 'scanning', address: this.config.walletAddress, error: null };
    this.schedulePointsSimulation();
    while (this.running) {
      const started = Date.now();
      try { await this.runOnce(); }
      catch (error) {
        if (this.walletImportState.status === 'scanning') {
          this.walletImportState = { status: 'failed', address: this.config.walletAddress, error: 'Initial scan failed; check RPC health and logs' };
        }
        this.ledger.append('cycle.failed', { error: error.message });
        log('error', 'cycle.failed', { error: error.stack || error.message });
      }
      const wait = Math.max(1000, this.config.pollIntervalMs - (Date.now() - started));
      await sleep(wait);
    }
  }

  stop() {
    this.running = false;
    if (this.pointsSimulationTimer) clearTimeout(this.pointsSimulationTimer);
    this.pointsSimulationTimer = null;
  }
}

function uniqueTargetTokens(pools) {
  const map = new Map();
  for (const pool of pools) {
    map.set(pool.token0.address.toLowerCase(), pool.token0);
    map.set(pool.token1.address.toLowerCase(), pool.token1);
  }
  return [...map.values()];
}
function snapshotPool(pool) {
  return {
    id: pool.id,
    pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
    hook: pool.key.hooks,
    tick: pool.state?.tick ?? null,
    tickSpacing: pool.key.tickSpacing,
    paused: pool.state?.paused ?? null,
    positions: (pool.positions || []).map((p) => ({
      id: p.id, shares: p.shares.toString(), tickLower: p.tickLower, tickUpper: p.tickUpper,
      outside: p.outside, nearEdge: Boolean(p.nearEdge), excursionPct: p.excursionPct, confirmations: p.confirmations,
      deepConfirmations: p.deepConfirmations, outOfRangeSince: p.outOfRangeSince,
      outOfRangeElapsedMin: p.outOfRangeElapsedMin, evaluationDue: p.evaluationDue,
      lastRangeEvaluationAt: p.lastRangeEvaluationAt, nextRangeEvaluationAt: p.nextRangeEvaluationAt,
      shouldRebalance: p.shouldRebalance, rebalanceReason: p.rebalanceReason,
      executionBlockedReason: p.executionBlockedReason || null, target: p.target,
      rebalancePlan: p.rebalancePlan || null, rebalanceQuote: p.rebalanceQuote || null,
      depositPlan: p.depositPlan || null
    }))
  };
}
function snapshotMarket(pool, stats, watched, fablesStats) {
  return {
    id: pool.id,
    pair: pool.token0.symbol + '/' + pool.token1.symbol,
    token0: pool.token0.symbol,
    token1: pool.token1.symbol,
    tick: pool.state?.tick ?? null,
    paused: pool.state?.paused ?? null,
    watched,
    tvlUsd: stats?.tvlUsd ?? null,
    volume24hUsd: stats?.volume24hUsd ?? null,
    fees24hUsd: stats?.fees24hUsd ?? null,
    aprPct: stats?.aprPct ?? null,
    statsObservedAt: fablesStats?.observedAt ?? null,
    statsSource: fablesStats?.source ?? null
  };
}
function positionStateKey(pool, position) {
  return `${pool.id.toLowerCase()}:${position.id.toLowerCase()}`;
}
function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function rangePolicySnapshot(config) {
  return {
    rangePreset: config.rangePreset,
    evaluationIntervalMs: config.rangeCheckIntervalMs,
    shallowThresholdPct: config.oorShallowThresholdPct,
    maxWaitMin: config.oorMaxWaitMin,
    deepConfirmationsRequired: config.oorDeepConfirmations,
    monitorPollIntervalMs: config.pollIntervalMs
  };
}

function emptyPortfolio() {
  return {
    baseline: null,
    inventory: {},
    currentValueUsd: 0,
    hodlValueUsd: 0,
    grossPnlUsd: 0,
    netPnlUsd: 0,
    excessVsHodlUsd: 0,
    currentIlUsd: 0,
    gasUsd: 0,
    trackedFeeUsd: 0,
    netCashflowUsd: 0,
    positions: []
  };
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
