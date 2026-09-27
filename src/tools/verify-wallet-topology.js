import fs from 'node:fs';
import { Contract, zeroPadValue, id } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { REGISTRY_ABI, HOOK_ABI, DEPOSITED_EVENT, WITHDRAWN_EVENT } from '../abi.js';

loadDotEnv();
const config = loadConfig();
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);

const snapshot = JSON.parse(fs.readFileSync('data/latest-snapshot.json', 'utf8'));
const state = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
const registry = new Contract(config.registryAddress, REGISTRY_ABI, readProvider);
const entries = await registry.activePools();
const pools = [];
for (const entry of entries) {
  if (!entry.active) continue;
  pools.push({
    id: String(entry.id).toLowerCase(),
    key: {
      currency0: String(entry.key.currency0).toLowerCase(),
      currency1: String(entry.key.currency1).toLowerCase(),
      fee: Number(entry.key.fee),
      tickSpacing: Number(entry.key.tickSpacing),
      hooks: String(entry.key.hooks).toLowerCase()
    }
  });
}
const poolByFingerprint = new Map(pools.map((pool) => [fingerprint(pool.key), pool]));
const hooks = [...new Set(pools.map((pool) => pool.key.hooks))];
const candidates = new Map();
for (const value of state.settings?.walletRangeCandidates || []) {
  const [hook, rangeId] = String(value).split('|');
  if (isAddress(hook) && isBytes32(rangeId)) candidates.set(candidateKey(hook, rangeId), { hook, rangeId });
}

const latestBlock = await readProvider.getBlockNumber();
const fromBlock = Number(process.env.VERIFY_FROM_BLOCK || config.walletPoolDiscoveryFromBlock);
const walletTopic = zeroPadValue(config.walletAddress, 32).toLowerCase();
const lifecycleTopics = [id(DEPOSITED_EVENT), id(WITHDRAWN_EVENT)];

for (const hook of hooks) {
  const logs = await getLogsAdaptive({
    address: hook,
    topics: [lifecycleTopics, walletTopic]
  }, fromBlock, latestBlock);
  for (const log of logs) {
    const rangeId = String(log.topics?.[2] || '').toLowerCase();
    if (!isBytes32(rangeId)) continue;
    candidates.set(candidateKey(hook, rangeId), { hook, rangeId });
  }
}

const activePoolIds = new Set();
const knownPoolIds = new Set();
const activeRangeKeys = new Set();
const detail = [];
const hookContracts = new Map();
for (const candidate of candidates.values()) {
  let hook = hookContracts.get(candidate.hook);
  if (!hook) {
    hook = new Contract(candidate.hook, HOOK_ABI, readProvider);
    hookContracts.set(candidate.hook, hook);
  }
  const [range, shares] = await Promise.all([
    hook.rangeKey(candidate.rangeId),
    hook.balanceOf(config.walletAddress, candidate.rangeId)
  ]);
  if (!range.exists) continue;
  const pool = poolByFingerprint.get(fingerprint(range.key));
  if (!pool) throw new Error('rangeKey points to pool missing from active registry: ' + candidate.rangeId);
  knownPoolIds.add(pool.id);
  const active = BigInt(shares) > 0n;
  if (active) {
    activePoolIds.add(pool.id);
    activeRangeKeys.add(candidateKey(candidate.hook, candidate.rangeId));
  }
  detail.push({
    poolId: pool.id,
    rangeKey: candidateKey(candidate.hook, candidate.rangeId),
    shares: BigInt(shares).toString(),
    active
  });
}

const actualPools = sortSet(activePoolIds);
const actualRanges = sortSet(activeRangeKeys);
const knownPools = sortSet(knownPoolIds);
const botPools = sortList(snapshot.bot?.activePoolIds || []);
const botRanges = sortList(state.settings?.activeWalletRangeKeys || []);
const accountingPools = sortList(snapshot.bot?.accountingPoolIds || []);

assertEqual('active pool IDs', botPools, actualPools);
assertEqual('active range keys', botRanges, actualRanges);
for (const id of knownPools) {
  if (!accountingPools.includes(id)) throw new Error('accounting pool missing known historical pool ' + id);
}

for (const pool of snapshot.pools || []) {
  if (!actualPools.includes(String(pool.id).toLowerCase())) {
    throw new Error('snapshot contains non-active execution pool ' + pool.id);
  }
  if (!(pool.positions || []).length) throw new Error('active pool has no positions in snapshot ' + pool.id);
}
const snapshotRangeKeys = new Set();
for (const pool of snapshot.pools || []) {
  for (const position of pool.positions || []) {
    snapshotRangeKeys.add(candidateKey(pool.hook, position.id));
  }
}
for (const rangeKey of actualRanges) {
  if (!snapshotRangeKeys.has(rangeKey)) throw new Error('active on-chain range missing from snapshot ' + rangeKey);
}

console.log(JSON.stringify({
  ok: true,
  verifiedAtBlock: latestBlock,
  scannedFromBlock: fromBlock,
  activePoolIds: actualPools,
  activeRangeKeys: actualRanges,
  accountingPoolIds: accountingPools,
  candidateCount: candidates.size,
  details: detail.filter((x) => x.active)
}, null, 2));

async function getLogsAdaptive(filter, from, to) {
  const out = [];
  let cursor = from;
  let span = Math.max(1, Number(process.env.VERIFY_LOG_CHUNK_BLOCKS || 500000));
  const minSpan = 25000;
  while (cursor <= to) {
    const end = Math.min(to, cursor + span - 1);
    try {
      out.push(...await readProvider.getLogs({ ...filter, fromBlock: cursor, toBlock: end }));
      cursor = end + 1;
    } catch (error) {
      if (span <= minSpan) throw error;
      span = Math.max(minSpan, Math.floor(span / 2));
    }
  }
  return out;
}

function fingerprint(key) {
  return [
    String(key.currency0).toLowerCase(),
    String(key.currency1).toLowerCase(),
    Number(key.fee),
    Number(key.tickSpacing),
    String(key.hooks).toLowerCase()
  ].join(':');
}
function candidateKey(hook, rangeId) { return String(hook).toLowerCase() + '|' + String(rangeId).toLowerCase(); }
function isAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(String(value || '')); }
function isBytes32(value) { return /^0x[0-9a-fA-F]{64}$/.test(String(value || '')); }
function sortSet(set) { return [...set].map((x) => String(x).toLowerCase()).sort(); }
function sortList(list) { return [...list].map((x) => String(x).toLowerCase()).sort(); }
function assertEqual(label, expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(label + ' mismatch\nBOT: ' + JSON.stringify(expected) + '\nCHAIN: ' + JSON.stringify(actual));
  }
}
