import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';

function mockBot({ beforePools, beforeRanges, afterPools, afterRanges, latest = 101 }) {
  const events = [];
  return {
    state: {
      getSetting(key, fallback) {
        if (key === 'activeWalletPoolIds') return beforePools;
        if (key === 'activeWalletRangeKeys') return beforeRanges;
        return fallback;
      }
    },
    providers: { readProvider: { async getBlockNumber() { return latest; } } },
    async resolveTargetPools() {
      return { discovery: { activePoolIds: afterPools, activeRangeKeys: afterRanges } };
    },
    ledger: { append(type, payload) { events.push({ type, ...payload }); } },
    _events: events
  };
}

test('pre-execution topology guard allows stable wallet topology', async () => {
  const bot = mockBot({
    beforePools: ['0xaaa'],
    beforeRanges: ['hook|range1'],
    afterPools: ['0xaaa'],
    afterRanges: ['hook|range1']
  });
  const ok = await AutoLpBot.prototype.revalidateTopologyBeforeExecution.call(bot, 100, []);
  assert.equal(ok, true);
  assert.equal(bot._events.length, 0);
});

test('pre-execution topology guard blocks when active range changes mid-cycle', async () => {
  const bot = mockBot({
    beforePools: ['0xaaa'],
    beforeRanges: ['hook|range1'],
    afterPools: ['0xbbb'],
    afterRanges: ['hook|range2']
  });
  const ok = await AutoLpBot.prototype.revalidateTopologyBeforeExecution.call(bot, 100, [{
    pool: { id: '0xaaa' },
    position: { id: '0x' + '11'.repeat(32) }
  }]);
  assert.equal(ok, false);
  assert.equal(bot._events.length, 1);
  assert.equal(bot._events[0].type, 'rebalance.blocked');
  assert.equal(bot._events[0].reason, 'wallet topology changed during cycle');
});
