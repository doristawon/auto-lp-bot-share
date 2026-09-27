import fs from 'node:fs';
import path from 'node:path';
import {
  Contract,
  Interface,
  formatUnits,
  id,
  zeroPadValue
} from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { FablesAdapter } from '../adapters/fables.js';
import { V4QuoterAdapter } from '../adapters/quoter.js';
import { buildUsdPriceMap } from '../analytics/prices.js';
import { rangeAmounts } from '../analytics/liquidity.js';
import { buildRebalanceInventoryPlan } from '../analytics/rebalance-plan.js';
import { buildTargetRange, isOutsideRange } from '../math/ticks.js';
import { DEPOSITED_EVENT, HOOK_ABI, WITHDRAWN_EVENT } from '../abi.js';
import { ZERO_ADDRESS } from '../constants.js';

loadDotEnv();
const config = loadConfig();
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);

const wallet = config.walletAddress.toLowerCase();
const fables = new FablesAdapter(readProvider, config);
const quoter = new V4QuoterAdapter(readProvider);
const hookIface = new Interface(HOOK_ABI);
const depositedTopic = id(DEPOSITED_EVENT).toLowerCase();
const withdrawnTopic = id(WITHDRAWN_EVENT).toLowerCase();
const transferTopic = id('Transfer(address,address,uint256)').toLowerCase();
const approvalTopic = id('Approval(address,address,uint256)').toLowerCase();
const claimSelector = hookIface.getFunction('claimFees').selector.toLowerCase();
const walletTopic = zeroPadValue(config.walletAddress, 32).toLowerCase();
const blockTimes = new Map();

console.log('[audit-v2] wallet', config.walletAddress);
const latestBlock = await readProvider.getBlockNumber();
console.log('[audit-v2] latest block', latestBlock);

const discoveredPools = await fables.discoverAllPools();
const poolByFingerprint = new Map(discoveredPools.map((pool) => [poolFingerprint(pool), pool]));
const hooks = new Set(discoveredPools.map((pool) => pool.key.hooks.toLowerCase()));
console.log('[audit-v2] registry pools', discoveredPools.length, 'hooks', hooks.size);

let discoveredHashes = [];
try {
  discoveredHashes = await discoverAddressActivityHashes();
  console.log('[audit-v2] Blockscout discovered tx hashes', discoveredHashes.length);
} catch (error) {
  console.warn('[audit-v2] Blockscout address discovery failed:', error.message);
}

let rows = await mapLimit([...new Set(discoveredHashes)], 8, loadTx);
let rawLifecycle = findRawLifecycle(rows);
if (!rawLifecycle.length) {
  console.log('[audit-v2] no lifecycle in address index; falling back to hook log scan');
  rawLifecycle = await fallbackLifecycleLogs();
  const extra = [...new Set(rawLifecycle.map((x) => x.transactionHash.toLowerCase()))]
    .filter((hash) => !rows.some((r) => r.hash === hash));
  rows.push(...await mapLimit(extra, 6, loadTx));
}
if (!rawLifecycle.length) throw new Error('No Fables lifecycle events found for this wallet');

