export class BlockscoutClient {
  constructor(config) {
    this.apiKey = config.blockscoutApiKey || '';
    this.baseUrl = String(config.blockscoutApiBase || 'https://api.blockscout.com/4663/api/v2').replace(/\/$/, '');
  }

  get enabled() { return Boolean(this.apiKey); }

  async transactionBundle(hash) {
    if (!this.enabled) return null;
    const [transaction, logs, internalTransactions, rawTrace] = await Promise.all([
      this.get(`/transactions/${hash}`),
      this.get(`/transactions/${hash}/logs`).catch((error) => ({ error: error.message })),
      this.get(`/transactions/${hash}/internal-transactions`).catch((error) => ({ error: error.message })),
      this.get(`/transactions/${hash}/raw-trace`).catch((error) => ({ error: error.message }))
    ]);
    return { transaction, logs, internalTransactions, rawTrace };
  }

  async smartContract(address) {
    if (!this.enabled) return null;
    return this.get(`/smart-contracts/${address}`);
  }

  async get(pathname) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    url.searchParams.set('apikey', this.apiKey);
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    const body = await response.text();
    if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}: ${body.slice(0, 300)}`);
    try { return JSON.parse(body); }
    catch { throw new Error('Blockscout returned non-JSON response'); }
  }
}

export function blockscoutItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}
