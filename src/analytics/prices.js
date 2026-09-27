import { spotToken1PerToken0 } from './liquidity.js';

export function buildUsdPriceMap(pools, usdgAddress) {
  const prices = new Map([[usdgAddress.toLowerCase(), 1]]);
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    for (const pool of pools) {
      if (!pool.state || !pool.token0 || !pool.token1) continue;
      if (pool.token0.decimals == null || pool.token1.decimals == null) continue;
      const spot = spotToken1PerToken0(pool.state.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
      if (!(spot > 0) || !Number.isFinite(spot)) continue;
      const k0 = pool.token0.address.toLowerCase();
      const k1 = pool.token1.address.toLowerCase();
      const p0 = prices.get(k0);
      const p1 = prices.get(k1);
      if (Number.isFinite(p0) && !Number.isFinite(p1)) {
        prices.set(k1, p0 / spot);
        changed = true;
      }
      if (Number.isFinite(p1) && !Number.isFinite(p0)) {
        prices.set(k0, p1 * spot);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return prices;
}

export function usdValue(amount, tokenAddress, prices) {
  const price = prices.get(tokenAddress.toLowerCase());
  return Number.isFinite(price) ? amount * price : null;
}
