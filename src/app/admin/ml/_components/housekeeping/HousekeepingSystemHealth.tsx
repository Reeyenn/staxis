'use client';

import { Activity, CheckCircle2, AlertTriangle } from 'lucide-react';
import { formatNextCron } from '@/lib/ml-cron-schedule';
import {
  MlSystemHealthShell,
  Row,
  fmt,
  isFresh,
  TRAINING_FRESH_SEC,
  PREDICTION_FRESH_SEC,
  type ComputedStatus,
} from '../MlSystemHealthShell';

/**
 * Housekeeping system health panel — banner-driven view of "is the
 * pipeline OK?" Mirrors InventoryPipelineHealth but shows HK-specific rows.
 * The card chrome (header, banner, Row, fmt/isFresh, freshness constants) is
 * shared with InventoryPipelineHealth via MlSystemHealthShell; only
 * computeStatus and the rows below are housekeeping-specific.
 *
 * Phase 1.5 (2026-05-22): now surfaces three honesty rollups from the
 * cockpit-data response: warmingUp / capacityUnavailable / xgboostDeferred.
 * The banner text changes when any of these are non-zero so operators see
 * the system state in plain terms instead of just healthy/issue.
 *
 * Phase 2.3 (2026-05-22): also shows the last walk-forward backtest
 * accuracy when one has been run. Hidden when no backtest exists — no
 * fake "N/A" placeholder.
 */

interface CommonProps {
  lastTrainingRunAt: string | null;
  lastInferenceWriteAt: string | null;
  lastOverrideAt: string | null;
  activeModelRunCount: number;
  predictionsLast24h: number;
  optimizerActive: boolean;
  nextTrainingAt: string;
  nextPredictionAt: string;
  /**
   * Phase 1.5 honesty rollups. All optional with sensible defaults so
   * callers that haven't updated yet still render the existing banner.
   */
  warmingUpCount?: number;
  capacityUnavailableCount?: number;
  xgboostDeferredCount?: number;
  fullyFittedCount?: number;
  /**
   * Phase 2.3 walk-forward backtest summary. Optional — tile is hidden
   * when undefined. fittedOnlyMaeRatio drives the green/amber/red color
   * (matches production's validation_mae_ratio_threshold=0.10 scale).
   */
  backtest?: {
    runDate: string;
    layer: 'demand' | 'supply';
    fittedOnlyMae: number | null;
    fittedOnlyMaeRatio: number | null;
    daysFitted: number;
    daysColdStart: number;
    refusalReason: string | null;
  } | null;
  /**
   * Phase 7 v2 (2026-05-22) — statistical auto-rollback signals.
   * `lastAutoRollbackAt` is per-hotel (single mode) or fleet-max (fleet
   * mode). Counts are always fleet-wide and split real vs dry-run.
   * All optional — rendering uses sensible defaults when omitted.
   */
  lastAutoRollbackAt?: string | null;
  autoRollbacksLast7d?: number;
  dryRunRollbacksLast7d?: number;
}

interface SingleModeProps extends CommonProps {
  mode: 'single';
  hotelName: string;
}

interface FleetModeProps extends CommonProps {
  mode: 'fleet';
  hotelCount: number;
  healthCounts: { healthy: number; warming: number; issue: number };
}

