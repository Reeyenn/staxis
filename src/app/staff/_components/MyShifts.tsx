// MyShifts — staff-side weekly view (MSv2Body / "Week strip" from the
// design), backed by scheduled_shifts (migration 0147).
//
//   • Greeting + hours card for the week being viewed
//   • 7-card horizontal week strip (only published shifts; drafts hidden)
//   • Back/forward week browsing (managers plan weeks ahead and every save
//     is published immediately, so the person working next month needs a
//     screen that reaches it)
//   • Open shifts in your dept that you can pick up
//   • Time-off requests (real list + "+ Request" modal + self-cancel)
//
// Requires an active account/property staff link. If absent, render a friendly
// empty state — the manager has to link the login to the person's schedule
// profile from My Hotel → People.

'use client';

import React, { useEffect, useId, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth, INTERACTIVE_ACTION_TIMEOUT_MS } from '@/lib/api-fetch';
import { RequestTimeoutError } from '@/lib/fetch-deadline';
import type { ScheduledShift, TimeOffRequest } from '@/types';
import { T, fonts, deptMeta, asDeptKey, Btn, Caps } from './_tokens';
import { Avatar } from './_people';
import { useWeekShifts } from './useWeekShifts';
import { addDaysYmd, fmtRange, sundayOf } from '@/lib/schedule-board';
import { isStaffVisibleScheduleStatus } from './staff-shift-visibility';
import { useStaffDialog } from './useStaffDialog';
import { useActiveStaffIdentity } from './useActiveStaffIdentity';
import { propertyLocalToday } from '@/lib/schedule/local-date';
import dialogStyles from './StaffDialog.module.css';

// How far back an employee may page. Matches the manager board's default
// history window (useScheduleData's WEEKS_BACK), so both sides of the app
// remember the same amount of the past.
const WEEKS_BACK_LIMIT = 12;

export function MyShifts({ previewStaffId }: { previewStaffId?: string | null } = {}) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const scopeKey = `${user?.uid ?? 'signed-out'}:${activePropertyId ?? 'no-property'}`;

  // Time-off drafts and action state are hotel-owned. A property or account
  // switch remounts the whole staff workspace so an open Hotel A dialog cannot
  // silently retarget itself to Hotel B through updated context props.
  return (
    <MyShiftsPropertyView
      key={scopeKey}
      previewStaffId={previewStaffId}
      scopeKey={scopeKey}
    />
  );
}

