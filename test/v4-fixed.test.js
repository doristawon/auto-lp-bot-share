import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Q96,
  buildExactDepositPlan,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtPriceAtTick
} from '../src/math/v4-fixed.js';

test('TickMath BigInt port matches canonical Q96 and boundary constants', () => {
  assert.equal(getSqrtPriceAtTick(0), Q96);
  assert.equal(getSqrtPriceAtTick(-887272), 4295128739n);
  assert.equal(getSqrtPriceAtTick(887272), 1461446703485210103287273052203988822378723970342n);
});

test('exact liquidity math round-trips without JS Number precision', () => {
  const sqrtX = getSqrtPriceAtTick(100);
  const sqrtA = getSqrtPriceAtTick(-200);
  const sqrtB = getSqrtPriceAtTick(400);
  const amount0 = 123456789012345678901234n;
  const amount1 = 98765432109876543210987n;
  const liquidity = getLiquidityForAmounts(sqrtX, sqrtA, sqrtB, amount0, amount1);
  const required = getAmountsForLiquidity(sqrtX, sqrtA, sqrtB, liquidity, true);
  assert.ok(liquidity > 0n);
  assert.ok(required.amount0 <= amount0);
  assert.ok(required.amount1 <= amount1);
});

test('exact deposit plan caps are bounded by operation raw balances', () => {
  const plan = buildExactDepositPlan({
    rawAmount0: 5_000_000_000n,
    rawAmount1: 9_000_000_000_000_000_000n,
    sqrtPriceX96: getSqrtPriceAtTick(100),
    tickLower: -200,
    tickUpper: 400,
    slippageBps: 50,
    liquidityReserveBps: 10
  });
  assert.equal(plan.provisional, false);
  assert.ok(plan.liquidity > 0n);
  assert.ok(plan.amount0Max <= 5_000_000_000n);
  assert.ok(plan.amount1Max <= 9_000_000_000_000_000_000n);
  assert.ok(plan.required0 <= plan.amount0Max);
  assert.ok(plan.required1 <= plan.amount1Max);
});
