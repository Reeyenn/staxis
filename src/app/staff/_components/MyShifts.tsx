// MyShifts — staff-side weekly view (MSv2Body / "Week strip" from the
// design), backed by scheduled_shifts (migration 0147).
//
//   • Greeting + hours-this-week card
//   • 7-card horizontal week strip (only published shifts; drafts hidden)
//   • Open shifts in your dept that you can pick up
//   • Time-off requests (real list + "+ Request" modal)
//
// Requires accounts.staff_id to be set. If null, render a friendly
// empty state — the manager has to link the account from the Directory.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { ScheduledShift, TimeOffRequest } from '@/types';
import { T, fonts, deptMeta, asDeptKey, Btn, Caps } from './_tokens';
import { Avatar } from './_people';
import { useWeekShifts, mondayOf } from './useWeekShifts';
import { fmtRange } from '@/lib/schedule-board';

export function MyShifts({ previewStaffId }: { previewStaffId?: string | null } = {}) {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff } = useProperty();
  const [requestOpen, setRequestOpen] = useState(false);
  const weekStart = useMemo(() => mondayOf(new Date()), []);

  // In demo "preview as staff" mode the page passes the staff row to render
  // as; otherwise this is the logged-in employee's own linked staffId.
  const staffId = previewStaffId !== undefined ? previewStaffId : (user?.staffId ?? null);
  const me = useMemo(() => staff.find(s => s.id === staffId) ?? null, [staff, staffId]);
  const {
    days, byStaff, openShifts, torByStaff, publishedDates, presets,
  } = useWeekShifts(activePropertyId, weekStart);

  const propName = activeProperty?.name ?? 'Your property';

  if (!staffId || !me) {
    return (
      <NotLinkedState
        displayName={user?.displayName ?? 'there'}
        propertyName={propName}
      />
    );
  }

  const meDept = deptMeta[asDeptKey(me.department)];
  // Only show *published* shifts (drafts are manager-side). Past dates
  // still render even if not in a published week — they ran historically.
  const myWeekFull = byStaff[me.id] ?? Array.from({ length: 7 }, () => ({ kind: 'off' as const }));
  const today = new Date().toLocaleDateString('en-CA');
  const myWeek = myWeekFull.map((c, i) => {
    if (c.kind !== 'shift') return c;
    if (publishedDates.has(c.shift.shiftDate) || c.shift.shiftDate < today) return c;
    return { kind: 'off' as const };
  });

  const myShiftCount = myWeek.filter(c => c.kind === 'shift').length;
  const myHrs = myWeek.reduce((sum, c) => {
    if (c.kind !== 'shift') return sum;
    return sum + hoursBetween(c.shift.startTime, c.shift.endTime);
  }, 0);
  const cap = me.maxWeeklyHours || 40;
  const firstName = me.name.split(/\s+/)[0] || me.name;
  const greeting = me.language === 'es' ? `Hola, ${firstName}.` : `Hi, ${firstName}.`;

  // Open shifts in my dept, in the visible week, that are published (i.e.
  // visible to staff) and in the future.
  const myDept = asDeptKey(me.department);
  const myOpenShifts = openShifts.filter(o =>
    o.department === myDept
    && o.status !== 'draft'
    && o.shiftDate >= today,
  ).sort((a, b) => a.shiftDate.localeCompare(b.shiftDate));

  // My TOR list: pending first, then recent decisions.
  const myTor = (torByStaff[me.id] ?? []).slice().sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return b.submittedAt.getTime() - a.submittedAt.getTime();
  });

  return (
    <div style={{
      background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%',
      padding: '28px 48px 56px',
    }}>
      <style>{`
        .my-shifts-week-strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; }
        .my-shifts-extras { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
        @media (max-width: 900px) {
          .my-shifts-week-strip { grid-template-columns: 1fr 1fr; }
          .my-shifts-extras { grid-template-columns: 1fr; }
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
              fontFamily: fonts.serif, fontSize: 42, color: T.ink,
              margin: '4px 0 0', letterSpacing: '-0.03em', lineHeight: 1.05, fontWeight: 400,
            }}>
              <span style={{ fontStyle: 'italic' }}>{greeting}</span>
            </h1>
          </div>
          <HoursCard hrs={myHrs} cap={cap} shifts={myShiftCount} tone={meDept.tone}/>
        </div>

        <div style={{
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          gap: 10, marginBottom: 12,
        }}>
          <div>
            <Caps size={9}>My schedule</Caps>
            <div style={{
              fontFamily: fonts.serif, fontSize: 22, fontStyle: 'italic',
              color: T.ink, letterSpacing: '-0.02em', marginTop: 3, lineHeight: 1.1,
            }}>Week at a glance</div>
          </div>
          <span style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.06em' }}>
            {days[0]?.dateLabel} – {days[6]?.dateLabel}
          </span>
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
                background: isToday ? T.ink : T.paper,
                color: isToday ? T.bg : T.ink,
                border: `1px solid ${isToday ? T.ink : T.rule}`, borderRadius: 14,
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
                      fontFamily: fonts.serif, fontSize: 24, fontStyle: 'italic', lineHeight: 1, marginTop: 1,
                      color: isToday ? T.bg : T.ink,
                    }}>{d.dayNum}</div>
                  </div>
                  {isToday && (
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700,
                      color: '#fff', background: 'rgba(255,255,255,0.18)',
                      border: '1px solid rgba(255,255,255,0.26)',
                      padding: '1px 6px', borderRadius: 999, letterSpacing: '0.08em', whiteSpace: 'nowrap',
                    }}>TODAY</span>
                  )}
                </div>
                {!isOff ? (
                  <div style={{
                    padding: '8px 10px', borderRadius: 8,
                    background: isToday ? 'rgba(255,255,255,0.12)' : meDept.dim,
                    border: `1px solid ${isToday ? 'rgba(255,255,255,0.20)' : meDept.tone + '33'}`,
                  }}>
                    <div style={{
                      fontFamily: fonts.serif, fontSize: 16, fontStyle: 'italic',
                      color: isToday ? T.bg : T.ink, letterSpacing: '-0.01em', lineHeight: 1.1,
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
                    fontFamily: fonts.serif, fontSize: 13, fontStyle: 'italic',
                    color: isToday ? 'rgba(255,255,255,0.6)' : T.ink3, textAlign: 'center',
                  }}>Day off</div>
                )}
              </div>
            );
          })}
        </div>

        <div className="my-shifts-extras">
          <OpenShiftsCard
            shifts={myOpenShifts}
            myDept={meDept.label.toLowerCase()}
            hotelId={activePropertyId ?? ''}
          />
          <TimeOffCard
            requests={myTor}
            onAddRequest={() => setRequestOpen(true)}
          />
        </div>

        {/* Recognition the manager gave you (in-app only; appears when you have some). */}
        <MyRecognitionCard hotelId={activePropertyId ?? ''} lang={me.language} />
      </div>

      {requestOpen && (
        <RequestTimeOffModal
          hotelId={activePropertyId ?? ''}
          onClose={() => setRequestOpen(false)}
        />
      )}
    </div>
  );
}

// ── Hours card ─────────────────────────────────────────────────────────────
function HoursCard({
  hrs, cap, shifts, tone,
}: { hrs: number; cap: number; shifts: number; tone: string }) {
  const pct = Math.min(1, cap > 0 ? hrs / cap : 0);
  return (
    <div style={{
      minWidth: 260, padding: '14px 18px',
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
    }}>
      <Caps size={9}>This week</Caps>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4, gap: 12 }}>
        <span style={{
          fontFamily: fonts.serif, fontSize: 38, color: T.ink,
          fontStyle: 'italic', letterSpacing: '-0.03em', lineHeight: 1,
        }}>
          {hrs}<span style={{ fontFamily: fonts.sans, fontSize: 13, fontStyle: 'normal', color: T.ink3, fontWeight: 500 }}>h</span>
        </span>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, fontWeight: 500 }}>
            {shifts} {shifts === 1 ? 'shift' : 'shifts'}
          </div>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, marginTop: 2 }}>of {cap}h cap</div>
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
  shifts, myDept, hotelId,
}: { shifts: ScheduledShift[]; myDept: string; hotelId: string }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const pickUp = async (shiftId: string) => {
    setBusyId(shiftId);
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth('/api/staff-schedule/pickup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId, shiftId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || 'Pick up failed');
      }
      // Realtime sub will refresh.
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Pick up failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
      overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '14px 16px', borderBottom: `1px solid ${T.rule}`,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <Caps size={9}>Pick up</Caps>
          <div style={{
            fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic',
            color: T.ink, letterSpacing: '-0.02em', marginTop: 3, lineHeight: 1.1,
          }}>Open shifts</div>
        </div>
        <span style={{
          fontFamily: fonts.mono, fontSize: 9.5,
          color: shifts.length > 0 ? '#A04A2C' : T.ink3,
          letterSpacing: '0.06em', fontWeight: 700,
          background: shifts.length > 0 ? 'rgba(160,74,44,0.10)' : 'rgba(31,35,28,0.04)',
          border: `1px solid ${shifts.length > 0 ? 'rgba(160,74,44,0.28)' : T.rule}`,
          padding: '3px 9px', borderRadius: 999,
        }}>{shifts.length} AVAILABLE</span>
      </div>
      {shifts.length === 0 ? (
        <div style={{
          padding: '22px 18px', textAlign: 'center', flex: 1,
          fontFamily: fonts.serif, fontSize: 16, fontStyle: 'italic',
          color: T.ink3, letterSpacing: '-0.01em',
        }}>No open shifts in {myDept} this week.</div>
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
                background: 'rgba(160,74,44,0.06)', border: '1px dashed rgba(160,74,44,0.45)',
              }}>
                <div style={{ fontFamily: fonts.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: '#A04A2C' }}>
                  {dateLabelFromYmd(s.shiftDate).slice(0,3).toUpperCase()}
                </div>
                <div style={{ fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic', lineHeight: 1, marginTop: 1, color: '#A04A2C' }}>
                  {Number(s.shiftDate.slice(8,10))}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: fonts.serif, fontSize: 16, fontStyle: 'italic', color: T.ink, letterSpacing: '-0.01em' }}>
                  {fmtRange(s.startTime, s.endTime)}
                </div>
                <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink2, marginTop: 3 }}>
                  {s.reason ?? 'Open shift'}
                </div>
              </div>
              <button
                onClick={() => pickUp(s.id)}
                disabled={busyId !== null}
                style={{
                  padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
                  background: T.ink, color: T.bg, border: `1px solid ${T.ink}`,
                  fontFamily: fonts.sans, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
                  opacity: busyId === s.id ? 0.5 : 1,
                }}
              >{busyId === s.id ? 'Picking…' : 'Pick up'}</button>
            </div>
          ))}
          {errorMsg && (
            <div role="alert" style={{
              padding: '10px 16px', fontSize: 12, color: '#A04A2C',
              background: 'rgba(160,74,44,0.08)',
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
  requests, onAddRequest,
}: { requests: TimeOffRequest[]; onAddRequest: () => void }) {
  return (
    <div style={{
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
      overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '14px 16px', borderBottom: `1px solid ${T.rule}`,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <Caps size={9}>Time off</Caps>
          <div style={{
            fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic',
            color: T.ink, letterSpacing: '-0.02em', marginTop: 3, lineHeight: 1.1,
          }}>Your requests</div>
        </div>
        <Btn variant="primary" size="sm" onClick={onAddRequest}>+ Request</Btn>
      </div>
      {requests.length === 0 ? (
        <div style={{
          padding: '22px 18px', textAlign: 'center', flex: 1,
          fontFamily: fonts.serif, fontSize: 16, fontStyle: 'italic',
          color: T.ink3, letterSpacing: '-0.01em',
        }}>No active requests.</div>
      ) : (
        <div>
          {requests.slice(0, 8).map(r => <TorRow key={r.id} r={r}/>)}
        </div>
      )}
    </div>
  );
}

function TorRow({ r }: { r: TimeOffRequest }) {
  const palette: Record<string, { fg: string; bg: string; br: string; label: string; icon: string }> = {
    pending:  { fg: '#8C6A33', bg: 'rgba(201,150,68,0.14)', br: 'rgba(140,106,51,0.32)', label: 'Pending',  icon: '⏱' },
    approved: { fg: '#3F5A43', bg: 'rgba(92,122,96,0.12)',  br: 'rgba(92,122,96,0.30)',  label: 'Approved', icon: '✓' },
    denied:   { fg: '#A04A2C', bg: 'rgba(160,74,44,0.10)',  br: 'rgba(160,74,44,0.30)',  label: 'Denied',   icon: '✕' },
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
        fontFamily: fonts.serif, fontSize: 16, fontStyle: 'italic',
        border: `1px solid ${p.br}`,
      }}>{p.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: fonts.serif, fontSize: 15, fontStyle: 'italic', color: T.ink, letterSpacing: '-0.01em' }}>
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
          <div style={{ fontFamily: fonts.sans, fontSize: 11, color: '#A04A2C', marginTop: 2 }}>
            Reason: {r.denyReason}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Request modal ─────────────────────────────────────────────────────────
function RequestTimeOffModal({
  hotelId, onClose,
}: { hotelId: string; onClose: () => void }) {
  const today = new Date().toLocaleDateString('en-CA');
  const [requestDate, setRequestDate] = useState<string>(today);
  const [reason, setReason] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const submit = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) { setErrorMsg('Pick a date.'); return; }
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth('/api/staff-schedule/time-off', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId, requestDate, reason: reason || undefined }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || 'Failed to submit');
      }
      onClose();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to submit');
    } finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(31,35,28,0.42)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: T.paper, borderRadius: 22, padding: '24px 26px',
        maxWidth: 420, width: '100%',
        boxShadow: '0 24px 60px -8px rgba(31,35,28,0.20), 0 0 0 1px rgba(31,35,28,0.04)',
      }}>
        <h2 style={{
          margin: 0, fontFamily: fonts.serif, fontSize: 24, fontStyle: 'italic',
          color: T.ink, letterSpacing: '-0.02em', fontWeight: 400,
        }}>Request time off</h2>
        <p style={{ margin: '8px 0 16px', fontFamily: fonts.sans, fontSize: 13, color: T.ink2, lineHeight: 1.5 }}>
          Your manager will see this in the schedule grid and approve or deny.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <Caps size={10}>Date</Caps>
            <input
              type="date" value={requestDate}
              onChange={e => setRequestDate(e.target.value)}
              min={today}
              style={{ ...inputStyle, marginTop: 6 }}
            />
          </div>
          <div>
            <Caps size={10}>Reason (optional)</Caps>
            <input
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. doctor appointment"
              style={{ ...inputStyle, marginTop: 6 }}
            />
          </div>
          {errorMsg && (
            <div role="alert" style={{
              padding: '10px 14px', background: 'rgba(160,74,44,0.08)',
              border: '1px solid rgba(160,74,44,0.25)', borderRadius: 12,
              color: '#A04A2C', fontFamily: fonts.sans, fontSize: 13,
            }}>{errorMsg}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Btn variant="ghost" size="md" onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn variant="primary" size="md" onClick={submit} disabled={busy}>
              {busy ? 'Submitting…' : 'Submit'}
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
  return (
    <div style={{
      background: T.bg, color: T.ink, fontFamily: fonts.sans,
      minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '64px 24px',
    }}>
      <div style={{ maxWidth: 480, textAlign: 'center' }}>
        <div style={{ display: 'inline-flex', marginBottom: 18 }}>
          <Avatar staffId="unknown" name={displayName} size={64}/>
        </div>
        <Caps>{propertyName}</Caps>
        <h1 style={{
          fontFamily: fonts.serif, fontSize: 32, color: T.ink,
          margin: '8px 0 0', letterSpacing: '-0.02em', lineHeight: 1.15, fontWeight: 400,
        }}>
          <span style={{ fontStyle: 'italic' }}>Hi, {displayName}.</span>
        </h1>
        <p style={{
          margin: '14px auto 0', maxWidth: 380,
          fontFamily: fonts.sans, fontSize: 14, color: T.ink2, lineHeight: 1.6,
        }}>
          Your account isn’t linked to a staff record yet. Ask your manager to open <strong style={{ color: T.ink }}>Staff → Directory</strong> and link your login from your staff card.
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

// ── My recognition card ────────────────────────────────────────────────────
// Closes the kudos loop: the recipient sees recognition their manager gave
// them, in-app (no SMS). Reads only the caller's OWN kudos via
// GET /api/staff/kudos?scope=mine. Hidden until there's something to show.
const KUDOS_CAT_LABEL: Record<string, { en: string; es: string }> = {
  'guest-praise':     { en: 'Guest praise',   es: 'Elogio de huésped' },
  'teamwork':         { en: 'Teamwork',       es: 'Trabajo en equipo' },
  'above-and-beyond': { en: 'Above & beyond', es: 'Excepcional' },
  'attendance':       { en: 'Attendance',     es: 'Asistencia' },
};

interface MyKudos {
  id: string;
  message: string;
  category: string | null;
  givenByName: string | null;
  createdAt: string | null;
}

function MyRecognitionCard({ hotelId, lang }: { hotelId: string; lang: 'en' | 'es' }) {
  const [kudos, setKudos] = useState<MyKudos[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!hotelId) return;
    let active = true;
    fetchWithAuth(`/api/staff/kudos?hotelId=${hotelId}&scope=mine`)
      .then(r => (r.ok ? r.json() : null))
      .then((b: { data?: { kudos?: MyKudos[] } } | null) => {
        if (!active) return;
        setKudos(b?.data?.kudos ?? []);
        setLoaded(true);
      })
      .catch(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [hotelId]);

  // Keep My Shifts clean — only show the card once there's recognition to show.
  if (!loaded || kudos.length === 0) return null;

  return (
    <div style={{
      marginTop: 24, background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18, overflow: 'hidden',
    }}>
      <div style={{
        padding: '14px 18px', borderBottom: `1px solid ${T.rule}`,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <Caps size={9}>{lang === 'es' ? 'Reconocimiento' : 'Recognition'}</Caps>
          <div style={{
            fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic',
            color: T.ink, letterSpacing: '-0.02em', marginTop: 3, lineHeight: 1.1,
          }}>{lang === 'es' ? 'Para ti ✨' : 'For you ✨'}</div>
        </div>
        <span style={{
          fontFamily: fonts.mono, fontSize: 9.5, color: '#8C6A33', letterSpacing: '0.06em', fontWeight: 700,
          background: 'rgba(201,150,68,0.14)', border: '1px solid rgba(140,106,51,0.32)',
          padding: '3px 9px', borderRadius: 999,
        }}>{kudos.length}</span>
      </div>
      <div>
        {kudos.slice(0, 6).map(k => {
          const cat = k.category && KUDOS_CAT_LABEL[k.category]
            ? (lang === 'es' ? KUDOS_CAT_LABEL[k.category].es : KUDOS_CAT_LABEL[k.category].en)
            : null;
          return (
            <div key={k.id} style={{
              padding: '12px 18px', borderBottom: `1px solid ${T.ruleSoft}`,
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {cat && (
                  <span style={{
                    fontFamily: fonts.sans, fontSize: 10.5, fontWeight: 600, color: '#8C6A33',
                    background: 'rgba(201,150,68,0.14)', border: '1px solid rgba(140,106,51,0.28)',
                    padding: '1px 8px', borderRadius: 999,
                  }}>{cat}</span>
                )}
                {k.givenByName && (
                  <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3 }}>
                    {lang === 'es' ? 'Por' : 'From'} {k.givenByName}
                  </span>
                )}
              </div>
              <div style={{
                fontFamily: fonts.serif, fontSize: 16, fontStyle: 'italic', color: T.ink,
                lineHeight: 1.45, wordBreak: 'break-word',
              }}>“{k.message}”</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
