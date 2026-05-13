'use client';

// Snow / split-grid Performance from the Claude Design housekeeping
// handoff (May 2026). Layout per design:
//   • Header: "Housekeeping Performance" + range pills (Today/7d/30d/90d/1y)
//   • Left column (1.6fr): leaderboard table → flagged review (only when there's
//     something to review)
//   • Right column (1fr): Cleaning Efficiency card with Overall + Checkout
//     / Stay light / Stay full weighted averages
//
// Data layer untouched from the previous version — same cleaning-events
// audit log (Migration 0012), same flag/keep/discard flow, same active-staff
// filter. Only the JSX changed and the time format flipped from MM:SS to
// decimal-minute (design uses "21.4m", not "21:24").

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import {
  getCleaningEventsForRange,
  getFlaggedCleaningEvents,
  decideOnFlaggedEvent,
  subscribeToTodayCleaningEvents,
} from '@/lib/db';
import type { CleaningEvent } from '@/lib/db';
import { useTodayStr } from '@/lib/use-today-str';
import { format, subDays } from 'date-fns';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, HousekeeperDot,
} from './_snow';
import type { StaffMember } from '@/types';

type ViewMode = 'live' | '7d' | '30d' | '3mo' | '1yr';
const VIEW_DAYS: Record<ViewMode, number> = { live: 1, '7d': 7, '30d': 30, '3mo': 90, '1yr': 365 };

const LEADERBOARD_MIN_ROOMS = 3;

// Decimal-minute format ("21.4m") — matches the design's typography.
function fmtDec(mins: number | null | undefined): string {
  if (mins == null || !isFinite(mins)) return '—';
  return `${mins.toFixed(1)}m`;
}

