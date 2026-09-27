import test from 'node:test';
import assert from 'node:assert/strict';
import { FablesAdapter, samePoolKey } from '../src/adapters/fables.js';

const CASHCAT = {
  currency0: '0x020bfC650A365f8BB26819deAAbF3E21291018b4',
  currency1: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  fee: 8388608,
  tickSpacing: 60,
  hooks: '0x08E52564Bad99E05a694b4809F397edcA417A080'
};
const MOO = {
  currency0: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  currency1: '0xD9dB30BB0D2b8d2eae3826A1372117E058791e18',
  fee: 8388608,
  tickSpacing: 200,
  hooks: '0x08E52564Bad99E05a694b4809F397edcA417A080'
};

test('shared hook does not make different PoolKeys equal', () => {
  assert.equal(samePoolKey(CASHCAT, { ...CASHCAT }), true);
  assert.equal(samePoolKey(CASHCAT, MOO), false);
});

test('target pool id allowlist is exclusive', () => {
  const adapterLike = { config: { targetPoolIds: ['0xmoo'], targetSymbols: ['CASHCAT', 'USDG'] } };
  const cashcatPool = { id: '0xcash', token0: { symbol: 'CASHCAT' }, token1: { symbol: 'USDG' } };
  const mooPool = { id: '0xmoo', token0: { symbol: 'USDG' }, token1: { symbol: 'MOO' } };
  assert.equal(FablesAdapter.prototype.matchesTarget.call(adapterLike, cashcatPool), false);
  assert.equal(FablesAdapter.prototype.matchesTarget.call(adapterLike, mooPool), true);
});


test('wallet-active mode follows discovered active pool ids and ignores stale static ids', () => {
  const adapterLike = {
    config: {
      targetMode: 'wallet-active',
      targetPoolIds: ['0xstale'],
      targetSymbols: ['OLD', 'USDG']
    }
  };
  const oldPool = { id: '0xold', token0: { symbol: 'OLD' }, token1: { symbol: 'USDG' } };
  const newMemePool = { id: '0xnew', token0: { symbol: 'NEWMEME' }, token1: { symbol: 'USDG' } };
  const selected = FablesAdapter.prototype.targetPools.call(adapterLike, [oldPool, newMemePool], ['0xnew']);
  assert.deepEqual(selected.map((x) => x.id), ['0xnew']);
});

test('allowlist mode never auto-adopts another matching meme pool', () => {
  const adapterLike = Object.create(FablesAdapter.prototype);
  adapterLike.config = {
    targetMode: 'allowlist',
    targetPoolIds: ['0xlocked'],
    targetSymbols: []
  };
  const locked = { id: '0xlocked', token0: { symbol: 'A' }, token1: { symbol: 'USDG' } };
  const other = { id: '0xother', token0: { symbol: 'B' }, token1: { symbol: 'USDG' } };
  const selected = FablesAdapter.prototype.targetPools.call(adapterLike, [locked, other], ['0xother']);
  assert.deepEqual(selected.map((x) => x.id), ['0xlocked']);
});
