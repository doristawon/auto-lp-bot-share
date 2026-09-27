import test from 'node:test';
import assert from 'node:assert/strict';
import { id, zeroPadValue } from 'ethers';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { DEPOSITED_EVENT } from '../src/abi.js';
import { getSqrtPriceAtTick } from '../src/math/v4-fixed.js';

const wallet = '0x000000000000000000000000000000000000dead';
const hook = '0x08E52564Bad99E05a694b4809F397edcA417A080';
const pool = {
  id: '0x' + 'ab'.repeat(32),
  key: {
    currency0: '0x0000000000000000000000000000000000000011',
    currency1: '0x0000000000000000000000000000000000000022',
    fee: 8388608,
    tickSpacing: 10,
    hooks: hook
  },
  token0: { address: '0x0000000000000000000000000000000000000011', symbol: 'T0', decimals: 18 },
  token1: { address: '0x0000000000000000000000000000000000000022', symbol: 'T1', decimals: 18 },
  state: { tick: 1100, sqrtPriceX96: getSqrtPriceAtTick(1100), paused: false }
};
const position = {
  id: '0x' + '11'.repeat(32),
  tickLower: 900,
  tickUpper: 1000,
  shares: 1_000_000_000_000_000_000n,
  outside: true,
  shouldRebalance: true,
  rebalanceReason: 'oor_max_wait_expired'
};

function createHarness({ failSwap = false } = {}) {
  const events = [];
  const settings = new Map();
  const balances = [
    { raw0: 10_000_000_000_000_000_000n, raw1: 10_000_000_000_000_000_000n },
    { raw0: 110_000_000_000_000_000_000n, raw1: 10_000_000_000_000_000_000n },
    // Exact-input mock: executor asks to swap 52.747082710266113281 T0 at 1:1.
    { raw0: 57_252_917_289_733_886_719n, raw1: 62_747_082_710_266_113_281n }
  ];
  let balanceIndex = 0;
  const state = {
    getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };
  const fables = {
    async readPoolState() { return { tick: 1100, sqrtPriceX96: getSqrtPriceAtTick(1100), paused: false }; },
    async readRangeKey() {
      return {
        exists: true,
        key: pool.key,
        tickLower: 980,
        tickUpper: 1220
      };
    },
    encodeDeposit() { return '0xdeadbeef'; }
  };
  const executor = new RebalanceExecutor(
    null,
    null,
    {
      dryRun: false,
      enableLiveWrites: true,
      enableAutoRedeploy: true,
      walletAddress: wallet,
      withdrawSlippageBps: 50,
      swapSlippageBps: 50,
      depositSlippageBps: 50,
      depositLiquidityReserveBps: 10,
      tightWidthBps: 120,
      txDeadlineSec: 1200,
      fablesWalk: 1000,
      allowZeroMinOut: false,
      confirmations: 1,
      oorShallowThresholdPct: 0.5
    },
    fables,
    { append(type, data) { events.push({ type, data }); } },
    () => 0,
    state
  );

  executor.assertLiveReady = async () => {};
  executor.assertNoUnfinishedExecution = () => {};
  executor.assertPlanStillOutOfRange = async (plan) => {
    plan.pool.state = { tick: 1100, sqrtPriceX96: getSqrtPriceAtTick(1100), paused: false };
    return plan.pool.state;
  };
  executor.readRawPairBalances = async () => balances[Math.min(balanceIndex++, balances.length - 1)];
  executor.readPositionShares = async (_pool, rangeId) => rangeId === position.id ? 0n : 5_000_000_000_000_000n;
  executor.ensureSwapAllowances = async () => {};
  executor.ensureHookAllowance = async () => {};
  executor.quoter = {
    async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn, slippageBps) {
      rawAmountIn = BigInt(rawAmountIn);
      return {
        rawAmountIn: rawAmountIn.toString(),
        rawAmountOut: rawAmountIn.toString(),
        minRawAmountOut: (rawAmountIn * BigInt(10000 - slippageBps) / 10000n).toString(),
        tokenIn: tokenIn === 0 ? pool.token0.address : pool.token1.address,
        tokenOut: tokenIn === 0 ? pool.token1.address : pool.token0.address,
        zeroForOne: tokenIn === 0
      };
    }
  };
  executor.router = {
    buildV4ExactInputSingle({ quote, deadline }) {
      return { router: '0x0000000000000000000000000000000000000099', data: '0x1234', value: 0n, quote, deadline };
    },
    async simulateV4ExactInputSingle() { return '0x'; }
  };
  let sent = 0;
  executor.sendVerifiedTx = async ({ label, onSent }) => {
    sent++;
    const hash = '0x' + sent.toString(16).padStart(64, '0');
    if (onSent) onSent(hash);
    if (failSwap && label === 'v4SwapExactInputSingle') throw new Error('mock swap failure');
    return {
      hash,
      status: 1,
      logs: label === 'fablesDeposit' ? [{
        address: hook,
        topics: [
          id(DEPOSITED_EVENT),
          zeroPadValue(wallet, 32),
          '0x' + '22'.repeat(32)
        ],
        data: '0x' + (5_000_000_000_000_000n).toString(16).padStart(64, '0')
      }] : []
    };
  };
  executor.findWalletDepositEvent = (_pool, receipt) => {
    if (!receipt.logs?.length) return null;
    return { rangeId: '0x' + '22'.repeat(32), liquidity: 5_000_000_000_000_000n };
  };
  return { executor, events, settings };
}

test('full executor advances only after receipts and completes with new LP shares', async () => {
  const { executor, events, settings } = createHarness();
  const result = await executor.execute({ pool: structuredClone(pool), position: { ...position }, currentTick: 1100 });
  assert.equal(result.status, 'completed');
  assert.ok(result.withdrawHash);
  assert.ok(result.swapHash);
  assert.ok(result.depositHash);
  assert.equal(settings.get('activeRebalanceExecution'), null);
  assert.ok(events.some((x) => x.type === 'rebalance.completed'));
});

test('post-withdraw swap failure records recovery_required and leaves execution locked', async () => {
  const { executor, events, settings } = createHarness({ failSwap: true });
  await assert.rejects(
    executor.execute({ pool: structuredClone(pool), position: { ...position }, currentTick: 1100 }),
    /mock swap failure/
  );
  const journal = settings.get('activeRebalanceExecution');
  assert.equal(journal.phase, 'recovery_required');
  assert.ok(journal.tx.withdraw);
  assert.ok(events.some((x) => x.type === 'rebalance.recovery_required'));
});
