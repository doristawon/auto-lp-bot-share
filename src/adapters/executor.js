import {
  Contract,
  Interface,
  Wallet,
  formatUnits,
  id,
  zeroPadValue
} from 'ethers';
import {
  DEPOSITED_EVENT,
  EIP7702_GUARD_ABI,
  ERC20_ABI,
  HOOK_ABI,
  PERMIT2_ABI
} from '../abi.js';
import {
  PERMIT2,
  UNISWAP_UNIVERSAL_ROUTER_212,
  ZERO_ADDRESS
} from '../constants.js';
import { UniversalRouterAdapter } from './universal-router.js';
import { V4QuoterAdapter } from './quoter.js';
import { buildExactBalancedSwapPlan } from '../execution/exact-rebalance.js';
import {
  MAX_UINT128,
  buildExactDepositPlan,
  buildExactWithdrawBounds
} from '../math/v4-fixed.js';
import { buildTargetRange, isLpOutOfRange } from '../math/ticks.js';
import { outOfRangeExcursionPct } from '../strategy.js';
import { log } from '../logger.js';

const erc20Interface = new Interface(ERC20_ABI);
const permit2Interface = new Interface(PERMIT2_ABI);
const guardInterface = new Interface(EIP7702_GUARD_ABI);
const depositedTopic = id(DEPOSITED_EVENT).toLowerCase();
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

export class RebalanceExecutor {
  constructor(readProvider, writeProvider, config, fables, ledger, getUsdPrice, state = null) {
    this.readProvider = readProvider;
    this.writeProvider = writeProvider;
    this.config = config;
    this.fables = fables;
    this.ledger = ledger;
    this.getUsdPrice = getUsdPrice;
    this.state = state;
    this.signer = config.privateKey ? new Wallet(config.privateKey, writeProvider) : null;
    this.quoter = new V4QuoterAdapter(readProvider);
    this.router = new UniversalRouterAdapter(readProvider, config);
  }

