'use client';

import React from 'react';

/**
 * Shared chrome for the two ML system-health panels (housekeeping and
 * inventory). Both render the same card + header + status banner + a
 * vertical stack of health rows; only the per-domain `computeStatus` and the
 * specific rows differ. Those stay in HousekeepingSystemHealth /
 * InventoryPipelineHealth, which pass their computed status + rows here.
 */

/** Freshness thresholds shared by both panels. */
export const TRAINING_FRESH_SEC = 8 * 86400;
export const PREDICTION_FRESH_SEC = 36 * 3600;

export interface ComputedStatus {
  headline: string;
  detail: string;
  bg: string;
  border: string;
  color: string;
  icon: React.ReactNode;
}

export function isFresh(d: string | null, maxAgeSec: number): boolean {
  if (!d) return false;
  return (Date.now() - new Date(d).getTime()) / 1000 <= maxAgeSec;
}

export function fmt(d: string | null): string {
  if (!d) return 'Never';
  const ms = Date.now() - new Date(d).getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} hr ago`;
  const days = Math.round(hr / 24);
  return `${days} days ago`;
}

export function Row({ label, value, healthy, subtitle }: { label: string; value: string; healthy: boolean; subtitle?: string }) {
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

/**
 * The card + header + status banner + rows-stack wrapper. Domain panels pass
 * the mode (drives the header/subtitle copy), the precomputed status, and
 * their rows as children.
 */
export function MlSystemHealthShell({
  mode,
  status,
  children,
}: {
  mode: 'single' | 'fleet';
  status: ComputedStatus;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(78,90,122,0.12)',
      borderRadius: '12px',
      padding: '24px',
    }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          {mode === 'single' ? 'System health' : 'System health — network'}
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          {mode === 'single'
            ? 'If anything breaks, you’ll see it here first.'
            : 'Aggregated health across the fleet. Red banner = at least one hotel is broken.'}
        </p>
      </div>

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
        {children}
      </div>
    </div>
  );
}
