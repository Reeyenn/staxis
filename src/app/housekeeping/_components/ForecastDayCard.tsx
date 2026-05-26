'use client';

// One card per day in the forecast grid. Renders the day's room mix,
// total cleaning minutes, scheduled vs recommended headcount, projected
// labor cost, and the honest accuracy label. Color-coded gap badge
// (green / yellow / red) with a redundant text label so the signal
// doesn't depend on color alone.

import React from 'react';
import { T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Pill } from './_snow';
import type { AccuracyLabel, GapStatus } from '@/lib/forecast';

export interface DayCardData {
  date: string;
  departures: number;
  stayoversLight: number;
  stayoversFull: number;
  deepCleans: number;
  totalMinutesNeeded: number;
  housekeepersScheduled: number;
  housekeepersRecommended: number;
  projectedLaborCents: number;
  wagePending: boolean;
  gapStatus: GapStatus;
  accuracyLabel: AccuracyLabel;
}

interface Props {
  data: DayCardData;
  isExpanded: boolean;
  onToggle: () => void;
  lang: 'en' | 'es';
}

export function ForecastDayCard({ data, isExpanded, onToggle, lang }: Props) {
  const accent = data.gapStatus === 'green'
    ? T.sageDeep
    : data.gapStatus === 'yellow' ? T.caramelDeep : T.warm;
  const bgTint = data.gapStatus === 'green'
    ? T.sageDim
    : data.gapStatus === 'yellow' ? 'rgba(201,150,68,0.10)' : T.warmDim;

  const formattedDate = formatDayHeader(data.date, lang);
  const gapWord = gapLabel(data.gapStatus, lang);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-label={
        `${formattedDate} — ${data.totalMinutesNeeded} ${lang === 'es' ? 'minutos' : 'minutes'} · `
        + `${data.housekeepersScheduled} / ${data.housekeepersRecommended} HKs · `
        + `${gapWord}`
      }
      style={{
        background: T.paper,
        border: `1px solid ${isExpanded ? accent : T.rule}`,
        borderRadius: 14,
        padding: '16px 20px',
        display: 'grid',
        gridTemplateColumns: 'minmax(160px, 220px) minmax(180px, 1fr) minmax(220px, 1fr) auto',
        gap: 18,
        alignItems: 'center',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        fontFamily: FONT_SANS,
        color: T.ink,
        transition: 'border-color 120ms ease, box-shadow 120ms ease',
        boxShadow: isExpanded ? '0 4px 12px rgba(0,0,0,0.06)' : 'none',
      }}
    >
      {/* Date + day-of-week */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Caps size={9}>{relativeDayHeader(data.date, lang)}</Caps>
        <span style={{
          fontFamily: FONT_SERIF,
          fontSize: 22,
          lineHeight: 1.15,
          letterSpacing: '-0.02em',
          color: T.ink,
        }}>
          {formattedDate}
        </span>
        <AccuracyChip label={data.accuracyLabel} lang={lang} />
      </div>

      {/* Room mix */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Caps size={9}>{lang === 'es' ? 'Mezcla del día' : "Day's mix"}</Caps>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <RoomCount
            value={data.departures}
            label={lang === 'es' ? 'Salidas' : 'Departures'}
            color={T.ink}
          />
          <RoomCount
            value={data.stayoversLight}
            label={lang === 'es' ? 'Estadía ligera' : 'Stay · light'}
            color={T.ink2}
          />
          <RoomCount
            value={data.stayoversFull}
            label={lang === 'es' ? 'Estadía completa' : 'Stay · full'}
            color={T.ink2}
          />
          {data.deepCleans > 0 && (
            <RoomCount
              value={data.deepCleans}
              label={lang === 'es' ? 'Limpieza profunda' : 'Deep clean'}
              color={T.purple}
            />
          )}
        </div>
        <span style={{
          fontFamily: FONT_MONO, fontSize: 11, color: T.ink3, marginTop: 2,
        }}>
          {fmtTime(data.totalMinutesNeeded, lang)} {lang === 'es' ? 'de limpieza' : 'of cleaning'}
        </span>
      </div>

      {/* Staffing + cost */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Caps size={9}>{lang === 'es' ? 'Personal' : 'Staffing'}</Caps>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontFamily: FONT_SERIF, fontSize: 22, color: accent, letterSpacing: '-0.02em' }}>
            {data.housekeepersScheduled}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink3 }}>
            / {data.housekeepersRecommended} {lang === 'es' ? 'recomendado' : 'recommended'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{
            fontFamily: FONT_MONO, fontSize: 12, color: T.ink2,
          }}>
            {lang === 'es' ? 'Costo' : 'Labor'}: ${(data.projectedLaborCents / 100).toFixed(0)}
          </span>
          {data.wagePending && (
            <span
              title={lang === 'es'
                ? 'Salario por defecto. Configure los salarios del personal para una proyección exacta.'
                : 'Default wage. Set per-staff wages for an accurate projection.'}
              style={{
                fontFamily: FONT_MONO, fontSize: 10, color: T.ink3,
                border: `1px dashed ${T.rule}`, padding: '1px 6px', borderRadius: 6,
              }}
            >
              {lang === 'es' ? 'salario pendiente' : 'wage pending'}
            </span>
          )}
        </div>
      </div>

      {/* Gap badge + expand caret */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '4px 10px', borderRadius: 999,
            background: bgTint, color: accent,
            fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600,
            border: `1px solid ${accent}`,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
              background: accent,
            }}
          />
          {gapWord}
        </span>
        <span style={{
          fontFamily: FONT_MONO, fontSize: 11, color: T.ink3,
        }}>
          {isExpanded
            ? (lang === 'es' ? '▴ ocultar' : '▴ collapse')
            : (lang === 'es' ? '▾ detalles' : '▾ details')}
        </span>
      </div>
    </button>
  );
}

function RoomCount({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontFamily: FONT_SERIF, fontSize: 18, color, letterSpacing: '-0.02em' }}>{value}</span>
      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.04em' }}>
        {label}
      </span>
    </div>
  );
}

function AccuracyChip({ label, lang }: { label: AccuracyLabel; lang: 'en' | 'es' }) {
  if (label === 'ai_prediction') {
    return (
      <Pill tone="sage">
        {lang === 'es' ? 'Predicción IA' : 'AI prediction'}
      </Pill>
    );
  }
  if (label === 'industry_estimate_learning') {
    return (
      <Pill tone="caramel">
        {lang === 'es' ? 'Estimación · aprendiendo' : 'Industry estimate · learning'}
      </Pill>
    );
  }
  // capacity_unavailable
  return (
    <Pill tone="neutral">
      {lang === 'es' ? 'Datos no disponibles' : 'Capacity unavailable'}
    </Pill>
  );
}

function fmtTime(mins: number, lang: 'en' | 'es'): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function gapLabel(status: GapStatus, lang: 'en' | 'es'): string {
  if (status === 'green') return lang === 'es' ? 'Cubierto' : 'Covered';
  if (status === 'yellow') return lang === 'es' ? 'Justo' : 'Tight';
  return lang === 'es' ? 'Falta personal' : 'Understaffed';
}

function relativeDayHeader(yyyyMmDd: string, lang: 'en' | 'es'): string {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  if (yyyyMmDd === todayStr) return lang === 'es' ? 'Hoy' : 'Today';
  if (yyyyMmDd === tomorrowStr) return lang === 'es' ? 'Mañana' : 'Tomorrow';
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  return d.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', {
    weekday: 'long', timeZone: 'UTC',
  });
}

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

function formatDayHeader(yyyyMmDd: string, lang: 'en' | 'es'): string {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  return d.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}
