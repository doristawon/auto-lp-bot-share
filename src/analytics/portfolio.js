import { formatUnits } from 'ethers';
import { rangeAmounts, spotToken1PerToken0 } from './liquidity.js';
import { usdValue } from './prices.js';
import { buildRebalanceInventoryPlan } from './rebalance-plan.js';

export class PortfolioAnalytics {
  constructor(config, ledger, state) {
    this.config = config;
    this.ledger = ledger;
    this.state = state;
  }

  build({ targetPools, walletBalances, prices, trackedTokens = [] }) {
    const positionMetrics = [];
    const inventory = new Map();
    const targetTokens = new Map();

    for (const token of trackedTokens || []) {
      targetTokens.set(token.address.toLowerCase(), token);
    }

    for (const pool of targetPools) {
      targetTokens.set(pool.token0.address.toLowerCase(), pool.token0);
      targetTokens.set(pool.token1.address.toLowerCase(), pool.token1);
      for (const position of pool.positions || []) {
        const amounts = rangeAmounts(
          position.shares,
          pool.state.sqrtPriceX96,
          position.tickLower,
          position.tickUpper,
          pool.token0.decimals,
          pool.token1.decimals
        );
        const owed0 = Number(formatUnits(position.owed0, pool.token0.decimals));
        const owed1 = Number(formatUnits(position.owed1, pool.token1.decimals));
        addInventory(inventory, pool.token0.address, amounts.amount0 + owed0);
        addInventory(inventory, pool.token1.address, amounts.amount1 + owed1);

        const principalUsd = valuePair(amounts.amount0, pool.token0.address, amounts.amount1, pool.token1.address, prices);
        const unclaimedFeeUsd = valuePair(owed0, pool.token0.address, owed1, pool.token1.address, prices);
        const baselineKey = `positionBaseline:${pool.id.toLowerCase()}:${position.id.toLowerCase()}`;
        let baseline = this.state.getSetting(baselineKey, null);
        if (!baseline || String(baseline.shares || '') !== position.shares.toString()) {
          baseline = {
            createdAt: Date.now(),
            shares: position.shares.toString(),
            amount0: amounts.amount0,
            amount1: amounts.amount1,
            token0: pool.token0.address,
            token1: pool.token1.address
          };
          this.state.setSetting(baselineKey, baseline);
        }
        const hodlUsd = valuePair(baseline.amount0, baseline.token0, baseline.amount1, baseline.token1, prices);
        const ilUsd = finitePair(principalUsd, hodlUsd) ? principalUsd - hodlUsd : null;
        const ilPct = Number.isFinite(ilUsd) && hodlUsd > 0 ? ilUsd / hodlUsd * 100 : null;
        let rebalancePlan = null;
        // Rebalance sizing must use THIS pool's own spot ratio, never a global
        // USD graph that could have priced the meme through a different pool.
        // token1 is the local reference unit: token0 value = token1/token0 spot.
        const localSpot1Per0 = spotToken1PerToken0(
          pool.state.sqrtPriceX96,
          pool.token0.decimals,
          pool.token1.decimals
        );
        // Absolute In-Range Hold: do not even construct an automatic rebalance inventory plan
        // while the LP is still earning inside its existing range.
        if (position.outside === true && position.target && Number.isFinite(localSpot1Per0) && localSpot1Per0 > 0) {
          try {
            rebalancePlan = buildRebalanceInventoryPlan({
              amount0: amounts.amount0 + owed0,
              amount1: amounts.amount1 + owed1,
              price0Usd: localSpot1Per0,
              price1Usd: 1,
              sqrtPriceX96: pool.state.sqrtPriceX96,
              tickLower: position.target.tickLower,
              tickUpper: position.target.tickUpper,
              decimals0: pool.token0.decimals,
              decimals1: pool.token1.decimals
            });
            rebalancePlan.valuationBasis = 'pool-local spot ratio; token1 reference unit';
          } catch {}
        }

        positionMetrics.push({
          id: position.id,
          pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
          poolId: pool.id,
          hook: pool.key.hooks,
          currentTick: pool.state.tick,
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          shares: position.shares.toString(),
          amount0: amounts.amount0,
          amount1: amounts.amount1,
          symbol0: pool.token0.symbol,
          symbol1: pool.token1.symbol,
          owed0,
          owed1,
          principalUsd,
          unclaimedFeeUsd,
          hodlUsd,
          ilUsd,
          ilPct,
          outside: Boolean(position.outside),
          excursionPct: Number(position.excursionPct || 0),
          confirmations: Number(position.confirmations || 0),
          deepConfirmations: Number(position.deepConfirmations || 0),
          outOfRangeSince: Number(position.outOfRangeSince || 0),
          outOfRangeElapsedMin: Number(position.outOfRangeElapsedMin || 0),
          evaluationDue: Boolean(position.evaluationDue),
          lastRangeEvaluationAt: Number(position.lastRangeEvaluationAt || 0),
          nextRangeEvaluationAt: Number(position.nextRangeEvaluationAt || 0),
          shouldRebalance: Boolean(position.shouldRebalance),
          rebalanceReason: position.rebalanceReason || null,
          target: position.target || null,
          rebalancePlan,
          rebalanceQuote: null,
          rebalanceQuoteError: null
        });
      }
    }

    for (const [address, token] of targetTokens) {
      const balance = walletBalances[address]?.amount || 0;
      addInventory(inventory, token.address, balance);
    }

    const inventoryObject = Object.fromEntries([...inventory.entries()]);
    let baseline = this.ledger.readBaseline();
    if (!baseline) {
      baseline = {
        createdAt: Date.now(),
        inventory: inventoryObject,
        initialValueUsd: inventoryUsd(inventoryObject, prices)
      };
      this.ledger.writeBaseline(baseline);
      this.ledger.append('portfolio.baseline_created', baseline);
    }

    const currentValueUsd = inventoryUsd(inventoryObject, prices);
    const hodlValueUsd = inventoryUsd(baseline.inventory || {}, prices);
    const gasUsd = uniqueGasUsd(this.ledger.all());
    const trackedFeeUsd = this.ledger.sum('feeUsd', 'fee.accrual');
    const cashflowEvents = this.ledger.all().filter((e) => e.type === 'cashflow.adjustment');
    const eventCashflow = cashflowEvents.reduce((sum, e) => sum + Number(e.usd || 0), 0);
    const netCashflowUsd = this.config.manualNetCashflowUsd + eventCashflow;
    const nativeIsTracked = targetTokens.has('0x0000000000000000000000000000000000000000');
    const grossPnlUsd = Number.isFinite(currentValueUsd) && Number.isFinite(baseline.initialValueUsd)
      ? currentValueUsd - baseline.initialValueUsd - netCashflowUsd
      : null;
    const netPnlUsd = Number.isFinite(grossPnlUsd) ? grossPnlUsd - (nativeIsTracked ? 0 : gasUsd) : null;
    const excessVsHodlUsd = finitePair(currentValueUsd, hodlValueUsd)
      ? currentValueUsd - hodlValueUsd - netCashflowUsd - (nativeIsTracked ? 0 : gasUsd)
      : null;
    const currentIlUsd = positionMetrics.reduce((sum, p) => sum + (Number.isFinite(p.ilUsd) ? p.ilUsd : 0), 0);

    return {
      baseline,
      inventory: inventoryObject,
      currentValueUsd,
      hodlValueUsd,
      grossPnlUsd,
      netPnlUsd,
      excessVsHodlUsd,
      currentIlUsd,
      gasUsd,
      trackedFeeUsd,
      netCashflowUsd,
      positions: positionMetrics
    };
  }
}

