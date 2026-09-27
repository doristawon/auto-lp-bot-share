import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';

loadDotEnv();
const config = loadConfig();
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);
const latest = await readProvider.getBlockNumber();
const lookback = Number(process.env.EIP7702_PROBE_BLOCKS || 250);
let type4 = null;
for (let n = latest; n >= Math.max(0, latest - lookback); n--) {
  const block = await readProvider.getBlock(n, true);
  for (const tx of block?.prefetchedTransactions || []) {
    if (Number(tx.type) === 4) {
      type4 = { blockNumber: n, hash: tx.hash, from: tx.from, to: tx.to };
      break;
    }
  }
  if (type4) break;
}
console.log(JSON.stringify({
  chainId: config.chainId,
  latestBlock: latest,
  scannedBlocks: lookback,
  observedType4: Boolean(type4),
  example: type4,
  note: type4 ? 'EIP-7702 type-4 transaction observed on chain' : 'No type-4 transaction observed in the scan window; absence does not prove unsupported'
}, null, 2));
