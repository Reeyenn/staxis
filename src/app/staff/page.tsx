'use client';

// Staff page — role-gated entry point.
//
//   • Manager (admin / owner / general_manager) → Schedule + Directory tabs
//   • Staff   (housekeeping / front_desk / maintenance / staff) → My Shifts
//
// Replaces the previous monolithic /staff page that mixed an AI confirmations
// flow with a department-filtered directory. The morning SMS workflow now
// lives exclusively at /housekeeping → Schedule; this surface is for week-
// level planning + the staff-facing "Am I working?" view.

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { canManageTeam } from '@/lib/roles';
import { AppLayout } from '@/components/layout/AppLayout';
import { SubTabBar, type StaffTab } from './_components/SubTabBar';
import { ManagerSchedule } from './_components/ManagerSchedule';
import { ManagerDirectory } from './_components/ManagerDirectory';
import { MyShifts } from './_components/MyShifts';
import { T, fonts } from './_components/_tokens';

const TAB_STORAGE_KEY = 'staxis-staff-tab';

export default function StaffPage() {
  const { user, loading } = useAuth();

  if (loading) {
    return <AppLayout><LoadingState/></AppLayout>;
  }
  if (!user) {
    // AppLayout already redirects unauthenticated users, but render a tidy
    // empty state in case the guard hasn't kicked in yet.
    return <AppLayout><LoadingState/></AppLayout>;
  }

  if (canManageTeam(user.role)) {
    return <AppLayout><ManagerView/></AppLayout>;
  }
  return <AppLayout><MyShifts/></AppLayout>;
}

function ManagerView() {
  const [tab, setTab] = useState<StaffTab>(() => {
    if (typeof window === 'undefined') return 'schedule';
    try {
      const raw = window.localStorage.getItem(TAB_STORAGE_KEY);
      return raw === 'directory' ? 'directory' : 'schedule';
    } catch { return 'schedule'; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* noop */ }
  }, [tab]);

  return (
    <div style={{ background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%' }}>
      <SubTabBar tab={tab} onTab={setTab}/>
      {tab === 'schedule'  && <ManagerSchedule/>}
      {tab === 'directory' && <ManagerDirectory/>}
    </div>
  );
}

function LoadingState() {
  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.08em',
    }}>LOADING…</div>
  );
}
