'use client';

// Split from 6094-line monolith on 2026-04-27. Each tab now lives in _components/:
// - ScheduleTab.tsx: Schedule tab (assignment planning)
// - RoomsTab.tsx: Rooms tab (live status board)
// - DeepCleanTab.tsx: Deep clean tab (config + records)
// - PerformanceTab.tsx: Performance tab (leaderboard + metrics)
//
// This page.tsx is now just the tab orchestrator — routes between tabs,
// persists tab choice to localStorage, handles auth guards. No section
// functions remain in this file; they're all in _components/.

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { ScheduleTab } from './_components/ScheduleTab';
import { RoomsTab } from './_components/RoomsTab';
import { DeepCleanTab } from './_components/DeepCleanTab';
import { PerformanceTab } from './_components/PerformanceTab';
import { T, FONT_SANS } from './_components/_snow';

// ─── Tab config ──────────────────────────────────────────────────────────────

type TabKey = 'rooms' | 'schedule' | 'deepclean' | 'performance';

const TABS: { key: TabKey; label: string; labelEs: string }[] = [
  { key: 'rooms',       label: 'Rooms',       labelEs: 'Habitaciones'    },
  { key: 'schedule',    label: 'Schedule',    labelEs: 'Horario'         },
  { key: 'performance', label: 'Performance', labelEs: 'Rendimiento'     },
  { key: 'deepclean',   label: 'Deep Clean',  labelEs: 'Limpieza prof.'  },
];

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

export default function HousekeepingPage() {
  const [activeTab, setActiveTabState] = useState<TabKey>('rooms');
  const { lang } = useLang();
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const router = useRouter();

  // Auth guard — redirect if not logged in or no property
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Restore tab from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('hk-tab') as TabKey | null;
    const valid: TabKey[] = ['rooms', 'schedule', 'deepclean', 'performance'];
    if (saved && valid.includes(saved)) setActiveTabState(saved);
  }, []);

  const setActiveTab = (tab: TabKey) => {
    setActiveTabState(tab);
    localStorage.setItem('hk-tab', tab);
  };

  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div style={{
          minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: T.bg, fontFamily: FONT_SANS,
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
          Sticky directly under the global Header (64px). White background,
          1px hairline rule on the bottom, 1.5px ink underline on the active
          tab — matches the design's SubTabBar from hk-shared.jsx. */}
      <div style={{
        padding: '18px 48px 0',
        background: T.bg,
        borderBottom: `1px solid ${T.rule}`,
        position: 'sticky', top: 64, zIndex: 10,
      }}>
        <nav style={{ display: 'flex', gap: '28px' }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.key;
            const label = lang === 'es' ? tab.labelEs : tab.label;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '8px 0 14px', position: 'relative',
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

      {/* ── Tab content — keyed remount triggers the CSS .animate-in cascade ── */}
      <div key={activeTab} className="animate-in stagger-1">
        {activeTab === 'rooms'       && <RoomsTab />}
        {activeTab === 'schedule'    && <ScheduleTab />}
        {activeTab === 'performance' && <PerformanceTab />}
        {activeTab === 'deepclean'   && <DeepCleanTab />}
      </div>
    </AppLayout>
  );
}
