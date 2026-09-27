import { Interface, formatUnits, parseUnits } from 'ethers';
import { V4_QUOTER_ABI } from '../abi.js';
import { UNISWAP_V4_QUOTER } from '../constants.js';
import { poolKeyArgs } from './fables.js';

const iface = new Interface(V4_QUOTER_ABI);
const MAX_UINT128 = (1n << 128n) - 1n;

export class V4QuoterAdapter {
  constructor(provider, address = UNISWAP_V4_QUOTER) {
    this.provider = provider;
    this.address = address;
  }

  async quoteExactInputSingle(pool, tokenInIndex, amountIn, slippageBps = 50) {
    if (![0, 1].includes(tokenInIndex)) throw new Error('tokenInIndex must be 0 or 1');
    const tokenIn = tokenInIndex === 0 ? pool.token0 : pool.token1;
    if (tokenIn.decimals == null) throw new Error('Token decimals unavailable for quote');
    const rawAmountIn = parseUnits(decimalString(amountIn, tokenIn.decimals), tokenIn.decimals);
    return this.quoteExactInputSingleRaw(pool, tokenInIndex, rawAmountIn, slippageBps);
  }

  async quoteExactInputSingleRaw(pool, tokenInIndex, rawAmountIn, slippageBps = 50) {
    if (![0, 1].includes(tokenInIndex)) throw new Error('tokenInIndex must be 0 or 1');
    const tokenIn = tokenInIndex === 0 ? pool.token0 : pool.token1;
    const tokenOut = tokenInIndex === 0 ? pool.token1 : pool.token0;
    if (tokenIn.decimals == null || tokenOut.decimals == null) throw new Error('Token decimals unavailable for quote');
    rawAmountIn = BigInt(rawAmountIn);
    if (rawAmountIn <= 0n || rawAmountIn > MAX_UINT128) throw new Error('Quote amount must fit uint128');
    const params = [poolKeyArgs(pool), tokenInIndex === 0, rawAmountIn, '0x'];
    const data = iface.encodeFunctionData('quoteExactInputSingle', [params]);
    const raw = await this.provider.call({ to: this.address, data });
    const [rawAmountOut, gasEstimate] = iface.decodeFunctionResult('quoteExactInputSingle', raw);
    const safeBps = Math.max(0, Math.min(10_000, Number(slippageBps)));
    const minRawAmountOut = BigInt(rawAmountOut) * BigInt(10_000 - safeBps) / 10_000n;
    return {
      quoter: this.address,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      symbolIn: tokenIn.symbol,
      symbolOut: tokenOut.symbol,
      rawAmountIn: rawAmountIn.toString(),
      rawAmountOut: BigInt(rawAmountOut).toString(),
      minRawAmountOut: minRawAmountOut.toString(),
      amountIn: Number(formatUnits(rawAmountIn, tokenIn.decimals)),
      amountOut: Number(formatUnits(rawAmountOut, tokenOut.decimals)),
      minAmountOut: Number(formatUnits(minRawAmountOut, tokenOut.decimals)),
      slippageBps: safeBps,
      gasEstimate: BigInt(gasEstimate).toString(),
      zeroForOne: tokenInIndex === 0
    };
  }
}

function decimalString(value, decimals) {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid quote amount');
  return value.toFixed(Math.min(decimals, 18)).replace(/0+$/, '').replace(/\.$/, '') || '0';
}