const rangeInfo = await resolveRanges(rawLifecycle);
const lifecycle = rawLifecycle
  .map((event) => {
    const rangeId = String(event.topics?.[2] || '').toLowerCase();
    const info = rangeInfo.get(rangeKey(event.address, rangeId));
    if (!info) return null;
    return {
      kind: String(event.topics?.[0]).toLowerCase() === depositedTopic ? 'deposit' : 'withdraw',
      blockNumber: Number(event.blockNumber),
      txHash: String(event.transactionHash).toLowerCase(),
      logIndex: Number(event.index || 0),
      hook: event.address,
      rangeId,
      liquidity: BigInt(event.data || 0),
      poolId: info.pool.id,
      pair: pairName(info.pool),
      tickLower: info.tickLower,
      tickUpper: info.tickUpper
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

if (!lifecycle.length) throw new Error('Fables lifecycle events were found but none matched an active registry PoolKey');

const firstFablesBlock = lifecycle[0].blockNumber;
const walletPoolIds = new Set(lifecycle.map((x) => x.poolId));
let walletPools = discoveredPools.filter((pool) => walletPoolIds.has(pool.id));
walletPools = await fables.hydratePoolStates(walletPools);
walletPools = walletPools.filter((pool) => pool.state);
const walletPoolMap = new Map(walletPools.map((pool) => [pool.id, pool]));
console.log('[audit-v2] wallet Fables pools', walletPools.map(pairName));

const hydratedAll = await fables.hydratePoolStates(discoveredPools);
const prices = buildUsdPriceMap(hydratedAll.filter((x) => x.state), config.usdgAddress);
const tokenMap = new Map();
for (const pool of walletPools) {
  tokenMap.set(pool.token0.address.toLowerCase(), pool.token0);
  tokenMap.set(pool.token1.address.toLowerCase(), pool.token1);
}
const tokens = [...tokenMap.values()];

try {
  const tokenTransferHashes = await discoverAddressTokenTransferHashes();
  const existing = new Set(rows.map((r) => r.hash));
  const extra = tokenTransferHashes.filter((hash) => !existing.has(hash));
  console.log('[audit-v2] extra txs from token-transfer index', extra.length);
  rows.push(...await mapLimit(extra, 8, loadTx));
} catch (error) {
  console.warn('[audit-v2] token-transfer index failed:', error.message);
  const tokenTransferHashes = await discoverTokenActivityHashesFromRpc(firstFablesBlock, latestBlock);
  const existing = new Set(rows.map((r) => r.hash));
  const extra = tokenTransferHashes.filter((hash) => !existing.has(hash));
  console.log('[audit-v2] RPC token-transfer fallback extra txs', extra.length);
  rows.push(...await mapLimit(extra, 8, loadTx));
}

const lifecycleHashes = new Set(lifecycle.map((x) => x.txHash));
for (const hash of lifecycleHashes) {
  if (!rows.some((r) => r.hash === hash)) rows.push(await loadTx(hash));
}
rows = dedupeRows(rows).sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex);

const txLedger = rows
  .map((row) => classifyRow(row))
  .filter((tx) => tx.relevant)
  .sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex);

for (const tx of txLedger) tx.timestampMs = await blockTimestamp(tx.blockNumber);
console.log('[audit-v2] relevant transactions', txLedger.length);

const currentWalletBalances = await fables.readWalletBalances(tokens);
const startBalances = reconstructStartBalances(currentWalletBalances, txLedger, firstFablesBlock);

const activePositions = [];
for (const [key, info] of rangeInfo) {
  const pool = walletPoolMap.get(info.pool.id);
  if (!pool) continue;
  const hook = new Contract(info.hook, HOOK_ABI, readProvider);
  const [shares, user] = await Promise.all([
    hook.balanceOf(config.walletAddress, info.rangeId),
    hook.userPosition(info.rangeId, config.walletAddress).catch(() => null)
  ]);
  if (shares === 0n) continue;
  const amounts = rangeAmounts(
    shares,
    pool.state.sqrtPriceX96,
    info.tickLower,
    info.tickUpper,
    pool.token0.decimals,
    pool.token1.decimals
  );
  const owed0 = user ? Number(formatUnits(user.owed0, pool.token0.decimals)) : 0;
  const owed1 = user ? Number(formatUnits(user.owed1, pool.token1.decimals)) : 0;
  activePositions.push({
    rangeMapKey: key,
    rangeId: info.rangeId,
    poolId: pool.id,
    pair: pairName(pool),
    hook: info.hook,
    tick: pool.state.tick,
    tickLower: info.tickLower,
    tickUpper: info.tickUpper,
    shares: shares.toString(),
    amount0: amounts.amount0,
    amount1: amounts.amount1,
    owed0,
    owed1,
    symbol0: pool.token0.symbol,
    symbol1: pool.token1.symbol,
    token0: pool.token0.address,
    token1: pool.token1.address
  });
}

const epochBenchmarks = buildEpochBenchmarks(lifecycle, txLedger, walletPoolMap);
for (const position of activePositions) {
  const pool = walletPoolMap.get(position.poolId);
  const price0 = priceOf(position.token0);
  const price1 = priceOf(position.token1);
  const principalUsd = position.amount0 * price0 + position.amount1 * price1;
  const owedUsd = position.owed0 * price0 + position.owed1 * price1;
  const epoch = epochBenchmarks.get(rangeKey(position.hook, position.rangeId));
  const hodl0 = epoch?.complete ? epoch.hodl0 : null;
  const hodl1 = epoch?.complete ? epoch.hodl1 : null;
  const hodlUsd = hodl0 == null || hodl1 == null ? null : hodl0 * price0 + hodl1 * price1;
  const ilUsd = hodlUsd == null ? null : principalUsd - hodlUsd;
  const ilPct = hodlUsd > 0 && Number.isFinite(ilUsd) ? ilUsd / hodlUsd * 100 : null;
  const outside = isOutsideRange(pool.state.tick, position.tickLower, position.tickUpper, config.edgeBufferTicks);
  const target = buildTargetRange(pool.state.tick, pool.key.tickSpacing, config.tightWidthBps, config.rangePreset);
  let inventoryPlan = null;
  let quote = null;
  let quoteError = null;
  if (outside && price0 > 0 && price1 > 0) {
    try {
      inventoryPlan = buildRebalanceInventoryPlan({
        amount0: position.amount0 + position.owed0,
        amount1: position.amount1 + position.owed1,
        price0Usd: price0,
        price1Usd: price1,
        sqrtPriceX96: pool.state.sqrtPriceX96,
        tickLower: target.tickLower,
        tickUpper: target.tickUpper,
        decimals0: pool.token0.decimals,
        decimals1: pool.token1.decimals
      });
      if (inventoryPlan.direction !== 'none' && inventoryPlan.amountIn > 0) {
        quote = await quoter.quoteExactInputSingle(pool, inventoryPlan.tokenIn, inventoryPlan.amountIn, config.swapSlippageBps);
      }
    } catch (error) {
      quoteError = error.message;
    }
  }
  Object.assign(position, {
    price0Usd: price0,
    price1Usd: price1,
    principalUsd,
    owedUsd,
    hodl0,
    hodl1,
    hodlUsd,
    ilUsd,
    ilPct,
    outside,
    autoAction: outside ? 'WAIT_SECOND_CONFIRMATION_THEN_REBALANCE' : 'HOLD_IN_RANGE',
    target,
    inventoryPlan,
    quote,
    quoteError
  });
}

const feeSummary = calculateFees(txLedger, activePositions, walletPoolMap);
const currentPortfolio = calculateCurrentPortfolio(tokens, currentWalletBalances, activePositions);
const swapPricePoints = buildSwapPricePoints(txLedger);
const externalCashflows = classifyExternalCashflows(txLedger, swapPricePoints);
const initialCapital = estimateInitialCapital(startBalances, swapPricePoints, firstFablesBlock);
const hodlUnits = { ...startBalances };
for (const flow of externalCashflows) {
  for (const [token, delta] of Object.entries(flow.deltas)) hodlUnits[token] = (hodlUnits[token] || 0) + delta;
}
const hodlCurrentUsd = valueTokenUnits(hodlUnits);
const externalCashflowUsd = externalCashflows.reduce((sum, x) => sum + x.usd, 0);
const totalGasEth = txLedger.reduce((sum, x) => sum + x.gasEth, 0);
const currentEthPrice = priceOf(ZERO_ADDRESS);
const gasUsdCurrent = totalGasEth * currentEthPrice;
const netPnlUsd = Number.isFinite(initialCapital.usd)
  ? currentPortfolio.totalUsd - initialCapital.usd - externalCashflowUsd - gasUsdCurrent
  : null;
const excessVsHodlUsd = currentPortfolio.totalUsd - hodlCurrentUsd - gasUsdCurrent;
const activeIlUsd = activePositions.reduce((sum, p) => sum + (Number.isFinite(p.ilUsd) ? p.ilUsd : 0), 0);
const scanEndBlock = await readProvider.getBlockNumber();
const postSnapshotLifecycle = scanEndBlock > latestBlock
  ? await scanWalletLifecycleWindow(latestBlock + 1, scanEndBlock)
  : [];
const topologyChangedDuringScan = postSnapshotLifecycle.length > 0;

const report = {
  generatedAt: new Date().toISOString(),
  wallet: config.walletAddress,
  chainId: config.chainId,
  latestBlock,
  scanEndBlock,
  snapshotConsistency: {
    asOfBlock: latestBlock,
    scanEndBlock,
    topologyChangedDuringScan,
    lifecycleEventsAfterSnapshot: postSnapshotLifecycle
  },
  firstFablesBlock,
  firstFablesTime: new Date(await blockTimestamp(firstFablesBlock)).toISOString(),
  walletPools: walletPools.map((pool) => ({
    id: pool.id,
    pair: pairName(pool),
    hook: pool.key.hooks,
    tick: pool.state.tick,
    token0: pool.token0,
    token1: pool.token1
  })),
  prices: Object.fromEntries(tokens.map((token) => [token.symbol, priceOf(token.address)])),
  startingWalletBalances: Object.fromEntries(tokens.map((token) => [token.symbol, startBalances[token.address.toLowerCase()] || 0])),
  initialCapital,
  currentPortfolio,
  pnl: {
    externalCashflowUsd,
    totalGasEth,
    gasUsdAtCurrentEth: gasUsdCurrent,
    netPnlUsd,
    hodlCurrentUsd,
    excessVsHodlUsd,
    activePositionIlUsd: activeIlUsd
  },
  fees: feeSummary,
  activePositions,
  externalCashflows,
  transactions: txLedger,
  lifecycle: lifecycle.map((x) => ({ ...x, liquidity: x.liquidity.toString() })),
  notes: [
    topologyChangedDuringScan
      ? 'WARNING: wallet Fables topology changed after the audit snapshot block; portfolio/active-position figures are an as-of snapshot, not end-of-scan current state.'
      : 'Snapshot consistency check passed: no wallet Fables deposit/withdraw occurred after the audit snapshot block during this scan.',
    'Pool association is resolved from rangeKey() full PoolKey, not hook address alone.',
    'Active-position IL compares current LP principal (fees excluded) with the remaining wallet-boundary token mix supplied to that range epoch.',
    'Confirmed fee income equals explicit claimFees wallet inflows plus currently owed fees; this is a conservative on-chain lower bound if a protocol route pays fees through a non-claim path.',
    'Gas ETH is exact from receipts; gas USD is translated using the current ETH/USD price.',
    'Initial non-USDG token prices use the nearest observed wallet USDG swap price when historical archive state is unavailable.',
    'Auto rebalance shown here is a one-point scan; production BOT still requires the configured second out-of-range confirmation before execution.'
  ]
};

writeReports(report, renderMarkdown(report));
console.log(JSON.stringify({
  ok: true,
  wallet: report.wallet,
  pools: report.walletPools.map((x) => x.pair),
  relevantTransactions: report.transactions.length,
  activePositions: report.activePositions.length,
  topologyChangedDuringScan: report.snapshotConsistency.topologyChangedDuringScan,
  scanEndBlock: report.scanEndBlock,
  currentValueUsd: report.currentPortfolio.totalUsd,
  initialCapitalUsd: report.initialCapital.usd,
  netPnlUsd: report.pnl.netPnlUsd,
  hodlCurrentUsd: report.pnl.hodlCurrentUsd,
  excessVsHodlUsd: report.pnl.excessVsHodlUsd,
  activeIlUsd: report.pnl.activePositionIlUsd,
  feeUsdCurrent: report.fees.totalFeeUsdCurrent,
  gasEth: report.pnl.totalGasEth,
  report: path.join(config.dataDir, 'audits', 'latest-v2.md')
}, null, 2));

async function scanWalletLifecycleWindow(fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];
  const found = [];
  for (const hook of hooks) {
    const logs = await fables.getLogsAdaptive(
      { address: hook, topics: [[depositedTopic, withdrawnTopic], walletTopic] },
      fromBlock,
      toBlock
    );
    for (const log of logs) {
      found.push({
        blockNumber: Number(log.blockNumber),
        transactionHash: String(log.transactionHash || '').toLowerCase(),
        hook,
        rangeId: String(log.topics?.[2] || '').toLowerCase(),
        kind: String(log.topics?.[0] || '').toLowerCase() === depositedTopic ? 'deposit' : 'withdraw'
      });
    }
  }
  return found.sort((a, b) => a.blockNumber - b.blockNumber);
}

