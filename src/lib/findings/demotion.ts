// ─── Self-demotion: the check library can shrink ─────────────────────────────
//
// WHY THIS EXISTS
// Phases 1 and 2 can only add. Every detector that ships is another card, and
// the sweep in this same phase exists to propose MORE detectors. A watcher that
// only grows ends as a screen a manager scrolls past, and a screen nobody reads
// is worse than no screen: it teaches them that everything Staxis says is
// ignorable, including the one card that mattered.
//
// So a check earns its place. A detector whose findings are shown to a manager
// again and again and never once acted on steps quietly down the ladder —
//
//     propose  →  recommend  →  fyi  →  resting
//
// — and eventually stops running. Nothing is deleted, nothing is hidden from
// the ledger, and a human can put it back on duty.
//
// PER HOTEL. ALWAYS PER HOTEL.
// One hotel ignoring the supply-spend card must never silence it at a hotel
// where it is the most useful thing on the screen. That is not a policy this
// file is careful about — it is the shape of the state: `finding_detector_state`
// is keyed (property_id, detector_id) with a unique index, so there is no row
// shape in which a fleet-wide demotion could be written down.
//
// THE THRESHOLDS ARE DELIBERATELY TIMID
// Ten shows, zero of any kind of engagement, spread over at least three weeks,
// buys ONE rung. A wrong demotion is invisible — the manager never learns that
// the thing that would have told them about the leak has been resting since
// April — so the failure mode is asymmetric and the numbers lean the safe way.
//
// AND A DEMOTION CANNOT CASCADE
// Every transition moves the baseline forward, so the ten ignored shows that
// bought the first rung are spent. Falling from propose to resting takes three
// separate stretches of being ignored, each at least three weeks long. Without
// that, one bad month would rest half the library in three nights.

import 'server-only';

import { scopedDb } from '@/lib/agent/scoped-db';
import { log } from '@/lib/log';

import type { AnyDetector, FindingDisposition, JsonValue } from './types';

// ─── The ladder ──────────────────────────────────────────────────────────────

/**
 * The rungs, loudest first. A detector starts on whichever rung its own
 * declaration named, which is why state stores STEPS and not an absolute
 * disposition: `expected_activity` starting at `propose` and a detector
 * starting at `fyi` are one and two rungs from rest respectively.
 */
export const DEMOTION_LADDER: readonly FindingDisposition[] = Object.freeze([
  'propose',
  'recommend',
  'fyi',
]);

/** Past the last rung there is only rest. */
export const DORMANT = 'dormant' as const;

export type EffectiveDisposition = FindingDisposition | typeof DORMANT;

/**
 * Where `steps` rungs below `base` lands.
 *
 * `ask` and `drop` are NOT on the ladder and are returned untouched. They are
 * the judge's vocabulary for "this is a question" and "do not surface this",
 * not volume settings, and demoting a question into a quieter question is
 * meaningless. A detector that defaults to either therefore never rests.
 */
export function demoteDisposition(base: FindingDisposition, steps: number): EffectiveDisposition {
  const from = DEMOTION_LADDER.indexOf(base);
  if (from === -1) return base;
  const to = from + Math.max(0, Math.floor(steps));
  return to >= DEMOTION_LADDER.length ? DORMANT : DEMOTION_LADDER[to];
}

/** True when this many steps rests this detector. */
export function isDormantAt(base: FindingDisposition, steps: number): boolean {
  return demoteDisposition(base, steps) === DORMANT;
}

// ─── The policy ──────────────────────────────────────────────────────────────

export interface DemotionThresholds {
  /** Distinct days a detector's cards were on screen since the last baseline. */
  readonly minShown: number;
  /** Any engagement at all above this many resets the case for demoting. */
  readonly maxActed: number;
  /** How long that ignoring has to have been going on. Three weeks. */
  readonly minSpanDays: number;
}

/**
 * Conservative on purpose. See the header: a wrong demotion is silent, and a
 * detector that should have demoted and did not merely costs a manager a
 * scroll.
 */
export const DEMOTION_THRESHOLDS: DemotionThresholds = Object.freeze({
  minShown: 10,
  maxActed: 0,
  minSpanDays: 21,
});

/** What this detector's cards have done at this hotel SINCE the baseline. */
export interface DetectorEngagement {
  /** Distinct hotel-days on which a card from this detector was on screen. */
  shown: number;
  /** Any verdict a manager reached, or the receipt opened. Handled it, seen,
   *  not doing this — all of them are somebody reading this check. */
  acted: number;
  /** Days since the baseline was set. */
  spanDays: number;
}

