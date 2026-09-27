import http from 'node:http';
import { getAddress, Wallet } from 'ethers';
import { dashboardPage } from './page.js';
import { log, sanitize } from '../logger.js';

export class DashboardServer {
  constructor(config, bot, ledger, pointsTracker) {
    this.config = config;
    this.bot = bot;
    this.ledger = ledger;
    this.pointsTracker = pointsTracker;
    this.server = null;
  }

  async start() {
    if (!this.config.dashboardEnabled || this.server) return;
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(this.config.dashboardHost);
    const sensitiveControl = Boolean(this.config.enableLiveWrites || this.config.dashboardManualControlEnabled);
    if ((!loopback || sensitiveControl) && !this.config.dashboardToken) {
      throw new Error(
        sensitiveControl
          ? 'DASHBOARD_TOKEN is required whenever live writes or dashboard manual control is enabled'
          : 'DASHBOARD_TOKEN is required when dashboard binds outside loopback'
      );
    }
    this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
      log('error', 'dashboard.request_failed', { error: error.message });
      sendJson(res, 500, { error: error.message });
    }));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.dashboardPort, this.config.dashboardHost, resolve);
    });
    log('info', 'dashboard.started', { host: this.config.dashboardHost, port: this.config.dashboardPort });
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  async handle(req, res) {
    this.ledger = this.bot.ledger;
    this.pointsTracker = this.bot.points;
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, dashboardPage());
    if (!this.authorized(req, url)) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET' && !sameOriginRequest(req)) return sendJson(res, 403, { error: 'same-origin request required' });
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        running: Boolean(this.bot.running),
        cycleActive: Boolean(this.bot.cycleActive),
        lastSnapshotAt: this.bot.snapshot?.generatedAt || null
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const snapshot = this.bot.snapshot || this.ledger.readSnapshot() || emptySnapshot(this.bot);
      const markets = liveMarketSnapshot(this.bot);
      return sendJson(res, 200, {
        ...snapshot,
        blockNumber: snapshot.blockNumber ?? this.bot.market?.latestBlock ?? null,
        markets: markets.length ? markets : (snapshot.markets || []),
        rpcHealth: this.bot.rpcHealth?.length ? this.bot.rpcHealth : (snapshot.rpcHealth || [])
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 250)));
      return sendJson(res, 200, { events: this.ledger.list({ limit }) });
    }
    if (req.method === 'GET' && url.pathname === '/api/control/status') {
      const status = await this.bot.controlStatus();
      return sendJson(res, 200, {
        ...status,
        manualControlEnabled: Boolean(this.config.dashboardManualControlEnabled)
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/intervals') {
      const body = await readJsonBody(req);
      try {
        const intervals = this.bot.setRuntimeIntervals(body);
        return sendJson(res, 200, { ok: true, intervals });
      } catch (error) {
        return sendJson(res, 400, { error: sanitize(error.message || '更新週期設定失敗') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/pause') {
      this.bot.setExecutionPaused(true, 'dashboard');
      return sendJson(res, 200, { ok: true, executionPaused: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/control/start') {
      const result = await this.bot.startExecution('dashboard');
      if (!result.ok) return sendJson(res, 409, { error: '啟動條件尚未完成，請查看控制台提示。', blockers: result.blockers });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/control/resume') {
      try {
        const result = await this.bot.startExecution('dashboard');
        if (!result.ok) return sendJson(res, 409, { error: '啟動條件尚未完成，請查看控制台提示。', blockers: result.blockers });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 409, { error: error.shortMessage || error.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/scan') {
      if (this.bot.cycleActive) {
        return sendJson(res, 409, { error: 'monitoring/execution cycle is already running' });
      }
      const snapshot = await this.bot.runOnce({ executeRebalances: false, source: 'dashboard-scan' });
      return sendJson(res, 200, {
        ok: true,
        blockNumber: snapshot?.blockNumber ?? null,
        generatedAt: snapshot?.generatedAt ?? null
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/rpc') {
      const body = await readJsonBody(req);
      try {
        const result = await this.bot.setRpcEndpoint(body.url);
        return sendJson(res, 200, { ok: true, ...result, customConfigured: true, persisted: Boolean(this.config.persistRuntimeCredentials) });
      } catch (error) {
        return sendJson(res, 400, { error: sanitize(error.message || 'RPC update failed') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/import') {
      const body = await readJsonBody(req);
      const type = String(body.type || '').trim().toLowerCase();
      let address = '';
      let privateKey = '';
      try {
        const secret = String(body.secret || '').trim();
        if (type === 'watch-only') {
          address = getAddress(secret);
        } else if (type === 'private-key') {
          const normalized = /^0x/i.test(secret) ? secret : '0x' + secret;
          const signer = new Wallet(normalized);
          address = signer.address;
          privateKey = signer.privateKey;
        } else if (type === 'mnemonic') {
          const phrase = secret.replace(/\s+/g, ' ');
          const signer = Wallet.fromPhrase(phrase);
          address = signer.address;
          privateKey = signer.privateKey;
        } else {
          body.secret = '';
          return sendJson(res, 400, { error: 'Wallet type must be mnemonic, private-key, or watch-only' });
        }
      } catch {
        body.secret = '';
        return sendJson(res, 400, { error: 'Wallet input did not validate; nothing was mounted' });
      }
      body.secret = '';
      try {
        const result = await this.bot.mountWallet(address, privateKey, type);
        privateKey = '';
        return sendJson(res, 200, { ...result, persisted: Boolean(this.config.persistRuntimeCredentials) });
      } catch (error) {
        privateKey = '';
        return sendJson(res, 409, { error: sanitize(error.message || 'Wallet could not be mounted') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/select') {
      const body = await readJsonBody(req);
      try { return sendJson(res, 200, this.bot.switchWallet(body.address)); }
      catch (error) { return sendJson(res, 409, { error: sanitize(error.message || 'Wallet could not be selected') }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/pools/watch') {
      const body = await readJsonBody(req);
      try {
        const watchedPoolIds = this.bot.setWatchedPool(body.poolId, Boolean(body.watch));
        return sendJson(res, 200, { ok: true, watchedPoolIds });
      } catch (error) {
        return sendJson(res, 400, { error: sanitize(error.message || 'Pool could not be updated') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/pools/target') {
      const body = await readJsonBody(req);
      try {
        const target = this.bot.setExecutionTargetPool(body.poolId);
        return sendJson(res, 200, { ok: true, target });
      } catch (error) {
        return sendJson(res, 400, { error: sanitize(error.message || 'Execution target could not be updated') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/rebalance') {
      if (!this.config.dashboardManualControlEnabled) {
        return sendJson(res, 403, { error: 'dashboard manual control is not armed' });
      }
      const body = await readJsonBody(req);
      if (String(body.confirm || '') !== 'REBALANCE') {
        return sendJson(res, 400, { error: 'manual rebalance requires confirm=REBALANCE' });
      }
      try {
        const result = await this.bot.manualRebalance(body.poolId, body.positionId, 'dashboard');
        const status = result?.status === 'blocked' ? 409 : 200;
        return sendJson(res, status, { ok: status === 200, result });
      } catch (error) {
        return sendJson(res, 409, { error: error.shortMessage || error.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/points/baseline') {
      const body = await readJsonBody(req);
      if (!Number.isFinite(Number(body.points)) || Number(body.points) < 0) return sendJson(res, 400, { error: 'invalid points' });
      this.pointsTracker.setActualBaseline(Number(body.points), body.at || new Date().toISOString());
      this.bot.updatePointsSnapshot(true);
      return sendJson(res, 200, { ok: true, points: Number(body.points) });
    }
    if (req.method === 'POST' && url.pathname === '/api/cashflow') {
      const body = await readJsonBody(req);
      const usd = Number(body.usd);
      if (!Number.isFinite(usd) || usd === 0) return sendJson(res, 400, { error: 'invalid usd' });
      this.ledger.append('cashflow.adjustment', { usd, note: String(body.note || '').slice(0, 200) });
      return sendJson(res, 200, { ok: true, usd });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  authorized(req, url) {
    if (!this.config.dashboardToken) return true;
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const header = String(req.headers['x-dashboard-token'] || '');
    return [bearer, header].includes(this.config.dashboardToken);
  }
}

function sameOriginRequest(req) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '').toLowerCase();
  if (!origin || !host || /[\r\n]/.test(host)) return false;
  try {
    const parsed = new URL(origin);
    const loopback = parsed.hostname === '127.0.0.1'
      || parsed.hostname === 'localhost'
      || parsed.hostname === '[::1]'
      || parsed.hostname === '::1';
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === host && loopback;
  } catch {
    return false;
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function sendHtml(res, value) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(value);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > 128 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      try { resolve(raw.length ? JSON.parse(raw.toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON body')); }
      finally {
        raw.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    });
    req.on('error', reject);
  });
}
function emptySnapshot(bot) { return { generatedAt: null, bot: { dryRun: bot?.config?.dryRun ?? true, executionPaused: bot?.executionPaused ?? true } }; }
function liveMarketSnapshot(bot) {
  const pools = bot?.market?.pools || [];
  const stats = bot?.market?.fablesStats;
  const watched = new Set((bot?.state?.getSetting('watchedPoolIds', []) || []).map((id) => String(id).toLowerCase()));
  return pools.map((pool) => {
    const id = String(pool.id || '').toLowerCase();
    const poolStats = stats?.pools?.get(id) || null;
    return {
      id: pool.id,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      token0: pool.token0.symbol,
      token1: pool.token1.symbol,
      tick: pool.state?.tick ?? null,
      paused: pool.state?.paused ?? null,
      watched: watched.has(id),
      tvlUsd: poolStats?.tvlUsd ?? null,
      volume24hUsd: poolStats?.volume24hUsd ?? null,
      fees24hUsd: poolStats?.fees24hUsd ?? null,
      aprPct: poolStats?.aprPct ?? null,
      statsObservedAt: stats?.observedAt ?? null,
      statsSource: stats?.source ?? null
    };
  });
}
