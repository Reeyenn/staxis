'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { getInventoryPipelineHealth } from '@/lib/db';
import type { InventoryPipelineHealth as Health } from '@/lib/db/ml-inventory-cockpit';
import { Activity, CheckCircle2, AlertTriangle } from 'lucide-react';

/**
 * Pipeline health + breakage detector.
 *
 * Reeyen wants ONE place to look that says "everything is good" or
 * "something broke, here's what." Logic:
 *
 *   • Last training run > 8 days ago    → red banner ("training overdue")
 *   • Last prediction > 36 hours ago    → red banner ("predictions stale")
 *   • Both fresh                        → green banner ("all systems healthy")
 *   • No data yet (Day 0)               → blue info banner ("warming up — first run pending")
 *
 * Below the banner, individual rows show timestamps so you can see the
 * specific component that's stale.
 */
export function InventoryPipelineHealth() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [data, setData] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    (async () => {
      try {
        setData(await getInventoryPipelineHealth(activePropertyId));
      } catch (err) {
        console.error('InventoryPipelineHealth: fetch error', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, activePropertyId]);

  const status = computeStatus(data);

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          System health
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          If anything breaks, you’ll see it here first.
        </p>
      </div>

      {loading || !data ? (
        <div style={{ color: '#7a8a9e', fontSize: '13px' }}>Loading…</div>
      ) : (
        <>
          {/* Banner */}
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

          {/* Detail rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <Row
              label="Last training run"
              value={fmt(data.lastTrainingRunAt)}
              healthy={isFresh(data.lastTrainingRunAt, 8 * 86400)}
            />
            <Row
              label="Last prediction write"
              value={fmt(data.lastInferenceWriteAt)}
              healthy={isFresh(data.lastInferenceWriteAt, 36 * 3600)}
            />
            <Row
              label="Last anomaly fired"
              value={fmt(data.lastAnomalyFiredAt)}
              healthy={true /* never firing is fine — it's not a breakage */}
            />
            <Row
              label="Active item models"
              value={String(data.activeItemCount)}
              healthy={true}
            />
            <Row
              label="Predictions in last 24h"
              value={String(data.predictionsLast24h)}
              healthy={true}
            />
          </div>
        </>
      )}
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

function computeStatus(data: Health | null): ComputedStatus {
  if (!data) {
    return {
      headline: 'Loading…',
      detail: '',
      bg: '#f7fafb',
      border: 'rgba(78,90,122,0.12)',
      color: '#454652',
      icon: <Activity size={18} />,
    };
  }

  const trainOk = isFresh(data.lastTrainingRunAt, 8 * 86400);
  const predOk = isFresh(data.lastInferenceWriteAt, 36 * 3600);
  const everRanTraining = !!data.lastTrainingRunAt;
  const everRanPrediction = !!data.lastInferenceWriteAt;

  // Bootstrap state — system has never run yet
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

  // Healthy state
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

  // Something is stale
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

function isFresh(d: Date | null, maxAgeSec: number): boolean {
  if (!d) return false;
  return (Date.now() - d.getTime()) / 1000 <= maxAgeSec;
}

function fmt(d: Date | null): string {
  if (!d) return 'Never';
  const ms = Date.now() - d.getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} hr ago`;
  const days = Math.round(hr / 24);
  return `${days} days ago`;
}

function Row({ label, value, healthy }: { label: string; value: string; healthy: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingBottom: '12px',
      borderBottom: '1px solid rgba(78,90,122,0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#7a8a9e', fontSize: '12px' }}>
        <span style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: healthy ? '#00a050' : '#dc3545',
          flexShrink: 0,
        }} />
        <span>{label}</span>
      </div>
      <div style={{
        fontSize: '13px',
        color: healthy ? '#1b1c19' : '#b21e2f',
        fontWeight: healthy ? 500 : 600,
      }}>{value}</div>
    </div>
  );
}
