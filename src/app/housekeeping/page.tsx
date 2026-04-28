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
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { ScheduleTab } from './_components/ScheduleTab';
import { RoomsTab } from './_components/RoomsTab';
import { DeepCleanTab } from './_components/DeepCleanTab';
import { PerformanceTab } from './_components/PerformanceTab';

// ─── Tab config ──────────────────────────────────────────────────────────────

type TabKey = 'rooms' | 'schedule' | 'deepclean' | 'performance';

const TABS: { key: TabKey; label: string; labelEs: string }[] = [
  { key: 'rooms',       label: 'Rooms',        labelEs: 'Habitaciones'   },
  { key: 'schedule',    label: 'Schedule',     labelEs: 'Horario'        },
  { key: 'deepclean',   label: 'Deep Clean',   labelEs: 'Limpieza Prof.' },
  { key: 'performance', label: 'Performance',  labelEs: 'Rendimiento'    },
];

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

export default function HousekeepingPage() {
  const [activeTab, setActiveTabState] = useState<TabKey>('rooms');
  const { lang } = useLang();
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
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
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  return (
    <AppLayout>
      {/* ── Sub-tab bar (Stitch pill style) ── */}
      <div style={{ padding: '16px 24px 0', position: 'sticky', top: 64, zIndex: 10, background: 'var(--bg)' }}>
        <nav style={{
          display: 'flex', alignItems: 'center', gap: '32px',
          borderBottom: '1px solid rgba(197,197,212,0.25)',
          paddingBottom: '0',
        }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.key;
            const tabLabel = tab.key === 'deepclean' ? (lang === 'es' ? tab.labelEs : tab.label) : undefined;
            const tabLabelKey = tab.key === 'rooms' ? 'rooms' : tab.key === 'schedule' ? 'scheduling' : tab.key === 'deepclean' ? undefined : 'performance';
            return (
              <button
                key={tab.key}
                className="hk-tab-btn"
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: '8px 0 12px',
                  border: 'none',
                  borderRadius: 0,
                  background: 'none',
                  color: isActive ? '#1b1c19' : '#757684',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: '15px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontFamily: "'Inter', sans-serif",
                  transition: 'all 150ms',
                  boxShadow: 'none',
                  borderBottom: isActive ? '2px solid #1b1c19' : '2px solid transparent',
                  letterSpacing: '-0.01em',
                  marginBottom: '-1px',
                }}
              >
                {tabLabel ?? (tabLabelKey ? t(tabLabelKey, lang) : '')}
              </button>
            );
          })}
        </nav>
      </div>

      {/* ── Section content ──
          Wrapped in a keyed div so React remounts the wrapper on tab
          switch, which re-triggers the CSS .animate-in fade-up. Same
          cascade-in feel as the dashboard page. The tab subcomponents
          themselves are unchanged. */}
      <div key={activeTab} className="animate-in stagger-1">
        {activeTab === 'schedule'    && <ScheduleTab />}
        {activeTab === 'rooms'       && <RoomsTab />}
        {activeTab === 'deepclean'   && <DeepCleanTab />}
        {activeTab === 'performance' && <PerformanceTab />}
      </div>
    </AppLayout>
  );
}
