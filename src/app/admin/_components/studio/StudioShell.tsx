'use client';

/* ───────────────────────────────────────────────────────────────────────
   Admin Studio shell — the redesigned /admin owner console (June 2026).

   Replaces the old StickyHeader + light Snow tabs with the design-handoff
   "Studio": a light blurred sticky sub-header (live stat strip + five tabs)
   over dark editorial surfaces. Rendered INSIDE the normal app shell
   (AppLayout) so the site's global nav (Dashboard · Housekeeping · … · Admin)
   stays on top — this is one section of the website, not a separate page.
   The sub-header sits just below that 64px global nav. Admin is gated
   server-side in src/app/admin/layout.tsx, with a client spinner during
   auth load.

   Five surfaces (Agent is folded into System, per the handoff):
     Onboarding · Live hotels · System & Agent · Money · ML

   Tab selection deep-links via the URL hash (#live etc.) so a refresh keeps
   you on the same surface — matches the prior console's behavior.
   ─────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import { FONT_SERIF, FONT_MONO, FONT_SANS, EASE_OUT, prefersReducedMotion, usd } from './kit';
import { OnboardingSurface } from './surfaces/OnboardingSurface';
import { LiveSurface } from './surfaces/LiveSurface';
import { SystemSurface } from './surfaces/SystemSurface';
import { MoneySurface } from './surfaces/MoneySurface';
import { MlSurface } from './surfaces/MlSurface';

export type StudioTab = 'onboarding' | 'live' | 'system' | 'money' | 'ml';

const TABS: { id: StudioTab; label: string }[] = [
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'live', label: 'Live hotels' },
  { id: 'system', label: 'System & Agent' },
  { id: 'money', label: 'Money' },
  { id: 'ml', label: 'ML' },
];

interface Overview {
  liveHotels: number;
  onboarding: number;
  errorsToday: number;
  activeJobs: number;
  mrrCents: number | null;
  pilotMode: boolean;
}

const VALID = new Set<string>(TABS.map((t) => t.id));
function readHashTab(): StudioTab {
  if (typeof window === 'undefined') return 'onboarding';
  const h = window.location.hash.replace('#', '');
  if (h === 'agent') return 'system'; // legacy deep-link → folded surface
  return VALID.has(h) ? (h as StudioTab) : 'onboarding';
}

export function StudioShell() {
  const [tab, setTab] = useState<StudioTab>('onboarding');
  const [ov, setOv] = useState<Overview | null>(null);
  const [refreshedAgo, setRefreshedAgo] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  // Deep-link the active tab to the URL hash.
  useEffect(() => {
    setTab(readHashTab());
    const onHash = () => setTab(readHashTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Overview stat strip — refresh every 15s (same cadence as the old header).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchWithAuth('/api/admin/overview-stats');
        const json = await res.json();
        if (alive && res.ok && json.ok) { setOv(json.data); setRefreshedAgo(0); }
      } catch { /* keep last-known values */ }
    };
    const loop = () => { timer.current = setTimeout(async () => { await load(); loop(); }, 15_000); };
    void load();
    loop();
    tick.current = setInterval(() => setRefreshedAgo((s) => s + 1), 1000);
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
      if (tick.current) clearInterval(tick.current);
    };
  }, []);

  const go = (t: StudioTab) => {
    setTab(t);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${t}`);
    }
  };

  // Rise-in when the surface changes.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 420, easing: EASE_OUT, fill: 'none' });
  }, [tab]);

  const stats: { label: string; node: React.ReactNode }[] = [
    { label: 'Live', node: <StatVal v={ov?.liveHotels} tone="var(--forest-deep)" /> },
    { label: 'Onboarding', node: <StatVal v={ov?.onboarding} tone="var(--gold-deep)" /> },
    { label: 'Errors', node: <StatVal v={ov?.errorsToday} tone={(ov?.errorsToday ?? 0) > 0 ? 'var(--terracotta)' : 'var(--ink)'} /> },
    { label: 'Jobs', node: <StatVal v={ov?.activeJobs} tone="var(--teal-deep)" /> },
    {
      label: 'MRR',
      node: ov?.pilotMode
        ? <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 15, color: 'var(--forest-deep)' }}>Pilot</span>
        : <StatVal text={ov?.mrrCents != null ? usd(ov.mrrCents) : undefined} tone="var(--ink)" />,
    },
  ];

  return (
    <div className="admin-studio">
      {/* Sticky sub-header — sits just below the global app nav (Header is
          64px tall). The site's own nav + wordmark live above this, so we
          don't repeat the wordmark here — just the live stat strip + tabs. */}
      <div style={{
        position: 'sticky', top: 64, zIndex: 30,
        background: 'rgba(255,255,255,.86)',
        backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)',
        borderBottom: '1px solid var(--rule)',
      }}>
        <div style={{ maxWidth: 1480, margin: '0 auto', padding: '0 28px' }}>
          {/* Row 1 — live stat strip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 22, height: 52, borderBottom: '1px solid var(--rule-soft)' }}>
            <div style={{ display: 'flex', gap: 24, alignItems: 'center', overflowX: 'auto' }}>
              {stats.map((s) => (
                <div key={s.label} style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexShrink: 0 }}>
                  <span className="caps" style={{ fontSize: 8.5, whiteSpace: 'nowrap' }}>{s.label}</span>
                  <span>{s.node}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 'auto' }}>
              <span data-studio-pulse style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--forest)', display: 'inline-block', animation: 'studio-pulse 1.6s ease-in-out infinite' }} />
              <span className="mono" style={{ fontSize: 10, color: 'var(--dim2)', whiteSpace: 'nowrap' }}>
                refreshed {refreshedAgo < 60 ? `${refreshedAgo}s` : `${Math.floor(refreshedAgo / 60)}m`}
              </span>
            </div>
          </div>
          {/* Row 2 — tabs */}
          <div style={{ display: 'flex', gap: 2, height: 50, alignItems: 'stretch', overflowX: 'auto' }}>
            {TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button key={t.id} onClick={() => go(t.id)} style={{
                  background: 'transparent', border: 'none', padding: '0 16px', cursor: 'pointer',
                  fontFamily: FONT_SANS, fontSize: 14, fontWeight: active ? 700 : 500,
                  color: active ? 'var(--ink)' : 'var(--dim)', whiteSpace: 'nowrap',
                  borderBottom: `2px solid ${active ? 'var(--forest)' : 'transparent'}`, transition: 'color .15s',
                }}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Stage */}
      <div ref={stageRef} key={tab} style={{ maxWidth: 1480, margin: '0 auto', padding: '26px 28px 80px' }}>
        {tab === 'onboarding' && <OnboardingSurface />}
        {tab === 'live' && <LiveSurface />}
        {tab === 'system' && <SystemSurface />}
        {tab === 'money' && <MoneySurface />}
        {tab === 'ml' && <MlSurface />}
      </div>
    </div>
  );
}

function StatVal({ v, text, tone }: { v?: number | null; text?: string; tone: string }) {
  const display = text !== undefined ? text : (v == null ? '—' : String(v));
  return <span className="mono" style={{ fontFamily: FONT_MONO, fontSize: 16, fontWeight: 700, color: v == null && text === undefined ? 'var(--dim2)' : tone, whiteSpace: 'nowrap' }}>{display}</span>;
}
