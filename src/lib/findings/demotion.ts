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
//
// ═══ DECLINING IS NOT THE SAME AS CARING ═══════════════════════════════════
// Founder ruling, 2026-07-26. Until it, ANY engagement vetoed demotion — and
// "Not doing this" is engagement. So a manager who refused this check's cards
// across twenty different rooms was, by the arithmetic, its most enthusiastic
// reader: the loudest available way to say "stop showing me this" guaranteed it
// stayed at full volume forever. Backwards.
//
// Engagement now has two kinds, and they pull in opposite directions:
//
//   POSITIVE  Handled it · Seen (known problem) · the receipt expanded · a
//             one-tap fix approved · an upkeep job logged. Somebody took this
//             check up. It stays loud.
//   NEGATIVE  "Not doing this" — the mute. Somebody read it and refused it.
//             That counts TOWARD quieting, the same direction silence points,
//             with clearer intent behind it.
//
// ONE refusal quiets NOTHING. Muting a card already silences that one problem
// forever, and that behaviour is untouched; a manager who does not want THIS
// leak chased has said nothing about the check that found it. What speaks is a
// PATTERN: five separate problems refused, spread over at least a week, with
// nothing positive anywhere in the same stretch. See DEMOTION_THRESHOLDS for
// why those two numbers.
//
// Positive still wins outright. One "Handled it" anywhere in the window vetoes
// the whole case however many refusals sit beside it — a check that is useful
// on Tuesday is not made useless by twenty rooms it was wrong about on Monday.
//
// AND IT WORKS IN BOTH DIRECTIONS
// A check somebody takes up again climbs back one rung, resting checks
// included. The hand-operated re-arm (rearmDetector) is unchanged and still
// resets everything at once; this is the automatic half, and it exists because
// the alternative is a check that a manager visibly started using again staying
// quiet until somebody remembers there is an admin button for it.

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
  /** POSITIVE engagement above this many resets the case for demoting. Zero:
   *  one person taking this check up once is enough to keep it loud. */
  readonly maxPositiveActed: number;
  /** How long that ignoring has to have been going on. Three weeks. */
  readonly minSpanDays: number;
  /** How many SEPARATE problems have to be refused before the refusals are a
   *  statement about the check rather than about those problems. */
  readonly minDeclinedProblems: number;
  /** And over how long. One afternoon of clearing the queue is a mood. */
  readonly minDeclineSpanDays: number;
  /** Positive engagement at or above this climbs a quietened check back a rung. */
  readonly minRearmPositiveActed: number;
}

/**
 * Conservative on purpose. See the header: a wrong demotion is silent, and a
 * detector that should have demoted and did not merely costs a manager a
 * scroll.
 *
 * WHY FIVE REFUSALS AND WHY A WEEK
 * Five is the smallest number that cannot be a run of bad luck on one kind of
 * problem — a manager rejecting four cards has told us about four rooms, a
 * manager rejecting five distinct problems with no "Handled it" anywhere in the
 * same stretch has told us about the check. The week stops one annoyed morning
 * from counting as a verdict, for exactly the reason three weeks guards the
 * silence path: a mood is not a policy. And five buys ONE rung, so a check does
 * not go from loud to resting until fifteen separate refusals across three
 * separate weeks, every one of them unanswered by a single positive tap.
 */
export const DEMOTION_THRESHOLDS: DemotionThresholds = Object.freeze({
  minShown: 10,
  maxPositiveActed: 0,
  minSpanDays: 21,
  minDeclinedProblems: 5,
  minDeclineSpanDays: 7,
  minRearmPositiveActed: 1,
});

/** What this detector's cards have done at this hotel SINCE the baseline. */
export interface DetectorEngagement {
  /** Distinct hotel-days on which a card from this detector was on screen. */
  shown: number;
  /** EVERY engagement: verdicts, receipts opened, chat taps. Both kinds. */
  acted: number;
  /** Of `acted`, the taps that landed on problems the manager ended up
   *  refusing. Subtracted out to leave the positive half. */
  declineActed: number;
  /** DISTINCT problems muted since the baseline. Distinct is the whole point —
   *  one problem refused twice is one refusal. */
  declinedProblems: number;
  /** Days between the first and the last of those refusals. Zero when there is
   *  only one (or none), which is honest: a single moment has no span. */
  declineSpanDays: number;
  /** Days since the baseline was set. */
  spanDays: number;
}

