'use client';

import { MlLifecycleTimeline, Stat, phaseIndexFor, type MlPhase } from '../MlLifecycleTimeline';

/**
 * Horizontal timeline for the Housekeeping ML lifecycle. Mirrors
 * InventoryTimeline but with HK-specific phases:
 *
 *   • Day 0   — Started recording cleaning events
 *   • Day 30  — Demand model trains (~200 events typical)
 *   • Day 60  — Supply model trains (per-room cleaning time)
 *   • Day 90  — Optimizer activates (Maria gets daily headcount recommendation)
 *   • Day 120 — Mature: ~±10% accuracy, override rate falls
 *
 * Activation depends on event volume + accuracy gates in addition to time;
 * these days are realistic markers for a ~75-room hotel cleaning daily.
 *
 * The card chrome (timeline bar, histogram, footnote shell, Stat) is shared
 * with InventoryTimeline via MlLifecycleTimeline.
 */

const PHASES: MlPhase[] = [
  { id: 'started',   label: 'Started recording',     day: 0,
    blurb: 'Every Done tap on the housekeeper app is captured. The AI is watching.' },
  { id: 'demand',    label: 'Demand model trains',   day: 30,
    blurb: 'AI learns total cleaning workload per day from your event history.' },
  { id: 'supply',    label: 'Supply model trains',   day: 60,
    blurb: 'AI learns how long each housekeeper takes per room type.' },
  { id: 'optimizer', label: 'Optimizer activates',   day: 90,
    blurb: 'Maria starts getting a daily recommended headcount with confidence bands.' },
  { id: 'mature',    label: 'Mature',                day: 120,
    blurb: 'Accuracy ~±10%. Override rate falling. Recommendations trusted.' },
];

export interface HKPhaseHistogramRow {
  phaseId: string;
  phaseLabel: string;
  phaseDay: number;
  hotelCount: number;
}

interface SingleModeProps {
  mode: 'single';
  day: number;
  staffActive: number;
  modelsActive: number;
  eventsLast1h: number;
  daysToNextMilestone: number | null;
  nextMilestoneLabel: string;
  hotelName: string;
  optimizerActive: boolean;
}

interface FleetModeProps {
  mode: 'fleet';
  fleetMedianDay: number;
  hotelCount: number;
  totalStaff: number;
  totalModelsActive: number;
  totalEventsLast1h: number;
  daysToNextMilestoneMedian: number | null;
  nextMilestoneLabel: string;
  phaseHistogram: HKPhaseHistogramRow[];
  optimizerActive: boolean;
}

export function HousekeepingTimeline(props: SingleModeProps | FleetModeProps) {
  const day = props.mode === 'single' ? props.day : props.fleetMedianDay;
  const currentPhaseIdx = phaseIndexFor(PHASES, day);

  const subtitle = props.mode === 'single'
    ? `Day ${day} — ${PHASES[currentPhaseIdx].blurb}`
    : `Fleet median: Day ${day} across ${props.hotelCount} ${props.hotelCount === 1 ? 'hotel' : 'hotels'} — ${PHASES[currentPhaseIdx].blurb}`;

  const headline = props.mode === 'single'
    ? `Where the AI is — ${props.hotelName}`
    : 'Where the AI is — fleet view';

  const stats = props.mode === 'single' ? (
    <>
      <Stat label="Active staff" value={String(props.staffActive)} subtitle="Last 30 days" />
      <Stat
        label="Working right now"
        value={String(props.eventsLast1h)}
        subtitle="Cleans last hour"
        color={props.eventsLast1h > 0 ? '#00a050' : '#7a8a9e'}
      />
      <Stat
        label="Models active"
        value={`${props.modelsActive}/3`}
        color={props.optimizerActive ? '#00a050' : '#7a8a9e'}
        subtitle="Demand · Supply · Optimizer"
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
      <Stat label="Active staff (network)" value={String(props.totalStaff)} subtitle="Last 30 days" />
      <Stat
        label="Working right now"
        value={String(props.totalEventsLast1h)}
        subtitle="Cleans last hour"
        color={props.totalEventsLast1h > 0 ? '#00a050' : '#7a8a9e'}
      />
      <Stat
        label="Active models (network)"
        value={String(props.totalModelsActive)}
        color={props.optimizerActive ? '#00a050' : '#7a8a9e'}
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
      <strong>5 hotels</strong> → cohort-based cleaning rate priors (new hotels get faster cold-start) ·{' '}
      <strong>50 hotels</strong> → stronger cohort priors ·{' '}
      <strong>300 hotels</strong> → cross-hotel XGBoost network model.
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
