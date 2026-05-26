'use client';

/**
 * PropertyTile — generic frame around any module's per-property tile
 * body. Owns the click-to-switch handler, the anomaly indicator chip,
 * the accuracy label, and the property header.
 *
 * Module-specific KPI rendering lives in a per-module Body component
 * (HousekeepingTileBody below). When a new module ships, add a switch
 * case here.
 */

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';
import type { PortfolioTileData, AccuracyLabel } from '@/lib/portfolio/types';
import { Building2, AlertTriangle } from 'lucide-react';

const sansFont = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  data: PortfolioTileData;
  onClick: () => void;
  isAnomaly: boolean;
}

export function PropertyTile({ data, onClick, isAnomaly }: Props) {
  const { lang } = useLang();
  const ink   = 'var(--snow-ink)';
  const ink2  = 'var(--snow-ink2)';
  const rule  = 'var(--snow-rule)';
  const warm  = 'var(--snow-warm)';

  const propertyName = data.property.name;
  const totalRooms = data.property.totalRooms;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: 'var(--snow-bg)',
        border: `1px solid ${isAnomaly ? warm : rule}`,
        borderRadius: '14px',
        padding: '18px 18px 16px',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: '12px',
        boxShadow: isAnomaly ? '0 0 0 1px rgba(217, 119, 6, 0.15)' : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget;
        if (!isAnomaly) el.style.borderColor = 'rgba(31, 35, 28, 0.25)';
        el.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget;
        el.style.borderColor = isAnomaly ? warm : rule;
        el.style.transform = 'translateY(0)';
      }}
      aria-label={`${lang === 'es' ? 'Abrir' : 'Open'} ${propertyName}`}
    >
      {/* Header: property name + total rooms + anomaly chip */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <div style={{
            width: '32px', height: '32px', borderRadius: '8px',
            background: 'rgba(158,183,166,0.18)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Building2 size={16} color="var(--snow-sage-deep)" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: sansFont, fontSize: '15px', fontWeight: 600,
              color: ink, lineHeight: 1.2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {propertyName}
            </div>
            <div style={{ fontFamily: sansFont, fontSize: '11px', color: ink2, marginTop: '2px' }}>
              {totalRooms} {lang === 'es' ? 'habitaciones' : 'rooms'}
            </div>
          </div>
        </div>
        {isAnomaly && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '4px 8px', borderRadius: '999px',
            background: 'rgba(217, 119, 6, 0.12)',
            color: warm, fontFamily: sansFont, fontSize: '10px', fontWeight: 600,
            letterSpacing: '0.04em', textTransform: 'uppercase',
            flexShrink: 0,
          }}>
            <AlertTriangle size={11} />
            {lang === 'es' ? 'Atención' : 'Flag'}
          </div>
        )}
      </div>

      {/* Per-module body */}
      <PropertyTileBody data={data} />

      {/* Accuracy label */}
      <AccuracyChip label={data.accuracyLabel} />
    </button>
  );
}

/**
 * Module-routing switch. New modules add a case here. The body
 * components own their own visual identity inside the shared frame.
 */
function PropertyTileBody({ data }: { data: PortfolioTileData }) {
  switch (data.module) {
    case 'housekeeping':
      return <HousekeepingTileBody data={data} />;
    // future: case 'maintenance': return <MaintenanceTileBody data={data} />;
    // future: case 'inventory':   return <InventoryTileBody   data={data} />;
    // future: case 'staff':       return <StaffTileBody       data={data} />;
    // future: case 'labor':       return <LaborTileBody       data={data} />;
  }
}

