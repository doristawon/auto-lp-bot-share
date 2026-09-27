import {
  FABLES_LP_POINTS_TOTAL,
  FABLES_POINTS_END_MS,
  FABLES_POINTS_START_MS,
  FABLES_WEEKLY_POINT_WEIGHTS
} from '../constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function pointsWeekIndex(timestampMs) {
  if (timestampMs < FABLES_POINTS_START_MS || timestampMs >= FABLES_POINTS_END_MS) return -1;
  return Math.min(5, Math.floor((timestampMs - FABLES_POINTS_START_MS) / WEEK_MS));
}

export function dailyPointBudget(timestampMs) {
  const week = pointsWeekIndex(timestampMs);
  if (week < 0) return 0;
  return FABLES_LP_POINTS_TOTAL * FABLES_WEEKLY_POINT_WEIGHTS[week] / 7;
}

export function estimateDailyPoints(timestampMs, userFeeUsd, totalFablesFeeUsd) {
  if (!(userFeeUsd > 0) || !(totalFablesFeeUsd > 0)) return 0;
  return dailyPointBudget(timestampMs) * userFeeUsd / totalFablesFeeUsd;
}

export function estimatePointsFromDailyBuckets(buckets) {
  let total = 0;
  for (const bucket of Object.values(buckets || {})) {
    total += estimateDailyPoints(bucket.timestampMs, bucket.userFeeUsd || 0, bucket.totalFeeUsd || 0);
  }
  return total;
}

export function utcDayKey(timestampMs) {
  const programmeDayStart = FABLES_POINTS_START_MS + Math.floor((timestampMs - FABLES_POINTS_START_MS) / DAY_MS) * DAY_MS;
  return new Date(programmeDayStart).toISOString().slice(0, 10);
}
