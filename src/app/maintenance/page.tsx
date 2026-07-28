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
// running. (The parked ComplianceTab.tsx UI was deleted 2026-07-16 on Reeyen's
// call; rebuild from git history if a new home is ever wanted.) Pattern mirrors
// housekeeping/page.tsx — orchestrator only.

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLang } from '@/contexts/LanguageContext';
import { canManageTeam } from '@/lib/roles';
import { T, FONT_SANS, Btn, MTSubTabBar, MaintenanceErrorBoundary, type MaintenanceTabKey } from './_components/_mt-snow';
import { WorkOrdersTab } from './_components/WorkOrdersTab';
import { PreventiveTab } from './_components/PreventiveTab';
import { EquipmentTab } from './_components/EquipmentTab';
import { PatternsModal } from './_components/PatternsModal';
import { panelText } from './_components/PatternsPanel';

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
  const [patternsOpen, setPatternsOpen] = useState(false);
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();
  const canSeePatterns = !!user && canManageTeam(user.role);

  // Auth guard — redirect if not logged in or no property selected.
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/property-selector');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Restore tab choice on mount. A `?tab=` deep-link (e.g. from the worklist)
  // wins over the saved choice; otherwise fall back to localStorage (guarded).
  useEffect(() => {
    const urlTab = new URLSearchParams(window.location.search).get('tab') as MaintenanceTabKey | null;
    if (urlTab && VALID_TABS.includes(urlTab)) { setTabState(urlTab); safeStore.set(STORAGE_KEY, urlTab); return; }
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
          background: 'transparent', fontFamily: FONT_SANS,
        }}>
          <div className="animate-spin" style={{
            width: 28, height: 28,
            border: `2px solid ${T.rule}`, borderTopColor: '#3E5C48', borderRadius: '50%',
          }} />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <MTSubTabBar
        tab={tab}
        onTab={setTab}
        actions={
          // Managers only. /maintenance itself is open to the maintenance role,
          // but the findings read behind this popup is manager-gated
          // (loadManagerCaller + managerManagesHotel), so anyone else would get
          // a button that can only ever answer "couldn't check just now". Same
          // predicate the Staxis queue gates its own fetch on.
          canSeePatterns ? (
            <Btn variant="ghost" onClick={() => setPatternsOpen(true)}>
              {panelText('button', lang === 'es' ? 'es' : 'en')}
            </Btn>
          ) : undefined
        }
      />
      <MaintenanceErrorBoundary>
        <div key={tab} className="animate-in stagger-1">
          {tab === 'work'       && <WorkOrdersTab />}
          {tab === 'preventive' && <PreventiveTab />}
          {tab === 'equipment'  && <EquipmentTab />}
        </div>
      </MaintenanceErrorBoundary>
      {canSeePatterns && (
        <PatternsModal open={patternsOpen} onClose={() => setPatternsOpen(false)} />
      )}
    </AppLayout>
  );
}