function MyShiftsPropertyView({
  previewStaffId,
  scopeKey,
}: {
  previewStaffId?: string | null;
  scopeKey: string;
}) {
  const { user } = useAuth();
  const {
    activeProperty, activePropertyId, staff, staffLoaded, staffLoadFailed,
  } = useProperty();
  const [requestOpen, setRequestOpen] = useState(false);
  const [today, setToday] = useState(() => propertyLocalToday(new Date(), activeProperty?.timezone ?? null));
  useEffect(() => {
    const refreshToday = () => {
      const next = propertyLocalToday(new Date(), activeProperty?.timezone ?? null);
      setToday(current => current === next ? current : next);
    };
    refreshToday();
    const interval = setInterval(refreshToday, 60_000);
    return () => clearInterval(interval);
  }, [activeProperty?.timezone]);
  const currentWeekStart = useMemo(() => sundayOf(today), [today]);
  // Weeks away from the current one. Forward is unbounded (a manager can plan
  // as far out as they like and every save is live the moment it is made);
  // back stops at the manager board's own default history window so an
  // employee can still check what they worked without paging into forever.
  const [weekOffset, setWeekOffset] = useState(0);
  const weekStart = useMemo(
    () => (weekOffset === 0 ? currentWeekStart : addDaysYmd(currentWeekStart, weekOffset * 7)),
    [currentWeekStart, weekOffset],
  );

  // In demo "preview as staff" mode the page passes the staff row to render
  // as; otherwise this is the logged-in employee's own linked staffId.
  const identity = useActiveStaffIdentity(activePropertyId, previewStaffId === undefined);
  const staffId = previewStaffId !== undefined ? previewStaffId : identity.staffId;
  const me = useMemo(() => staff.find(s => s.id === staffId) ?? null, [staff, staffId]);
  const {
    days, byStaff, openShifts, torByStaff,
    loading: shiftsLoading, loadError: shiftsLoadError, retry: retryShifts,
  } = useWeekShifts(activePropertyId, weekStart, staffId, today);

  const propName = activeProperty?.name ?? 'Your property';

  if (previewStaffId === undefined && (identity.loading || identity.error)) {
    return (
      <MyShiftsLoadState
        error={identity.error}
        onRetry={identity.retry}
      />
    );
  }

  if (staffId && (!staffLoaded || staffLoadFailed)) {
    return (
      <MyShiftsLoadState
        error={staffLoadFailed}
        onRetry={() => window.location.reload()}
      />
    );
  }

  if (!staffId || !me) {
    return (
      <NotLinkedState
        displayName={user?.displayName ?? 'there'}
        propertyName={propName}
      />
    );
  }

  const es = false;
  if (shiftsLoading || shiftsLoadError) {
    return (
      <MyShiftsLoadState
        error={!!shiftsLoadError}
        onRetry={retryShifts}
        es={es}
      />
    );
  }
  const meDept = deptMeta[asDeptKey(me.department)];
  // Row status is the source of truth. The manager schedule saves rows as
  // `published` immediately; the legacy week stamp is non-fatal bookkeeping
  // and must not hide a successfully saved shift or expose a draft.
  const myWeekFull = byStaff[me.id] ?? Array.from({ length: 7 }, () => ({ kind: 'off' as const }));
  const myWeek = myWeekFull.map((c) => {
    if (c.kind !== 'shift') return c;
    return isStaffVisibleScheduleStatus(c.shift.status) ? c : { kind: 'off' as const };
  });

  const myShiftCount = myWeek.filter(c => c.kind === 'shift').length;
  const myHrs = myWeek.reduce((sum, c) => {
    if (c.kind !== 'shift') return sum;
    return sum + hoursBetween(c.shift.startTime, c.shift.endTime);
  }, 0);
  const cap = me.maxWeeklyHours || 40;
  const firstName = me.name.split(/\s+/)[0] || me.name;
  const greeting = `Hi, ${firstName}.`;

  // Open shifts in my dept, in the week being viewed, that are published
  // (i.e. visible to staff) and in the future.
  //
  // FOLLOWS THE BROWSED WEEK on purpose: an open shift three weeks out was
  // exactly as unreachable as a future assigned shift, and the `>= today`
  // filter already stops a browse into the past from offering stale pickups.
  const myDept = asDeptKey(me.department);
  const myDeptLabel = meDept.label.toLowerCase();
  const myOpenShifts = openShifts.filter(o =>
    o.department === myDept
    && isStaffVisibleScheduleStatus(o.status)
    && o.shiftDate >= today,
  ).sort((a, b) => a.shiftDate.localeCompare(b.shiftDate));

  // My TOR list: pending first, then recent decisions. PINNED TO "ALL MY
  // REQUESTS", not the browsed week: a request is a standing conversation
  // with the manager, and hiding it because you paged the calendar would
  // read as the request having disappeared.
  const myTor = (torByStaff[me.id] ?? []).slice().sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return b.submittedAt.getTime() - a.submittedAt.getTime();
  });

  // Week-browsing labels.
  const weekRangeLabel = `${days[0]?.dateLabel ?? ''} – ${days[6]?.dateLabel ?? ''}`;
  const hoursCardLabel = weekOffset === 0 ? 'This week'
    : weekOffset === -1 ? 'Last week'
    : weekOffset === 1 ? 'Next week'
    : `Week of ${days[0]?.dateLabel ?? ''}`;
  const weekPhrase = weekOffset === 0 ? 'this week' : `the week of ${days[0]?.dateLabel ?? ''}`;
  const weekTag = weekOffset === 0 ? 'THIS WEEK' : weekOffset < 0 ? 'PAST' : 'UPCOMING';
  const backDisabled = weekOffset <= -WEEKS_BACK_LIMIT;
  const stepWeek = (dir: 1 | -1) => {
    setWeekOffset(n => Math.max(-WEEKS_BACK_LIMIT, n + dir));
  };

  return (
    <div className="my-shifts-shell" style={{
      background: 'transparent', color: T.ink, fontFamily: fonts.sans, minHeight: '100%',
      padding: '28px 48px 130px',
    }}>
      <style>{`
        .my-shifts-week-strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; }
        .my-shifts-extras { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
        @media (max-width: 900px) {
          .my-shifts-week-strip { grid-template-columns: 1fr 1fr; }
          .my-shifts-extras { grid-template-columns: 1fr; }
        }
        @media (max-width: 640px) {
          .my-shifts-shell { padding: 18px 16px 110px !important; }
          .my-shifts-week-strip { grid-template-columns: 1fr; }
        }
      `}</style>

      <div style={{ maxWidth: 1280, margin: '0 auto' }}>
        {/* Greeting + hours */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
          marginBottom: 22, gap: 24, flexWrap: 'wrap',
        }}>
          <div>
            <Caps>{propName}</Caps>
            <h1 style={{
              fontFamily: fonts.sans, fontSize: 26, color: T.ink,
              margin: '4px 0 0', letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: 600,
            }}>
              <span>{greeting}</span>
            </h1>
          </div>
          <HoursCard hrs={myHrs} cap={cap} shifts={myShiftCount} label={hoursCardLabel} tone={meDept.tone} es={es}/>
        </div>

        <div style={{
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          gap: 10, marginBottom: 12, flexWrap: 'wrap',
        }}>
          <div>
            <Caps size={9}>{'My schedule'}</Caps>
            <div style={{
              fontFamily: fonts.sans, fontSize: 16, fontWeight: 600,
              color: T.ink, letterSpacing: '-0.01em', marginTop: 3, lineHeight: 1.1,
            }}>{'Week at a glance'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {weekOffset !== 0 && (
              <button
                type="button"
                onClick={() => setWeekOffset(0)}
                style={weekJumpStyle}
              >{'This week'}</button>
            )}
            <button
              type="button"
              onClick={() => stepWeek(-1)}
              disabled={backDisabled}
              aria-label={'Previous week'}
              title={backDisabled ? 'No earlier weeks' : 'Previous week'}
              style={weekArrowStyle(backDisabled)}
            >‹</button>
            <span aria-live="polite" style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.06em',
              whiteSpace: 'nowrap',
            }}>
              {weekRangeLabel}
              <span style={{
                fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em',
                color: weekOffset === 0 ? T.brand : T.ink3,
                border: `1px solid ${weekOffset === 0 ? T.brand : T.rule}`,
                padding: '2px 7px', borderRadius: 999,
              }}>{weekTag}</span>
            </span>
            <button
              type="button"
              onClick={() => stepWeek(1)}
              aria-label={'Next week'}
              title={'Next week'}
              style={weekArrowStyle(false)}
            >›</button>
          </div>
        </div>

        {/* Week strip */}
        <div className="my-shifts-week-strip" style={{ marginBottom: 24 }}>
          {days.map((d, i) => {
            const cell = myWeek[i];
            const isOff = cell.kind !== 'shift';
            const isToday = d.today;
            const isPast = d.past;
            return (
              <div key={d.key} style={{
                background: isToday ? T.brand : T.paper,
                color: isToday ? T.bg : T.ink,
                border: `1px solid ${isToday ? T.brand : T.rule}`, borderRadius: 14,
                boxShadow: isToday ? '0 8px 18px -8px rgba(62,92,72,0.55)' : T.cardShadow,
                padding: '12px 12px 14px',
                display: 'flex', flexDirection: 'column', gap: 10,
                opacity: isPast ? 0.55 : 1,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                  <div>
                    <div style={{
                      fontFamily: fonts.mono, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em',
                      color: isToday ? 'rgba(255,255,255,0.55)' : T.ink3,
                    }}>{d.label.toUpperCase()}</div>
                    <div style={{
                      fontFamily: fonts.sans, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em',
                      lineHeight: 1, marginTop: 1,
                      color: isToday ? T.bg : T.ink,
                    }}>{d.dayNum}</div>
                  </div>
                  {isToday && (
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700,
                      color: '#fff', background: 'rgba(255,255,255,0.18)',
                      border: '1px solid rgba(255,255,255,0.26)',
                      padding: '1px 6px', borderRadius: 999, letterSpacing: '0.08em', whiteSpace: 'nowrap',
                    }}>{'TODAY'}</span>
                  )}
                </div>
                {!isOff ? (
                  <div style={{
                    padding: '8px 10px', borderRadius: 8,
                    background: isToday ? 'rgba(255,255,255,0.12)' : meDept.dim,
                    border: `1px solid ${isToday ? 'rgba(255,255,255,0.20)' : meDept.tone + '33'}`,
                  }}>
                    <div style={{
                      fontFamily: fonts.mono, fontSize: 12.5, fontWeight: 600,
                      color: isToday ? T.bg : T.ink, letterSpacing: '0', lineHeight: 1.2,
                    }}>{cell.kind === 'shift' ? fmtRange(cell.shift.startTime, cell.shift.endTime) : ''}</div>
                    <div style={{
                      fontFamily: fonts.sans, fontSize: 11,
                      color: isToday ? 'rgba(255,255,255,0.65)' : T.ink2, marginTop: 2,
                    }}>{meDept.short}</div>
                  </div>
                ) : (
                  <div style={{
                    padding: '7px 10px', borderRadius: 8,
                    border: `1px dashed ${isToday ? 'rgba(255,255,255,0.22)' : T.rule}`,
                    fontFamily: fonts.mono, fontSize: 10.5,
                    color: isToday ? 'rgba(255,255,255,0.6)' : T.ink3, textAlign: 'center',
                  }}>{'Day off'}</div>
                )}
              </div>
            );
          })}
        </div>

        <div className="my-shifts-extras">
          <OpenShiftsCard
            shifts={myOpenShifts}
            myDept={myDeptLabel}
            weekPhrase={weekPhrase}
            hotelId={activePropertyId ?? ''}
            scopeKey={scopeKey}
            onReconcile={retryShifts}
            es={es}
          />
          <TimeOffCard
            requests={myTor}
            hotelId={activePropertyId ?? ''}
            scopeKey={scopeKey}
            onAddRequest={() => setRequestOpen(true)}
            onReconcile={retryShifts}
            es={es}
          />
        </div>
      </div>

      {requestOpen && (
        <RequestTimeOffModal
          hotelId={activePropertyId ?? ''}
          scopeKey={scopeKey}
          today={today}
          onClose={() => setRequestOpen(false)}
          es={es}
        />
      )}
    </div>
  );
}