export function HousekeepingSystemHealth(props: SingleModeProps | FleetModeProps) {
  const status = computeStatus(props);

  return (
    <MlSystemHealthShell mode={props.mode} status={status}>
        {props.mode === 'fleet' && (
          <Row
            label="Hotels by status"
            value={`${props.healthCounts.healthy} healthy · ${props.healthCounts.warming} warming · ${props.healthCounts.issue} issue`}
            healthy={props.healthCounts.issue === 0}
          />
        )}
        <Row
          label="Last training run"
          value={fmt(props.lastTrainingRunAt)}
          healthy={isFresh(props.lastTrainingRunAt, TRAINING_FRESH_SEC)}
          subtitle={formatNextCron(new Date(props.nextTrainingAt))}
        />
        <Row
          label="Last prediction write"
          value={fmt(props.lastInferenceWriteAt)}
          healthy={isFresh(props.lastInferenceWriteAt, PREDICTION_FRESH_SEC)}
          subtitle={formatNextCron(new Date(props.nextPredictionAt))}
        />
        <Row
          label="Last override (Maria)"
          value={fmt(props.lastOverrideAt)}
          healthy
        />
        <Row
          label="Active model runs"
          value={String(props.activeModelRunCount)}
          healthy
        />
        <Row
          label="Predictions in last 24h"
          value={String(props.predictionsLast24h)}
          healthy
        />
        <Row
          label="Optimizer (Layer 3)"
          value={props.optimizerActive ? 'Active' : 'Not yet activated'}
          healthy={props.optimizerActive}
        />
        {/* Phase 1.5 honesty rollup rows — render only when non-zero so
            the panel stays clean for fully-fitted hotels. */}
        {(props.warmingUpCount ?? 0) > 0 && (
          <Row
            label={props.mode === 'fleet' ? 'Hotels using industry benchmark' : 'Industry benchmark in use'}
            value={
              props.mode === 'fleet'
                ? `${props.warmingUpCount} hotel${props.warmingUpCount === 1 ? '' : 's'}`
                : 'Yes — still learning your hotel'
            }
            healthy={false}
            subtitle="Sharpens to your hotel's pattern after ~14 days of cleanings"
          />
        )}
        {(props.capacityUnavailableCount ?? 0) > 0 && (
          <Row
            label={props.mode === 'fleet' ? 'Capacity model unavailable' : 'Per-room model'}
            value={
              props.mode === 'fleet'
                ? `${props.capacityUnavailableCount} hotel${props.capacityUnavailableCount === 1 ? '' : 's'}`
                : 'Not active (<10 supply predictions today)'
            }
            healthy={false}
            subtitle="Recommendation is based on aggregate workload only"
          />
        )}
        {(props.xgboostDeferredCount ?? 0) > 0 && (
          <Row
            label="XGBoost-eligible"
            value={
              props.mode === 'fleet'
                ? `${props.xgboostDeferredCount} hotel${props.xgboostDeferredCount === 1 ? '' : 's'}`
                : 'Yes (>=500 events)'
            }
            healthy={false}
            subtitle="XGBoost inference not yet wired — using Bayesian fallback"
          />
        )}
        {/* Phase 7 v2 (2026-05-22) — statistical auto-rollback signals.
            Three rows: last rollback (hidden when null), safety mode
            (always shown so operators know dry-run vs live), 7-day
            count (hidden when 0+0). The fleet banner above also adds
            "K rollback(s) fired in last 7 days" to the detail line. */}
        {props.lastAutoRollbackAt && (
          <Row
            label="Last auto-rollback"
            value={fmt(props.lastAutoRollbackAt)}
            healthy={false}
            subtitle="Drift detector deactivated a model that was worse than naive baseline"
          />
        )}
        <Row
          label="Rollback safety mode"
          value={
            // Live mode if we've seen a real fire in the last 7 days.
            // Otherwise dry-run (the Phase 7 default, kept on for the
            // first 30 days while operators audit decisions).
            (props.autoRollbacksLast7d ?? 0) > 0
              ? 'Live (deactivates bad models)'
              : 'Dry-run (logs only — first 30 days)'
          }
          healthy={(props.autoRollbacksLast7d ?? 0) > 0}
          subtitle="Flip via AUTO_ROLLBACK_DRY_RUN env var on Railway (hot-reload)"
        />
        {((props.autoRollbacksLast7d ?? 0) + (props.dryRunRollbacksLast7d ?? 0)) > 0 && (
          <Row
            label="Rollbacks in last 7 days"
            value={
              (props.autoRollbacksLast7d ?? 0) > 0
                ? `${props.autoRollbacksLast7d} fired${(props.dryRunRollbacksLast7d ?? 0) > 0 ? ` · ${props.dryRunRollbacksLast7d} dry-run-only` : ''}`
                : `${props.dryRunRollbacksLast7d} would-have-fired (dry-run)`
            }
            healthy={(props.autoRollbacksLast7d ?? 0) === 0}
          />
        )}
        {/* Phase 2.3 walk-forward backtest tile. Hidden when no backtest
            exists — no fake "N/A" placeholder. Color uses ratio thresholds
            aligned with production's validation_mae_ratio_threshold=0.10. */}
        {props.backtest && (
          <Row
            label={`Last walk-forward backtest (${props.backtest.layer})`}
            value={
              props.backtest.refusalReason
                ? props.backtest.refusalReason
                : props.backtest.fittedOnlyMae !== null
                  ? `${Math.round(props.backtest.fittedOnlyMae)} min MAE`
                  : '—'
            }
            healthy={
              props.backtest.fittedOnlyMaeRatio !== null
              && props.backtest.fittedOnlyMaeRatio <= 0.05
            }
            subtitle={
              props.backtest.refusalReason
                ? `${props.backtest.daysFitted} fitted days · ${props.backtest.daysColdStart} cold-start days · run ${props.backtest.runDate}`
                : props.backtest.fittedOnlyMaeRatio !== null
                  ? `MAE/mean = ${(props.backtest.fittedOnlyMaeRatio * 100).toFixed(1)}% · run ${props.backtest.runDate}`
                  : `run ${props.backtest.runDate}`
            }
          />
        )}
    </MlSystemHealthShell>
  );
}