async function discoverAddressActivityHashes() {
  const txs = await fetchBlockscoutPages('/addresses/' + config.walletAddress + '/transactions');
  return txs.map((x) => String(x.hash || '').toLowerCase()).filter(isHash);
}

async function discoverAddressTokenTransferHashes() {
  const transfers = await fetchBlockscoutPages('/addresses/' + config.walletAddress + '/token-transfers');
  return transfers
    .map((x) => String(x.transaction_hash || x.tx_hash || x.hash || '').toLowerCase())
    .filter(isHash);
}

async function discoverTokenActivityHashesFromRpc(fromBlock, toBlock) {
  const hashes = new Set();
  for (const token of tokens) {
    if (token.address.toLowerCase() === ZERO_ADDRESS) continue;
    const outgoing = await fables.getLogsAdaptive(
      { address: token.address, topics: [transferTopic, walletTopic] },
      fromBlock,
      toBlock
    );
    const incoming = await fables.getLogsAdaptive(
      { address: token.address, topics: [transferTopic, null, walletTopic] },
      fromBlock,
      toBlock
    );
    for (const log of [...outgoing, ...incoming]) {
      const hash = String(log.transactionHash || '').toLowerCase();
      if (isHash(hash)) hashes.add(hash);
    }
  }
  return [...hashes];
}

