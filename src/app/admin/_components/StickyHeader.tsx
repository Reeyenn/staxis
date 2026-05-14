'use client';

/**
 * Sticky header for /admin — always visible above the four tabs.
 *
 * Shows the at-a-glance stats Reeyen wants without clicking anything:
 * live hotels, hotels mid-onboarding, errors today, active jobs, MRR
 * (or pilot indicator). Plus the alerts bell (Phase 3) and the four
 * tab buttons.
 *
 * Stats refresh every 15s. The tab state lives in the parent page so
 * URL ?tab=… can deep-link into a specific tab if we add that later.
 */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AlertsBell } from './AlertsBell';

export type AdminTab = 'onboarding' | 'live' | 'system' | 'money' | 'agent';

const TABS: { id: AdminTab; label: string }[] = [
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'live', label: 'Live hotels' },
  { id: 'system', label: 'System' },
  { id: 'money', label: 'Money' },
  { id: 'agent', label: 'Agent' },
];

interface Stats {
  liveHotels: number;
  onboarding: number;
  errorsToday: number;
  activeJobs: number;
  mrrCents: number | null;
  pilotMode: boolean;
}

interface Props {
  activeTab: AdminTab;
  onTabChange: (t: AdminTab) => void;
}

export function StickyHeader({ activeTab, onTabChange }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    try {
      const res = await fetchWithAuth('/api/admin/overview-stats');
      const json = await res.json();
      if (res.ok && json.ok) setStats(json.data);
    } catch {
      // Silent — header just shows last-known values until next tick.
    }
  };

  useEffect(() => {
    void load();
    const tick = () => {
      refreshTimer.current = setTimeout(async () => {
        await load();
        tick();
      }, 15_000);
    };
    tick();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  return (
    <div style={{
      position: 'sticky',
      top: '64px', // sits below the global Header.tsx (height 64)
      zIndex: 30,
      background: 'rgba(251, 249, 244, 0.92)',
      backdropFilter: 'blur(48px)',
      WebkitBackdropFilter: 'blur(48px)',
      borderBottom: '1px solid var(--border)',
      padding: '12px 24px',
      marginLeft: '-24px',
      marginRight: '-24px',
      marginTop: '-24px',
      marginBottom: '20px',
    }}>
      {/* Stats row */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '14px',
        marginBottom: '12px',
        fontSize: '13px',
      }}>
        <Stat label="Live hotels" value={stats?.liveHotels} />
        <Dot />
        <Stat label="Onboarding" value={stats?.onboarding} />
        <Dot />
        <Stat label="Errors today" value={stats?.errorsToday} color={(stats?.errorsToday ?? 0) > 0 ? 'var(--red)' : undefined} />
        <Dot />
        <Stat label="Active jobs" value={stats?.activeJobs} color={(stats?.activeJobs ?? 0) > 0 ? 'var(--amber)' : undefined} />
        <Dot />
        <span style={{ color: 'var(--text-muted)' }}>
          MRR: <strong style={{ color: 'var(--text-primary)', marginLeft: '4px' }}>
            {stats?.pilotMode ? 'Pilot mode' : stats?.mrrCents != null ? `$${(stats.mrrCents / 100).toLocaleString()}` : '—'}
          </strong>
        </span>

        <div style={{ marginLeft: 'auto' }}>
          <AlertsBell />
        </div>
      </div>

      {/* Tab buttons */}
      <div style={{ display: 'flex', gap: '4px' }}>
        {TABS.map((t) => {
          const active = t.id === activeTab;
          return (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              style={{
                padding: '10px 16px',
                fontSize: '13px',
                fontWeight: active ? 600 : 500,
                color: active ? '#364262' : 'var(--text-muted)',
                background: active ? 'var(--surface-primary)' : 'transparent',
                border: 'none',
                borderBottom: `2px solid ${active ? '#364262' : 'transparent'}`,
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
                transition: 'color 0.15s, background 0.15s',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number | undefined; color?: string }) {
  return (
    <span style={{ color: 'var(--text-muted)' }}>
      {label}:{' '}
      <strong style={{
        color: color ?? 'var(--text-primary)',
        marginLeft: '4px',
        fontFamily: 'var(--font-mono)',
      }}>
        {value ?? '—'}
      </strong>
    </span>
  );
}

function Dot() {
  return <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>·</span>;
}
