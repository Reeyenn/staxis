'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  subscribeToRooms,
  subscribeToWorkOrders,
  subscribeToHandoffLogs,
  subscribeToDashboardNumbers,
  type DashboardNumbers,
} from '@/lib/db';
import { dashboardFreshness } from '@/lib/db/dashboard';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, WorkOrder, HandoffEntry } from '@/types';

// Snow palette tokens — applied via CSS vars defined in globals.css.
// Aliased here so the JSX below stays readable and a future redesign can
// swap palettes by editing one block of vars.
const C = {
  bg:       'var(--snow-bg)',
  ink:      'var(--snow-ink)',
  ink2:     'var(--snow-ink2)',
  ink3:     'var(--snow-ink3)',
  rule:     'var(--snow-rule)',
  ruleSoft: 'var(--snow-rule-soft)',
  sage:     'var(--snow-sage)',
  sageDeep: 'var(--snow-sage-deep)',
  caramel:  'var(--snow-caramel)',
  warm:     'var(--snow-warm)',
};

const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO  = "var(--font-geist-mono), ui-monospace, monospace";
const FONT_SERIF = "var(--font-instrument-serif), 'Times New Roman', Georgia, serif";

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  // Reactive "today" so realtime subscriptions roll over at midnight
  // (Central). Without this, leaving the dashboard open overnight on the
  // back-office TV silently keeps subscribing to yesterday's room bucket.
  const today = useTodayStr();

  const [rooms, setRooms]               = useState<Room[]>([]);
  const [workOrders, setWorkOrders]     = useState<WorkOrder[]>([]);
  const [handoffs, setHandoffs]         = useState<HandoffEntry[]>([]);
  const [arrivals, setArrivals]         = useState(0);
  const [inHouseGuests, setInHouseGuests] = useState(0);
  const [reservationCount, setReservationCount] = useState(0);
  const [adr, setAdr]                   = useState(0);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);

  // Auth + onboarding gate
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Real-time subscriptions
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, today, setRooms);
  }, [user, activePropertyId, today]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToWorkOrders(user.uid, activePropertyId, setWorkOrders);
  }, [user, activePropertyId]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToHandoffLogs(user.uid, activePropertyId, setHandoffs);
  }, [user, activePropertyId]);

  // Scraper-written PMS dashboard numbers (In House, Arrivals pending),
  // refreshed ~every 15 min by the scraper tick.
  useEffect(() => {
    return subscribeToDashboardNumbers(setDashboardNums);
  }, []);

  // Mirror PMS-scraped figures into displayed numbers — but skip the
  // mirror while the user is mid-typing in InlineEdit so a scraper tick
  // doesn't clobber input.
  useEffect(() => {
    if (!dashboardNums) return;
    if (typeof dashboardNums.arrivals === 'number' && editingField !== 'arrivals') {
      setArrivals(dashboardNums.arrivals);
    }
    if (typeof dashboardNums.inHouse === 'number' && editingField !== 'in-house') {
      setInHouseGuests(dashboardNums.inHouse);
    }
  }, [dashboardNums, editingField]);

  // Derived tallies. After the May-2026 maintenance simplification
  // (migration 0131) the work_orders schema only carries 'open' / 'done'
  // — the blocked-room concept that used to mark a room unsellable via a
  // work order is gone. If we need to track unsellable rooms again later
  // it should come from a dedicated room-status field, not work_orders.
  const openOrders   = workOrders.filter(o => o.status === 'open');
  const blockedRooms = 0;
  const clean        = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const inProgress   = rooms.filter(r => r.status === 'in_progress').length;
  const dirty        = rooms.filter(r => r.status === 'dirty').length;
  const checkouts    = rooms.filter(r => r.type === 'checkout').length;
  const stayovers    = rooms.filter(r => r.type === 'stayover').length;

  // Occupancy — preserves the bug-fix from 2026-05-07 (Maria reported the
  // dashboard showing 88% while Choice Advantage showed 84.93%):
  //   Numerator  = scraped in-house count when fresh, else CSV-derived sum
  //                (checkouts + stayovers).
  //   Denominator = totalPropertyRooms − blockedRooms (sellable rooms;
  //                  matches CA's % Occupancy formula).
  // dashboardFreshness handles the off-hours-Central window plus the
  // 25-min staleness threshold and error states.
  const totalPropertyRooms = activeProperty?.totalRooms || 0;
  const inHouseFresh =
    dashboardFreshness(dashboardNums ?? null) === 'fresh' &&
    typeof dashboardNums?.inHouse === 'number' &&
    Number.isFinite(dashboardNums.inHouse) &&
    dashboardNums.inHouse >= 0;
  const inHouseRooms = inHouseFresh ? (dashboardNums!.inHouse as number) : (checkouts + stayovers);
  const sellableRooms = Math.max(0, totalPropertyRooms - blockedRooms);
  const occupancyPct  = sellableRooms > 0 ? Math.round((inHouseRooms / sellableRooms) * 100) : 0;
  const rentedRooms   = inHouseRooms;
  const revpar        = sellableRooms > 0 && adr > 0 ? Math.round((adr * rentedRooms) / sellableRooms) : 0;

  // Average turnover (minutes) across rooms with both startedAt and completedAt
  const avgTurnover = useMemo(() => {
    const toMs = (v: unknown): number | null => {
      if (!v) return null;
      if (typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate: () => Date }).toDate().getTime();
      const d = new Date(v as string | number | Date);
      return isNaN(d.getTime()) ? null : d.getTime();
    };
    const timed = rooms
      .filter(r => r.startedAt && r.completedAt)
      .map(r => {
        const s = toMs(r.startedAt); const e = toMs(r.completedAt);
        if (!s || !e) return 0;
        return (e - s) / 60000;
      })
      .filter(m => m > 0 && m < 480);
    return timed.length > 0 ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  }, [rooms]);

  // Briefing — combine recent handoffs (24h) + open work orders into a
  // single timeline, newest first, capped at 4 for the design's lower band.
  const briefingItems = useMemo(() => {
    type Item = { id: string; time: Date; tone: 'sage' | 'caramel' | 'warm'; text: string };
    const items: Item[] = [];
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Safely coerce a createdAt value that could be: a real Date, a
    // Firestore-style Timestamp object with .toDate(), an ISO string
    // (Supabase's normal shape), or null. Returns null when we can't
    // get a valid Date — the caller decides whether to drop the item or
    // surface it with a placeholder. The previous code had two subtly
    // different versions per branch — handoffs handled ISO strings,
    // openOrders fell back to `new Date()` (== "right now") which made
    // older rows appear current and broke sort order.
    const safeDate = (raw: unknown): Date | null => {
      if (!raw) return null;
      if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
      if (typeof raw === 'object' && 'toDate' in raw && typeof (raw as { toDate?: unknown }).toDate === 'function') {
        const d = (raw as { toDate: () => Date }).toDate();
        return isNaN(d.getTime()) ? null : d;
      }
      if (typeof raw === 'string' || typeof raw === 'number') {
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
      }
      return null;
    };

    handoffs.forEach(h => {
      const d = safeDate(h.createdAt);
      if (!d || d < cutoff) return;
      items.push({ id: `h-${h.id}`, time: d, tone: 'sage', text: `${h.shiftType}: ${h.notes}` });
    });

    openOrders.forEach(o => {
      const d = safeDate(o.createdAt);
      // Drop the item entirely if we can't pin a real timestamp on it —
      // ranking it as "right now" caused old work orders to crowd out
      // genuinely fresh handoffs in the briefing.
      if (!d) return;
      const tone: 'warm' | 'caramel' = o.priority === 'urgent' ? 'warm' : 'caramel';
      // Match the Maintenance tab's displayLoc helper: bare digits get a
      // "Rm " prefix; anything with letters (e.g. "Lobby") shows verbatim.
      const where = /^\d{1,4}$/.test(o.location.trim()) ? `Rm ${o.location.trim()}` : o.location;
      items.push({ id: `wo-${o.id}`, time: d, tone, text: `${where}: ${o.description}` });
    });

    return items.sort((a, b) => b.time.getTime() - a.time.getTime()).slice(0, 4);
  }, [handoffs, openOrders]);

  // Labor cost — hourly wage × 8-hour shift × headcount per role.
  const wage      = activeProperty?.hourlyWage || 12;
  const hkStaff   = rooms.length > 0 ? Math.ceil(rooms.length / 15) : 1;
  const hkCost    = Math.round(hkStaff * wage * 8);
  const fdCost    = Math.round(2 * wage * 8);
  const mtCost    = Math.round(1 * wage * 8);
  const totalCost = fdCost + hkCost + mtCost;

  // Greeting + date strip — both sit left-aligned at the top of the
  // page. Greeting first, then a small-dot separator, then the date.
  // Right side of the strip is intentionally empty.
  const greeting = (() => {
    const h = new Date().getHours();
    if (lang === 'es') return h < 12 ? 'Buenos días' : h < 18 ? 'Buenas tardes' : 'Buenas noches';
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();
  const firstName = (user?.displayName ?? user?.username ?? '').split(' ')[0];
  const dateLine = new Date().toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // Format time as "8:14 AM" — used for briefing items.
  const formatTime = (d: Date) => {
    const h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${m} ${ampm}`;
  };

  // Inline-edit affordance for Reservations and ADR — kept so the manager
  // can still type values that aren't scraped from the PMS. Dashed
  // underline appears on hover only, so the design's clean readout
  // aesthetic isn't disturbed.
  const InlineEdit = ({ value, onChange, fieldKey, prefix }: {
    value: number; onChange: (v: number) => void; fieldKey: string; prefix?: string;
  }) => {
    const isEditing = editingField === fieldKey;
    if (isEditing) {
      return (
        <input
          type="number"
          autoFocus
          value={value || ''}
          onChange={e => onChange(parseInt(e.target.value) || 0)}
          onBlur={() => setEditingField(null)}
          onKeyDown={e => { if (e.key === 'Enter') setEditingField(null); }}
          style={{
            width: '88px', fontFamily: FONT_MONO, fontWeight: 500, fontSize: '22px',
            border: `1px solid ${C.ink}`, borderRadius: '4px', padding: '2px 6px',
            background: C.bg, color: C.ink, outline: 'none', textAlign: 'right',
            letterSpacing: '-0.02em',
          }}
        />
      );
    }
    return (
      <span
        onClick={(e) => { e.stopPropagation(); setEditingField(fieldKey); }}
        style={{
          fontFamily: FONT_MONO, fontWeight: 500, fontSize: '22px',
          color: C.ink, cursor: 'pointer', letterSpacing: '-0.02em',
          borderBottom: '1px dashed transparent',
          transition: 'border-color 0.15s ease',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderBottomColor = 'rgba(31,35,28,0.18)'; }}
        onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
      >
        {value > 0 ? `${prefix || ''}${value}` : '—'}
      </span>
    );
  };

  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div style={{
          minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '12px', background: C.bg, fontFamily: FONT_SANS,
        }}>
          <div className="animate-spin" style={{
            width: '28px', height: '28px',
            border: `2px solid ${C.rule}`, borderTopColor: C.ink, borderRadius: '50%',
          }} />
          <p style={{ color: C.ink2, fontSize: '13px' }}>
            {lang === 'es' ? 'Cargando panel...' : 'Loading dashboard...'}
          </p>
        </div>
      </AppLayout>
    );
  }

  // Right-side stat list — order matches the design's Frame (v5-focal.jsx).
  type Stat = { label: string; value: React.ReactNode; sub: string; tone: string };
  const stats: Stat[] = [
    {
      label: lang === 'es' ? 'Habitaciones sucias' : 'Dirty rooms',
      value: dirty,
      sub: lang === 'es' ? `${inProgress} en progreso` : `${inProgress} in progress`,
      tone: C.warm,
    },
    {
      label: lang === 'es' ? 'Mano de obra / turno' : 'Labor / shift',
      value: `$${totalCost}`,
      sub: `HK ${hkStaff} · FD 2 · MT 1`,
      tone: C.ink,
    },
    {
      label: lang === 'es' ? 'Tiempo medio' : 'Avg turnover',
      value: avgTurnover ? `${avgTurnover}m` : '—',
      sub: avgTurnover
        ? (lang === 'es' ? 'esta semana' : 'this week')
        : (lang === 'es' ? 'sin datos aún' : 'no data yet'),
      tone: C.sageDeep,
    },
    {
      label: lang === 'es' ? 'Habitaciones disponibles' : 'Rooms available',
      value: clean,
      sub: lang === 'es' ? `${blockedRooms} bloqueada(s)` : `${blockedRooms} blocked`,
      tone: C.sage,
    },
  ];

  return (
    <AppLayout>
      <div style={{
        background: C.bg,
        minHeight: '100dvh',
        fontFamily: FONT_SANS,
        color: C.ink,
        padding: '32px 48px',
      }}>

        {/* greeting strip — left-aligned. Greeting first, then a thin
            vertical rule, then the date. Right side intentionally
            empty so the eye starts at "Good morning, Reeyen" the way
            you'd open a newspaper. */}
        <div style={{
          display: 'flex', alignItems: 'center',
          marginBottom: '24px', gap: '14px', flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: FONT_MONO, fontSize: '10px', color: C.ink3,
            letterSpacing: '0.18em', textTransform: 'uppercase',
          }}>
            {greeting}{firstName ? `, ${firstName}` : ''}
          </span>
          <span style={{ width: 1, height: 12, background: C.rule }} />
          <span style={{
            fontFamily: FONT_MONO, fontSize: '10px', color: C.ink3,
            letterSpacing: '0.18em', textTransform: 'uppercase',
          }}>
            {dateLine}
          </span>
        </div>

        {/* hero row — focal occupancy + stat list. Tighter spacing than
            the original mock (marginBottom 24 instead of 48) so the
            page doesn't read as overly spacey. */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '48px',
          marginBottom: '24px', alignItems: 'start',
        }}>
          {/* LEFT: focal occupancy. Reverted the centering hack — the
              giant 82% sits in its natural left position again. */}
          <div>
            <span style={{
              fontFamily: FONT_MONO, fontSize: '13px', color: C.ink2,
              letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 500,
            }}>
              {lang === 'es' ? 'Ocupación' : 'Occupancy'}
            </span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px', marginTop: '4px' }}>
              <span style={{
                fontFamily: FONT_SERIF,
                fontSize: 'clamp(140px, 16vw, 220px)',
                lineHeight: 0.85, letterSpacing: '-0.04em', color: C.ink, fontWeight: 400,
              }}>
                {/* If every room is blocked, sellableRooms is 0 and the
                    real answer is "undefined" — rendering "0%" reads to a
                    non-technical owner as "we have zero guests." Show "—"
                    instead. */}
                {sellableRooms > 0
                  ? <>{occupancyPct}<span style={{ fontStyle: 'italic' }}>%</span></>
                  : '—'}
              </span>
            </div>
            <p style={{
              fontFamily: FONT_SERIF, fontSize: '24px', color: C.ink2,
              fontStyle: 'italic', lineHeight: 1.35, margin: '14px 0 0',
              maxWidth: '540px', fontWeight: 400,
            }}>
              {sellableRooms === 0
                ? (lang === 'es'
                    ? 'Sin cuartos disponibles para vender hoy.'
                    : 'No sellable rooms today.')
                : activeProperty?.name
                  ? (lang === 'es'
                      ? `${activeProperty.name} está al ${occupancyPct}% de ocupación.`
                      : `${activeProperty.name} is at ${occupancyPct}% occupancy.`)
                  : (lang === 'es' ? `Al ${occupancyPct}% de ocupación.` : `At ${occupancyPct}% occupancy.`)}
            </p>
            <div style={{ display: 'flex', gap: '10px', marginTop: '28px', flexWrap: 'wrap' }}>
              <button
                onClick={() => router.push('/front-desk')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '8px',
                  padding: '12px 20px', borderRadius: '999px', border: 'none', cursor: 'pointer',
                  background: C.ink, color: C.bg,
                  fontFamily: FONT_SANS, fontSize: '13px', fontWeight: 500,
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                {lang === 'es' ? 'Recepción' : 'Front desk command'} →
              </button>
              <button
                onClick={() => router.push('/roi')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '8px',
                  padding: '12px 20px', borderRadius: '999px', cursor: 'pointer',
                  background: 'transparent', color: C.ink, border: `1px solid ${C.rule}`,
                  fontFamily: FONT_SANS, fontSize: '13px', fontWeight: 500,
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                {lang === 'es' ? 'Análisis ROI' : 'ROI analytics'}
              </button>
            </div>
          </div>

          {/* RIGHT: stat list */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {stats.map((row, i) => (
              <div key={row.label} style={{
                padding: '18px 0',
                borderTop: i === 0 ? 'none' : `1px solid ${C.ruleSoft}`,
              }}>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: '10px', color: C.ink3,
                  letterSpacing: '0.18em', textTransform: 'uppercase',
                }}>
                  {row.label}
                </span>
                <div style={{
                  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                  marginTop: '6px', gap: '12px',
                }}>
                  <span style={{
                    fontFamily: FONT_SERIF, fontSize: 'clamp(40px, 4vw, 54px)',
                    lineHeight: 1, color: row.tone, letterSpacing: '-0.02em', fontWeight: 400,
                  }}>
                    {row.value}
                  </span>
                  <span style={{
                    fontFamily: FONT_SANS, fontSize: '12px', color: C.ink2,
                    fontStyle: 'italic', textAlign: 'right',
                  }}>
                    {row.sub}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* lower band — Guests / Revenue / Briefing ─────────────── */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: '32px',
          paddingTop: '20px', borderTop: `1px solid ${C.rule}`,
        }}>
          {/* Guests */}
          <div>
            <span style={{
              fontFamily: FONT_MONO, fontSize: '10px', color: C.ink3,
              letterSpacing: '0.18em', textTransform: 'uppercase',
            }}>
              {lang === 'es' ? 'Huéspedes' : 'Guests'}
            </span>
            <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: FONT_SANS, fontSize: '13px', color: C.ink2 }}>
                  {lang === 'es' ? 'Llegadas' : 'Arrivals'}
                </span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: '22px', fontWeight: 500,
                  color: C.ink, letterSpacing: '-0.02em',
                }}>
                  {arrivals > 0 ? arrivals : '—'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: FONT_SANS, fontSize: '13px', color: C.ink2 }}>
                  {lang === 'es' ? 'Reservas' : 'Reservations'}
                </span>
                <InlineEdit value={reservationCount} onChange={setReservationCount} fieldKey="reservations" />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: FONT_SANS, fontSize: '13px', color: C.ink2 }}>
                  {lang === 'es' ? 'En casa' : 'In-house'}
                </span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: '22px', fontWeight: 500,
                  color: C.ink, letterSpacing: '-0.02em',
                }}>
                  {inHouseGuests > 0 ? inHouseGuests : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Revenue */}
          <div>
            <span style={{
              fontFamily: FONT_MONO, fontSize: '10px', color: C.ink3,
              letterSpacing: '0.18em', textTransform: 'uppercase',
            }}>
              {lang === 'es' ? 'Ingresos' : 'Revenue'}
            </span>
            <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: FONT_SANS, fontSize: '13px', color: C.ink2 }}>ADR</span>
                <InlineEdit value={adr} onChange={setAdr} fieldKey="adr" prefix="$" />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: FONT_SANS, fontSize: '13px', color: C.ink2 }}>RevPAR</span>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: '22px', fontWeight: 500,
                  color: C.ink, letterSpacing: '-0.02em',
                }}>
                  {revpar > 0 ? `$${revpar}` : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Morning briefing */}
          <div>
            <span style={{
              fontFamily: FONT_MONO, fontSize: '10px', color: C.ink3,
              letterSpacing: '0.18em', textTransform: 'uppercase',
            }}>
              {lang === 'es' ? 'Resumen matutino' : 'Morning briefing'}
            </span>
            <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column' }}>
              {briefingItems.length === 0 ? (
                <p style={{
                  fontFamily: FONT_SANS, fontSize: '13px', color: C.ink2,
                  fontStyle: 'italic', margin: '8px 0 0',
                }}>
                  {lang === 'es' ? 'Sin actualizaciones hoy.' : 'No updates today.'}
                </p>
              ) : briefingItems.map((b, i) => {
                const dotColor =
                  b.tone === 'warm' ? C.warm
                  : b.tone === 'caramel' ? C.caramel
                  : C.sageDeep;
                return (
                  <div key={b.id} style={{
                    display: 'flex', gap: '12px', padding: '10px 0',
                    borderBottom: i < briefingItems.length - 1 ? `1px solid ${C.ruleSoft}` : 'none',
                  }}>
                    <span style={{
                      width: '5px', height: '5px', borderRadius: '50%',
                      background: dotColor, marginTop: '7px', flexShrink: 0,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: '10px', color: C.ink3 }}>
                        {formatTime(b.time)}
                      </span>
                      <p style={{
                        fontFamily: FONT_SANS, fontSize: '13px', color: C.ink,
                        margin: '2px 0 0', lineHeight: 1.4,
                      }}>
                        {b.text}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

      </div>
    </AppLayout>
  );
}