async function fetchBlockscoutPages(pathname) {
  const base = 'https://robinhoodchain.blockscout.com/api/v2' + pathname;
  const out = [];
  let params = {};
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'auto-LP-bot/0.2.1 wallet-audit-v2' }
    });
    if (!response.ok) throw new Error('Blockscout ' + response.status + ' ' + response.statusText);
    const body = await response.json();
    const items = Array.isArray(body.items) ? body.items : [];
    out.push(...items);
    if (!body.next_page_params) break;
    params = body.next_page_params;
  }
  return out;
}

function findRawLifecycle(txRows) {
  const found = [];
  for (const row of txRows) {
    for (const log of row.receipt?.logs || []) {
      if (!hooks.has(String(log.address).toLowerCase())) continue;
      const topic0 = String(log.topics?.[0] || '').toLowerCase();
      if (topic0 !== depositedTopic && topic0 !== withdrawnTopic) continue;
      if (topicAddress(log.topics?.[1]) !== wallet) continue;
      found.push({
        ...log,
        address: log.address,
        blockNumber: row.blockNumber,
        transactionHash: row.hash
      });
    }
  }
  return found;
}

async function fallbackLifecycleLogs() {
  const found = [];
  for (const hook of [...hooks]) {
    const logs = await fables.getLogsAdaptive(
      { address: hook, topics: [[depositedTopic, withdrawnTopic], walletTopic] },
      config.logFromBlock,
      latestBlock
    );
    found.push(...logs);
  }
  return found;
}

async function resolveRanges(events) {
  const map = new Map();
  const unique = new Map();
  for (const event of events) {
    const rid = String(event.topics?.[2] || '').toLowerCase();
    if (!rid) continue;
    unique.set(rangeKey(event.address, rid), { hook: event.address, rangeId: rid });
  }
  await mapLimit([...unique.values()], 6, async ({ hook, rangeId }) => {
    try {
      const contract = new Contract(hook, HOOK_ABI, readProvider);
      const result = await contract.rangeKey(rangeId);
      if (!result.exists) return;
      const fingerprint = tupleFingerprint(result.key);
      const pool = poolByFingerprint.get(fingerprint);
      if (!pool) {
        console.warn('[audit-v2] range PoolKey not found in active registry', rangeId, fingerprint);
        return;
      }
      map.set(rangeKey(hook, rangeId), {
        hook,
        rangeId,
        pool,
        tickLower: Number(result.tickLower),
        tickUpper: Number(result.tickUpper)
      });
    } catch (error) {
      console.warn('[audit-v2] rangeKey read failed', rangeId, error.message);
    }
  });
  return map;
}