/**
 * The half of `acted` that means somebody took this check UP. Never negative:
 * see `declineActed` in loadDetectorEngagement for the one case where the
 * subtraction can overshoot, and why it overshoots in the safe direction.
 */
export function positiveEngagement(engagement: DetectorEngagement): number {
  return Math.max(0, engagement.acted - engagement.declineActed);
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
 * TWO WAYS DOWN, ONE VETO OVER BOTH.
 *
 *   the veto      any POSITIVE engagement — handled, seen, receipt opened,
 *                 fix approved. Somebody is using this check. Nothing else in
 *                 this function can outvote that.
 *   refused       five distinct problems muted, spread over a week or more.
 *                 The manager keeps saying "not doing this"; we stop saying it
 *                 so loudly. Checked BEFORE the silence path because when both
 *                 are true the refusals are the truer reason.
 *   ignored       ten shown days across three weeks with nothing at all. The
 *                 original rule, unchanged.
 *
 * A refusal below the threshold does not veto the silence path any more. That
 * is the founder ruling in one line: a "no" is not a reason to keep talking.
 */
export function evaluateDemotion(
  engagement: DetectorEngagement,
  thresholds: DemotionThresholds = DEMOTION_THRESHOLDS,
): DemotionVerdict {
  const positive = positiveEngagement(engagement);
  if (positive > thresholds.maxPositiveActed) {
    return { demote: false, reason: `taken up ${positive} time(s), still useful here` };
  }

  if (engagement.declinedProblems >= thresholds.minDeclinedProblems) {
    if (engagement.declineSpanDays >= thresholds.minDeclineSpanDays) {
      return {
        demote: true,
        reason:
          `"not doing this" on ${engagement.declinedProblems} separate problems across ` +
          `${Math.floor(engagement.declineSpanDays)} days, and nothing here ever taken up`,
      };
    }
    // Deliberately falls through rather than returning: a queue cleared in one
    // sitting says nothing yet, but the same cards may still have been ignored
    // long enough to demote on the silence rule below, and that case is real.
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
        `${thresholds.minSpanDays} needed. A bad fortnight is not a verdict`,
    };
  }
  return {
    demote: true,
    reason:
      `shown on ${engagement.shown} days across ${Math.floor(engagement.spanDays)} days ` +
      'with nothing ever taken up',
  };
}

export interface RearmVerdict {
  rearm: boolean;
  reason: string;
}

/**
 * Should this detector climb back a rung? The mirror of the above, and
 * deliberately far easier to satisfy than demotion was: ONE positive
 * engagement since the last transition, no span requirement, no show
 * requirement.
 *
 * The asymmetry is the same one that governs every threshold in this file. Too
 * loud costs a scroll; too quiet costs the leak nobody was told about. So
 * evidence that a check is wanted is acted on immediately, and evidence that it
 * is not takes weeks to accumulate.
 *
 * Only ever called for a detector that has already been quietened — a check at
 * full volume has nowhere to climb, and calling this for one would reset its
 * baseline every time a manager opened a receipt, which would make the silence
 * path unreachable.
 */
