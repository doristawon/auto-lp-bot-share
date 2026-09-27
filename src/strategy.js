import { buildTargetRange, isLpOutOfRange, isOutsideRange } from './math/ticks.js';

export function outOfRangeExcursionPct(currentTick, tickLower, tickUpper) {
  if (currentTick <= tickLower) {
    return (Math.pow(1.0001, tickLower - currentTick) - 1) * 100;
  }
  if (currentTick >= tickUpper) {
    return (Math.pow(1.0001, currentTick - tickUpper) - 1) * 100;
  }
  return 0;
}

export function evaluatePosition({
  currentTick,
  tickSpacing,
  position,
  widthBps,
  rangePreset = 'custom-bps',
  edgeBufferTicks = 0,
  lastEvaluationAt = 0,
  outOfRangeSince = 0,
  deepConfirmationsSeen = 0,
  checkIntervalMs = 15 * 60 * 1000,
  shallowThresholdPct = 0.5,
  maxWaitMs = 90 * 60 * 1000,
  deepConfirmationsRequired = 2,
  cooldownUntil = 0,
  nowMs = Date.now()
}) {
  // ABSOLUTE RULE: automatic LP withdrawal eligibility uses only the true LP range.
  // edgeBufferTicks is monitoring-only and can never turn an in-range LP into a rebalance candidate.
  const outside = isLpOutOfRange(currentTick, position.tickLower, position.tickUpper);
  const nearEdge = !outside && edgeBufferTicks > 0
    && isOutsideRange(currentTick, position.tickLower, position.tickUpper, edgeBufferTicks);
  const excursionPct = outOfRangeExcursionPct(currentTick, position.tickLower, position.tickUpper);
  const target = buildTargetRange(currentTick, tickSpacing, widthBps, rangePreset);
  const cooldownActive = nowMs < cooldownUntil;
  const evaluationDue = !lastEvaluationAt || nowMs - lastEvaluationAt >= checkIntervalMs;

  // Re-entry is an asynchronous safety reset, not a 15-minute policy sample.
  // Any fast monitor observation back inside the original LP range breaks the OOR
  // episode immediately, so a later breakout can never inherit an old 90m timer
  // or deep-confirmation count.
  if (!outside) {
    const evaluatedAt = evaluationDue ? nowMs : lastEvaluationAt;
    return {
      outside: false,
      nearEdge,
      excursionPct: 0,
      evaluationDue,
      evaluatedAt,
      nextEvaluationAt: evaluatedAt + checkIntervalMs,
      outOfRangeSince: 0,
      outOfRangeElapsedMs: 0,
      deepConfirmations: 0,
      cooldownActive,
      shouldRebalance: false,
      rebalanceReason: null,
      target
    };
  }

  if (!evaluationDue) {
    const elapsedMs = outOfRangeSince ? Math.max(0, nowMs - outOfRangeSince) : 0;
    return {
      outside: true,
      nearEdge: false,
      excursionPct,
      evaluationDue: false,
      evaluatedAt: lastEvaluationAt,
      nextEvaluationAt: lastEvaluationAt + checkIntervalMs,
      outOfRangeSince,
      outOfRangeElapsedMs: elapsedMs,
      deepConfirmations: deepConfirmationsSeen,
      cooldownActive,
      shouldRebalance: false,
      rebalanceReason: null,
      target
    };
  }

  const nextOutOfRangeSince = outOfRangeSince || nowMs;
  const outOfRangeElapsedMs = Math.max(0, nowMs - nextOutOfRangeSince);
  const deepConfirmations = excursionPct > shallowThresholdPct ? deepConfirmationsSeen + 1 : 0;
  const deepConfirmed = deepConfirmations >= deepConfirmationsRequired;
  const waitExpired = outOfRangeElapsedMs >= maxWaitMs;
  const shouldRebalance = !cooldownActive && (deepConfirmed || waitExpired);
  const rebalanceReason = shouldRebalance
    ? (waitExpired ? 'oor_max_wait_expired' : 'deep_oor_confirmed')
    : null;

  return {
    outside: true,
    nearEdge: false,
    excursionPct,
    evaluationDue: true,
    evaluatedAt: nowMs,
    nextEvaluationAt: nowMs + checkIntervalMs,
    outOfRangeSince: nextOutOfRangeSince,
    outOfRangeElapsedMs,
    deepConfirmations,
    cooldownActive,
    shouldRebalance,
    rebalanceReason,
    target
  };
}