function MyShiftsLoadState({
  error, onRetry, es = false,
}: {
  error: boolean;
  onRetry: () => void;
  es?: boolean;
}) {
  return (
    <div style={{
      minHeight: 360, display: 'grid', placeItems: 'center', padding: 24,
      color: T.ink, fontFamily: fonts.sans,
    }}>
      <div role={error ? 'alert' : 'status'} aria-live="polite" style={{
        width: 'min(100%, 420px)', textAlign: 'center', padding: '28px 24px',
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
        boxShadow: T.cardShadow,
      }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 7 }}>
          {error
            ? ("Couldn't load your shifts")
            : ('Loading your shifts…')}
        </div>
        {error && (
          <Btn variant="primary" size="md" onClick={onRetry} style={{ marginTop: 10 }}>
            {'Retry'}
          </Btn>
        )}
      </div>
    </div>
  );
}

// ── Week navigation control styles ─────────────────────────────────────────
// 44px targets: these are the primary controls for reaching a future week on
// a phone, which is where most employees open this page.
function weekArrowStyle(disabled: boolean): React.CSSProperties {
  return {
    minWidth: 44, minHeight: 44, padding: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 12, border: `1px solid ${T.rule}`, background: T.paper,
    color: disabled ? T.ink3 : T.ink, cursor: disabled ? 'default' : 'pointer',
    fontFamily: fonts.sans, fontSize: 18, lineHeight: 1,
    opacity: disabled ? 0.45 : 1,
  };
}

