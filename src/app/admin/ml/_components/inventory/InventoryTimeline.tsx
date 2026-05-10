'use client';

import React from 'react';

/**
 * Horizontal timeline showing where the inventory AI is in its lifecycle.
 *
 * Two modes:
 *   • "single"  — one hotel; "today" dot is at that hotel's day
 *   • "fleet"   — aggregate; "today" dot is at the fleet median day. Below
 *                 the bar, a small histogram shows how many hotels are in
 *                 each phase bucket.
 *
 * Phases (per-hotel; based on days since first count event):
 *   • Day 0     — Started learning
 *   • Day 14    — First predictions appear
 *   • Day 30    — Items start graduating to auto-fill
 *   • Day 60    — Most common items graduated
 *   • Day 90+   — Mature; accuracy ~±10%
 *
 * Data is computed server-side and passed in via props — no self-fetching.
 */

const PHASES = [
  { id: 'started',    label: 'Started learning',         day: 0,
    blurb: 'AI watches every count and starts learning your hotel’s usage.' },
  { id: 'predicting', label: 'First predictions',        day: 14,
    blurb: 'Reorder list switches to AI-predicted rates instead of manual rates.' },
  { id: 'first-grad', label: 'First items auto-fill',    day: 30,
    blurb: 'Common items start pre-filling counts. Counting time drops.' },
  { id: 'mostly',     label: 'Most items graduated',     day: 60,
    blurb: 'Reorder list very accurate. Most counts auto-filled.' },
  { id: 'mature',     label: 'Mature',                   day: 90,
    blurb: 'Accuracy ~±10%. Anomaly alerts well-calibrated.' },
];

const TOTAL_DAYS = PHASES[PHASES.length - 1].day;

export interface PhaseHistogramRow {
  phaseId: string;
  phaseLabel: string;
  phaseDay: number;
  hotelCount: number;
}

interface SingleModeProps {
  mode: 'single';
  day: number;
  itemsTotal: number;
  itemsGraduated: number;
  daysToNextMilestone: number | null;
  nextMilestoneLabel: string;
  aiMode: 'off' | 'auto' | 'always-on';
  hotelName: string;
}

interface FleetModeProps {
  mode: 'fleet';
  fleetMedianDay: number;
  hotelCount: number;
  itemsLearningTotal: number;
  itemsGraduatedTotal: number;
  daysToNextMilestoneMedian: number | null;
  nextMilestoneLabel: string;
  phaseHistogram: PhaseHistogramRow[];
}

export function InventoryTimeline(props: SingleModeProps | FleetModeProps) {
  const day = props.mode === 'single' ? props.day : props.fleetMedianDay;
  const currentPhaseIdx = phaseIndexFor(day);
  const positionPct = Math.min(100, Math.max(0, (day / TOTAL_DAYS) * 100));

  const subtitle = props.mode === 'single'
    ? (props.aiMode === 'off'
        ? 'AI is OFF for this hotel. Turn it back on from the AI Helper page on /inventory.'
        : `Day ${day} — ${PHASES[currentPhaseIdx].blurb}`)
    : `Fleet median: Day ${day} across ${props.hotelCount} ${props.hotelCount === 1 ? 'hotel' : 'hotels'} — ${PHASES[currentPhaseIdx].blurb}`;

  const headline = props.mode === 'single'
    ? `Where the AI is — ${props.hotelName}`
    : 'Where the AI is — fleet view';

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
        }} title={`Day ${day} (${props.mode === 'single' ? 'today' : 'fleet median'})`} />
        {PHASES.map((p, idx) => {
          const left = `calc(12px + (100% - 24px) * ${(p.day / TOTAL_DAYS) * 100} / 100)`;
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
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '12px',
        marginTop: '12px',
      }}>
        {props.mode === 'single' ? (
          <>
            <Stat label="Items learning" value={`${props.itemsTotal - props.itemsGraduated} / ${props.itemsTotal}`} />
            <Stat label="Items auto-filling" value={String(props.itemsGraduated)} color="#00a050" />
            <Stat
              label={props.daysToNextMilestone === null
                ? 'Next milestone'
                : `Days to "${props.nextMilestoneLabel}"`}
              value={props.daysToNextMilestone === null ? 'Mature' : String(props.daysToNextMilestone)}
            />
          </>
        ) : (
          <>
            <Stat label="Items learning (network)" value={String(props.itemsLearningTotal)} />
            <Stat label="Items auto-filling (network)" value={String(props.itemsGraduatedTotal)} color="#00a050" />
            <Stat
              label={props.daysToNextMilestoneMedian === null
                ? 'Fleet next milestone'
                : `Median days to "${props.nextMilestoneLabel}"`}
              value={props.daysToNextMilestoneMedian === null ? 'Mature' : String(props.daysToNextMilestoneMedian)}
            />
          </>
        )}
      </div>

      {/* Fleet-only: phase histogram */}
      {props.mode === 'fleet' && (
        <div style={{ marginTop: '20px' }}>
          <div style={{
            fontSize: '11px', color: '#7a8a9e',
            textTransform: 'uppercase', letterSpacing: '0.04em',
            marginBottom: '8px',
          }}>
            Hotels by phase
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', height: '60px' }}>
            {props.phaseHistogram.map((p) => {
              const maxCount = Math.max(1, ...props.phaseHistogram.map((x) => x.hotelCount));
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

      {/* Network unlocks footnote — only shown in fleet mode */}
      {props.mode === 'fleet' && (
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
            <strong>5 hotels</strong> → cohort priors activate (new hotels get faster cold-start) ·{' '}
            <strong>50 hotels</strong> → stronger cohort priors ·{' '}
            <strong>300 hotels</strong> → XGBoost network model trains on cross-hotel features.
          </div>
        </div>
      )}
    </div>
  );
}

function phaseIndexFor(day: number): number {
  return PHASES.reduce((latest, p, idx) => (day >= p.day ? idx : latest), 0);
}

const cardStyle: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid rgba(78,90,122,0.12)',
  borderRadius: '12px',
  padding: '24px',
};

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: '#7a8a9e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: '20px', fontWeight: 600, color: color ?? '#1b1c19', marginTop: '2px' }}>
        {value}
      </div>
    </div>
  );
}
