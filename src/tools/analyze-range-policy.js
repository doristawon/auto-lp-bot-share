import { Contract, Interface, id, zeroPadValue } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { FablesAdapter, poolKeyFingerprint } from '../adapters/fables.js';
import { HOOK_ABI, DEPOSITED_EVENT, WITHDRAWN_EVENT } from '../abi.js';

loadDotEnv();
const config = loadConfig();
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);
const fables = new FablesAdapter(readProvider, config);

const SWAP_EVENT = 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)';
const swapIface = new Interface([
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)'
]);
const swapTopic = id(SWAP_EVENT).toLowerCase();
const depositedTopic = id(DEPOSITED_EVENT).toLowerCase();
const withdrawnTopic = id(WITHDRAWN_EVENT).toLowerCase();
const walletTopic = zeroPadValue(config.walletAddress, 32).toLowerCase();

const latestBlock = await readProvider.getBlockNumber();
const fromBlock = Number(process.env.RANGE_BACKTEST_FROM_BLOCK || Math.max(config.logFromBlock, latestBlock - 600000));
const preBufferBlocks = Number(process.env.RANGE_BACKTEST_PREBUFFER_BLOCKS || 50000);
const scanIntervals = parseNums(process.env.RANGE_SCAN_MINUTES || '5,10,15,30');
const waitMinutes = parseNums(process.env.RANGE_WAIT_MINUTES || '30,60,90,120,180');
const thresholds = parseNums(process.env.RANGE_OOR_THRESHOLDS_PCT || '0.25,0.5,0.75,1');
const deepConfirmScans = parseNums(process.env.RANGE_DEEP_CONFIRM_SCANS || '1,2');
const postCloseLookaheadMin = Number(process.env.RANGE_POST_CLOSE_LOOKAHEAD_MIN || 180);

console.log('[range-policy] latest', latestBlock, 'from', fromBlock);

const allPools = await fables.discoverAllPools();
const poolByFingerprint = new Map(allPools.map((pool) => [poolKeyFingerprint(pool.key), pool]));
const hooks = [...new Set(allPools.map((pool) => pool.key.hooks.toLowerCase()))];
const lifecycleLogs = [];
for (const hook of hooks) {
  const logs = await fables.getLogsAdaptive({
    address: hook,
    topics: [[depositedTopic, withdrawnTopic], walletTopic]
  }, fromBlock, latestBlock);
  lifecycleLogs.push(...logs);
}
lifecycleLogs.sort((a,b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.index || 0) - Number(b.index || 0));
if (!lifecycleLogs.length) throw new Error('No wallet Fables lifecycle logs in requested window');

const rangeMap = new Map();
for (const log of lifecycleLogs) {
  const hook = String(log.address).toLowerCase();
  const rangeId = String(log.topics?.[2] || '').toLowerCase();
  if (!rangeId) continue;
  const key = hook + '|' + rangeId;
  if (!rangeMap.has(key)) rangeMap.set(key, { hook, rangeId, logs: [] });
  rangeMap.get(key).logs.push(log);
}

for (const range of rangeMap.values()) {
  const contract = new Contract(range.hook, HOOK_ABI, readProvider);
  const info = await contract.rangeKey(range.rangeId);
  if (!info.exists) continue;
  range.tickLower = Number(info.tickLower);
  range.tickUpper = Number(info.tickUpper);
  range.pool = poolByFingerprint.get(poolKeyFingerprint(info.key)) || null;
}
const ranges = [...rangeMap.values()].filter((x) => x.pool);

const relevantPools = new Map();
for (const range of ranges) relevantPools.set(range.pool.id, range.pool);

const managerByHook = new Map();
for (const pool of relevantPools.values()) {
  const hook = pool.key.hooks.toLowerCase();
  if (!managerByHook.has(hook)) {
    const contract = new Contract(pool.key.hooks, HOOK_ABI, readProvider);
    managerByHook.set(hook, String(await contract.poolManager()).toLowerCase());
  }
}