function classifyRow(row) {
  const deltas = receiptTokenDeltas(row.receipt);
  const events = lifecycle.filter((x) => x.txHash === row.hash);
  const hasRelevantTransfer = Object.values(deltas).some((x) => Math.abs(x) > 0);
  const hasApproval = receiptHasRelevantApproval(row.receipt);
  const selector = String(row.tx?.data || '').slice(0, 10).toLowerCase();
  const to = String(row.tx?.to || '').toLowerCase();
  let claimPool = null;
  if (hooks.has(to) && selector === claimSelector) {
    try {
      const decoded = hookIface.parseTransaction({ data: row.tx.data, value: row.tx.value });
      const key = decoded?.args?.[0];
      if (key) claimPool = poolByFingerprint.get(tupleFingerprint(key)) || null;
    } catch {}
  }
  let classification = 'irrelevant';
  if (events.some((x) => x.kind === 'deposit') && events.some((x) => x.kind === 'withdraw')) classification = 'manual_rebalance';
  else if (events.some((x) => x.kind === 'deposit')) classification = 'lp_deposit';
  else if (events.some((x) => x.kind === 'withdraw')) classification = 'lp_withdraw';
  else if (claimPool) classification = 'claim_fees';
  else if (isSwapDeltas(deltas)) classification = 'swap';
  else if (hasApproval) classification = 'approval';
  else if (hasRelevantTransfer) classification = String(row.tx?.from || '').toLowerCase() === wallet ? 'external_or_contract_out' : 'external_or_protocol_in';

  const initiatedByWallet = String(row.tx?.from || '').toLowerCase() === wallet;
  const gasWei = initiatedByWallet && row.receipt
    ? BigInt(row.receipt.gasUsed || 0) * BigInt(row.receipt.gasPrice || row.tx?.gasPrice || 0)
    : 0n;
  return {
    relevant: classification !== 'irrelevant',
    hash: row.hash,
    blockNumber: row.blockNumber,
    transactionIndex: row.transactionIndex,
    classification,
    from: row.tx?.from || null,
    to: row.tx?.to || null,
    selector,
    deltas,
    gasEth: Number(formatUnits(gasWei, 18)),
    lifecycle: events.map((x) => ({ kind: x.kind, pair: x.pair, rangeId: x.rangeId, liquidity: x.liquidity.toString() })),
    claimPoolId: claimPool?.id || null,
    claimPair: claimPool ? pairName(claimPool) : null
  };
}

function receiptTokenDeltas(receipt) {
  const result = {};
  for (const token of tokens) result[token.address.toLowerCase()] = 0;
  for (const log of receipt?.logs || []) {
    if (String(log.topics?.[0]).toLowerCase() !== transferTopic) continue;
    const token = tokenMap.get(String(log.address).toLowerCase());
    if (!token || token.address.toLowerCase() === ZERO_ADDRESS) continue;
    const from = topicAddress(log.topics?.[1]);
    const to = topicAddress(log.topics?.[2]);
    const amount = Number(formatUnits(BigInt(log.data || 0), token.decimals));
    const key = token.address.toLowerCase();
    if (from === wallet) result[key] -= amount;
    if (to === wallet) result[key] += amount;
  }
  return result;
}

function receiptHasRelevantApproval(receipt) {
  for (const log of receipt?.logs || []) {
    if (String(log.topics?.[0]).toLowerCase() !== approvalTopic) continue;
    if (!tokenMap.has(String(log.address).toLowerCase())) continue;
    if (topicAddress(log.topics?.[1]) === wallet) return true;
  }
  return false;
}

function isSwapDeltas(deltas) {
  const values = Object.values(deltas).filter((x) => Math.abs(x) > 1e-12);
  return values.some((x) => x > 0) && values.some((x) => x < 0);
}

function reconstructStartBalances(current, ledger, firstBlock) {
  const start = {};
  for (const token of tokens) {
    const key = token.address.toLowerCase();
    const currentAmount = Number(current[key]?.amount || 0);
    const netDelta = ledger
      .filter((tx) => tx.blockNumber >= firstBlock)
      .reduce((sum, tx) => sum + Number(tx.deltas[key] || 0), 0);
    start[key] = currentAmount - netDelta;
    if (Math.abs(start[key]) < 1e-8) start[key] = 0;
  }
  return start;
}

