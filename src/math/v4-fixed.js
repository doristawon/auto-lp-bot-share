export const Q96 = 1n << 96n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const MAX_UINT256 = (1n << 256n) - 1n;

const TICK_MULTIPLIERS = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n]
];

export function getSqrtPriceAtTick(tick) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`Invalid tick: ${tick}`);
  }
  const absTick = Math.abs(tick);
  let price = (absTick & 1)
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  for (const [mask, multiplier] of TICK_MULTIPLIERS) {
    if (absTick & mask) price = (price * multiplier) >> 128n;
  }
  if (tick > 0) price = MAX_UINT256 / price;
  return (price + 0xffffffffn) >> 32n;
}

export function mulDiv(a, b, denominator) {
  a = BigInt(a); b = BigInt(b); denominator = BigInt(denominator);
  if (denominator === 0n) throw new Error('division by zero');
  return a * b / denominator;
}

export function mulDivRoundingUp(a, b, denominator) {
  a = BigInt(a); b = BigInt(b); denominator = BigInt(denominator);
  if (denominator === 0n) throw new Error('division by zero');
  const product = a * b;
  return product / denominator + (product % denominator === 0n ? 0n : 1n);
}

export function divRoundingUp(a, b) {
  a = BigInt(a); b = BigInt(b);
  if (b === 0n) throw new Error('division by zero');
  return a / b + (a % b === 0n ? 0n : 1n);
}

export function getLiquidityForAmount0(sqrtA, sqrtB, amount0) {
  [sqrtA, sqrtB] = sortSqrt(sqrtA, sqrtB);
  const intermediate = mulDiv(sqrtA, sqrtB, Q96);
  return mulDiv(BigInt(amount0), intermediate, sqrtB - sqrtA);
}

export function getLiquidityForAmount1(sqrtA, sqrtB, amount1) {
  [sqrtA, sqrtB] = sortSqrt(sqrtA, sqrtB);
  return mulDiv(BigInt(amount1), Q96, sqrtB - sqrtA);
}

export function getLiquidityForAmounts(sqrtX, sqrtA, sqrtB, amount0, amount1) {
  sqrtX = BigInt(sqrtX);
  [sqrtA, sqrtB] = sortSqrt(sqrtA, sqrtB);
  let liquidity;
  if (sqrtX <= sqrtA) {
    liquidity = getLiquidityForAmount0(sqrtA, sqrtB, amount0);
  } else if (sqrtX < sqrtB) {
    const l0 = getLiquidityForAmount0(sqrtX, sqrtB, amount0);
    const l1 = getLiquidityForAmount1(sqrtA, sqrtX, amount1);
    liquidity = l0 < l1 ? l0 : l1;
  } else {
    liquidity = getLiquidityForAmount1(sqrtA, sqrtB, amount1);
  }
  return assertUint128(liquidity, 'liquidity');
}

export function getAmount0ForLiquidity(sqrtA, sqrtB, liquidity, roundUp = false) {
  [sqrtA, sqrtB] = sortSqrt(sqrtA, sqrtB);
  const numerator1 = BigInt(liquidity) << 96n;
  const numerator2 = sqrtB - sqrtA;
  if (!roundUp) return mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
  return divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA);
}

export function getAmount1ForLiquidity(sqrtA, sqrtB, liquidity, roundUp = false) {
  [sqrtA, sqrtB] = sortSqrt(sqrtA, sqrtB);
  return roundUp
    ? mulDivRoundingUp(BigInt(liquidity), sqrtB - sqrtA, Q96)
    : mulDiv(BigInt(liquidity), sqrtB - sqrtA, Q96);
}

export function getAmountsForLiquidity(sqrtX, sqrtA, sqrtB, liquidity, roundUp = false) {
  sqrtX = BigInt(sqrtX);
  [sqrtA, sqrtB] = sortSqrt(sqrtA, sqrtB);
  liquidity = BigInt(liquidity);
  if (sqrtX <= sqrtA) {
    return { amount0: getAmount0ForLiquidity(sqrtA, sqrtB, liquidity, roundUp), amount1: 0n };
  }
  if (sqrtX < sqrtB) {
    return {
      amount0: getAmount0ForLiquidity(sqrtX, sqrtB, liquidity, roundUp),
      amount1: getAmount1ForLiquidity(sqrtA, sqrtX, liquidity, roundUp)
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(sqrtA, sqrtB, liquidity, roundUp) };
}

export function buildExactWithdrawBounds({ sqrtPriceX96, tickLower, tickUpper, liquidity, slippageBps = 50 }) {
  const sqrtA = getSqrtPriceAtTick(tickLower);
  const sqrtB = getSqrtPriceAtTick(tickUpper);
  const expected = getAmountsForLiquidity(BigInt(sqrtPriceX96), sqrtA, sqrtB, BigInt(liquidity), false);
  return {
    expected0: expected.amount0,
    expected1: expected.amount1,
    amount0Min: bpsDown(expected.amount0, slippageBps),
    amount1Min: bpsDown(expected.amount1, slippageBps)
  };
}

export function buildExactDepositPlan({
  rawAmount0,
  rawAmount1,
  sqrtPriceX96,
  tickLower,
  tickUpper,
  slippageBps = 50,
  liquidityReserveBps = 10
}) {
  rawAmount0 = BigInt(rawAmount0);
  rawAmount1 = BigInt(rawAmount1);
  const sqrtX = BigInt(sqrtPriceX96);
  const sqrtA = getSqrtPriceAtTick(tickLower);
  const sqrtB = getSqrtPriceAtTick(tickUpper);
  let liquidity = getLiquidityForAmounts(sqrtX, sqrtA, sqrtB, rawAmount0, rawAmount1);
  liquidity = bpsDown(liquidity, liquidityReserveBps);
  if (liquidity <= 0n) throw new Error('Exact deposit liquidity is zero');
  liquidity = assertUint128(liquidity, 'deposit liquidity');

  const required = getAmountsForLiquidity(sqrtX, sqrtA, sqrtB, liquidity, true);
  const amount0Max = minBigInt(rawAmount0, bpsUp(required.amount0, slippageBps));
  const amount1Max = minBigInt(rawAmount1, bpsUp(required.amount1, slippageBps));
  return {
    provisional: false,
    basis: 'post-swap raw balances / BigInt Q64.96 fixed-point',
    tickLower,
    tickUpper,
    liquidity,
    required0: required.amount0,
    required1: required.amount1,
    amount0Max: assertUint128(amount0Max, 'amount0Max'),
    amount1Max: assertUint128(amount1Max, 'amount1Max')
  };
}

export function bpsDown(value, bps) {
  value = BigInt(value);
  const n = BigInt(Math.max(0, Math.min(9999, Number(bps))));
  return value * (10000n - n) / 10000n;
}

export function bpsUp(value, bps) {
  value = BigInt(value);
  const n = BigInt(Math.max(0, Math.min(9999, Number(bps))));
  return mulDivRoundingUp(value, 10000n + n, 10000n);
}

export function assertUint128(value, label = 'value') {
  value = BigInt(value);
  if (value < 0n || value > MAX_UINT128) throw new Error(`${label} does not fit uint128`);
  return value;
}

function sortSqrt(a, b) {
  a = BigInt(a); b = BigInt(b);
  return a <= b ? [a, b] : [b, a];
}
function minBigInt(a, b) { return BigInt(a) < BigInt(b) ? BigInt(a) : BigInt(b); }
