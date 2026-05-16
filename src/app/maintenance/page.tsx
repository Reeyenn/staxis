'use client';

// Maintenance tab — full rewrite (Claude Design handoff, May 2026).
//
// Replaces a 4,058-line monolith that had 5 sub-tabs (Work Orders, Preventive,
// Equipment Registry, Landscaping, Vendors/Contracts). After user research
// with hotel operators (head housekeeper, GM, VP of Ops at 22 hotels), the
// tab is now just 2 sub-tabs: Work Orders + Preventive. Pattern mirrors
// src/app/housekeeping/page.tsx — orchestrator only, each tab lives in
// _components/.

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { T, FONT_SANS, MTSubTabBar, type MaintenanceTabKey } from './_components/_mt-snow';
import { WorkOrdersTab } from './_components/WorkOrdersTab';
import { PreventiveTab } from './_components/PreventiveTab';

const STORAGE_KEY = 'mt-tab';
const VALID_TABS: MaintenanceTabKey[] = ['work', 'preventive'];

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

  // Restore tab choice from localStorage on mount.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as MaintenanceTabKey | null;
    if (saved && VALID_TABS.includes(saved)) setTabState(saved);
  }, []);

  const setTab = (t: MaintenanceTabKey) => {
    setTabState(t);
    localStorage.setItem(STORAGE_KEY, t);
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
      <div key={tab} className="animate-in stagger-1">
        {tab === 'work'       && <WorkOrdersTab />}
        {tab === 'preventive' && <PreventiveTab />}
      </div>
    </AppLayout>
  );
}
