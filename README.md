# Fables LP 監控與自動平衡 Bot

這是一套在本機執行的 Robinhood Chain（chain ID 4663）Fables LP 監控與受安全條件限制的再平衡工具。它會探索 Fables 池子與錢包部位，顯示池級 APR 與帳務估算，並依設定產生區間再平衡計畫。錢包憑證與自訂 RPC 一律留在本機 `.env`。

## 功能

- 探索 Fables 池子，顯示 TVL、24 小時成交量、手續費與估算 APR。
- 監控錢包餘額、LP 區間、手續費與區間外狀態。
- 提供繁體中文本機中控台，查看錢包、池子、部位、帳務與分數估算。
- 使用可取得的官方結算與手續費資料模擬分數。
- 支援選擇性自動平衡，並受 dry-run、簽署器、實盤寫入、防護合約與復原狀態檢查限制。

APR 是根據公開池子統計資料推算的近期年化估值，不代表個人實際報酬。分數模擬也只是估值，可能與下一次官方結算不同。

## 系統需求

- Node.js 20 以上
- Robinhood Chain RPC（`RPC_URLS` 留空時使用程式內建的公開備援端點）
- 要監控的錢包地址

## 快速開始（PowerShell）

```powershell
npm ci
Copy-Item .env.example .env
notepad .env
npm run check
npm test
npm run compile:guard
npm start
```

在 `.env` 設定 `WALLET_ADDRESS`。如要使用代管 RPC，將端點填入 `RPC_URLS`；多個端點以逗號分隔。含有供應商憑證的 URL 只放在本機 `.env`。預設設定為 dry-run，所有實盤寫入功能均關閉。

中控台預設網址為 `http://127.0.0.1:8787`，只綁定本機回環介面。啟用會移動資產的中控台功能，或將中控台綁定到非本機介面前，先設定高強度隨機 `DASHBOARD_TOKEN`。

## 錢包與憑證

- 絕對不要提交 `.env`、錢包私鑰、助記詞、中控台權杖或含供應商憑證的 RPC URL。
- 在中控台匯入錢包時，助記詞只用來推導簽署器，不會被保存。設定 `PERSIST_RUNTIME_CREDENTIALS=true` 後，目前使用的私鑰與驗證通過的 RPC 設定會寫入被 Git 忽略的本機 `.env`。
- 建議使用餘額有限的專用錢包，不要使用存有其他資產的錢包。
- 公開 repo 及其歷史紀錄任何人都看得到；分享前先檢查產生的 log 與匯出檔。

## 實盤安全

實盤交易預設關閉。專案包含交易安全檢查與 EIP-7702 原子化區間外防護流程，但程式碼審查和單元測試不能證明某個錢包、RPC、池子或即時鏈上狀態已可安全實盤。請先閱讀[實盤檢查清單](docs/LIVE_MODE_CHECKLIST.md)，使用獨立 canary 錢包，逐筆確認交易收據，再評估是否啟用無人值守執行。本專案不保證獲利，也不保證避免損失。

## 本機資料

執行狀態、帳本、log 與中控台設定寫入 `data/`、`state/` 和 `logs/`，這些路徑都由 Git 忽略。資料請留在本機；如需備份，也請安全保管。

## 開發檢查

```powershell
npm ci
npm run check
npm test
npm run compile:guard
```

更多說明請見[系統架構](docs/ARCHITECTURE.md)與[操作手冊](docs/OPERATIONS.md)。
