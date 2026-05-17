// MyShifts — staff-side weekly view (MSv2Body / "Week strip" from the design).
//
// Rendered when the logged-in account is *not* a manager. Three blocks:
//   • Greeting + hours-this-week card
//   • 7-card horizontal week strip (the user's own shifts pulled from
//     shift_confirmations)
//   • Two cards: open shifts in your dept (empty — coming soon), time-off
//     requests (empty — coming soon)
//
// Requires `accounts.staff_id` to be set. If null, render a friendly empty
// state instead of a broken view — the manager has to link the account
// from the Directory before staff can see their own week.

'use client';

import React, { useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { T, fonts, deptMeta, asDeptKey, Btn, Caps } from './_tokens';
import { Avatar } from './_people';
import { useWeekShifts, mondayOf } from './useWeekShifts';
import { ComingSoonModal, type ComingSoonKind } from './ComingSoonModal';

export function MyShifts() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff } = useProperty();
  const [comingSoon, setComingSoon] = useState<ComingSoonKind | null>(null);
  const weekStart = useMemo(() => mondayOf(new Date()), []);

  const staffId = user?.staffId ?? null;
  const me = useMemo(() => staff.find(s => s.id === staffId) ?? null, [staff, staffId]);
  const { days, byStaff } = useWeekShifts(activePropertyId, weekStart);

  const propName = activeProperty?.name ?? 'Your property';

  // Not-linked empty state.
  if (!staffId || !me) {
    return (
      <NotLinkedState
        displayName={user?.displayName ?? 'there'}
        propertyName={propName}
      />
    );
  }

  const meDept = deptMeta[asDeptKey(me.department)];
  const myWeek = byStaff[me.id] ?? Array.from({ length: 7 }, () => ({ kind: 'off' as const }));
  const myShiftCount = myWeek.filter(c => c.kind === 'shift').length;
  const myHrs = myWeek.reduce((sum, c) => sum + (c.kind === 'shift' ? c.hrs : 0), 0);
  const cap = me.maxWeeklyHours || 40;
  const firstName = me.name.split(/\s+/)[0] || me.name;
  const greeting = me.language === 'es' ? `Hola, ${firstName}.` : `Hi, ${firstName}.`;

  return (
    <div style={{
      background: T.bg, color: T.ink, fontFamily: fonts.sans, minHeight: '100%',
      padding: '28px 48px 56px',
    }}>
      <style>{`
        .my-shifts-week-strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; }
        .my-shifts-extras { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
        @media (max-width: 900px) {
          .my-shifts-pad { padding: 22px 18px 40px !important; }
          .my-shifts-week-strip { grid-template-columns: 1fr 1fr; }
          .my-shifts-extras { grid-template-columns: 1fr; }
        }
      `}</style>

      <div style={{ maxWidth: 1280, margin: '0 auto' }}>
        {/* Hola, … + hours card */}
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

        {/* Section heading */}
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
          <span style={{
            fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.06em',
          }}>{days[0]?.dateLabel} – {days[6]?.dateLabel}</span>
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
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6,
                }}>
                  <div>
                    <div style={{
                      fontFamily: fonts.mono, fontSize: 9.5, fontWeight: 600,
                      letterSpacing: '0.08em',
                      color: isToday ? 'rgba(255,255,255,0.55)' : T.ink3,
                    }}>{d.label.toUpperCase()}</div>
                    <div style={{
                      fontFamily: fonts.serif, fontSize: 24, fontStyle: 'italic',
                      lineHeight: 1, marginTop: 1,
                      color: isToday ? T.bg : T.ink,
                    }}>{d.dayNum}</div>
                  </div>
                  {isToday && (
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700,
                      color: '#fff',
                      background: 'rgba(255,255,255,0.18)',
                      border: '1px solid rgba(255,255,255,0.26)',
                      padding: '1px 6px', borderRadius: 999,
                      letterSpacing: '0.08em', whiteSpace: 'nowrap',
                    }}>TODAY</span>
                  )}
                </div>
                {!isOff ? (
                  <div style={{
                    padding: '8px 10px', borderRadius: 8,
                    background: isToday
                      ? 'rgba(255,255,255,0.12)'
                      : (cell.kind === 'shift' && cell.status === 'sent'
                        ? 'rgba(201,150,68,0.14)'
                        : meDept.dim),
                    border: `1px solid ${isToday
                      ? 'rgba(255,255,255,0.20)'
                      : (cell.kind === 'shift' && cell.status === 'sent'
                        ? 'rgba(140,106,51,0.32)'
                        : meDept.tone + '33')}`,
                  }}>
                    <div style={{
                      fontFamily: fonts.serif, fontSize: 16, fontStyle: 'italic',
                      color: isToday ? T.bg : T.ink,
                      letterSpacing: '-0.01em', lineHeight: 1.1,
                    }}>{cell.kind === 'shift' ? cell.label : ''}</div>
                    <div style={{
                      fontFamily: fonts.sans, fontSize: 11,
                      color: isToday ? 'rgba(255,255,255,0.65)' : T.ink2, marginTop: 2,
                    }}>
                      {meDept.short}
                      {cell.kind === 'shift' && cell.status === 'sent' && ' · awaiting'}
                    </div>
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

        {/* Open shifts + time off */}
        <div className="my-shifts-extras">
          <ExtrasCard
            eyebrow="Pick up"
            title="Open shifts"
            chipText={`0 in ${meDept.label.toLowerCase()}`}
            chipTone={T.ink3}
            empty="No open shifts in your department this week."
            actionLabel="Pick up a shift"
            onAction={() => setComingSoon('pickup-shift')}
          />
          <ExtrasCard
            eyebrow="Time off"
            title="Your requests"
            chipText="No active"
            chipTone={T.ink3}
            empty="No active requests."
            actionLabel="+ Request"
            onAction={() => setComingSoon('request-time-off')}
            primaryAction
          />
        </div>
      </div>

      <ComingSoonModal kind={comingSoon} onClose={() => setComingSoon(null)}/>
    </div>
  );
}

