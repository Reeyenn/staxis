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
 * System health panel — single banner-driven view of "is the pipeline OK?"
 *
 * Two modes:
 *   • "single" — one hotel; banner says healthy / warming / issue
 *   • "fleet"  — aggregate; banner says "X of Y hotels healthy" with red
 *                state if any hotel has an issue
 *
 * Detail rows below the banner show specific timestamps + counts. The card
 * chrome (header, banner, Row, fmt/isFresh, freshness constants) is shared
 * with HousekeepingSystemHealth via MlSystemHealthShell; only computeStatus
 * and the rows below are inventory-specific.
 */

interface CommonProps {
  lastTrainingRunAt: string | null;
  lastInferenceWriteAt: string | null;
  lastAnomalyFiredAt: string | null;
  activeItemModelCount: number;
  predictionsLast24h: number;
  nextTrainingAt: string;
  nextPredictionAt: string;
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

export function InventoryPipelineHealth(props: SingleModeProps | FleetModeProps) {
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
        label="Last anomaly fired"
        value={fmt(props.lastAnomalyFiredAt)}
        healthy
      />
      <Row
        label="Active item models"
        value={String(props.activeItemModelCount)}
        healthy
      />
      <Row
        label="Predictions in last 24h"
        value={String(props.predictionsLast24h)}
        healthy
      />
    </MlSystemHealthShell>
  );
}

function computeStatus(props: SingleModeProps | FleetModeProps): ComputedStatus {
  if (props.mode === 'fleet') {
    const { healthCounts, hotelCount } = props;
    if (healthCounts.issue > 0) {
      return {
        headline: `${healthCounts.issue} ${healthCounts.issue === 1 ? 'hotel' : 'hotels'} with issues`,
        detail: `${healthCounts.healthy} healthy, ${healthCounts.warming} warming, ${healthCounts.issue} with stale training or predictions. Click into a hotel below to drill in.`,
        bg: 'rgba(220,52,69,0.06)',
        border: 'rgba(220,52,69,0.20)',
        color: '#b21e2f',
        icon: <AlertTriangle size={18} />,
      };
    }
    if (healthCounts.warming === hotelCount) {
      return {
        headline: 'All hotels warming up',
        detail: 'No hotel has done its first training run yet. The next scheduled cron will kick them off; nothing for you to do.',
        bg: 'rgba(0,101,101,0.06)',
        border: 'rgba(0,101,101,0.18)',
        color: '#006565',
        icon: <Activity size={18} />,
      };
    }
    return {
      headline: `All ${hotelCount} ${hotelCount === 1 ? 'hotel' : 'hotels'} healthy`,
      detail: `Training, predictions, and anomaly detection are running on schedule across the network. ${healthCounts.warming > 0 ? `(${healthCounts.warming} new hotel${healthCounts.warming === 1 ? '' : 's'} still warming.)` : ''}`,
      bg: 'rgba(0,160,80,0.06)',
      border: 'rgba(0,160,80,0.20)',
      color: '#00733a',
      icon: <CheckCircle2 size={18} />,
    };
  }

  // single mode
  const trainOk = isFresh(props.lastTrainingRunAt, TRAINING_FRESH_SEC);
  const predOk = isFresh(props.lastInferenceWriteAt, PREDICTION_FRESH_SEC);
  const everRanTraining = !!props.lastTrainingRunAt;
  const everRanPrediction = !!props.lastInferenceWriteAt;

  if (!everRanTraining && !everRanPrediction) {
    return {
      headline: 'Warming up',
      detail: 'The AI hasn’t done its first training run yet. The next scheduled cron will kick it off; nothing for you to do.',
      bg: 'rgba(0,101,101,0.06)',
      border: 'rgba(0,101,101,0.18)',
      color: '#006565',
      icon: <Activity size={18} />,
    };
  }

  if (trainOk && predOk) {
    return {
      headline: 'All systems healthy',
      detail: 'Training, predictions, and anomaly detection are all running on schedule.',
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
    detail: `${issues.join(' and ')}. The cron schedule may be failing — check GitHub Actions and Railway service health.`,
    bg: 'rgba(220,52,69,0.06)',
    border: 'rgba(220,52,69,0.20)',
    color: '#b21e2f',
    icon: <AlertTriangle size={18} />,
  };
}
