# Live Mode 上線檢查清單

v0.5.0 已具備完整 receipt-reconciled withdraw → swap → deposit executor、EIP-7702 atomic In-Range guard、recovery journal 與 deployment-aware dashboard。正式送出真實交易前，仍必須逐項完成以下 canary。

## 1. 安全預設

正式切 live 前，repo / image / log 內不得出現 private key。預設維持：

```env
DRY_RUN=true
ENABLE_LIVE_WRITES=false
ENABLE_AUTO_REDEPLOY=false
EIP7702_GUARD_VERIFIED=false
DASHBOARD_MANUAL_CONTROL_ENABLED=false
```

Dashboard 顯示 `DRY RUN`、`MANUAL SAFE-OFF` 為正常安全狀態。

## 2. Wallet / RPC / topology

- `PRIVATE_KEY` 必須與 `WALLET_ADDRESS` 完全一致。
- chain id 必須為 4663。
- 建議 managed/archive-capable RPC 放第一順位，public RPC 作 fallback。
- `TARGET_MODE=wallet-active` 時，active pool / range / shares 必須與錢包與 Fables UI 一致。
- Dashboard current block、RPC health、current tick、tick range 必須合理。
- 任何 wallet topology handoff 會觸發 cooldown；cooldown 期間不得強制繞過。

## 3. Range policy

Production policy：

```env
RANGE_CHECK_INTERVAL_MS=900000
OOR_SHALLOW_THRESHOLD_PCT=0.5
OOR_MAX_WAIT_MIN=90
OOR_DEEP_CONFIRMATIONS=2
```

絕對規則：

> `tickLower <= currentTick < tickUpper` 時，任何自動或手動 withdraw 都禁止。

Manual Rebalance 不得提供 bypass。

## 4. EIP-7702 guard

依序執行：

```bash
npm run compile:guard
npm run deploy:guard
npm run setup:guard
npm run verify:guard
```

必須同時確認：

- wallet delegation pointer 指向指定 guard implementation。
- `guardVersion() == keccak256("Fables7702Guard/v1")`。
- `IMPLEMENTATION() == EIP7702_GUARD_ADDRESS`。
- 真實 In-Range LP 的 guarded withdrawal canary 必須 revert。
- guard runtime readiness 在 Dashboard 顯示 `READY`。

完成後才人工設定：

```env
EIP7702_GUARD_VERIFIED=true
```

## 5. Withdraw / swap / deposit path

目前 executor 必須維持：

```text
fresh OOR recheck
→ guarded withdrawAndClaim
→ wait receipt
→ verify old shares == 0
→ read actual raw wallet balances
→ compute exact balanced swap
→ Universal Router V4 quote + eth_call simulation
→ exact-input swap
→ wait receipt
→ assert actual spent == requested amountIn
→ assert actual received >= minOut
→ read actual balances + latest slot0
→ recompute target / BigInt liquidity / caps
→ deposit
→ wait receipt
→ verify Deposited event
→ verify exact PoolKey + target ticks
→ verify new ERC-6909 shares > 0
```

任何 capital-moving phase 失敗後進 `recovery_required`，不得開始下一筆 execution。

## 6. Dashboard manual canary

先保持：

```env
DRY_RUN=true
DASHBOARD_MANUAL_CONTROL_ENABLED=true
```

在 Control Center：

1. 按 `Scan now · no trades`。
2. 確認該 position 真的是 OUT。
3. 確認 OOR elapsed / excursion / deep confirmations 已達 policy。
4. 使用該 position 的 `Run dry-run`。
5. 確認 ledger 出現 `rebalance.manual_requested` 與 `rebalance.dry_run`。
6. 確認 dry-run 沒有改變 shares、range、OOR timer、cooldown 或 rebalanceHistory。

完成後才進入小額真實 canary。

## 7. 小額 live canary

切換：

```env
DRY_RUN=false
ENABLE_LIVE_WRITES=true
ENABLE_AUTO_REDEPLOY=true
EIP7702_GUARD_VERIFIED=true
DASHBOARD_MANUAL_CONTROL_ENABLED=true
```

Dashboard 必須同時顯示：

- Signer: READY
- Live writes: READY
- Auto redeploy: READY
- Guard config flag: READY
- Guard runtime: READY
- Recovery: CLEAR
- Execution: LIVE READY

只挑一個小額、已達 OOR policy 的 position 做第一次 Manual Rebalance。

驗證：

- withdraw receipt 成功。
- old range shares = 0。
- swap（若需要）spent exactly equal exact-in request。
- received >= minOut。
- deposit receipt 成功。
- new PoolKey / ticks 正確。
- new ERC-6909 shares > 0。
- residual wallet balances 合理。
- dashboard / ledger / explorer 三方 tx hash 與 balance delta 一致。

## 8. Pause / recovery

Dashboard `Pause new execution`：

- 阻止新的 rebalance 開始。
- 不停止監控與 accounting。
- **不會**在已經 withdraw / swap / deposit 中途硬中斷既有 state machine；既有流程會走到安全完成或 `recovery_required`。

若出現 `recovery_required`：

1. Dashboard 自動 Pause。
2. Resume 必須被拒絕。
3. 執行 `npm run inspect:recovery`。
4. 對照 receipts 與 actual balances。
5. 完成人工 recovery review 後才能清除/處理 execution journal。

## 9. 正式 unattended live

只有小額 canary 完整成功後，才考慮讓 scheduler 自動執行。

即使進入 unattended live，也保留：

- Absolute In-Range Hold
- 15m / 0.5% / 90m / 2-confirm policy
- topology cooldown / revalidation
- max gas
- withdraw / swap / deposit slippage
- hourly rate limit
- recovery auto-pause
- Dashboard manual-control arming 分離