  async execute(plan) {
    await this.assertPlanStillOutOfRange(plan, 'executor-entry');

    if (this.config.dryRun || !this.config.enableLiveWrites) {
      const payload = serializablePlan(plan);
      this.ledger.append('rebalance.dry_run', payload);
      log('info', 'rebalance.dry_run', payload);
      return { status: 'dry-run' };
    }

    await this.assertLiveReady(plan);
    this.assertNoUnfinishedExecution();
    let phase = 'prepared';
    let journal = {
      id: `${Date.now()}:${plan.pool.id}:${plan.position.id}`,
      phase,
      startedAt: Date.now(),
      poolId: plan.pool.id,
      pair: `${plan.pool.token0.symbol}/${plan.pool.token1.symbol}`,
      oldPosition: {
        id: plan.position.id,
        tickLower: plan.position.tickLower,
        tickUpper: plan.position.tickUpper,
        shares: plan.position.shares.toString()
      },
      tx: {}
    };
    this.saveJournal(journal);

    try {
      const preBalances = await this.readRawPairBalances(plan.pool);
      journal = this.patchJournal(journal, {
        preBalancesRaw: stringifyRawBalances(preBalances)
      });

      // Prepare every approval path before principal is withdrawn. If a meme token
      // rejects approve/Permit2, fail while the LP is still intact.
      await this.ensureSwapAllowances(plan.pool.token0, MAX_UINT160);
      await this.ensureSwapAllowances(plan.pool.token1, MAX_UINT160);
      await this.ensureHookAllowance(plan.pool.token0, plan.pool.key.hooks, MAX_UINT128);
      await this.ensureHookAllowance(plan.pool.token1, plan.pool.key.hooks, MAX_UINT128);
      journal = this.patchJournal(journal, { phase: 'approvals_ready' });

      // Approvals can consume blocks; re-check OOR only after all non-capital-moving
      // setup transactions are complete.
      const latest = await this.assertPlanStillOutOfRange(plan, 'pre-atomic-withdraw');
      const withdrawBounds = buildExactWithdrawBounds({
        sqrtPriceX96: latest.sqrtPriceX96,
        tickLower: plan.position.tickLower,
        tickUpper: plan.position.tickUpper,
        liquidity: plan.position.shares,
        slippageBps: this.config.withdrawSlippageBps
      });
      if (!this.config.allowZeroMinOut && withdrawBounds.expected0 > 0n && withdrawBounds.amount0Min === 0n) {
        throw new Error('withdraw amount0Min resolved to zero for non-zero expected principal');
      }
      if (!this.config.allowZeroMinOut && withdrawBounds.expected1 > 0n && withdrawBounds.amount1Min === 0n) {
        throw new Error('withdraw amount1Min resolved to zero for non-zero expected principal');
      }

      const withdrawDeadline = this.deadline();
      const guardedData = guardInterface.encodeFunctionData('guardedWithdrawAndClaim', [
        [
          plan.pool.key.currency0,
          plan.pool.key.currency1,
          plan.pool.key.fee,
          plan.pool.key.tickSpacing,
          plan.pool.key.hooks
        ],
        plan.position.tickLower,
        plan.position.tickUpper,
        BigInt(plan.position.shares),
        this.config.walletAddress,
        withdrawBounds.amount0Min,
        withdrawBounds.amount1Min,
        BigInt(withdrawDeadline),
        this.config.fablesWalk
      ]);

      journal = this.patchJournal(journal, {
        phase: 'withdraw_preflighted',
        withdraw: {
          expected0: withdrawBounds.expected0.toString(),
          expected1: withdrawBounds.expected1.toString(),
          amount0Min: withdrawBounds.amount0Min.toString(),
          amount1Min: withdrawBounds.amount1Min.toString(),
          deadline: withdrawDeadline,
          walk: this.config.fablesWalk
        }
      });

      const withdrawReceipt = await this.sendVerifiedTx({
        label: 'guardedWithdrawAndClaim',
        to: this.config.walletAddress,
        data: guardedData,
        value: 0n,
        onSent: (hash) => {
          phase = 'withdraw_sent';
          journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, withdraw: hash } });
        }
      });
      phase = 'withdraw_confirmed';
      journal = this.patchJournal(journal, {
        phase,
        tx: { ...journal.tx, withdraw: withdrawReceipt.hash || journal.tx.withdraw }
      });

      const oldShares = await this.readPositionShares(plan.pool, plan.position.id);
      if (oldShares !== 0n) throw new Error(`Old LP shares remain after full withdraw: ${oldShares}`);

      const postWithdrawBalances = await this.readRawPairBalances(plan.pool);
      const withdrawn = positiveOperationDelta(preBalances, postWithdrawBalances);
      if (withdrawn.raw0 === 0n && withdrawn.raw1 === 0n) {
        throw new Error('Withdraw confirmed but no token principal/fees reached the wallet');
      }
      journal = this.patchJournal(journal, {
        postWithdrawBalancesRaw: stringifyRawBalances(postWithdrawBalances),
        withdrawnRaw: { raw0: withdrawn.raw0.toString(), raw1: withdrawn.raw1.toString() }
      });

      const postWithdrawState = await this.fables.readPoolState(plan.pool);
      const targetAfterWithdraw = buildTargetRange(
        postWithdrawState.tick,
        plan.pool.key.tickSpacing,
        this.config.tightWidthBps,
        this.config.rangePreset
      );
      const swapPlan = await buildExactBalancedSwapPlan({
        pool: plan.pool,
        quoter: this.quoter,
        rawAmount0: withdrawn.raw0,
        rawAmount1: withdrawn.raw1,
        sqrtPriceX96: postWithdrawState.sqrtPriceX96,
        tickLower: targetAfterWithdraw.tickLower,
        tickUpper: targetAfterWithdraw.tickUpper,
        slippageBps: this.config.swapSlippageBps
      });
      journal = this.patchJournal(journal, {
        targetAfterWithdraw,
        swapPlan: serializeSwapPlan(swapPlan)
      });

      let postSwapBalances = postWithdrawBalances;
      if (swapPlan.direction !== 'none') {
        const inputToken = swapPlan.tokenIn === 0 ? plan.pool.token0 : plan.pool.token1;
        await this.ensureSwapAllowances(inputToken, swapPlan.rawAmountIn);

        const swapDeadline = this.deadline();
        const request = this.router.buildV4ExactInputSingle({
          pool: plan.pool,
          quote: swapPlan.quote,
          deadline: swapDeadline
        });
        await this.router.simulateV4ExactInputSingle({
          pool: plan.pool,
          quote: swapPlan.quote,
          deadline: swapDeadline,
          from: this.config.walletAddress
        });
        const beforeSwap = postWithdrawBalances;
        const swapReceipt = await this.sendVerifiedTx({
          label: 'v4SwapExactInputSingle',
          to: request.router,
          data: request.data,
          value: request.value,
          onSent: (hash) => {
            phase = 'swap_sent';
            journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, swap: hash } });
          }
        });
        phase = 'swap_confirmed';
        postSwapBalances = await this.readRawPairBalances(plan.pool);
        this.assertSwapReceiptBalances(plan.pool, swapPlan, beforeSwap, postSwapBalances);
        journal = this.patchJournal(journal, {
          phase,
          tx: { ...journal.tx, swap: swapReceipt.hash || journal.tx.swap },
          postSwapBalancesRaw: stringifyRawBalances(postSwapBalances)
        });
      } else {
        phase = 'swap_not_required';
        journal = this.patchJournal(journal, { phase });
      }

      const strategyInventory = operationDelta(preBalances, postSwapBalances);
      if (strategyInventory.raw0 < 0n || strategyInventory.raw1 < 0n) {
        throw new Error('Post-swap strategy inventory crossed below the pre-rebalance wallet baseline');
      }
      if (strategyInventory.raw0 === 0n && strategyInventory.raw1 === 0n) {
        throw new Error('No strategy inventory remains for redeposit');
      }

      let postSwapState = await this.fables.readPoolState(plan.pool);
      let finalTarget = buildTargetRange(
        postSwapState.tick,
        plan.pool.key.tickSpacing,
        this.config.tightWidthBps,
        this.config.rangePreset
      );
      let exactDeposit = buildExactDepositPlan({
        rawAmount0: strategyInventory.raw0,
        rawAmount1: strategyInventory.raw1,
        sqrtPriceX96: postSwapState.sqrtPriceX96,
        tickLower: finalTarget.tickLower,
        tickUpper: finalTarget.tickUpper,
        slippageBps: this.config.depositSlippageBps,
        liquidityReserveBps: this.config.depositLiquidityReserveBps
      });
      if (exactDeposit.liquidity <= 0n || exactDeposit.liquidity > MAX_UINT128) {
        throw new Error('Exact deposit liquidity is invalid');
      }
      await this.ensureHookAllowance(plan.pool.token0, plan.pool.key.hooks, exactDeposit.amount0Max);
      await this.ensureHookAllowance(plan.pool.token1, plan.pool.key.hooks, exactDeposit.amount1Max);

      // Any allowance transaction, mempool delay, or swap can move the market.
      // Re-read slot0 immediately before deposit and rebuild range/liquidity/caps.
      postSwapState = await this.fables.readPoolState(plan.pool);
      finalTarget = buildTargetRange(
        postSwapState.tick,
        plan.pool.key.tickSpacing,
        this.config.tightWidthBps,
        this.config.rangePreset
      );
      exactDeposit = buildExactDepositPlan({
        rawAmount0: strategyInventory.raw0,
        rawAmount1: strategyInventory.raw1,
        sqrtPriceX96: postSwapState.sqrtPriceX96,
        tickLower: finalTarget.tickLower,
        tickUpper: finalTarget.tickUpper,
        slippageBps: this.config.depositSlippageBps,
        liquidityReserveBps: this.config.depositLiquidityReserveBps
      });
      if (exactDeposit.liquidity <= 0n || exactDeposit.liquidity > MAX_UINT128) {
        throw new Error('Recomputed exact deposit liquidity is invalid');
      }

      const depositDeadline = this.deadline();
      const depositData = this.fables.encodeDeposit(
        plan.pool,
        finalTarget,
        exactDeposit.liquidity,
        exactDeposit.amount0Max,
        exactDeposit.amount1Max,
        depositDeadline
      );
      journal = this.patchJournal(journal, {
        phase: 'deposit_preflighted',
        finalTarget,
        exactDeposit: serializeDepositPlan(exactDeposit),
        strategyInventoryRaw: {
          raw0: strategyInventory.raw0.toString(),
          raw1: strategyInventory.raw1.toString()
        }
      });

      const depositReceipt = await this.sendVerifiedTx({
        label: 'fablesDeposit',
        to: plan.pool.key.hooks,
        data: depositData,
        value: 0n,
        onSent: (hash) => {
          phase = 'deposit_sent';
          journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, deposit: hash } });
        }
      });
      phase = 'deposit_confirmed';
      const depositEvent = this.findWalletDepositEvent(plan.pool, depositReceipt);
      if (!depositEvent) throw new Error('Deposit receipt is missing the wallet Deposited event');

      // Shared hooks can manage multiple PoolKeys. Prove that the minted range is
      // exactly the pool + ticks this execution intended, not merely "some range"
      // emitted by the same hook.
      const mintedRange = await this.fables.readRangeKey(plan.pool, depositEvent.rangeId);
      if (
        !mintedRange.exists ||
        !samePoolKeyLocal(mintedRange.key, plan.pool.key) ||
        Number(mintedRange.tickLower) !== finalTarget.tickLower ||
        Number(mintedRange.tickUpper) !== finalTarget.tickUpper
      ) {
        throw new Error('Deposit receipt minted an unexpected PoolKey/range');
      }

      const newShares = await this.readPositionShares(plan.pool, depositEvent.rangeId);
      if (newShares <= 0n) throw new Error('Deposit confirmed but no new ERC-6909 LP shares were minted');
      const oldSharesAfter = await this.readPositionShares(plan.pool, plan.position.id);
      if (oldSharesAfter !== 0n && depositEvent.rangeId.toLowerCase() !== plan.position.id.toLowerCase()) {
        throw new Error('Old LP shares reappeared after new-range deposit');
      }

      journal = this.patchJournal(journal, {
        phase: 'completed',
        completedAt: Date.now(),
        tx: { ...journal.tx, deposit: depositReceipt.hash || journal.tx.deposit },
        newPosition: {
          rangeId: depositEvent.rangeId,
          liquidity: depositEvent.liquidity.toString(),
          shares: newShares.toString(),
          tickLower: finalTarget.tickLower,
          tickUpper: finalTarget.tickUpper
        }
      });
      this.clearJournal();

      this.ledger.append('rebalance.completed', {
        poolId: plan.pool.id,
        pair: journal.pair,
        oldPositionId: plan.position.id,
        newPositionId: depositEvent.rangeId,
        withdrawHash: journal.tx.withdraw,
        swapHash: journal.tx.swap || null,
        depositHash: journal.tx.deposit,
        target: finalTarget
      });
      return {
        status: 'completed',
        withdrawHash: journal.tx.withdraw,
        swapHash: journal.tx.swap || null,
        depositHash: journal.tx.deposit,
        newPositionId: depositEvent.rangeId,
        target: finalTarget
      };
    } catch (error) {
      const afterCapitalMoved = [
        'withdraw_sent',
        'withdraw_confirmed',
        'swap_sent',
        'swap_confirmed',
        'swap_not_required',
        'deposit_preflighted',
        'deposit_sent',
        'deposit_confirmed'
      ].includes(phase);
      if (afterCapitalMoved) {
        let balances = null;
        try { balances = await this.readRawPairBalances(plan.pool); } catch {}
        journal = this.patchJournal(journal, {
          phase: 'recovery_required',
          failedAt: Date.now(),
          error: error.message,
          currentBalancesRaw: balances ? stringifyRawBalances(balances) : null
        });
        this.ledger.append('rebalance.recovery_required', jsonSafe(journal));
      } else {
        this.patchJournal(journal, { phase: 'failed', failedAt: Date.now(), error: error.message });
      }
      throw error;
    }
  }

  assertNoUnfinishedExecution() {
    if (!this.state) return;
    const active = this.state.getSetting('activeRebalanceExecution', null);
    if (!active || !active.phase) return;
    const terminal = new Set(['completed', 'failed']);
    if (terminal.has(active.phase)) return;
    throw new Error(
      `Unfinished rebalance execution requires recovery before new writes: ${active.phase} (${active.id || 'unknown'})`
    );
  }

  async assertLiveReady(plan) {
    if (!this.config.enableAutoRedeploy) throw new Error('ENABLE_AUTO_REDEPLOY is not enabled');
    if (!this.signer) throw new Error('PRIVATE_KEY is missing');
    if (this.signer.address.toLowerCase() !== this.config.walletAddress.toLowerCase()) {
      throw new Error('PRIVATE_KEY does not match WALLET_ADDRESS');
    }
    if (!this.config.eip7702GuardAddress || !this.config.eip7702GuardVerified) {
      throw new Error('EIP-7702 atomic OOR guard is not configured and verified');
    }
    if (
      plan.pool.token0.address.toLowerCase() === ZERO_ADDRESS ||
      plan.pool.token1.address.toLowerCase() === ZERO_ADDRESS
    ) {
      throw new Error('Native-token live rebalance is not enabled');
    }
    await this.assertAtomicGuardReady();
    await this.assertGasGuard();
  }

  async assertAtomicGuardReady() {
    const code = (await this.readProvider.getCode(this.config.walletAddress)).toLowerCase();
    const expected = ('0xef0100' + this.config.eip7702GuardAddress.slice(2)).toLowerCase();
    if (code !== expected) {
      throw new Error(`Wallet is not delegated to the verified EIP-7702 guard: expected ${expected}, got ${code}`);
    }
    const versionData = guardInterface.encodeFunctionData('guardVersion', []);
    const rawVersion = await this.readProvider.call({
      from: this.config.walletAddress,
      to: this.config.walletAddress,
      data: versionData
    });
    const [version] = guardInterface.decodeFunctionResult('guardVersion', rawVersion);
    const expectedVersion = id('Fables7702Guard/v1');
    if (String(version).toLowerCase() !== expectedVersion.toLowerCase()) {
      throw new Error(`Unexpected EIP-7702 guard version: expected ${expectedVersion}, got ${version}`);
    }
    const implementationData = guardInterface.encodeFunctionData('IMPLEMENTATION', []);
    const rawImplementation = await this.readProvider.call({
      from: this.config.walletAddress,
      to: this.config.walletAddress,
      data: implementationData
    });
    const [implementation] = guardInterface.decodeFunctionResult('IMPLEMENTATION', rawImplementation);
    if (String(implementation).toLowerCase() !== this.config.eip7702GuardAddress.toLowerCase()) {
      throw new Error(
        `Unexpected EIP-7702 guard implementation: expected ${this.config.eip7702GuardAddress}, got ${implementation}`
      );
    }
  }

  async assertPlanStillOutOfRange(plan, phase) {
    const latestState = await this.fables.readPoolState(plan.pool);
    const outside = isLpOutOfRange(
      latestState.tick,
      plan.position.tickLower,
      plan.position.tickUpper
    );
    plan.currentTick = latestState.tick;
    plan.pool.state = latestState;

    if (outside) {
      const excursionPct = outOfRangeExcursionPct(
        latestState.tick,
        plan.position.tickLower,
        plan.position.tickUpper
      );
      if (
        plan.position.rebalanceReason === 'deep_oor_confirmed'
        && excursionPct <= this.config.oorShallowThresholdPct
      ) {
        const details = {
          positionId: plan.position.id,
          poolId: plan.pool.id,
          pair: `${plan.pool.token0.symbol}/${plan.pool.token1.symbol}`,
          reason: 'deep OOR faded below threshold before executor',
          phase,
          latestTick: latestState.tick,
          excursionPct,
          thresholdPct: this.config.oorShallowThresholdPct
        };
        this.ledger.append('rebalance.blocked', details);
        log('info', 'rebalance.deep_oor_faded', details);
        throw new Error(
          `Deep OOR faded to ${excursionPct.toFixed(4)}%, below ${this.config.oorShallowThresholdPct}% threshold`
        );
      }
      return latestState;
    }

    const details = {
      positionId: plan.position.id,
      poolId: plan.pool.id,
      pair: `${plan.pool.token0.symbol}/${plan.pool.token1.symbol}`,
      reason: 'absolute in-range hold',
      phase,
      latestTick: latestState.tick,
      tickLower: plan.position.tickLower,
      tickUpper: plan.position.tickUpper
    };
    this.ledger.append('rebalance.blocked', details);
    log('warn', 'rebalance.in_range_hold', details);
    throw new Error(
      `Absolute in-range hold: refusing LP withdrawal at tick ${latestState.tick} within [${plan.position.tickLower}, ${plan.position.tickUpper})`
    );
  }

  async readRawPairBalances(pool) {
    const [raw0, raw1] = await Promise.all([
      this.readRawTokenBalance(pool.token0),
      this.readRawTokenBalance(pool.token1)
    ]);
    return { raw0, raw1 };
  }

  async readRawTokenBalance(token) {
    if (token.address.toLowerCase() === ZERO_ADDRESS) {
      return this.readProvider.getBalance(this.config.walletAddress);
    }
    const contract = new Contract(token.address, ERC20_ABI, this.readProvider);
    return BigInt(await contract.balanceOf(this.config.walletAddress));
  }

  async readPositionShares(pool, rangeId) {
    const hook = new Contract(pool.key.hooks, HOOK_ABI, this.readProvider);
    return BigInt(await hook.balanceOf(this.config.walletAddress, rangeId));
  }

  async ensureSwapAllowances(token, rawAmountIn) {
    if (token.address.toLowerCase() === ZERO_ADDRESS) throw new Error('Native input is not enabled');
    const tokenContract = new Contract(token.address, ERC20_ABI, this.readProvider);
    let erc20Allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, PERMIT2));
    if (erc20Allowance < rawAmountIn) {
      if (erc20Allowance > 0n) {
        await this.sendVerifiedTx({
          label: `approve:${token.symbol}:permit2:reset`,
          to: token.address,
          data: erc20Interface.encodeFunctionData('approve', [PERMIT2, 0n]),
          value: 0n
        });
      }
      await this.sendVerifiedTx({
        label: `approve:${token.symbol}:permit2`,
        to: token.address,
        data: erc20Interface.encodeFunctionData('approve', [PERMIT2, MAX_UINT256]),
        value: 0n
      });
      erc20Allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, PERMIT2));
      if (erc20Allowance < rawAmountIn) throw new Error('ERC20 -> Permit2 allowance did not update');
    }

    const permit2 = new Contract(PERMIT2, PERMIT2_ABI, this.readProvider);
    const allowance = await permit2.allowance(
      this.config.walletAddress,
      token.address,
      UNISWAP_UNIVERSAL_ROUTER_212
    );
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(allowance.amount) < rawAmountIn || Number(allowance.expiration) <= now + this.config.txDeadlineSec) {
      const expiration = now + this.config.permit2ExpirationSec;
      await this.sendVerifiedTx({
        label: `permit2:${token.symbol}:router`,
        to: PERMIT2,
        data: permit2Interface.encodeFunctionData('approve', [
          token.address,
          UNISWAP_UNIVERSAL_ROUTER_212,
          MAX_UINT160,
          expiration
        ]),
        value: 0n
      });
      const updated = await permit2.allowance(
        this.config.walletAddress,
        token.address,
        UNISWAP_UNIVERSAL_ROUTER_212
      );
      if (BigInt(updated.amount) < rawAmountIn || Number(updated.expiration) <= now + this.config.txDeadlineSec) {
        throw new Error('Permit2 -> Universal Router allowance did not update');
      }
    }
  }

  async ensureHookAllowance(token, hookAddress, rawAmount) {
    rawAmount = BigInt(rawAmount);
    if (rawAmount === 0n) return;
    if (token.address.toLowerCase() === ZERO_ADDRESS) throw new Error('Native Fables deposits are not enabled');
    const tokenContract = new Contract(token.address, ERC20_ABI, this.readProvider);
    let allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, hookAddress));
    if (allowance >= rawAmount) return;
    if (allowance > 0n) {
      await this.sendVerifiedTx({
        label: `approve:${token.symbol}:hook:reset`,
        to: token.address,
        data: erc20Interface.encodeFunctionData('approve', [hookAddress, 0n]),
        value: 0n
      });
    }
    await this.sendVerifiedTx({
      label: `approve:${token.symbol}:hook`,
      to: token.address,
      // Fables deposit amount caps are uint128. Never grant a dynamic hook
      // more ERC20 allowance than the ABI can actually consume per deposit.
      data: erc20Interface.encodeFunctionData('approve', [hookAddress, MAX_UINT128]),
      value: 0n
    });
    allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, hookAddress));
    if (allowance < rawAmount) throw new Error(`${token.symbol} -> Fables hook allowance did not update`);
  }

  assertSwapReceiptBalances(pool, swapPlan, before, after) {
    const inputBefore = swapPlan.tokenIn === 0 ? before.raw0 : before.raw1;
    const inputAfter = swapPlan.tokenIn === 0 ? after.raw0 : after.raw1;
    const outputBefore = swapPlan.tokenOut === 0 ? before.raw0 : before.raw1;
    const outputAfter = swapPlan.tokenOut === 0 ? after.raw0 : after.raw1;
    const spent = inputBefore - inputAfter;
    const received = outputAfter - outputBefore;
    if (spent !== swapPlan.rawAmountIn) {
      throw new Error(`Swap receipt input mismatch for exact-in request: spent ${spent}, expected ${swapPlan.rawAmountIn}`);
    }
    if (received < BigInt(swapPlan.quote.minRawAmountOut)) {
      throw new Error(`Swap receipt output below minOut: ${received} < ${swapPlan.quote.minRawAmountOut}`);
    }
  }

  findWalletDepositEvent(pool, receipt) {
    const walletTopic = zeroPadValue(this.config.walletAddress, 32).toLowerCase();
    const entry = (receipt.logs || []).find((logEntry) =>
      String(logEntry.address).toLowerCase() === pool.key.hooks.toLowerCase()
      && String(logEntry.topics?.[0] || '').toLowerCase() === depositedTopic
      && String(logEntry.topics?.[1] || '').toLowerCase() === walletTopic
      && logEntry.topics?.[2]
    );
    if (!entry) return null;
    return {
      rangeId: String(entry.topics[2]).toLowerCase(),
      liquidity: BigInt(entry.data || 0)
    };
  }

  async sendVerifiedTx({ label, to, data, value = 0n, onSent = null }) {
    await this.assertGasGuard();
    const request = { to, data, value: BigInt(value) };
    await this.readProvider.call({ ...request, from: this.config.walletAddress });
    const gasEstimate = await this.signer.estimateGas(request);
    const tx = await this.signer.sendTransaction({
      ...request,
      gasLimit: gasEstimate * 120n / 100n
    });
    this.ledger.append('tx.sent', { label, hash: tx.hash, to, gasEstimate: gasEstimate.toString() });
    if (onSent) onSent(tx.hash);
    const receipt = await tx.wait(this.config.confirmations);
    if (!receipt || receipt.status !== 1) throw new Error(`${label} failed: ${tx.hash}`);
    const gasPrice = receipt.gasPrice || tx.gasPrice || 0n;
    const gasEth = Number(formatUnits(receipt.gasUsed * gasPrice, 18));
    const ethUsd = Number(this.getUsdPrice?.(ZERO_ADDRESS) || 0);
    this.ledger.append('tx.confirmed', {
      label,
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      gasPriceWei: gasPrice.toString(),
      gasEth,
      gasUsd: ethUsd > 0 ? gasEth * ethUsd : 0
    });
    return receipt;
  }

  async assertGasGuard() {
    const feeData = await this.writeProvider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
    if (!gasPrice) return;
    const maxWei = BigInt(Math.floor(Number(this.config.maxGasGwei) * 1e9));
    if (gasPrice > maxWei) {
      throw new Error(`Gas guard: ${formatUnits(gasPrice, 'gwei')} gwei > ${this.config.maxGasGwei} gwei`);
    }
  }

  deadline() {
    return Math.floor(Date.now() / 1000) + this.config.txDeadlineSec;
  }

  saveJournal(journal) {
    if (this.state) this.state.setSetting('activeRebalanceExecution', jsonSafe(journal));
  }

  patchJournal(journal, patch) {
    const next = { ...journal, ...patch, updatedAt: Date.now() };
    this.saveJournal(next);
    return next;
  }

  clearJournal() {
    if (this.state) this.state.setSetting('activeRebalanceExecution', null);
  }
}

