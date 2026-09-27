import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyPointBudget, estimateDailyPoints, pointsWeekIndex } from '../src/analytics/points.js';
import { FABLES_LP_POINTS_TOTAL, FABLES_WEEKLY_POINT_WEIGHTS } from '../src/constants.js';

test('points campaign has six weekly buckets', () => {
  const start = Date.parse('2026-08-24T02:00:00Z');
  assert.equal(pointsWeekIndex(start), 0);
  assert.equal(pointsWeekIndex(start + 7 * 86400000), 1);
  assert.equal(pointsWeekIndex(Date.parse('2026-10-05T02:00:00Z')), -1);
});

test('daily budget uses weekly allocation', () => {
  const at = Date.parse('2026-08-24T12:00:00Z');
  assert.equal(dailyPointBudget(at), FABLES_LP_POINTS_TOTAL * FABLES_WEEKLY_POINT_WEIGHTS[0] / 7);
});

test('fee share maps linearly to estimated points', () => {
  const at = Date.parse('2026-09-21T12:00:00Z');
  const budget = dailyPointBudget(at);
  assert.equal(estimateDailyPoints(at, 25, 100), budget * 0.25);
  assert.equal(estimateDailyPoints(at, 0, 100), 0);
});
