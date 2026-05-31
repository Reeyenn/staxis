'use client';

// Schedule tab — a single board with a Kanban / Timeline / Forecast view
// toggle near the top (May 2026 combine). The legacy manual board (crew
// rows, drag-to-assign, swap menus, the "Auto-assign" + "Send links"
// action band, and the staff-priority modal) was removed: it duplicated
// the Kanban board and ran on the retired schedule_assignments data layer.
// Auto-assignment now happens server-side (the run-auto-assign cron) and
// surfaces in the Kanban (AutoAssignBoard) + Timeline views, which read
// cleaning_tasks / hk_assignments. "Send the crew their rooms" and "pick
// who's working today" will be rebuilt on the new board once the PMS room
// feed is live end-to-end.
//
// What stays here: the date stepper, the PMS pull strip (live counts) with
// its cleaning-time settings modal, the "tomorrow's confidence" ML tile,
// and the three sub-views.

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import {
  subscribeToPlanSnapshot,
  subscribeToDashboardByDate,
  updateProperty,
} from '@/lib/db';
import type { PlanSnapshot, DashboardNumbers } from '@/lib/db';
import {
  defaultShiftDate, addDays, formatDisplayDate, snapshotToShiftRooms, formatPulledAt,
} from './_shared';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Btn,
} from './_snow';
import { CalloutBanner } from './CalloutBanner';
import {
  getActiveOptimizerForTomorrow,
  getActiveDemandForTomorrow,
} from '@/lib/ml-schedule-helpers';
// Auto-Assign Board — the Kanban view. Manager view of the cleaning_tasks +
// hk_assignments system; degrades to an empty-state when the rules engine
// hasn't produced tasks for today yet.
import { AutoAssignBoard } from './AutoAssignBoard';
// Timeline View — Gantt-style strip below the Auto-Assign Board. Shows each
// housekeeper's day on a horizontal time axis. Same data model as the board,
// richer payload via /api/housekeeping/timeline (lifecycle timestamps).
import { TimelineView } from './TimelineView';
// Forecast View — third optional sub-view below the legacy schedule.
// Renders forward-looking demand vs supply across 1 / 7 / 14 day ranges
// so the GM can spot understaffed days before the day-of fire drill.
import { ForecastView } from './ForecastView';
import { NoticeBoardPoster } from './NoticeBoardPoster';

// Persisted view choice. Three states — see the toggle below the
// existing PMS strip. Stored in localStorage so a tab refresh lands
// the manager on the same view they last looked at.
type ScheduleView = 'kanban' | 'timeline' | 'forecast';
const VIEW_STORAGE_KEY = 'staxis.schedule.view';