const swapsByPool = new Map();
for (const pool of relevantPools.values()) {
  const manager = managerByHook.get(pool.key.hooks.toLowerCase());
  const logs = await adaptiveLogs({
    address: manager,
    topics: [swapTopic, pool.id]
  }, Math.max(0, fromBlock - preBufferBlocks), latestBlock);
  const points = logs.map((log) => {
    const parsed = swapIface.parseLog(log);
    return {
      blockNumber: Number(log.blockNumber),
      logIndex: Number(log.index || 0),
      tick: Number(parsed.args.tick),
      sqrtPriceX96: parsed.args.sqrtPriceX96.toString(),
      txHash: String(log.transactionHash).toLowerCase()
    };
  });
  swapsByPool.set(pool.id, points);
  console.log('[range-policy] swaps', pairName(pool), points.length);
}

const blocksNeeded = new Set();
for (const range of ranges) for (const log of range.logs) blocksNeeded.add(Number(log.blockNumber));
for (const points of swapsByPool.values()) for (const p of points) blocksNeeded.add(p.blockNumber);
blocksNeeded.add(latestBlock);
const blockTimes = new Map();
await mapLimit([...blocksNeeded], 12, async (blockNumber) => {
  const b = await readProvider.getBlock(blockNumber);
  if (b) blockTimes.set(blockNumber, Number(b.timestamp) * 1000);
});
const latestTimeMs = blockTimes.get(latestBlock) || Date.now();

for (const points of swapsByPool.values()) {
  for (const p of points) p.ts = blockTimes.get(p.blockNumber);
  points.sort((a,b) => a.ts - b.ts || a.logIndex - b.logIndex);
}
for (const range of ranges) {
  for (const log of range.logs) log.ts = blockTimes.get(Number(log.blockNumber));
}

const epochs = [];
for (const range of ranges) {
  let liquidity = 0n;
  let activeStart = null;
  let seq = 0;
  for (const log of range.logs.sort((a,b) => a.ts - b.ts || Number(a.index||0)-Number(b.index||0))) {
    const kind = String(log.topics?.[0]).toLowerCase() === depositedTopic ? 'deposit' : 'withdraw';
    const delta = BigInt(log.data || 0);
    const before = liquidity;
    liquidity = kind === 'deposit' ? liquidity + delta : (delta >= liquidity ? 0n : liquidity - delta);
    if (before === 0n && liquidity > 0n) {
      activeStart = { ts: log.ts, blockNumber: Number(log.blockNumber), txHash: String(log.transactionHash).toLowerCase() };
    }
    if (before > 0n && liquidity === 0n && activeStart) {
      epochs.push(buildEpoch(range, activeStart, { ts: log.ts, blockNumber: Number(log.blockNumber), txHash: String(log.transactionHash).toLowerCase() }, ++seq));
      activeStart = null;
    }
  }
  if (liquidity > 0n && activeStart) epochs.push(buildEpoch(range, activeStart, null, ++seq));
}

function buildEpoch(range, start, end, seq) {
  return {
    id: range.rangeId + ':' + seq,
    rangeId: range.rangeId,
    poolId: range.pool.id,
    pair: pairName(range.pool),
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    start,
    end,
    active: !end
  };
}

for (const epoch of epochs) {
  const points = swapsByPool.get(epoch.poolId) || [];
  epoch.startTime = new Date(epoch.start.ts).toISOString();
  epoch.endTime = epoch.end ? new Date(epoch.end.ts).toISOString() : null;
  epoch.durationMin = ((epoch.end?.ts || latestTimeMs) - epoch.start.ts) / 60000;
  epoch.swapCount = points.filter((p) => p.ts >= epoch.start.ts && p.ts <= (epoch.end?.ts || latestTimeMs)).length;
  epoch.episodes15m = detectEpisodes(epoch, points, 15);
}

const episodeStats = summarizeEpisodes(epochs.flatMap((e) => e.episodes15m));
const policyResults = [];
for (const scanMin of scanIntervals) {
  for (const thresholdPct of thresholds) {
    for (const waitMin of waitMinutes) {
      for (const deepConfirm of deepConfirmScans) {
        const result = evaluatePolicy(epochs, swapsByPool, { scanMin, thresholdPct, waitMin, deepConfirm });
        policyResults.push(result);
      }
    }
  }
}

policyResults.sort((a,b) =>
  a.triggered - b.triggered ||
  b.recoveredBeforeAction - a.recoveredBeforeAction ||
  a.meanActionDelayMin - b.meanActionDelayMin
);