// ── Hours card ─────────────────────────────────────────────────────────────
function HoursCard({
  hrs, cap, shifts, tone,
}: {
  hrs: number;
  cap: number;
  shifts: number;
  tone: string;
}) {
  const pct = Math.min(1, cap > 0 ? hrs / cap : 0);
  return (
    <div style={{
      minWidth: 260, padding: '14px 18px',
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Caps size={9}>This week</Caps>
      </div>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginTop: 4, gap: 12,
      }}>
        <span style={{
          fontFamily: fonts.serif, fontSize: 38, color: T.ink,
          fontStyle: 'italic', letterSpacing: '-0.03em', lineHeight: 1,
        }}>
          {hrs}
          <span style={{ fontFamily: fonts.sans, fontSize: 13, fontStyle: 'normal', color: T.ink3, fontWeight: 500 }}>h</span>
        </span>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontFamily: fonts.sans, fontSize: 13, color: T.ink2, fontWeight: 500,
          }}>{shifts} {shifts === 1 ? 'shift' : 'shifts'}</div>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, marginTop: 2 }}>of {cap}h cap</div>
        </div>
      </div>
      <span style={{
        display: 'block', height: 5, borderRadius: 5, background: T.rule,
        overflow: 'hidden', marginTop: 10,
      }}>
        <span style={{
          display: 'block', height: '100%',
          width: `${pct * 100}%`, background: tone, borderRadius: 5,
        }}/>
      </span>
    </div>
  );
}

// ── Open shifts / Time off card ────────────────────────────────────────────
function ExtrasCard({
  eyebrow, title, chipText, chipTone, empty, actionLabel, onAction, primaryAction,
}: {
  eyebrow: string;
  title: string;
  chipText: string;
  chipTone: string;
  empty: string;
  actionLabel: string;
  onAction: () => void;
  primaryAction?: boolean;
}) {
  return (
    <div style={{
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '14px 16px', borderBottom: `1px solid ${T.rule}`,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <Caps size={9}>{eyebrow}</Caps>
          <div style={{
            fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic',
            color: T.ink, letterSpacing: '-0.02em', marginTop: 3, lineHeight: 1.1,
          }}>{title}</div>
        </div>
        {primaryAction ? (
          <Btn variant="primary" size="sm" onClick={onAction}>{actionLabel}</Btn>
        ) : (
          <span style={{
            fontFamily: fonts.mono, fontSize: 9.5, color: chipTone, letterSpacing: '0.06em', fontWeight: 700,
            background: 'rgba(31,35,28,0.04)', border: `1px solid ${T.rule}`,
            padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{chipText.toUpperCase()}</span>
        )}
      </div>
      <div style={{
        padding: '22px 18px', textAlign: 'center', flex: 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 12,
      }}>
        <span style={{
          fontFamily: fonts.serif, fontSize: 16, fontStyle: 'italic',
          color: T.ink3, letterSpacing: '-0.01em',
        }}>{empty}</span>
        {!primaryAction && (
          <Btn variant="ghost" size="sm" onClick={onAction}>{actionLabel}</Btn>
        )}
      </div>
    </div>
  );
}

// ── Not-linked empty state ─────────────────────────────────────────────────
function NotLinkedState({
  displayName, propertyName,
}: {
  displayName: string;
  propertyName: string;
}) {
  const fakeId = 'unknown';
  return (
    <div style={{
      background: T.bg, color: T.ink, fontFamily: fonts.sans,
      minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '64px 24px',
    }}>
      <div style={{
        maxWidth: 480, textAlign: 'center',
      }}>
        <div style={{ display: 'inline-flex', marginBottom: 18 }}>
          <Avatar staffId={fakeId} name={displayName} size={64}/>
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
          Your account isn’t linked to a staff record yet. Ask your manager
          to open <strong style={{ color: T.ink }}>Staff → Directory</strong> and
          link your login from your staff card.
        </p>
      </div>
    </div>
  );
}
