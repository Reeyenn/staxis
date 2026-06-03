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

  // Bright tones — the stat strip sits on the dark canvas now.
  const stats: { label: string; node: React.ReactNode }[] = [
    { label: 'Live', node: <StatVal v={ov?.liveHotels} tone="var(--forest)" /> },
    { label: 'Onboarding', node: <StatVal v={ov?.onboarding} tone="var(--gold)" /> },
    { label: 'Errors', node: <StatVal v={ov?.errorsToday} tone={(ov?.errorsToday ?? 0) > 0 ? 'var(--terracotta)' : '#fff'} /> },
    { label: 'Jobs', node: <StatVal v={ov?.activeJobs} tone="var(--teal)" /> },
    {
      label: 'MRR',
      node: ov?.pilotMode
        ? <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 15, color: 'var(--forest)' }}>Pilot</span>
        : <StatVal text={ov?.mrrCents != null ? usd(ov.mrrCents) : undefined} tone="#fff" />,
    },
  ];

  return (
    <div className="admin-studio" style={{
      background: 'var(--ink)', color: '#fff',
      // Full-bleed: break out of AppLayout's centered max-width (1920) so the
      // dark admin canvas spans the whole viewport below the global nav. On
      // viewports ≤1920 the margins compute to ~0 (already full width); wider
      // monitors get pulled out to the edges. macOS overlay scrollbars → no
      // stray horizontal scrollbar.
      marginLeft: 'calc(50% - 50vw)', marginRight: 'calc(50% - 50vw)',
      minHeight: 'calc(100vh - 64px)',
    }}>
      {/* Dark sticky sub-header — live stat strip + tabs, just below the 64px
          global nav. Part of the same continuous dark admin canvas; the site
          nav + wordmark live above it so we don't repeat them here. */}
      <div style={{
        position: 'sticky', top: 64, zIndex: 30,
        background: 'var(--ink)',
        borderBottom: '1px solid rgba(255,255,255,.10)',
      }}>
        <div style={{ padding: '0 32px' }}>
          {/* Row 1 — live stat strip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 22, height: 50, borderBottom: '1px solid rgba(255,255,255,.07)' }}>
            <div style={{ display: 'flex', gap: 26, alignItems: 'center', overflowX: 'auto' }}>
              {stats.map((s) => (
                <div key={s.label} style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexShrink: 0 }}>
                  <span className="caps" style={{ fontSize: 8.5, whiteSpace: 'nowrap', color: 'rgba(255,255,255,.5)' }}>{s.label}</span>
                  <span>{s.node}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 'auto' }}>
              <span data-studio-pulse style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--forest)', display: 'inline-block', animation: 'studio-pulse 1.6s ease-in-out infinite' }} />
              <span className="mono" style={{ fontSize: 10, color: 'rgba(255,255,255,.4)', whiteSpace: 'nowrap' }}>
                refreshed {refreshedAgo < 60 ? `${refreshedAgo}s` : `${Math.floor(refreshedAgo / 60)}m`}
              </span>
            </div>
          </div>
          {/* Row 2 — tabs */}
          <div style={{ display: 'flex', gap: 4, height: 50, alignItems: 'stretch', overflowX: 'auto' }}>
            {TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button key={t.id} onClick={() => go(t.id)} style={{
                  background: 'transparent', border: 'none', padding: '0 16px', cursor: 'pointer',
                  fontFamily: FONT_SANS, fontSize: 14, fontWeight: active ? 700 : 500,
                  color: active ? '#fff' : 'rgba(255,255,255,.5)', whiteSpace: 'nowrap',
                  borderBottom: `2px solid ${active ? 'var(--forest)' : 'transparent'}`, transition: 'color .15s',
                }}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Stage — surfaces render full-width on the dark canvas (each provides
          its own padding + radial glow via SurfaceShell). */}
      <div ref={stageRef} key={tab} style={{ paddingBottom: 64 }}>
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
  return <span className="mono" style={{ fontFamily: FONT_MONO, fontSize: 16, fontWeight: 700, color: v == null && text === undefined ? 'rgba(255,255,255,.4)' : tone, whiteSpace: 'nowrap' }}>{display}</span>;
}
