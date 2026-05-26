'use client';

// Third view on the Schedule tab. Renders forward-looking demand vs
// supply across today / next 7 days / next 14 days. The GM uses this
// to spot understaffed days 2 weeks out, before the day-of fire drill.
//
// Layout:
//   [ range selector ]
//   [ summary banner ]
//   [ stacked day cards — click to expand drill-down ]
//
// Range + (when used) drill-down state persist to localStorage so a
// page refresh lands the manager back where they were.

import React, { useEffect, useMemo, useState } from 'react';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Btn } from './_snow';
import { fetchWithAuth } from '@/lib/api-fetch';
import { captureException } from '@/lib/sentry';
import { ForecastSummaryBanner, type ForecastSummary } from './ForecastSummaryBanner';
import { ForecastDayCard, type DayCardData } from './ForecastDayCard';
import { ForecastDayDrilldown } from './ForecastDayDrilldown';
import type { AccuracyLabel, ForecastRange, GapStatus } from '@/lib/forecast';

interface ForecastPayload {
  range: ForecastRange;
  timezone: string;
  today: string;
  history_days: number | null;
  history_threshold_days: number;
  shift_minutes: number;
  wage_pending_roster: boolean;
  summary: {
    total_minutes_needed: number;
    total_hours_scheduled: number;
    gap_hours: number;
    understaffed_day_count: number;
  };
  days: Array<{
    date: string;
    departures: number;
    stayovers_light: number;
    stayovers_full: number;
    deep_cleans: number;
    total_minutes_needed: number;
    housekeepers_scheduled: number;
    housekeepers_recommended: number;
    projected_labor_cents: number;
    wage_pending: boolean;
    gap_status: GapStatus;
    accuracy_label: AccuracyLabel;
  }>;
}

interface Props {
  propertyId: string;
  lang: 'en' | 'es';
}

const RANGE_STORAGE_KEY = 'staxis.forecast.range';
const ALLOWED_RANGES: ForecastRange[] = ['today', 'week', '14day'];

