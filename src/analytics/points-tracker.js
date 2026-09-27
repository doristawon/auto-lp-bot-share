import { dailyPointBudget, utcDayKey } from './points.js';
import { fetchOfficialPoints, fetchWalletFeeEvidence } from './points-evidence.js';
import { FABLES_POINTS_END_MS } from '../constants.js';

const EVIDENCE_REFRESH_MS = 60_000;
const DAY_MS = 86_400_000;

export class PointsTracker {
  constructor(config, ledger, state) {
    this.config = config;
    this.ledger = ledger;
    this.state = state;
    this.cachedSnapshot = null;
    this.lastSimulationAt = 0;
    this.lastEvidenceAttemptAt = 0;
    this.evidencePromise = null;
    this.walletEvidence = null;
    this.evidenceError = null;
    if (this.state.getSetting('actualPointsBaseline', null) == null && config.actualPointsBaseline > 0) {
      this.state.setSetting('actualPointsBaseline', config.actualPointsBaseline);
      this.state.setSetting('actualPointsBaselineAt', config.actualPointsBaselineAt || new Date().toISOString());
    }
  }

  setActualBaseline(points, at = new Date().toISOString()) {
    this.state.setSetting('actualPointsBaseline', Number(points) || 0);
    this.state.setSetting('actualPointsBaselineAt', at);
    this.ledger.append('points.actual_baseline', { points: Number(points) || 0, at });
    this.invalidate();
  }

  async refreshEvidence({ address, provider, pools, prices, force = false }) {
    if (!address || !provider || !pools?.length || !prices?.size) return;
    if (this.evidencePromise) return this.evidencePromise;
    if (!force && Date.now() - this.lastEvidenceAttemptAt < EVIDENCE_REFRESH_MS) return;
    this.lastEvidenceAttemptAt = Date.now();
    this.evidencePromise = this.fetchAndApplyEvidence({ address, provider, pools, prices });
    try { return await this.evidencePromise; }
    finally { this.evidencePromise = null; }
  }

