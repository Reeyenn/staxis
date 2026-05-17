'use client';

/**
 * Sticky header for /admin — always visible above the five tabs.
 *
 * Snow design (May 2026):
 *   - Top stat row: caps mono labels + Instrument Serif italic numbers
 *   - Tab buttons: hairline pills, active = ink-solid with sage underline
 *
 * Stats refresh every 15s. The tab state lives in the parent page so URL
 * hash can deep-link into a specific tab.
 */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { AlertsBell } from './AlertsBell';
import { T, FONT_SANS, FONT_SERIF, Caps, MonoNum } from './_snow';

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
      background: 'rgba(255,255,255,0.92)',
      backdropFilter: 'blur(48px)',
      WebkitBackdropFilter: 'blur(48px)',
      borderBottom: `1px solid ${T.rule}`,
      padding: '18px 48px 0',
      marginLeft: '-48px',
      marginRight: '-48px',
      marginTop: '-24px',
      marginBottom: '32px',
    }}>
      {/* Page title row */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 24, flexWrap: 'wrap', marginBottom: 16,
      }}>
        <div>
          <Caps>Owner cockpit</Caps>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 36, fontWeight: 400,
            letterSpacing: '-0.02em', color: T.ink, margin: '4px 0 0',
            lineHeight: 1.15,
          }}>
            <span style={{ fontStyle: 'italic' }}>Staxis</span> Admin
          </h1>
        </div>
        <div style={{ flexShrink: 0 }}>
          <AlertsBell />
        </div>
      </div>

      {/* Stats row — caps label over italic-serif number, separated by hairlines */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 0,
        marginBottom: 20,
        border: `1px solid ${T.rule}`,
        borderRadius: 18, background: T.paper,
        overflow: 'hidden',
      }}>
        <StatCell label="Live hotels" value={stats?.liveHotels} />
        <StatCell label="Onboarding" value={stats?.onboarding} />
        <StatCell label="Errors today" value={stats?.errorsToday}
          tone={(stats?.errorsToday ?? 0) > 0 ? 'warm' : 'neutral'} />
        <StatCell label="Active jobs" value={stats?.activeJobs}
          tone={(stats?.activeJobs ?? 0) > 0 ? 'caramel' : 'neutral'} />
        <StatCell
          label="MRR"
          customValue={stats?.pilotMode
            ? <span style={{ fontFamily: FONT_SANS, fontSize: 22, fontStyle: 'italic', color: T.ink2 }}>Pilot</span>
            : stats?.mrrCents != null
              ? <MonoNum size={28} weight={500}>${(stats.mrrCents / 100).toLocaleString()}</MonoNum>
              : <MonoNum size={28} c={T.ink3}>—</MonoNum>
          }
          tone="sage"
        />
      </div>

      {/* Tab buttons — Snow style: ghost ink, active = solid-ink pill */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const active = t.id === activeTab;
          return (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              style={{
                position: 'relative',
                padding: '10px 18px',
                fontFamily: FONT_SANS,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                color: active ? T.ink : T.ink2,
                background: 'transparent',
                border: 'none',
                borderBottom: `2px solid ${active ? T.sageDeep : 'transparent'}`,
                marginBottom: -1,
                cursor: 'pointer',
                transition: 'color 0.15s',
                letterSpacing: '-0.005em',
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

function StatCell({
  label, value, customValue, tone = 'neutral',
}: {
  label: string;
  value?: number | null;
  customValue?: React.ReactNode;
  tone?: 'neutral' | 'sage' | 'warm' | 'caramel';
}) {
  const toneColor = {
    neutral: T.ink,
    sage:    T.sageDeep,
    warm:    T.warm,
    caramel: T.caramelDeep,
  }[tone];
  return (
    <div style={{
      flex: '1 1 160px', minWidth: 140,
      padding: '14px 18px',
      borderRight: `1px solid ${T.rule}`,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <Caps size={9}>{label}</Caps>
      {customValue ? (
        <div>{customValue}</div>
      ) : (
        <span style={{
          fontFamily: FONT_SERIF, fontStyle: 'italic',
          fontSize: 32, fontWeight: 400, lineHeight: 1, letterSpacing: '-0.03em',
          color: value == null ? T.ink3 : toneColor,
        }}>
          {value ?? '—'}
        </span>
      )}
    </div>
  );
}
