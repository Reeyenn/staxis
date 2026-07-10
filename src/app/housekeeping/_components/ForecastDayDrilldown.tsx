'use client';

// Inline drill-down rendered under a ForecastDayCard when expanded.
// Three panes:
//   • Hour-by-hour arrival / departure curve (5am–10pm)
//   • Reservations driving the day (arrival, departure, in-house)
//   • Housekeepers scheduled for the day
//
// Fetches via /api/housekeeping/forecast/day on mount; shows a
// lightweight loading state, surfaces auth-style errors verbatim, and
// is keyboard-dismissible (Esc) via the parent.

import React, { useEffect, useState } from 'react';
import { T, FONT_SANS, FONT_MONO, Caps, Pill } from './_snow';
import { fetchWithAuth } from '@/lib/api-fetch';
import { captureException } from '@/lib/sentry';

interface HourlyBucket {
  hour: number;
  arrivals: number;
  departures: number;
  unknown_arrivals: number;
  unknown_departures: number;
}

interface ReservationItem {
  kind: 'arrival' | 'departure' | 'in_house';
  pms_reservation_id: string;
  guest_name: string | null;
  room_number: string | null;
  room_type: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  notes: string | null;
}

interface HousekeeperItem {
  id: string;
  name: string;
  language: string | null;
  start_time: string;
  end_time: string;
}

interface DrilldownPayload {
  date: string;
  hourly: HourlyBucket[];
  unknown_time_totals: {
    arrivals: number;
    departures: number;
  };
  reservations: ReservationItem[];
  housekeepers: HousekeeperItem[];
}

interface Props {
  propertyId: string;
  date: string;
  lang: 'en' | 'es';
}

