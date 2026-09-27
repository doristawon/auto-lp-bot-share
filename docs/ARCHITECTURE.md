# v0.2 架構與 API-less 設計

## 為什麼不需要 Fables API

Fables 是鏈上 AMM。前端只是一個 client；BOT 真正需要的 source of truth 都能直接從 Robinhood Chain 取得：

| 資料 | 來源 |
|---|---|
| Active pools / PoolKey / hook | FablesPoolRegistry `activePools()` |
| Current tick / sqrt price / liquidity | Uniswap v4 PoolManager state |
| LP range id / ticks | Fables hook `rangeKey()` |
| Wallet range shares | hook ERC-6909 `balanceOf()` |
| User unclaimed fee state | `userPosition()` |
| LP lifecycle | `Deposited` / `Withdrawn` logs |
| Pool fees | `FeesCollected` logs |
| Wallet balance | ERC20 `balanceOf()` / native balance |
| Gas | transaction receipt |
| Writes | EVM signed transactions over RPC |

Fables 網站消失、前端改版或沒有 API key，BOT 的核心 monitor/accounting 仍可運作。

## RPC strategy

### Development

Robinhood public RPC + 15s polling。

### Production

- Primary：managed Robinhood RPC，例如 Alchemy / QuickNode / Chainstack。
- Secondary：另一家 managed provider。
- Last-resort：Robinhood public RPC。
- historical/backfill：archive-capable endpoint。

v0.2 使用 ethers `FallbackProvider` 做 read failover，第一個 endpoint 是 write provider。

## Data model

append-only ledger 優先於只存 mutable state：

```text
on-chain events ─┐
bot tx receipts ─┼─> events.jsonl ─> analytics ─> latest-snapshot.json ─> dashboard
manual cashflow ─┤
points baseline ─┘
```

這讓 PnL 可以重建，也方便後續 migration 到 SQLite/PostgreSQL。

## PnL decomposition

Dashboard 應分開看：

- Token market PnL
- LP principal
- Unclaimed fees
- Lifetime tracked fees
- Gas
- External cashflow
- Impermanent Loss vs HODL
- Excess return vs HODL
- Estimated points

不要只看 APR 或 LP position current value。

## Points estimator limitations

Fables leaderboard Points 若是 off-chain 計算，鏈上無法保證精準重建。因此：

- fee ledger = on-chain verified
- points formula = estimator
- actual leaderboard snapshot = manual calibration baseline

如果未來找到 leaderboard public endpoint/contract，再新增 adapter 即可，不改 accounting core。

## Fail-closed execution

任何未確認的 Fables deposit/zap selector 都不能進 live executor。

目前 executor 狀態：

```text
claimFees  VERIFIED
withdraw   VERIFIED
swap       GATED
new range  GATED
deposit    GATED
```

Reference tx inspector 是下一階段解鎖 gate 的工具。
