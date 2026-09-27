import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { StateStore } from '../state.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';

loadDotEnv();
const config = loadConfig();
const state = new StateStore(config.stateFile);
const journal = state.getSetting('activeRebalanceExecution', null);
if (!journal) {
  console.log(JSON.stringify({ ok: true, status: 'no-pending-execution' }, null, 2));
  process.exit(0);
}
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);
const receipts = {};
for (const [phase, hash] of Object.entries(journal.tx || {})) {
  if (!hash) continue;
  const receipt = await readProvider.getTransactionReceipt(hash);
  receipts[phase] = receipt ? {
    hash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString()
  } : { hash, pending: true };
}
console.log(JSON.stringify({
  ok: true,
  status: journal.phase,
  journal,
  receipts,
  instruction: journal.phase === 'recovery_required'
    ? 'Automatic new writes are locked. Review token balances and receipts before clearing or resuming this execution.'
    : 'An unfinished execution journal exists; do not start a new rebalance.'
}, null, 2));