  async fetchAndApplyEvidence(context) {
    const [officialResult, walletResult] = await Promise.allSettled([
      fetchOfficialPoints(context.address),
      fetchWalletFeeEvidence(context)
    ]);
    if (walletResult.status === 'fulfilled') {
      const evidence = walletResult.value;
      const localHashes = new Set(this.ledger.all()
        .filter((event) => ['lp.deposit', 'lp.withdraw', 'tx.confirmed'].includes(event.type))
        .map((event) => String(event.hash || '').toLowerCase()));
      evidence.localTxCount = evidence.transactionHashes.length;
      evidence.localTxMatched = evidence.transactionHashes.filter((hash) => localHashes.has(hash)).length;
      delete evidence.transactionHashes;
      this.walletEvidence = evidence;
    }
    if (officialResult.status === 'fulfilled') {
      this.applyOfficialSettlement(officialResult.value, walletResult.status === 'fulfilled' ? walletResult.value : null);
    }
    this.evidenceError = [officialResult, walletResult]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason?.message || 'points evidence unavailable').join('; ') || null;
    this.invalidate();
  }

  applyOfficialSettlement(official, walletEvidence) {
    const prior = this.state.getSetting('pointsOfficial', null);
    const priorForWallet = prior?.wallet === official.wallet ? prior : null;
    if (priorForWallet && Number(priorForWallet.settledAt) > official.settledAt) return;
    if (priorForWallet && Number(priorForWallet.settledAt) < official.settledAt) {
      const addedPoints = official.lpPoints - Number(priorForWallet.lpPoints || 0);
      const addedFees = official.settledFeesUsd - Number(priorForWallet.settledFeesUsd || 0);
      if (addedPoints >= 0 && addedFees > 0.005) {
        this.state.setSetting('pointsCalibration', {
          wallet: official.wallet, pointsPerFeeUsd: addedPoints / addedFees,
          feeUsd: addedFees, points: addedPoints,
          programmeDayEnd: official.settledAt, source: 'consecutive-official-settlements'
        });
      }
    } else if (!priorForWallet && walletEvidence?.firstDepositAt != null &&
               walletEvidence.firstDepositAt >= official.settledAt - DAY_MS &&
               walletEvidence.firstDepositAt < official.settledAt &&
               official.lpPoints > 0 && official.settledFeesUsd > 0.005) {
      // This wallet first entered LP within this one settled programme day.
      this.state.setSetting('pointsCalibration', {
        wallet: official.wallet, pointsPerFeeUsd: official.lpPoints / official.settledFeesUsd,
        feeUsd: official.settledFeesUsd, points: official.lpPoints,
        programmeDayEnd: official.settledAt, source: 'first-wallet-lp-day'
      });
    }
    if (!priorForWallet || priorForWallet.settledAt !== official.settledAt ||
        priorForWallet.lpPoints !== official.lpPoints || priorForWallet.referralPoints !== official.referralPoints ||
        priorForWallet.settledFeesUsd !== official.settledFeesUsd) {
      this.ledger.appendUnique(`points-settled:${official.wallet}:${official.settledAt}`, 'points.official_settlement', {
        settledAt: official.settledAt, lpPoints: official.lpPoints,
        referralPoints: official.referralPoints, settledFeesUsd: official.settledFeesUsd,
        source: 'Fables points API'
      });
      this.state.setSetting('pointsOfficial', official);
    }
  }

  invalidate() { this.cachedSnapshot = null; }

  snapshot({ force = false } = {}) {
    const intervalMs = this.config.pointsSimulationIntervalMs || 15_000;
    const now = Date.now();
    if (!force && this.cachedSnapshot && now - this.lastSimulationAt < intervalMs) {
      return this.snapshotWithSchedule(intervalMs);
    }
    const official = this.state.getSetting('pointsOfficial', null);
    const manualBaseline = Number(this.state.getSetting('actualPointsBaseline', 0) || 0);
    const manualBaselineAt = this.state.getSetting('actualPointsBaselineAt', null);
    const baseline = official ? official.lpPoints + official.referralPoints : manualBaseline;
    const calibration = this.state.getSetting('pointsCalibration', null);
    const matchingEvidence = official && this.walletEvidence?.wallet === official.wallet ? this.walletEvidence : null;
    const matchingCalibration = official && calibration?.wallet === official.wallet ? calibration : null;
    const observedUnsettledFees = matchingEvidence
      ? matchingEvidence.lifetimeFeeUsd - official.settledFeesUsd : null;
    const unsettledFeeUsd = observedUnsettledFees != null && observedUnsettledFees >= -0.05
      ? Math.max(0, observedUnsettledFees) : null;
    const currentBudget = dailyPointBudget(Math.min(now, FABLES_POINTS_END_MS - 1));
    const settledBudget = matchingCalibration ? dailyPointBudget(matchingCalibration.programmeDayEnd - 1) : 0;
    const pointsPerFeeUsd = matchingCalibration && settledBudget > 0
      ? matchingCalibration.pointsPerFeeUsd * currentBudget / settledBudget : null;
    const estimatedDelta = unsettledFeeUsd != null && pointsPerFeeUsd != null
      ? unsettledFeeUsd * pointsPerFeeUsd : null;
    const buckets = {};
    for (const day of official?.history || []) {
      const key = utcDayKey(day.settledAt - 1);
      buckets[key] = {
        source: 'official', timestampMs: day.settledAt - 1,
        estimatedPoints: null, actualPoints: day.lpPoints + day.referralPoints, userFeeUsd: null
      };
    }
    if (unsettledFeeUsd != null) {
      const key = utcDayKey(now);
      buckets[key] = {
        source: 'estimate', timestampMs: now, estimatedPoints: estimatedDelta,
        actualPoints: null, userFeeUsd: unsettledFeeUsd
      };
    }
    this.cachedSnapshot = {
      source: official ? 'official-wallet-calibrated' : 'manual-only',
      actualBaseline: baseline,
      actualBaselineAt: official ? new Date(official.settledAt).toISOString() : manualBaselineAt,
      settledLpPoints: official?.lpPoints ?? null,
      settledReferralPoints: official?.referralPoints ?? null,
      settledFeeUsd: official?.settledFeesUsd ?? null,
      officialSettledAt: official?.settledAt ?? null,
      actualPointsFromFables: Boolean(official),
      walletFeeEvidence: matchingEvidence,
      unsettledFeeUsd,
      calibratedPointsPerFeeUsd: pointsPerFeeUsd,
      calibrationSource: matchingCalibration?.source || null,
      estimatedDelta,
      estimatedTotal: estimatedDelta == null ? null : baseline + estimatedDelta,
      evidenceError: this.evidenceError,
      buckets
    };
    this.lastSimulationAt = now;
    return this.snapshotWithSchedule(intervalMs);
  }

  snapshotWithSchedule(intervalMs) {
    return {
      ...this.cachedSnapshot,
      simulatedAt: this.lastSimulationAt,
      simulationIntervalMs: intervalMs,
      nextSimulationAt: this.lastSimulationAt + intervalMs
    };
  }
}