function buildEpochBenchmarks(events, ledger, pools) {
  const byTx = new Map(ledger.map((tx) => [tx.hash, tx]));
  const depositGroups = new Map();
  for (const event of events.filter((x) => x.kind === 'deposit')) {
    const key = event.txHash + ':' + event.poolId;
    const list = depositGroups.get(key) || [];
    list.push(event);
    depositGroups.set(key, list);
  }
  const result = new Map();
  for (const event of events) {
    const key = rangeKey(event.hook, event.rangeId);
    let state = result.get(key) || { liquidity: 0n, hodl0: 0, hodl1: 0, complete: true, epochStartBlock: event.blockNumber };
    if (event.kind === 'deposit') {
      if (state.liquidity === 0n) state = { liquidity: 0n, hodl0: 0, hodl1: 0, complete: true, epochStartBlock: event.blockNumber };
      const pool = pools.get(event.poolId);
      const tx = byTx.get(event.txHash);
      const group = depositGroups.get(event.txHash + ':' + event.poolId) || [event];
      const totalL = group.reduce((sum, x) => sum + x.liquidity, 0n);
      const share = totalL > 0n ? Number(event.liquidity) / Number(totalL) : 1 / group.length;
      if (pool && tx) {
        const d0 = Number(tx.deltas[pool.token0.address.toLowerCase()] || 0);
        const d1 = Number(tx.deltas[pool.token1.address.toLowerCase()] || 0);
        const supplied0 = Math.max(0, -d0) * share;
        const supplied1 = Math.max(0, -d1) * share;
        if (supplied0 === 0 && supplied1 === 0) state.complete = false;
        state.hodl0 += supplied0;
        state.hodl1 += supplied1;
      } else {
        state.complete = false;
      }
      state.liquidity += event.liquidity;
    } else {
      const before = state.liquidity;
      if (before > 0n) {
        const ratio = Math.min(1, Number(event.liquidity) / Number(before));
        state.hodl0 *= 1 - ratio;
        state.hodl1 *= 1 - ratio;
        state.liquidity = event.liquidity >= before ? 0n : before - event.liquidity;
      }
      if (state.liquidity === 0n) {
        state.hodl0 = 0;
        state.hodl1 = 0;
      }
    }
    result.set(key, state);
  }
  return result;
}

function calculateFees(ledger, positions, pools) {
  const byToken = {};
  for (const token of tokens) byToken[token.address.toLowerCase()] = { symbol: token.symbol, realized: 0, unclaimed: 0, priceUsd: priceOf(token.address) };
  const claims = [];
  for (const tx of ledger.filter((x) => x.classification === 'claim_fees' && x.claimPoolId)) {
    const pool = pools.get(tx.claimPoolId);
    if (!pool) continue;
    const a0 = Math.max(0, Number(tx.deltas[pool.token0.address.toLowerCase()] || 0));
    const a1 = Math.max(0, Number(tx.deltas[pool.token1.address.toLowerCase()] || 0));
    byToken[pool.token0.address.toLowerCase()].realized += a0;
    byToken[pool.token1.address.toLowerCase()].realized += a1;
    claims.push({ hash: tx.hash, blockNumber: tx.blockNumber, pair: pairName(pool), amount0: a0, amount1: a1, symbol0: pool.token0.symbol, symbol1: pool.token1.symbol });
  }
  for (const position of positions) {
    byToken[position.token0.toLowerCase()].unclaimed += position.owed0;
    byToken[position.token1.toLowerCase()].unclaimed += position.owed1;
  }
  let realizedFeeUsdCurrent = 0;
  let unclaimedFeeUsdCurrent = 0;
  for (const x of Object.values(byToken)) {
    realizedFeeUsdCurrent += x.realized * x.priceUsd;
    unclaimedFeeUsdCurrent += x.unclaimed * x.priceUsd;
  }
  return {
    method: 'explicit claimFees wallet inflows + current userPosition owed',
    byToken,
    claims,
    realizedFeeUsdCurrent,
    unclaimedFeeUsdCurrent,
    totalFeeUsdCurrent: realizedFeeUsdCurrent + unclaimedFeeUsdCurrent
  };
}

function calculateCurrentPortfolio(strategyTokens, balances, positions) {
  const byToken = {};
  for (const token of strategyTokens) {
    const key = token.address.toLowerCase();
    byToken[key] = {
      symbol: token.symbol,
      wallet: Number(balances[key]?.amount || 0),
      lpPrincipal: 0,
      owedFees: 0,
      priceUsd: priceOf(token.address)
    };
  }
  for (const p of positions) {
    byToken[p.token0.toLowerCase()].lpPrincipal += p.amount0;
    byToken[p.token1.toLowerCase()].lpPrincipal += p.amount1;
    byToken[p.token0.toLowerCase()].owedFees += p.owed0;
    byToken[p.token1.toLowerCase()].owedFees += p.owed1;
  }
  let totalUsd = 0;
  for (const x of Object.values(byToken)) {
    x.total = x.wallet + x.lpPrincipal + x.owedFees;
    x.valueUsd = x.total * x.priceUsd;
    totalUsd += x.valueUsd;
  }
  return { byToken, totalUsd };
}

