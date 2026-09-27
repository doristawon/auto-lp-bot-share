import { Interface, id } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { AutoLpBot } from '../bot.js';
import { EIP7702_GUARD_ABI } from '../abi.js';

loadDotEnv();
const config = loadConfig();
if (!config.eip7702GuardAddress) throw new Error('EIP7702_GUARD_ADDRESS is required');
const bot = new AutoLpBot({ ...config, dryRun: true, enableLiveWrites: false, enableAutoRedeploy: false });
await bot.initialize();
const snapshot = await bot.runOnce();

const code = (await bot.providers.readProvider.getCode(config.walletAddress)).toLowerCase();
const expected = ('0xef0100' + config.eip7702GuardAddress.slice(2)).toLowerCase();
if (code !== expected) throw new Error(`Wallet delegation mismatch: expected ${expected}, got ${code}`);

const iface = new Interface([...EIP7702_GUARD_ABI, 'error InRange(int24 currentTick,int24 tickLower,int24 tickUpper)']);
const versionRaw = await bot.providers.readProvider.call({
  from: config.walletAddress,
  to: config.walletAddress,
  data: iface.encodeFunctionData('guardVersion', [])
});
const [version] = iface.decodeFunctionResult('guardVersion', versionRaw);
const expectedVersion = id('Fables7702Guard/v1');
if (String(version).toLowerCase() !== expectedVersion.toLowerCase()) {
  throw new Error(`Guard version mismatch: expected ${expectedVersion}, got ${version}`);
}
const implRaw = await bot.providers.readProvider.call({
  from: config.walletAddress,
  to: config.walletAddress,
  data: iface.encodeFunctionData('IMPLEMENTATION', [])
});
const [implementation] = iface.decodeFunctionResult('IMPLEMENTATION', implRaw);
if (String(implementation).toLowerCase() !== config.eip7702GuardAddress.toLowerCase()) {
  throw new Error(`Guard implementation mismatch: expected ${config.eip7702GuardAddress}, got ${implementation}`);
}

let candidate = null;
for (const pool of snapshot.pools || []) {
  for (const position of pool.positions || []) {
    if (!position.outside) {
      candidate = { pool, position };
      break;
    }
  }
  if (candidate) break;
}
if (!candidate) {
  console.log(JSON.stringify({
    ok: false,
    reason: 'no-current-in-range-position',
    note: 'Delegation and guardVersion passed, but an In-Range withdrawal-block canary needs at least one active In-Range LP.'
  }, null, 2));
  process.exitCode = 2;
} else {
  const { pool, position } = candidate;
  const data = iface.encodeFunctionData('guardedWithdrawAndClaim', [
    [
      snapshot.pools.find((x) => x.id === pool.id) ? bot.market.pools.find((x) => x.id === pool.id).key.currency0 : pool.currency0,
      bot.market.pools.find((x) => x.id === pool.id).key.currency1,
      bot.market.pools.find((x) => x.id === pool.id).key.fee,
      bot.market.pools.find((x) => x.id === pool.id).key.tickSpacing,
      bot.market.pools.find((x) => x.id === pool.id).key.hooks
    ],
    position.tickLower,
    position.tickUpper,
    BigInt(position.shares),
    config.walletAddress,
    0n,
    0n,
    BigInt(Math.floor(Date.now() / 1000) + config.txDeadlineSec),
    config.fablesWalk
  ]);
  let blocked = false;
  try {
    await bot.providers.readProvider.call({
      from: config.walletAddress,
      to: config.walletAddress,
      data
    });
  } catch (error) {
    const raw = error.data || error.info?.error?.data || error.info?.error?.error?.data;
    const parsed = typeof raw === 'string' ? iface.parseError(raw) : null;
    blocked = parsed?.name === 'InRange';
    if (!blocked) throw new Error('Atomic guard canary reverted for a reason other than InRange');
  }
  if (!blocked) throw new Error('Atomic guard canary FAILED: an In-Range guarded withdrawal eth_call unexpectedly succeeded');
  console.log(JSON.stringify({
    ok: true,
    wallet: config.walletAddress,
    guard: config.eip7702GuardAddress,
    pair: pool.pair,
    tick: pool.tick,
    range: [position.tickLower, position.tickUpper],
    result: 'in-range-withdrawal-blocked',
    revert: 'InRange'
  }, null, 2));
}
