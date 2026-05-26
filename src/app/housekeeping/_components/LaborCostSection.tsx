'use client';

/**
 * Labor cost section on the Performance tab. Owner/GM/admin only.
 *
 * Renders the "this week vs last week" comparison plus a per-housekeeper
 * trendline of daily labor cost across the current ISO week.
 *
 * Data: /api/housekeeping/labor-cost-range. One pull for the 14-day
 * window (this week + prior). Cheap because the route batches all
 * source pulls server-side; the per-day aggregation happens once in JS.
 */

import React, { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Pill, HousekeeperDot,
} from './_snow';

type Lang = 'en' | 'es';

interface RangeDailyCost {
  date: string;
  totalCents: number;
  perHousekeeper: Array<{ staffId: string; name: string; cents: number; billableMinutes: number; wageUnknown: boolean }>;
  anyWageUnknown: boolean;
}

interface RangePerStaffTotal {
  staffId: string;
  name: string;
  totalCents: number;
  perDay: Array<{ date: string; cents: number }>;
}

interface RangePayload {
  fromDate: string;
  toDate: string;
  days: RangeDailyCost[];
  perStaffTotal: RangePerStaffTotal[];
  totalCents: number;
  anyWageUnknown: boolean;
}

function fmtCents(cents: number, lang: Lang): string {
  const dollars = Math.round(cents / 100);
  return new Intl.NumberFormat(lang === 'es' ? 'es-US' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(dollars);
}

/**
 * Return the ISO Monday of the week containing `dateStr`. Format: YYYY-MM-DD.
 * Matches the same anchor the daily/weekly cron uses for the Sunday
 * weekly report (Mon-Sun ISO week).
 */
function isoMondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;     // Mon=1, Sun=7
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function LaborCostSection({
  propertyId, today, lang,
}: {
  propertyId: string | null;
  today: string;
  lang: Lang;
}) {
  const [data, setData] = useState<RangePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const thisMonday = isoMondayOf(today);
  const lastMonday = addDaysUtc(thisMonday, -7);
  const thisSunday = addDaysUtc(thisMonday, 6);
  const fromDate = lastMonday;
  const toDate = thisSunday;

  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    fetchWithAuth(`/api/housekeeping/labor-cost-range?propertyId=${encodeURIComponent(propertyId)}&fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`)
      .then(r => r.json())
      .then((body: { ok?: boolean; data?: RangePayload; error?: string }) => {
        if (cancelled) return;
        if (!body.ok || !body.data) {
          setErrorMsg(body.error ?? 'Could not load labor cost');
          setData(null);
          return;
        }
        setData(body.data);
      })
      .catch(err => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : 'Network error');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [propertyId, fromDate, toDate]);

  if (!propertyId) return null;
  if (loading && !data) {
    return (
      <Card>
        <Caps>{lang === 'es' ? 'Costo laboral' : 'Labor cost'}</Caps>
        <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: '12px 0 0' }}>
          {lang === 'es' ? 'Cargando…' : 'Loading…'}
        </p>
      </Card>
    );
  }
  if (errorMsg || !data) {
    return (
      <Card>
        <Caps>{lang === 'es' ? 'Costo laboral' : 'Labor cost'}</Caps>
        <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.red, margin: '12px 0 0' }}>
          {errorMsg ?? (lang === 'es' ? 'No disponible' : 'Unavailable')}
        </p>
      </Card>
    );
  }

  // Split days into prior week (Mon-Sun of lastMonday) and this week.
  const priorWeekTotal = data.days
    .filter(d => d.date >= lastMonday && d.date < thisMonday)
    .reduce((s, d) => s + d.totalCents, 0);
  const thisWeekTotal = data.days
    .filter(d => d.date >= thisMonday && d.date <= thisSunday)
    .reduce((s, d) => s + d.totalCents, 0);
  const deltaCents = thisWeekTotal - priorWeekTotal;
  const deltaPct = priorWeekTotal > 0
    ? Math.round((deltaCents / priorWeekTotal) * 100)
    : null;

  // Trendline: 14 daily totals, ordered chronologically. Render as a
  // tiny SVG sparkline so a brand-new tab doesn't ship a charting lib.
  const dailyTotals = data.days
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => d.totalCents);

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
        <Caps>{lang === 'es' ? 'Costo laboral' : 'Labor cost'}</Caps>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.04em' }}>
          {lang === 'es' ? 'SEMANA · LUN A DOM' : 'WEEK · MON–SUN'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 18 }}>
        <KpiCell
          label={lang === 'es' ? 'Esta semana' : 'This week'}
          big={fmtCents(thisWeekTotal, lang)}
          accent={T.sageDeep}
        />
        <KpiCell
          label={lang === 'es' ? 'Semana pasada' : 'Last week'}
          big={fmtCents(priorWeekTotal, lang)}
          accent={T.ink2}
        />
        <KpiCell
          label={lang === 'es' ? 'Cambio' : 'Change'}
          big={deltaCents === 0
            ? '—'
            : `${deltaCents > 0 ? '+' : '−'}${fmtCents(Math.abs(deltaCents), lang)}`}
          sub={deltaPct !== null ? `${deltaPct > 0 ? '+' : ''}${deltaPct}%` : ''}
          accent={deltaCents > 0 ? T.warm : T.sageDeep}
        />
      </div>

      {dailyTotals.length > 0 && (
        <Sparkline values={dailyTotals} lang={lang} />
      )}

      {data.perStaffTotal.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <Caps>{lang === 'es' ? 'Por limpiadora · 14 días' : 'Per housekeeper · 14 days'}</Caps>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            {data.perStaffTotal.slice(0, 8).map(s => (
              <div key={s.staffId} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px',
                background: T.bg,
                border: `1px solid ${T.ruleSoft}`, borderRadius: 10,
              }}>
                <HousekeeperDot staff={{ id: s.staffId, name: s.name }} size={22} />
                <span style={{
                  flex: 1, fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{s.name}</span>
                <span style={{
                  fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 18,
                  color: T.ink, letterSpacing: '-0.02em',
                }}>{fmtCents(s.totalCents, lang)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.anyWageUnknown && (
        <div style={{ marginTop: 12 }}>
          <Pill tone="caramel">
            {lang === 'es'
              ? 'Algunos limpiadores no tienen salario configurado'
              : 'Some housekeepers have no wage set'}
          </Pill>
        </div>
      )}
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
      padding: '18px 24px',
    }}>{children}</div>
  );
}

function KpiCell({
  label, big, sub, accent,
}: {
  label: string;
  big: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div style={{
      background: T.bg, border: `1px solid ${T.ruleSoft}`, borderRadius: 14,
      padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Caps size={9}>{label}</Caps>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent }} />
      </div>
      <span style={{
        fontFamily: FONT_SERIF, fontSize: 26, color: T.ink, fontStyle: 'italic',
        letterSpacing: '-0.03em', lineHeight: 1,
      }}>{big}</span>
      {sub && (
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>{sub}</span>
      )}
    </div>
  );
}

function Sparkline({ values, lang }: { values: number[]; lang: Lang }) {
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const width = 320;
  const height = 60;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = max === min ? height / 2 : height - ((v - min) / (max - min)) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        aria-label={lang === 'es' ? 'Tendencia diaria de costo' : 'Daily cost trend'}
        role="img"
      >
        <polyline
          points={points}
          fill="none"
          stroke={T.sageDeep}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, marginTop: 4, letterSpacing: '0.04em',
      }}>
        <span>{lang === 'es' ? '14 DÍAS' : '14 DAYS'}</span>
        <span>{lang === 'es' ? 'HOY' : 'TODAY'}</span>
      </div>
    </div>
  );
}
