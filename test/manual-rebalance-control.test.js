import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';

const poolId = '0x' + '11'.repeat(32);
const positionId = '0x' + '22'.repeat(32);

function makeBot(positionPatch = {}) {
  const events = [];
  const position = {
    id: positionId,
    outside: true,
    shouldRebalance: true,
    ...positionPatch
  };
  const pool = {
    id: poolId,
    token0: { symbol: 'USDG' },
    token1: { symbol: 'MOO' },
    positions: [position]
  };
  const bot = Object.create(AutoLpBot.prototype);
  bot.cycleActive = false;
  bot.executionPaused = false;
  bot.config = { targetMode: 'allowlist', dryRun: true };
  bot.market = { pools: [pool] };
  bot.ledger = { append(type, data) { events.push({ type, data }); } };
  bot.runOnce = async (options) => {
    assert.equal(options.executeRebalances, false);
    return { blockNumber: 100, bot: { activePoolIds: [poolId] } };
  };
  return { bot, pool, position, events };
}

test('manual rebalance can never bypass Absolute In-Range Hold', async () => {
  const { bot } = makeBot({ outside: false, shouldRebalance: false });
  await assert.rejects(
    bot.manualRebalance(poolId, positionId),
    /Absolute in-range hold/
  );
  assert.equal(bot.cycleActive, false);
});

test('manual rebalance cannot force an OOR position before policy eligibility', async () => {
  const { bot } = makeBot({ outside: true, shouldRebalance: false });
  await assert.rejects(
    bot.manualRebalance(poolId, positionId),
    /has not satisfied the configured rebalance policy/
  );
  assert.equal(bot.cycleActive, false);
});

test('eligible manual rebalance uses the normal safety executor path', async () => {
  const { bot, events } = makeBot();
  let call = null;
  bot.maybeRebalance = async (pool, position, options) => {
    call = { pool, position, options };
    return { status: 'dry-run' };
  };
  const result = await bot.manualRebalance(poolId, positionId, 'dashboard');
  assert.equal(result.status, 'dry-run');
  assert.ok(call);
  assert.equal(call.options.source, 'dashboard');
  assert.equal(call.options.throwOnFailure, true);
  assert.equal(bot.cycleActive, false);
  assert.ok(events.some((x) => x.type === 'rebalance.manual_requested'));
});

test('manual rebalance refuses while execution is paused before any fresh scan', async () => {
  const { bot } = makeBot();
  let scanned = false;
  bot.runOnce = async () => { scanned = true; return null; };
  bot.executionPaused = true;
  await assert.rejects(
    bot.manualRebalance(poolId, positionId),
    /Execution is paused/
  );
  assert.equal(scanned, false);
});


test('resume is blocked while a non-terminal rebalance journal exists', () => {
  const bot = Object.create(AutoLpBot.prototype);
  bot.executionPaused = true;
  bot.state = {
    getSetting(key) {
      if (key === 'activeRebalanceExecution') return { id: 'exec-1', phase: 'recovery_required' };
      return null;
    },
    setSetting() {
      throw new Error('resume should not mutate state while recovery is pending');
    }
  };
  bot.ledger = { append() { throw new Error('resume should not write ledger while recovery is pending'); } };
  assert.throws(
    () => bot.setExecutionPaused(false, 'dashboard'),
    /Cannot resume while rebalance execution requires review: recovery_required/
  );
  assert.equal(bot.executionPaused, true);
});