// Parse YYYY-MM-DD as a *local* midnight date instead of UTC. Without
// this, `new Date('2026-05-12')` lands at UTC midnight, which renders
// as "May 11" for any timezone west of UTC — flagged events from "today"
// would display as yesterday.
function parseLocalDate(ymd: string | null | undefined): Date | null {
  if (!ymd) return null;
  const parts = ymd.split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

interface StaffStats {
  staffId: string;
  name: string;
  total: number;
  avgMins: number;
  avgCheckout: number | null;
  avgS1: number | null;
  avgS2: number | null;
}

export function PerformanceTab() {
  const { user } = useAuth();
  const { activePropertyId, staff, staffLoaded } = useProperty();
  const { lang } = useLang();
  const today = useTodayStr();

  const [view, setView] = useState<ViewMode>('7d');
  const [events, setEvents] = useState<CleaningEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [flagged, setFlagged] = useState<CleaningEvent[]>([]);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  // Active-staff set drives the leaderboard filter; null → context still
  // loading, so include everyone (avoid a transient empty leaderboard).
  const activeStaffIds = useMemo<Set<string> | null>(
    () => staffLoaded ? new Set(staff.filter(s => s.isActive !== false).map(s => s.id)) : null,
    [staff, staffLoaded],
  );

  // Load events for the current view. Live = realtime, history = one-shot.
  useEffect(() => {
    if (!user || !activePropertyId) return;
    if (view === 'live') {
      return subscribeToTodayCleaningEvents(activePropertyId, today, setEvents);
    }
    const days = VIEW_DAYS[view];
    const fromDate = format(subDays(new Date(), days - 1), 'yyyy-MM-dd');
    let cancelled = false;
    setHistoryLoading(true);
    getCleaningEventsForRange(activePropertyId, fromDate, today)
      .then(rows => { if (!cancelled) setEvents(rows); })
      .catch(err => console.error('[PerformanceTab] load events failed:', err))
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [user, activePropertyId, view, today]);

  // Flag-review queue — independent of view, polled every 30s.
  useEffect(() => {
    if (!activePropertyId) return;
    let cancelled = false;
    const refresh = () => {
      getFlaggedCleaningEvents(activePropertyId)
        .then(rows => { if (!cancelled) setFlagged(rows); })
        .catch(err => console.error('[PerformanceTab] load flagged failed:', err));
    };
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activePropertyId]);

  // Eligible = recorded + approved (kept after flag review).
  const eligible = useMemo(
    () => events.filter(e => e.status === 'recorded' || e.status === 'approved'),
    [events],
  );

  // Per-staff aggregated stats.
  const leaderboard: StaffStats[] = useMemo(() => {
    type Acc = StaffStats & { _check: number; _s1: number; _s2: number; checkoutN: number; s1N: number; s2N: number; totalMins: number };
    const byStaff = new Map<string, Acc>();
    for (const ev of eligible) {
      if (activeStaffIds && ev.staffId && !activeStaffIds.has(ev.staffId)) continue;
      const key = ev.staffId ?? `name:${ev.staffName}`;
      const e = byStaff.get(key) ?? {
        staffId: ev.staffId ?? key, name: ev.staffName,
        total: 0, totalMins: 0, avgMins: 0,
        avgCheckout: null, avgS1: null, avgS2: null,
        _check: 0, _s1: 0, _s2: 0, checkoutN: 0, s1N: 0, s2N: 0,
      };
      e.total++;
      e.totalMins += ev.durationMinutes;
      if (ev.roomType === 'checkout')        { e._check += ev.durationMinutes; e.checkoutN++; }
      else if (ev.stayoverDay === 1)         { e._s1    += ev.durationMinutes; e.s1N++; }
      else if (ev.stayoverDay === 2)         { e._s2    += ev.durationMinutes; e.s2N++; }
      byStaff.set(key, e);
    }
    return Array.from(byStaff.values())
      .filter(e => e.total >= LEADERBOARD_MIN_ROOMS)
      .map(e => ({
        staffId: e.staffId, name: e.name, total: e.total,
        avgMins: e.totalMins / e.total,
        avgCheckout: e.checkoutN > 0 ? e._check / e.checkoutN : null,
        avgS1:       e.s1N       > 0 ? e._s1    / e.s1N       : null,
        avgS2:       e.s2N       > 0 ? e._s2    / e.s2N       : null,
      }))
      // Tie-break by name so two crew with identical avgMins don't flip
      // ranks across renders — without this, refresh-to-refresh stability
      // depends on Map iteration order.
      .sort((a, b) => (a.avgMins - b.avgMins) || a.name.localeCompare(b.name));
  }, [eligible, activeStaffIds]);

  // Provisional — < 3 rooms; sidebar pills.
  const provisional = useMemo(() => {
    const byStaff = new Map<string, { staffId: string; name: string; total: number }>();
    for (const ev of eligible) {
      if (activeStaffIds && ev.staffId && !activeStaffIds.has(ev.staffId)) continue;
      const key = ev.staffId ?? `name:${ev.staffName}`;
      const e = byStaff.get(key) ?? { staffId: ev.staffId ?? key, name: ev.staffName, total: 0 };
      e.total++;
      byStaff.set(key, e);
    }
    return Array.from(byStaff.values())
      .filter(e => e.total < LEADERBOARD_MIN_ROOMS && e.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [eligible, activeStaffIds]);

  // Per-type team weighted averages for the right-column card.
  const typeAvgs = useMemo(() => {
    const checkout = eligible.filter(e => e.roomType === 'checkout');
    const s1       = eligible.filter(e => e.roomType === 'stayover' && e.stayoverDay === 1);
    const s2       = eligible.filter(e => e.roomType === 'stayover' && e.stayoverDay === 2);
    const sum = (arr: CleaningEvent[]) => arr.reduce((s, e) => s + e.durationMinutes, 0);
    const total = eligible.length;
    return {
      overall:  total ? sum(eligible) / total : null,
      checkout: checkout.length ? sum(checkout) / checkout.length : null,
      s1:       s1.length       ? sum(s1)       / s1.length       : null,
      s2:       s2.length       ? sum(s2)       / s2.length       : null,
      shareCheckout: total ? checkout.length / total : 0,
      shareS1:       total ? s1.length       / total : 0,
      shareS2:       total ? s2.length       / total : 0,
    };
  }, [eligible]);

  // Pace badge: rank 1 / rank 2-3 / rank 4+ → fast / on / slow vs team avg.
  function paceFor(stats: StaffStats): 'fast' | 'on' | 'slow' {
    if (typeAvgs.overall == null) return 'on';
    if (stats.avgMins < typeAvgs.overall * 0.95) return 'fast';
    if (stats.avgMins > typeAvgs.overall * 1.05) return 'slow';
    return 'on';
  }

  function PaceBadge({ pace }: { pace: 'fast' | 'on' | 'slow' }) {
    if (pace === 'fast') return <Pill tone="sage">↑ {lang === 'es' ? 'Rápido' : 'Fast'}</Pill>;
    if (pace === 'slow') return <Pill tone="warm">↓ {lang === 'es' ? 'Lento'  : 'Slow'}</Pill>;
    return <Pill tone="neutral">· {lang === 'es' ? 'En ritmo' : 'On pace'}</Pill>;
  }

  // Map a stats row to a StaffMember-shaped object so HousekeeperDot can color it.
  const staffShape = (s: { staffId: string; name: string }): Pick<StaffMember, 'id' | 'name'> => ({
    id: s.staffId, name: s.name,
  });

  // Flagged review action.
  const handleDecide = async (eventId: string, decision: 'approved' | 'rejected') => {
    if (!user || !activePropertyId) return;
    setReviewingId(eventId);
    try {
      await decideOnFlaggedEvent(eventId, decision, user.uid);
      setFlagged(prev => prev.filter(e => e.id !== eventId));
    } catch (err) {
      console.error('[PerformanceTab] decide failed:', err);
    } finally {
      setReviewingId(null);
    }
  };

  const ranges: { k: ViewMode; l: string }[] = [
    { k: 'live', l: lang === 'es' ? 'Hoy'      : 'Today' },
    { k: '7d',   l: lang === 'es' ? '7 días'   : '7 days' },
    { k: '30d',  l: lang === 'es' ? '30 días'  : '30 days' },
    { k: '3mo',  l: lang === 'es' ? '90 días'  : '90 days' },
    { k: '1yr',  l: lang === 'es' ? '1 año'    : '1 year' },
  ];

  // CSV export — coerces startedAt/completedAt safely. The CleaningEvent
  // type narrows to Date in TS, but Supabase row mappers occasionally
  // forward an ISO string through (especially for legacy rows that
  // bypassed the mapper); calling .toISOString() on a string blows up
  // mid-export. The helper accepts both.
  const toIso = (v: unknown): string => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') {
      const d = new Date(v);
      return isNaN(d.getTime()) ? '' : d.toISOString();
    }
    if (typeof v === 'object' && v !== null && 'toDate' in v && typeof (v as { toDate?: unknown }).toDate === 'function') {
      return (v as { toDate: () => Date }).toDate().toISOString();
    }
    return '';
  };
  const handleExport = useCallback(() => {
    if (events.length === 0) return;
    const fromDate = view === 'live' ? today : format(subDays(new Date(), VIEW_DAYS[view] - 1), 'yyyy-MM-dd');
    const filename = `cleaning-events_${fromDate}_to_${today}.csv`;
    const headers = ['date', 'room', 'type', 'cycle', 'housekeeper', 'started_at', 'completed_at', 'duration_minutes', 'status'];
    const rows = events.map(e => [
      e.date, e.roomNumber, e.roomType,
      e.stayoverDay === 1 ? 'S1' : e.stayoverDay === 2 ? 'S2' : (e.roomType === 'checkout' ? 'CO' : ''),
      e.staffName,
      toIso(e.startedAt), toIso(e.completedAt),
      e.durationMinutes.toFixed(2),
      e.status,
    ]);
    const csv = [headers, ...rows]
      .map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }, [events, view, today]);

  return (
    <div style={{
      padding: '24px 48px 48px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>

      {/* HEADER */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: 24, gap: 24, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: 0,
            letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400,
          }}>
            {lang === 'es' ? 'Limpieza ' : 'Housekeeping '}
            <span style={{ fontStyle: 'italic' }}>
              {lang === 'es' ? 'Rendimiento' : 'Performance'}
            </span>
          </h1>
          <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: '8px 0 0' }}>
            {lang === 'es' ? 'Eficiencia operacional y tabla del equipo.' : 'Operational efficiency and team leaderboards.'}
          </p>
        </div>
        <div style={{
          background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 999,
          padding: 4, display: 'flex', gap: 2,
        }}>
          {ranges.map(r => (
            <button
              key={r.k}
              onClick={() => setView(r.k)}
              style={{
                padding: '7px 14px', borderRadius: 999, border: 'none', cursor: 'pointer',
                background: view === r.k ? T.ink : 'transparent',
                color: view === r.k ? T.bg : T.ink2,
                fontFamily: FONT_SANS, fontSize: 12, fontWeight: view === r.k ? 600 : 500,
                whiteSpace: 'nowrap',
              }}
            >{r.l}</button>
          ))}
        </div>
      </div>

      {/* MAIN GRID */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 18, alignItems: 'flex-start' }}>

        {/* LEFT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* LEADERBOARD */}
          <div style={{
            background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
            padding: '8px 24px 16px',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '18px 0 14px', borderBottom: `1px solid ${T.rule}`,
            }}>
              <Caps>{lang === 'es' ? 'Tabla del equipo' : 'Team leaderboard'}</Caps>
              <Btn variant="ghost" size="sm" onClick={handleExport} disabled={events.length === 0}>
                {lang === 'es' ? 'Exportar reporte' : 'Export report'} ↓
              </Btn>
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: '40px 1fr 80px 100px 110px',
              gap: 12, padding: '14px 0', borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center',
            }}>
              <Caps size={9}>#</Caps>
              <Caps size={9}>{lang === 'es' ? 'Limpiadora' : 'Crew'}</Caps>
              <Caps size={9}>{lang === 'es' ? 'Cuartos' : 'Rooms'}</Caps>
              <Caps size={9}>{lang === 'es' ? 'Tiempo' : 'Avg time'}</Caps>
              <Caps size={9}>{lang === 'es' ? 'Ritmo' : 'Pace'}</Caps>
            </div>

            {historyLoading && leaderboard.length === 0 && (
              <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, padding: '20px 0' }}>
                {lang === 'es' ? 'Cargando…' : 'Loading…'}
              </p>
            )}
            {!historyLoading && leaderboard.length === 0 && (
              <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, padding: '20px 0', fontStyle: 'italic' }}>
                {lang === 'es' ? 'Sin datos suficientes en este período.' : 'Not enough data in this period yet.'}
              </p>
            )}
            {leaderboard.map((r, i) => {
              const rank = i + 1;
              const pace = paceFor(r);
              return (
                <div key={r.staffId} style={{
                  display: 'grid', gridTemplateColumns: '40px 1fr 80px 100px 110px',
                  gap: 12, padding: '16px 0', borderBottom: `1px solid ${T.ruleSoft}`, alignItems: 'center',
                }}>
                  <span style={{
                    fontFamily: FONT_SERIF, fontSize: 26, fontStyle: 'italic',
                    color: rank <= 3 ? T.ink : T.ink2, lineHeight: 1, letterSpacing: '-0.02em',
                  }}>{rank}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <HousekeeperDot staff={staffShape(r)} size={32} />
                    <span style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink, fontWeight: 500, whiteSpace: 'nowrap' }}>{r.name}</span>
                  </div>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 14, color: T.ink, fontWeight: 500 }}>{r.total}</span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 14, color: T.ink, fontWeight: 600 }}>{fmtDec(r.avgMins)}</span>
                  <span><PaceBadge pace={pace} /></span>
                </div>
              );
            })}

            {/* PROVISIONAL */}
            {provisional.length > 0 && (
              <div style={{ paddingTop: 14, marginTop: 4 }}>
                <Caps>{lang === 'es' ? 'Provisional · < 3 limpiezas este período' : 'Provisional · < 3 cleans this period'}</Caps>
                <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                  {provisional.map(p => (
                    <div key={p.staffId} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 4px 4px',
                      background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 999,
                    }}>
                      <HousekeeperDot staff={staffShape(p)} size={22} />
                      <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink, whiteSpace: 'nowrap' }}>{p.name}</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
                        {p.total} {lang === 'es' ? 'limpiezas' : 'cleans'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* FLAGGED — only renders when there's something to review */}
          {flagged.length > 0 && (
            <div style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
              padding: '18px 24px',
            }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8,
              }}>
                <Caps>{lang === 'es' ? 'A revisar' : 'Flagged · review'}</Caps>
                <Pill tone="warm">
                  {flagged.length} {lang === 'es' ? 'sobre 60m' : 'over 60m'}
                </Pill>
              </div>
              <p style={{
                fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '0 0 12px', fontStyle: 'italic',
              }}>
                {lang === 'es'
                  ? 'Decide si estas limpiezas cuentan en los promedios.'
                  : 'Decide if these cleans count toward averages.'}
              </p>
              {flagged.map(f => (
                <div key={f.id} style={{
                  padding: '12px 0', borderTop: `1px solid ${T.ruleSoft}`,
                  display: 'grid', gridTemplateColumns: '70px 80px 1fr 60px auto',
                  gap: 14, alignItems: 'center',
                }}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
                    {(() => {
                      const d = parseLocalDate(f.date);
                      return d ? format(d, 'MMM d') : f.date;
                    })()}
                  </span>
                  <span style={{
                    fontFamily: FONT_SERIF, fontSize: 20, color: T.ink, fontStyle: 'italic',
                    letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400,
                  }}>{lang === 'es' ? 'Cuarto' : 'Rm'} {f.roomNumber}</span>
                  <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>{f.staffName}</span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 14, color: T.warm, fontWeight: 600 }}>
                    {f.durationMinutes.toFixed(0)}m
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn variant="ghost" size="sm" disabled={reviewingId === f.id} onClick={() => handleDecide(f.id, 'approved')}>
                      {lang === 'es' ? 'Mantener' : 'Keep'}
                    </Btn>
                    <Btn variant="paper" size="sm" disabled={reviewingId === f.id} onClick={() => handleDecide(f.id, 'rejected')}>
                      {lang === 'es' ? 'Descartar' : 'Discard'}
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT COLUMN — CLEANING EFFICIENCY */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{
            background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
            padding: '22px 24px',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${T.rule}`,
            }}>
              <Caps>{lang === 'es' ? 'Eficiencia de limpieza' : 'Cleaning efficiency'}</Caps>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, whiteSpace: 'nowrap' }}>
                {lang === 'es' ? 'equipo · ponderado' : 'team · weighted avg'}
              </span>
            </div>

            {/* OVERALL HERO */}
            <div style={{ paddingBottom: 14, borderBottom: `1px solid ${T.ruleSoft}` }}>
              <Caps size={9}>{lang === 'es' ? 'General' : 'Overall'}</Caps>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={{
                  fontFamily: FONT_SERIF, fontSize: 42, color: T.ink,
                  letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400,
                }}>
                  {typeAvgs.overall != null ? (
                    <>
                      <span style={{ fontStyle: 'italic' }}>{typeAvgs.overall.toFixed(1)}</span>
                      <span style={{ fontSize: 22, color: T.ink2, fontStyle: 'italic' }}>m</span>
                    </>
                  ) : '—'}
                </span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>
                  {eligible.length} {lang === 'es' ? 'limpiezas' : 'cleans'}
                </span>
              </div>
            </div>

            {/* PER-TYPE */}
            {([
              { l: lang === 'es' ? 'Salida'      : 'Checkout',     v: typeAvgs.checkout, sub: lang === 'es' ? 'cambio total'  : 'full turnover', tone: T.warm,        share: typeAvgs.shareCheckout },
              { l: lang === 'es' ? 'Estadía · 1' : 'Stay · light', v: typeAvgs.s1,       sub: lang === 'es' ? 'día 1'         : 'day 1',         tone: T.sageDeep,    share: typeAvgs.shareS1 },
              { l: lang === 'es' ? 'Estadía · 2' : 'Stay · full',  v: typeAvgs.s2,       sub: lang === 'es' ? 'día 2'         : 'day 2',         tone: T.caramelDeep, share: typeAvgs.shareS2 },
            ] as const).map((e, i, arr) => (
              <div key={e.l} style={{
                padding: '14px 0',
                borderBottom: i < arr.length - 1 ? `1px solid ${T.ruleSoft}` : 'none',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500, whiteSpace: 'nowrap' }}>{e.l}</span>
                    <span style={{
                      fontFamily: FONT_MONO, fontSize: 10, color: T.ink3,
                      letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{e.sub}</span>
                  </div>
                  <span style={{
                    fontFamily: FONT_SERIF, fontSize: 28, color: e.tone,
                    letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400,
                  }}>
                    {e.v != null ? (
                      <>
                        <span style={{ fontStyle: 'italic' }}>{e.v.toFixed(1)}</span>
                        <span style={{ fontSize: 14, color: T.ink2, fontStyle: 'italic' }}>m</span>
                      </>
                    ) : '—'}
                  </span>
                </div>
                <div style={{ height: 4, background: T.ruleSoft, borderRadius: 2, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${e.share * 100}%`, background: e.tone }} />
                </div>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, marginTop: 4,
                  display: 'inline-block', whiteSpace: 'nowrap',
                }}>
                  {Math.round(e.share * 100)}% {lang === 'es' ? 'de limpiezas' : 'of cleans'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
