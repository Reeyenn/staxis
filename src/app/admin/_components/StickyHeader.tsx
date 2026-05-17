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

export type AdminTab = 'onboarding' | 'live' | 'system' | 'money' | 'agent' | 'ml';

const TABS: { id: AdminTab; label: string }[] = [
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'live', label: 'Live hotels' },
  { id: 'system', label: 'System' },
  { id: 'money', label: 'Money' },
  { id: 'agent', label: 'Agent' },
  { id: 'ml', label: 'ML' },
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
      padding: '10px 48px 0',
      marginLeft: '-48px',
      marginRight: '-48px',
      marginTop: '-24px',
      marginBottom: 20,
    }}>
      {/* Compact stats strip — caps label + mono number on one line.
          Bell sits inline on the right. */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap',
        gap: 0, marginBottom: 10,
        border: `1px solid ${T.rule}`,
        borderRadius: 999, background: T.paper,
        padding: '0 6px', height: 38,
        overflow: 'hidden',
      }}>
        <StatCell label="Live" value={stats?.liveHotels} />
        <Divider />
        <StatCell label="Onboarding" value={stats?.onboarding} />
        <Divider />
        <StatCell label="Errors" value={stats?.errorsToday}
          tone={(stats?.errorsToday ?? 0) > 0 ? 'warm' : 'neutral'} />
        <Divider />
        <StatCell label="Jobs" value={stats?.activeJobs}
          tone={(stats?.activeJobs ?? 0) > 0 ? 'caramel' : 'neutral'} />
        <Divider />
        <StatCell
          label="MRR"
          customValue={stats?.pilotMode
            ? <span style={{ fontFamily: FONT_SERIF, fontSize: 14, fontStyle: 'italic', color: T.sageDeep }}>Pilot</span>
            : stats?.mrrCents != null
              ? <MonoNum size={13} weight={600} c={T.sageDeep}>${(stats.mrrCents / 100).toLocaleString()}</MonoNum>
              : <MonoNum size={13} c={T.ink3}>—</MonoNum>
          }
        />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingRight: 4 }}>
          <AlertsBell />
        </div>
      </div>

      {/* Tab buttons — Snow style: ghost ink, active = sage underline */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const active = t.id === activeTab;
          return (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              style={{
                position: 'relative',
                padding: '8px 16px',
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

function Divider() {
  return <span style={{ width: 1, height: 18, background: T.rule, flexShrink: 0 }} />;
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
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '0 14px', height: '100%',
    }}>
      <Caps size={9}>{label}</Caps>
      {customValue ? (
        customValue
      ) : (
        <MonoNum size={13} weight={600} c={value == null ? T.ink3 : toneColor}>
          {value ?? '—'}
        </MonoNum>
      )}
    </div>
  );
}