export function ForecastView({ propertyId, lang }: Props) {
  // Range selector — restored from localStorage on mount, persisted on
  // every change. Defaults to "14day" because that's the most
  // actionable view (gives the GM lead time to adjust schedules).
  const [range, setRange] = useState<ForecastRange>('14day');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(RANGE_STORAGE_KEY);
      if (stored && (ALLOWED_RANGES as string[]).includes(stored)) {
        setRange(stored as ForecastRange);
      }
    } catch {
      // localStorage can throw in private-browsing modes — fine to ignore.
    }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(RANGE_STORAGE_KEY, range); } catch { /* ignore */ }
  }, [range]);

  // Expanded day — collapsed by default each time the tab is opened.
  // Deliberately NOT persisted so the manager always starts with a
  // clean overview rather than someone else's last-viewed day.
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  // Reset expansion when range changes — a card collapsed in 14-day
  // view shouldn't be hidden if the user switches to today view and
  // back. Each range switch is a fresh slate.
  useEffect(() => { setExpandedDate(null); }, [range]);

  const [payload, setPayload] = useState<ForecastPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/housekeeping/forecast?propertyId=${encodeURIComponent(propertyId)}&range=${encodeURIComponent(range)}`,
        );
        const body = (await res.json().catch(() => null)) as
          | { ok: true; data: ForecastPayload }
          | { ok: false; error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !body || body.ok === false) {
          // 429 retry: surface the standard rate-limited copy rather
          // than the raw "rate_limited" code, so a manager who clicks
          // ranges quickly sees plain English.
          if (res.status === 429) {
            setErrMsg(lang === 'es'
              ? 'Demasiadas solicitudes. Espera un momento.'
              : 'Too many requests — wait a moment, then try again.');
          } else {
            setErrMsg(
              body && 'error' in body
                ? body.error ?? `HTTP ${res.status}`
                : `HTTP ${res.status}`,
            );
          }
          setPayload(null);
        } else {
          setPayload(body.data);
        }
      } catch (e) {
        if (cancelled) return;
        captureException(e, { route: 'housekeeping/forecast', propertyId, range });
        setErrMsg(lang === 'es' ? 'Error al cargar el pronóstico' : 'Failed to load forecast');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [propertyId, range, lang]);

  const summary: ForecastSummary | null = useMemo(() => {
    if (!payload) return null;
    return {
      totalHoursNeeded: round1(payload.summary.total_minutes_needed / 60),
      totalHoursScheduled: payload.summary.total_hours_scheduled,
      gapHours: payload.summary.gap_hours,
      understaffedDayCount: payload.summary.understaffed_day_count,
      rangeDayCount: payload.days.length,
    };
  }, [payload]);

  const dayCards: DayCardData[] = useMemo(() => {
    if (!payload) return [];
    return payload.days.map(d => ({
      date: d.date,
      departures: d.departures,
      stayoversLight: d.stayovers_light,
      stayoversFull: d.stayovers_full,
      deepCleans: d.deep_cleans,
      totalMinutesNeeded: d.total_minutes_needed,
      housekeepersScheduled: d.housekeepers_scheduled,
      housekeepersRecommended: d.housekeepers_recommended,
      projectedLaborCents: d.projected_labor_cents,
      wagePending: d.wage_pending,
      gapStatus: d.gap_status,
      accuracyLabel: d.accuracy_label,
    }));
  }, [payload]);

  return (
    <div style={{ marginTop: 24 }}>
      {/* Section header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        gap: 16, marginBottom: 14, flexWrap: 'wrap',
      }}>
        <div>
          <Caps>{lang === 'es' ? 'Pronóstico' : 'Forecast'}</Caps>
          <h2 style={{
            fontFamily: FONT_SERIF, fontSize: 28, margin: '4px 0 0',
            letterSpacing: '-0.02em', lineHeight: 1.2, fontWeight: 400, color: T.ink,
          }}>
            <span style={{ fontStyle: 'italic' }}>
              {lang === 'es' ? 'Demanda vs. capacidad' : 'Demand vs. capacity'}
            </span>
          </h2>
        </div>
        <RangePicker range={range} onChange={setRange} lang={lang} />
      </div>

      {/* History calibration line — honest about why labels read the way they do. */}
      {payload && (
        <p style={{
          fontFamily: FONT_MONO, fontSize: 11, color: T.ink3,
          margin: '0 0 12px',
        }}>
          {historyBlurb(payload, lang)}
        </p>
      )}

      {loading && (
        <p style={{
          fontFamily: FONT_MONO, fontSize: 12, color: T.ink3,
          padding: '12px 0',
        }}>
          {lang === 'es' ? 'Cargando pronóstico…' : 'Loading forecast…'}
        </p>
      )}

      {errMsg && (
        <p style={{
          fontFamily: FONT_SANS, fontSize: 13, color: T.warm,
          padding: '12px 18px', background: T.warmDim,
          border: `1px solid ${T.warm}`, borderRadius: 10,
        }}>
          {errMsg}
        </p>
      )}

      {summary && <ForecastSummaryBanner summary={summary} lang={lang} />}

      {/* Day cards — stacked single-column for scanability */}
      {!loading && !errMsg && payload && dayCards.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {dayCards.map(card => (
            <div key={card.date}>
              <ForecastDayCard
                data={card}
                isExpanded={expandedDate === card.date}
                onToggle={() => setExpandedDate(prev => (prev === card.date ? null : card.date))}
                lang={lang}
              />
              {expandedDate === card.date && (
                <ForecastDayDrilldown
                  propertyId={propertyId}
                  date={card.date}
                  lang={lang}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && !errMsg && payload && dayCards.length === 0 && (
        <p style={{
          fontFamily: FONT_SANS, fontSize: 13, color: T.ink3, fontStyle: 'italic',
        }}>
          {lang === 'es' ? 'No hay días en el rango seleccionado.' : 'No days in the selected range.'}
        </p>
      )}
    </div>
  );
}

function RangePicker({
  range, onChange, lang,
}: {
  range: ForecastRange;
  onChange: (r: ForecastRange) => void;
  lang: 'en' | 'es';
}) {
  const opts: Array<{ key: ForecastRange; label: string }> = [
    { key: 'today',  label: lang === 'es' ? 'Hoy'         : 'Today' },
    { key: 'week',   label: lang === 'es' ? '7 días'      : '7 days' },
    { key: '14day',  label: lang === 'es' ? '14 días'     : '14 days' },
  ];
  return (
    <div role="tablist" aria-label={lang === 'es' ? 'Rango del pronóstico' : 'Forecast range'}
      style={{ display: 'inline-flex', gap: 4 }}>
      {opts.map(o => (
        <Btn
          key={o.key}
          variant={range === o.key ? 'paper' : 'ghost'}
          size="sm"
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </Btn>
      ))}
    </div>
  );
}

function historyBlurb(p: ForecastPayload, lang: 'en' | 'es'): string {
  if (p.history_days === null) {
    return lang === 'es'
      ? 'Sin historial de limpiezas. Pronóstico basado en estimaciones del sector.'
      : 'No cleaning history yet — forecast uses industry benchmarks.';
  }
  if (p.history_days < p.history_threshold_days) {
    return lang === 'es'
      ? `${p.history_days} días de historial · pronóstico aprende del tu hotel (>${p.history_threshold_days} días para “predicción IA”).`
      : `${p.history_days} days of cleaning history · forecast is learning from your hotel (>${p.history_threshold_days} days unlocks "AI prediction").`;
  }
  return lang === 'es'
    ? `${p.history_days} días de historial · pronóstico calibrado con tu hotel.`
    : `${p.history_days} days of cleaning history · forecast is calibrated to your hotel.`;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