/** KPI rows for the housekeeping tile. */
function HousekeepingTileBody({ data }: { data: Extract<PortfolioTileData, { module: 'housekeeping' }> }) {
  const { lang } = useLang();
  const ink  = 'var(--snow-ink)';
  const ink2 = 'var(--snow-ink2)';

  // Labor budget gap badge — green/red chip when both numbers are
  // present so the operator gets an instant under/over signal.
  const budgetGap = (() => {
    if (data.laborCostTodayCents === null || data.laborBudgetTodayCents === null) return null;
    if (data.laborBudgetTodayCents === 0) return null;
    return data.laborCostTodayCents / data.laborBudgetTodayCents - 1;
  })();

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 18px' }}>
      <KpiCell
        label={lang === 'es' ? 'Habitaciones limpiadas' : 'Rooms turned'}
        value={`${data.roomsTurned}`}
        sub={lang === 'es'
          ? `${data.roomsRemaining} restantes`
          : `${data.roomsRemaining} remaining`}
      />
      <KpiCell
        label={lang === 'es' ? 'Tasa de aprobación' : 'Pass rate'}
        value={data.inspectionPassRate === null
          ? '—'
          : `${Math.round(data.inspectionPassRate * 100)}%`}
        sub={lang === 'es' ? 'inspecciones' : 'inspections'}
      />
      <KpiCell
        label={lang === 'es' ? 'Min. por salida' : 'Min/departure'}
        value={data.avgMinutesPerDeparture === null
          ? '—'
          : data.avgMinutesPerDeparture.toFixed(1)}
        sub={lang === 'es' ? 'promedio hoy' : 'avg today'}
      />
      <KpiCell
        label={lang === 'es' ? 'Personal' : 'Staff'}
        value={`${data.staffActiveCount} / ${data.staffScheduledCount}`}
        sub={lang === 'es' ? 'activos / programados' : 'active / scheduled'}
      />
      <div style={{
        gridColumn: '1 / -1',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: '8px', paddingTop: '6px',
        borderTop: '1px solid var(--snow-rule-soft)',
      }}>
        <div style={{ fontSize: '11px', color: ink2, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {lang === 'es' ? 'Costo laboral hoy' : 'Labor cost today'}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontFamily: sansFont, fontSize: '15px', fontWeight: 600, color: ink }}>
            {formatCents(data.laborCostTodayCents)}
          </span>
          <span style={{ fontFamily: sansFont, fontSize: '12px', color: ink2 }}>
            / {formatCents(data.laborBudgetTodayCents)}
          </span>
          {budgetGap !== null && (
            <BudgetGapChip gap={budgetGap} />
          )}
        </div>
      </div>
    </div>
  );
}

function KpiCell({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{ fontSize: '10px', color: 'var(--snow-ink2)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontFamily: sansFont, fontSize: '20px', fontWeight: 600, color: 'var(--snow-ink)', lineHeight: 1.2 }}>
        {value}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--snow-ink3)' }}>{sub}</div>
    </div>
  );
}

function BudgetGapChip({ gap }: { gap: number }) {
  // Negative gap = under budget = good; positive = over.
  const under = gap < 0;
  const abs = Math.abs(gap);
  const color = under ? 'var(--snow-sage-deep)' : 'var(--snow-warm)';
  const bg = under ? 'rgba(76, 138, 100, 0.12)' : 'rgba(217, 119, 6, 0.12)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 6px', borderRadius: '6px',
      background: bg, color,
      fontFamily: sansFont, fontSize: '10px', fontWeight: 600,
    }}>
      {under ? '↓' : '↑'} {Math.round(abs * 100)}%
    </span>
  );
}

function AccuracyChip({ label }: { label: AccuracyLabel }) {
  const { lang } = useLang();
  const map: Record<AccuracyLabel, { text: string; bg: string; fg: string }> = {
    ai_prediction:              { text: lang === 'es' ? 'Predicción AI'    : 'AI prediction',         bg: 'rgba(76, 138, 100, 0.10)', fg: 'var(--snow-sage-deep)' },
    industry_estimate_learning: { text: lang === 'es' ? 'Estimación, aprendiendo' : 'Estimate, learning', bg: 'rgba(31, 35, 28, 0.06)',   fg: 'var(--snow-ink2)' },
    capacity_unavailable:       { text: lang === 'es' ? 'Sin datos'        : 'Capacity unavailable',  bg: 'rgba(31, 35, 28, 0.04)',   fg: 'var(--snow-ink3)' },
  };
  const m = map[label];
  return (
    <div style={{
      display: 'inline-flex', alignSelf: 'flex-start',
      padding: '3px 8px', borderRadius: '6px',
      background: m.bg, color: m.fg,
      fontFamily: sansFont, fontSize: '10px', fontWeight: 500,
      letterSpacing: '0.04em',
    }}>
      {m.text}
    </div>
  );
}

/** Format integer cents as "$X" or "—" when null. */
function formatCents(cents: number | null): string {
  if (cents === null) return '—';
  return `$${Math.round(cents / 100).toLocaleString()}`;
}
