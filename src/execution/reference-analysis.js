export function analyzeReferenceArtifact(artifact, depositedTopic) {
  const topic = String(depositedTopic || '').toLowerCase();
  const logs = artifact?.receipt?.logs || blockscoutItems(artifact?.blockscout?.logs);
  const deposits = logs
    .filter((log) => String(log?.topics?.[0] || '').toLowerCase() === topic)
    .map((log) => ({
      hook: normalizeAddress(log.address),
      user: topicAddress(log.topics?.[1]),
      rangeId: String(log.topics?.[2] || '').toLowerCase() || null,
      liquidity: decodeUint(log.data),
      logIndex: Number(log.index ?? log.log_index ?? 0),
      transactionHash: log.transactionHash || log.transaction_hash || artifact?.hash || null
    }));
  const hooks = [...new Set(deposits.map((x) => x.hook).filter(Boolean))];
  const traceRoots = [artifact?.trace, artifact?.blockscout?.rawTrace, artifact?.blockscout?.internalTransactions].filter(Boolean);
  const calls = traceRoots.flatMap((root) => collectTraceCalls(root));
  const topLevel = artifact?.transaction?.to ? [{
    to: artifact.transaction.to,
    from: artifact.transaction.from || null,
    input: artifact.transaction.data || artifact.transaction.input || null,
    value: stringifyValue(artifact.transaction.value),
    type: 'transaction'
  }] : [];
  const allCalls = [...topLevel, ...calls];
  const candidateCalls = allCalls.filter((call) => hooks.includes(normalizeAddress(call.to)) && call.input && call.input !== '0x');
  return {
    deposits,
    hooks,
    candidateCalls: candidateCalls.map((call) => ({ ...call, selector: call.input.slice(0, 10).toLowerCase() })),
    hasTrace: calls.length > 0,
    status: deposits.length === 0 ? 'no_deposit_event' : candidateCalls.length ? 'candidate_calls_found' : 'deposit_event_found_trace_needed'
  };
}

export function collectTraceCalls(root) {
  const out = [];
  walk(root, out);
  return out;
}

function walk(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  if (typeof node !== 'object') return;
  const action = node.action && typeof node.action === 'object' ? node.action : null;
  const to = node.to || action?.to || null;
  const from = node.from || action?.from || null;
  const input = node.input || action?.input || null;
  const value = node.value ?? action?.value ?? null;
  const type = node.type || node.callType || action?.callType || null;
  if (to || input) out.push({ to, from, input, value: stringifyValue(value), type });
  for (const key of ['calls', 'children', 'trace', 'result']) {
    const child = node[key];
    if (child && typeof child === 'object') walk(child, out);
  }
}

function blockscoutItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}
function normalizeAddress(value) {
  const x = String(value || '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(x) ? x : null;
}
function topicAddress(value) {
  const x = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(x)) return null;
  return '0x' + x.slice(-40);
}
function decodeUint(value) {
  try { return BigInt(value || '0x0').toString(); } catch { return '0'; }
}
function stringifyValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value == null) return null;
  return String(value);
}