function computeStatus(props: SingleModeProps | FleetModeProps): ComputedStatus {
  // Phase 1.5 honesty rollup detail line — appended to the banner detail
  // whenever any layer is cold-start, capacity-unavailable, or
  // XGBoost-deferred. Keeps the headline color/icon driven by the existing
  // healthy/warming/issue logic; just adds an extra sentence operators see.
  const honestyDetail = (() => {
    const parts: string[] = [];
    const warm = props.warmingUpCount ?? 0;
    const cap = props.capacityUnavailableCount ?? 0;
    const xgb = props.xgboostDeferredCount ?? 0;
    if (warm > 0) parts.push(`${warm} hotel${warm === 1 ? '' : 's'} still warming up (industry benchmark)`);
    if (cap > 0) parts.push(`${cap} hotel${cap === 1 ? '' : 's'} with capacity model unavailable`);
    if (xgb > 0) parts.push(`${xgb} hotel${xgb === 1 ? '' : 's'} eligible for XGBoost (inference not yet wired)`);
    return parts.length > 0 ? ` ${parts.join('; ')}.` : '';
  })();

  if (props.mode === 'fleet') {
    const { healthCounts, hotelCount } = props;
    if (healthCounts.issue > 0) {
      return {
        headline: `${healthCounts.issue} ${healthCounts.issue === 1 ? 'hotel' : 'hotels'} with issues`,
        detail: `${healthCounts.healthy} healthy, ${healthCounts.warming} warming, ${healthCounts.issue} with stale training or predictions. Click into a hotel below to drill in.${honestyDetail}`,
        bg: 'rgba(220,52,69,0.06)',
        border: 'rgba(220,52,69,0.20)',
        color: '#b21e2f',
        icon: <AlertTriangle size={18} />,
      };
    }
    if (healthCounts.warming === hotelCount) {
      return {
        headline: 'All hotels warming up',
        detail: `No hotel has done its first training run yet. The next scheduled cron will kick them off; nothing for you to do.${honestyDetail}`,
        bg: 'rgba(0,101,101,0.06)',
        border: 'rgba(0,101,101,0.18)',
        color: '#006565',
        icon: <Activity size={18} />,
      };
    }
    // Phase 1.5: when any layer is in cold-start / capacity-unavailable,
    // demote the "All hotels healthy" headline to a more honest framing
    // so operators don't see green when the system is still learning.
    const anyNonFitted = (props.warmingUpCount ?? 0) > 0 || (props.capacityUnavailableCount ?? 0) > 0;
    if (anyNonFitted) {
      const fully = props.fullyFittedCount ?? 0;
      return {
        headline: `${fully} of ${hotelCount} fully fitted, rest still learning`,
        detail: `${fully} hotel${fully === 1 ? ' is' : 's are'} running fully-learned AI; the rest are on industry benchmarks or aggregate-only mode.${honestyDetail}`,
        bg: 'rgba(0,101,101,0.06)',
        border: 'rgba(0,101,101,0.18)',
        color: '#006565',
        icon: <Activity size={18} />,
      };
    }
    return {
      headline: `All ${hotelCount} ${hotelCount === 1 ? 'hotel' : 'hotels'} healthy`,
      detail: `Training, predictions, and override tracking are running on schedule across the network.${honestyDetail}`,
      bg: 'rgba(0,160,80,0.06)',
      border: 'rgba(0,160,80,0.20)',
      color: '#00733a',
      icon: <CheckCircle2 size={18} />,
    };
  }

  const trainOk = isFresh(props.lastTrainingRunAt, TRAINING_FRESH_SEC);
  const predOk = isFresh(props.lastInferenceWriteAt, PREDICTION_FRESH_SEC);
  const everRanTraining = !!props.lastTrainingRunAt;
  const everRanPrediction = !!props.lastInferenceWriteAt;

  if (!everRanTraining && !everRanPrediction) {
    return {
      headline: 'Warming up',
      detail: `The AI hasn’t done its first training run yet. The next scheduled cron will kick it off; nothing for you to do.${honestyDetail}`,
      bg: 'rgba(0,101,101,0.06)',
      border: 'rgba(0,101,101,0.18)',
      color: '#006565',
      icon: <Activity size={18} />,
    };
  }

  if (trainOk && predOk) {
    // Phase 1.5: single-hotel mode also demotes the green "healthy"
    // headline when this hotel is still on cohort priors or fell to the
    // L1-only path. Operators see "Warming up · industry benchmark" /
    // "Capacity model unavailable" instead of false confidence.
    const warm = props.warmingUpCount ?? 0;
    const cap = props.capacityUnavailableCount ?? 0;
    if (cap > 0) {
      return {
        headline: 'Capacity model unavailable',
        detail: `Per-room cleaning-time model is not yet active. Recommendation falls back to aggregate workload only.${honestyDetail}`,
        bg: 'rgba(0,101,101,0.06)',
        border: 'rgba(0,101,101,0.18)',
        color: '#006565',
        icon: <Activity size={18} />,
      };
    }
    if (warm > 0) {
      return {
        headline: 'Warming up — using industry benchmark',
        detail: `Predictions are based on cohort averages for hotels of your size. Will sharpen as your hotel's cleaning history accumulates.${honestyDetail}`,
        bg: 'rgba(0,101,101,0.06)',
        border: 'rgba(0,101,101,0.18)',
        color: '#006565',
        icon: <Activity size={18} />,
      };
    }
    return {
      headline: 'All systems healthy',
      detail: `Training, predictions, and override tracking are all running on schedule.${honestyDetail}`,
      bg: 'rgba(0,160,80,0.06)',
      border: 'rgba(0,160,80,0.20)',
      color: '#00733a',
      icon: <CheckCircle2 size={18} />,
    };
  }

  const issues: string[] = [];
  if (!trainOk) issues.push('weekly training is overdue');
  if (!predOk) issues.push('daily predictions are stale');
  return {
    headline: 'Issue detected',
    detail: `${issues.join(' and ')}. The cron schedule may be failing — check GitHub Actions and Railway service health.${honestyDetail}`,
    bg: 'rgba(220,52,69,0.06)',
    border: 'rgba(220,52,69,0.20)',
    color: '#b21e2f',
    icon: <AlertTriangle size={18} />,
  };
}
