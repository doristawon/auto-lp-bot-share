import {
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getSqrtPriceAtTick
} from '../math/v4-fixed.js';

export async function buildExactBalancedSwapPlan({
  pool,
  quoter,
  rawAmount0,
  rawAmount1,
  sqrtPriceX96,
  tickLower,
  tickUpper,
  slippageBps = 50,
  iterations = 22
}) {
  rawAmount0 = BigInt(rawAmount0);
  rawAmount1 = BigInt(rawAmount1);
  const sqrtX = BigInt(sqrtPriceX96);
  const sqrtA = getSqrtPriceAtTick(tickLower);
  const sqrtB = getSqrtPriceAtTick(tickUpper);
  if (!(sqrtA < sqrtX && sqrtX < sqrtB)) {
    throw new Error('Target range must contain the current price before balancing inventory');
  }

  const initial = capacities(rawAmount0, rawAmount1, sqrtX, sqrtA, sqrtB);
  if (balancedEnough(initial.l0, initial.l1)) {
    return { direction: 'none', tokenIn: null, tokenOut: null, rawAmountIn: 0n, quote: null };
  }

  const tokenIn = initial.l0 > initial.l1 ? 0 : 1;
  const tokenOut = tokenIn === 0 ? 1 : 0;
  const available = tokenIn === 0 ? rawAmount0 : rawAmount1;
  if (available <= 1n) return { direction: 'none', tokenIn: null, tokenOut: null, rawAmountIn: 0n, quote: null };

  let lo = 1n;
  let hi = available;
  let best = null;
  for (let i = 0; i < iterations && lo <= hi; i++) {
    const mid = (lo + hi) >> 1n;
    const quote = await quoter.quoteExactInputSingleRaw(pool, tokenIn, mid, slippageBps);
    const out = BigInt(quote.rawAmountOut);
    const post0 = tokenIn === 0 ? rawAmount0 - mid : rawAmount0 + out;
    const post1 = tokenIn === 1 ? rawAmount1 - mid : rawAmount1 + out;
    const cap = capacities(post0, post1, sqrtX, sqrtA, sqrtB);
    const score = abs(cap.l0 - cap.l1);
    if (!best || score < best.score) best = { score, mid, quote, post0, post1, cap };

    if (tokenIn === 0) {
      if (cap.l0 > cap.l1) lo = mid + 1n;
      else hi = mid - 1n;
    } else {
      if (cap.l1 > cap.l0) lo = mid + 1n;
      else hi = mid - 1n;
    }
  }

  if (!best || best.mid <= 0n) return { direction: 'none', tokenIn: null, tokenOut: null, rawAmountIn: 0n, quote: null };
  return {
    direction: tokenIn === 0 ? '0_to_1' : '1_to_0',
    tokenIn,
    tokenOut,
    rawAmountIn: best.mid,
    quote: best.quote,
    projectedRaw0: best.post0,
    projectedRaw1: best.post1
  };
}

function capacities(amount0, amount1, sqrtX, sqrtA, sqrtB) {
  return {
    l0: getLiquidityForAmount0(sqrtX, sqrtB, amount0),
    l1: getLiquidityForAmount1(sqrtA, sqrtX, amount1)
  };
}
function balancedEnough(a, b) {
  const max = a > b ? a : b;
  if (max === 0n) return true;
  return abs(a - b) * 10000n <= max;
}
function abs(x) { return x < 0n ? -x : x; }