function buildSwapPricePoints(ledger) {
  const points = {};
  const usdg = config.usdgAddress.toLowerCase();
  for (const tx of ledger.filter((x) => x.classification === 'swap')) {
    const usdDelta = Number(tx.deltas[usdg] || 0);
    if (Math.abs(usdDelta) < 1e-12) continue;
    for (const token of tokens) {
      const key = token.address.toLowerCase();
      if (key === usdg) continue;
      const delta = Number(tx.deltas[key] || 0);
      if (delta * usdDelta >= 0 || Math.abs(delta) < 1e-12) continue;
      const price = Math.abs(usdDelta / delta);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!points[key]) points[key] = [];
      points[key].push({ blockNumber: tx.blockNumber, price });
    }
  }
  for (const list of Object.values(points)) list.sort((a, b) => a.blockNumber - b.blockNumber);
  return points;
}

function estimatePrice(tokenAddress, blockNumber, swapPoints) {
  const key = tokenAddress.toLowerCase();
  if (key === config.usdgAddress.toLowerCase()) return 1;
  const list = swapPoints[key] || [];
  if (list.length) {
    let best = list[0];
    let distance = Math.abs(best.blockNumber - blockNumber);
    for (const point of list) {
      const d = Math.abs(point.blockNumber - blockNumber);
      if (d < distance) { best = point; distance = d; }
    }
    return best.price;
  }
  return priceOf(tokenAddress);
}

function classifyExternalCashflows(ledger, swapPoints) {
  const flows = [];
  for (const tx of ledger) {
    if (!['external_or_contract_out', 'external_or_protocol_in'].includes(tx.classification)) continue;
    const nonzero = Object.entries(tx.deltas).filter(([, value]) => Math.abs(value) > 1e-12);
    if (!nonzero.length) continue;
    let usd = 0;
    for (const [token, delta] of nonzero) usd += delta * estimatePrice(token, tx.blockNumber, swapPoints);
    flows.push({ hash: tx.hash, blockNumber: tx.blockNumber, timestampMs: tx.timestampMs, deltas: Object.fromEntries(nonzero), usd });
  }
  return flows;
}

function estimateInitialCapital(start, swapPoints, blockNumber) {
  let usd = 0;
  const byToken = {};
  for (const token of tokens) {
    const key = token.address.toLowerCase();
    const amount = Number(start[key] || 0);
    const priceUsd = estimatePrice(key, blockNumber, swapPoints);
    const valueUsd = amount * priceUsd;
    byToken[key] = { symbol: token.symbol, amount, priceUsd, valueUsd };
    usd += valueUsd;
  }
  return { usd, byToken, priceMethod: 'nearest observed USDG swap; USDG=1; current price fallback' };
}

function valueTokenUnits(units) {
  let total = 0;
  for (const [token, amount] of Object.entries(units)) total += Number(amount || 0) * priceOf(token);
  return total;
}

function priceOf(address) {
  const value = Number(prices.get(String(address).toLowerCase()));
  return Number.isFinite(value) ? value : 0;
}

async function loadTx(hash) {
  const [tx, receipt] = await Promise.all([
    readProvider.getTransaction(hash),
    readProvider.getTransactionReceipt(hash)
  ]);
  if (!tx || !receipt) return { hash: hash.toLowerCase(), tx, receipt, blockNumber: 0, transactionIndex: 0 };
  return {
    hash: hash.toLowerCase(),
    tx,
    receipt,
    blockNumber: Number(receipt.blockNumber || tx.blockNumber || 0),
    transactionIndex: Number(receipt.index || tx.index || 0)
  };
}

function dedupeRows(input) {
  const map = new Map();
  for (const row of input) if (row?.hash && row.receipt) map.set(row.hash, row);
  return [...map.values()];
}

async function blockTimestamp(blockNumber) {
  if (blockTimes.has(blockNumber)) return blockTimes.get(blockNumber);
  const block = await readProvider.getBlock(blockNumber);
  const ms = block ? Number(block.timestamp) * 1000 : Date.now();
  blockTimes.set(blockNumber, ms);
  return ms;
}

function poolFingerprint(pool) {
  return [pool.key.currency0, pool.key.currency1, pool.key.fee, pool.key.tickSpacing, pool.key.hooks]
    .map((x) => String(x).toLowerCase()).join(':');
}

function tupleFingerprint(key) {
  return [key.currency0, key.currency1, Number(key.fee), Number(key.tickSpacing), key.hooks]
    .map((x) => String(x).toLowerCase()).join(':');
}

function pairName(pool) { return pool.token0.symbol + '/' + pool.token1.symbol; }
function rangeKey(hook, rangeId) { return String(hook).toLowerCase() + ':' + String(rangeId).toLowerCase(); }
function isHash(value) { return /^0x[0-9a-f]{64}$/.test(value); }

function topicAddress(value) {
  const x = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(x)) return null;
  return '0x' + x.slice(-40);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker()));
  return out;
}

function writeReports(report, markdown) {
  const dir = path.join(config.dataDir, 'audits');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest-v2.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'latest-v2.md'), markdown);
}

