'use client';


export const dynamic = 'force-dynamic';
// Maintenance tab — board-based redesign (Claude Design handoff, Jun 2026).
//
// Three sub-tabs, each a triage/inventory board that lives in _components/:
//   Work orders — four-lane priority board (Low · Normal · Urgent · Professional)
//   Preventive  — three-band recurring-task board (Overdue · This month · Upcoming)
//   Equipment   — three-band storeroom board (Out · Low · In stock); was "Parts"
//
// The Compliance tab was removed from the Maintenance nav in this redesign. The
// engineering-compliance feature itself is untouched — its anomaly crons, the
// engineer SMS links (/engineer/[id]) and the dashboard summary all keep
// running; ComplianceTab.tsx is parked (unlinked) in _components/ so it can be
// re-linked if a new home is wanted. Pattern mirrors housekeeping/page.tsx —
// orchestrator only.

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { T, FONT_SANS, MTSubTabBar, MaintenanceErrorBoundary, type MaintenanceTabKey } from './_components/_mt-snow';
import { WorkOrdersTab } from './_components/WorkOrdersTab';
import { PreventiveTab } from './_components/PreventiveTab';
import { EquipmentTab } from './_components/EquipmentTab';

// Storage can throw in privacy-mode / sandboxed / SSR contexts — guard both
// get and set so a blocked localStorage never blanks the whole screen.
const STORAGE_KEY = 'mt-tab3'; // bumped from 'mt-tab' so old 'compliance'/'parts' values don't resolve
const VALID_TABS: MaintenanceTabKey[] = ['work', 'preventive', 'equipment'];
const safeStore = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export default function MaintenancePage() {
  const [tab, setTabState] = useState<MaintenanceTabKey>('work');
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const router = useRouter();

  // Auth guard — redirect if not logged in or no property selected.
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Restore tab choice from localStorage on mount (guarded).
  useEffect(() => {
    const saved = safeStore.get(STORAGE_KEY) as MaintenanceTabKey | null;
    if (saved && VALID_TABS.includes(saved)) setTabState(saved);
  }, []);

  const setTab = (t: MaintenanceTabKey) => {
    setTabState(t);
    safeStore.set(STORAGE_KEY, t);
  };

  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div style={{
          minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: T.bg, fontFamily: FONT_SANS,
        }}>
          <div className="animate-spin" style={{
            width: 28, height: 28,
            border: `2px solid ${T.rule}`, borderTopColor: T.ink, borderRadius: '50%',
          }} />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <MTSubTabBar tab={tab} onTab={setTab} />
      <MaintenanceErrorBoundary>
        <div key={tab} className="animate-in stagger-1">
          {tab === 'work'       && <WorkOrdersTab />}
          {tab === 'preventive' && <PreventiveTab />}
          {tab === 'equipment'  && <EquipmentTab />}
        </div>
      </MaintenanceErrorBoundary>
    </AppLayout>
  );
}