export function ScheduleTab() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, refreshProperty } = useProperty();
  const { lang } = useLang();

  const [shiftDate, setShiftDate] = useState(defaultShiftDate);
  const [planSnapshot, setPlanSnapshot] = useState<PlanSnapshot | null>(null);
  // Flips true after the first plan-snapshot callback fires (with data or
  // null), so the PMS strip can show a skeleton during the initial fetch
  // instead of zero-counts that read like real data.
  const [planLoaded, setPlanLoaded] = useState(false);
  // 15-min Choice Advantage dashboard pull (In House / Arrivals /
  // Departures). Independent of the hourly CSV plan-snapshot above — each
  // refreshes on its own cadence and has its own loaded flag.
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [scheduleView, setScheduleView] = useState<ScheduleView>('kanban');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === 'kanban' || stored === 'timeline' || stored === 'forecast') {
        setScheduleView(stored);
      }
    } catch {
      // private-browsing modes can throw on localStorage — ignore
    }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, scheduleView); } catch { /* ignore */ }
  }, [scheduleView]);

  // Prediction Settings modal — lets the user tune per-property cleaning
  // minutes (checkout / stayover Day 1 / stayover Day 2 / prep) and the
  // shift cap, which all feed the auto-assign algorithm and the per-HK
  // capacity bars. Form state is seeded from activeProperty when the
  // modal opens so the inputs always reflect the current persisted values.
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    checkoutMinutes: 30,
    stayoverDay1Minutes: 15,
    stayoverDay2Minutes: 20,
    prepMinutesPerActivity: 5,
    shiftMinutes: 420,
  });

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  useEffect(() => {
    if (!pid) return;
    setDashboardLoaded(false);
    return subscribeToDashboardByDate(pid, shiftDate, (nums) => {
      setDashboardNums(nums);
      setDashboardLoaded(true);
    });
  }, [pid, shiftDate]);

  useEffect(() => {
    if (!uid || !pid) return;
    setPlanLoaded(false);
    return subscribeToPlanSnapshot(uid, pid, shiftDate, (snap) => {
      setPlanSnapshot(snap);
      setPlanLoaded(true);
    });
  }, [uid, pid, shiftDate]);

  const [optimizerPanel, setOptimizerPanel] = useState<{
    recommendedHeadcount: number;
    completionProbabilityCurve: Array<{ headcount: number; p: number }>;
    // Phase 1.3 (2026-05-22) — derived from optimizer_results.inputs_snapshot
    // so the confidence tile can branch the headline label honestly
    // between "AI recommendation" (fitted) and "Industry estimate ·
    // learning" (warming-up or capacity-unavailable).
    modelKind: 'fitted' | 'warming-up' | 'capacity-unavailable';
    warmupReason: string | null;
  } | null>(null);
  const [demandPanel, setDemandPanel] = useState<{
    predictedHeadcountP80: number;
    predictedHeadcountP95: number;
  } | null>(null);
  useEffect(() => {
    if (!pid || !activeProperty) return;
    let cancelled = false;
    void Promise.all([
      getActiveOptimizerForTomorrow(pid, activeProperty.timezone ?? undefined),
      getActiveDemandForTomorrow(pid, activeProperty.timezone ?? undefined),
    ]).then(([opt, dem]) => {
      if (cancelled) return;
      setOptimizerPanel(opt);
      setDemandPanel(dem);
    });
    return () => { cancelled = true; };
  }, [pid, activeProperty, shiftDate]);

  // ── Derived: shift rooms from CSV pull ────────────────────────────────
  const shiftRooms = useMemo(() => snapshotToShiftRooms(planSnapshot, pid), [planSnapshot, pid]);

  // Rooms eligible for cleaning. Excludes DND rooms — guest flagged "do
  // not disturb" so the housekeeper can't enter. They re-appear next
  // refresh once the HK clears DND from their phone. Without this filter,
  // auto-assign would hand someone a room they physically can't service.
  //
  // The May-2026 maintenance simplification (migration 0131) dropped the
  // `blockedRoom` field from work_orders, so we no longer filter rooms by
  // an open maintenance ticket here. If unsellable-room filtering comes
  // back, it should be sourced from a dedicated room-status flag.
  const assignableRooms = useMemo(
    () => shiftRooms.filter(r => !r.isDnd),
    [shiftRooms],
  );

  const checkouts = assignableRooms.filter(r => r.type === 'checkout').length;
  const stayoverDay1 = assignableRooms.filter(r => r.type === 'stayover' && r.stayoverDay === 1).length;
  const stayoverDay2 = assignableRooms.filter(r => r.type === 'stayover' && r.stayoverDay === 2).length;

  // Time math — checkout 30m + stayoverDay1 15m + stayoverDay2 20m by default,
  // or whatever Maria has set in Property settings.
  const ckMin   = activeProperty?.checkoutMinutes      ?? 30;
  const so1Min  = activeProperty?.stayoverDay1Minutes  ?? 15;
  const so2Min  = activeProperty?.stayoverDay2Minutes  ?? 20;
  const totalMinutes = checkouts * ckMin + stayoverDay1 * so1Min + stayoverDay2 * so2Min;
  // Per-housekeeper shift cap. Property setting (default 420 = 7h),
  // not a hardcoded 8h — the auto-assign algorithm and the capacity
  // bars MUST agree on the same number, or the bars will misrepresent
  // what auto-assign actually produced.
  //
  // Clamp to a positive minimum: a misconfigured property row (0 or
  // negative shiftMinutes) would otherwise propagate as Infinity through
  // every division in the tab (recommendedHKs, capacity bars, etc.) and
  // render literal "Infinity HKs". Bottom-clamp at 60 — anything below
  // a single hour-long shift is almost certainly a fat-finger.
  const SHIFT_MINS = Math.max(60, activeProperty?.shiftMinutes ?? 420);
  // Recommended housekeeping headcount = cleaning crew needed to cover
  // the total cleaning minutes within shift hours, plus 1 dedicated to
  // laundry. Matches the previous version's `recommendedStaff` formula.
  const LAUNDRY_STAFF = 1;
  const recommendedHKs = Math.max(1, Math.ceil(totalMinutes / SHIFT_MINS)) + LAUNDRY_STAFF;

  const fmtTime = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
  };

  // ── Persist (debounced) ───────────────────────────────────────────────
  const flashToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  // Clear any pending toast timer on unmount so a delayed setToast(null)
  // can't fire after the component is gone (React warns + leaks state).
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Shift back/forward controls — date stepper
  const today = useMemo(() => new Date().toLocaleDateString('en-CA'), []);
  const isToday = shiftDate === today;
  const isYesterday = shiftDate === addDays(today, -1);
  const isTomorrow = shiftDate === addDays(today, 1);

  // formatPulledAt prefixes "Today" vs the weekday so a 2-day-old pull
  // and a 1-min-old pull don't both show the same time-of-day. Coerce
  // pulledAt to ISO string for the helper (it can come through as Date
  // from Supabase or string from a cached snapshot).
  const pulledAtIso = planSnapshot?.pulledAt
    ? (planSnapshot.pulledAt instanceof Date
        ? planSnapshot.pulledAt.toISOString()
        : String(planSnapshot.pulledAt))
    : null;
  const pulledAtLabel = pulledAtIso
    ? formatPulledAt(pulledAtIso, lang)
    : (lang === 'es' ? 'sin datos' : 'no data');

  return (
    <div style={{
      padding: '24px 48px 48px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>

      <NoticeBoardPoster />

      {/* DATE STEPPER */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: 18, gap: 24, flexWrap: 'wrap',
      }}>
        <div>
          <Caps>{
            // Show "Schedule" alone for arbitrary past/future dates so we
            // don't render "Schedule · " with a dangling middle-dot.
            (() => {
              if (isToday)     return lang === 'es' ? 'Horario · hoy'     : 'Schedule · today';
              if (isYesterday) return lang === 'es' ? 'Horario · ayer'    : 'Schedule · yesterday';
              if (isTomorrow)  return lang === 'es' ? 'Horario · mañana'  : 'Schedule · tomorrow';
              return lang === 'es' ? 'Horario' : 'Schedule';
            })()
          }</Caps>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0',
            letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>{formatDisplayDate(shiftDate, lang).split(',')[0]}</span>
            <span> · {formatDisplayDate(shiftDate, lang).split(',').slice(1).join(',').trim()}</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, -1))}>← {lang === 'es' ? 'Ayer' : 'Yesterday'}</Btn>
          <Btn variant={isToday ? 'paper' : 'ghost'} size="sm" onClick={() => setShiftDate(today)}>{lang === 'es' ? 'Hoy' : 'Today'}</Btn>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, 1))}>{lang === 'es' ? 'Mañana' : 'Tomorrow'} →</Btn>
        </div>
      </div>

      <CalloutBanner shiftDate={shiftDate} />

      {/* PMS PULL STRIP — current pull's numbers in plain sight.
          The design also showed ‹/› buttons toggling between morning and
          evening pulls, but the underlying subscription only gives us the
          most-recent pull for the date. Rather than render lying buttons
          we just show the current pull's freshness; we'll add real
          history navigation when the data layer supports it. */}
      <div style={{
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
        padding: '18px 22px', marginBottom: 18,
        display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 160 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Caps size={9}>{lang === 'es' ? 'Última carga PMS' : 'Latest PMS pull'}</Caps>
            {/* Cleaning-time settings live behind the gear so the strip
                stays uncluttered. Opens the Prediction Settings modal,
                seeded from activeProperty. */}
            <button
              onClick={() => {
                setSettingsForm({
                  checkoutMinutes:        activeProperty?.checkoutMinutes        ?? 30,
                  stayoverDay1Minutes:    activeProperty?.stayoverDay1Minutes    ?? 15,
                  stayoverDay2Minutes:    activeProperty?.stayoverDay2Minutes    ?? 20,
                  prepMinutesPerActivity: activeProperty?.prepMinutesPerActivity ?? 5,
                  shiftMinutes:           activeProperty?.shiftMinutes           ?? 420,
                });
                setShowSettings(true);
              }}
              title={lang === 'es' ? 'Ajustes de cuartos / turno' : 'Cleaning-time settings'}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: 2, borderRadius: 4, color: T.ink3,
                display: 'inline-flex', alignItems: 'center',
              }}
              aria-label={lang === 'es' ? 'Ajustes' : 'Settings'}
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
          <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500, marginTop: 2 }}>
            {planLoaded ? pulledAtLabel : (lang === 'es' ? 'Cargando…' : 'Loading…')}
          </span>
        </div>
        <span style={{ width: 1, height: 42, background: T.rule }} />
        <div style={{ display: 'flex', gap: 32, flex: 1, flexWrap: 'wrap' }}>
          {/* Skeleton dashes until each source's first callback fires
              — without this, the strip momentarily reads "Checkouts: 0
              · Stay·light: 0 · Recommended: 1 HKs" which looks like real
              data on a slow pull. The first five cells come from the
              hourly CSV plan snapshot; the last three come from the
              15-min Choice Advantage dashboard pull. Each cell uses
              its own `loaded` flag so a slow dashboard pull doesn't
              hold back the CSV numbers (or vice versa). */}
          {([
            { l: lang === 'es' ? 'En Casa'      : 'In House',    v: dashboardNums?.inHouse    ?? null, loaded: dashboardLoaded },
            { l: lang === 'es' ? 'Llegadas'     : 'Arrivals',    v: dashboardNums?.arrivals   ?? null, loaded: dashboardLoaded },
            { l: lang === 'es' ? 'Salen'        : 'Departures',  v: dashboardNums?.departures ?? null, loaded: dashboardLoaded },
            { l: lang === 'es' ? 'Salidas'      : 'Checkouts',   v: checkouts,             loaded: planLoaded },
            { l: lang === 'es' ? 'Estadía·1'    : 'Stay · light',v: stayoverDay1,          loaded: planLoaded },
            { l: lang === 'es' ? 'Estadía·2+'   : 'Stay · full', v: stayoverDay2,          loaded: planLoaded },
            { l: lang === 'es' ? 'Tiempo total' : 'Total time',  v: fmtTime(totalMinutes), loaded: planLoaded },
            { l: lang === 'es' ? 'Recomendado'  : 'Recommended', v: `${recommendedHKs} HKs`, loaded: planLoaded, tone: T.sageDeep },
          ] as Array<{ l: string; v: React.ReactNode; loaded: boolean; tone?: string }>).map(n => (
            <div key={n.l} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 80 }}>
              <Caps size={9}>{n.l}</Caps>
              <span style={{
                fontFamily: FONT_SERIF, fontSize: 30, color: n.loaded ? (n.tone || T.ink) : T.ink3,
                lineHeight: 1, letterSpacing: '-0.02em', fontWeight: 400, whiteSpace: 'nowrap',
              }}>{n.loaded && n.v != null ? n.v : '—'}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Phase M3.1 (2026-05-14): ML confidence panel — Tomorrow's
          recommended headcount + p80/p95 confidence band. Renders only
          when (a) shiftDate is tomorrow (the optimizer writes for
          tomorrow only), AND (b) optimizer has produced a row for this
          property. Fail closed: if the optimizer cron hasn't run yet
          (brand-new property), the panel is hidden — operator falls
          back to the existing PMS strip + crew rows below.

          Phase 1.4 (2026-05-22): label branches on modelKind. Only
          fitted-from-this-hotel recommendations are labeled "AI
          recommendation" — cold-start / capacity-unavailable rows
          show "Industry estimate · learning". The synthetic p80/p95
          confidence band is hidden when not fitted (multiplier-derived
          bands carry no per-hotel signal). */}
      {isTomorrow && optimizerPanel && (() => {
        const isFitted = optimizerPanel.modelKind === 'fitted';
        const headlineLabel = isFitted
          ? (lang === 'es' ? 'Recomendación de IA' : 'AI recommendation')
          : (lang === 'es' ? 'Estimación del sector · aprendiendo' : 'Industry estimate · learning');
        const kindTooltip = isFitted
          ? (optimizerPanel.completionProbabilityCurve.length > 0
              ? optimizerPanel.completionProbabilityCurve
                  .map((r) => `${r.headcount} HKs → ${Math.round(r.p * 100)}% finish`)
                  .join('\n')
              : (lang === 'es' ? 'Recomendación basada en demanda + capacidad estimada.' : 'Recommendation based on predicted demand + crew capacity.'))
          : optimizerPanel.modelKind === 'capacity-unavailable'
            ? (lang === 'es'
                ? 'El modelo por habitación aún no está activo. Recomendación basada en demanda agregada.'
                : 'Per-room model is not yet active. Recommendation is based on aggregate workload only.')
            : (lang === 'es'
                ? 'Basado en datos de hoteles similares. Mejorará con el historial de tu hotel.'
                : "Based on industry benchmark for hotels of your size. Will sharpen as your hotel's cleaning history accumulates.");
        return (
          <div
            title={kindTooltip}
            style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
              padding: '14px 22px', marginBottom: 10,
              display: 'flex', alignItems: 'center', gap: 28, flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 160 }}>
              <Caps size={9}>{lang === 'es' ? 'Confianza para mañana' : "Tomorrow's confidence"}</Caps>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, marginTop: 2 }}>
                {headlineLabel}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
              <Caps size={9}>{lang === 'es' ? 'Recomendado' : 'Recommended'}</Caps>
              <span style={{ fontFamily: FONT_SERIF, fontSize: 28, color: T.ink, lineHeight: 1.1 }}>
                {optimizerPanel.recommendedHeadcount}
                <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, marginLeft: 4 }}>
                  {lang === 'es' ? 'HK' : 'HKs'}
                </span>
              </span>
            </div>
            {/* P80/P95 bands are only shown when the model is fitted; for
                cold-start / capacity-unavailable, the bands are derived from
                synthetic multipliers (mu × [0.5, 0.7, …, 1.8]) and have no
                per-hotel signal. Hiding them keeps the tile honest. */}
            {isFitted && demandPanel && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
                  <Caps size={9}>P80</Caps>
                  <span style={{ fontFamily: FONT_SERIF, fontSize: 22, color: T.ink2, lineHeight: 1.1 }}>
                    {demandPanel.predictedHeadcountP80}
                    <span style={{ fontFamily: FONT_SANS, fontSize: 11, color: T.ink3, marginLeft: 4 }}>
                      {lang === 'es' ? 'HK' : 'HKs'}
                    </span>
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
                  <Caps size={9}>P95</Caps>
                  <span style={{ fontFamily: FONT_SERIF, fontSize: 22, color: T.ink2, lineHeight: 1.1 }}>
                    {demandPanel.predictedHeadcountP95}
                    <span style={{ fontFamily: FONT_SANS, fontSize: 11, color: T.ink3, marginLeft: 4 }}>
                      {lang === 'es' ? 'HK' : 'HKs'}
                    </span>
                  </span>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* VIEW TOGGLE — Kanban / Timeline / Forecast. Only the chosen
          view renders; the unselected sub-views unmount entirely so
          they don't keep their subscriptions live in the background.
          Defaults to Kanban (the historical primary view). */}
      {pid && (
        <div style={{
          marginTop: 24, marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        }}>
          <Caps>{lang === 'es' ? 'Vista' : 'View'}</Caps>
          <div role="tablist" aria-label={lang === 'es' ? 'Vista del horario' : 'Schedule view'}
            style={{ display: 'inline-flex', gap: 4, marginLeft: 6 }}>
            <Btn variant={scheduleView === 'kanban'   ? 'paper' : 'ghost'} size="sm" onClick={() => setScheduleView('kanban')}>
              {lang === 'es' ? 'Kanban' : 'Kanban'}
            </Btn>
            <Btn variant={scheduleView === 'timeline' ? 'paper' : 'ghost'} size="sm" onClick={() => setScheduleView('timeline')}>
              {lang === 'es' ? 'Línea de tiempo' : 'Timeline'}
            </Btn>
            <Btn variant={scheduleView === 'forecast' ? 'paper' : 'ghost'} size="sm" onClick={() => setScheduleView('forecast')}>
              {lang === 'es' ? 'Pronóstico' : 'Forecast'}
            </Btn>
          </div>
        </div>
      )}

      {/* AUTO-ASSIGN BOARD — new cleaning_tasks + hk_assignments system.
          Renders below the existing legacy schedule. Only shows when there's
          a property + date in context, so the rest of the tab works the same
          when the manager hasn't selected a property yet. */}
      {pid && scheduleView === 'kanban' && (
        <div style={{ marginTop: 12 }}>
          <AutoAssignBoard
            propertyId={pid}
            shiftDate={shiftDate}
            shiftMinutes={SHIFT_MINS}
            lang={lang}
          />
        </div>
      )}

      {/* TIMELINE VIEW — horizontal time-axis strip beneath the board.
          Board = place work; timeline = watch it unfold. */}
      {pid && scheduleView === 'timeline' && (
        <div style={{ marginTop: 12 }}>
          <TimelineView propertyId={pid} shiftDate={shiftDate} lang={lang} />
        </div>
      )}

      {/* FORECAST VIEW — forward-looking demand vs supply across
          today / 7-day / 14-day ranges. Lets the GM spot understaffed
          days early enough to adjust schedules. */}
      {pid && scheduleView === 'forecast' && (
        <div style={{ marginTop: 12 }}>
          <ForecastView propertyId={pid} lang={lang} />
        </div>
      )}

      {/* TOAST */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 70, padding: '12px 18px',
          background: T.sageDim, color: T.sageDeep,
          border: '1px solid rgba(104,131,114,0.3)',
          borderRadius: 999, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
        }}>{toast}</div>
      )}

      {/* PREDICTION SETTINGS MODAL — Maria's per-property cleaning-time
          knobs. Saves directly to the property record; auto-assign and
          the per-HK capacity bars both read these fields, so changes
          propagate the moment refreshProperty() finishes. Triggered by
          the gear next to "Latest PMS pull" in the strip above. */}
      {showSettings && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => { if (!settingsSaving) setShowSettings(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
              padding: '20px 24px', maxWidth: 480, width: '100%',
              maxHeight: '85vh', overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.20)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h2 style={{ fontFamily: FONT_SERIF, fontSize: 24, margin: 0, color: T.ink, fontWeight: 400 }}>
                <span style={{ fontStyle: 'italic' }}>{lang === 'es' ? 'Ajustes de Predicción' : 'Cleaning-time Settings'}</span>
              </h2>
              <button
                onClick={() => setShowSettings(false)}
                disabled={settingsSaving}
                style={{
                  background: 'transparent', border: 'none', cursor: settingsSaving ? 'default' : 'pointer',
                  fontSize: 20, color: T.ink3, padding: '0 6px',
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '0 0 14px' }}>
              {lang === 'es'
                ? 'Estos minutos definen cuánto tarda cada tipo de limpieza. Auto-asignar y las barras de capacidad usan estos valores.'
                : 'How long each clean takes, by type. Auto-assign and the per-housekeeper capacity bars both read these values.'}
            </p>
            {/* 4 minute fields + 1 hour-cap field. shiftMinutes is shown
                in hours for sanity, converted to minutes on save. */}
            {([
              { key: 'checkoutMinutes',        label: lang === 'es' ? 'Salida (limpieza completa)'  : 'Checkout (full clean)',      unit: 'min', step: 1,    min: 1,   max: 240 },
              { key: 'stayoverDay1Minutes',    label: lang === 'es' ? 'Estadía día 1 (ligera)'      : 'Stayover Day 1 (light)',      unit: 'min', step: 1,    min: 1,   max: 240 },
              { key: 'stayoverDay2Minutes',    label: lang === 'es' ? 'Estadía día 2+ (completa)'   : 'Stayover Day 2+ (full)',      unit: 'min', step: 1,    min: 1,   max: 240 },
              { key: 'prepMinutesPerActivity', label: lang === 'es' ? 'Preparación entre cuartos'   : 'Prep between rooms',          unit: 'min', step: 1,    min: 0,   max: 60  },
              { key: 'shiftMinutes',           label: lang === 'es' ? 'Turno máximo por persona'    : 'Max shift hours per person',   unit: 'h',   step: 0.25, min: 1,   max: 24, asHours: true },
            ] as Array<{ key: keyof typeof settingsForm; label: string; unit: string; step: number; min: number; max: number; asHours?: boolean }>).map(f => {
              const raw = settingsForm[f.key];
              const display = f.asHours ? raw / 60 : raw;
              return (
                <div key={f.key} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 0', borderTop: `1px solid ${T.rule}`, gap: 12,
                }}>
                  <label htmlFor={`pred-${f.key}`} style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, flex: 1 }}>
                    {f.label}
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      id={`pred-${f.key}`}
                      type="number"
                      step={f.step}
                      min={f.min}
                      max={f.max}
                      value={display}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isNaN(n)) return;
                        setSettingsForm(prev => ({
                          ...prev,
                          [f.key]: f.asHours ? Math.round(n * 60) : Math.round(n),
                        }));
                      }}
                      style={{
                        width: 70, padding: '6px 8px', borderRadius: 8,
                        border: `1px solid ${T.rule}`, background: T.bg,
                        fontFamily: FONT_MONO, fontSize: 13, color: T.ink, textAlign: 'right',
                      }}
                    />
                    <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, minWidth: 24 }}>{f.unit}</span>
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <Btn variant="ghost" size="sm" onClick={() => setShowSettings(false)} disabled={settingsSaving}>
                {lang === 'es' ? 'Cancelar' : 'Cancel'}
              </Btn>
              <Btn
                variant="primary"
                size="sm"
                disabled={settingsSaving || !uid || !pid}
                onClick={async () => {
                  if (!uid || !pid) return;
                  setSettingsSaving(true);
                  try {
                    await updateProperty(uid, pid, {
                      checkoutMinutes:        settingsForm.checkoutMinutes,
                      stayoverDay1Minutes:    settingsForm.stayoverDay1Minutes,
                      stayoverDay2Minutes:    settingsForm.stayoverDay2Minutes,
                      // Mirror Day 2 to the legacy stayoverMinutes field
                      // so older callers (DND/over-time fallbacks) still
                      // get a sensible value.
                      stayoverMinutes:        settingsForm.stayoverDay2Minutes,
                      prepMinutesPerActivity: settingsForm.prepMinutesPerActivity,
                      shiftMinutes:           settingsForm.shiftMinutes,
                    });
                    await refreshProperty();
                    flashToast(lang === 'es' ? 'Ajustes guardados' : 'Settings saved');
                    setShowSettings(false);
                  } catch (err) {
                    console.error('[Schedule] settings save failed:', err);
                    flashToast(lang === 'es' ? 'Error al guardar' : 'Save failed');
                  } finally {
                    setSettingsSaving(false);
                  }
                }}
              >
                {settingsSaving
                  ? (lang === 'es' ? 'Guardando…' : 'Saving…')
                  : (lang === 'es' ? 'Guardar' : 'Save')}
              </Btn>
            </div>
          </div>
        </div>,
        document.body,
      )}

    </div>
  );
}
