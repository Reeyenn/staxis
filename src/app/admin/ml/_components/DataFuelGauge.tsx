'use client';

import React from 'react';

/**
 * Shared shell for the two ML data fuel gauges (housekeeping cleaning events
 * and inventory counts). Both render the same card + header + a stat strip +
 * an optional callout row + a milestone progress bar + a daily activity
 * chart. The stat strip, the callout row (HK's throwaway-rate), and the chart
 * are domain-specific and passed in as slots; the milestone progress bar is
 * shared and driven by `total` + `milestones`.
 */

interface DataFuelGaugeProps {
  headline: string;
  subtitle: string;
  /** Current total (events or counts) — drives the milestone progress bar. */
  total: number;
  /** Ascending milestone thresholds. */
  milestones: number[];
  /** Noun after the milestone number: "events" (HK) / "counts" (inventory). */
  milestoneNoun: string;
  /** Domain-specific stat strip (owns its own grid + Stat sizing). */
  stats: React.ReactNode;
  /** Optional callout row between the stats and the progress bar (HK throwaway rate). */
  extraRow?: React.ReactNode;
  /** Domain-specific daily activity chart. */
  chart: React.ReactNode;
}

export function DataFuelGauge({
  headline,
  subtitle,
  total,
  milestones,
  milestoneNoun,
  stats,
  extraRow,
  chart,
}: DataFuelGaugeProps) {
  const nextMilestone = milestones.find((m) => m > total) ?? milestones[milestones.length - 1];
  const prevMilestone = milestones.filter((m) => m <= total).pop() ?? 0;
  const progressToNext = nextMilestone > prevMilestone
    ? ((total - prevMilestone) / (nextMilestone - prevMilestone)) * 100
    : 100;

  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          {headline}
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>{subtitle}</p>
      </div>

      {stats}

      {extraRow}

      {/* Progress bar to next milestone */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: '11px', color: '#7a8a9e', marginBottom: '6px',
        }}>
          <span>Next milestone: {nextMilestone.toLocaleString()} {milestoneNoun}</span>
          <span>{Math.round(progressToNext)}%</span>
        </div>
        <div style={{ height: '6px', background: '#f0f4f7', borderRadius: '3px', overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(100, Math.max(0, progressToNext))}%`,
            height: '100%',
            background: '#004b4b',
            transition: 'width 0.4s',
          }} />
        </div>
      </div>

      {chart}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid rgba(78,90,122,0.12)',
  borderRadius: '12px',
  padding: '24px',
};
