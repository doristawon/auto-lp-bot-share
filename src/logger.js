let redactionValues = [];

export function log(level, event, data = {}) {
  const record = { ts: new Date().toISOString(), level, event, ...sanitize(data) };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function sanitize(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

export function registerSensitiveValues(values = []) {
  const candidates = new Set();
  for (const value of values) {
    const raw = String(value || '');
    if (!raw) continue;
    candidates.add(raw);
    try {
      const parsed = new URL(raw);
      for (const label of parsed.hostname.split('.')) {
        if (label.length >= 16) candidates.add(label);
      }
      for (const segment of parsed.pathname.split('/')) {
        if (segment.length >= 16) candidates.add(segment);
        try {
          const decoded = decodeURIComponent(segment);
          if (decoded.length >= 16) candidates.add(decoded);
        } catch {}
      }
      for (const [key, item] of parsed.searchParams) {
        if (/(api.?key|token|secret|auth|access.?key|credential)/i.test(key) && item) candidates.add(item);
      }
    } catch {}
  }
  redactionValues = [...candidates].sort((left, right) => right.length - left.length);
}

function redactText(text) {
  let output = text;
  for (const value of redactionValues) {
    output = output.split(value).join('[REDACTED]');
    const encoded = encodeURIComponent(value);
    if (encoded !== value) output = output.split(encoded).join('[REDACTED]');
  }
  return output;
}
