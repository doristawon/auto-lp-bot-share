import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const BASE = {
  WALLET_ADDRESS: '0x000000000000000000000000000000000000dead',
  DRY_RUN: 'true',
  ENABLE_LIVE_WRITES: 'false',
  ENABLE_AUTO_REDEPLOY: 'false'
};

function withEnv(extra, fn) {
  const keys = new Set([...Object.keys(BASE), ...Object.keys(extra), 'TARGET_POOL_IDS', 'TARGET_SYMBOLS', 'TARGET_MODE', 'SWAP_SLIPPAGE_BPS', 'PRIVATE_KEY', 'EIP7702_GUARD_ADDRESS', 'EIP7702_GUARD_VERIFIED', 'DASHBOARD_MANUAL_CONTROL_ENABLED']);
  const previous = Object.fromEntries([...keys].map((k) => [k, process.env[k]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, BASE, extra);
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('allowlist mode refuses empty pool ids instead of targeting all pools', () => {
  assert.throws(
    () => withEnv({ TARGET_MODE: 'allowlist', TARGET_POOL_IDS: '' }, () => loadConfig()),
    /requires at least one TARGET_POOL_IDS/
  );
});

test('symbols mode refuses empty symbols instead of targeting all pools', () => {
  assert.throws(
    () => withEnv({ TARGET_MODE: 'symbols', TARGET_SYMBOLS: '' }, () => loadConfig()),
    /requires TARGET_SYMBOLS/
  );
});

test('wallet-active mode allows empty static target fields', () => {
  const config = withEnv({ TARGET_MODE: 'wallet-active' }, () => loadConfig());
  assert.equal(config.targetMode, 'wallet-active');
  assert.deepEqual(config.targetPoolIds, []);
  assert.deepEqual(config.targetSymbols, []);
});

test('invalid swap slippage fails closed', () => {
  assert.throws(
    () => withEnv({ TARGET_MODE: 'wallet-active', SWAP_SLIPPAGE_BPS: '10000' }, () => loadConfig()),
    /SWAP_SLIPPAGE_BPS/
  );
});

test('live auto-redeploy requires the atomic guard to be configured and canary-verified', () => {
  assert.throws(
    () => withEnv({
      TARGET_MODE: 'wallet-active',
      DRY_RUN: 'false',
      ENABLE_LIVE_WRITES: 'true',
      ENABLE_AUTO_REDEPLOY: 'true',
      PRIVATE_KEY: '0x' + '11'.repeat(32)
    }, () => loadConfig()),
    /EIP-7702 atomic OOR guard/
  );
});


test('dashboard manual control defaults safe-off and requires explicit opt-in', () => {
  const safe = withEnv({ TARGET_MODE: 'wallet-active' }, () => loadConfig());
  assert.equal(safe.dashboardManualControlEnabled, false);

  const armed = withEnv({
    TARGET_MODE: 'wallet-active',
    DASHBOARD_MANUAL_CONTROL_ENABLED: 'true'
  }, () => loadConfig());
  assert.equal(armed.dashboardManualControlEnabled, true);
});
