// Manager Schedule — interactive week grid backed by scheduled_shifts.
//
// 7-column Mon→Sun grid. Rows = staff grouped by department. Click any
// cell to assign someone, post the slot as open, or change/remove an
// existing shift. The Publish Week button promotes draft cells to
// published (visible to staff in My Shifts); Copy Last Week clones the
// previous week's assignments (skipping approved-TOR conflicts).

'use client';

import React, { useMemo, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { ScheduledShift, StaffMember, TimeOffRequest } from '@/types';
import { T, fonts, deptMeta, asDeptKey, Btn, Caps } from './_tokens';
import { StaffAvatar, SMTag, PageHeader } from './_people';
import { useWeekShifts, mondayOf, addDays } from './useWeekShifts';

const DEPT_ORDER: ('housekeeping' | 'front_desk' | 'maintenance')[] = [
  'housekeeping', 'front_desk', 'maintenance',
];

// 'HH:MM' → 8a / 8:30a / 12p / 4p / 11p
function fmtTime(t: string): string {
  const [hh, mm] = t.split(':').map(Number);
  if (Number.isNaN(hh)) return t;
  const ampm = hh >= 12 ? 'p' : 'a';
  let h12 = hh % 12;
  if (h12 === 0) h12 = 12;
  return mm ? `${h12}:${String(mm).padStart(2,'0')}${ampm}` : `${h12}${ampm}`;
}
export function fmtRange(start: string, end: string): string {
  return `${fmtTime(start)}–${fmtTime(end)}`;
}

export function ManagerSchedule() {
  const { activePropertyId, staff } = useProperty();
  const [weekStart, setWeekStart] = useState<string>(() => mondayOf(new Date()));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<'publish' | 'copy' | null>(null);

  const { days, byStaff, openShifts, torPending, publishedDates, presets, loading } =
    useWeekShifts(activePropertyId, weekStart);

  // Roster ordered HK → FD → MT, alpha within group, active only.
  const rows = useMemo(() => {
    const ord: Record<string, number> = { housekeeping: 0, front_desk: 1, maintenance: 2, other: 3 };
    return [...staff].filter(s => s.isActive !== false)
      .sort((a, b) => {
        const oa = ord[asDeptKey(a.department)] ?? 3;
        const ob = ord[asDeptKey(b.department)] ?? 3;
        if (oa !== ob) return oa - ob;
        return a.name.localeCompare(b.name);
      });
  }, [staff]);

  // Index open shifts by (day, dept) so we can render extra "OPEN" rows.
  const openByDayDept = useMemo(() => {
    const m: Record<string, ScheduledShift[]> = {};
    for (const o of openShifts) {
      const key = `${o.shiftDate}:${o.department}`;
      if (!m[key]) m[key] = [];
      m[key].push(o);
    }
    return m;
  }, [openShifts]);

  // Coverage row: per-day count of assigned shifts (excluding open).
  const coverage = useMemo(() => days.map((d) => {
    return rows.filter(r => byStaff[r.id]?.[days.findIndex(x => x.date === d.date)]?.kind === 'shift').length;
  }), [days, rows, byStaff]);

  const totalShifts = useMemo(
    () => rows.reduce((sum, r) => sum + (byStaff[r.id]?.filter(c => c.kind === 'shift').length ?? 0), 0),
    [rows, byStaff],
  );
  const draftCount = useMemo(
    () => Object.values(byStaff).flat().filter(c => c.kind === 'shift' && c.shift.status === 'draft').length
       + openShifts.filter(s => s.status === 'draft').length,
    [byStaff, openShifts],
  );

  const startLabel = days[0]?.dateLabel ?? '';
  const endLabel   = days[6]?.dateLabel ?? '';
  const weekPublished = days.every(d => publishedDates.has(d.date));

  const handlePublish = async () => {
    if (!activePropertyId || actionBusy) return;
    setActionBusy('publish');
    setActionMsg(null);
    try {
      const res = await fetchWithAuth('/api/staff-schedule/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId: activePropertyId, weekStart, action: 'publish' }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || 'Publish failed');
      }
      const body = await res.json();
      const n = body?.data?.published ?? 0;
      setActionMsg(`Published — ${n} ${n === 1 ? 'shift' : 'shifts'} now visible to staff.`);
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : 'Publish failed');
    } finally { setActionBusy(null); }
  };

  const handleCopy = async () => {
    if (!activePropertyId || actionBusy) return;
    if (!window.confirm('Copy last week\'s shifts into this week? Existing shifts here will be overwritten.')) return;
    setActionBusy('copy');
    setActionMsg(null);
    try {
      const res = await fetchWithAuth('/api/staff-schedule/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId: activePropertyId, weekStart, action: 'copy' }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || 'Copy failed');
      }
      const body = await res.json();
      const copied = body?.data?.copied ?? 0;
      const skipped = body?.data?.skipped ?? 0;
      setActionMsg(`Copied ${copied} ${copied === 1 ? 'shift' : 'shifts'}${skipped ? ` · ${skipped} skipped (TOR)` : ''}.`);
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : 'Copy failed');
    } finally { setActionBusy(null); }
  };

  return (
    <div style={{
      background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%',
      padding: '24px 48px 48px',
    }}>
      <style>{`
        .staff-schedule-scroll { overflow-x: auto; }
        @media (max-width: 900px) {
          .staff-schedule-grid { min-width: 820px; }
        }
        .schedule-cell { cursor: pointer; transition: background 0.1s; }
        .schedule-cell:hover { background: rgba(31,35,28,0.03); }
      `}</style>

      <PageHeader
        title="The week at a glance"
        eyebrow={`Schedule · Week of ${startLabel}`}
        sub="Click any cell to assign someone, post the slot as open, or change a shift. Publish when you’re happy with the week."
      />

      <div style={{
        display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <Btn variant="ghost" size="sm" onClick={() => setWeekStart(addDays(weekStart, -7))}>‹</Btn>
        <span style={{ fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic', color: T.ink, padding: '0 6px' }}>
          {startLabel} – {endLabel}
        </span>
        <Btn variant="ghost" size="sm" onClick={() => setWeekStart(addDays(weekStart, 7))}>›</Btn>
        <Btn variant="ghost" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>Today</Btn>
        <span style={{ flex: 1 }}/>
        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.06em' }}>
          {totalShifts} shifts
          {draftCount > 0 && <> · <span style={{ color: '#8C6A33' }}>{draftCount} draft</span></>}
        </span>
        <Btn variant="ghost" size="sm" onClick={handleCopy} disabled={actionBusy !== null}>
          {actionBusy === 'copy' ? 'Copying…' : '⎘ Copy last week'}
        </Btn>
        <Btn variant="primary" size="sm" onClick={handlePublish} disabled={actionBusy !== null}>
          {actionBusy === 'publish' ? 'Publishing…' : weekPublished ? 'Re-publish' : 'Publish week'}
        </Btn>
      </div>

      {actionMsg && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: 'rgba(92,122,96,0.08)', border: '1px solid rgba(92,122,96,0.30)',
          borderRadius: 12, fontSize: 13, color: '#3F5A43',
        }}>{actionMsg}</div>
      )}

      <div className="staff-schedule-scroll">
        <div className="staff-schedule-grid" style={{
          background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16, overflow: 'visible',
        }}>
          {/* day headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '220px repeat(7, 1fr)',
            background: '#FBFAF6', borderBottom: `1px solid ${T.rule}`,
            borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden',
          }}>
            <div style={{ padding: '12px 16px', fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.08em', fontWeight: 600 }}>STAFF</div>
            {days.map(d => (
              <div key={d.key} style={{
                padding: '12px 8px', textAlign: 'center',
                background: d.today ? 'rgba(201,150,68,0.10)' : d.tomorrow ? 'rgba(92,122,96,0.08)' : 'transparent',
                borderLeft: `1px solid ${T.ruleSoft}`,
              }}>
                <div style={{
                  fontFamily: fonts.mono, fontSize: 10,
                  color: d.today ? '#8C6A33' : d.tomorrow ? '#5C7A60' : T.ink3,
                  letterSpacing: '0.06em', fontWeight: 600,
                }}>{d.label.toUpperCase()}{d.today && ' · TODAY'}{d.tomorrow && ' · TOMORROW'}</div>
                <div style={{ fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic', color: T.ink, marginTop: 2 }}>{d.dayNum}</div>
              </div>
            ))}
          </div>

          {DEPT_ORDER.map(dept => {
            const m = deptMeta[dept];
            const list = rows.filter(r => asDeptKey(r.department) === dept);
            if (list.length === 0 && Object.keys(openByDayDept).every(k => !k.endsWith(dept))) return null;
            return (
              <React.Fragment key={dept}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '220px 1fr',
                  padding: '8px 16px', background: '#FCFBF8',
                  borderBottom: `1px solid ${T.ruleSoft}`,
                  alignItems: 'center', gap: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.tone }}/>
                    <span style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink2, letterSpacing: '0.08em', fontWeight: 600, textTransform: 'uppercase' }}>{m.label}</span>
                    <span style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3 }}>· {list.length}</span>
                  </div>
                </div>

                {list.map(s => {
                  const wkShifts = byStaff[s.id]?.filter(c => c.kind === 'shift').length ?? 0;
                  // Approx hours sum across the week.
                  const wkHrs = byStaff[s.id]?.reduce((sum, c) => {
                    if (c.kind !== 'shift') return sum;
                    return sum + hoursBetween(c.shift.startTime, c.shift.endTime);
                  }, 0) ?? 0;
                  const overCap = !!s.maxWeeklyHours && wkHrs > s.maxWeeklyHours;
                  return (
                    <div key={s.id} style={{
                      display: 'grid', gridTemplateColumns: '220px repeat(7, 1fr)',
                      borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px' }}>
                        <StaffAvatar staff={s} size={28}/>
                        <div style={{ minWidth: 0 }}>
                          <div style={{
                            fontSize: 13, fontWeight: 600, color: T.ink,
                            display: 'flex', alignItems: 'center', gap: 6,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>
                            {s.name}
                            {s.isSchedulingManager && <SMTag size={8.5} compact/>}
                          </div>
                          <div style={{
                            fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: '0.04em',
                            color: overCap ? '#A04A2C' : T.ink3,
                            fontWeight: overCap ? 700 : 500,
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                          }}>
                            {wkHrs}h · {wkShifts}d
                            {overCap && (
                              <span style={{
                                fontSize: 8.5, fontWeight: 700, color: '#A04A2C',
                                background: 'rgba(160,74,44,0.10)', border: '1px solid rgba(160,74,44,0.28)',
                                padding: '0 5px', borderRadius: 999, letterSpacing: '0.06em', marginLeft: 2,
                              }}>OT</span>
                            )}
                          </div>
                        </div>
                      </div>
                      {days.map((d, di) => {
                        const cell = byStaff[s.id]?.[di] ?? { kind: 'off' as const };
                        const tor  = torPending[`${s.id}:${d.date}`] ?? null;
                        return (
                          <div key={d.key} style={{
                            borderLeft: `1px solid ${T.ruleSoft}`,
                            background: d.today ? 'rgba(201,150,68,0.04)' : d.tomorrow ? 'rgba(92,122,96,0.04)' : 'transparent',
                            position: 'relative',
                          }}>
                            <ScheduleCell
                              cell={cell} tone={m.tone} past={d.past} tor={tor}
                              onClick={() => setEditor({
                                kind: 'cell',
                                staff: s, dept: asDeptKey(s.department),
                                date: d.date, dayLabel: `${d.label} ${d.dateLabel}`,
                                existing: cell.kind === 'shift' ? cell.shift : null,
                                tor,
                              })}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                {/* Open-shift rows: one row per dept showing per-day open slots. */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '220px repeat(7, 1fr)',
                  borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center',
                  background: '#FBFAF6',
                }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
                    fontFamily: fonts.mono, fontSize: 9.5, color: '#A04A2C',
                    letterSpacing: '0.08em', fontWeight: 700,
                  }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#A04A2C' }}/>
                    OPEN · {m.short}
                  </div>
                  {days.map((d, di) => {
                    const open = openByDayDept[`${d.date}:${dept}`] ?? [];
                    return (
                      <div key={d.key} style={{
                        borderLeft: `1px solid ${T.ruleSoft}`,
                        padding: 6, minHeight: 34,
                        display: 'flex', flexDirection: 'column', gap: 4,
                        background: d.today ? 'rgba(201,150,68,0.04)' : d.tomorrow ? 'rgba(92,122,96,0.04)' : 'transparent',
                      }}>
                        {open.map(o => (
                          <button
                            key={o.id}
                            className="schedule-cell"
                            onClick={() => setEditor({
                              kind: 'open',
                              dept, date: d.date, dayLabel: `${d.label} ${d.dateLabel}`,
                              existing: o,
                            })}
                            style={{
                              all: 'unset', cursor: 'pointer',
                              padding: '4px 8px', borderRadius: 6,
                              background: 'rgba(160,74,44,0.06)',
                              border: '1px dashed rgba(160,74,44,0.45)',
                              fontFamily: fonts.mono, fontSize: 10, color: '#A04A2C',
                              fontWeight: 700, textAlign: 'center', letterSpacing: '0.04em',
                            }}
                            title={o.reason ?? undefined}
                          >OPEN · {fmtRange(o.startTime, o.endTime)}</button>
                        ))}
                        <button
                          className="schedule-cell"
                          onClick={() => setEditor({
                            kind: 'open-new',
                            dept, date: d.date, dayLabel: `${d.label} ${d.dateLabel}`,
                            existing: null,
                          })}
                          style={{
                            all: 'unset', cursor: 'pointer',
                            padding: '2px', borderRadius: 6,
                            fontFamily: fonts.mono, fontSize: 9, color: T.ink3,
                            fontWeight: 500, textAlign: 'center', letterSpacing: '0.04em',
                            border: '1px dashed transparent',
                            ...(open.length === 0 ? { color: 'transparent' } : {}),
                          }}
                        >＋</button>
                      </div>
                    );
                  })}
                </div>
              </React.Fragment>
            );
          })}

          {/* coverage row */}
          <div style={{
            display: 'grid', gridTemplateColumns: '220px repeat(7, 1fr)',
            background: '#FBFAF6', borderTop: `1px solid ${T.rule}`,
            borderBottomLeftRadius: 16, borderBottomRightRadius: 16, overflow: 'hidden',
          }}>
            <div style={{ padding: '12px 16px', fontFamily: fonts.mono, fontSize: 10, color: T.ink2, letterSpacing: '0.08em', fontWeight: 600 }}>COVERAGE</div>
            {coverage.map((n, di) => {
              const isWeekend = days[di]?.key === 'sat' || days[di]?.key === 'sun';
              const rec = isWeekend ? 4 : 5;
              const short = n > 0 && n < rec;
              const empty = n === 0;
              return (
                <div key={di} style={{
                  padding: '10px 8px', textAlign: 'center', borderLeft: `1px solid ${T.ruleSoft}`,
                  background: days[di]?.today ? 'rgba(201,150,68,0.06)' : days[di]?.tomorrow ? 'rgba(92,122,96,0.06)' : 'transparent',
                }}>
                  <div style={{
                    fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic',
                    color: short ? '#A04A2C' : empty ? T.ink3 : T.ink,
                  }}>{n}<span style={{ color: T.ink3, fontFamily: fonts.sans, fontStyle: 'normal', fontSize: 11, fontWeight: 500 }}>/{rec}</span></div>
                  <div style={{
                    fontFamily: fonts.mono, fontSize: 9,
                    color: short ? '#A04A2C' : T.ink3, marginTop: 1, letterSpacing: '0.06em', fontWeight: 600,
                  }}>{empty ? '—' : short ? 'SHORT' : 'OK'}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div style={{
        marginTop: 14, padding: '12px 18px',
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 12,
        display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap',
        fontFamily: fonts.sans, fontSize: 12, color: T.ink2,
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            display: 'inline-block', width: 18, height: 10, borderRadius: 4,
            background: 'rgba(92,122,96,0.18)', border: '1px solid rgba(92,122,96,0.40)',
          }}/>
          Published
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            display: 'inline-block', width: 18, height: 10, borderRadius: 4,
            background: 'rgba(201,150,68,0.14)', border: '1px solid rgba(201,150,68,0.40)',
          }}/>
          Draft
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            display: 'inline-block', width: 18, height: 10, borderRadius: 4,
            background: 'rgba(160,74,44,0.06)', border: '1px dashed rgba(160,74,44,0.45)',
          }}/>
          Open
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700, color: '#8C6A33',
            background: 'rgba(201,150,68,0.14)', border: '1px solid rgba(140,106,51,0.32)',
            padding: '1px 6px', borderRadius: 999,
          }}>⏱</span>
          Time-off request
        </span>
        <span style={{ flex: 1 }}/>
        <span style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.06em' }}>
          Send tomorrow’s texts from <strong>Housekeeping → Schedule</strong>
        </span>
      </div>

      {/* Cell-edit modal */}
      {editor && (
        <CellEditor
          state={editor}
          presets={presets}
          allStaff={staff}
          onClose={() => setEditor(null)}
          hotelId={activePropertyId ?? ''}
          weekDates={days.map(d => d.date)}
        />
      )}

      {loading && (
        <div style={{
          position: 'fixed', bottom: 14, right: 14,
          fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.08em',
        }}>LOADING…</div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ScheduleCell — one cell in the manager grid.
// ────────────────────────────────────────────────────────────────────────────

function ScheduleCell({
  cell, tone, past, tor, onClick,
}: {
  cell: { kind: 'shift'; shift: ScheduledShift } | { kind: 'off' };
  tone: string;
  past: boolean;
  tor: TimeOffRequest | null;
  onClick: () => void;
}) {
  if (cell.kind === 'shift') {
    const s = cell.shift;
    const isDraft = s.status === 'draft';
    const isPending = s.status === 'sent';
    const fg = isDraft ? '#8C6A33' : isPending ? '#8C6A33' : tone;
    const bg = isDraft ? 'rgba(201,150,68,0.14)' : isPending ? 'rgba(201,150,68,0.14)' : `${tone}1A`;
    const br = isDraft ? '1px dashed rgba(140,106,51,0.45)' : isPending ? '1px solid rgba(140,106,51,0.32)' : `1px solid ${tone}33`;
    return (
      <button className="schedule-cell" onClick={onClick} style={{
        all: 'unset', cursor: 'pointer', display: 'block',
        padding: 6, minHeight: 34, width: '100%', boxSizing: 'border-box', position: 'relative',
      }}>
        <div style={{
          padding: '5px 8px', borderRadius: 6,
          background: bg, border: br,
          color: fg, fontFamily: fonts.mono, fontSize: 10.5, fontWeight: 600,
          textAlign: 'center', letterSpacing: '0.02em',
          opacity: past ? 0.55 : 1,
        }}>{fmtRange(s.startTime, s.endTime)}</div>
        {tor && <TorPin/>}
      </button>
    );
  }
  return (
    <button className="schedule-cell" onClick={onClick} style={{
      all: 'unset', cursor: 'pointer', display: 'block',
      padding: '8px 4px', minHeight: 34, width: '100%', boxSizing: 'border-box',
      color: tor ? '#8C6A33' : T.ink3, fontSize: 11, fontFamily: fonts.mono,
      textAlign: 'center', position: 'relative',
    }}>{tor ? '⏱' : '·'}</button>
  );
}

function TorPin() {
  return (
    <span title="Pending time-off request" style={{
      position: 'absolute', top: -3, left: -3,
      width: 14, height: 14, borderRadius: '50%',
      background: 'rgba(201,150,68,0.95)', color: '#fff',
      fontSize: 8, fontWeight: 700,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: `0 0 0 1.5px ${T.paper}`, letterSpacing: 0,
    }}>⏱</span>
  );
}

function hoursBetween(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

// ────────────────────────────────────────────────────────────────────────────
// CellEditor — popover-as-modal for assigning, opening, removing, or
// approving a TOR on a cell.
// ────────────────────────────────────────────────────────────────────────────

type EditorState =
  | {
      kind: 'cell';
      staff: StaffMember;
      dept: 'housekeeping' | 'front_desk' | 'maintenance' | 'other';
      date: string;
      dayLabel: string;
      existing: ScheduledShift | null;
      tor: TimeOffRequest | null;
    }
  | {
      kind: 'open';
      dept: 'housekeeping' | 'front_desk' | 'maintenance' | 'other';
      date: string;
      dayLabel: string;
      existing: ScheduledShift;
    }
  | {
      kind: 'open-new';
      dept: 'housekeeping' | 'front_desk' | 'maintenance' | 'other';
      date: string;
      dayLabel: string;
      existing: null;
    };

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function CellEditor({
  state, presets, allStaff, onClose, hotelId, weekDates,
}: {
  state: EditorState;
  presets: { id: string; name: string; department: string; startTime: string; endTime: string }[];
  allStaff: StaffMember[];
  onClose: () => void;
  hotelId: string;
  weekDates: string[];
}) {
  const dept = state.dept;
  const deptPresets = useMemo(() => presets.filter(p => p.department === dept), [presets, dept]);
  const initialPreset =
    state.kind === 'cell' && state.existing?.presetId
      ? deptPresets.find(p => p.id === state.existing!.presetId) ?? null
      : (state.kind === 'open' && state.existing.presetId
        ? deptPresets.find(p => p.id === state.existing.presetId) ?? null
        : null);

  const initialStart =
    state.kind === 'cell' ? (state.existing?.startTime ?? deptPresets[0]?.startTime ?? '08:00')
    : state.kind === 'open' ? state.existing.startTime
    : (deptPresets[0]?.startTime ?? '08:00');
  const initialEnd =
    state.kind === 'cell' ? (state.existing?.endTime ?? deptPresets[0]?.endTime ?? '16:00')
    : state.kind === 'open' ? state.existing.endTime
    : (deptPresets[0]?.endTime ?? '16:00');

  const [presetId, setPresetId] = useState<string | null>(initialPreset?.id ?? deptPresets[0]?.id ?? null);
  const [startTime, setStartTime] = useState<string>(initialStart);
  const [endTime, setEndTime] = useState<string>(initialEnd);
  const [note, setNote] = useState<string>(state.kind === 'cell' ? (state.existing?.note ?? '') : '');
  const [reason, setReason] = useState<string>(state.kind === 'open' ? (state.existing.reason ?? '') : '');
  const [busy, setBusy] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Choose preset → autofill times.
  const pickPreset = (id: string) => {
    const p = deptPresets.find(x => x.id === id);
    if (!p) return;
    setPresetId(p.id);
    setStartTime(p.startTime);
    setEndTime(p.endTime);
  };

  const saveAssignment = async () => {
    if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
      setErrorMsg('Use HH:MM (e.g. 08:00).');
      return;
    }
    setBusy('save');
    setErrorMsg(null);
    try {
      const shift = {
        id: state.kind === 'cell' ? state.existing?.id : undefined,
        staffId: state.kind === 'cell' ? state.staff.id : null,
        department: dept,
        shiftDate: state.date,
        startTime, endTime,
        kind: state.kind === 'cell' ? 'shift' : 'open',
        presetId,
        note: state.kind === 'cell' ? (note || null) : null,
        reason: state.kind !== 'cell' ? (reason || null) : null,
      };
      const res = await fetchWithAuth('/api/staff-schedule/shifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId, shift }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || 'Save failed');
      }
      onClose();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Save failed');
    } finally { setBusy(null); }
  };

  const postAsOpen = async () => {
    if (state.kind !== 'cell') return;
    setBusy('open');
    setErrorMsg(null);
    try {
      // If the cell currently has an assignment, delete that first.
      if (state.existing?.id) {
        await fetchWithAuth(`/api/staff-schedule/shifts?hotelId=${hotelId}&id=${state.existing.id}`, { method: 'DELETE' });
      }
      const res = await fetchWithAuth('/api/staff-schedule/shifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hotelId,
          shift: {
            staffId: null,
            department: dept,
            shiftDate: state.date,
            startTime, endTime,
            kind: 'open',
            presetId,
            reason: reason || (state.existing ? `Was ${state.staff.name}` : null),
          },
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || 'Post-as-open failed');
      }
      onClose();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Post-as-open failed');
    } finally { setBusy(null); }
  };

  const removeShift = async () => {
    const id = state.kind === 'cell' ? state.existing?.id : state.kind === 'open' ? state.existing.id : null;
    if (!id) { onClose(); return; }
    if (!window.confirm('Remove this shift?')) return;
    setBusy('remove');
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth(`/api/staff-schedule/shifts?hotelId=${hotelId}&id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || 'Remove failed');
      }
      onClose();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Remove failed');
    } finally { setBusy(null); }
  };

  const decideTor = async (decision: 'approve' | 'deny') => {
    if (state.kind !== 'cell' || !state.tor) return;
    setBusy(decision);
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth('/api/staff-schedule/time-off', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId, id: state.tor.id, decision }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || 'Decide failed');
      }
      onClose();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Decide failed');
    } finally { setBusy(null); }
  };

  const title =
    state.kind === 'cell' ? state.staff.name :
    state.kind === 'open' ? 'Open shift' :
    'Post open shift';

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(31,35,28,0.42)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: T.paper, borderRadius: 22, padding: '24px 26px',
        maxWidth: 440, width: '100%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 24px 60px -8px rgba(31,35,28,0.20), 0 0 0 1px rgba(31,35,28,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <Caps>{state.dayLabel} · {deptMeta[dept].label}</Caps>
            <h2 style={{
              margin: '4px 0 0', fontFamily: fonts.serif, fontSize: 24, fontStyle: 'italic',
              color: T.ink, letterSpacing: '-0.02em', fontWeight: 400,
            }}>{title}</h2>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: `1px solid ${T.rule}`, borderRadius: '50%',
            width: 28, height: 28, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            color: T.ink2, fontSize: 14, lineHeight: 1, padding: 0,
          }}>×</button>
        </div>

        {/* Pending TOR panel (cell editor only) */}
        {state.kind === 'cell' && state.tor && (
          <div style={{
            marginTop: 16, padding: '12px 14px',
            background: 'rgba(201,150,68,0.14)', border: '1px solid rgba(140,106,51,0.32)',
            borderRadius: 12,
          }}>
            <div style={{ fontFamily: fonts.mono, fontSize: 9.5, color: '#8C6A33', letterSpacing: '0.10em', fontWeight: 700 }}>
              ⏱ TIME-OFF REQUEST · PENDING
            </div>
            <div style={{ fontSize: 13, color: T.ink, marginTop: 4 }}>
              {state.staff.name} asked for this day off
              {state.tor.reason && <> — “{state.tor.reason}”</>}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
              <Btn variant="ghost" size="sm" onClick={() => decideTor('deny')} disabled={busy !== null}>Deny</Btn>
              <Btn variant="sage" size="sm" onClick={() => decideTor('approve')} disabled={busy !== null}>✓ Approve</Btn>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 16 }}>
          {/* Preset picker */}
          {deptPresets.length > 0 && (
            <div>
              <Caps size={10}>Preset</Caps>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {deptPresets.map(p => {
                  const sel = presetId === p.id;
                  return (
                    <button key={p.id} onClick={() => pickPreset(p.id)} style={{
                      padding: '6px 10px', borderRadius: 999,
                      border: sel ? `1px solid ${T.ink}` : `1px solid ${T.rule}`,
                      background: sel ? T.ink : 'transparent',
                      color: sel ? T.bg : T.ink2,
                      fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}>{p.name} · {fmtRange(p.startTime, p.endTime)}</button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Manual times */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <Caps size={10}>Start</Caps>
              <input
                value={startTime}
                onChange={e => { setStartTime(e.target.value); setPresetId(null); }}
                placeholder="08:00"
                style={{ ...inputStyle, fontFamily: fonts.mono, marginTop: 6 }}
              />
            </div>
            <div>
              <Caps size={10}>End</Caps>
              <input
                value={endTime}
                onChange={e => { setEndTime(e.target.value); setPresetId(null); }}
                placeholder="16:00"
                style={{ ...inputStyle, fontFamily: fonts.mono, marginTop: 6 }}
              />
            </div>
          </div>

          {state.kind === 'cell' && (
            <div>
              <Caps size={10}>Note (optional)</Caps>
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="e.g. covering for Diego"
                style={{ ...inputStyle, marginTop: 6 }}
              />
            </div>
          )}

          {state.kind !== 'cell' && (
            <div>
              <Caps size={10}>Why open? (optional)</Caps>
              <input
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="e.g. extra coverage Saturday"
                style={{ ...inputStyle, marginTop: 6 }}
              />
            </div>
          )}

          {errorMsg && (
            <div role="alert" style={{
              padding: '10px 14px', background: 'rgba(160,74,44,0.08)',
              border: '1px solid rgba(160,74,44,0.25)', borderRadius: 12,
              color: '#A04A2C', fontFamily: fonts.sans, fontSize: 13,
            }}>{errorMsg}</div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            {/* Remove (only when editing an existing) */}
            {((state.kind === 'cell' && state.existing) || state.kind === 'open') && (
              <Btn variant="ghost" size="md" onClick={removeShift} disabled={busy !== null}
                style={{ color: '#A04A2C', borderColor: 'rgba(160,74,44,0.25)' }}>
                Remove
              </Btn>
            )}
            {state.kind === 'cell' && (
              <Btn variant="ghost" size="md" onClick={postAsOpen} disabled={busy !== null}>
                Post as open
              </Btn>
            )}
            <span style={{ flex: 1 }}/>
            <Btn variant="ghost" size="md" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" size="md" onClick={saveAssignment} disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </div>
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
