// Manager Schedule — read-only week grid (SchedV2Body from the design).
//
// 7-column Mon→Sun grid. Rows = staff grouped by department. Each cell shows
// whether the staff member has a `shift_confirmations` row for that date and
// what its status is. "Today" gets a caramel tint, "tomorrow" gets sage.
//
// This is read-only in this pass. Cell clicks, note popovers, drag-to-fill,
// and OPEN-shift cells are deferred to a follow-up that introduces a real
// scheduled_shifts table. The header buttons that imply write actions
// ("Publish week", "Copy last week") are rendered but disabled with a
// coming-soon tooltip.

'use client';

import React, { useMemo, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { T, fonts, deptMeta, asDeptKey, Btn } from './_tokens';
import { StaffAvatar, SMTag, PageHeader } from './_people';
import { useWeekShifts, mondayOf, addDays } from './useWeekShifts';
import { ComingSoonModal, type ComingSoonKind } from './ComingSoonModal';

const DEPT_ORDER: ('housekeeping' | 'front_desk' | 'maintenance')[] = [
  'housekeeping', 'front_desk', 'maintenance',
];

export function ManagerSchedule() {
  const { activePropertyId, staff } = useProperty();
  const [weekStart, setWeekStart] = useState<string>(() => mondayOf(new Date()));
  const [comingSoon, setComingSoon] = useState<ComingSoonKind | null>(null);

  const { days, byStaff } = useWeekShifts(activePropertyId, weekStart);

  // Roster ordered HK → FD → MT → other, alphabetical within each group.
  const rows = useMemo(() => {
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

  // Coverage row + footer counters.
  const coverage = useMemo(() => days.map((_, d) => {
    return rows.filter(r => byStaff[r.id]?.[d]?.kind === 'shift').length;
  }), [days, rows, byStaff]);

  const totalShifts = useMemo(() => {
    return rows.reduce((sum, r) => sum + (byStaff[r.id]?.filter(c => c.kind === 'shift').length ?? 0), 0);
  }, [rows, byStaff]);

  const tomorrowIdx = days.findIndex(d => d.tomorrow);
  const tomorrowCount = tomorrowIdx >= 0 ? coverage[tomorrowIdx] : 0;

  // Week-range label, e.g. "May 11 – May 17"
  const startLabel = days[0]?.dateLabel ?? '';
  const endLabel   = days[6]?.dateLabel ?? '';

  return (
    <div style={{
      background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%',
      padding: '24px 48px 48px',
    }}>
      <style>{`
        .staff-schedule-scroll { overflow-x: auto; }
        @media (max-width: 900px) {
          .staff-page-pad { padding: 18px 18px 36px !important; }
          .staff-schedule-grid { min-width: 820px; }
        }
      `}</style>

      <PageHeader
        title="The week at a glance"
        eyebrow={`Schedule · Week of ${startLabel}`}
        sub="Every shift across every department in one grid. Cells fill in as housekeepers confirm tomorrow’s SMS texts."
      />

      {/* Header row: prev / range / next / today | summary | actions */}
      <div style={{
        display: 'flex', gap: 10, marginBottom: 14,
        alignItems: 'center', flexWrap: 'wrap',
      }}>
        <Btn variant="ghost" size="sm" onClick={() => setWeekStart(addDays(weekStart, -7))}>‹</Btn>
        <span style={{
          fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic',
          color: T.ink, padding: '0 6px',
        }}>{startLabel} – {endLabel}</span>
        <Btn variant="ghost" size="sm" onClick={() => setWeekStart(addDays(weekStart, 7))}>›</Btn>
        <Btn variant="ghost" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>Today</Btn>
        <span style={{ flex: 1 }}/>
        <span style={{
          fontFamily: fonts.mono, fontSize: 11, color: T.ink3, letterSpacing: '0.06em',
        }}>
          {totalShifts} shifts · {tomorrowCount} on {tomorrowIdx >= 0 ? days[tomorrowIdx].label : '—'}
        </span>
        <Btn
          variant="ghost" size="sm"
          onClick={() => setComingSoon('copy-last-week')}
          title="Coming soon"
        >⎘ Copy last week</Btn>
        <Btn
          variant="primary" size="sm"
          onClick={() => setComingSoon('publish-week')}
          title="Coming soon"
        >Publish week</Btn>
      </div>

      <div className="staff-schedule-scroll">
        <div className="staff-schedule-grid" style={{
          background: T.paper, border: `1px solid ${T.rule}`,
          borderRadius: 16, overflow: 'visible',
        }}>
          {/* day headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '220px repeat(7, 1fr)',
            background: '#FBFAF6', borderBottom: `1px solid ${T.rule}`,
            borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden',
          }}>
            <div style={{
              padding: '12px 16px', fontFamily: fonts.mono, fontSize: 10,
              color: T.ink3, letterSpacing: '0.08em', fontWeight: 600,
            }}>STAFF</div>
            {days.map(d => (
              <div key={d.key} style={{
                padding: '12px 8px', textAlign: 'center',
                background: d.today
                  ? 'rgba(201,150,68,0.10)'
                  : d.tomorrow
                    ? 'rgba(92,122,96,0.08)'
                    : 'transparent',
                borderLeft: `1px solid ${T.ruleSoft}`,
              }}>
                <div style={{
                  fontFamily: fonts.mono, fontSize: 10,
                  color: d.today ? '#8C6A33' : d.tomorrow ? '#5C7A60' : T.ink3,
                  letterSpacing: '0.06em', fontWeight: 600,
                }}>
                  {d.label.toUpperCase()}{d.today && ' · TODAY'}{d.tomorrow && ' · TOMORROW'}
                </div>
                <div style={{
                  fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic',
                  color: T.ink, marginTop: 2,
                }}>{d.dayNum}</div>
              </div>
            ))}
          </div>

          {/* rows grouped by dept */}
          {DEPT_ORDER.map(dept => {
            const m = deptMeta[dept];
            const list = rows.filter(r => asDeptKey(r.department) === dept);
            if (list.length === 0) return null;
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
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 10, color: T.ink2,
                      letterSpacing: '0.08em', fontWeight: 600, textTransform: 'uppercase',
                    }}>{m.label}</span>
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 10, color: T.ink3,
                    }}>· {list.length}</span>
                  </div>
                </div>
                {list.map(s => {
                  const week = byStaff[s.id] ?? Array.from({ length: 7 }, () => ({ kind: 'off' as const }));
                  const wkShifts = week.filter(c => c.kind === 'shift').length;
                  const wkHrs    = week.reduce((sum, c) => sum + (c.kind === 'shift' ? c.hrs : 0), 0);
                  const overCap  = s.maxWeeklyHours && wkHrs > s.maxWeeklyHours;
                  return (
                    <div key={s.id} style={{
                      display: 'grid', gridTemplateColumns: '220px repeat(7, 1fr)',
                      borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center',
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px',
                      }}>
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
                            {overCap && (
                              <span style={{
                                display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                                background: '#A04A2C',
                              }}/>
                            )}
                            {wkHrs}h · {wkShifts}d
                            {overCap && (
                              <span style={{
                                fontSize: 8.5, fontWeight: 700, color: '#A04A2C',
                                background: 'rgba(160,74,44,0.10)',
                                border: '1px solid rgba(160,74,44,0.28)',
                                padding: '0 5px', borderRadius: 999,
                                letterSpacing: '0.06em', marginLeft: 2,
                              }}>OT</span>
                            )}
                          </div>
                        </div>
                      </div>
                      {week.map((cell, d) => (
                        <div key={d} style={{
                          borderLeft: `1px solid ${T.ruleSoft}`,
                          background: days[d]?.today
                            ? 'rgba(201,150,68,0.04)'
                            : days[d]?.tomorrow
                              ? 'rgba(92,122,96,0.04)'
                              : 'transparent',
                          position: 'relative',
                        }}>
                          <ScheduleCell cell={cell} tone={m.tone} past={days[d]?.past ?? false}/>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}

          {/* coverage row */}
          <div style={{
            display: 'grid', gridTemplateColumns: '220px repeat(7, 1fr)',
            background: '#FBFAF6', borderTop: `1px solid ${T.rule}`,
            borderBottomLeftRadius: 16, borderBottomRightRadius: 16, overflow: 'hidden',
          }}>
            <div style={{
              padding: '12px 16px', fontFamily: fonts.mono, fontSize: 10,
              color: T.ink2, letterSpacing: '0.08em', fontWeight: 600,
            }}>COVERAGE</div>
            {coverage.map((n, d) => {
              // Heuristic recommended count: weekend=4, weekday=5. This is the
              // same fallback the existing /housekeeping/Schedule uses for the
              // daily AI rec — we don't have a per-day plan_snapshot in this
              // read-only view.
              const isWeekend = days[d]?.key === 'sat' || days[d]?.key === 'sun';
              const rec = isWeekend ? 4 : 5;
              const short = n > 0 && n < rec;
              const empty = n === 0;
              return (
                <div key={d} style={{
                  padding: '10px 8px', textAlign: 'center',
                  borderLeft: `1px solid ${T.ruleSoft}`,
                  background: days[d]?.today
                    ? 'rgba(201,150,68,0.06)'
                    : days[d]?.tomorrow
                      ? 'rgba(92,122,96,0.06)'
                      : 'transparent',
                }}>
                  <div style={{
                    fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic',
                    color: short ? '#A04A2C' : empty ? T.ink3 : T.ink,
                  }}>
                    {n}
                    <span style={{
                      color: T.ink3, fontFamily: fonts.sans, fontStyle: 'normal',
                      fontSize: 11, fontWeight: 500,
                    }}>/{rec}</span>
                  </div>
                  <div style={{
                    fontFamily: fonts.mono, fontSize: 9,
                    color: short ? '#A04A2C' : empty ? T.ink3 : T.ink3,
                    marginTop: 1, letterSpacing: '0.06em', fontWeight: 600,
                  }}>
                    {empty ? '—' : short ? 'SHORT' : 'OK'}
                  </div>
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
          Confirmed
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            display: 'inline-block', width: 18, height: 10, borderRadius: 4,
            background: 'rgba(201,150,68,0.16)', border: '1px solid rgba(201,150,68,0.40)',
          }}/>
          Sent · waiting
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700, color: '#A04A2C',
            background: 'rgba(160,74,44,0.10)', border: '1px solid rgba(160,74,44,0.28)',
            padding: '1px 6px', borderRadius: 999,
          }}>OT</span>
          Over weekly cap
        </span>
        <span style={{ flex: 1 }}/>
        <span style={{
          fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.06em',
        }}>
          Send tomorrow’s texts from <strong>Housekeeping → Schedule</strong>
        </span>
      </div>

      <ComingSoonModal kind={comingSoon} onClose={() => setComingSoon(null)}/>
    </div>
  );
}

// ── Cell renderer ────────────────────────────────────────────────────────
function ScheduleCell({
  cell, tone, past,
}: {
  cell: { kind: 'shift'; label: string; hrs: number; status: 'sent' | 'confirmed' } | { kind: 'declined'; label: string } | { kind: 'off' };
  tone: string;
  past: boolean;
}) {
  if (cell.kind === 'shift') {
    // Two-tone treatment: confirmed = dept-tone, sent = caramel.
    const isPending = cell.status === 'sent';
    const fg = isPending ? '#8C6A33' : tone;
    const bg = isPending ? 'rgba(201,150,68,0.14)' : `${tone}1A`;
    const br = isPending ? 'rgba(140,106,51,0.32)' : `${tone}33`;
    return (
      <div style={{ padding: 6, minHeight: 34, display: 'flex', alignItems: 'center' }}>
        <div style={{
          flex: 1, padding: '5px 8px', borderRadius: 6,
          background: bg, border: `1px solid ${br}`,
          color: fg, fontFamily: fonts.mono, fontSize: 10.5, fontWeight: 600,
          textAlign: 'center', letterSpacing: '0.02em',
          opacity: past ? 0.55 : 1,
        }}>{cell.label}</div>
      </div>
    );
  }
  if (cell.kind === 'declined') {
    return (
      <div style={{
        padding: '8px 4px', minHeight: 34,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#A04A2C', fontSize: 9, fontFamily: fonts.mono, fontWeight: 600,
        letterSpacing: '0.06em',
      }}>DECL</div>
    );
  }
  return (
    <div style={{
      padding: '8px 4px', minHeight: 34,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: T.ink3, fontSize: 11, fontFamily: fonts.mono,
    }}>·</div>
  );
}
