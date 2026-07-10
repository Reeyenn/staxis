'use client';

// CapEx projection views — Forecast (upcoming capital spend by month) and the
// multi-property Rollup. Split out of CapexTab so the board file keeps only
// the list + workflow orchestration. Reads /api/financials/capex/forecast and
// /rollup behind the owner/GM finance gate. Money is integer cents.

import React from 'react';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { monthLabelFromYm } from '@/lib/format-date';
import { Money, Card, Notice, T, FONT_SANS, FONT_MONO } from './fin-ui';
import { StatStrip, statNum } from './fin-board';
import { ft } from './fin-i18n';

type Lang = 'en' | 'es';

interface ForecastMonth {
  month: string;
  estimatedCents: number;
  spentCents: number;
  remainingCents: number;
  projects: number;
}
interface RollupRow {
  propertyId: string;
  propertyName: string | null;
  projects: number;
  pending: number;
  active: number;
  estimatedCents: number;
  spentCents: number;
}
interface Rollup {
  properties: RollupRow[];
  totals: { projects: number; pending: number; active: number; estimatedCents: number; spentCents: number };
}

// ─── Forecast ──────────────────────────────────────────────────────────────
export function Forecast({ pid, lang }: { pid: string; lang: Lang }) {
  const S = ft(lang);
  const res = useApiResource<{ forecast: ForecastMonth[] }>(`/api/financials/capex/forecast?pid=${pid}`);
  if (res.loading) return <Notice text={S.loading} />;
  // A failed load must not read as "no upcoming capital spend".
  if (res.error != null) return <Notice text={S.errorLoading} onRetry={() => void res.reload()} />;
  const rows = res.data?.forecast ?? [];
  if (rows.length === 0) return <Notice text={S.noForecastCapex} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 4 }}>{S.upcomingByMonth}</span>
      {rows.map((m) => (
        <Card key={m.month} style={{ padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink }}>{monthLabelFromYm(m.month, lang)}</span>
          <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>{m.projects} {S.projects.toLowerCase()}</span>
            <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>{S.remaining}: <Money cents={m.remainingCents} size={14} /></span>
            <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3 }}>{S.estimate}: <Money cents={m.estimatedCents} size={12} weight={500} color={T.ink2} /></span>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── Multi-property rollup ─────────────────────────────────────────────────
const EMPTY_ROLLUP: Rollup = { properties: [], totals: { projects: 0, pending: 0, active: 0, estimatedCents: 0, spentCents: 0 } };

export function RollupView({ lang }: { lang: Lang }) {
  const S = ft(lang);
  const res = useApiResource<{ rollup: Rollup }>('/api/financials/capex/rollup');
  if (res.loading) return <Notice text={S.loading} />;
  // A failed load must not render confident all-zero totals.
  if (res.error != null) return <Notice text={S.errorLoading} onRetry={() => void res.reload()} />;
  const data = res.data?.rollup ?? EMPTY_ROLLUP;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink2, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>{S.acrossProperties}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 16 }}>
          <StatStrip label={S.totalRequests}><span style={statNum}>{data.totals.projects}</span></StatStrip>
          <StatStrip label={S.capPending}><span style={statNum}>{data.totals.pending}</span></StatStrip>
          <StatStrip label={S.capActive}><span style={statNum}>{data.totals.active}</span></StatStrip>
          <StatStrip label={S.totalEstimated}><Money cents={data.totals.estimatedCents} size={20} /></StatStrip>
          <StatStrip label={S.totalSpent}><Money cents={data.totals.spentCents} size={20} /></StatStrip>
        </div>
      </Card>
      {data.properties.map((p) => (
        <Card key={p.propertyId} style={{ padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: 14, fontWeight: 600, color: T.ink }}>{p.propertyName ?? p.propertyId.slice(0, 8)}</span>
          <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap', fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>
            <span>{p.projects} {S.projects.toLowerCase()}</span>
            <span>{S.capPending}: {p.pending}</span>
            <span>{S.capActive}: {p.active}</span>
            <span>{S.totalSpent} <Money cents={p.spentCents} size={13} /> / <Money cents={p.estimatedCents} size={12} weight={500} color={T.ink3} /></span>
          </div>
        </Card>
      ))}
    </div>
  );
}
