import { Contract, formatUnits, getAddress } from 'ethers';

// Fables' public read-only lens. Keep this ABI in sync with the official
// userRanges ABI before changing the field layout.
const LENS_ADDRESS = '0xE44c0BAb43BdD47e7Ab40236bC183dCc77A9ED6c';
const LENS_ABI = [
  'function userRanges(address hook,address owner,uint256[] ids) view returns ((uint256 rangeId,bool keyVerified,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,int24 tickLower,int24 tickUpper,uint256 shares,uint128 staked,uint128 claimable0,uint128 claimable1,uint128 totalShares,uint128 totalStaked,uint16 effectiveClaimFeeBps,bool claimPaused,bool settling,uint160 sqrtPriceX96,int24 tick,bool inRange,int24 ticksToLower,int24 ticksToUpper,uint128 poolLiquidity,uint256 shareOfActiveLiquidityE18,uint256 amount0,uint256 amount1)[] rows,(uint256 arbBlockNumber,uint256 l1BlockNumber,uint64 timestamp,bool arbSysAnswered) stamp)'
];
const ORIGIN = 'https://www.fables.fi';
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

export async function fetchOfficialPoints(address, fetchFn = fetch) {
  const wallet = getAddress(address);
  const headers = { origin: ORIGIN, referer: `${ORIGIN}/leaderboard` };
  const [pointsResponse, boardResponse] = await Promise.all([
    fetchFn(`${ORIGIN}/api/points`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ address: wallet }),
      signal: AbortSignal.timeout(8_000)
    }),
    fetchFn(`${ORIGIN}/api/board`, { headers, signal: AbortSignal.timeout(8_000) })
  ]);
  if (!pointsResponse.ok || !boardResponse.ok) throw new Error('Fables points API unavailable');
  const [points, board] = await Promise.all([pointsResponse.json(), boardResponse.json()]);
  const settledAtSec = Number(board?.meta?.settledAt);
  const lpPoints = Number(points?.points);
  const referralPoints = Number(points?.referral || 0);
  const settledFeesUsd = Number(points?.standing?.fees);
  if (!Number.isFinite(settledAtSec) || settledAtSec <= 0 || !Number.isSafeInteger(lpPoints) || lpPoints < 0 ||
      !Number.isSafeInteger(referralPoints) || referralPoints < 0 || !Number.isFinite(settledFeesUsd) || settledFeesUsd < 0) {
    throw new Error('Fables points API returned incomplete settlement data');
  }
  return {
    wallet: wallet.toLowerCase(),
    settledAt: settledAtSec * 1000,
    settledThroughDay: Number(board.meta.settledThroughDay),
    lpPoints,
    referralPoints,
    settledFeesUsd,
    depositsUsd: finiteOrNull(points.standing?.deposits),
    history: Array.isArray(points.history) ? points.history.map((day) => ({
      day: Number(day.day),
      settledAt: Number(day.t) * 1000,
      lpPoints: Number(day.lp || 0),
      referralPoints: Number(day.referral || 0)
    })).filter((day) => Number.isFinite(day.settledAt) && Number.isFinite(day.lpPoints)) : []
  };
}

