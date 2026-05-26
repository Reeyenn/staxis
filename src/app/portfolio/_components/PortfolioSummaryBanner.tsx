'use client';

/**
 * Top-of-page summary banner. Shows portfolio-wide totals + the anomaly
 * count chip. Single-line on desktop, wraps on mobile.
 */

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';
import type { PortfolioSummary } from '@/lib/portfolio/types';
import { AlertTriangle } from 'lucide-react';

const sansFont = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  summary: PortfolioSummary;
}

export function PortfolioSummaryBanner({ summary }: Props) {
  const { lang } = useLang();
  const ink   = 'var(--snow-ink)';
  const ink2  = 'var(--snow-ink2)';
  const rule  = 'var(--snow-rule)';
  const warm  = 'var(--snow-warm)';

  const propertiesLabel = lang === 'es' ? 'propiedades' : 'properties';
  const roomsLabel      = lang === 'es' ? 'habitaciones limpiadas' : 'rooms cleaned';
  const remainingLabel  = lang === 'es' ? 'restantes' : 'remaining';
  const laborLabel      = lang === 'es' ? 'costo laboral hoy' : 'labor today';
  const anomaliesLabel  = lang === 'es'
    ? (summary.anomalyCount === 1 ? 'anomalía' : 'anomalías')
    : (summary.anomalyCount === 1 ? 'anomaly'  : 'anomalies');

  return (
    <div style={{
      borderBottom: `1px solid ${rule}`,
      background: 'var(--snow-bg)',
      padding: '14px clamp(16px, 3vw, 48px)',
      display: 'flex', alignItems: 'center',
      gap: '24px', flexWrap: 'wrap',
      fontFamily: sansFont,
    }}>
      <Stat
        primary={String(summary.propertiesCount)}
        suffix={propertiesLabel}
        ink={ink} ink2={ink2}
      />
      <span style={{ color: ink2 }}>·</span>
      <Stat
        primary={`${summary.totalRoomsTurned} / ${summary.totalRoomsTurned + summary.totalRoomsRemaining}`}
        suffix={roomsLabel}
        ink={ink} ink2={ink2}
        secondary={`${summary.totalRoomsRemaining} ${remainingLabel}`}
      />
      <span style={{ color: ink2 }}>·</span>
      <Stat
        primary={`$${Math.round(summary.totalLaborCostTodayCents / 100).toLocaleString()}`}
        suffix={laborLabel}
        ink={ink} ink2={ink2}
        secondary={
          summary.totalLaborBudgetTodayCents > 0
            ? `/ $${Math.round(summary.totalLaborBudgetTodayCents / 100).toLocaleString()}`
            : undefined
        }
      />
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
        {summary.anomalyCount > 0 ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '4px 10px', borderRadius: '999px',
            background: 'rgba(217, 119, 6, 0.12)',
            color: warm,
            fontSize: '12px', fontWeight: 600,
          }}>
            <AlertTriangle size={12} />
            {summary.anomalyCount} {anomaliesLabel}
          </span>
        ) : (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '4px 10px', borderRadius: '999px',
            background: 'rgba(76, 138, 100, 0.10)',
            color: 'var(--snow-sage-deep)',
            fontSize: '12px', fontWeight: 600,
          }}>
            {lang === 'es' ? 'Todo en orden' : 'All clear'}
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ primary, suffix, secondary, ink, ink2 }: {
  primary: string;
  suffix: string;
  secondary?: string;
  ink: string;
  ink2: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
      <span style={{ fontSize: '15px', fontWeight: 600, color: ink }}>{primary}</span>
      <span style={{ fontSize: '12px', color: ink2 }}>{suffix}</span>
      {secondary && <span style={{ fontSize: '12px', color: ink2 }}>· {secondary}</span>}
    </div>
  );
}
