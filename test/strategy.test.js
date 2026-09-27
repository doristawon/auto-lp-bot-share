import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCenteredRange, buildFablesTightRange, isLpInRange, isLpOutOfRange, isOutsideRange, priceWidthBpsToTickDelta } from '../src/math/ticks.js';
import { evaluatePosition, outOfRangeExcursionPct } from '../src/strategy.js';

const M15 = 15 * 60 * 1000;

test('Tight 120 bps is about 120 ticks before spacing snap', () => {
  const delta = priceWidthBpsToTickDelta(120);
  assert.ok(delta >= 119 && delta <= 121);
});

test('centered range expands to tick spacing and contains spot', () => {
  const r = buildCenteredRange(12345, 10, 120);
  assert.ok(r.tickLower < 12345 && r.tickUpper > 12345);
  assert.equal(r.tickLower % 10, 0);
  assert.equal(r.tickUpper % 10, 0);
});

test('Fables Tight follows its nearest-tick one-percent preset', () => {
  assert.deepEqual(buildFablesTightRange(320278, 200), { tickLower: 320000, tickUpper: 320400, tickDelta: 200 });
  assert.deepEqual(buildFablesTightRange(320300, 200), { tickLower: 320200, tickUpper: 320600, tickDelta: 200 });
});

test('canonical LP range uses lower-inclusive upper-exclusive semantics', () => {
  assert.equal(isLpInRange(100, 100, 200), true);
  assert.equal(isLpInRange(199, 100, 200), true);
  assert.equal(isLpOutOfRange(99, 100, 200), true);
  assert.equal(isLpOutOfRange(200, 100, 200), true);
});

test('edge buffer is monitoring-only and cannot authorize an in-range rebalance', () => {
  assert.equal(isOutsideRange(105, 100, 200, 10), true);
  const x = evaluatePosition({
    currentTick: 105,
    tickSpacing: 10,
    position: { tickLower: 100, tickUpper: 200 },
    widthBps: 120,
    edgeBufferTicks: 10,
    outOfRangeSince: 1,
    deepConfirmationsSeen: 99,
    maxWaitMs: 1,
    nowMs: 10_000
  });
  assert.equal(x.outside, false);
  assert.equal(x.nearEdge, true);
  assert.equal(x.shouldRebalance, false);
});

test('50 ticks outside is about 0.5 percent', () => {
  const pct = outOfRangeExcursionPct(1050, 900, 1000);
  assert.ok(pct > 0.50 && pct < 0.51);
});

test('shallow OOR waits until 90 minutes', () => {
  const base = {
    currentTick: 1007,
    tickSpacing: 10,
    position: { tickLower: 900, tickUpper: 1000 },
    widthBps: 120,
    checkIntervalMs: M15,
    shallowThresholdPct: 0.5,
    maxWaitMs: 90 * 60 * 1000,
    deepConfirmationsRequired: 2,
    cooldownUntil: 0
  };
  const t0 = 1_000_000;
  const first = evaluatePosition({ ...base, nowMs: t0 });
  assert.equal(first.shouldRebalance, false);
  assert.ok(first.excursionPct < 0.5);

  const t75 = evaluatePosition({
    ...base,
    nowMs: t0 + 75 * 60 * 1000,
    lastEvaluationAt: t0 + 60 * 60 * 1000,
    outOfRangeSince: first.outOfRangeSince
  });
  assert.equal(t75.shouldRebalance, false);

  const t90 = evaluatePosition({
    ...base,
    nowMs: t0 + 90 * 60 * 1000,
    lastEvaluationAt: t0 + 75 * 60 * 1000,
    outOfRangeSince: first.outOfRangeSince
  });
  assert.equal(t90.shouldRebalance, true);
  assert.equal(t90.rebalanceReason, 'oor_max_wait_expired');
});

test('deep OOR requires two consecutive 15-minute evaluations', () => {
  const base = {
    currentTick: 1051,
    tickSpacing: 10,
    position: { tickLower: 900, tickUpper: 1000 },
    widthBps: 120,
    checkIntervalMs: M15,
    shallowThresholdPct: 0.5,
    maxWaitMs: 90 * 60 * 1000,
    deepConfirmationsRequired: 2,
    cooldownUntil: 0
  };
  const t0 = 2_000_000;
  const first = evaluatePosition({ ...base, nowMs: t0 });
  assert.equal(first.deepConfirmations, 1);
  assert.equal(first.shouldRebalance, false);

  const second = evaluatePosition({
    ...base,
    nowMs: t0 + M15,
    lastEvaluationAt: first.evaluatedAt,
    outOfRangeSince: first.outOfRangeSince,
    deepConfirmationsSeen: first.deepConfirmations
  });
  assert.equal(second.deepConfirmations, 2);
  assert.equal(second.shouldRebalance, true);
  assert.equal(second.rebalanceReason, 'deep_oor_confirmed');
});