export function ForecastDayDrilldown({ propertyId, date, lang }: Props) {
  const [payload, setPayload] = useState<DrilldownPayload | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    setPayload(null);
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/housekeeping/forecast/day?propertyId=${encodeURIComponent(propertyId)}&date=${encodeURIComponent(date)}`,
        );
        const body = (await res.json().catch(() => null)) as
          | { ok: true; data: DrilldownPayload }
          | { ok: false; error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !body || body.ok === false) {
          setErrMsg(body && 'error' in body ? body.error ?? `HTTP ${res.status}` : `HTTP ${res.status}`);
          setPayload(null);
        } else {
          setPayload(body.data);
        }
      } catch (e) {
        if (cancelled) return;
        captureException(e, { route: 'housekeeping/forecast-drilldown', propertyId, date });
        setErrMsg(lang === 'es' ? 'Error al cargar detalles' : 'Failed to load details');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [propertyId, date, lang]);

  return (
    <div style={{
      marginTop: 8,
      padding: '18px 22px',
      background: T.bg,
      border: `1px solid ${T.rule}`,
      borderRadius: 14,
      display: 'grid',
      gridTemplateColumns: 'minmax(280px, 1fr) minmax(280px, 1fr)',
      gap: 24,
    }}>
      {loading && (
        <span style={{
          gridColumn: '1 / -1', fontFamily: FONT_MONO, fontSize: 12, color: T.ink3,
        }}>
          {lang === 'es' ? 'Cargando detalles…' : 'Loading details…'}
        </span>
      )}
      {errMsg && (
        <span style={{
          gridColumn: '1 / -1', fontFamily: FONT_SANS, fontSize: 13, color: T.warm,
        }}>
          {errMsg}
        </span>
      )}
      {payload && (
        <>
          <HourCurve
            hourly={payload.hourly}
            unknown={payload.unknown_time_totals}
            lang={lang}
          />
          <Housekeepers list={payload.housekeepers} lang={lang} />
          <Reservations list={payload.reservations} lang={lang} />
        </>
      )}
    </div>
  );
}

function HourCurve({
  hourly, unknown, lang,
}: {
  hourly: HourlyBucket[];
  unknown: { arrivals: number; departures: number };
  lang: 'en' | 'es';
}) {
  // Max bar height in each cell. Use the larger of arrivals/departures
  // across the day so the bars are comparable across the chart.
  const max = Math.max(1, ...hourly.flatMap(h => [h.arrivals, h.departures]));
  const hasSynthetic = unknown.arrivals > 0 || unknown.departures > 0;
  return (
    <div style={{ gridColumn: '1 / 2' }}>
      <Caps>{lang === 'es' ? 'Carga por hora' : 'Hourly workload'}</Caps>
      <div style={{
        marginTop: 10,
        display: 'grid',
        gridTemplateColumns: `repeat(${hourly.length}, minmax(0, 1fr))`,
        alignItems: 'end',
        gap: 4,
        height: 96,
      }}>
        {hourly.map(h => (
          <div key={h.hour} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            height: '100%', justifyContent: 'flex-end',
          }}>
            <div style={{ display: 'flex', gap: 1, alignItems: 'end', height: 70 }}>
              <Bar
                value={h.arrivals}
                synthetic={h.unknown_arrivals}
                max={max}
                color={T.sageDeep}
              />
              <Bar
                value={h.departures}
                synthetic={h.unknown_departures}
                max={max}
                color={T.caramelDeep}
              />
            </div>
            <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: T.ink3 }}>{formatHour(h.hour)}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
        <LegendDot color={T.sageDeep} label={lang === 'es' ? 'Llegadas' : 'Arrivals'} />
        <LegendDot color={T.caramelDeep} label={lang === 'es' ? 'Salidas' : 'Departures'} />
        {hasSynthetic && (
          <span style={{
            fontFamily: FONT_MONO, fontSize: 10, color: T.ink3,
          }}>
            {lang === 'es'
              ? `Incluye ${unknown.arrivals + unknown.departures} reservas sin hora registrada (asignadas a horarios típicos).`
              : `Includes ${unknown.arrivals + unknown.departures} reservation${unknown.arrivals + unknown.departures === 1 ? '' : 's'} with no recorded time (placed at typical check-in/out hours).`}
          </span>
        )}
      </div>
    </div>
  );
}

function Bar({
  value, synthetic, max, color,
}: {
  value: number;
  synthetic: number;
  max: number;
  color: string;
}) {
  const h = Math.round((value / max) * 70);
  const knownShare = value === 0 ? 0 : (value - synthetic) / value;
  const fillH = Math.round(h * knownShare);
  const ghostH = Math.max(value > 0 ? 2 : 0, h) - fillH;
  // The "known" portion of the bar is solid; the "synthetic-time"
  // portion stacks above it with a striped fill so a busy 3pm with
  // mostly missing-time rows reads visually different from a busy
  // 3pm with real check-ins.
  return (
    <span
      aria-label={
        synthetic > 0
          ? `${value} (${synthetic} placed by default)`
          : String(value)
      }
      title={
        synthetic > 0
          ? `${value} (${synthetic} placed by default)`
          : String(value)
      }
      style={{
        width: 6, height: Math.max(value > 0 ? 2 : 0, h),
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
        background: value > 0 ? 'transparent' : 'transparent',
        borderRadius: 2,
        overflow: 'hidden',
        transition: 'height 120ms ease',
      }}
    >
      {ghostH > 0 && (
        <span
          aria-hidden="true"
          style={{
            width: '100%', height: ghostH,
            backgroundImage: `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 4px)`,
            opacity: 0.55,
          }}
        />
      )}
      {fillH > 0 && (
        <span aria-hidden="true" style={{ width: '100%', height: fillH, background: color }} />
      )}
    </span>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontFamily: FONT_MONO, fontSize: 11, color: T.ink2,
    }}>
      <span aria-hidden="true" style={{
        width: 8, height: 8, borderRadius: '50%', background: color,
      }} />
      {label}
    </span>
  );
}

function Housekeepers({ list, lang }: { list: HousekeeperItem[]; lang: 'en' | 'es' }) {
  return (
    <div style={{ gridColumn: '2 / 3' }}>
      <Caps>{lang === 'es' ? 'Personal programado' : 'Housekeepers scheduled'}</Caps>
      {list.length === 0 ? (
        <p style={{
          marginTop: 10, fontFamily: FONT_SANS, fontSize: 13, color: T.warm,
        }}>
          {lang === 'es' ? 'Nadie programado todavía.' : 'No one scheduled yet.'}
        </p>
      ) : (
        <ul style={{
          marginTop: 10, padding: 0, listStyle: 'none',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {list.map(h => (
            <li key={h.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 10px', background: T.paper,
              border: `1px solid ${T.rule}`, borderRadius: 10,
              fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
            }}>
              <span>{h.name}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>
                {h.start_time.slice(0, 5)}–{h.end_time.slice(0, 5)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Reservations({ list, lang }: { list: ReservationItem[]; lang: 'en' | 'es' }) {
  if (list.length === 0) {
    return (
      <div style={{ gridColumn: '1 / -1' }}>
        <Caps>{lang === 'es' ? 'Reservas del día' : "Day's reservations"}</Caps>
        <p style={{
          marginTop: 10, fontFamily: FONT_SANS, fontSize: 13, color: T.ink3,
        }}>
          {lang === 'es' ? 'Sin reservas registradas.' : 'No reservations on file.'}
        </p>
      </div>
    );
  }
  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <Caps>{lang === 'es' ? 'Reservas del día' : "Day's reservations"}</Caps>
      <ul style={{
        marginTop: 10, padding: 0, listStyle: 'none',
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8,
      }}>
        {list.map(r => (
          <li key={r.pms_reservation_id} style={{
            padding: '8px 10px', background: T.paper,
            border: `1px solid ${T.rule}`, borderRadius: 10,
            display: 'flex', flexDirection: 'column', gap: 3,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>
                {r.guest_name || (lang === 'es' ? '(sin nombre)' : '(no name)')}
              </span>
              <KindPill kind={r.kind} lang={lang} />
            </div>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>
              {(r.room_number ?? '—')} · {r.room_type ?? (lang === 'es' ? 'tipo desconocido' : 'unknown type')}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
              {formatTimeBlurb(r, lang)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function KindPill({ kind, lang }: { kind: ReservationItem['kind']; lang: 'en' | 'es' }) {
  if (kind === 'arrival') {
    return <Pill tone="sage">{lang === 'es' ? 'Llega' : 'Arriving'}</Pill>;
  }
  if (kind === 'departure') {
    return <Pill tone="caramel">{lang === 'es' ? 'Sale' : 'Departing'}</Pill>;
  }
  return <Pill tone="neutral">{lang === 'es' ? 'En casa' : 'In-house'}</Pill>;
}

function formatTimeBlurb(r: ReservationItem, lang: 'en' | 'es'): string {
  if (r.kind === 'arrival') {
    const t = (r.arrival_time ?? '').slice(0, 5);
    return t
      ? `${lang === 'es' ? 'Llegada' : 'ETA'} ${t}`
      : (lang === 'es' ? 'Hora de llegada desconocida' : 'ETA unknown');
  }
  if (r.kind === 'departure') {
    const t = (r.departure_time ?? '').slice(0, 5);
    return t
      ? `${lang === 'es' ? 'Salida' : 'Check-out'} ${t}`
      : (lang === 'es' ? 'Hora de salida desconocida' : 'Check-out unknown');
  }
  return `${r.arrival_date ?? '?'} → ${r.departure_date ?? '?'}`;
}

function formatHour(h: number): string {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}
