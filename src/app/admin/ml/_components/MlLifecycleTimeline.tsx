'use client';

import React from 'react';

/**
 * Shared shell for the two ML-lifecycle timeline cards (housekeeping and
 * inventory). Both render the same horizontal phase bar, "today"/fleet-median
 * dot, 4-column stat strip, fleet-only phase histogram, and fleet-only
 * "Network unlocks" footnote — only the domain PHASES, the stat strip
 * contents, the subtitle copy, and the footnote copy differ. Those come in as
 * props from HousekeepingTimeline / InventoryTimeline, which own their
 * domain-specific PHASES and prop shapes.
 */

export interface MlPhase {
  id: string;
  label: string;
  day: number;
  blurb: string;
}

export interface MlPhaseHistogramRow {
  phaseId: string;
  phaseLabel: string;
  phaseDay: number;
  hotelCount: number;
}

export function phaseIndexFor(phases: MlPhase[], day: number): number {
  return phases.reduce((latest, p, idx) => (day >= p.day ? idx : latest), 0);
}

interface MlLifecycleTimelineProps {
  phases: MlPhase[];
  mode: 'single' | 'fleet';
  /** The day the "today" dot sits at — a hotel's day (single) or the fleet median (fleet). */
  day: number;
  headline: string;
  subtitle: string;
  /** The 4-column stat strip contents (domain-specific), rendered as-is. */
  stats: React.ReactNode;
  /** Fleet-only phase histogram data. Omit (or pass undefined) in single mode. */
  phaseHistogram?: MlPhaseHistogramRow[];
  /** Fleet-only "Network unlocks" footnote body (domain-specific copy). */
  footnote?: React.ReactNode;
}

export function MlLifecycleTimeline({
  phases,
  mode,
  day,
  headline,
  subtitle,
  stats,
  phaseHistogram,
  footnote,
}: MlLifecycleTimelineProps) {
  const totalDays = phases[phases.length - 1].day;
  const currentPhaseIdx = phaseIndexFor(phases, day);
  const positionPct = Math.min(100, Math.max(0, (day / totalDays) * 100));

  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: '12px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#1b1c19', margin: 0 }}>
          {headline}
        </h2>
        <p style={{ fontSize: '12px', color: '#7a8a9e', marginTop: '4px' }}>
          {subtitle}
        </p>
      </div>

      {/* Timeline bar */}
      <div style={{ position: 'relative', padding: '40px 12px 56px 12px' }}>
        <div style={{
          position: 'absolute', left: '12px', right: '12px', top: '60px',
          height: '4px', background: '#eef1f4', borderRadius: '2px',
        }} />
        <div style={{
          position: 'absolute', left: '12px', top: '60px',
          width: `calc((100% - 24px) * ${positionPct} / 100)`,
          height: '4px', background: '#004b4b', borderRadius: '2px',
          transition: 'width 0.4s',
        }} />
        <div style={{
          position: 'absolute', left: `calc(12px + (100% - 24px) * ${positionPct} / 100)`,
          top: '52px', width: '20px', height: '20px',
          background: '#004b4b', borderRadius: '50%',
          border: '3px solid #ffffff',
          boxShadow: '0 0 0 1px rgba(0,75,75,0.3)',
          transform: 'translateX(-10px)',
          zIndex: 2,
        }} title={`Day ${day} (${mode === 'single' ? 'today' : 'fleet median'})`} />
        {phases.map((p, idx) => {
          const left = `calc(12px + (100% - 24px) * ${(p.day / totalDays) * 100} / 100)`;
          const reached = idx <= currentPhaseIdx;
          return (
            <React.Fragment key={p.id}>
              <div style={{
                position: 'absolute',
                left,
                top: '54px',
                width: '12px', height: '12px',
                borderRadius: '50%',
                background: reached ? '#004b4b' : '#cdd5dd',
                transform: 'translateX(-6px)',
                zIndex: 1,
              }} />
              <div style={{
                position: 'absolute', left, top: '8px',
                transform: 'translateX(-50%)',
                fontSize: '11px', fontWeight: 600,
                color: reached ? '#004b4b' : '#7a8a9e',
                whiteSpace: 'nowrap',
                textAlign: 'center',
              }}>
                {p.label}
              </div>
              <div style={{
                position: 'absolute', left, top: '78px',
                transform: 'translateX(-50%)',
                fontSize: '10px', color: '#7a8a9e',
                whiteSpace: 'nowrap',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {p.day === 0 ? 'Day 0' : `Day ${p.day}`}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Stats strip */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '12px',
        marginTop: '12px',
      }}>
        {stats}
      </div>

      {/* Fleet-only: phase histogram */}
      {mode === 'fleet' && phaseHistogram && (
        <div style={{ marginTop: '20px' }}>
          <div style={{
            fontSize: '11px', color: '#7a8a9e',
            textTransform: 'uppercase', letterSpacing: '0.04em',
            marginBottom: '8px',
          }}>
            Hotels by phase
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', height: '60px' }}>
            {phaseHistogram.map((p) => {
              const maxCount = Math.max(1, ...phaseHistogram.map((x) => x.hotelCount));
              const heightPct = (p.hotelCount / maxCount) * 100;
              return (
                <div
                  key={p.phaseId}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '4px',
                    height: '100%',
                    justifyContent: 'flex-end',
                  }}
                  title={`${p.hotelCount} ${p.hotelCount === 1 ? 'hotel' : 'hotels'} in "${p.phaseLabel}"`}
                >
                  <div style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    color: p.hotelCount > 0 ? '#004b4b' : '#cdd5dd',
                  }}>
                    {p.hotelCount}
                  </div>
                  <div style={{
                    width: '100%',
                    height: `${heightPct}%`,
                    minHeight: '2px',
                    background: p.hotelCount > 0 ? '#004b4b' : '#eef1f4',
                    borderRadius: '3px 3px 0 0',
                  }} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Network unlocks footnote — only in fleet mode */}
      {mode === 'fleet' && footnote && (
        <div style={{
          marginTop: '20px',
          padding: '12px 14px',
          background: '#f7fafb',
          border: '1px solid rgba(78,90,122,0.08)',
          borderRadius: '10px',
          fontSize: '12px',
          color: '#454652',
          lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 600, color: '#1b1c19', marginBottom: '4px' }}>
            Network unlocks
          </div>
          <div>
            {footnote}
          </div>
        </div>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid rgba(78,90,122,0.12)',
  borderRadius: '12px',
  padding: '24px',
};

export function Stat({ label, value, color, subtitle }: { label: string; value: string; color?: string; subtitle?: string }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: '#7a8a9e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: '20px', fontWeight: 600, color: color ?? '#1b1c19', marginTop: '2px' }}>
        {value}
      </div>
      {subtitle && (
        <div style={{ fontSize: '10px', color: '#7a8a9e', marginTop: '1px' }}>{subtitle}</div>
      )}
    </div>
  );
}