function addInventory(map, address, amount) {
  const key = address.toLowerCase();
  map.set(key, (map.get(key) || 0) + amount);
}
function inventoryUsd(inventory, prices) {
  let total = 0;
  for (const [address, amount] of Object.entries(inventory || {})) {
    const value = usdValue(Number(amount), address, prices);
    if (value == null) return null;
    total += value;
  }
  return total;
}
function valuePair(amount0, token0, amount1, token1, prices) {
  const v0 = usdValue(amount0, token0, prices);
  const v1 = usdValue(amount1, token1, prices);
  return v0 == null || v1 == null ? null : v0 + v1;
}
function finitePair(a, b) { return Number.isFinite(a) && Number.isFinite(b); }

function uniqueGasUsd(events) {
  const byHash = new Map();
  let withoutHash = 0;
  for (const event of events) {
    // portfolio.snapshot carries the running total. Counting it again makes
    // gas costs grow recursively on every snapshot.
    if (!['tx.confirmed', 'lp.deposit', 'lp.withdraw'].includes(event.type)) continue;
    const gas = Number(event.gasUsd || 0);
    if (!(gas > 0)) continue;
    if (event.hash) byHash.set(String(event.hash).toLowerCase(), Math.max(gas, byHash.get(String(event.hash).toLowerCase()) || 0));
    else withoutHash += gas;
  }
  return withoutHash + [...byHash.values()].reduce((sum, value) => sum + value, 0);
}