const weekJumpStyle: React.CSSProperties = {
  minHeight: 44, padding: '0 14px',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 999, border: `1px solid ${T.rule}`, background: T.paper,
  color: T.ink, cursor: 'pointer',
  fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
};

// ── Hours card ─────────────────────────────────────────────────────────────
function HoursCard({
  hrs, cap, shifts, label, tone, es,
}: { hrs: number; cap: number; shifts: number; label: string; tone: string; es: boolean }) {
  const pct = Math.min(1, cap > 0 ? hrs / cap : 0);
  return (
    <div style={{
      minWidth: 260, padding: '14px 18px',
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
      boxShadow: T.cardShadow,
    }}>
      <Caps size={9}>{label}</Caps>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4, gap: 12 }}>
        <span style={{
          fontFamily: fonts.sans, fontSize: 23, fontWeight: 600, color: T.ink,
          letterSpacing: '-0.02em', lineHeight: 1,
        }}>
          {hrs}<span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink3, fontWeight: 500 }}>h</span>
        </span>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, fontWeight: 500 }}>
            {shifts} {(shifts === 1 ? 'shift' : 'shifts')}
          </div>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, marginTop: 2 }}>{`of ${cap}h cap`}</div>
        </div>
      </div>
      <span style={{ display: 'block', height: 5, borderRadius: 5, background: T.rule, overflow: 'hidden', marginTop: 10 }}>
        <span style={{ display: 'block', height: '100%', width: `${pct * 100}%`, background: tone, borderRadius: 5 }}/>
      </span>
    </div>
  );
}