export function evaluateRearm(
  engagement: DetectorEngagement,
  thresholds: DemotionThresholds = DEMOTION_THRESHOLDS,
): RearmVerdict {
  const positive = positiveEngagement(engagement);
  if (positive < thresholds.minRearmPositiveActed) {
    return { rearm: false, reason: 'nothing here has been taken up since it was quietened' };
  }
  return {
    rearm: true,
    reason: `taken up ${positive} time(s) since it was quietened, back up a rung`,
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

/** One problem this hotel refused, and what it cost the counters. */
export interface DeclinedProblem {
  /** The problem's identity. DISTINCT keys are what the threshold counts. */
  dedupeKey: string;
  /** When they said no — `status_changed_at` on the muted row. */
  at: string;
  /** That row's whole `acted_count`. See `declineActed`. */
  acted: number;
}

/** Everything the demotion decision reads about one detector at one hotel. */
export interface DetectorLedger {
  shown: number;
  acted: number;
  declines: DeclinedProblem[];
}

/**
 * Per-detector engagement for one hotel, straight off the ledger.
 *
 * WHY THE REFUSALS ARE DERIVED RATHER THAN COUNTED
 * A mute is already written down exactly once, in the place that matters: the
 * findings row itself goes to `status = 'muted'` with `status_changed_at`
 * stamped, it holds the one-active-row-per-problem slot forever after, and
 * nothing in the engine ever moves it out again (silencer.ts: muted suppresses
 * unconditionally, and only `known_problem` can escalate). So "which distinct
 * problems did this hotel refuse, and when" is answerable exactly from rows
 * that already exist. A `declined_count` column would have been a second,
 * driftable copy of a fact the ledger already holds — and CLAUDE.md's "extend
 * before you add" is at its most literal when the alternative is a migration
 * that stores nothing new.
 *
 * One query, not two: the status columns ride along on the read that was
 * already fetching the counters.
 */
export async function loadDetectorEngagement(
  propertyId: string,
): Promise<Map<string, DetectorLedger>> {
  const out = new Map<string, DetectorLedger>();
  const { data, error } = await scopedDb(propertyId)
    .from('findings')
    .select('detector_id, dedupe_key, status, status_changed_at, shown_count, acted_count')
    .limit(5000);
  if (error) throw new Error(`findings engagement read failed: ${error.message}`);

  for (const row of (data ?? []) as unknown as Array<{
    detector_id: string;
    dedupe_key: string;
    status: string;
    status_changed_at: string | null;
    shown_count: number | string;
    acted_count: number | string;
  }>) {
    const current = out.get(row.detector_id) ?? { shown: 0, acted: 0, declines: [] };
    current.shown += intOf(row.shown_count);
    current.acted += intOf(row.acted_count);
    if (row.status === 'muted' && row.status_changed_at) {
      current.declines.push({
        dedupeKey: row.dedupe_key,
        at: row.status_changed_at,
        acted: intOf(row.acted_count),
      });
    }
    out.set(row.detector_id, current);
  }
  return out;
}

const MS_PER_DAY = 86_400_000;

/** Milliseconds, or null when the stored timestamp is not one. */
function msOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The ledger, narrowed to what has happened SINCE this detector's baseline —
 * the shape `evaluateDemotion` and `evaluateRearm` decide on.
 *
 * `declineActed` is the sum of `acted_count` over the refused rows, not one per
 * refusal. A manager who opens the numbers and THEN says "not doing this" has
 * engaged twice with a card they refused, and counting the first tap as
 * positive would let one moment of curiosity keep a check loud through twenty
 * refusals — which is the exact behaviour the ruling exists to end. The
 * terminal verdict is what the card meant.
 *
 * That sum can overshoot in one narrow case: a card whose receipt was opened
 * BEFORE the baseline and which was refused after it contributes a tap the
 * baseline had already excluded, so it can swallow one genuine positive
 * elsewhere in the window. Bounded (one tap per such card), rare (baselines
 * move only on a transition or a re-arm), and it costs at most one rung of a
 * ladder that takes three to reach rest and re-arms on the next positive tap.
 * The alternative — under-counting refusals — fails in the direction the
 * founder just ruled against.
 */
export function engagementSince(
  ledger: DetectorLedger,
  state: DetectorState,
  now: Date,
): DetectorEngagement {
  const baselineMs = msOf(state.baselineAt);

  // Unparseable baseline: treat the window as empty rather than as unbounded.
  // A detector whose state row is unreadable stays exactly where it is.
  const byKey = new Map<string, DeclinedProblem>();
  if (baselineMs !== null) {
    for (const decline of ledger.declines) {
      const at = msOf(decline.at);
      if (at === null || at < baselineMs) continue;
      // One problem refused more than once is still one refusal; keep the
      // earliest, so the span measures the whole stretch.
      const seen = byKey.get(decline.dedupeKey);
      if (!seen || at < msOf(seen.at)!) byKey.set(decline.dedupeKey, decline);
    }
  }

  const declines = [...byKey.values()];
  const times = declines.map((d) => msOf(d.at)!).sort((a, b) => a - b);

  return {
    shown: Math.max(0, ledger.shown - state.baselineShown),
    acted: Math.max(0, ledger.acted - state.baselineActed),
    declineActed: declines.reduce((sum, d) => sum + d.acted, 0),
    declinedProblems: declines.length,
    declineSpanDays: times.length < 2 ? 0 : (times[times.length - 1] - times[0]) / MS_PER_DAY,
    spanDays:
      baselineMs === null ? 0 : Math.max(0, (now.getTime() - baselineMs) / MS_PER_DAY),
  };
}

export interface DemotionTransition {
  detectorId: string;
  from: EffectiveDisposition;
  to: EffectiveDisposition;
  reason: string;
  /** Which way it moved. A rung climbed BACK is not a demotion, and reporting
   *  one under that heading would make the cron response a small lie. */
  direction: 'down' | 'up';
}

export interface DemotionPass {
  /** State after this pass, for every detector the runner is about to consider. */
  states: Map<string, DetectorState>;
  /** What changed tonight. Recorded on the run and returned to the cron. */
  transitions: DemotionTransition[];
}

/**
 * Evaluate every registered detector against this hotel's own engagement, move
 * it at most ONE rung — down when it has been ignored or repeatedly refused, up
 * when somebody has taken it up again — and hand the runner the resulting
 * state.
 *
 * Runs BEFORE the detectors do, so tonight's cards already carry tonight's
 * verdict — a detector that just earned rest does not get one more night of
 * being ignored first, and one that just earned its volume back does not get
 * one more night of being whispered.
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

  let engagement: Map<string, DetectorLedger>;
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
    const totals = engagement.get(id) ?? { shown: 0, acted: 0, declines: [] };
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

    const base = detector.declaration.defaultDisposition;
    if (DEMOTION_LADDER.indexOf(base) === -1) continue; // ask/drop never rest

    const since = engagementSince(totals, existing, now);

    // ── back up a rung ──────────────────────────────────────────────────────
    // Checked FIRST, and checked for resting detectors too. A resting check
    // still has its last cards on the screen — nothing expires findings for a
    // detector that no longer runs — so "somebody just pressed Handled it on
    // one of these" is a thing that can genuinely happen, and it is the
    // clearest possible statement that this hotel wants the check back. The
    // hand-operated re-arm is unchanged and still resets the whole ladder at
    // once; this only ever moves one rung.
    if (existing.stepsDown > 0) {
      const back = evaluateRearm(since, thresholds);
      if (back.rearm) {
        const from = existing.dormant ? DORMANT : demoteDisposition(base, existing.stepsDown);
        const stepsDown = Math.max(0, existing.stepsDown - 1);
        const to = demoteDisposition(base, stepsDown);

        const applied = await writeTransition(propertyId, id, {
          stepsDown,
          dormant: false,
          dormantSince: null,
          baselineShown: totals.shown,
          baselineActed: totals.acted,
          baselineAt: now.toISOString(),
          transition: {
            at: now.toISOString(),
            from,
            to,
            shown: since.shown,
            acted: since.acted,
            declined: since.declinedProblems,
            reason: back.reason,
          },
        });
        if (!applied) continue;

        states.set(id, {
          ...existing,
          stepsDown,
          dormant: false,
          dormantSince: null,
          baselineShown: totals.shown,
          baselineActed: totals.acted,
          baselineAt: now.toISOString(),
        });
        transitions.push({ detectorId: id, from, to, reason: back.reason, direction: 'up' });

        log.info('[findings] detector taken up again at this hotel', {
          propertyId,
          detectorId: id,
          from,
          to,
          reason: back.reason,
        });
        continue;
      }
    }

    if (existing.dormant) continue; // resting, and nobody has picked it back up

    const verdict = evaluateDemotion(since, thresholds);
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
        shown: since.shown,
        acted: since.acted,
        // On the record next to the counters, because "shown 30 times, acted on
        // 20" and "shown 30 times, refused 20 times" are different hotels and
        // the transition log is where somebody goes to ask which one this was.
        declined: since.declinedProblems,
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
    transitions.push({ detectorId: id, from, to, reason: verdict.reason, direction: 'down' });

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
 *
 * Moving the baseline also clears the refusals: `engagementSince` only counts
 * problems muted at or after `baseline_at`, so a check put back on duty starts
 * with a clean sheet on both paths down, not just the silent one.
 */
export async function rearmDetector(
  propertyId: string,
  detectorId: string,
  now: Date = new Date(),
): Promise<RearmResult> {
  let totals: DetectorLedger = { shown: 0, acted: 0, declines: [] };
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
