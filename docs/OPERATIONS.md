# 操作手冊

## 安全啟動

1. 安裝 Node.js 20 以上並複製本 repo。
2. 執行 `npm ci`，再將 `.env.example` 複製為 `.env`。
3. 設定 `WALLET_ADDRESS`；需要代管 RPC 時，將本機端點填入 `RPC_URLS`。
4. 保持 `DRY_RUN=true`、`ENABLE_LIVE_WRITES=false`、`ENABLE_AUTO_REDEPLOY=false` 與 `DASHBOARD_MANUAL_CONTROL_ENABLED=false`。
5. 執行 `npm run check`、`npm test`、`npm run compile:guard`。
6. 執行 `npm start`，再開啟 `DASHBOARD_HOST` 與 `DASHBOARD_PORT` 指定的本機中控台。

中控台在暫停執行時仍會持續監控。選擇或加入監控某個池子本身不會授權送出交易。

## 憑證

`.env` 請只留在本機。不要把秘密資料貼到 issue、pull request、截圖、log 或支援訊息。若啟用中控台憑證持久化，程式會更新被 Git 忽略的 `.env`；匯入的助記詞只用來推導目前簽署器。帳本與狀態資料請分開備份，不要把憑證一起放進備份。

除非你已刻意設定遠端存取，請讓中控台綁定 `127.0.0.1`。啟用實盤寫入、人工控制或非本機綁定時，請設定隨機 `DASHBOARD_TOKEN`。

## 監控設定

APR 更新間隔、區間檢查間隔與分數模擬間隔可在中控台分別調整；`.env` 內的值是啟動時的預設值。APR 是池子的近期手續費年化估值，不等於錢包實際收益。

`wallet-active` 會追蹤設定錢包持有的活躍 LP。需要限制池子或幣對時，可用 `allowlist` 或 `symbols`；空白 allowlist 會拒絕啟動，不會自動擴大到所有池子。

## 實盤條件

實盤交易需要專用 canary 錢包、可用 RPC、與私鑰相符的錢包地址、明確開啟實盤寫入、驗證過的原子化防護合約，以及沒有未完成的復原紀錄。請依[檢查清單](LIVE_MODE_CHECKLIST.md)逐階段確認鏈上狀態與餘額。單看中控台顯示程序健康，不足以判定可以啟用無人值守交易。

若資產移動流程在中途失敗，先保持 bot 暫停並檢查復原紀錄，再決定是否恢復。交易收據與錢包實際餘額才是最終依據。

## Windows 本機監督程序（選用）

可選擇安裝目前使用者的工作排程器監督程序：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-dashboard-supervisor.ps1
```

監督程序會檢查本機健康端點，並在程序異常時重新啟動。正式依賴前，請先檢查排程工作與本機 `logs/`。若要停止監督，建立 `state/dashboard-supervisor.stop`，再到工作排程器停止該工作。