export async function fetchWalletFeeEvidence({ address, provider, pools, prices, fetchFn = fetch }) {
  const wallet = getAddress(address);
  const poolById = new Map(pools.map((pool) => [pool.id.toLowerCase(), pool]));
  const owner = await fetchOwnerLedger(wallet, fetchFn);
  const unknownPoolIds = new Set();
  let claimedFeeUsd = 0;
  for (const claim of owner.FeeClaim) {
    const pool = poolById.get(String(claim.pool_id).toLowerCase());
    if (!pool) { unknownPoolIds.add(String(claim.pool_id).toLowerCase()); continue; }
    const value = valueRawPair(claim.amount0, claim.amount1, pool, prices);
    if (value === null) { unknownPoolIds.add(pool.id.toLowerCase()); continue; }
    claimedFeeUsd += value;
  }

  const byHook = new Map();
  for (const position of owner.Position) {
    const pool = poolById.get(String(position.pool_id).toLowerCase());
    if (!pool) { unknownPoolIds.add(String(position.pool_id).toLowerCase()); continue; }
    const hook = pool.key.hooks.toLowerCase();
    const ids = byHook.get(hook) || [];
    ids.push(String(position.range_id).toLowerCase());
    byHook.set(hook, ids);
  }
  if (unknownPoolIds.size) throw new Error('Wallet fee evidence includes pools absent from the current registry');

  const lens = new Contract(LENS_ADDRESS, LENS_ABI, provider);
  let claimableFeeUsd = 0;
  let positionCount = 0;
  let lensTimestamp = 0;
  for (const [hook, allIds] of byHook) {
    const ids = [...new Set(allIds)];
    for (let offset = 0; offset < ids.length; offset += 200) {
      const chunk = ids.slice(offset, offset + 200);
      const [rows, stamp] = await lens.userRanges(hook, wallet, chunk);
      lensTimestamp = Math.max(lensTimestamp, Number(stamp.timestamp) * 1000);
      if (rows.length !== chunk.length) throw new Error('Fables lens returned an incomplete range batch');
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (!row.keyVerified || BigInt(row.rangeId) !== BigInt(chunk[index])) {
          throw new Error('Fables lens did not verify a wallet range');
        }
        if (row.shares === 0n && row.claimable0 === 0n && row.claimable1 === 0n) continue;
        const pool = [...poolById.values()].find((item) => item.key.hooks.toLowerCase() === hook &&
          item.key.currency0.toLowerCase() === row.key.currency0.toLowerCase() &&
          item.key.currency1.toLowerCase() === row.key.currency1.toLowerCase() &&
          Number(item.key.fee) === Number(row.key.fee) &&
          Number(item.key.tickSpacing) === Number(row.key.tickSpacing));
        if (!pool) throw new Error('Fables lens range key does not match a registry pool');
        const value = valueRawPair(row.claimable0, row.claimable1, pool, prices);
        if (value === null) throw new Error('A wallet fee token has no current USD price');
        claimableFeeUsd += value;
        positionCount += 1;
      }
    }
  }
  const firstDepositAt = owner.LiquidityEvent
    .filter((event) => event.kind === 'DEPOSIT')
    .reduce((min, event) => Math.min(min, Number(event.timestamp) * 1000), Infinity);
  return {
    wallet: wallet.toLowerCase(),
    observedAt: Date.now(),
    indexerBlock: Number(owner.chain_metadata?.[0]?.latest_processed_block || 0),
    lensTimestamp: lensTimestamp || null,
    firstDepositAt: Number.isFinite(firstDepositAt) ? firstDepositAt : null,
    depositCount: owner.LiquidityEvent.filter((event) => event.kind === 'DEPOSIT').length,
    withdrawalCount: owner.LiquidityEvent.filter((event) => event.kind === 'WITHDRAW').length,
    claimCount: owner.FeeClaim.length,
    transactionHashes: [...new Set([...owner.LiquidityEvent, ...owner.FeeClaim]
      .map((event) => String(event.txHash || '').toLowerCase()).filter(Boolean))],
    positionCount,
    claimedFeeUsd,
    claimableFeeUsd,
    lifetimeFeeUsd: claimedFeeUsd + claimableFeeUsd
  };
}

async function fetchOwnerLedger(address, fetchFn) {
  const names = ['Position', 'LiquidityEvent', 'FeeClaim'];
  const combined = Object.fromEntries(names.map((name) => [name, []]));
  let chainMetadata = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchFn(`${ORIGIN}/api/indexer`, {
      method: 'POST',
      headers: { origin: ORIGIN, referer: `${ORIGIN}/portfolio`, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'owner', address: address.toLowerCase(), off: String(page * PAGE_SIZE) }),
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error('Fables wallet indexer unavailable');
    const body = await response.json();
    if (body.errors?.length || !body.data) throw new Error('Fables wallet indexer returned invalid data');
    chainMetadata = body.data.chain_metadata;
    let needsNextPage = false;
    for (const name of names) {
      const rows = body.data[name];
      if (!Array.isArray(rows)) throw new Error(`Fables wallet indexer missing ${name}`);
      combined[name].push(...rows);
      if (rows.length >= PAGE_SIZE) needsNextPage = true;
    }
    if (!needsNextPage) return { ...combined, chain_metadata: chainMetadata };
  }
  throw new Error('Fables wallet history exceeds the bounded indexer read');
}

function valueRawPair(raw0, raw1, pool, prices) {
  const price0 = Number(prices.get(pool.token0.address.toLowerCase()));
  const price1 = Number(prices.get(pool.token1.address.toLowerCase()));
  if (!(price0 > 0) || !(price1 > 0)) return null;
  const amount0 = Number(formatUnits(BigInt(raw0), pool.token0.decimals));
  const amount1 = Number(formatUnits(BigInt(raw1), pool.token1.decimals));
  return amount0 * price0 + amount1 * price1;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
