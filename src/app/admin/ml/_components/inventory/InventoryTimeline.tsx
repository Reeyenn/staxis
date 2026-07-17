'use client';

import { MlLifecycleTimeline, Stat, phaseIndexFor, type MlPhase } from '../MlLifecycleTimeline';

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
 * The card chrome (timeline bar, histogram, footnote shell, Stat) is shared
 * with HousekeepingTimeline via MlLifecycleTimeline.
 */

const PHASES: MlPhase[] = [
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
  countsLast1h: number;
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
  totalCountsLast1h: number;
  daysToNextMilestoneMedian: number | null;
  nextMilestoneLabel: string;
  phaseHistogram: PhaseHistogramRow[];
}

export function InventoryTimeline(props: SingleModeProps | FleetModeProps) {
  const day = props.mode === 'single' ? props.day : props.fleetMedianDay;
  const currentPhaseIdx = phaseIndexFor(PHASES, day);

  const subtitle = props.mode === 'single'
    ? (props.aiMode === 'off'
        ? 'AI is OFF for this hotel. Turn it back on from the AI Helper page on /inventory.'
        : `Day ${day} — ${PHASES[currentPhaseIdx].blurb}`)
    : `Fleet median: Day ${day} across ${props.hotelCount} ${props.hotelCount === 1 ? 'hotel' : 'hotels'} — ${PHASES[currentPhaseIdx].blurb}`;

  const headline = props.mode === 'single'
    ? `Where the AI is — ${props.hotelName}`
    : 'Where the AI is — fleet view';

  const stats = props.mode === 'single' ? (
    <>
      <Stat label="Items learning" value={`${props.itemsTotal - props.itemsGraduated} / ${props.itemsTotal}`} />
      <Stat label="Items auto-filling" value={String(props.itemsGraduated)} color="#00a050" />
      <Stat
        label="Counting right now"
        value={String(props.countsLast1h)}
        subtitle="Counts last hour"
        color={props.countsLast1h > 0 ? '#00a050' : '#7a8a9e'}
      />
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
        label="Counting right now"
        value={String(props.totalCountsLast1h)}
        subtitle="Counts last hour"
        color={props.totalCountsLast1h > 0 ? '#00a050' : '#7a8a9e'}
      />
      <Stat
        label={props.daysToNextMilestoneMedian === null
          ? 'Fleet next milestone'
          : `Median days to "${props.nextMilestoneLabel}"`}
        value={props.daysToNextMilestoneMedian === null ? 'Mature' : String(props.daysToNextMilestoneMedian)}
      />
    </>
  );

  const footnote = (
    <>
      <strong>5 hotels</strong> → cohort priors activate (new hotels get faster cold-start) ·{' '}
      <strong>50 hotels</strong> → stronger cohort priors ·{' '}
      <strong>300 hotels</strong> → XGBoost network model trains on cross-hotel features.
    </>
  );

  return (
    <MlLifecycleTimeline
      phases={PHASES}
      mode={props.mode}
      day={day}
      headline={headline}
      subtitle={subtitle}
      stats={stats}
      phaseHistogram={props.mode === 'fleet' ? props.phaseHistogram : undefined}
      footnote={props.mode === 'fleet' ? footnote : undefined}
    />
  );
}
