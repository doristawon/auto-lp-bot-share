import { FallbackProvider, JsonRpcProvider } from 'ethers';

export function createProviders(config) {
  const network = { chainId: config.chainId, name: 'robinhood' };
  const rawProviders = config.rpcUrls.map((url) => new JsonRpcProvider(url, network, { staticNetwork: true }));
  const readProvider = rawProviders.length === 1
    ? rawProviders[0]
    : new FallbackProvider(
        rawProviders.map((provider, index) => ({
          provider,
          priority: index + 1,
          weight: 1,
          stallTimeout: 1200 + index * 400
        })),
        network,
        { quorum: 1 }
      );
  return { readProvider, writeProvider: rawProviders[0], rawProviders };
}

export async function verifyProviders(providers, chainId) {
  const results = [];
  for (let index = 0; index < providers.length; index += 1) {
    try {
      const actualChainId = Number(BigInt(await providers[index].send('eth_chainId', [])));
      results.push({ index, ok: actualChainId === chainId, chainId: actualChainId });
    } catch {
      results.push({ index, ok: false, error: 'unreachable' });
    }
  }
  if (!results.some((x) => x.ok)) throw new Error('No configured RPC endpoint is healthy on Robinhood Chain');
  return results;
}
