import { Contract } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { FablesAdapter } from '../adapters/fables.js';
import { V4QuoterAdapter } from '../adapters/quoter.js';
import { UniversalRouterAdapter } from '../adapters/universal-router.js';
import { ERC20_ABI, PERMIT2_ABI } from '../abi.js';
import { PERMIT2, UNISWAP_UNIVERSAL_ROUTER_212 } from '../constants.js';

loadDotEnv();
const config = loadConfig();
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);

const pair = (process.env.SIM_PAIR || '').toUpperCase().split('/').filter(Boolean);
const tokenInSymbol = (process.env.SIM_TOKEN_IN || 'USDG').toUpperCase();
const amountIn = Number(process.env.SIM_AMOUNT_IN || '1');
if (pair.length !== 2 || !(amountIn > 0)) throw new Error('Set SIM_PAIR=A/B and positive SIM_AMOUNT_IN');

const fables = new FablesAdapter(readProvider, config);
const pools = await fables.hydratePoolStates(await fables.discoverAllPools());
const pool = pools.find((p) => {
  const symbols = [p.token0.symbol.toUpperCase(), p.token1.symbol.toUpperCase()];
  return p.state && symbols.includes(pair[0]) && symbols.includes(pair[1]);
});
if (!pool) throw new Error('Pool not found: ' + pair.join('/'));
const tokenInIndex = pool.token0.symbol.toUpperCase() === tokenInSymbol ? 0 :
  pool.token1.symbol.toUpperCase() === tokenInSymbol ? 1 : -1;
if (tokenInIndex < 0) throw new Error('SIM_TOKEN_IN not in selected pool');

const quoter = new V4QuoterAdapter(readProvider);
const quote = await quoter.quoteExactInputSingle(pool, tokenInIndex, amountIn, config.swapSlippageBps);
const router = new UniversalRouterAdapter(readProvider, config);
const deadline = Math.floor(Date.now() / 1000) + config.txDeadlineSec;

const inputToken = tokenInIndex === 0 ? pool.token0 : pool.token1;
const erc20 = new Contract(inputToken.address, ERC20_ABI, readProvider);
const permit2 = new Contract(PERMIT2, PERMIT2_ABI, readProvider);
const [freeBalance, erc20Allowance, p2Allowance] = await Promise.all([
  erc20.balanceOf(config.walletAddress),
  erc20.allowance(config.walletAddress, PERMIT2),
  permit2.allowance(config.walletAddress, inputToken.address, UNISWAP_UNIVERSAL_ROUTER_212)
]);

let simulation;
let simulationError = null;
try {
  simulation = await router.simulateV4ExactInputSingle({ pool, quote, deadline, from: config.walletAddress });
} catch (error) {
  simulationError = error.shortMessage || error.reason || error.message;
}

const rawAmountIn = BigInt(quote.rawAmountIn);
const permit2Unexpired = Number(p2Allowance.expiration) > Math.floor(Date.now() / 1000);
const allowanceReady =
  BigInt(erc20Allowance) >= rawAmountIn &&
  BigInt(p2Allowance.amount) >= rawAmountIn &&
  permit2Unexpired;
const insufficientFreeBalance = BigInt(freeBalance) < rawAmountIn;
const expectedPreWithdrawBalanceFailure =
  !simulation &&
  insufficientFreeBalance &&
  allowanceReady &&
  /TRANSFER_FROM_FAILED/i.test(String(simulationError || ''));

const result = {
  wallet: config.walletAddress,
  pair: pool.token0.symbol + '/' + pool.token1.symbol,
  poolId: pool.id,
  hook: pool.key.hooks,
  tick: pool.state.tick,
  amountIn,
  inputToken: inputToken.symbol,
  quote,
  freeWalletBalanceRaw: freeBalance.toString(),
  rawAmountIn: rawAmountIn.toString(),
  allowances: {
    erc20ToPermit2: erc20Allowance.toString(),
    permit2ToRouter: {
      amount: p2Allowance.amount.toString(),
      expiration: Number(p2Allowance.expiration),
      nonce: Number(p2Allowance.nonce)
    }
  },
  simulationOk: Boolean(simulation),
  simulationStatus: simulation
    ? 'success'
    : expectedPreWithdrawBalanceFailure
      ? 'expected-pre-withdraw-insufficient-free-balance'
      : 'failed',
  expectedPreWithdrawBalanceFailure,
  allowanceReady,
  permit2Unexpired,
  insufficientFreeBalance,
  simulationError,
  routerPlan: simulation ? {
    router: simulation.router,
    commands: simulation.commands,
    v4Actions: simulation.v4Actions,
    amountIn: simulation.amountIn,
    minAmountOut: simulation.minAmountOut,
    data: simulation.data,
    result: simulation.simulationResult
  } : router.buildV4ExactInputSingle({ pool, quote, deadline })
};
console.log(JSON.stringify(result, bigintReplacer, 2));
// A reverse route can be structurally valid while the token principal is still
// locked inside the LP. In that case a pre-withdraw eth_call is expected to fail
// TRANSFER_FROM_FAILED even though approvals and route encoding are correct.
// Treat only unexpected simulation failures as workflow failures.
if (!simulation && !expectedPreWithdrawBalanceFailure) process.exitCode = 2;


function bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
