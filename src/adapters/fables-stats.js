import { FABLES_STATS_URL } from '../constants.js';

const REQUEST_TIMEOUT_MS = 8_000;

export async function fetchFablesPoolStats() {
  const [tvlResult, volumeResult] = await Promise.all([
    fetchStats('PoolTvl'),
    fetchStats('PoolVolume24h')
  ]);
  if (!tvlResult.ok && !volumeResult.ok) {
    throw new Error('Fables public pool statistics are temporarily unavailable');
  }

  const tvlPools = tvlResult.data?.pools || {};
  const volumePools = volumeResult.data?.pools || {};
  const ids = new Set([...Object.keys(tvlPools), ...Object.keys(volumePools)]);
  const observedAt = Date.now();
  const pools = new Map();

  for (const id of ids) {
    const key = id.toLowerCase();
    const tvlUsd = finiteOrNull(tvlPools[id]?.tvlUsd);
    const volume24hUsd = finiteOrNull(volumePools[id]?.volumeUsd);
    const fees24hUsd = finiteOrNull(volumePools[id]?.feesUsd);
    pools.set(key, {
      tvlUsd,
      volume24hUsd,
      fees24hUsd,
      aprPct: tvlUsd > 0 && fees24hUsd != null && fees24hUsd >= 0
        ? fees24hUsd * 365 / tvlUsd * 100
        : null
    });
  }

  return {
    source: 'https://www.fables.fi',
    observedAt,
    pools,
    tvlAvailable: tvlResult.ok,
    volumeAvailable: volumeResult.ok
  };
}

async function fetchStats(operation) {
  try {
    const response = await fetch(new URL(operation, FABLES_STATS_URL), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) return { ok: false, data: null };
    const data = await response.json();
    if (!data || typeof data.pools !== 'object' || Array.isArray(data.pools)) {
      return { ok: false, data: null };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