function renderMarkdown(report) {
  const f = (x, digits = 4) => Number.isFinite(Number(x)) ? Number(x).toLocaleString('en-US', { maximumFractionDigits: digits }) : 'N/A';
  const usd = (x) => Number.isFinite(Number(x)) ? '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A';
  const pct = (x) => Number.isFinite(Number(x)) ? Number(x).toFixed(2) + '%' : 'N/A';
  const lines = [];
  lines.push('# Fables Wallet Audit v2');
  lines.push('');
  lines.push('- Wallet: `' + report.wallet + '`');
  lines.push('- Generated: ' + report.generatedAt);
  lines.push('- Snapshot block: ' + report.latestBlock + ' (scan ended at ' + report.scanEndBlock + ')');
  if (report.snapshotConsistency?.topologyChangedDuringScan) {
    lines.push('');
    lines.push('> **STALE SNAPSHOT WARNING:** Fables deposit/withdraw activity occurred after the snapshot block while this audit was running. Active-position and current-value fields are valid only as-of the snapshot block.');
  }
  lines.push('- First observed Fables operation: block ' + report.firstFablesBlock + ' · ' + report.firstFablesTime);
  lines.push('- Pools touched: ' + report.walletPools.map((x) => x.pair).join(', '));
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Result |');
  lines.push('|---|---:|');
  lines.push('| Current strategy value | ' + usd(report.currentPortfolio.totalUsd) + ' |');
  lines.push('| Estimated initial capital | ' + usd(report.initialCapital.usd) + ' |');
  lines.push('| Net external cashflow after start | ' + usd(report.pnl.externalCashflowUsd) + ' |');
  lines.push('| Net PnL after external cashflow + gas | ' + usd(report.pnl.netPnlUsd) + ' |');
  lines.push('| Current HODL benchmark | ' + usd(report.pnl.hodlCurrentUsd) + ' |');
  lines.push('| Excess / deficit vs HODL after gas | ' + usd(report.pnl.excessVsHodlUsd) + ' |');
  lines.push('| Active-position IL | ' + usd(report.pnl.activePositionIlUsd) + ' |');
  lines.push('| Confirmed fees + currently owed | ' + usd(report.fees.totalFeeUsdCurrent) + ' |');
  lines.push('| Gas | ' + f(report.pnl.totalGasEth, 8) + ' ETH (~' + usd(report.pnl.gasUsdAtCurrentEth) + ' @ current ETH) |');
  lines.push('');
  lines.push('## Active LP positions');
  lines.push('');
  lines.push('| Pair | Range | Tick | Status | Principal | Owed fees | IL | Bot action | Quote |');
  lines.push('|---|---|---:|---|---:|---:|---:|---|---|');
  for (const p of report.activePositions) {
    const quote = p.quote
      ? p.quote.symbolIn + '→' + p.quote.symbolOut + ' ' + f(p.quote.amountIn, 6) + ' → ' + f(p.quote.amountOut, 6) + ' (min ' + f(p.quote.minAmountOut, 6) + ')'
      : p.quoteError ? 'quote failed: ' + p.quoteError : '--';
    lines.push('| ' + p.pair + ' | ' + p.tickLower + '…' + p.tickUpper + ' | ' + p.tick + ' | ' + (p.outside ? 'OUT' : 'IN') + ' | ' + usd(p.principalUsd) + ' | ' + usd(p.owedUsd) + ' | ' + usd(p.ilUsd) + ' / ' + pct(p.ilPct) + ' | ' + p.autoAction + ' | ' + quote + ' |');
  }
  lines.push('');
  lines.push('## Fees');
  lines.push('');
  lines.push('| Token | Realized claim | Currently owed | Current USD value |');
  lines.push('|---|---:|---:|---:|');
  for (const item of Object.values(report.fees.byToken)) {
    lines.push('| ' + item.symbol + ' | ' + f(item.realized, 8) + ' | ' + f(item.unclaimed, 8) + ' | ' + usd((item.realized + item.unclaimed) * item.priceUsd) + ' |');
  }
  lines.push('');
  lines.push('## Relevant transactions');
  lines.push('');
  lines.push('Total: ' + report.transactions.length);
  lines.push('');
  lines.push('| Time | Type | Tx | Pair / claim | Gas ETH | Token deltas |');
  lines.push('|---|---|---|---|---:|---|');
  for (const tx of report.transactions) {
    const deltaText = Object.entries(tx.deltas)
      .filter(([, v]) => Math.abs(v) > 1e-12)
      .map(([addr, v]) => {
        const token = report.currentPortfolio.byToken[addr];
        return (token?.symbol || addr.slice(0, 8)) + ' ' + (v >= 0 ? '+' : '') + f(v, 6);
      }).join(', ');
    const pair = tx.claimPair || tx.lifecycle.map((x) => x.pair).join(', ');
    lines.push('| ' + new Date(tx.timestampMs).toISOString() + ' | ' + tx.classification + ' | `' + tx.hash.slice(0, 10) + '…' + tx.hash.slice(-6) + '` | ' + pair + ' | ' + f(tx.gasEth, 8) + ' | ' + deltaText + ' |');
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const note of report.notes) lines.push('- ' + note);
  return lines.join('\n');
}