function hoursBetween(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

// ── Open shifts card ──────────────────────────────────────────────────────
function OpenShiftsCard({
  shifts, myDept, weekPhrase, hotelId, scopeKey, onReconcile, es,
}: {
  shifts: ScheduledShift[];
  myDept: string;
  /** 'this week' or 'the week of Aug 17', matching what the strip shows. */
  weekPhrase: string;
  hotelId: string;
  scopeKey: string;
  onReconcile: () => void;
  es: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const actionScopeRef = React.useRef<string | null>(scopeKey);
  const actionAttemptRef = React.useRef(0);
  const actionInFlightRef = React.useRef(false);
  React.useEffect(() => {
    actionScopeRef.current = scopeKey;
    return () => {
      if (actionScopeRef.current === scopeKey) actionScopeRef.current = null;
      actionAttemptRef.current += 1;
      actionInFlightRef.current = false;
    };
  }, [scopeKey]);

  const pickUp = async (shiftId: string) => {
    if (actionInFlightRef.current) return;
    const requestedHotelId = hotelId;
    const requestedShiftId = shiftId;
    const attempt = ++actionAttemptRef.current;
    const ownsAttempt = () => (
      actionScopeRef.current === scopeKey
      && actionAttemptRef.current === attempt
    );
    actionInFlightRef.current = true;
    setBusyId(requestedShiftId);
    setErrorMsg(null);
    let responseReceived = false;
    try {
      const res = await fetchWithAuth('/api/staff-schedule/pickup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId: requestedHotelId, shiftId: requestedShiftId }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      if (!ownsAttempt()) return;
      responseReceived = true;
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        if (!ownsAttempt()) return;
        throw new Error(b?.error || ('Pick up failed'));
      }
      // Realtime normally pushes this update, but a fresh scoped snapshot is
      // the source of truth if the subscription was reconnecting or delayed.
      onReconcile();
    } catch (e) {
      if (!ownsAttempt()) return;
      if (!responseReceived) {
        // A timeout or network failure can lose the response after the server
        // committed the compare-and-set. Never tell the employee it failed or
        // leave the open row stale: reread this exact viewer+hotel week first.
        onReconcile();
        if (!ownsAttempt()) return;
        setErrorMsg("We couldn't confirm whether you got the shift. We're refreshing your schedule before you try again.");
      } else {
        setErrorMsg(e instanceof Error ? e.message : ('Pick up failed'));
      }
    } finally {
      if (ownsAttempt()) {
        actionInFlightRef.current = false;
        setBusyId(null);
      }
    }
  };

  return (
    <div style={{
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
      boxShadow: T.cardShadow,
      overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '14px 16px', borderBottom: `1px solid ${T.rule}`,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <Caps size={9}>{'Pick up'}</Caps>
          <div style={{
            fontFamily: fonts.sans, fontSize: 14.5, fontWeight: 600,
            color: T.ink, letterSpacing: '-0.01em', marginTop: 3, lineHeight: 1.1,
          }}>{'Open shifts'}</div>
        </div>
        <span style={{
          fontFamily: fonts.mono, fontSize: 9.5,
          color: shifts.length > 0 ? '#B85C3D' : T.ink3,
          letterSpacing: '0.06em', fontWeight: 700,
          background: shifts.length > 0 ? 'rgba(184,92,61,0.10)' : 'rgba(31,35,28,0.05)',
          border: `1px solid ${shifts.length > 0 ? 'rgba(184,92,61,0.28)' : T.rule}`,
          padding: '3px 9px', borderRadius: 999,
        }}>{shifts.length} {'AVAILABLE'}</span>
      </div>
      {shifts.length === 0 ? (
        <div style={{
          padding: '22px 18px', textAlign: 'center', flex: 1,
          fontFamily: fonts.sans, fontSize: 13,
          color: T.ink3, letterSpacing: '0',
        }}>{`No open shifts in ${myDept} ${weekPhrase}.`}</div>
      ) : (
        <div>
          {shifts.map(s => (
            <div key={s.id} style={{
              padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 12,
              borderBottom: `1px solid ${T.ruleSoft}`,
            }}>
              <div style={{
                width: 46, flexShrink: 0, textAlign: 'center', padding: '5px 0', borderRadius: 10,
                background: 'rgba(184,92,61,0.06)', border: '1px dashed rgba(184,92,61,0.45)',
              }}>
                <div style={{ fontFamily: fonts.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: '#B85C3D' }}>
                  {dateLabelFromYmd(s.shiftDate).slice(0,3).toUpperCase()}
                </div>
                <div style={{ fontFamily: fonts.sans, fontSize: 16, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1, marginTop: 1, color: '#B85C3D' }}>
                  {Number(s.shiftDate.slice(8,10))}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: fonts.mono, fontSize: 12.5, fontWeight: 600, color: T.ink, letterSpacing: '0' }}>
                  {fmtRange(s.startTime, s.endTime)}
                </div>
                <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink2, marginTop: 3 }}>
                  {s.reason ?? ('Open shift')}
                </div>
              </div>
              <button
                onClick={() => pickUp(s.id)}
                disabled={busyId !== null}
                style={{
                  padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
                  background: T.brand, color: '#FFFFFF', border: `1px solid ${T.brand}`,
                  fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
                  opacity: busyId === s.id ? 0.5 : 1,
                }}
              >{busyId === s.id ? ('Picking…') : ('Pick up')}</button>
            </div>
          ))}
          {errorMsg && (
            <div role="alert" style={{
              padding: '10px 16px', fontSize: 12, color: '#B85C3D',
              background: 'rgba(184,92,61,0.08)',
            }}>{errorMsg}</div>
          )}
        </div>
      )}
    </div>
  );
}

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dateLabelFromYmd(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number);
  return `${MONTH_SHORT[(m ?? 1) - 1]} ${d ?? 0}`;
}

