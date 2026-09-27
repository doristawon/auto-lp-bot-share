import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeAmounts, spotToken1PerToken0 } from '../src/analytics/liquidity.js';

test('spot price at Q96 is 1 for equal decimals', () => {
  assert.equal(spotToken1PerToken0(2n ** 96n, 18, 18), 1);
});

test('range amounts are one-sided outside range', () => {
  const below = rangeAmounts(1_000_000n, 2n ** 95n, -100, 100, 6, 6);
  assert.ok(below.amount0 > 0);
  assert.equal(below.amount1, 0);
  const above = rangeAmounts(1_000_000n, 2n ** 97n, -100, 100, 6, 6);
  assert.equal(above.amount0, 0);
  assert.ok(above.amount1 > 0);
});
