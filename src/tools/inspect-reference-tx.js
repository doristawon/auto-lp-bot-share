import fs from 'node:fs';
import path from 'node:path';
import { Interface, id } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { DEPOSITED_EVENT, HOOK_ABI } from '../abi.js';
import { BlockscoutClient, blockscoutItems } from '../rpc/blockscout.js';
import { analyzeReferenceArtifact } from '../execution/reference-analysis.js';

loadDotEnv();
const config = loadConfig();
const hash = process.argv[2] || config.referenceDepositTx;
if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) throw new Error('Provide a transaction hash or set REFERENCE_DEPOSIT_TX');
const providers = createProviders(config);
await verifyProviders(providers.rawProviders, config.chainId);
const blockscout = new BlockscoutClient(config);

const [rpcTxResult, rpcReceiptResult] = await Promise.allSettled([
  providers.readProvider.getTransaction(hash),
  providers.readProvider.getTransactionReceipt(hash)
]);
const rpcTx = rpcTxResult.status === 'fulfilled' ? rpcTxResult.value : null;
const rpcReceipt = rpcReceiptResult.status === 'fulfilled' ? rpcReceiptResult.value : null;
let blockscoutBundle = null;
if ((!rpcTx || !rpcReceipt || config.blockscoutApiKey) && blockscout.enabled) {
  try { blockscoutBundle = await blockscout.transactionBundle(hash); }
  catch (error) { blockscoutBundle = { error: error.message }; }
}
if (!rpcTx && !blockscoutBundle?.transaction) throw new Error(`Transaction not found through configured RPC/Blockscout: ${hash}`);

let trace = null;
try {
  trace = await providers.writeProvider.send('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
} catch (error) {
  trace = { unavailable: true, error: error.message };
}

const transaction = rpcTx ? {
  from: rpcTx.from,
  to: rpcTx.to,
  nonce: rpcTx.nonce,
  value: rpcTx.value.toString(),
  selector: rpcTx.data?.slice(0, 10) || '0x',
  data: rpcTx.data
} : normalizeBlockscoutTransaction(blockscoutBundle.transaction);
const receipt = rpcReceipt ? {
  status: rpcReceipt.status,
  blockNumber: rpcReceipt.blockNumber,
  gasUsed: rpcReceipt.gasUsed.toString(),
  gasPrice: (rpcReceipt.gasPrice || rpcTx?.gasPrice || 0n).toString(),
  logs: rpcReceipt.logs.map((x) => ({
    address: x.address,
    topics: [...x.topics],
    data: x.data,
    index: x.index,
    transactionHash: x.transactionHash
  }))
} : normalizeBlockscoutReceipt(blockscoutBundle);

const hookIface = new Interface(HOOK_ABI);
let directHookDecode = null;
try { directHookDecode = hookIface.parseTransaction({ data: transaction.data, value: transaction.value }); } catch {}
const artifact = {
  inspectedAt: new Date().toISOString(),
  hash,
  transaction,
  receipt,
  directHookDecode: directHookDecode ? parsedTx(directHookDecode) : null,
  trace,
  blockscout: blockscoutBundle
};
artifact.analysis = analyzeReferenceArtifact(artifact, id(DEPOSITED_EVENT));
artifact.analysis.candidateDecodes = [];

if (blockscout.enabled) {
  for (const hook of artifact.analysis.hooks) {
    try {
      const contract = await blockscout.smartContract(hook);
      const abi = normalizeAbi(contract?.abi);
      if (!abi) continue;
      const iface = new Interface(abi);
      for (const candidate of artifact.analysis.candidateCalls.filter((x) => String(x.to).toLowerCase() === hook)) {
        try {
          const decoded = iface.parseTransaction({ data: candidate.input, value: candidate.value || 0 });
          if (decoded) artifact.analysis.candidateDecodes.push({ hook, selector: candidate.selector, ...parsedTx(decoded) });
        } catch {}
      }
    } catch (error) {
      artifact.analysis.candidateDecodes.push({ hook, error: error.message });
    }
  }
}

const dir = path.join(config.dataDir, 'reference-tx');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${hash}.json`);
fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({
  ok: true,
  file,
  to: transaction.to,
  selector: transaction.selector,
  traceAvailable: !trace?.unavailable,
  blockscoutUsed: Boolean(blockscoutBundle),
  analysisStatus: artifact.analysis.status,
  depositHooks: artifact.analysis.hooks,
  candidateSelectors: [...new Set(artifact.analysis.candidateCalls.map((x) => x.selector))],
  decodedCandidates: artifact.analysis.candidateDecodes.filter((x) => x.signature).map((x) => x.signature)
}, null, 2));

function normalizeBlockscoutTransaction(tx) {
  const data = tx?.raw_input || tx?.input || tx?.data || '0x';
  return {
    from: addressValue(tx?.from),
    to: addressValue(tx?.to),
    nonce: Number(tx?.nonce || 0),
    value: String(tx?.value || '0'),
    selector: data.slice(0, 10),
    data
  };
}
function normalizeBlockscoutReceipt(bundle) {
  const tx = bundle?.transaction || {};
  const logs = blockscoutItems(bundle?.logs).map((x) => ({
    address: addressValue(x.address) || x.address,
    topics: x.topics || [],
    data: x.data || '0x',
    index: Number(x.index ?? x.log_index ?? 0),
    transactionHash: x.transaction_hash || x.transactionHash || tx.hash || null
  }));
  return {
    status: tx.status === 'ok' || tx.status === 1 || tx.status === '1' ? 1 : tx.status,
    blockNumber: Number(tx.block || tx.block_number || 0),
    gasUsed: String(tx.gas_used || '0'),
    gasPrice: String(tx.gas_price || '0'),
    logs
  };
}
function normalizeAbi(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
function addressValue(value) {
  if (typeof value === 'string') return value;
  return value?.hash || value?.address || null;
}
function parsedTx(decoded) {
  return { name: decoded.name, signature: decoded.signature, args: [...decoded.args].map(stringify) };
}
function stringify(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringify(v)]));
  return value;
}
