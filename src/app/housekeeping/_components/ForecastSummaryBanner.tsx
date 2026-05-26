'use client';

// Single-line range summary that sits at the top of the Forecast view.
// Always renders three numbers — hours needed, hours scheduled, the gap
// — and counts how many days in the range went red. Color tracks the
// gap magnitude so the GM gets a glanceable verdict before reading the
// per-day grid below.

import React from 'react';
import { T, FONT_SANS, FONT_MONO, Caps } from './_snow';

export interface ForecastSummary {
  totalHoursNeeded: number;
  totalHoursScheduled: number;
  gapHours: number;
  understaffedDayCount: number;
  rangeDayCount: number;
}

interface Props {
  summary: ForecastSummary;
  lang: 'en' | 'es';
}

export function ForecastSummaryBanner({ summary, lang }: Props) {
  // Gap tone — green when covered, yellow within 10% of needed, red
  // above that. Mirrors the per-day gap thresholds so the banner and
  // the cards agree.
  const slack = summary.totalHoursNeeded > 0
    ? summary.gapHours / summary.totalHoursNeeded
    : 0;
  let tone: 'green' | 'yellow' | 'red';
  if (summary.gapHours <= 0.05) tone = 'green';
  else if (slack <= 0.10) tone = 'yellow';
  else tone = 'red';

  const accent =
    tone === 'green' ? T.sageDeep
      : tone === 'yellow' ? T.caramelDeep
        : T.warm;
  const bg =
    tone === 'green' ? T.sageDim
      : tone === 'yellow' ? 'rgba(201,150,68,0.10)'
        : T.warmDim;

  // Plain-English summary — the part the GM reads first. Compose
  // sentence by sentence so a fully-covered week skips the "X
  // understaffed days" tail.
  const headlineEn = summary.gapHours <= 0.05
    ? `Fully staffed across ${summary.rangeDayCount} ${summary.rangeDayCount === 1 ? 'day' : 'days'}.`
    : `${summary.gapHours.toFixed(1)}-hour gap${
      summary.understaffedDayCount > 0
        ? ` · ${summary.understaffedDayCount} ${summary.understaffedDayCount === 1 ? 'day' : 'days'} understaffed`
        : ''
    }.`;

  const headlineEs = summary.gapHours <= 0.05
    ? `Totalmente cubierto en ${summary.rangeDayCount} ${summary.rangeDayCount === 1 ? 'día' : 'días'}.`
    : `Faltan ${summary.gapHours.toFixed(1)} horas${
      summary.understaffedDayCount > 0
        ? ` · ${summary.understaffedDayCount} ${summary.understaffedDayCount === 1 ? 'día' : 'días'} con poco personal`
        : ''
    }.`;

  // Status word for screen readers / non-color users — accessibility
  // requirement: the gap signal must not rely on color alone.
  const statusWord =
    tone === 'green' ? (lang === 'es' ? 'Cubierto' : 'Covered')
      : tone === 'yellow' ? (lang === 'es' ? 'Ajustado' : 'Tight')
        : (lang === 'es' ? 'Falto' : 'Short');

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: bg,
        border: `1px solid ${accent}`,
        borderRadius: 16,
        padding: '14px 22px',
        marginBottom: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 10, height: 10, borderRadius: '50%',
            background: accent,
          }}
        />
        <span style={{
          fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600,
          color: accent, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>{statusWord}</span>
      </div>

      <span style={{ width: 1, height: 28, background: T.rule }} />

      <div style={{ display: 'flex', gap: 26, flex: 1, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Caps size={9}>{lang === 'es' ? 'Horas necesarias' : 'Hours needed'}</Caps>
          <span style={{ fontFamily: FONT_SANS, fontSize: 18, fontWeight: 600, color: T.ink }}>
            {summary.totalHoursNeeded.toFixed(1)}h
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Caps size={9}>{lang === 'es' ? 'Horas programadas' : 'Hours scheduled'}</Caps>
          <span style={{ fontFamily: FONT_SANS, fontSize: 18, fontWeight: 600, color: T.ink }}>
            {summary.totalHoursScheduled.toFixed(1)}h
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Caps size={9}>{lang === 'es' ? 'Diferencia' : 'Gap'}</Caps>
          <span style={{ fontFamily: FONT_SANS, fontSize: 18, fontWeight: 600, color: accent }}>
            {summary.gapHours <= 0.05 ? '0h' : `${summary.gapHours.toFixed(1)}h`}
          </span>
        </div>
      </div>

      <p style={{
        fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: 0,
        flexBasis: '100%',
      }}>
        {lang === 'es' ? headlineEs : headlineEn}
      </p>
    </div>
  );
}