export interface DemotionVerdict {
  demote: boolean;
  /** Plain English, stored on the transition. A demotion nobody can explain is
   *  indistinguishable from a bug. */
  reason: string;
}

/**
 * Should this detector step down? Pure — no clock, no database — because this
 * is the decision that has to be provable.
 *
 * All three conditions, together. Any engagement at all is a veto: a manager
 * who opened the receipt once was reading, and a check somebody reads is a
 * check that is working even if they did not press a button.
 */
export function evaluateDemotion(
  engagement: DetectorEngagement,
  thresholds: DemotionThresholds = DEMOTION_THRESHOLDS,
): DemotionVerdict {
  if (engagement.acted > thresholds.maxActed) {
    return { demote: false, reason: `acted on ${engagement.acted} time(s) — still useful here` };
  }
  if (engagement.shown < thresholds.minShown) {
    return {
      demote: false,
      reason: `shown ${engagement.shown} day(s), under the ${thresholds.minShown} needed to judge it`,
    };
  }
  if (engagement.spanDays < thresholds.minSpanDays) {
    return {
      demote: false,
      reason:
        `ignored for ${Math.floor(engagement.spanDays)} days, under the ` +
        `${thresholds.minSpanDays} needed — a bad fortnight is not a verdict`,
    };
  }
  return {
    demote: true,
    reason:
      `shown on ${engagement.shown} days across ${Math.floor(engagement.spanDays)} days ` +
      'with nothing ever acted on',
  };
}

// ─── The stored state ────────────────────────────────────────────────────────

export interface DetectorState {
  propertyId: string;
  detectorId: string;
  stepsDown: number;
  dormant: boolean;
  dormantSince: string | null;
  baselineShown: number;
  baselineActed: number;
  baselineAt: string;
  rearmedAt: string | null;
}

interface StateRow {
  detector_id: string;
  steps_down: number | string;
  dormant: boolean;
  dormant_since: string | null;
  baseline_shown: number | string;
  baseline_acted: number | string;
  baseline_at: string;
  rearmed_at: string | null;
}

const STATE_COLUMNS =
  'detector_id, steps_down, dormant, dormant_since, baseline_shown, baseline_acted, ' +
  'baseline_at, rearmed_at';