// ── Time-off card ─────────────────────────────────────────────────────────
function TimeOffCard({
  requests, hotelId, scopeKey, onAddRequest, onReconcile, es,
}: {
  requests: TimeOffRequest[];
  hotelId: string;
  scopeKey: string;
  onAddRequest: () => void;
  onReconcile: () => void;
  es: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const actionScopeRef = React.useRef<string | null>(scopeKey);
  const actionAttemptRef = React.useRef(0);
  const actionInFlightRef = React.useRef(false);
  React.useEffect(() => {
    actionScopeRef.current = scopeKey;
    return () => {
      if (actionScopeRef.current === scopeKey) actionScopeRef.current = null;
      actionAttemptRef.current += 1;
      actionInFlightRef.current = false;
    };
  }, [scopeKey]);

  const cancelRequest = async (id: string) => {
    if (actionInFlightRef.current) return;
    const requestedHotelId = hotelId;
    const attempt = ++actionAttemptRef.current;
    const ownsAttempt = () => (
      actionScopeRef.current === scopeKey
      && actionAttemptRef.current === attempt
    );
    actionInFlightRef.current = true;
    setBusyId(id);
    setErrorMsg(null);
    let responseReceived = false;
    try {
      const res = await fetchWithAuth(
        `/api/staff-schedule/time-off?hotelId=${encodeURIComponent(requestedHotelId)}&id=${encodeURIComponent(id)}`,
        { method: 'DELETE', timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS },
      );
      if (!ownsAttempt()) return;
      responseReceived = true;
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        if (!ownsAttempt()) return;
        throw new Error(b?.error || 'Could not cancel the request');
      }
      setConfirmId(null);
      // Realtime normally pushes this, but a fresh scoped snapshot is the
      // source of truth if the subscription was reconnecting or delayed.
      onReconcile();
    } catch (e) {
      if (!ownsAttempt()) return;
      if (!responseReceived) {
        onReconcile();
        if (!ownsAttempt()) return;
        setErrorMsg("We couldn't confirm whether the request was cancelled. We're refreshing your list before you try again.");
      } else {
        setErrorMsg(e instanceof Error ? e.message : 'Could not cancel the request');
      }
    } finally {
      if (ownsAttempt()) {
        actionInFlightRef.current = false;
        setBusyId(null);
      }
    }
  };

  return (
    <div style={{
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
      boxShadow: T.cardShadow,
      overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '14px 16px', borderBottom: `1px solid ${T.rule}`,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <Caps size={9}>{'Time off'}</Caps>
          <div style={{
            fontFamily: fonts.sans, fontSize: 14.5, fontWeight: 600,
            color: T.ink, letterSpacing: '-0.01em', marginTop: 3, lineHeight: 1.1,
          }}>{'Your requests'}</div>
        </div>
        <Btn variant="primary" size="sm" onClick={onAddRequest}>{'+ Request'}</Btn>
      </div>
      {requests.length === 0 ? (
        <div style={{
          padding: '22px 18px', textAlign: 'center', flex: 1,
          fontFamily: fonts.sans, fontSize: 13,
          color: T.ink3, letterSpacing: '0',
        }}>{'No active requests.'}</div>
      ) : (
        <div>
          {requests.slice(0, 8).map(r => (
            <TorRow
              key={r.id}
              r={r}
              confirming={confirmId === r.id}
              busy={busyId === r.id}
              disabled={busyId !== null}
              onAskCancel={() => { setErrorMsg(null); setConfirmId(r.id); }}
              onKeep={() => setConfirmId(null)}
              onConfirmCancel={() => { void cancelRequest(r.id); }}
              es={es}
            />
          ))}
          {errorMsg && (
            <div role="alert" style={{
              padding: '10px 16px', fontSize: 12, color: '#B85C3D',
              background: 'rgba(184,92,61,0.08)',
            }}>{errorMsg}</div>
          )}
        </div>
      )}
    </div>
  );
}

function TorRow({
  r, confirming, busy, disabled, onAskCancel, onKeep, onConfirmCancel, es,
}: {
  r: TimeOffRequest;
  confirming: boolean;
  busy: boolean;
  disabled: boolean;
  onAskCancel: () => void;
  onKeep: () => void;
  onConfirmCancel: () => void;
  es: boolean;
}) {
  const palette: Record<string, { fg: string; bg: string; br: string; label: string; icon: string }> = {
    pending:  { fg: '#8C6A33', bg: 'rgba(201,150,68,0.14)', br: 'rgba(140,106,51,0.32)', label: 'Pending',  icon: '⏱' },
    approved: { fg: '#356B4C', bg: 'rgba(53,107,76,0.10)',  br: 'rgba(53,107,76,0.30)',  label: 'Approved', icon: '✓' },
    denied:   { fg: '#B85C3D', bg: 'rgba(184,92,61,0.10)',  br: 'rgba(184,92,61,0.30)',  label: 'Denied',   icon: '✕' },
    cancelled:{ fg: T.ink3,    bg: 'transparent',           br: T.rule,                  label: 'Cancelled',icon: '·' },
  };
  const p = palette[r.status];
  return (
    <div style={{
      padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 12,
      borderBottom: `1px solid ${T.ruleSoft}`,
    }}>
      <span style={{
        width: 32, height: 32, flexShrink: 0, borderRadius: 10,
        background: p.bg, color: p.fg,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: fonts.sans, fontSize: 14, fontWeight: 600,
        border: `1px solid ${p.br}`,
      }}>{p.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: fonts.mono, fontSize: 12, fontWeight: 600, color: T.ink, letterSpacing: '0' }}>
            {dateLabelFromYmd(r.requestDate)}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999,
            background: p.bg, color: p.fg, border: `1px solid ${p.br}`,
            fontFamily: fonts.mono, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em',
          }}>{p.label.toUpperCase()}</span>
        </div>
        {r.reason && (
          <div style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink2, marginTop: 3, lineHeight: 1.45 }}>
            “{r.reason}”
          </div>
        )}
        {r.denyReason && r.status === 'denied' && (
          <div style={{ fontFamily: fonts.sans, fontSize: 11, color: '#B85C3D', marginTop: 2 }}>
            {'Reason'}: {r.denyReason}
          </div>
        )}
        {r.status === 'pending' && (
          confirming ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink2 }}>
                {'Take this request back?'}
              </span>
              <Btn variant="ghost" size="sm" onClick={onKeep} disabled={busy}>{'Keep it'}</Btn>
              <Btn variant="primary" size="sm" onClick={onConfirmCancel} disabled={busy}>
                {busy ? ('Cancelling…') : ('Yes, cancel')}
              </Btn>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAskCancel}
              disabled={disabled}
              style={{
                marginTop: 7, minHeight: 32, padding: '0 10px',
                display: 'inline-flex', alignItems: 'center',
                background: 'transparent', border: `1px solid ${T.rule}`, borderRadius: 999,
                fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600, color: T.ink2,
                cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
              }}
            >{'Cancel request'}</button>
          )
        )}
      </div>
    </div>
  );
}

