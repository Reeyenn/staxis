'use client';


export const dynamic = 'force-dynamic';
// Staff page — role-gated entry point.
//
//   • Manager (admin / owner / general_manager) → Schedule + Directory tabs
//   • Staff   (housekeeping / front_desk / maintenance / staff) → My Shifts
//
// Demo/investor logins (accounts.skip_2fa → user.isDemo) that can manage the
// team get an extra Manager⇄Staff view switch so the shared test login can
// preview BOTH surfaces — and, in staff mode, preview as any employee.
//
// Replaces the previous monolithic /staff page that mixed an AI confirmations
// flow with a department-filtered directory. The morning SMS workflow now
// lives exclusively at /housekeeping → Schedule; this surface is for week-
// level planning + the staff-facing "Am I working?" view.

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { canManageTeam } from '@/lib/roles';
import { AppLayout } from '@/components/layout/AppLayout';
import { SubTabBar, type StaffTab } from './_components/SubTabBar';
import { UnifiedSchedule } from './_components/schedule';
import { ManagerDirectory } from './_components/ManagerDirectory';
import { ManagerRecognition } from './_components/ManagerRecognition';
import { MyShifts } from './_components/MyShifts';
import { asDeptKey, deptMeta, T, fonts } from './_components/_tokens';

const TAB_STORAGE_KEY = 'staxis-staff-tab';
const VIEWMODE_STORAGE_KEY = 'staxis-staff-viewmode';
const PREVIEW_STAFF_STORAGE_KEY = 'staxis-staff-previewid';

export default function StaffPage() {
  const { user, loading } = useAuth();
  const { activePropertyId, loading: propLoading } = useProperty();
  const router = useRouter();

  // No property selected (an account with zero accessible hotels, or the active
  // hotel was deleted) → route to the property picker / setup instead of
  // rendering a confusing empty Staff page. Mirrors the dashboard / housekeeping
  // guards. All hooks run unconditionally, above every early return.
  useEffect(() => {
    if (!loading && !propLoading && user && !activePropertyId) {
      router.replace('/property-selector');
    }
  }, [loading, propLoading, user, activePropertyId, router]);

  if (loading || propLoading) {
    return <AppLayout><LoadingState/></AppLayout>;
  }
  if (!user || !activePropertyId) {
    // Not signed in, or mid-redirect to the property picker — render a tidy
    // loading state until it lands. (The signin gate lives in middleware;
    // AppLayout does not itself redirect.)
    return <AppLayout><LoadingState/></AppLayout>;
  }

  const isManager = canManageTeam(user.role);

  // Demo login + manager → both UIs, switchable.
  if (user.isDemo && isManager) {
    return <AppLayout><DemoSwitchableView/></AppLayout>;
  }
  if (isManager) {
    return <AppLayout><ManagerView/></AppLayout>;
  }
  return <AppLayout><MyShifts/></AppLayout>;
}

// ── Demo-only Manager ⇄ Staff preview ───────────────────────────────────────
function DemoSwitchableView() {
  const { user } = useAuth();
  const [mode, setMode] = useState<'manager' | 'staff'>(() => {
    if (typeof window === 'undefined') return 'manager';
    try {
      return window.localStorage.getItem(VIEWMODE_STORAGE_KEY) === 'staff' ? 'staff' : 'manager';
    } catch { return 'manager'; }
  });
  const [previewStaffId, setPreviewStaffId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.localStorage.getItem(PREVIEW_STAFF_STORAGE_KEY); } catch { return null; }
  });

  useEffect(() => {
    try { window.localStorage.setItem(VIEWMODE_STORAGE_KEY, mode); } catch { /* noop */ }
  }, [mode]);
  useEffect(() => {
    try {
      if (previewStaffId) window.localStorage.setItem(PREVIEW_STAFF_STORAGE_KEY, previewStaffId);
    } catch { /* noop */ }
  }, [previewStaffId]);

  return (
    <div style={{ background: 'transparent', color: T.ink, fontFamily: fonts.sans, minHeight: '100%' }}>
      <DemoViewSwitch
        mode={mode}
        onMode={setMode}
        previewStaffId={previewStaffId}
        onPreviewStaff={setPreviewStaffId}
        loginName={user?.displayName ?? user?.username ?? 'demo'}
      />
      {mode === 'manager'
        ? <ManagerView/>
        : <MyShifts previewStaffId={previewStaffId}/>}
    </div>
  );
}

