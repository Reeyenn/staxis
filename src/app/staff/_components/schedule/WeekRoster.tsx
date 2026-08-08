// WeekRoster — read-only roster grid (staff rows × 7 day columns) used by
// the Week view and, identically, by the Fill modal's week preview. Day
// column headers click through to the Day view. Shift chips replay the
// slide entrance (staggered) when animNonce changes — e.g. after a Fill.

'use client';

import React, { useEffect, useRef } from 'react';
import type { StaffMember } from '@/types';
import {
  fmtMinRange, fmtScheduledHours, shortName, weekMinutesByStaff, weeklyCapMinutes, weeklyLimitStatus,
  type BoardShift, type DayInfo,
} from '@/lib/schedule-board';
import { staffVisibleInWeekRoster } from '@/lib/schedule/week-roster-staff';
import { T, fonts, deptMeta, asDeptKey, Caps, type DeptKey } from '../_tokens';
import { Avatar } from '../_people';

export function WeekRoster({
  days, getDay, staff, lang, onPickDay, animNonce, reducedMotion, openCountByDate,
}: {
  days: DayInfo[];
  getDay: (date: string) => BoardShift[];
  staff: StaffMember[];
  lang: 'en' | 'es';
  onPickDay?: (date: string) => void;
  animNonce?: number;
  reducedMotion?: boolean;
  /**
   * Unfilled slots per date. The roster is a staff × day grid and an open
   * shift belongs to nobody, so it shows as a marker on the day column
   * instead of a row. Optional: the Fill modal's preview has no open lane.
   */
  openCountByDate?: Record<string, number>;
}) {
  const cols = `170px repeat(${days.length}, 1fr)`;
  const rootRef = useRef<HTMLDivElement>(null);

  // Staggered slide-in for the chips after a fill lands.
  useEffect(() => {
    if (!animNonce || reducedMotion || Date.now() - animNonce > 1500 || !rootRef.current) return;
    const chips = rootRef.current.querySelectorAll('.wr-chip');
    chips.forEach((el, i) => {
      (el as HTMLElement).animate?.(
        [{ opacity: 0, transform: 'translateX(-28px)' }, { opacity: 1, transform: 'translateX(0)' }],
        { duration: 460, delay: Math.min(i * 14, 500), easing: 'cubic-bezier(.2,.85,.3,1)', fill: 'backwards' });
    });
  }, [animNonce, days, reducedMotion]);

  // Build the displayed shift set before roster filtering. Active people are
  // always shown; archived people are included only when this week contains a
  // preserved assigned shift for them.
  const shiftsByDay = days.map(d => getDay(d.date));
  const assignedStaffIds = new Set(
    shiftsByDay.flatMap(shifts => shifts.map(shift => shift.staffId)).filter(Boolean),
  );
  const visibleStaff = staffVisibleInWeekRoster(staff, assignedStaffIds);

  // Lane order HK → FD → MT (+ Other when someone's assigned there), alpha
  // within each group.
  const byDept = (dep: DeptKey) =>
    visibleStaff.filter(s => asDeptKey(s.department) === dep)
      .sort((a, b) => a.name.localeCompare(b.name));
  const lanes: DeptKey[] = ['housekeeping', 'front_desk', 'maintenance'];
  if (byDept('other').length > 0) lanes.push('other');

  // Per-day shift lookup keyed by staff for O(1) cell rendering.
  const shiftFor = new Map<string, BoardShift>();
  for (const [index, d] of days.entries()) {
    for (const s of shiftsByDay[index]) shiftFor.set(`${s.staffId}:${d.date}`, s);
  }
  // Projected weekly hours per person — the overtime flag's whole value is
  // catching an over-cap week while the manager is still building it.
  const weekMin = weekMinutesByStaff(shiftsByDay);
  const capMinOf = (s: StaffMember) => weeklyCapMinutes(s.maxWeeklyHours);

  return (
    <div ref={rootRef} style={{
      border: `1px solid ${T.rule}`, borderRadius: 16, overflow: 'hidden', background: T.paper,
    }}>
      {/* day header */}
      <div style={{ display: 'grid', gridTemplateColumns: cols, background: 'rgba(31,35,28,0.03)', borderBottom: `1px solid ${T.rule}` }}>
        <div style={{
          padding: '10px 14px', fontFamily: fonts.mono, fontSize: 9,
          color: T.ink3, letterSpacing: '0.08em', fontWeight: 600,
        }}>{'STAFF'}</div>
        {days.map(d => {
          const openCount = openCountByDate?.[d.date] ?? 0;
          return (
            <button
              key={d.date}
              onClick={() => onPickDay?.(d.date)}
              title={onPickDay ? (`Open ${d.dowFull} in Day view`) : undefined}
              style={{
                padding: '8px 4px', textAlign: 'center',
                cursor: onPickDay ? 'pointer' : 'default',
                border: 'none', borderLeft: `1px solid ${T.ruleSoft}`,
                background: d.today ? 'rgba(201,150,68,0.10)' : 'transparent',
              }}
            >
              <div style={{
                fontFamily: fonts.mono, fontSize: 8.5,
                color: d.today ? T.caramelDeep : T.ink3, fontWeight: 600, letterSpacing: '0.05em',
              }}>{d.dow.toUpperCase()}{d.today ? (' · NOW') : ''}</div>
              <div style={{ fontFamily: fonts.sans, fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink }}>{d.dayNum}</div>
              {openCount > 0 && (
                <div
                  title={`${openCount} open ${openCount === 1 ? 'shift' : 'shifts'} nobody has picked up`}
                  style={{
                    display: 'inline-block', marginTop: 2,
                    fontFamily: fonts.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.05em',
                    color: T.caramelDeep, border: `1px dashed ${T.caramelDeep}`,
                    borderRadius: 999, padding: '0 5px',
                  }}
                >{openCount} {'OPEN'}</div>
              )}
            </button>
          );
        })}
      </div>

      {lanes.map(dep => {
        const m = deptMeta[dep];
        const list = byDept(dep);
        if (list.length === 0) return null;
        return (
          <React.Fragment key={dep}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '5px 14px',
              background: 'rgba(31,35,28,0.02)', borderBottom: `1px solid ${T.ruleSoft}`,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.tone }}/>
              <Caps size={8.5} c={T.ink2}>{m.label}</Caps>
            </div>
            {list.map(s => {
              const min = weekMin.get(s.id) ?? 0;
              const capMin = capMinOf(s);
              const limitStatus = weeklyLimitStatus(min, s.maxWeeklyHours);
              const limitLabel = limitStatus === 'over' ? 'Over limit' : limitStatus === 'near' ? 'Near limit' : null;
              return (
              <div key={s.id} style={{ display: 'grid', gridTemplateColumns: cols, borderBottom: `1px solid ${T.ruleSoft}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 14px' }}>
                  <Avatar staffId={s.id} name={s.name} size={20}/>
                  <span style={{
                    fontSize: 11.5, fontWeight: 600, color: T.ink, minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{shortName(s.name)}</span>
                  {s.isActive === false ? (
                    <span style={{
                      fontFamily: fonts.mono,
                      fontSize: 7.5,
                      color: T.ink3,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}>{'Archived'}</span>
                  ) : null}
                  <span
                    style={{
                      fontFamily: fonts.mono, fontSize: 8.5, flexShrink: 0,
                      fontWeight: limitStatus ? 700 : 500,
                      color: limitStatus === 'over' ? T.red : limitStatus === 'near' ? T.caramelDeep : T.ink3,
                      ...(limitStatus ? {
                        background: limitStatus === 'over' ? 'rgba(184,92,61,0.10)' : 'rgba(201,150,68,0.10)',
                        border: `1px solid ${limitStatus === 'over' ? 'rgba(184,92,61,0.35)' : 'rgba(201,150,68,0.35)'}`,
                        padding: '0 4px', borderRadius: 999,
                      } : {}),
                      whiteSpace: 'nowrap',
                    }}
                  >{fmtScheduledHours(min, capMin)}{limitLabel ? ` · ${limitLabel}` : ''}</span>
                </div>
                {days.map(d => {
                  const sh = shiftFor.get(`${s.id}:${d.date}`);
                  return (
                    <div key={d.date} style={{
                      borderLeft: `1px solid ${T.ruleSoft}`, padding: 4, minHeight: 30,
                      display: 'flex', alignItems: 'center',
                      background: d.today ? 'rgba(201,150,68,0.04)' : 'transparent',
                    }}>
                      {sh && (
                        <div className="wr-chip" title={sh.note ?? undefined} style={{
                          width: '100%', padding: '3px 4px', borderRadius: 6, boxSizing: 'border-box',
                          background: `${deptMeta[asDeptKey(sh.dept)].tone}1A`,
                          border: `1px solid ${deptMeta[asDeptKey(sh.dept)].tone}44`,
                          color: deptMeta[asDeptKey(sh.dept)].tone,
                          fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700, textAlign: 'center',
                        }}>{fmtMinRange(sh.startMin, sh.endMin)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}