// ── Request modal ─────────────────────────────────────────────────────────
function RequestTimeOffModal({
  hotelId, scopeKey, today, onClose, es,
}: { hotelId: string; scopeKey: string; today: string; onClose: () => void; es: boolean }) {
  const [requestDate, setRequestDate] = useState<string>(today);
  const [reason, setReason] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const dateId = useId();
  const reasonId = useId();
  const errorId = useId();
  const dialogRef = useStaffDialog(onClose);
  const actionScopeRef = React.useRef<string | null>(scopeKey);
  const actionAttemptRef = React.useRef(0);
  React.useEffect(() => {
    actionScopeRef.current = scopeKey;
    return () => {
      if (actionScopeRef.current === scopeKey) actionScopeRef.current = null;
      actionAttemptRef.current += 1;
    };
  }, [scopeKey]);

  const submit = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) { setErrorMsg('Pick a date.'); return; }
    const requestedHotelId = hotelId;
    const attempt = ++actionAttemptRef.current;
    const ownsAttempt = () => (
      actionScopeRef.current === scopeKey
      && actionAttemptRef.current === attempt
    );
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth('/api/staff-schedule/time-off', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId: requestedHotelId, requestDate, reason: reason || undefined }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      if (!ownsAttempt()) return;
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || ('Failed to submit'));
      }
      onClose();
    } catch (e) {
      if (!ownsAttempt()) return;
      setErrorMsg(e instanceof RequestTimeoutError
        ? ('Confirmation took too long. Check your requests before trying again.')
        : e instanceof Error ? e.message : ('Failed to submit'));
    } finally {
      if (ownsAttempt()) setBusy(false);
    }
  };

  return (
    <div onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(31,35,28,0.42)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div
        ref={dialogRef}
        className={dialogStyles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={e => e.stopPropagation()}
        style={{
        background: T.paper, borderRadius: 18, padding: '24px 26px',
        maxWidth: 420, width: '100%',
        boxShadow: '0 24px 60px -8px rgba(31,42,32,0.24), 0 0 0 1px rgba(31,35,28,0.04)',
      }}>
        <h2 id={titleId} style={{
          margin: 0, fontFamily: fonts.sans, fontSize: 18,
          color: T.ink, letterSpacing: '-0.02em', fontWeight: 600,
        }}>{'Request time off'}</h2>
        <p id={descriptionId} style={{ margin: '8px 0 16px', fontFamily: fonts.sans, fontSize: 13, color: T.ink2, lineHeight: 1.5 }}>
          {'Your manager will see this in the schedule grid and approve or deny.'}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label htmlFor={dateId}><Caps size={10}>{'Date'}</Caps></label>
            <input
              id={dateId}
              type="date" value={requestDate}
              onChange={e => setRequestDate(e.target.value)}
              min={today}
              data-dialog-initial-focus="true"
              aria-invalid={errorMsg ? true : undefined}
              aria-describedby={errorMsg ? errorId : undefined}
              style={{ ...inputStyle, marginTop: 6 }}
            />
          </div>
          <div>
            <label htmlFor={reasonId}><Caps size={10}>{'Reason (optional)'}</Caps></label>
            <input
              id={reasonId}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={'e.g. doctor appointment'}
              style={{ ...inputStyle, marginTop: 6 }}
            />
          </div>
          {errorMsg && (
            <div id={errorId} role="alert" style={{
              padding: '10px 14px', background: 'rgba(184,92,61,0.08)',
              border: '1px solid rgba(184,92,61,0.25)', borderRadius: 12,
              color: '#B85C3D', fontFamily: fonts.sans, fontSize: 13,
            }}>{errorMsg}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Btn variant="ghost" size="md" onClick={onClose} disabled={busy}>{'Cancel'}</Btn>
            <Btn variant="primary" size="md" onClick={submit} disabled={busy}>
              {busy ? ('Submitting…') : ('Submit')}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Not-linked empty state ─────────────────────────────────────────────────
function NotLinkedState({
  displayName, propertyName,
}: { displayName: string; propertyName: string }) {
  const { lang } = useLang();
  const es = false;
  return (
    <div style={{
      background: 'transparent', color: T.ink, fontFamily: fonts.sans,
      minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '64px 24px 130px',
    }}>
      <div style={{ maxWidth: 480, textAlign: 'center' }}>
        <div style={{ display: 'inline-flex', marginBottom: 18 }}>
          <Avatar staffId="unknown" name={displayName} size={64}/>
        </div>
        <Caps>{propertyName}</Caps>
        <h1 style={{
          fontFamily: fonts.sans, fontSize: 26, color: T.ink,
          margin: '8px 0 0', letterSpacing: '-0.02em', lineHeight: 1.15, fontWeight: 600,
        }}>
          <span>{`Hi, ${displayName}.`}</span>
        </h1>
        <p style={{
          margin: '14px auto 0', maxWidth: 380,
          fontFamily: fonts.sans, fontSize: 14, color: T.ink2, lineHeight: 1.6,
        }}>
          {<>Your account isn’t linked to your schedule profile yet. Ask your manager to open <strong style={{ color: T.ink }}>My Hotel → People</strong>, find you in the list, and link your login from your card.</>}
        </p>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '10px 14px', borderRadius: 12, border: `1px solid ${T.rule}`,
  background: T.paper, fontFamily: fonts.sans, fontSize: 13, color: T.ink,
  outline: 'none',
};
