import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDepositPlan, buildRebalanceInventoryPlan, targetAmountsPerLiquidity } from '../src/analytics/rebalance-plan.js';

test('target ratio is two-sided inside range', () => {
  const unit = targetAmountsPerLiquidity({ sqrtPriceX96: 2n ** 96n, tickLower: -120, tickUpper: 120, decimals0: 6, decimals1: 6 });
  assert.ok(unit.amount0PerL > 0);
  assert.ok(unit.amount1PerL > 0);
});

test('balanced value returns finite target', () => {
  const plan = buildRebalanceInventoryPlan({ amount0: 100, amount1: 100, price0Usd: 1, price1Usd: 1, sqrtPriceX96: 2n ** 96n, tickLower: -120, tickUpper: 120, decimals0: 6, decimals1: 6 });
  assert.ok(Number.isFinite(plan.target0));
  assert.ok(Number.isFinite(plan.target1));
  assert.ok(Math.abs(plan.target0 + plan.target1 - 200) < 1e-6);
});

test('one-sided token0 inventory plans 0_to_1 swap', () => {
  const plan = buildRebalanceInventoryPlan({ amount0: 200, amount1: 0, price0Usd: 1, price1Usd: 1, sqrtPriceX96: 2n ** 96n, tickLower: -120, tickUpper: 120, decimals0: 6, decimals1: 6 });
  assert.equal(plan.direction, '0_to_1');
  assert.ok(plan.amountIn > 0);
});


test('real USDG/ZZZ deposit caps match 50 bps price bounds', () => {
  const liquidity = 603915329638896163;
  const tickLower = 312600;
  const tickUpper = 313000;
  const amount0 = 1401.5489;
  const amount1 = 20734.001967136974;
  const sb = Math.pow(1.0001, tickUpper / 2);
  const sp = 1 / ((amount0 * 1e6) / liquidity + 1 / sb);
  const sqrtPriceX96 = BigInt(Math.round(sp * (2 ** 96)));
  const plan = buildDepositPlan({
    amount0,
    amount1,
    inventoryPlan: { direction: 'none' },
    quote: null,
    sqrtPriceX96,
    tickLower,
    tickUpper,
    decimals0: 6,
    decimals1: 18,
    slippageBps: 50,
    liquidityReserveBps: 0
  });
  assert.ok(relativeError(Number(plan.liquidity), liquidity) < 1e-10);
  assert.ok(relativeError(Number(plan.amount0MaxRaw), 1647269003) < 2e-9);
  assert.ok(relativeError(Number(plan.amount1MaxRaw), 30033980216309220824922) < 2e-9);
});

test('real CASHCAT/USDG deposit caps match 50 bps price bounds with reversed decimals', () => {
  const liquidity = 416346248331525075;
  const tickLower = -295080;
  const tickUpper = -294840;
  const amount0 = 6594.881132947995;
  const amount1 = 938.770877;
  // Use the exact 6-decimal USDG receipt delta to reconstruct spot.
  // Reconstructing from the 18-decimal CASHCAT human Number loses raw-token
  // precision before the formula is even evaluated.
  const sa = Math.pow(1.0001, tickLower / 2);
  const sp = (amount1 * 1e6) / liquidity + sa;
  const sqrtPriceX96 = BigInt(Math.round(sp * (2 ** 96)));
  const plan = buildDepositPlan({
    amount0,
    amount1,
    inventoryPlan: { direction: 'none' },
    quote: null,
    sqrtPriceX96,
    tickLower,
    tickUpper,
    decimals0: 18,
    decimals1: 6,
    slippageBps: 50,
    liquidityReserveBps: 0
  });
  assert.ok(relativeError(Number(plan.liquidity), liquidity) < 1e-10);
  assert.ok(relativeError(Number(plan.amount0MaxRaw), 9248224182311255497981) < 2e-9);
  assert.ok(relativeError(Number(plan.amount1MaxRaw), 1348112979) < 2e-9);
});

function relativeError(actual, expected) {
  return Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
}
