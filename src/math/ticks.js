import { MAX_TICK, MIN_TICK } from '../constants.js';

const LOG_1_0001 = Math.log(1.0001);

export function priceWidthBpsToTickDelta(widthBps) {
  if (!Number.isFinite(widthBps) || widthBps <= 0) throw new Error('widthBps must be > 0');
  return Math.max(1, Math.ceil(Math.log1p(widthBps / 10_000) / LOG_1_0001));
}

export function snapTickDown(tick, spacing) {
  validateSpacing(spacing);
  return Math.floor(tick / spacing) * spacing;
}

export function snapTickUp(tick, spacing) {
  validateSpacing(spacing);
  return Math.ceil(tick / spacing) * spacing;
}

export function clampUsableTick(tick, spacing, direction) {
  const snapped = direction === 'up' ? snapTickUp(tick, spacing) : snapTickDown(tick, spacing);
  const min = snapTickUp(MIN_TICK, spacing);
  const max = snapTickDown(MAX_TICK, spacing);
  return Math.min(max, Math.max(min, snapped));
}

export function buildCenteredRange(currentTick, tickSpacing, widthBps) {
  const delta = priceWidthBpsToTickDelta(widthBps);
  let tickLower = clampUsableTick(currentTick - delta, tickSpacing, 'down');
  let tickUpper = clampUsableTick(currentTick + delta, tickSpacing, 'up');
  if (tickLower >= currentTick) tickLower = clampUsableTick(currentTick - tickSpacing, tickSpacing, 'down');
  if (tickUpper <= currentTick) tickUpper = clampUsableTick(currentTick + tickSpacing, tickSpacing, 'up');
  if (tickLower >= tickUpper) throw new Error('Unable to build a valid tick range');
  return { tickLower, tickUpper, tickDelta: delta };
}

// Fables frontend's "Tight" preset: +/-1% converted to usable tick steps,
// centered on the nearest usable tick (not floor/ceil of a BPS band).
export function buildFablesTightRange(currentTick, tickSpacing) {
  validateSpacing(tickSpacing);
  const tickDelta = Math.max(
    tickSpacing,
    Math.round(Math.log1p(0.01) / LOG_1_0001 / tickSpacing) * tickSpacing
  );
  const center = Math.round(currentTick / tickSpacing) * tickSpacing;
  const tickLower = clampUsableTick(center - tickDelta, tickSpacing, 'down');
  const tickUpper = clampUsableTick(center + tickDelta, tickSpacing, 'up');
  if (tickLower > currentTick || currentTick >= tickUpper) {
    throw new Error('Fables Tight range cannot contain the current tick');
  }
  return { tickLower, tickUpper, tickDelta };
}

export function buildTargetRange(currentTick, tickSpacing, widthBps, preset = 'custom-bps') {
  return preset === 'fables-tight'
    ? buildFablesTightRange(currentTick, tickSpacing)
    : buildCenteredRange(currentTick, tickSpacing, widthBps);
}

// Canonical Uniswap concentrated-liquidity membership rule:
// lower tick is active/in-range, upper tick is exclusive.
export function isLpOutOfRange(currentTick, tickLower, tickUpper) {
  return currentTick < tickLower || currentTick >= tickUpper;
}

export function isLpInRange(currentTick, tickLower, tickUpper) {
  return !isLpOutOfRange(currentTick, tickLower, tickUpper);
}

// Monitoring-only helper. A positive edge buffer may flag "near edge" while the LP
// is still truly in-range. It must never be used as authorization to withdraw.
export function isOutsideRange(currentTick, tickLower, tickUpper, edgeBufferTicks = 0) {
  return currentTick <= tickLower + edgeBufferTicks || currentTick >= tickUpper - edgeBufferTicks;
}

function validateSpacing(spacing) {
  if (!Number.isInteger(spacing) || spacing <= 0) throw new Error('tickSpacing must be a positive integer');
}