function DemoViewSwitch({
  mode, onMode, previewStaffId, onPreviewStaff, loginName,
}: {
  mode: 'manager' | 'staff';
  onMode: (m: 'manager' | 'staff') => void;
  previewStaffId: string | null;
  onPreviewStaff: (id: string) => void;
  loginName: string;
}) {
  const { staff } = useProperty();

  // Active roster for the "preview as" picker, grouped HK → FD → MT → other.
  const roster = useMemo(() => {
    const ord: Record<string, number> = { housekeeping: 0, front_desk: 1, maintenance: 2, other: 3 };
    return [...staff]
      .filter(s => s.isActive !== false)
      .sort((a, b) => {
        const oa = ord[asDeptKey(a.department)] ?? 3;
        const ob = ord[asDeptKey(b.department)] ?? 3;
        if (oa !== ob) return oa - ob;
        return a.name.localeCompare(b.name);
      });
  }, [staff]);

  // Default the preview to the first roster member once it loads.
  useEffect(() => {
    if (mode === 'staff' && !previewStaffId && roster.length > 0) {
      onPreviewStaff(roster[0].id);
    }
  }, [mode, previewStaffId, roster, onPreviewStaff]);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      padding: '9px 48px', background: 'rgba(201,150,68,0.07)',
      borderBottom: '1px solid rgba(140,106,51,0.20)',
    }}>
      <span style={{
        fontFamily: fonts.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: '#8C6A33',
      }}>Demo preview · {loginName}</span>

      <div style={{
        display: 'inline-flex', gap: 3, background: T.paper,
        border: `1px solid ${T.rule}`, borderRadius: 999, padding: 3,
      }}>
        {([['manager', 'Manager view'], ['staff', 'Staff view']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => onMode(k)}
            style={{
              border: 'none', borderRadius: 999, padding: '6px 14px', cursor: 'pointer',
              fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600,
              background: mode === k ? T.ink : 'transparent',
              color: mode === k ? T.bg : T.ink2, transition: 'all .12s',
            }}
          >{label}</button>
        ))}
      </div>

      {mode === 'staff' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>previewing as</span>
          {roster.length === 0 ? (
            <span style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink3 }}>
              no staff on this property
            </span>
          ) : (
            <select
              value={previewStaffId ?? roster[0].id}
              onChange={e => onPreviewStaff(e.target.value)}
              style={{
                padding: '6px 10px', borderRadius: 10, border: `1px solid ${T.rule}`,
                background: T.paper, fontFamily: fonts.sans, fontSize: 12.5, color: T.ink,
                outline: 'none', cursor: 'pointer', maxWidth: 240,
              }}
            >
              {roster.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} · {deptMeta[asDeptKey(s.department)].short}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <span style={{ flex: 1 }}/>
      <span style={{ fontFamily: fonts.mono, fontSize: 9.5, color: T.ink3, letterSpacing: '0.04em' }}>
        {mode === 'manager'
          ? 'What managers see'
          : 'What this employee sees on their phone'}
      </span>
    </div>
  );
}

function ManagerView() {
  const [tab, setTab] = useState<StaffTab>(() => {
    if (typeof window === 'undefined') return 'schedule';
    try {
      const raw = window.localStorage.getItem(TAB_STORAGE_KEY);
      return raw === 'directory' || raw === 'recognition' ? raw : 'schedule';
    } catch { return 'schedule'; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* noop */ }
  }, [tab]);

  return (
    <div style={{ background: 'transparent', color: T.ink, fontFamily: fonts.sans, minHeight: '100%' }}>
      <SubTabBar tab={tab} onTab={setTab}/>
      {tab === 'schedule'    && <UnifiedSchedule onOpenDirectory={() => setTab('directory')}/>}
      {tab === 'directory'   && <ManagerDirectory/>}
      {tab === 'recognition' && <ManagerRecognition/>}
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
