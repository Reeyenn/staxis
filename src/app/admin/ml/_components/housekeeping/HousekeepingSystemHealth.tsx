'use client';

import React from 'react';
import { Activity, CheckCircle2, AlertTriangle } from 'lucide-react';
import { formatNextCron } from '@/lib/ml-cron-schedule';

/**
 * Housekeeping system health panel — banner-driven view of "is the
 * pipeline OK?" Mirrors InventoryPipelineHealth but shows HK-specific rows.
 */

const TRAINING_FRESH_SEC = 8 * 86400;
const PREDICTION_FRESH_SEC = 36 * 3600;

interface CommonProps {
  lastTrainingRunAt: string | null;
  lastInferenceWriteAt: string | null;
  lastOverrideAt: string | null;
  activeModelRunCount: number;
  predictionsLast24h: number;
  optimizerActive: boolean;
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

export function HousekeepingSystemHealth(props: SingleModeProps | FleetModeProps) {
  const status = computeStatus(props);

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          {props.mode === 'single' ? 'System health' : 'System health — network'}
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          {props.mode === 'single'
            ? 'If anything breaks, you’ll see it here first.'
            : 'Aggregated health across the fleet. Red banner = at least one hotel is broken.'}
        </p>
      </div>

      <div style={{
        padding: '14px 16px',
        background: status.bg,
        border: `1px solid ${status.border}`,
        borderRadius: '10px',
        color: status.color,
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        marginBottom: '20px',
      }}>
        {status.icon}
        <div>
          <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '2px' }}>
            {status.headline}
          </div>
          <div style={{ fontSize: '12px', opacity: 0.85, lineHeight: 1.5 }}>
            {status.detail}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
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
      </div>
    </div>
  );
}

interface ComputedStatus {
  headline: string;
  detail: string;
  bg: string;
  border: string;
  color: string;
  icon: React.ReactNode;
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
      detail: `Training, predictions, and override tracking are running on schedule across the network. ${healthCounts.warming > 0 ? `(${healthCounts.warming} new hotel${healthCounts.warming === 1 ? '' : 's'} still warming.)` : ''}`,
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
      detail: 'Training, predictions, and override tracking are all running on schedule.',
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

function isFresh(d: string | null, maxAgeSec: number): boolean {
  if (!d) return false;
  return (Date.now() - new Date(d).getTime()) / 1000 <= maxAgeSec;
}

function fmt(d: string | null): string {
  if (!d) return 'Never';
  const ms = Date.now() - new Date(d).getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} hr ago`;
  const days = Math.round(hr / 24);
  return `${days} days ago`;
}

function Row({ label, value, healthy, subtitle }: { label: string; value: string; healthy: boolean; subtitle?: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      paddingBottom: '12px',
      borderBottom: '1px solid rgba(78,90,122,0.06)',
      gap: '12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#7a8a9e', fontSize: '12px', paddingTop: '2px' }}>
        <span style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: healthy ? '#00a050' : '#dc3545',
          flexShrink: 0,
        }} />
        <span>{label}</span>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{
          fontSize: '13px',
          color: healthy ? '#1b1c19' : '#b21e2f',
          fontWeight: healthy ? 500 : 600,
        }}>{value}</div>
        {subtitle && (
          <div style={{ fontSize: '11px', color: '#7a8a9e', marginTop: '2px', fontFamily: "'JetBrains Mono', monospace" }}>
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