function intOf(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toState(propertyId: string, row: StateRow): DetectorState {
  return {
    propertyId,
    detectorId: row.detector_id,
    stepsDown: intOf(row.steps_down),
    dormant: row.dormant === true,
    dormantSince: row.dormant_since,
    baselineShown: intOf(row.baseline_shown),
    baselineActed: intOf(row.baseline_acted),
    baselineAt: row.baseline_at,
    rearmedAt: row.rearmed_at,
  };
}

/**
 * Demotion state for one hotel. Empty map on ANY failure — a broken state read
 * must leave every detector at its declared default and running, never
 * accidentally resting.
 */
export async function loadDetectorStates(propertyId: string): Promise<Map<string, DetectorState>> {
  const out = new Map<string, DetectorState>();
  try {
    const { data, error } = await scopedDb(propertyId)
      .from('finding_detector_state')
      .select(STATE_COLUMNS)
      .limit(500);
    if (error) {
      log.warn('[findings] demotion state unreadable; every check runs at full volume', {
        propertyId,
        err: error.message,
      });
      return out;
    }
    for (const row of (data ?? []) as unknown as StateRow[]) {
      out.set(row.detector_id, toState(propertyId, row));
    }
  } catch (e) {
    log.warn('[findings] demotion state read threw; every check runs at full volume', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

/** Per-detector engagement totals for one hotel, straight off the ledger. */
export async function loadDetectorEngagement(
  propertyId: string,
): Promise<Map<string, { shown: number; acted: number }>> {
  const out = new Map<string, { shown: number; acted: number }>();
  const { data, error } = await scopedDb(propertyId)
    .from('findings')
    .select('detector_id, shown_count, acted_count')
    .limit(5000);
  if (error) throw new Error(`findings engagement read failed: ${error.message}`);

  for (const row of (data ?? []) as unknown as Array<{
    detector_id: string;
    shown_count: number | string;
    acted_count: number | string;
  }>) {
    const current = out.get(row.detector_id) ?? { shown: 0, acted: 0 };
    current.shown += intOf(row.shown_count);
    current.acted += intOf(row.acted_count);
    out.set(row.detector_id, current);
  }
  return out;
}

const MS_PER_DAY = 86_400_000;

export interface DemotionTransition {
  detectorId: string;
  from: EffectiveDisposition;
  to: EffectiveDisposition;
  reason: string;
}

export interface DemotionPass {
  /** State after this pass, for every detector the runner is about to consider. */
  states: Map<string, DetectorState>;
  /** What changed tonight. Recorded on the run and returned to the cron. */
  transitions: DemotionTransition[];
}

/**
 * Evaluate every registered detector against this hotel's own engagement, apply
 * at most one rung of demotion each, and hand the runner the resulting state.
 *
 * Runs BEFORE the detectors do, so tonight's cards already carry tonight's
 * verdict — a detector that just earned rest does not get one more night of
 * being ignored first.
 *
 * Never throws. Demotion is an ergonomics feature over a ledger that is correct
 * without it; a failure here must cost volume control, never a night of
 * detection. On failure the caller gets whatever state it could read, which
 * fails toward every check running loudly.
 */
export async function applyDemotionPass(
  propertyId: string,
  detectors: readonly AnyDetector[],
  now: Date,
  thresholds: DemotionThresholds = DEMOTION_THRESHOLDS,
): Promise<DemotionPass> {
  const states = await loadDetectorStates(propertyId);
  const transitions: DemotionTransition[] = [];

  let engagement: Map<string, { shown: number; acted: number }>;
  try {
    engagement = await loadDetectorEngagement(propertyId);
  } catch (e) {
    log.warn('[findings] engagement read failed; no demotion decisions tonight', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return { states, transitions };
  }

  for (const detector of detectors) {
    const id = detector.declaration.id;
    const totals = engagement.get(id) ?? { shown: 0, acted: 0 };
    const existing = states.get(id);

    // First sight of this detector at this hotel. The baseline starts at
    // TODAY'S totals, not at zero: engagement that predates the state row
    // predates the decision to watch, and counting it would let a detector be
    // demoted on evidence gathered before anyone was keeping score.
    if (!existing) {
      const created = await createState(propertyId, id, totals, now);
      if (created) states.set(id, created);
      continue;
    }

    if (existing.dormant) continue; // already resting; only a human wakes it

    const base = detector.declaration.defaultDisposition;
    if (DEMOTION_LADDER.indexOf(base) === -1) continue; // ask/drop never rest

    const verdict = evaluateDemotion(
      {
        shown: Math.max(0, totals.shown - existing.baselineShown),
        acted: Math.max(0, totals.acted - existing.baselineActed),
        spanDays: Math.max(0, (now.getTime() - new Date(existing.baselineAt).getTime()) / MS_PER_DAY),
      },
      thresholds,
    );
    if (!verdict.demote) continue;

    const from = demoteDisposition(base, existing.stepsDown);
    const stepsDown = Math.min(DEMOTION_LADDER.length, existing.stepsDown + 1);
    const to = demoteDisposition(base, stepsDown);
    const dormant = to === DORMANT;

    const applied = await writeTransition(propertyId, id, {
      stepsDown,
      dormant,
      dormantSince: dormant ? now.toISOString() : null,
      baselineShown: totals.shown,
      baselineActed: totals.acted,
      baselineAt: now.toISOString(),
      transition: {
        at: now.toISOString(),
        from,
        to,
        shown: totals.shown - existing.baselineShown,
        acted: totals.acted - existing.baselineActed,
        reason: verdict.reason,
      },
    });
    if (!applied) continue;

    states.set(id, {
      ...existing,
      stepsDown,
      dormant,
      dormantSince: dormant ? now.toISOString() : null,
      baselineShown: totals.shown,
      baselineActed: totals.acted,
      baselineAt: now.toISOString(),
    });
    transitions.push({ detectorId: id, from, to, reason: verdict.reason });

    log.info('[findings] detector demoted at this hotel', {
      propertyId,
      detectorId: id,
      from,
      to,
      reason: verdict.reason,
    });
  }

  return { states, transitions };
}

async function createState(
  propertyId: string,
  detectorId: string,
  totals: { shown: number; acted: number },
  now: Date,
): Promise<DetectorState | null> {
  const iso = now.toISOString();
  const { error } = await scopedDb(propertyId).from('finding_detector_state').insert({
    detector_id: detectorId,
    steps_down: 0,
    dormant: false,
    dormant_since: null,
    baseline_shown: totals.shown,
    baseline_acted: totals.acted,
    baseline_at: iso,
    transitions: [] as unknown as JsonValue,
  });
  if (error) {
    // A racing runner inserted it first, or the table is not there yet. Either
    // way tonight runs at full volume, which is the safe direction.
    log.warn('[findings] could not open demotion state; running at full volume', {
      propertyId,
      detectorId,
      err: error.message,
    });
    return null;
  }
  return {
    propertyId,
    detectorId,
    stepsDown: 0,
    dormant: false,
    dormantSince: null,
    baselineShown: totals.shown,
    baselineActed: totals.acted,
    baselineAt: iso,
    rearmedAt: null,
  };
}

interface TransitionWrite {
  stepsDown: number;
  dormant: boolean;
  dormantSince: string | null;
  baselineShown: number;
  baselineActed: number;
  baselineAt: string;
  transition: Record<string, JsonValue>;
  rearmedAt?: string | null;
}

/**
 * Append a transition and move the baseline in one update.
 *
 * The transition log is read-then-append rather than a Postgres array push:
 * PostgREST has no `||` on jsonb, and a lost transition costs an audit line,
 * never a wrong state — the state columns in the same update are authoritative.
 */
async function writeTransition(
  propertyId: string,
  detectorId: string,
  write: TransitionWrite,
): Promise<boolean> {
  const db = scopedDb(propertyId);
  const { data: current } = await db
    .from('finding_detector_state')
    .select('transitions')
    .eq('detector_id', detectorId)
    .limit(1);
  const rows = (current ?? []) as unknown as Array<{ transitions: unknown }>;
  const history = Array.isArray(rows[0]?.transitions) ? (rows[0].transitions as unknown[]) : [];

  const patch: Record<string, unknown> = {
    steps_down: write.stepsDown,
    dormant: write.dormant,
    dormant_since: write.dormantSince,
    baseline_shown: write.baselineShown,
    baseline_acted: write.baselineActed,
    baseline_at: write.baselineAt,
    // Bounded: the last 50 transitions is more history than anyone will read,
    // and an unbounded jsonb column on a row updated nightly is a slow leak.
    transitions: [...history, write.transition].slice(-50),
  };
  if (write.rearmedAt !== undefined) patch.rearmed_at = write.rearmedAt;

  const { error } = await db
    .from('finding_detector_state')
    .update(patch)
    .eq('detector_id', detectorId);
  if (error) {
    log.warn('[findings] demotion write failed; the detector keeps its current volume', {
      propertyId,
      detectorId,
      err: error.message,
    });
    return false;
  }
  return true;
}

export interface RearmResult {
  ok: boolean;
  detectorId: string;
  /** False when there was no state to re-arm — an unknown detector, or one that
   *  has never been demoted here. Not an error. */
  changed: boolean;
  error?: string;
}

/**
 * Put a detector back on duty at one hotel.
 *
 * Re-arming resets the rung AND the baseline. That second half is the whole
 * point: without it, the ten ignored shows that rested the check are still
 * sitting in the counters and it would rest again on the very next pass, which
 * would make re-arming a button that visibly does nothing.
 */
export async function rearmDetector(
  propertyId: string,
  detectorId: string,
  now: Date = new Date(),
): Promise<RearmResult> {
  let totals = { shown: 0, acted: 0 };
  try {
    totals = (await loadDetectorEngagement(propertyId)).get(detectorId) ?? totals;
  } catch {
    // Engagement unreadable: re-arm anyway with a zero baseline. The span rule
    // still buys the detector three weeks before it could rest again.
  }

  const states = await loadDetectorStates(propertyId);
  const existing = states.get(detectorId);
  if (!existing) return { ok: true, detectorId, changed: false };

  const from = existing.dormant ? DORMANT : ('' as EffectiveDisposition);
  const applied = await writeTransition(propertyId, detectorId, {
    stepsDown: 0,
    dormant: false,
    dormantSince: null,
    baselineShown: totals.shown,
    baselineActed: totals.acted,
    baselineAt: now.toISOString(),
    rearmedAt: now.toISOString(),
    transition: {
      at: now.toISOString(),
      from: from || 'demoted',
      to: 'rearmed',
      shown: 0,
      acted: 0,
      reason: 'put back on duty by hand',
    },
  });
  return { ok: applied, detectorId, changed: applied };
}
