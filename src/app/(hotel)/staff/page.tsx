'use client';


export const dynamic = 'force-dynamic';
// Staff page — role-gated entry point.
//
//   • Manager (admin / owner / general_manager) → Schedule
//   • Staff   (housekeeping / front_desk / maintenance / staff) → My Shifts
//
// Demo/investor logins (accounts.skip_2fa → user.isDemo) that can manage the
// team get an extra Manager⇄Staff view switch so the shared test login can
// preview BOTH surfaces — and, in staff mode, preview as any employee.
//
// The Directory tab was removed on 2026-07-27. Everyone who works at the hotel
// — logins and schedule-only people alike — is now ONE list at
// My Hotel → People (/company?tab=people), which is also the only place a
// person's pay, hours cap, department, linked login and auto-assign rank are
// edited. With Schedule the only manager surface left here, the sub-tab bar and
// its stored tab preference are gone too; a returning manager whose browser
// still remembers 'directory' simply lands on Schedule.
//
// The morning workflow lives at /housekeeping → Schedule; this surface is for
// week-level planning + the staff-facing "Am I working?" view.

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { canManageTeam } from '@/lib/roles';
import { useActiveHotelStanding, useCan } from '@/lib/capabilities/useCan';
import { UnifiedSchedule } from '@/app/staff/_components/schedule';
import { MyShifts } from '@/app/staff/_components/MyShifts';
import { asDeptKey, deptMeta, T, fonts } from '@/app/staff/_components/_tokens';
import { RouteErrorState, RouteLoadingState } from '@/components/layout/RouteResourceState';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';

/** My Hotel → People. Where new hires are added and logins get linked. */
const PEOPLE_HREF = '/company?tab=people';

const VIEWMODE_STORAGE_KEY = 'staxis-staff-viewmode';
const PREVIEW_STAFF_STORAGE_KEY = 'staxis-staff-previewid';

export default function StaffPage() {
  const { user, loading } = useAuth();
  const {
    activeProperty,
    activePropertyId,
    activePropertyViewerKey,
    capabilityOverridesPropertyId,
    capabilityOverridesViewerKey,
    capabilityOverridesStatus,
    capabilityOverridesError,
    refreshCapabilities,
    loading: propLoading,
  } = useProperty();
  const can = useCan();
  const hotelStanding = useActiveHotelStanding();
  const { push, replace } = useReliableNavigation();

  // No property selected (an account with zero accessible hotels, or the active
  // hotel was deleted) → route to the property picker / setup instead of
  // rendering a confusing empty Staff page. Mirrors the dashboard / housekeeping
  // guards. All hooks run unconditionally, above every early return.
  useEffect(() => {
    if (!loading && !propLoading && user && !activePropertyId) {
      replace('/property-selector');
    }
  }, [loading, propLoading, user, activePropertyId, replace]);

  if (loading || propLoading) {
    return <LoadingState/>;
  }
  if (!user) {
    // Not signed in, or mid-redirect to the property picker — render a tidy
    // loading state until it lands. (The signin gate lives in middleware;
    // The route-family shell does not itself redirect.)
    return <LoadingState/>;
  }
  if (!activePropertyId) {
    return (

        <RouteErrorState
          title="No hotel is selected"
          message="Choose a hotel before opening Staff."
          retryLabel="Choose a hotel"
          onRetry={() => push('/property-selector')}
        />

    );
  }

  const isManager = hotelStanding.hotelMutationAllowed
    && !!hotelStanding.role
    && canManageTeam(hotelStanding.role);
  const capabilityViewerKey = activePropertyViewerKey;
  const capabilityContextReady = Boolean(
    activeProperty?.id === activePropertyId
    && capabilityOverridesPropertyId === activePropertyId
    && capabilityOverridesViewerKey === capabilityViewerKey
  );

  // The per-hotel standing chooses the privileged manager surface. Until that
  // fresh decision arrives, render the ordinary My Shifts experience instead
  // of blocking the whole route. This fails closed: no manager schedule or
  // controls mount before the authoritative standing is ready.

  // Schedule data and controls are the capability-affected part of this page.
  // Keep them fail-closed until the exact viewer/hotel snapshot arrives, but
  // render the normal route-family shell immediately instead of replacing the entire
  // route with a capability-refresh loader.
  if (isManager && !capabilityContextReady) {
    return (

        <ManagerScheduleStatus
          pending={capabilityOverridesStatus !== 'error'}
          message={capabilityOverridesError ?? undefined}
          onRetry={() => void refreshCapabilities()}
        />

    );
  }

  const canManageSchedule = isManager && can('manage_shifts');
  // Not a tab any more — this decides whether we offer the manager a way over
  // to My Hotel → People from inside the schedule.
  const canManagePeople = isManager && can('manage_team');

  // Demo login + manager → both UIs, switchable.
  if (user.isDemo && canManageSchedule) {
    return (

        <DemoSwitchableView key={capabilityViewerKey} canManagePeople={canManagePeople} />

    );
  }
  if (canManageSchedule) {
    return (

        <ManagerView key={capabilityViewerKey} canManagePeople={canManagePeople} />

    );
  }
  if (isManager) {
    return <ManagerAccessUnavailable canManagePeople={canManagePeople}/>;
  }
  return <MyShifts/>;
}