function serializablePlan(plan) {
  return {
    poolId: plan.pool.id,
    pair: `${plan.pool.token0.symbol}/${plan.pool.token1.symbol}`,
    hook: plan.pool.key.hooks,
    currentTick: plan.currentTick,
    position: {
      id: plan.position.id,
      tickLower: plan.position.tickLower,
      tickUpper: plan.position.tickUpper,
      shares: plan.position.shares.toString()
    },
    target: plan.target,
    inventoryPlan: plan.inventoryPlan || null,
    quote: plan.quote || null,
    depositPlan: plan.depositPlan || null
  };
}

function samePoolKeyLocal(left, right) {
  if (!left || !right) return false;
  return String(left.currency0).toLowerCase() === String(right.currency0).toLowerCase()
    && String(left.currency1).toLowerCase() === String(right.currency1).toLowerCase()
    && Number(left.fee) === Number(right.fee)
    && Number(left.tickSpacing) === Number(right.tickSpacing)
    && String(left.hooks).toLowerCase() === String(right.hooks).toLowerCase();
}

function operationDelta(before, after) {
  return { raw0: after.raw0 - before.raw0, raw1: after.raw1 - before.raw1 };
}
function positiveOperationDelta(before, after) {
  const delta = operationDelta(before, after);
  return {
    raw0: delta.raw0 > 0n ? delta.raw0 : 0n,
    raw1: delta.raw1 > 0n ? delta.raw1 : 0n
  };
}
function stringifyRawBalances(value) {
  return { raw0: value.raw0.toString(), raw1: value.raw1.toString() };
}
function serializeSwapPlan(plan) {
  return {
    direction: plan.direction,
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    rawAmountIn: plan.rawAmountIn?.toString?.() || '0',
    quote: plan.quote || null
  };
}
function serializeDepositPlan(plan) {
  return {
    provisional: false,
    basis: plan.basis,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    liquidity: plan.liquidity.toString(),
    required0: plan.required0.toString(),
    required1: plan.required1.toString(),
    amount0Max: plan.amount0Max.toString(),
    amount1Max: plan.amount1Max.toString()
  };
}
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v));
}
