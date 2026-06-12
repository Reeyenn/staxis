// WeekRoster — read-only roster grid (staff rows × 7 day columns) used by
// the Week view and, identically, by the Fill modal's week preview. Day
// column headers click through to the Day view. Shift chips replay the
// slide entrance (staggered) when animNonce changes — e.g. after a Fill.

'use client';

import React, { useEffect, useRef } from 'react';
import type { StaffMember } from '@/types';
import {
  fmtHours, fmtMinRange, shortName, weekMinutesByStaff,
  type BoardShift, type DayInfo,
} from '@/lib/schedule-board';
import { T, fonts, deptMeta, asDeptKey, Caps, type DeptKey } from '../_tokens';
import { Avatar } from '../_people';

const DEFAULT_WEEKLY_CAP = 40;

export function WeekRoster({
  days, getDay, staff, lang, onPickDay, animNonce, reducedMotion,
}: {
  days: DayInfo[];
  getDay: (date: string) => BoardShift[];
  staff: StaffMember[];
  lang: 'en' | 'es';
  onPickDay?: (date: string) => void;
  animNonce?: number;
  reducedMotion?: boolean;
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

  // Lane order HK → FD → MT (+ Other when someone's assigned there), full
  // active roster per department, alpha within group.
  const active = staff.filter(s => s.isActive !== false);
  const byDept = (dep: DeptKey) =>
    active.filter(s => asDeptKey(s.department) === dep)
      .sort((a, b) => a.name.localeCompare(b.name));
  const lanes: DeptKey[] = ['housekeeping', 'front_desk', 'maintenance'];
  if (byDept('other').length > 0) lanes.push('other');

  // Per-day shift lookup keyed by staff for O(1) cell rendering.
  const shiftFor = new Map<string, BoardShift>();
  for (const d of days) {
    for (const s of getDay(d.date)) shiftFor.set(`${s.staffId}:${d.date}`, s);
  }
  // Projected weekly hours per person — the overtime flag's whole value is
  // catching an over-cap week while the manager is still building it.
  const weekMin = weekMinutesByStaff(days.map(d => getDay(d.date)));
  const capMinOf = (s: StaffMember) => (s.maxWeeklyHours || DEFAULT_WEEKLY_CAP) * 60;

  return (
    <div ref={rootRef} style={{
      border: `1px solid ${T.rule}`, borderRadius: 16, overflow: 'hidden', background: T.paper,
    }}>
      {/* day header */}
      <div style={{ display: 'grid', gridTemplateColumns: cols, background: '#FBFAF6', borderBottom: `1px solid ${T.rule}` }}>
        <div style={{
          padding: '10px 14px', fontFamily: fonts.mono, fontSize: 9,
          color: T.ink3, letterSpacing: '0.08em', fontWeight: 600,
        }}>{lang === 'es' ? 'PERSONAL' : 'STAFF'}</div>
        {days.map(d => (
          <button
            key={d.date}
            onClick={() => onPickDay?.(d.date)}
            title={onPickDay ? (lang === 'es' ? `Abrir ${d.dowFull} en vista Día` : `Open ${d.dowFull} in Day view`) : undefined}
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
            }}>{d.dow.toUpperCase()}{d.today ? (lang === 'es' ? ' · HOY' : ' · NOW') : ''}</div>
            <div style={{ fontFamily: fonts.serif, fontSize: 16, fontStyle: 'italic', color: T.ink }}>{d.dayNum}</div>
          </button>
        ))}
      </div>

      {lanes.map(dep => {
        const m = deptMeta[dep];
        const list = byDept(dep);
        if (list.length === 0) return null;
        return (
          <React.Fragment key={dep}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '5px 14px',
              background: '#FCFBF8', borderBottom: `1px solid ${T.ruleSoft}`,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.tone }}/>
              <Caps size={8.5} c={T.ink2}>{m.label}</Caps>
            </div>
            {list.map(s => {
              const min = weekMin.get(s.id) ?? 0;
              const over = min > capMinOf(s);
              return (
              <div key={s.id} style={{ display: 'grid', gridTemplateColumns: cols, borderBottom: `1px solid ${T.ruleSoft}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 14px' }}>
                  <Avatar staffId={s.id} name={s.name} size={20}/>
                  <span style={{
                    fontSize: 11.5, fontWeight: 600, color: T.ink, minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{shortName(s.name)}</span>
                  {min > 0 && (
                    <span
                      title={over
                        ? (lang === 'es'
                          ? `${fmtHours(min)} esta semana — supera el límite de ${fmtHours(capMinOf(s))}`
                          : `${fmtHours(min)} this week — over the ${fmtHours(capMinOf(s))} cap`)
                        : undefined}
                      style={{
                        fontFamily: fonts.mono, fontSize: 8.5, flexShrink: 0,
                        fontWeight: over ? 700 : 500,
                        color: over ? T.red : T.ink3,
                        ...(over ? {
                          background: 'rgba(160,74,44,0.10)',
                          border: '1px solid rgba(160,74,44,0.35)',
                          padding: '0 4px', borderRadius: 999,
                        } : {}),
                      }}
                    >{fmtHours(min)}{over ? ' OT' : ''}</span>
                  )}
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