// ── Demo-only Manager ⇄ Staff preview ───────────────────────────────────────
function DemoSwitchableView({ canManagePeople }: { canManagePeople: boolean }) {
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
        ? <ManagerView canManagePeople={canManagePeople} />
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

  // Default the preview to the first roster member once it loads. Also
  // recover when a stored previewStaffId points at a since-deactivated or
  // deleted staffer (no longer in the roster) — otherwise the preview shows
  // "not linked" forever while the picker displays someone else.
  useEffect(() => {
    if (mode !== 'staff' || roster.length === 0) return;
    if (!previewStaffId || !roster.some(s => s.id === previewStaffId)) {
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

function ManagerView({ canManagePeople }: { canManagePeople: boolean }) {
  const { push } = useReliableNavigation();

  return (
    <div style={{ background: 'transparent', color: T.ink, fontFamily: fonts.sans, minHeight: '100%' }}>
      <UnifiedSchedule
        onOpenPeople={canManagePeople ? () => push(PEOPLE_HREF) : undefined}
      />
    </div>
  );
}

function ManagerAccessUnavailable({ canManagePeople }: { canManagePeople: boolean }) {
  return (
    <div style={{
      minHeight: '60vh', display: 'grid', placeItems: 'center', padding: 24,
      color: T.ink, fontFamily: fonts.sans,
    }}>
      <div role="status" style={{
        width: 'min(100%, 460px)', textAlign: 'center', padding: '28px 24px',
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
        boxShadow: T.cardShadow,
      }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 7 }}>
          {'The schedule isn’t available for your access'}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: T.ink3 }}>
          {'Ask an administrator to enable Schedule access for your role at this hotel.'}
        </div>
        {canManagePeople ? (
          <Link
            href={PEOPLE_HREF}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minHeight: 44, marginTop: 16, padding: '0 18px', borderRadius: 12,
              border: `1px solid ${T.rule}`, background: T.paper,
              fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: T.ink,
              textDecoration: 'none',
            }}
          >
            {'Open My Hotel → People'}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function ManagerScheduleStatus({
  pending,
  message,
  onRetry,
}: {
  pending: boolean;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div style={{
      minHeight: 360, display: 'grid', placeItems: 'center', padding: 24,
      color: T.ink, fontFamily: fonts.sans,
    }}>
      <div role={pending ? 'status' : 'alert'} aria-live="polite" style={{
        width: 'min(100%, 440px)', textAlign: 'center', padding: '28px 24px',
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
        boxShadow: T.cardShadow,
      }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 7 }}>
          {pending
            ? 'Loading the schedule…'
            : 'Schedule access could not be confirmed'}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: T.ink3 }}>
          {pending
            ? 'Controls will be available once access is ready.'
            : (message ?? 'Check your connection and try again.')}
        </div>
        {!pending && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            style={{
              minHeight: 44, marginTop: 16, padding: '0 18px', borderRadius: 12,
              border: `1px solid ${T.rule}`, background: T.paper,
              fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: T.ink,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LoadingState() {
  return <RouteLoadingState title="Loading Staff…" message="Getting the current schedule and access settings." />;
}