const requested = policyResults.find((x) =>
  x.scanMin === 15 && x.thresholdPct === 0.5 && x.waitMin === 90 && x.deepConfirm === 1
);
const requested2 = policyResults.find((x) =>
  x.scanMin === 15 && x.thresholdPct === 0.5 && x.waitMin === 90 && x.deepConfirm === 2
);

const report = {
  generatedAt: new Date().toISOString(),
  wallet: config.walletAddress,
  blockWindow: { fromBlock, latestBlock },
  poolCount: relevantPools.size,
  pools: [...relevantPools.values()].map((p) => ({
    id: p.id,
    pair: pairName(p),
    tickSpacing: p.key.tickSpacing,
    swapEvents: (swapsByPool.get(p.id) || []).length
  })),
  epochs,
  episodeStats,
  requestedPolicy: requested,
  requestedPolicyDeepConfirm2: requested2,
  topPolicies: policyResults.slice(0, 20),
  allPolicies: policyResults
};

const out = process.env.RANGE_POLICY_OUTPUT || 'data/range-policy-backtest.json';
await import('node:fs').then(({default:fs}) => {
  fs.mkdirSync(out.split('/').slice(0,-1).join('/') || '.', { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  fs.writeFileSync(out.replace(/\.json$/, '.md'), renderMarkdown(report));
});

console.log(JSON.stringify({
  ok: true,
  epochs: epochs.length,
  pools: report.pools,
  episodeStats,
  requested,
  requestedDeepConfirm2: requested2,
  output: out
}, null, 2));

function detectEpisodes(epoch, points, scanMin) {
  const start = epoch.start.ts;
  const end = epoch.end?.ts || latestTimeMs;
  if (end <= start) return [];
  const samples = sampleTicks(points, start, end, scanMin);
  const episodes = [];
  let current = null;
  for (const sample of samples) {
    const d = excursion(epoch, sample.tick);
    if (d.outside) {
      if (!current) current = { startTs: sample.ts, samples: [], maxExcursionPct: 0, side: d.side };
      current.samples.push({ ...sample, excursionPct: d.pct, side: d.side });
      current.maxExcursionPct = Math.max(current.maxExcursionPct, d.pct);
    } else if (current) {
      current.endTs = sample.ts;
      current.recovered = true;
      current.durationMin = (current.endTs - current.startTs) / 60000;
      episodes.push(current);
      current = null;
    }
  }
  if (current) {
    current.endTs = end;
    current.recovered = false;
    current.durationMin = (end - current.startTs) / 60000;
    const lookaheadEnd = Math.min(latestTimeMs, end + postCloseLookaheadMin * 60000);
    if (epoch.end && lookaheadEnd > end) {
      const follow = sampleTicks(points, end, lookaheadEnd, scanMin);
      const recovered = follow.find((s) => !excursion(epoch, s.tick).outside);
      current.postCloseRecoveryMin = recovered ? (recovered.ts - end) / 60000 : null;
    }
    episodes.push(current);
  }
  return episodes.map((e) => ({
    rangeId: epoch.rangeId,
    poolId: epoch.poolId,
    pair: epoch.pair,
    tickLower: epoch.tickLower,
    tickUpper: epoch.tickUpper,
    startTime: new Date(e.startTs).toISOString(),
    endTime: new Date(e.endTs).toISOString(),
    durationMin: e.durationMin,
    recovered: e.recovered,
    maxExcursionPct: e.maxExcursionPct,
    side: e.side,
    postCloseRecoveryMin: e.postCloseRecoveryMin ?? null
  }));
}

function evaluatePolicy(epochs, swapMap, policy) {
  let episodes = 0, triggered = 0, recoveredBeforeAction = 0, shallowTimeout = 0, deepTrigger = 0, censored = 0;
  const actionDelays = [];
  const details = [];
  for (const epoch of epochs) {
    const points = swapMap.get(epoch.poolId) || [];
    const end = epoch.end?.ts || latestTimeMs;
    const samples = sampleTicks(points, epoch.start.ts, end, policy.scanMin);
    let state = null;
    for (const sample of samples) {
      const d = excursion(epoch, sample.tick);
      if (!d.outside) {
        if (state && !state.triggered) {
          recoveredBeforeAction++;
          details.push({ pair:epoch.pair, rangeId:epoch.rangeId, outcome:'recovered', delayMin:(sample.ts-state.startTs)/60000, maxExcursionPct:state.max });
        }
        state = null;
        continue;
      }
      if (!state) {
        episodes++;
        state = { startTs: sample.ts, max: d.pct, deepConsecutive: d.pct > policy.thresholdPct ? 1 : 0, triggered:false };
      } else {
        state.max = Math.max(state.max, d.pct);
        state.deepConsecutive = d.pct > policy.thresholdPct ? state.deepConsecutive + 1 : 0;
      }
      if (state.triggered) continue;
      const elapsed = (sample.ts - state.startTs) / 60000;
      if (d.pct > policy.thresholdPct && state.deepConsecutive >= policy.deepConfirm) {
        state.triggered = true; triggered++; deepTrigger++; actionDelays.push(elapsed);
        details.push({ pair:epoch.pair, rangeId:epoch.rangeId, outcome:'deep-trigger', delayMin:elapsed, excursionPct:d.pct, maxExcursionPct:state.max });
      } else if (d.pct <= policy.thresholdPct && elapsed >= policy.waitMin) {
        state.triggered = true; triggered++; shallowTimeout++; actionDelays.push(elapsed);
        details.push({ pair:epoch.pair, rangeId:epoch.rangeId, outcome:'shallow-timeout', delayMin:elapsed, excursionPct:d.pct, maxExcursionPct:state.max });
      }
    }
    if (state && !state.triggered) {
      censored++;
      details.push({ pair:epoch.pair, rangeId:epoch.rangeId, outcome:'censored', delayMin:(end-state.startTs)/60000, maxExcursionPct:state.max });
    }
  }
  return {
    ...policy,
    episodes,
    triggered,
    recoveredBeforeAction,
    shallowTimeout,
    deepTrigger,
    censored,
    triggerRatePct: episodes ? triggered / episodes * 100 : 0,
    recoveryAvoidRatePct: episodes ? recoveredBeforeAction / episodes * 100 : 0,
    meanActionDelayMin: actionDelays.length ? actionDelays.reduce((a,b)=>a+b,0)/actionDelays.length : null,
    details
  };
}

function sampleTicks(points, start, end, scanMin) {
  if (!points.length) return [];
  let idx = upperBound(points, start) - 1;
  if (idx < 0) idx = 0;
  let tick = points[idx]?.tick;
  const out = [];
  const step = scanMin * 60000;
  for (let ts = start; ts <= end; ts += step) {
    while (idx + 1 < points.length && points[idx + 1].ts <= ts) {
      idx++;
      tick = points[idx].tick;
    }
    if (Number.isFinite(tick)) out.push({ ts, tick });
  }
  return out;
}

function upperBound(points, ts) {
  let lo=0, hi=points.length;
  while (lo<hi) {
    const mid=(lo+hi)>>1;
    if (points[mid].ts <= ts) lo=mid+1; else hi=mid;
  }
  return lo;
}

function excursion(epoch, tick) {
  if (tick <= epoch.tickLower) {
    const pct = (Math.pow(1.0001, epoch.tickLower - tick) - 1) * 100;
    return { outside:true, pct, side:'below' };
  }
  if (tick >= epoch.tickUpper) {
    const pct = (Math.pow(1.0001, tick - epoch.tickUpper) - 1) * 100;
    return { outside:true, pct, side:'above' };
  }
  return { outside:false, pct:0, side:null };
}

function summarizeEpisodes(episodes) {
  const durations = episodes.filter((x)=>x.recovered).map((x)=>x.durationMin).sort((a,b)=>a-b);
  const recoverWithin = {};
  for (const m of [15,30,45,60,90,120,180]) {
    recoverWithin[m] = episodes.length ? episodes.filter((x)=>x.recovered && x.durationMin <= m).length / episodes.length * 100 : 0;
  }
  return {
    total: episodes.length,
    recovered: episodes.filter((x)=>x.recovered).length,
    unresolvedOrCensored: episodes.filter((x)=>!x.recovered).length,
    medianRecoveryMin: percentile(durations, 0.5),
    p75RecoveryMin: percentile(durations, 0.75),
    p90RecoveryMin: percentile(durations, 0.9),
    recoverWithinPct: recoverWithin,
    excursionPctMedian: percentile(episodes.map((x)=>x.maxExcursionPct).sort((a,b)=>a-b),0.5),
    excursionPctP90: percentile(episodes.map((x)=>x.maxExcursionPct).sort((a,b)=>a-b),0.9)
  };
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const i = (arr.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? arr[lo] : arr[lo] + (arr[hi]-arr[lo])*(i-lo);
}

async function adaptiveLogs(filter, from, to) {
  const out=[]; let cursor=from; let span=config.logChunkBlocks;
  while(cursor<=to){
    const end=Math.min(to,cursor+span-1);
    try{
      out.push(...await readProvider.getLogs({...filter,fromBlock:cursor,toBlock:end}));
      cursor=end+1;
    }catch(error){
      if(span<=config.minLogChunkBlocks) throw error;
      span=Math.max(config.minLogChunkBlocks,Math.floor(span/2));
    }
  }
  return out;
}

function pairName(pool){ return pool.token0.symbol + '/' + pool.token1.symbol; }
function parseNums(v){ return String(v).split(',').map(Number).filter(Number.isFinite); }
async function mapLimit(items,limit,fn){
  const out=new Array(items.length); let cursor=0;
  async function worker(){ while(true){ const i=cursor++; if(i>=items.length)return; out[i]=await fn(items[i],i); } }
  await Promise.all(Array.from({length:Math.min(limit,Math.max(1,items.length))},()=>worker()));
  return out;
}

function renderMarkdown(r){
  const x=r.requestedPolicy;
  const x2=r.requestedPolicyDeepConfirm2;
  const lines=[
    '# Range Exit Policy Backtest',
    '',
    '- Wallet: `'+r.wallet+'`',
    '- Block window: '+r.blockWindow.fromBlock+' → '+r.blockWindow.latestBlock,
    '- Historical LP epochs: '+r.epochs.length,
    '',
    '## 15-minute / 0.5% / 90-minute policy',
    '',
    '| Variant | OOR episodes | Actions | Recovered before action | Deep triggers | 90m shallow timeouts | Mean action delay |',
    '|---|---:|---:|---:|---:|---:|---:|',
    '| >0.5% first scan | '+x.episodes+' | '+x.triggered+' | '+x.recoveredBeforeAction+' | '+x.deepTrigger+' | '+x.shallowTimeout+' | '+fmt(x.meanActionDelayMin)+' min |',
    '| >0.5% two consecutive scans | '+x2.episodes+' | '+x2.triggered+' | '+x2.recoveredBeforeAction+' | '+x2.deepTrigger+' | '+x2.shallowTimeout+' | '+fmt(x2.meanActionDelayMin)+' min |',
    '',
    '## Natural OOR recovery',
    '',
    '- Total 15m-sampled OOR episodes: '+r.episodeStats.total,
    '- Recovered while observed: '+r.episodeStats.recovered,
    '- Median recovery: '+fmt(r.episodeStats.medianRecoveryMin)+' min',
    '- P75 recovery: '+fmt(r.episodeStats.p75RecoveryMin)+' min',
    '- P90 recovery: '+fmt(r.episodeStats.p90RecoveryMin)+' min',
    '- Median max excursion: '+fmt(r.episodeStats.excursionPctMedian)+'%',
    '- P90 max excursion: '+fmt(r.episodeStats.excursionPctP90)+'%',
    '',
    '### Recovery within',
    '',
    ...Object.entries(r.episodeStats.recoverWithinPct).map(([m,p])=>'- '+m+' min: '+fmt(p)+'%'),
    '',
    '## LP epochs',
    '',
    '| Pair | Range | Start | End | Duration | 15m OOR episodes |',
    '|---|---|---|---|---:|---:|',
    ...r.epochs.map(e=>'| '+e.pair+' | '+e.tickLower+'…'+e.tickUpper+' | '+e.startTime+' | '+(e.endTime||'ACTIVE')+' | '+fmt(e.durationMin)+' min | '+e.episodes15m.length+' |')
  ];
  return lines.join('\n');
}
function fmt(v){ return Number.isFinite(Number(v)) ? Number(v).toFixed(2) : 'N/A'; }
