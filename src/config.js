import { getAddress } from 'ethers';
import { CHAIN_ID, DEFAULT_RPC_URL, FABLES_REGISTRY, USDG } from './constants.js';
import { envBool, envInt, envList, envNum } from './env.js';

export const RUNTIME_INTERVAL_LIMITS = Object.freeze({
  marketRefreshMs: { min: 15_000, max: 60 * 60 * 1000, label: 'APR 更新間隔', minLabel: '15 秒', maxLabel: '60 分鐘' },
  rangeCheckIntervalMs: { min: 30_000, max: 24 * 60 * 60 * 1000, label: '區間檢查間隔', minLabel: '30 秒', maxLabel: '24 小時' },
  pointsSimulationIntervalMs: { min: 5_000, max: 60 * 60 * 1000, label: '分數模擬間隔', minLabel: '5 秒', maxLabel: '60 分鐘' }
});

export function normalizeRuntimeIntervals(values) {
  return Object.fromEntries(Object.entries(RUNTIME_INTERVAL_LIMITS).map(([key, bounds]) => {
    const value = Number(values?.[key]);
    if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
      throw new Error(`${bounds.label}須介於${bounds.minLabel}至${bounds.maxLabel}。`);
    }
    return [key, value];
  }));
}

export function loadConfig() {
  const walletAddress = requiredAddress('WALLET_ADDRESS');
  const privateKey = process.env.PRIVATE_KEY?.trim() || '';
  const dryRun = envBool('DRY_RUN', true);
  const enableLiveWrites = envBool('ENABLE_LIVE_WRITES', false);
  const enableAutoRedeploy = envBool('ENABLE_AUTO_REDEPLOY', false);
  const rpcUrls = envList('RPC_URLS', [DEFAULT_RPC_URL]);
  const targetMode = (process.env.TARGET_MODE?.trim() || 'wallet-active').toLowerCase();
  const logFromBlock = envInt('LOG_FROM_BLOCK', 44_000_000);
  const oorMaxWaitMin = envInt('OOR_MAX_WAIT_MIN', 90);
  const targetSymbols = envList('TARGET_SYMBOLS', []).map((x) => x.toUpperCase());
  const targetPoolIds = envList('TARGET_POOL_IDS', []).map((x) => x.toLowerCase());
  const rangePreset = (process.env.RANGE_PRESET?.trim() || 'custom-bps').toLowerCase();
  const runtimeIntervals = normalizeRuntimeIntervals({
    marketRefreshMs: envInt('MARKET_REFRESH_MS', 60_000),
    rangeCheckIntervalMs: envInt('RANGE_CHECK_INTERVAL_MS', 15 * 60 * 1000),
    pointsSimulationIntervalMs: envInt('POINTS_SIMULATION_INTERVAL_MS', 15_000)
  });
  const { marketRefreshMs, rangeCheckIntervalMs, pointsSimulationIntervalMs } = runtimeIntervals;
  const oorShallowThresholdPct = envNum('OOR_SHALLOW_THRESHOLD_PCT', 0.5);
  const oorDeepConfirmations = envInt('OOR_DEEP_CONFIRMATIONS', envInt('OUT_OF_RANGE_CONFIRMATIONS', 2));
  const swapSlippageBps = envInt('SWAP_SLIPPAGE_BPS', 50);
  const depositSlippageBps = envInt('DEPOSIT_SLIPPAGE_BPS', 50);
  const withdrawSlippageBps = envInt('WITHDRAW_SLIPPAGE_BPS', 50);
  const eip7702GuardAddress = optionalAddress('EIP7702_GUARD_ADDRESS');
  const eip7702GuardVerified = envBool('EIP7702_GUARD_VERIFIED', false);

  if (!rpcUrls.length) throw new Error('RPC_URLS must contain at least one endpoint');
  if (!['wallet-active', 'allowlist', 'symbols'].includes(targetMode)) {
    throw new Error('TARGET_MODE must be wallet-active, allowlist, or symbols');
  }
  if (targetMode === 'allowlist' && !targetPoolIds.length) {
    throw new Error('TARGET_MODE=allowlist requires at least one TARGET_POOL_IDS entry; refusing fail-open all-pool selection');
  }
  if (targetMode === 'symbols' && !targetSymbols.length) {
    throw new Error('TARGET_MODE=symbols requires TARGET_SYMBOLS; refusing fail-open all-pool selection');
  }
  if (!['custom-bps', 'fables-tight'].includes(rangePreset)) {
    throw new Error('RANGE_PRESET must be custom-bps or fables-tight');
  }
  if (!(oorShallowThresholdPct >= 0 && oorShallowThresholdPct <= 100)) {
    throw new Error('OOR_SHALLOW_THRESHOLD_PCT must be between 0 and 100');
  }
  if (oorMaxWaitMin <= 0) throw new Error('OOR_MAX_WAIT_MIN must be > 0');
  if (oorDeepConfirmations < 1) throw new Error('OOR_DEEP_CONFIRMATIONS must be >= 1');
  if (swapSlippageBps < 0 || swapSlippageBps >= 10_000) throw new Error('SWAP_SLIPPAGE_BPS must be 0..9999');
  if (depositSlippageBps < 0 || depositSlippageBps >= 10_000) throw new Error('DEPOSIT_SLIPPAGE_BPS must be 0..9999');
  if (withdrawSlippageBps < 0 || withdrawSlippageBps >= 10_000) throw new Error('WITHDRAW_SLIPPAGE_BPS must be 0..9999');
  if (!dryRun && enableLiveWrites && !privateKey) throw new Error('PRIVATE_KEY is required when live writes are enabled');
  if (!dryRun && enableAutoRedeploy && !enableLiveWrites) throw new Error('ENABLE_AUTO_REDEPLOY requires ENABLE_LIVE_WRITES=true');
  if (!dryRun && enableAutoRedeploy && (!eip7702GuardAddress || !eip7702GuardVerified)) {
    throw new Error('Live auto-redeploy requires a deployed and canary-verified EIP-7702 atomic OOR guard');
  }

  return {
    chainId: CHAIN_ID,
    rpcUrls,
    registryAddress: getAddress(process.env.FABLES_REGISTRY?.trim() || FABLES_REGISTRY),
    usdgAddress: getAddress(process.env.USDG_ADDRESS?.trim() || USDG),
    walletAddress,
    privateKey,
    persistRuntimeCredentials: envBool('PERSIST_RUNTIME_CREDENTIALS', false),
    dryRun,
    enableLiveWrites,
    enableAutoRedeploy,
    targetMode,
    targetSymbols,
    targetPoolIds,
    rangePreset,
    positionIds: envList('POSITION_IDS', []).map(normalizeBytes32),
    pollIntervalMs: envInt('POLL_INTERVAL_MS', 15_000),
    logChunkBlocks: envInt('LOG_CHUNK_BLOCKS', 5_000),
    minLogChunkBlocks: envInt('MIN_LOG_CHUNK_BLOCKS', 500),
    logFromBlock,
    walletPoolDiscoveryFromBlock: envInt('WALLET_POOL_DISCOVERY_FROM_BLOCK', logFromBlock),
    manualTopologyCooldownSec: envInt('MANUAL_TOPOLOGY_COOLDOWN_SEC', 120),
    feeLogFromBlock: envInt('FEE_LOG_FROM_BLOCK', 0),
    marketRefreshMs,
    pointsSimulationIntervalMs,
    reorgLookbackBlocks: envInt('REORG_LOOKBACK_BLOCKS', 64),
    tightWidthBps: envInt('TIGHT_WIDTH_BPS', 120),
    edgeBufferTicks: envInt('EDGE_BUFFER_TICKS', 0),
    rangeCheckIntervalMs,
    oorShallowThresholdPct,
    oorMaxWaitMin,
    oorMaxWaitMs: oorMaxWaitMin * 60 * 1000,
    oorDeepConfirmations,
    minRebalanceIntervalSec: envInt('MIN_REBALANCE_INTERVAL_SEC', 300),
    maxRebalancesPerHour: envInt('MAX_REBALANCES_PER_HOUR', 3),
    swapSlippageBps,
    depositSlippageBps,
    withdrawSlippageBps,
    depositLiquidityReserveBps: envInt('DEPOSIT_LIQUIDITY_RESERVE_BPS', 10),
    fablesWalk: envInt('FABLES_WALK', 1000),
    permit2ExpirationSec: envInt('PERMIT2_EXPIRATION_SEC', 30 * 24 * 60 * 60),
    eip7702GuardAddress,
    eip7702GuardVerified,
    claimBeforeWithdraw: envBool('CLAIM_BEFORE_WITHDRAW', true),
    allowZeroMinOut: envBool('ALLOW_ZERO_MIN_OUT', false),
    txDeadlineSec: envInt('TX_DEADLINE_SEC', 1200),
    confirmations: envInt('TX_CONFIRMATIONS', 1),
    maxGasGwei: envNum('MAX_GAS_GWEI', 1),
    dashboardEnabled: envBool('DASHBOARD_ENABLED', true),
    dashboardManualControlEnabled: envBool('DASHBOARD_MANUAL_CONTROL_ENABLED', false),
    dashboardHost: process.env.DASHBOARD_HOST?.trim() || '127.0.0.1',
    dashboardPort: envInt('DASHBOARD_PORT', 8787),
    dashboardToken: process.env.DASHBOARD_TOKEN?.trim() || '',
    dataDir: process.env.DATA_DIR?.trim() || './data',
    stateFile: process.env.STATE_FILE?.trim() || './state/bot-state.json',
    actualPointsBaseline: envNum('ACTUAL_POINTS_BASELINE', 0),
    actualPointsBaselineAt: process.env.ACTUAL_POINTS_BASELINE_AT?.trim() || '',
    manualNetCashflowUsd: envNum('MANUAL_NET_CASHFLOW_USD', 0),
    portfolioSnapshotIntervalMs: envInt('PORTFOLIO_SNAPSHOT_INTERVAL_MS', 300_000),
    referenceDepositTx: process.env.REFERENCE_DEPOSIT_TX?.trim() || '',
    blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY?.trim() || '',
    blockscoutApiBase: process.env.BLOCKSCOUT_API_BASE?.trim() || 'https://api.blockscout.com/4663/api/v2'
  };
}

function requiredAddress(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return getAddress(value);
}

function normalizeBytes32(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid bytes32: ${value}`);
  return value.toLowerCase();
}

function optionalAddress(name) {
  const value = process.env[name]?.trim();
  return value ? getAddress(value) : '';
}
