const Q96 = 2 ** 96;

export function sqrtPriceFloat(sqrtPriceX96) {
  return Number(sqrtPriceX96) / Q96;
}

export function spotToken1PerToken0(sqrtPriceX96, decimals0, decimals1) {
  const sqrt = sqrtPriceFloat(sqrtPriceX96);
  return sqrt * sqrt * Math.pow(10, decimals0 - decimals1);
}

export function rangeAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1) {
  const L = Number(liquidity);
  const sp = sqrtPriceFloat(sqrtPriceX96);
  const sa = Math.pow(1.0001, tickLower / 2);
  const sb = Math.pow(1.0001, tickUpper / 2);
  if (!(L > 0) || !(sp > 0) || !(sb > sa)) return { amount0: 0, amount1: 0 };
  let raw0 = 0;
  let raw1 = 0;
  if (sp <= sa) raw0 = L * (sb - sa) / (sa * sb);
  else if (sp >= sb) raw1 = L * (sb - sa);
  else {
    raw0 = L * (sb - sp) / (sp * sb);
    raw1 = L * (sp - sa);
  }
  return {
    amount0: raw0 / Math.pow(10, decimals0),
    amount1: raw1 / Math.pow(10, decimals1)
  };
}

export function rawAmountToNumber(value, decimals) {
  return Number(value) / Math.pow(10, decimals);
}
