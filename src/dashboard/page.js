export function dashboardPage() {
  return String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Fables LP 部位監控與再平衡中控台</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e9edf5;background:#0a0f18;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:#0a0f18}main{max-width:1640px;margin:auto;padding:20px}
[hidden]{display:none!important}
h1,h2,h3{margin:.2em 0}.top{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}.muted{color:#91a0b8}.small{font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pill{display:inline-flex;align-items:center;padding:5px 9px;border:1px solid #2b3a55;border-radius:999px;font-size:12px;gap:6px}.pill.good{border-color:#23623f}.pill.bad{border-color:#713636}.pill.warn{border-color:#665423}
.grid{display:grid;grid-template-columns:repeat(4,minmax(170px,1fr));gap:12px;margin:16px 0}.card{background:#101827;border:1px solid #24324b;border-radius:14px;padding:14px}.label{font-size:12px;color:#91a0b8}.value{font-size:24px;font-weight:750;margin-top:5px}.good{color:#68d391}.bad{color:#fc8181}.warn{color:#f6c85f}.neutral{color:#d8e1ef}
.row{display:grid;grid-template-columns:1.5fr .5fr;gap:12px}.row-equal{display:grid;grid-template-columns:1fr 1fr;gap:12px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px;border-bottom:1px solid #24324b;white-space:nowrap;vertical-align:middle}th{color:#91a0b8;font-weight:600}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}button,input,select{background:#172235;border:1px solid #354764;color:#eef3fb;border-radius:8px;padding:8px 10px}button{cursor:pointer}button:hover:not(:disabled){background:#1d2d46}button:disabled{opacity:.45;cursor:not-allowed}.danger{border-color:#7b3b3b;background:#2b171d}.primary{border-color:#416188;background:#183050}.execution-button{min-height:56px;min-width:205px;padding:12px 18px;font-size:17px;font-weight:800;border-width:2px}.execution-button.start{background:#153b2a;border-color:#2b8654;color:#dbffe9}.execution-button.pause{background:#3c1d23;border-color:#a34c57;color:#ffe1e4}.execution-button.start:hover:not(:disabled){background:#1b5137}.execution-button.pause:hover:not(:disabled){background:#51252d}.events{max-height:620px;overflow:auto}
.status-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin-top:10px}.status-item{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #1d2a40}.banner{display:none;margin:12px 0;padding:11px 13px;border-radius:10px;border:1px solid #6e5830;background:#261f12}.banner.bad{border-color:#713636;background:#2b171d;color:#ffd7d7}.banner.good{border-color:#23623f;background:#11251a;color:#c9f6d8}.notice{display:none;margin:10px 0;padding:10px 12px;border-radius:9px;background:#11251a;border:1px solid #23623f}.notice.error{background:#2b171d;border-color:#713636;color:#ffd7d7}.action-note{max-width:320px;white-space:normal}.field{display:flex;flex-direction:column;gap:6px;min-width:160px}.field label,.label{font-size:12px;color:#91a0b8}.field input{width:160px}.tab-nav{display:flex;gap:7px;overflow-x:auto;margin:14px 0 8px;padding-bottom:5px;border-bottom:1px solid #24324b}.tab-button{white-space:nowrap;background:#111a29;border-color:#2b3a55}.tab-button.active{background:#21416a;border-color:#6094ca;color:#fff}.tab-panel{display:none}.tab-panel.active{display:block}.section-gap{margin-top:12px}.note-box{padding:10px 12px;border-left:3px solid #416188;background:#0d1624;border-radius:5px;margin:10px 0}.settings-row{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:10px 0}.stats-grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px;margin:12px 0}
@media(max-width:1100px){.grid,.stats-grid{grid-template-columns:repeat(2,1fr)}.row,.row-equal{grid-template-columns:1fr}}@media(max-width:620px){.grid,.stats-grid{grid-template-columns:1fr}.status-list{grid-template-columns:1fr}main{padding:12px}}
:root{color:#f5f6f0;background:#0c0d0b;color-scheme:dark;--accent:#d7f920;--surface:#181a16;--border:#30342a;--subtle:#a5ab9b}
body{background:radial-gradient(circle at 5% 0%,#1b2114 0,#0c0d0b 34%);color:#f5f6f0}main{max-width:1280px;padding:28px 24px 60px}
.brand h1{font-size:29px;letter-spacing:-.04em}.brand .muted{margin-top:5px}.muted,.label,th{color:var(--subtle)}
.card{background:var(--surface);border-color:var(--border);border-radius:18px;padding:20px}.card h2{font-size:18px;margin-bottom:12px}.value{font-size:27px;letter-spacing:-.03em}
.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:center;background:linear-gradient(130deg,#20271a,#151813 68%);border:1px solid #465337;border-radius:24px;padding:27px;margin:20px 0 14px}
.hero h2{font-size:32px;letter-spacing:-.04em;margin:3px 0 8px}.hero-kicker{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.hero-meta{display:flex;gap:9px;flex-wrap:wrap;margin-top:15px}.hero-meta span{border:1px solid #3c4632;border-radius:999px;padding:7px 11px;font-size:13px;color:#dce7d3}.hero-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;max-width:455px}
button,input,select{background:#20231d;border-color:#444a3d;color:#f5f6f0;border-radius:11px}button:hover:not(:disabled){background:#333b2b}.primary,.execution-button.start{background:var(--accent);color:#15180b;border-color:var(--accent)}.execution-button.start:hover:not(:disabled){background:#e5ff63}.execution-button.pause{background:#2c211f;border-color:#6a4440;color:#ffe5de}.execution-button{min-width:185px;min-height:56px}.hero-actions #scan{width:100%;min-height:38px}
.tab-nav{border-color:var(--border);gap:5px;margin:20px 0 18px}.tab-button{background:transparent;border-color:transparent;color:#a5ab9b}.tab-button.active{background:#2d381d;border-color:#718c30;color:var(--accent)}.tab-panel>.card,.tab-panel>.row-equal>.card{margin-top:12px}.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.grid .card{min-height:118px}.note-box{border-left-color:var(--accent);background:#1c2117}.status-item,th,td{border-bottom-color:var(--border)}.status-item{gap:16px}.detail-toggle{margin:14px 0}.detail-toggle>summary{cursor:pointer;color:var(--subtle);padding:10px 0}.detail-toggle[open]>summary{color:var(--accent)}.pill{border-color:#454b3b}.pill.good{color:var(--accent)}.good{color:#a6ed9b}.warn{color:#f2d286}
@media(max-width:900px){.hero{grid-template-columns:1fr}.hero-actions{justify-content:flex-start;max-width:none}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:620px){main{padding:17px 13px 40px}.brand h1{font-size:23px}.hero{padding:20px}.hero h2{font-size:27px}.hero-actions{display:grid;grid-template-columns:1fr 1fr}.hero-actions .execution-button{min-width:0;font-size:15px}.hero-actions #scan{grid-column:1/-1}.grid{grid-template-columns:1fr 1fr}.grid .card{padding:15px}.grid .value{font-size:21px}.status-list{grid-template-columns:1fr}}
</style>
</head>
<body><main>
<header class="top">
  <div class="brand"><h1>Fables LP 中控台</h1><div class="muted small">Robinhood Chain · 最近更新 <span id="updated">載入中</span></div></div>
  <div class="controls"><span class="pill" id="mode">--</span><button id="refresh" aria-label="重新整理資料">重新整理</button></div>
</header>
<section id="authPanel" class="card section-gap" style="display:none"><h2>解鎖本機中控台</h2><p class="muted small">實盤控制權杖儲存在本機 <code>.env</code> 的 <code>DASHBOARD_TOKEN</code>。貼上一次後，這個瀏覽器分頁會記住。</p><div class="controls"><label class="field"><span>中控台權杖</span><input id="dashboardTokenInput" type="password" autocomplete="off" placeholder="貼上 DASHBOARD_TOKEN"/></label><button id="saveDashboardToken" class="primary">解鎖中控台</button></div></section>
<section class="hero" aria-label="指定池子與執行控制">
  <div><div class="hero-kicker">目前專注的池子</div><h2 id="focusPair">尚未指定池子</h2><div class="muted" id="focusSummary">正在讀取鏈上狀態…</div><div class="hero-meta"><span id="focusRange">Tight 區間 · --</span><span id="focusApr">池級 APR --</span><span id="focusWallet">錢包 --</span></div></div>
  <div class="hero-actions"><button id="startExecution" class="execution-button start" disabled>啟動自動平衡</button><button id="pauseExecution" class="execution-button pause" disabled>暫停自動平衡</button><button id="scan" disabled>立即掃描 · 不交易</button></div>
</section>
<span id="armed" hidden>--</span>
<div id="startReadiness" class="note-box small muted" role="status">正在檢查啟動條件…</div>
<div id="liveBanner" class="banner"></div>
<nav class="tab-nav" role="tablist" aria-label="中控台功能分頁">
  <button class="tab-button active" role="tab" aria-selected="true" data-tab="overview">總覽</button>
  <button class="tab-button" role="tab" aria-selected="false" data-tab="wallet">錢包與 RPC</button>
  <button class="tab-button" role="tab" aria-selected="false" data-tab="pools">池子監控與 APR</button>
  <button class="tab-button" role="tab" aria-selected="false" data-tab="positions">LP 部位與區間檢查</button>
  <button class="tab-button" role="tab" aria-selected="false" data-tab="points">分數即時模擬</button>
  <button class="tab-button" role="tab" aria-selected="false" data-tab="ledger">帳務與事件紀錄</button>
</nav>
<div id="notice" class="notice" role="status"></div>

<section class="tab-panel active" id="panel-overview" data-panel="overview" role="tabpanel">
  <div class="grid">
    <div class="card"><div class="label">追蹤資產價值</div><div class="value" id="valueUsd">--</div><div class="small muted" id="hodl">持有基準 --</div></div>
    <div class="card"><div class="label">目前 LP 部位</div><div class="value" id="rangeCount">--</div><div class="small muted" id="oorCount">--</div></div>
    <div class="card"><div class="label">執行狀態</div><div class="value" id="execution">--</div><div class="small muted" id="lastAction">尚無執行紀錄</div></div>
    <div class="card"><div class="label">LP 手續費</div><div class="value" id="fees">--</div><div class="small muted" id="gas">鏈上手續費 --</div></div>
  </div>
  <details class="detail-toggle"><summary>查看損益與安全細節</summary>
  <div class="grid">
    <div class="card"><div class="label">淨損益</div><div class="value" id="netPnl">--</div><div class="small muted" id="excess">相對持有基準 --</div></div>
    <div class="card"><div class="label">無常損失</div><div class="value" id="il">--</div><div class="small muted">相對部位起始基準</div></div>
    <div class="card"><div class="label">原子化安全防護</div><div class="value" id="guard">--</div><div class="small muted mono" id="guardAddr">--</div></div>
    <div class="card"><div class="label">復原狀態</div><div class="value" id="recovery">--</div><div class="small muted" id="recoveryDetail">--</div></div>
  </div>
  <div class="row-equal">
    <section class="card"><h2>部署與安全閘門</h2><div class="status-list">
      <div class="status-item"><span class="muted">簽署錢包</span><strong id="signer">--</strong></div>
      <div class="status-item"><span class="muted">鏈上寫入</span><strong id="liveWrites">--</strong></div>
      <div class="status-item"><span class="muted">自動重新部署</span><strong id="autoRedeploy">--</strong></div>
      <div class="status-item"><span class="muted">人工控制</span><strong id="manualControl">--</strong></div>
      <div class="status-item"><span class="muted">安全防護設定</span><strong id="guardFlag">--</strong></div>
      <div class="status-item"><span class="muted">安全防護狀態</span><strong id="guardRuntime">--</strong></div>
      <div class="status-item"><span class="muted">RPC 健康狀態</span><strong id="rpc">--</strong></div>
      <div class="status-item"><span class="muted">目前區塊</span><strong id="block">--</strong></div>
    </div></section>
    <section class="card"><h2>區間策略與執行限制</h2><div class="status-list">
      <div class="status-item"><span class="muted">區間內絕對保留</span><strong class="good">啟用</strong></div>
      <div class="status-item"><span class="muted">區間檢查週期</span><strong id="policyScan">--</strong></div>
      <div class="status-item"><span class="muted">深度區間外門檻</span><strong id="policyDeep">--</strong></div>
      <div class="status-item"><span class="muted">淺度區間外最長等待</span><strong id="policyWait">--</strong></div>
      <div class="status-item"><span class="muted">深度確認次數</span><strong id="policyConfirm">--</strong></div>
      <div class="status-item"><span class="muted">目標區間寬度</span><strong id="policyWidth">--</strong></div>
      <div class="status-item"><span class="muted">提領／兌換／存入滑價</span><strong id="slippage">--</strong></div>
      <div class="status-item"><span class="muted">最高 Gas 價格</span><strong id="maxGas">--</strong></div>
    </div></section>
  </div>
  <div class="note-box small muted">中控台僅綁定本機回環網路。啟用本機憑證保存後，通過驗證的 RPC 網址與目前簽署錢包會寫入 Git 忽略且限制 ACL 的 <code>.env</code>；匯入錢包仍會強制預演並暫停執行。助記詞不會寫入檔案，只保存推導出的私鑰。</div>
  </details>
</section>

<section class="tab-panel" id="panel-wallet" data-panel="wallet" role="tabpanel">
  <section class="card">
    <h2>錢包管理</h2><p class="muted small">可匯入助記詞、私鑰或唯讀地址。匯入後立即切換成目前監控錢包，並強制預演／暫停。啟用本機憑證保存時，簽署私鑰與地址會寫入受 ACL 保護的 <code>.env</code>，重啟後沿用；助記詞本身不保存。</p>
    <div class="row-equal">
      <div>
        <div class="label">目前監控地址</div><div class="mono" id="activeWallet">--</div><div class="small muted" id="walletStatus">--</div>
        <div class="controls section-gap"><label class="field"><span>匯入類型</span><select id="walletType" aria-label="錢包匯入類型"><option value="mnemonic">助記詞</option><option value="private-key">私鑰</option><option value="watch-only">唯讀地址</option></select></label>
          <label class="field" style="flex:1"><span>錢包資料</span><input id="walletSecret" type="password" autocomplete="off" spellcheck="false" placeholder="在此輸入助記詞、私鑰或地址"/></label><button id="mountWallet" class="primary">新增並掛載</button></div>
        <div class="small muted section-gap">助記詞使用 EVM 預設路徑 m/44'/60'/0'/0/0。若錢包採用其他推導路徑，請匯入對應私鑰。</div>
        <div class="controls section-gap"><label class="field" style="flex:1"><span>本次程序已掛載的錢包</span><select id="walletProfile" aria-label="已掛載錢包"></select></label><button id="selectWallet">切換監控錢包</button></div>
      </div>
      <div>
        <h3>Robinhood Chain RPC</h3><div class="small muted" id="rpcStatus">--</div>
        <div class="controls section-gap"><label class="field" style="flex:1"><span>自訂 RPC 網址</span><input id="rpcEndpoint" type="password" autocomplete="off" spellcheck="false" placeholder="輸入 Robinhood Chain RPC 網址"/></label><button id="saveRpc" class="primary">驗證並套用</button></div>
        <div class="note-box small muted">系統會實際查詢 eth_chainId，確認為 4663 後才套用；官方 RPC 會保留作讀取備援。啟用本機憑證保存時，驗證成功的網址會寫入受 ACL 保護的 <code>.env</code>，不會由 API 回傳。</div>
      </div>
    </div>
  </section>
</section>

<section class="tab-panel" id="panel-pools" data-panel="pools" role="tabpanel">
  <section class="card">
    <div class="top"><div><h2>Fables 池子監控</h2><div class="muted small">APR 以 Fables 公開的 24 小時手續費年化估算：24 小時手續費 × 365 ÷ 目前 TVL。這是池級估算，不等於個人實際收益。</div></div><div class="small muted" id="marketStatsSource">統計來源尚未更新</div></div>
    <div class="settings-row"><label class="field"><span>APR 與池資料更新間隔（秒）</span><input id="aprIntervalSeconds" type="number" min="15" max="3600" step="1"/></label><button id="saveAprInterval" class="primary">儲存 APR 更新間隔</button><span class="small muted">可設定 15 至 3,600 秒；設定會保存在本機並套用於所有錢包。</span></div>
    <div class="settings-row"><label class="field" style="flex:1;max-width:440px"><span>搜尋池子（交易對、代幣或池子地址）</span><input id="poolSearch" type="search" autocomplete="off" placeholder="例如：MOO、USDG 或池子地址"/></label><span id="poolSearchSummary" class="small muted">依 APR 由高至低排序</span></div>
    <div class="note-box small muted" id="executionTargetStatus">尚未指定自動平衡目標池。選定目標只會限定部位監控範圍，不會解除暫停或送出交易。</div>
    <div class="table-wrap"><table><thead><tr><th>交易池</th><th>池級 APR</th><th>TVL</th><th>監控</th><th>執行目標</th></tr></thead><tbody id="markets"></tbody></table></div>
  </section>
</section>

<section class="tab-panel" id="panel-positions" data-panel="positions" role="tabpanel">
  <section class="card">
    <div class="top"><div><h2>LP 部位與區間檢查</h2><div class="muted small">區間內部位一律保留；再平衡資格仍受既有區間外政策、安全閘門與暫停狀態限制。</div></div></div>
    <div class="settings-row"><label class="field"><span>區間檢查間隔（秒）</span><input id="rangeIntervalSeconds" type="number" min="30" max="86400" step="1"/></label><button id="saveRangeInterval" class="primary">儲存區間檢查間隔</button><span class="small muted">可設定 30 至 86,400 秒；此設定影響部位政策評估頻率。</span></div>
    <div class="table-wrap"><table><thead><tr><th>交易池</th><th>區間狀態</th><th>目前 Tick／部位區間</th><th>超出幅度</th><th>區間外時間</th><th>深度確認</th><th>再平衡資格</th><th>目標區間</th><th>價值／未領手續費</th><th>操作</th></tr></thead><tbody id="positions"></tbody></table></div>
  </section>
</section>

<section class="tab-panel" id="panel-points" data-panel="points" role="tabpanel">
  <section class="card">
    <div class="top"><div><h2>Fables 分數對帳與估算</h2><div class="muted small">官方已結算分數為基準；待結算分數依錢包實際 LP 費用與上次結算倍率推估，隔日全市場交易量會影響結果。</div></div><div class="small muted" id="pointsSchedule">尚無模擬紀錄</div></div>
    <div class="stats-grid">
      <div class="card"><div class="label">推估總分</div><div class="value" id="pointsTotal">--</div></div>
      <div class="card"><div class="label">官方已結算</div><div class="value" id="pointsBaseline">--</div></div>
      <div class="card"><div class="label">待結算估算</div><div class="value" id="pointsDelta">--</div></div>
      <div class="card"><div class="label">費用觀測時間</div><div class="value small" id="pointsSimulatedAt">--</div></div>
    </div>
    <p class="muted small" id="pointsEvidence">正在取得錢包費用與官方結算資料。</p>
    <div class="settings-row"><label class="field"><span>分數即時模擬間隔（秒）</span><input id="pointsIntervalSeconds" type="number" min="5" max="3600" step="1"/></label><button id="savePointsInterval" class="primary">儲存分數模擬間隔</button><span class="small muted">可設定 5 至 3,600 秒；此模擬會獨立排程，不受鏈上掃描週期限制。</span></div>
    <div class="controls section-gap"><label class="field"><span>手動備援分數（官方資料無法取得時）</span><input id="actualPoints" type="number" min="0" step="any" placeholder="輸入已確認分數"/></label><button id="savePoints" class="primary">儲存備援分數</button></div>
    <h3 class="section-gap">計畫日紀錄（台灣時間 10:00 換日）</h3>
    <div class="table-wrap"><table><thead><tr><th>計畫日（UTC）</th><th>狀態</th><th>個人費用</th><th>分數</th></tr></thead><tbody id="pointBuckets"></tbody></table></div>
  </section>
</section>

<section class="tab-panel" id="panel-ledger" data-panel="ledger" role="tabpanel">
  <section class="card">
    <h2>手動帳務調整</h2><p class="muted small">存入／提領現金流只影響本機帳務，不會送出鏈上交易。</p>
    <div class="controls"><label class="field"><span>金額（美元）</span><input id="cashflow" type="number" step="any" placeholder="存入填正數，提領填負數"/></label><label class="field" style="flex:1"><span>備註</span><input id="cashflowNote" placeholder="輸入調整原因"/></label><button id="addCashflow" class="primary">新增帳務調整</button></div>
  </section>
  <section class="card section-gap"><h2>交易與帳務事件紀錄</h2><div class="events table-wrap"><table><thead><tr><th>時間</th><th>事件</th><th>交易雜湊</th><th>Gas（美元）</th><th>手續費（美元）</th><th>說明</th></tr></thead><tbody id="events"></tbody></table></div></section>
</section>

<script>
const $=id=>document.getElementById(id);
let snapshot=null,control=null,busy=false,noticeTimer=null;
let dashboardToken=sessionStorage.getItem('dashboardToken')||'';
const validTabs=['overview','wallet','pools','positions','points','ledger'];
const tabNames={overview:'總覽',wallet:'錢包與 RPC',pools:'池子監控與 APR',positions:'LP 部位與區間檢查',points:'分數即時模擬',ledger:'帳務與事件紀錄'};
const eventNames={
  'portfolio.snapshot':'資產組合快照','portfolio.baseline_created':'建立資產基準','points.actual_baseline':'更新實際分數基準',
  'execution.control':'執行暫停狀態','cashflow.adjustment':'手動帳務調整','fee.accrual':'個人手續費累計','fee.owed_decrease':'未領手續費減少',
  'pool.fee':'池子手續費紀錄','pool.fee_unattributed':'未歸屬池子的手續費','lp.deposit':'LP 存入','lp.withdraw':'LP 提領',
  'wallet.lp_topology_changed':'錢包 LP 部位變更','rebalance.manual_requested':'要求人工再平衡','rebalance.dry_run':'再平衡預演',
  'rebalance.blocked':'再平衡遭安全條件阻擋','rebalance.failed':'再平衡失敗','rebalance.uncommitted':'再平衡尚未完成',
  'rebalance.completed':'再平衡完成','rebalance.recovery_required':'需要人工復原','rebalance.auto_paused':'復原狀態自動暫停',
  'bootstrap.completed':'首次 Tight LP 已建立','bootstrap.recovery_required':'首次建倉需要復原',
  'tx.sent':'交易已送出','tx.confirmed':'交易已確認','cycle.failed':'監控週期失敗'
};
const errorNames={
  unauthorized:'請輸入有效的中控台權杖。','same-origin request required':'來源驗證失敗，請從本機中控台操作。',
  'monitoring/execution cycle is already running':'目前正在掃描，請稍後再試。',
  'Wait for the current monitor cycle before changing RPC':'目前掃描尚未完成，請稍後再套用 RPC。',
  'Wait for the current monitor cycle before mounting another wallet':'目前掃描尚未完成，請稍後再掛載錢包。',
  'Wait for the current monitor cycle before switching wallets':'目前掃描尚未完成，請稍後再切換錢包。',
  'Wallet is not mounted in this session':'此錢包尚未在本次程序中掛載。',
  'Cannot resume while rebalance execution requires review: recovery_required':'再平衡仍需要人工復原，完成檢查後才能解除暫停。',
  oor_max_wait_expired:'已達區間外最長等待時間',deep_oor_confirmed:'深度區間外已確認',
  'Wallet input did not validate; nothing was mounted':'錢包資料驗證失敗，未掛載任何錢包。',
  '尚未設定有效的監控錢包地址':'尚未設定有效的監控錢包地址。請匯入測試錢包或填入非零地址。',
  'Zero address cannot be used as a monitoring wallet':'零地址不能作為監控錢包。',
  'RPC endpoint is too long':'RPC 網址長度超過允許上限。',
  'Resolve the active wallet recovery journal before switching wallets':'目前錢包仍有待處理的復原紀錄，完成檢查後才能切換。',
  'Wallet address did not validate':'錢包地址格式無效。',
  'address mismatch':'錢包地址與簽署金鑰不一致。',
  'Wallet signer did not validate for this address':'簽署金鑰與錢包地址驗證失敗。',
  'Invalid pool ID':'交易池識別碼格式無效。',
  'Pool is not present in the current Fables registry':'此交易池不在目前的 Fables 清單中。',
  'Invalid poolId':'交易池識別碼格式無效。',
  'Invalid positionId':'LP 部位識別碼格式無效。',
  'A monitoring/execution cycle is already running':'目前已有監控或執行流程進行中。',
  'Execution is paused; resume before manual rebalance':'執行已暫停，解除暫停後才能進行人工再平衡。',
  'Monitoring cycle did not release execution lock':'監控流程尚未釋放執行鎖定，請稍後再試。',
  'Requested pool is not an active wallet LP pool':'指定交易池不是此錢包目前的活躍 LP 池。',
  'Requested LP position is not active after fresh chain scan':'重新掃描鏈上資料後，找不到指定的有效 LP 部位。',
  'Absolute in-range hold: manual withdrawal is forbidden while LP is in range':'部位仍在區間內；安全政策禁止提領。',
  'Position is OOR but has not satisfied the configured rebalance policy yet':'部位雖已區間外，但尚未符合再平衡政策。',
  'Wallet LP topology changed during manual preflight':'人工操作預檢期間偵測到錢包 LP 結構變更，已停止操作。',
  'position-not-oor-eligible':'部位尚未符合區間外再平衡資格。',
  'latest-chain-state-not-eligible':'最新鏈上狀態不符合再平衡資格。',
  'wallet-topology-cooldown':'錢包 LP 結構變更後仍在冷卻期間。',
  'execution-paused':'執行目前已暫停。',
  '啟動條件尚未完成，請查看控制台提示。':'啟動條件尚未完成，請查看頁面上方的啟動提示。',
  'global-min-rebalance-interval':'尚未達到兩次再平衡的最短間隔。',
  'hourly-rate-limit':'已達每小時再平衡次數上限。',
  'RPC endpoint did not verify as Robinhood Chain (chain ID 4663)':'RPC 驗證失敗：回應的鏈 ID 不是 4663。',
  'Enter a valid Robinhood Chain RPC URL':'請輸入有效的 Robinhood Chain RPC 網址。',
  'RPC must use HTTP(S) and must not include URL username or password':'RPC 必須使用 HTTP 或 HTTPS，且網址不得包含使用者名稱或密碼。'
};
const usd=v=>v==null||!Number.isFinite(Number(v))?'--':'$'+Number(v).toLocaleString('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2});
const num=v=>v==null||!Number.isFinite(Number(v))?'--':Number(v).toLocaleString('zh-TW',{maximumFractionDigits:4});
const pct=v=>v==null||!Number.isFinite(Number(v))?'--':Number(v).toLocaleString('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2})+'%';
const short=v=>v?v.slice(0,8)+'…'+v.slice(-6):'';
const yesNo=v=>v?'<span class="good">是</span>':'<span class="bad">否</span>';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function dt(ms){if(!ms)return'--';return new Intl.DateTimeFormat('zh-TW',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Taipei'}).format(new Date(ms))}
function durationMin(v){const n=Number(v||0);if(n<1)return n>0?Math.round(n*60)+' 秒':'0 分鐘';if(n<120)return Math.round(n)+' 分鐘';return(n/60).toFixed(1)+' 小時'}
function translateError(message){const text=String(message||'');if(errorNames[text])return errorNames[text];if(text.startsWith('Cannot resume while rebalance execution requires review:'))return'再平衡仍需要檢查或復原，完成處理後才能解除暫停。';if(text==='Failed to fetch'||text==='NetworkError when attempting to fetch resource.')return'無法連線到本機中控台，請確認服務仍在執行。';return text?'操作失敗；請檢查本機執行紀錄中的技術細節。':'操作失敗，請稍後再試。'}
function showNotice(message,isError=false){const el=$('notice');el.textContent=message;el.className='notice'+(isError?' error':'');el.style.display='block';clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{el.style.display='none'},7000)}
async function api(path,opts){opts=opts||{};opts.headers=Object.assign({},opts.headers||{},dashboardToken?{'authorization':'Bearer '+dashboardToken}:{});let response;try{response=await fetch(path,opts)}catch(error){throw new Error(translateError(error.message))}const text=await response.text();let body={};try{body=text?JSON.parse(text):{}}catch{body={error:text}}if(!response.ok)throw new Error(translateError(body.error||text||('HTTP '+response.status)));return body}
function formatInterval(ms){return Math.max(1,Math.round(Number(ms||0)/1000))+' 秒'}
function setTab(name,updateHash=true){if(!validTabs.includes(name))name='overview';document.querySelectorAll('[data-panel]').forEach(el=>el.classList.toggle('active',el.dataset.panel===name));document.querySelectorAll('.tab-button').forEach(el=>{const active=el.dataset.tab===name;el.classList.toggle('active',active);el.setAttribute('aria-selected',String(active))});sessionStorage.setItem('activeDashboardTab',name);if(updateHash&&location.hash!=='#'+name)history.replaceState(null,'','#'+name)}
document.querySelectorAll('.tab-button').forEach(el=>el.addEventListener('click',()=>setTab(el.dataset.tab)));
window.addEventListener('hashchange',()=>setTab(location.hash.slice(1),false));
setTab(location.hash.slice(1)||sessionStorage.getItem('activeDashboardTab')||'overview',false);
function setBusy(value){busy=value;['scan','startExecution','pauseExecution','refresh','mountWallet','saveRpc','saveAprInterval','saveRangeInterval','savePointsInterval','savePoints','addCashflow'].forEach(id=>{const el=$(id);if(el)el.disabled=value});if(!value&&control){$('startExecution').disabled=!control.executionPaused||!(control.startReadiness&&control.startReadiness.ready);$('pauseExecution').disabled=control.executionPaused}$('selectWallet').disabled=value||((control&&control.walletProfiles)||[]).length<2;document.querySelectorAll('button[data-watch-id],button[data-target-id],button[data-action]').forEach(el=>{el.disabled=value||el.dataset.ineligible==='true'})}
function actionState(position){
  if(!position.outside)return{disabled:true,label:'區間內，保留部位',note:'區間內不提領'};
  if(!position.shouldRebalance)return{disabled:true,label:'等待策略確認',note:position.rebalanceReason||'尚未符合再平衡條件'};
  if(!control||!control.manualControlEnabled)return{disabled:true,label:'人工控制未啟用',note:'需先完成安全設定'};
  if(control.executionPaused)return{disabled:true,label:'執行已暫停',note:'解除暫停後才能操作'};
  if(control.recoveryRequired)return{disabled:true,label:'復原鎖定',note:'請先檢查復原狀態'};
  if(control.cycleActive||control.executionBusy)return{disabled:true,label:'流程進行中',note:'請等待目前流程與交易紀錄完成'};
  if(!control.dryRun&&!control.liveReady)return{disabled:true,label:'安全閘門未就緒',note:'簽署錢包、即時寫入或安全防護尚未就緒'};
  return{disabled:false,label:control.dryRun?'執行預演':'人工再平衡',note:control.dryRun?'不會移動資產':'符合所有條件時會送出鏈上交易'};
}
function positionRow(x){
  const action=actionState(x),status=x.outside?'<span class="bad">區間外</span>':'<span class="good">區間內</span>';
  const eligibility=x.shouldRebalance?'<span class="warn">符合條件</span>':(x.outside?'<span class="neutral">等待確認</span>':'<span class="good">保留部位</span>');
  const target=x.target?x.target.tickLower+' … '+x.target.tickUpper:'--';
  const button='<button '+(action.disabled?'disabled ':'')+'data-action="rebalance" data-ineligible="'+action.disabled+'" data-pool="'+esc(x.poolId)+'" data-pos="'+esc(x.id)+'" data-pair="'+esc(x.pair)+'">'+esc(action.label)+'</button><div class="small muted action-note">'+esc(action.note)+'</div>';
  return'<tr><td>'+esc(x.pair)+'</td><td>'+status+'</td><td>'+esc(x.currentTick)+'<div class="small muted">'+esc(x.tickLower)+' … '+esc(x.tickUpper)+'</div></td><td>'+pct(x.excursionPct)+'</td><td>'+durationMin(x.outOfRangeElapsedMin)+'</td><td>'+esc(x.deepConfirmations)+'</td><td>'+eligibility+'<div class="small muted">'+esc(translateError(x.rebalanceReason||''))+'</div></td><td>'+esc(target)+'</td><td>'+usd(x.principalUsd)+'<div class="small muted">未領手續費 '+usd(x.unclaimedFeeUsd)+'</div></td><td>'+button+'</td></tr>';
}
function marketRow(x){const watchButton='<button data-watch-id="'+esc(x.id)+'" data-watch-next="'+(!x.watched)+'">'+(x.watched?'取消監控':'監控')+'</button>';const selected=String(control&&control.selectedExecutionTargetPoolId||'').toLowerCase()===String(x.id||'').toLowerCase();const targetButton='<button '+(selected?'class="primary" ':'')+'data-target-id="'+(selected?'':esc(x.id))+'">'+(selected?'已選定 · 清除':'選定')+'</button>';return'<tr><td><strong>'+esc(x.pair)+'</strong><div class="small muted mono">'+esc(short(x.id))+(x.paused?' · 池子暫停':'')+'</div></td><td title="24 小時手續費 × 365 ÷ 目前 TVL"><strong>'+pct(x.aprPct)+'</strong></td><td>'+usd(x.tvlUsd)+'</td><td>'+watchButton+'</td><td>'+targetButton+'</td></tr>'}
function renderMarkets(markets){const all=Array.isArray(markets)?markets:[];const query=($('poolSearch').value||'').trim().toLowerCase();const filtered=all.filter(pool=>!query||[pool.pair,pool.token0,pool.token1,pool.id].some(value=>String(value||'').toLowerCase().includes(query)));const aprValue=pool=>pool.aprPct==null||pool.aprPct===''||!Number.isFinite(Number(pool.aprPct))?null:Number(pool.aprPct);filtered.sort((a,b)=>{const aApr=aprValue(a),bApr=aprValue(b);if(aApr==null&&bApr!=null)return 1;if(bApr==null&&aApr!=null)return-1;if(aApr!=null&&bApr!=null&&aApr!==bApr)return bApr-aApr;return String(a.pair||'').localeCompare(String(b.pair||''),'zh-Hant')});$('markets').innerHTML=filtered.map(marketRow).join('')||'<tr><td colspan="5" class="muted">'+(query?'沒有符合搜尋條件的池子。':'等待 Fables 池子資料')+'</td></tr>';$('poolSearchSummary').textContent='依 APR 由高至低 · 顯示 '+filtered.length+' / '+all.length+' 個池子'}
function renderFocus(state,ctl){const targetId=String(ctl.selectedExecutionTargetPoolId||'').toLowerCase();const market=(state.markets||[]).find(x=>String(x.id||'').toLowerCase()===targetId);const activePool=(state.pools||[]).find(x=>String(x.id||'').toLowerCase()===targetId);const position=(activePool?.positions||[]).find(x=>Number(x.shares)>0);$('focusPair').textContent=market?market.pair==='USDG/MOO'?'MOO / USDG':market.pair:'尚未指定池子';$('focusApr').textContent='池級 APR '+pct(market?.aprPct);$('focusWallet').textContent='錢包 '+short(ctl.walletAddress||'');$('focusRange').textContent=position?'Tight · Tick '+position.tickLower+'–'+position.tickUpper:'Tight · 尚無 LP 部位';$('focusSummary').textContent=!market?'請到「池子」分頁選定 MOO / USDG。':!position?'目前尚未持有此池子的 LP；建立 Tight 部位後才能啟動實盤。':position.outside?'部位已在區間外，等待再平衡政策與安全檢查。':'部位在區間內，持續監控且不會提領。'}
function renderExecutionTargetStatus(markets){const el=$('executionTargetStatus');if(!el||!control)return;const targetId=String(control.selectedExecutionTargetPoolId||'').toLowerCase();if(!targetId){el.textContent='尚未指定自動平衡目標池。選定目標只會限定部位監控範圍，不會解除暫停或送出交易。';return}const target=(markets||[]).find(pool=>String(pool.id||'').toLowerCase()===targetId);const label=target?target.pair:short(targetId);const scan=(control.walletImportState||{}).status;let message='目前自動平衡目標：'+label+'。';if(scan==='ready')message+='錢包初次掃描完成。';else if(scan==='failed')message+='錢包初次掃描失敗，尚未就緒。';else if(scan==='scanning')message+='錢包正在掃描。';else message+='請先完成錢包掃描。';if(control.dryRun)message+='目前為預演模式。';if(control.executionPaused)message+='執行已暫停。';if(!control.liveReady)message+='實盤安全閘門尚未就緒。';el.textContent=message}
const startBlockerNames={'target-required':'尚未選擇自動平衡目標池','target-unavailable':'目標池不在最新池子清單','wallet-address-missing':'尚未掛載有效錢包地址','wallet-scanning':'錢包初次掃描尚未完成','wallet-failed':'錢包掃描失敗，請先重新掃描','wallet-not-ready':'錢包監控尚未就緒','active-lp-required':'此錢包尚無指定池子的 LP 部位','wallet-snapshot-stale':'錢包掃描資料過舊','rpc-not-ready':'沒有健康的 Robinhood Chain RPC','cycle-active':'目前有掃描週期進行中','recovery-required':'有尚待處理的交易復原流程','execution-busy':'目前有執行中的交易流程','live-writes-disabled':'實盤鏈上寫入尚未啟用','auto-redeploy-disabled':'自動重新部署尚未啟用','signer-required':'尚未掛載簽署錢包','guard-not-ready':'原子化安全防護尚未部署並驗證'};
function renderStartReadiness(){const el=$('startReadiness');if(!el||!control)return;if(!control.executionPaused&&!control.recoveryRequired){el.textContent=(control.dryRun?'預演監控中':'實盤監控中')+' · '+(control.cycleActive?'正在更新鏈上資料；':'')+'區間內保留部位，達到區間外政策時才會再平衡。';el.className='note-box small muted';return}const readiness=control.startReadiness||{ready:false,blockers:['wallet-not-ready']};const labels=(readiness.blockers||[]).map(key=>startBlockerNames[key]||key);if(readiness.ready){el.textContent='啟動條件已通過。按下「啟動自動平衡」才會解除暫停；目前 '+(control.dryRun?'為預演模式，不會送出交易。':'為實盤模式，可能送出真實鏈上交易。');el.className='note-box small muted';return}el.textContent='尚未符合啟動條件：'+labels.join('；')+'。';el.className='note-box small muted'}
function pointBucketRow(key,x){return'<tr><td>'+esc(key)+'</td><td>'+(x.source==='official'?'官方結算':'待結算推估')+'</td><td>'+usd(x.userFeeUsd)+'</td><td>'+num(x.source==='official'?x.actualPoints:x.estimatedPoints)+'</td></tr>'}
function eventDetail(e){
  if(e.type==='portfolio.snapshot')return'淨損益 '+usd(e.netPnlUsd)+' · 無常損失 '+usd(e.ilUsd)+' · 模擬積分 '+num(e.estimatedPoints);
  if(e.type==='wallet.lp_topology_changed')return'新增池 '+(e.added||[]).length+' 個／移除 '+(e.removed||[]).length+' 個 · 區間新增 '+(e.addedRanges||[]).length+' 個／移除 '+(e.removedRanges||[]).length+' 個';
  if(e.type==='rebalance.manual_requested')return'人工操作 · '+(e.pair||'')+(e.dryRun?' · 預演':' · 即時交易');
  if(e.type==='rebalance.recovery_required')return'需要人工復原 · '+translateError(e.error||'');
  if(e.type==='rebalance.blocked')return'安全條件阻擋 · '+translateError(e.reason||'');
  if(e.type==='pool.fee_unattributed')return'共用 Hook，無法歸屬到單一交易池';
  const value=e.note||e.label||e.pair||e.reason||e.status||e.error||e.eventKey||'';
  return translateError(value);
}
function eventRow(e){return'<tr><td>'+dt(e.ts)+'</td><td>'+esc(eventNames[e.type]||'其他事件')+'</td><td class="mono">'+(e.hash?esc(short(e.hash)):'')+'</td><td>'+(e.gasUsd!=null?usd(e.gasUsd):'')+'</td><td>'+(e.feeUsd!=null?usd(e.feeUsd):'')+'</td><td class="small">'+esc(eventDetail(e))+'</td></tr>'}
function renderWallet(){if(!control)return;$('activeWallet').textContent=control.walletAddress||'--';const wi=control.walletImportState||{};const walletStates={ready:'監控就緒',scanning:'初次掃描中',failed:'掃描失敗'};const signer=control.signerConfigured?'簽署金鑰已掛載':'唯讀，未載入簽署金鑰';const persistence=control.credentialPersistenceEnabled?'本機 .env 保存已啟用':'只保留於本次程序';$('walletStatus').textContent=(walletStates[wi.status]||'狀態未知')+(wi.error?' · '+translateError(wi.error):'')+' · '+signer+' · '+persistence;$('rpcStatus').textContent=(control.rpc&&control.rpc.customConfigured?'自訂 RPC':'官方公開 RPC')+' · '+((control.rpc&&control.rpc.endpointCount)||1)+' 個端點 · 鏈 ID '+((control.rpc&&control.rpc.chainId)||4663);const select=$('walletProfile');const profiles=control.walletProfiles||[];const typeNames={mnemonic:'助記詞', 'private-key':'私鑰','watch-only':'唯讀地址',environment:'環境設定'};select.innerHTML=profiles.map(x=>'<option value="'+esc(x.address)+'" '+(x.active?'selected':'')+'>'+esc(x.address)+' · '+(typeNames[x.type]||'錢包')+(x.signerConfigured?' · 可簽署':' · 唯讀')+'</option>').join('');$('selectWallet').disabled=profiles.length<2||busy}
function renderIntervals(){if(!control)return;const values=control.runtimeIntervals||{};const pairs=[['aprIntervalSeconds','marketRefreshMs'],['rangeIntervalSeconds','rangeCheckIntervalMs'],['pointsIntervalSeconds','pointsSimulationIntervalMs']];for(const[id,key]of pairs){const el=$(id);if(el&&document.activeElement!==el)el.value=Math.round(Number(values[key]||0)/1000)}$('policyScan').textContent=formatInterval(values.rangeCheckIntervalMs);const pt=snapshot&&snapshot.points||{};$('pointsSchedule').textContent=pt.simulatedAt?'最近模擬 '+dt(pt.simulatedAt)+' · 下次預定 '+dt(pt.nextSimulationAt):'尚無模擬紀錄'}
function render(){
  const state=snapshot||{},ctl=control||{},portfolio=state.portfolio||{},points=state.points||{},bot=state.bot||{};
  $('updated').textContent=state.generatedAt?dt(state.generatedAt):'等待首次掃描';
  $('mode').textContent=(ctl.dryRun?'預演模式':'實盤模式')+' · '+(ctl.executionPaused?'已暫停':'監控中');$('mode').className='pill '+(ctl.recoveryRequired?'bad':ctl.executionPaused?'warn':'good');
  $('armed').textContent=ctl.manualControlEnabled?'人工操作已啟用':'人工操作安全關閉';$('armed').className='pill '+(ctl.manualControlEnabled?'warn':'good');
  $('valueUsd').textContent=usd(portfolio.currentValueUsd);$('hodl').textContent='持有基準 '+usd(portfolio.hodlValueUsd);$('netPnl').textContent=usd(portfolio.netPnlUsd);$('netPnl').className='value '+(Number(portfolio.netPnlUsd)>0?'good':Number(portfolio.netPnlUsd)<0?'bad':'');$('excess').textContent='相對持有基準 '+usd(portfolio.excessVsHodlUsd);$('il').textContent=usd(portfolio.currentIlUsd);$('fees').textContent=usd(portfolio.trackedFeeUsd);$('gas').textContent='鏈上手續費 '+usd(portfolio.gasUsd);
  const positions=portfolio.positions||[];$('rangeCount').textContent=positions.length;$('oorCount').textContent=positions.filter(x=>x.outside).length+' 個區間外';$('execution').textContent=ctl.executionPaused?'已暫停':(ctl.dryRun?'預演監控中':(ctl.recoveryRequired||!(ctl.guard&&ctl.guard.runtimeReady)?'實盤受限':'實盤監控中'));$('lastAction').textContent=bot.lastAction||'尚無操作紀錄';
  const phases={completed:'已完成',failed:'失敗',recovery_required:'需要復原',withdraw_submitted:'提領交易已送出',swap_submitted:'兌換交易已送出',deposit_submitted:'存入交易已送出'};$('guard').textContent=ctl.guard&&ctl.guard.runtimeReady?'已就緒':(ctl.guard&&ctl.guard.verifiedFlag?'驗證失敗':'未啟用');$('guard').className='value '+(ctl.guard&&ctl.guard.runtimeReady?'good':(ctl.guard&&ctl.guard.verifiedFlag?'bad':'warn'));$('guardAddr').textContent=ctl.guard&&ctl.guard.address?short(ctl.guard.address):'尚未設定';$('recovery').textContent=ctl.recoveryRequired?'需要復原':(ctl.executionBusy?'執行中':'正常');$('recovery').className='value '+(ctl.recoveryRequired?'bad':(ctl.executionBusy?'warn':'good'));$('recoveryDetail').textContent=ctl.activeRebalanceExecution?((phases[ctl.activeRebalanceExecution.phase]||'交易處理中')+' · '+(ctl.activeRebalanceExecution.pair||'')):'沒有待處理交易';
  $('signer').innerHTML=yesNo(ctl.signerConfigured);$('liveWrites').innerHTML=yesNo(ctl.liveWrites);$('autoRedeploy').innerHTML=yesNo(ctl.autoRedeploy);$('manualControl').innerHTML=ctl.manualControlEnabled?'<span class="warn">已啟用</span>':'<span class="good">安全關閉</span>';$('guardFlag').innerHTML=yesNo(ctl.guard&&ctl.guard.verifiedFlag);$('guardRuntime').innerHTML=(ctl.guard&&ctl.guard.runtimeReady)?'<span class="good">已就緒</span>':'<span class="bad">'+esc((ctl.guard&&ctl.guard.error)?translateError(ctl.guard.error):'尚未部署並驗證安全防護')+'</span>';
  const healthy=(state.rpcHealth||[]).filter(x=>x.ok).length;$('rpc').textContent=healthy+'/'+(state.rpcHealth||[]).length;$('block').textContent=state.blockNumber||'--';const strategy=ctl.strategy||{},limits=ctl.limits||{};$('policyDeep').textContent=pct(strategy.shallowThresholdPct);$('policyWait').textContent=num(strategy.maxWaitMin)+' 分鐘';$('policyConfirm').textContent=num(strategy.deepConfirmationsRequired)+' 次';$('policyWidth').textContent=strategy.rangePreset==='fables-tight'?'Fables Tight（隨 Tick 間距取整）':num(strategy.tightWidthBps)+' bps';$('slippage').textContent=num(limits.withdrawSlippageBps)+' / '+num(limits.swapSlippageBps)+' / '+num(limits.depositSlippageBps)+' bps';$('maxGas').textContent=num(limits.maxGasGwei)+' gwei';
  renderMarkets(state.markets||[]);renderExecutionTargetStatus(state.markets||[]);renderFocus(state,ctl);const observed=(state.markets||[]).find(x=>x.statsObservedAt)?.statsObservedAt;$('marketStatsSource').textContent=observed?'資料來源：Fables · '+dt(observed):'官方池子統計暫時無法取得';
  $('positions').innerHTML=positions.map(positionRow).join('')||'<tr><td colspan="10" class="muted">目前沒有追蹤中的 LP 部位；匯入錢包後會掃描部位。</td></tr>';
  $('pointsTotal').textContent=num(points.estimatedTotal);$('pointsBaseline').textContent=num(points.actualBaseline);$('pointsDelta').textContent=num(points.estimatedDelta);$('pointsSimulatedAt').textContent=points.walletFeeEvidence?.observedAt?dt(points.walletFeeEvidence.observedAt):'尚未取得';$('pointBuckets').innerHTML=Object.entries(points.buckets||{}).sort(([a],[b])=>b.localeCompare(a)).map(([key,value])=>pointBucketRow(key,value)).join('')||'<tr><td colspan="4" class="muted">尚無已結算或可推估的紀錄。</td></tr>';
  const feeEvidence=points.walletFeeEvidence;$('pointsEvidence').textContent=points.actualPointsFromFables?('官方結算至 '+dt(points.officialSettledAt)+'：'+num(points.settledLpPoints)+' LP 分、'+num(points.settledReferralPoints)+' 推薦分，當時費用 '+usd(points.settledFeeUsd)+'。'+(feeEvidence?'本機交易對上 '+num(feeEvidence.localTxMatched)+'／'+num(feeEvidence.localTxCount)+' 筆；鏈上已領 '+usd(feeEvidence.claimedFeeUsd)+'、目前可領 '+usd(feeEvidence.claimableFeeUsd)+'。'+(points.calibratedPointsPerFeeUsd!=null?'以上次結算倍率約 '+num(points.calibratedPointsPerFeeUsd)+' 分／美元推估；實際分數以官方次日結算為準。':'尚無可比對的結算日，待結算分數暫不估算。'):'錢包費用資料尚未取得，待結算分數暫不估算。')):'官方資料尚未取得；目前僅顯示手動備援分數。';
  $('events').innerHTML=(state.events||[]).map(eventRow).join('');renderWallet();renderIntervals();
  const banner=$('liveBanner');if(ctl.recoveryRequired){banner.style.display='block';banner.className='banner bad';banner.textContent='需要人工復原：有尚未完成的資產移動流程，請先檢查交易與帳務紀錄。'}else if(!ctl.dryRun&&ctl.liveReady&&ctl.manualControlEnabled){banner.style.display='block';banner.className='banner bad';banner.textContent='即時交易已就緒：人工再平衡可能送出真實鏈上交易；仍受區間保留、政策限制與安全防護約束。'}else if(ctl.dryRun){banner.style.display='block';banner.className='banner good';banner.textContent='預演模式：再平衡只執行檢查與規劃，不會移動資產。'}else{banner.style.display='none'}
  renderStartReadiness();$('startExecution').textContent=ctl.dryRun?'啟動自動平衡（預演）':'啟動自動平衡（實盤）';$('startExecution').disabled=busy||!ctl.executionPaused||!(ctl.startReadiness&&ctl.startReadiness.ready);$('startExecution').title=(ctl.startReadiness&&ctl.startReadiness.ready)?'解除暫停並啟動自動平衡監控。':'完成上方列出的條件後才能啟動。';$('pauseExecution').disabled=busy||ctl.executionPaused;$('pauseExecution').title='暫停會阻止新的再平衡；不會中斷已開始的資產移動流程。';$('scan').disabled=busy;
}
async function load(){try{const results=await Promise.all([api('/api/state'),api('/api/control/status'),api('/api/events?limit=250')]);snapshot=results[0];control=results[1];snapshot.events=results[2].events||[];$('authPanel').style.display='none';render()}catch(error){if(error.message==='請輸入有效的中控台權杖。')$('authPanel').style.display='block';showNotice(error.message,true)}}
async function saveInterval(field,inputId){if(busy)return;const current=control&&control.runtimeIntervals;if(!current){showNotice('尚未載入週期設定。',true);return}const seconds=Number($(inputId).value);if(!Number.isFinite(seconds)||seconds<=0){showNotice('請輸入有效的秒數。',true);return}setBusy(true);try{const result=await api('/api/settings/intervals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...current,[field]:Math.round(seconds*1000)})});control.runtimeIntervals=result.intervals;await load();showNotice('週期設定已儲存並立即套用。')}catch(error){showNotice(error.message,true)}finally{setBusy(false)}}
async function manualRebalance(poolId,positionId,pair){if(busy)return;const live=control&&!control.dryRun;const prompt=live?'這會嘗試送出真實鏈上交易。只有所有安全條件通過才會繼續。':'目前是預演模式，不會移動資產。';if(!confirm('要對 '+pair+' 執行人工再平衡嗎？\n\n'+prompt+'\n\n操作仍不能略過區間政策。'))return;setBusy(true);try{const result=await api('/api/control/rebalance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({poolId,positionId,confirm:'REBALANCE'})});showNotice('操作結果：'+(result.result?.status||'已完成'));await load()}catch(error){showNotice(error.message,true);await load()}finally{setBusy(false)}}
$('positions').addEventListener('click',event=>{const button=event.target.closest('button[data-action="rebalance"]');if(button&&!button.disabled)manualRebalance(button.dataset.pool,button.dataset.pos,button.dataset.pair)});
$('markets').addEventListener('click',async event=>{const targetButton=event.target.closest('button[data-target-id]');if(targetButton&&!busy){setBusy(true);try{const result=await api('/api/pools/target',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({poolId:targetButton.dataset.targetId})});await load();showNotice(result.target.poolId?'已設定 '+result.target.pair+' 為自動平衡目標池；不會自動解除暫停。':'已清除自動平衡目標池。')}catch(error){showNotice(error.message,true)}finally{setBusy(false)}return}const button=event.target.closest('button[data-watch-id]');if(!button||busy)return;setBusy(true);try{await api('/api/pools/watch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({poolId:button.dataset.watchId,watch:button.dataset.watchNext==='true'})});await load();showNotice('監控清單已更新。')}catch(error){showNotice(error.message,true)}finally{setBusy(false)}});
$('scan').onclick=async()=>{if(busy)return;setBusy(true);try{await api('/api/control/scan',{method:'POST'});await load();showNotice('掃描完成。')}catch(error){showNotice(error.message,true)}finally{setBusy(false)}};
$('startExecution').onclick=async()=>{if(busy||!control||!(control.startReadiness&&control.startReadiness.ready))return;const live=!control.dryRun;const message=live?'這會解除暫停並允許程式在既有安全政策通過時送出真實鏈上交易。':'目前為預演模式，只會檢查與規劃，不會移動資產。';if(!confirm('要啟動自動平衡嗎？\n\n'+message))return;setBusy(true);try{await api('/api/control/start',{method:'POST'});await load();showNotice('自動平衡已啟動。')}catch(error){showNotice(error.message,true);await load()}finally{setBusy(false)}};
$('pauseExecution').onclick=async()=>{if(busy)return;setBusy(true);try{await api('/api/control/pause',{method:'POST'});await load();showNotice('自動平衡已暫停；錢包監控仍會繼續。')}catch(error){showNotice(error.message,true)}finally{setBusy(false)}};
$('refresh').onclick=()=>load();
$('saveAprInterval').onclick=()=>saveInterval('marketRefreshMs','aprIntervalSeconds');
$('poolSearch').addEventListener('input',()=>renderMarkets(snapshot&&snapshot.markets||[]));
$('saveRangeInterval').onclick=()=>saveInterval('rangeCheckIntervalMs','rangeIntervalSeconds');
$('savePointsInterval').onclick=()=>saveInterval('pointsSimulationIntervalMs','pointsIntervalSeconds');
$('mountWallet').onclick=async()=>{if(busy)return;const secret=$('walletSecret').value,type=$('walletType').value;if(!secret){showNotice('請輸入錢包資料。',true);return}const saving=control&&control.credentialPersistenceEnabled?'通過驗證後會將私鑰與地址保存到本機 .env（助記詞不保存），':'憑證只保留在目前程序記憶體，';if(!confirm('確定掛載此錢包為目前監控地址嗎？'+saving+'並強制啟用預演與暫停。'))return;setBusy(true);try{const result=await api('/api/wallet/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type,secret})});showNotice('錢包 '+short(result.address)+' 已掛載，正在掃描部位與餘額。');await load()}catch(error){showNotice(error.message,true)}finally{$('walletSecret').value='';setBusy(false)}};
$('selectWallet').onclick=async()=>{if(busy)return;const address=$('walletProfile').value;if(!address)return;setBusy(true);try{const result=await api('/api/wallet/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address})});showNotice('已切換監控錢包 '+short(result.address)+'，正在掃描。');await load()}catch(error){showNotice(error.message,true)}finally{setBusy(false)}};
$('saveRpc').onclick=async()=>{if(busy)return;const endpoint=$('rpcEndpoint').value;if(!endpoint){showNotice('請輸入 RPC 網址。',true);return}setBusy(true);try{const result=await api('/api/settings/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:endpoint})});$('rpcEndpoint').value='';showNotice('RPC 驗證成功，鏈 ID '+result.chainId+(result.persisted?'；已保存到本機 .env。':'；目前只套用於本次執行。'));await load()}catch(error){showNotice(error.message,true);$('rpcEndpoint').value=''}finally{setBusy(false)}};
$('savePoints').onclick=async()=>{const points=Number($('actualPoints').value);if(!Number.isFinite(points)||points<0){showNotice('請輸入零或正數作為實際分數。',true);return}setBusy(true);try{await api('/api/points/baseline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({points})});$('actualPoints').value='';await load();showNotice('實際分數基準已更新。')}catch(error){showNotice(error.message,true)}finally{setBusy(false)}};
$('addCashflow').onclick=async()=>{const usdValue=Number($('cashflow').value);if(!Number.isFinite(usdValue)||usdValue===0){showNotice('請輸入非零金額；存入填正數、提領填負數。',true);return}setBusy(true);try{await api('/api/cashflow',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({usd:usdValue,note:$('cashflowNote').value})});$('cashflow').value='';$('cashflowNote').value='';await load();showNotice('帳務調整已新增。')}catch(error){showNotice(error.message,true)}finally{setBusy(false)}};
$('saveDashboardToken').onclick=async()=>{dashboardToken=$('dashboardTokenInput').value;sessionStorage.setItem('dashboardToken',dashboardToken);$('dashboardTokenInput').value='';await load()};
load();setInterval(()=>{if(!busy)load()},10000);
</script>
</main></body></html>`;
}
