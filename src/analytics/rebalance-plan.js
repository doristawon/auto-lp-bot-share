const Q96 = 2 ** 96;
const MAX_UINT128 = (1n << 128n) - 1n;

export function targetAmountsPerLiquidity({ sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1 }) {
  const sp = Number(sqrtPriceX96) / Q96;
  const [raw0, raw1] = rangeRawAmountsPerLiquidity(sp, tickLower, tickUpper);
  return {
    amount0PerL: raw0 / Math.pow(10, decimals0),
    amount1PerL: raw1 / Math.pow(10, decimals1)
  };
}

export function buildRebalanceInventoryPlan({
  amount0,
  amount1,
  price0Usd,
  price1Usd,
  sqrtPriceX96,
  tickLower,
  tickUpper,
  decimals0,
  decimals1
}) {
  const unit = targetAmountsPerLiquidity({ sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1 });
  const unitValueUsd = unit.amount0PerL * price0Usd + unit.amount1PerL * price1Usd;
  const totalValueUsd = amount0 * price0Usd + amount1 * price1Usd;
  if (!(unitValueUsd > 0) || !(totalValueUsd >= 0)) throw new Error('Unable to value rebalance inventory');
  const scale = totalValueUsd / unitValueUsd;
  const target0 = unit.amount0PerL * scale;
  const target1 = unit.amount1PerL * scale;
  const delta0 = target0 - amount0;
  const delta1 = target1 - amount1;
  const toleranceUsd = Math.max(0.01, totalValueUsd * 0.0001);
  let direction = 'none';
  let amountIn = 0;
  let tokenIn = null;
  let tokenOut = null;
  if (delta0 > 0 && -delta1 * price1Usd > toleranceUsd) {
    direction = '1_to_0';
    amountIn = Math.min(amount1, Math.max(0, -delta1));
    tokenIn = 1;
    tokenOut = 0;
  } else if (delta1 > 0 && -delta0 * price0Usd > toleranceUsd) {
    direction = '0_to_1';
    amountIn = Math.min(amount0, Math.max(0, -delta0));
    tokenIn = 0;
    tokenOut = 1;
  }
  return {
    provisional: true,
    basis: 'pre-withdraw spot / approximate inventory ratio',
    totalValueUsd,
    target0,
    target1,
    delta0,
    delta1,
    direction,
    amountIn,
    tokenIn,
    tokenOut,
    idealLiquidityApprox: scale
  };
}

export function buildDepositPlan({
  amount0,
  amount1,
  inventoryPlan,
  quote,
  sqrtPriceX96,
  tickLower,
  tickUpper,
  decimals0,
  decimals1,
  slippageBps = 50,
  liquidityReserveBps = 10
}) {
  let projected0 = Number(amount0);
  let projected1 = Number(amount1);
  if (quote && inventoryPlan?.direction === '0_to_1') {
    projected0 -= Number(quote.amountIn);
    projected1 += Number(quote.amountOut);
  } else if (quote && inventoryPlan?.direction === '1_to_0') {
    projected1 -= Number(quote.amountIn);
    projected0 += Number(quote.amountOut);
  }
  projected0 = Math.max(0, projected0);
  projected1 = Math.max(0, projected1);

  const unit = targetAmountsPerLiquidity({ sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1 });
  const candidates = [];
  if (unit.amount0PerL > 0) candidates.push(projected0 / unit.amount0PerL);
  if (unit.amount1PerL > 0) candidates.push(projected1 / unit.amount1PerL);
  if (!candidates.length || candidates.some((x) => !Number.isFinite(x) || x <= 0)) {
    throw new Error('Unable to derive deposit liquidity from projected inventory');
  }

  const reserve = Math.max(0, Math.min(9999, Number(liquidityReserveBps))) / 10000;
  const liquidityApprox = Math.min(...candidates) * (1 - reserve);
  const liquidity = approxUint128(liquidityApprox, 'liquidity');

  const sp = Number(sqrtPriceX96) / Q96;
  const slip = Math.max(0, Math.min(9999, Number(slippageBps))) / 10000;
  const lowerSp = sp * Math.sqrt(1 - slip);
  const upperSp = sp * Math.sqrt(1 + slip);
  const amount0MaxRawApprox = rawAmount0ForLiquidity(Number(liquidity), lowerSp, tickLower, tickUpper);
  const amount1MaxRawApprox = rawAmount1ForLiquidity(Number(liquidity), upperSp, tickLower, tickUpper);
  const amount0Max = approxUint128Ceil(amount0MaxRawApprox, 'amount0Max');
  const amount1Max = approxUint128Ceil(amount1MaxRawApprox, 'amount1Max');

  return {
    provisional: true,
    basis: 'pre-swap float approximation; must be rebuilt from post-swap receipt before live deposit',
    projected0,
    projected1,
    tickLower,
    tickUpper,
    slippageBps: Number(slippageBps),
    liquidityReserveBps: Number(liquidityReserveBps),
    liquidity: liquidity.toString(),
    liquidityApprox,
    amount0MaxRaw: amount0Max.toString(),
    amount1MaxRaw: amount1Max.toString(),
    amount0Max: Number(amount0Max) / Math.pow(10, decimals0),
    amount1Max: Number(amount1Max) / Math.pow(10, decimals1)
  };
}

function rangeRawAmountsPerLiquidity(sp, tickLower, tickUpper) {
  const sa = Math.pow(1.0001, tickLower / 2);
  const sb = Math.pow(1.0001, tickUpper / 2);
  if (!(sp > 0) || !(sb > sa)) throw new Error('Invalid target range/price');
  if (sp <= sa) return [(sb - sa) / (sa * sb), 0];
  if (sp >= sb) return [0, sb - sa];
  return [(sb - sp) / (sp * sb), sp - sa];
}

function rawAmount0ForLiquidity(liquidity, sp, tickLower, tickUpper) {
  return liquidity * rangeRawAmountsPerLiquidity(sp, tickLower, tickUpper)[0];
}

function rawAmount1ForLiquidity(liquidity, sp, tickLower, tickUpper) {
  return liquidity * rangeRawAmountsPerLiquidity(sp, tickLower, tickUpper)[1];
}

function approxUint128(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${label}`);
  const result = BigInt(Math.floor(value));
  if (result <= 0n || result > MAX_UINT128) throw new Error(`${label} does not fit uint128`);
  return result;
}

function approxUint128Ceil(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
  // JS floating point has ~15 significant digits. Add a tiny one-sided cushion
  // so an amountMax generated from a large raw value is never rounded below the
  // mathematical cap. The configured price-slippage bound remains the real guard.
  const cushioned = value * (1 + 1e-12) + 1;
  const result = BigInt(Math.ceil(cushioned));
  if (result < 0n || result > MAX_UINT128) throw new Error(`${label} does not fit uint128`);
  return result;
}
