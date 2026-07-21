'use client';


export const dynamic = 'force-dynamic';
// Split from 6094-line monolith on 2026-04-27. Each tab now lives in _components/:
// - ScheduleTab.tsx: Schedule tab (assignment planning)
// - RoomsTab.tsx: Rooms tab (live status board)
// - DeepCleanTab.tsx: Deep clean tab (config + records)
// - QualityTab.tsx: Quality & performance (merged Inspections + Performance,
//   June 2026 — replaces the former two separate tabs)
//
// This page.tsx is now just the tab orchestrator — routes between tabs,
// persists tab choice to localStorage, handles auth guards. No section
// functions remain in this file; they're all in _components/.

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { ScheduleTab } from './_components/ScheduleTab';
import { RoomsTab } from './_components/RoomsTab';
import { DeepCleanTab } from './_components/DeepCleanTab';
import { QualityTab } from './_components/QualityTab';
import { T, FONT_SANS } from './_components/_snow';

// ─── Tab config ──────────────────────────────────────────────────────────────

type TabKey = 'rooms' | 'schedule' | 'quality' | 'deepclean';

const TABS: { key: TabKey; label: string; labelEs: string }[] = [
  { key: 'rooms',     label: 'Rooms',      labelEs: 'Habitaciones'   },
  { key: 'schedule',  label: 'Schedule',   labelEs: 'Horario'        },
  { key: 'quality',   label: 'Quality',    labelEs: 'Calidad'        },
  { key: 'deepclean', label: 'Deep Clean', labelEs: 'Limpieza prof.' },
];

const housekeepingTabStore = {
  get(): string | null {
    try { return window.localStorage.getItem('hk-tab'); } catch { return null; }
  },
  set(tab: TabKey): void {
    try { window.localStorage.setItem('hk-tab', tab); } catch { /* storage can be blocked */ }
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

export default function HousekeepingPage() {
  const [activeTab, setActiveTabState] = useState<TabKey>('rooms');
  const tabRefs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});
  const { lang } = useLang();
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const router = useRouter();

  // Auth guard — redirect if not logged in or no property
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/property-selector');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Restore tab on mount. A `?tab=` deep-link (e.g. from the worklist) wins
  // over the saved choice; otherwise fall back to localStorage.
  useEffect(() => {
    const valid: TabKey[] = ['rooms', 'schedule', 'quality', 'deepclean'];
    const urlTab = new URLSearchParams(window.location.search).get('tab');
    if (urlTab && (valid as string[]).includes(urlTab)) {
      setActiveTabState(urlTab as TabKey);
      housekeepingTabStore.set(urlTab as TabKey);
      return;
    }
    const saved = housekeepingTabStore.get();
    // Legacy keys: the former Inspections / Performance tabs are now merged
    // into Quality, so anyone whose last tab was one of those lands on Quality.
    if (saved === 'inspections' || saved === 'performance') { setActiveTabState('quality'); return; }
    if (saved && (valid as string[]).includes(saved)) setActiveTabState(saved as TabKey);
  }, []);

  const setActiveTab = (tab: TabKey) => {
    setActiveTabState(tab);
    housekeepingTabStore.set(tab);
  };

  useEffect(() => {
    tabRefs.current[activeTab]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div style={{
          minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', fontFamily: FONT_SANS,
        }}>
          <div className="animate-spin" style={{
            width: '28px', height: '28px',
            border: `2px solid ${T.rule}`, borderTopColor: T.ink, borderRadius: '50%',
          }} />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      {/* ── Snow sub-tab bar ──
          Sticky just below the floating pill bar. Frosted (not solid white)
          so it sits on the Concourse page wash without a color seam; 1px
          hairline rule on the bottom, 1.5px ink underline on the active tab. */}
      <div className="hk-tab-shell" style={{
        background: 'rgba(255,255,255,.72)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: `1px solid ${T.rule}`,
        position: 'sticky', top: 64, zIndex: 10,
      }}>
        <nav className="hk-tab-list" aria-label={lang === 'es' ? 'Secciones de limpieza' : 'Housekeeping sections'}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.key;
            const label = lang === 'es' ? tab.labelEs : tab.label;
            return (
              <button
                key={tab.key}
                ref={(node) => { tabRefs.current[tab.key] = node; }}
                onClick={() => setActiveTab(tab.key)}
                aria-current={isActive ? 'page' : undefined}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  minHeight: 44, padding: '8px 0 10px', position: 'relative',
                  fontFamily: FONT_SANS, fontSize: 14,
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? T.ink : T.ink2,
                  borderBottom: isActive ? `1.5px solid ${T.ink}` : '1.5px solid transparent',
                  marginBottom: '-1px',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </div>

      <style>{`
        .hk-tab-shell { padding: 18px 48px 0; }
        .hk-tab-list {
          display: flex;
          gap: 28px;
          overflow-x: auto;
          overscroll-behavior-inline: contain;
          scrollbar-width: none;
        }
        .hk-tab-list::-webkit-scrollbar { display: none; }
        @media (max-width: 640px) {
          .hk-tab-shell { padding: 10px 16px 0; }
          .hk-tab-list { gap: 22px; scroll-snap-type: inline proximity; }
          .hk-tab-list > button { flex: 0 0 auto; scroll-snap-align: start; }
        }
      `}</style>

      {/* ── Tab content — keyed remount triggers the CSS .animate-in cascade ── */}
      <div key={activeTab} className="animate-in stagger-1">
        {activeTab === 'rooms'     && <RoomsTab />}
        {activeTab === 'schedule'  && <ScheduleTab />}
        {activeTab === 'quality'   && <QualityTab />}
        {activeTab === 'deepclean' && <DeepCleanTab />}
      </div>
    </AppLayout>
  );
}