test('single deep spike that becomes shallow resets deep confirmations but keeps OOR timer', () => {
  const common = {
    tickSpacing: 10,
    position: { tickLower: 900, tickUpper: 1000 },
    widthBps: 120,
    checkIntervalMs: M15,
    shallowThresholdPct: 0.5,
    maxWaitMs: 90 * 60 * 1000,
    deepConfirmationsRequired: 2,
    cooldownUntil: 0
  };
  const t0 = 3_000_000;
  const deep = evaluatePosition({ ...common, currentTick: 1051, nowMs: t0 });
  const shallow = evaluatePosition({
    ...common,
    currentTick: 1007,
    nowMs: t0 + M15,
    lastEvaluationAt: deep.evaluatedAt,
    outOfRangeSince: deep.outOfRangeSince,
    deepConfirmationsSeen: deep.deepConfirmations
  });
  assert.equal(shallow.deepConfirmations, 0);
  assert.equal(shallow.outOfRangeSince, t0);
  assert.equal(shallow.shouldRebalance, false);
});

test('checks inside the 15-minute policy window do not advance confirmations', () => {
  const t0 = 4_000_000;
  const x = evaluatePosition({
    currentTick: 1051,
    tickSpacing: 10,
    position: { tickLower: 900, tickUpper: 1000 },
    widthBps: 120,
    lastEvaluationAt: t0,
    outOfRangeSince: t0,
    deepConfirmationsSeen: 1,
    checkIntervalMs: M15,
    shallowThresholdPct: 0.5,
    maxWaitMs: 90 * 60 * 1000,
    deepConfirmationsRequired: 2,
    nowMs: t0 + 5 * 60 * 1000
  });
  assert.equal(x.evaluationDue, false);
  assert.equal(x.deepConfirmations, 1);
  assert.equal(x.shouldRebalance, false);
});

test('re-entry on a due evaluation clears the OOR timer', () => {
  const t0 = 5_000_000;
  const x = evaluatePosition({
    currentTick: 950,
    tickSpacing: 10,
    position: { tickLower: 900, tickUpper: 1000 },
    widthBps: 120,
    lastEvaluationAt: t0,
    outOfRangeSince: t0 - 60 * 60 * 1000,
    deepConfirmationsSeen: 1,
    checkIntervalMs: M15,
    nowMs: t0 + M15
  });
  assert.equal(x.outside, false);
  assert.equal(x.outOfRangeSince, 0);
  assert.equal(x.deepConfirmations, 0);
});

test('cooldown blocks an otherwise eligible rebalance', () => {
  const t0 = 6_000_000;
  const x = evaluatePosition({
    currentTick: 1051,
    tickSpacing: 10,
    position: { tickLower: 900, tickUpper: 1000 },
    widthBps: 120,
    outOfRangeSince: t0 - 90 * 60 * 1000,
    lastEvaluationAt: t0 - M15,
    deepConfirmationsSeen: 1,
    checkIntervalMs: M15,
    shallowThresholdPct: 0.5,
    maxWaitMs: 90 * 60 * 1000,
    deepConfirmationsRequired: 2,
    cooldownUntil: t0 + M15,
    nowMs: t0
  });
  assert.equal(x.cooldownActive, true);
  assert.equal(x.shouldRebalance, false);
});


test('re-entry between 15-minute samples immediately resets the OOR episode', () => {
  const t0 = 7_000_000;
  const x = evaluatePosition({
    currentTick: 950,
    tickSpacing: 10,
    position: { tickLower: 900, tickUpper: 1000 },
    widthBps: 120,
    lastEvaluationAt: t0,
    outOfRangeSince: t0 - 45 * 60 * 1000,
    deepConfirmationsSeen: 1,
    checkIntervalMs: M15,
    nowMs: t0 + 5 * 60 * 1000
  });
  assert.equal(x.evaluationDue, false);
  assert.equal(x.outside, false);
  assert.equal(x.outOfRangeSince, 0);
  assert.equal(x.deepConfirmations, 0);
  assert.equal(x.shouldRebalance, false);
  assert.equal(x.evaluatedAt, t0);
});
