// ─── The findings runner ─────────────────────────────────────────────────────
//
// One nightly pass per hotel: load the feeds the registered detectors declared,
// run every detector, and reconcile what they found against what is already in
// the ledger.
//
// THE SILENCER IS SUBSTRATE, NOT A FEATURE
// A detector cannot opt out of dedupe, caps, staleness or the silenced states,
// because a detector never writes. It returns drafts; this file decides what
// happens to them, using the DECLARATION rather than anything the detector
// chose at runtime. A new detector inherits every guarantee by existing.
//
// The guarantee under the guarantee is in Postgres: the partial unique index
// `findings_one_active_per_problem_uq` (migration 0360) means two runners
// racing on the same hotel cannot produce two cards for one problem. The loser
// gets a unique violation and turns its insert into the update it should have
// been. Code politeness would have been enough right up until the night it
// wasn't.
//
// NULL RESULT IS A RESULT
// Every run writes a finding_runs row — how many detectors were registered,
// checked, skipped for want of data, and how many failed. "Checked 3 things,
// all normal" and "the runner has been dead for a week" are otherwise the same
// silence, and the second one is the dangerous one.

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { runWithConcurrency } from '@/lib/parallel';
import type { MessagesClient } from '@/lib/agent/llm';

import { judgeFindingsForProperty } from './judge';
import { writeReplyQuestions } from '@/lib/companion/reply-question';

import {
  DORMANT,
  applyDemotionPass,
  demoteDisposition,
  type DetectorState,
} from './demotion';
import { proposeAction } from './actions/store';
import { allDetectors, requiredFeeds } from './registry';
import { loadFeeds, resolveLoadEnv } from './feeds';
import {
  capDrafts,
  decideAction,
  dedupeDrafts,
  dedupeKeyFor,
} from './silencer';
import {
  escalateFinding,
  expireStaleFindings,
  loadActiveFindings,
  openFinding,
  recordRun,
  refreshFinding,
  toExisting,
  touchSilenced,
  type PersistArgs,
} from './store';
import type {
  AnyDetector,
  DetectorContext,
  FeedId,
  FeedOutcome,
  FindingDisposition,
  FindingRunSummary,
} from './types';
import { isFeedFailure } from './types';

// Registering the detectors is a module side effect; the runner is the one
// place that needs it to have happened.
import './detectors';

export interface FindingsRunOptions {
  /** Override the clock. Injected so the whole run is testable. */
  now?: Date;
  /** Run only these detectors. Everything else is treated as unregistered. */
  detectorIds?: readonly string[];
  /** Evaluate and reconcile in memory, write nothing. */
  dryRun?: boolean;
  /**
   * Skip the judge pass. Detector-focused tests and operator re-runs use it so
   * exercising the ledger costs nothing at the provider. Recorded on the run
   * row as judge_mode='skipped' rather than left blank — a run that chose not
   * to judge and a run whose judge died must not look the same.
   */
  skipJudge?: boolean;
  /** Scripted model for the judge. Production never passes it. */
  judgeModelClient?: MessagesClient;
  /** Scripted model for the question pass. Production never passes it. */
  replyQuestionModelClient?: MessagesClient;
  /**
   * Skip the self-demotion pass: no state is read, no state is written, and
   * every detector runs at its declared volume. Detector-focused tests and
   * one-off operator re-runs use it — a hand-kicked run should not be able to
   * rest a check by accident.
   */
  skipDemotion?: boolean;
}

/** Why a detector said nothing. Skipped ≠ found nothing. */
interface SkipReason {
  detectorId: string;
  because: string;
}

/**
 * Does this detector have what it declared it needs? A detector that reads a
 * feed that failed to load, or a feed with fewer records than it declared a
 * minimum for, is SKIPPED and counted — never run against thin data and never
 * silently treated as "found nothing".
 */
function unmetRequirement(
  detector: AnyDetector,
  feeds: Partial<Record<FeedId, FeedOutcome>>,
): string | null {
  for (const requirement of detector.declaration.requires) {
    const outcome = feeds[requirement.feed];
    if (!outcome) return `feed "${requirement.feed}" was not loaded`;
    if (isFeedFailure(outcome)) return `feed "${requirement.feed}" failed: ${outcome.error}`;
    if (outcome.recordCount < requirement.minRecords) return requirement.because;
  }
  return null;
}

/** One hotel, one night. */
export async function runFindingsForProperty(
  propertyId: string,
  opts: FindingsRunOptions = {},
): Promise<FindingRunSummary> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;

  const registered = allDetectors();
  const detectors = opts.detectorIds
    ? registered.filter((d) => opts.detectorIds!.includes(d.declaration.id))
    : registered;

  const summary: FindingRunSummary = {
    propertyId,
    runDate: '',
    detectorsRegistered: registered.length,
    detectorsChecked: 0,
    detectorsSkipped: 0,
    detectorsFailed: 0,
    detectorsDormant: 0,
    findingsOpened: 0,
    findingsUpdated: 0,
    findingsSuppressed: 0,
    findingsEscalated: 0,
    findingsExpired: 0,
    actionsProposed: 0,
    durationMs: 0,
    errors: [],
    skipped: [],
    dormant: [],
    demotions: [],
    rearms: [],
    judge: { mode: 'skipped', findings: 0, costUsd: 0, guardRejections: 0 },
  };

  const env = await resolveLoadEnv(propertyId, now);
  summary.runDate = env.businessDate;

  // ── SELF-DEMOTION, BEFORE ANYTHING ELSE ─────────────────────────────────
  // A check this hotel has ignored into rest should not cost a feed read
  // tonight, and a check that just stepped down should say tonight's cards
  // quietly rather than getting one more loud night first. Never throws (see
  // demotion.ts) — on any failure every detector runs at its declared volume,
  // which is the safe direction.
  let states = new Map<string, DetectorState>();
  if (!dryRun && !opts.skipDemotion) {
    const pass = await applyDemotionPass(propertyId, detectors, now);
    states = pass.states;
    const asLine = (t: (typeof pass.transitions)[number]) => ({
      detectorId: t.detectorId,
      from: String(t.from),
      to: String(t.to),
      reason: t.reason,
    });
    summary.demotions = pass.transitions.filter((t) => t.direction === 'down').map(asLine);
    summary.rearms = pass.transitions.filter((t) => t.direction === 'up').map(asLine);
  }

  const awake = detectors.filter((detector) => {
    const state = states.get(detector.declaration.id);
    if (!state?.dormant) return true;
    summary.detectorsDormant += 1;
    summary.dormant.push({ detectorId: detector.declaration.id, since: state.dormantSince });
    return false;
  });

  const feeds = await loadFeeds(requiredFeeds(awake), env);
  const skips: SkipReason[] = [];

  for (const detector of awake) {
    const declaration = detector.declaration;

    const unmet = unmetRequirement(detector, feeds);
    if (unmet) {
      summary.detectorsSkipped += 1;
      skips.push({ detectorId: declaration.id, because: unmet });
      continue;
    }

    const ctx: DetectorContext = {
      propertyId,
      now,
      timezone: env.timezone,
      businessDate: env.businessDate,
      feeds,
    };

    let drafts;
    try {
      // Pure. No database handle reaches this call, by construction.
      drafts = capDrafts(
        dedupeDrafts(detector.detect(ctx, declaration.params ?? {})),
        declaration.maxPerRun,
      );
    } catch (e) {
      summary.detectorsFailed += 1;
      summary.errors.push({
        detectorId: declaration.id,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    summary.detectorsChecked += 1;

    if (dryRun) {
      summary.findingsOpened += drafts.length;
      continue;
    }

    const keys = drafts.map((draft) => dedupeKeyFor(declaration.id, draft.key));
    let existing;
    try {
      existing = await loadActiveFindings(propertyId, keys);
    } catch (e) {
      summary.detectorsFailed += 1;
      summary.errors.push({
        detectorId: declaration.id,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    for (let i = 0; i < drafts.length; i += 1) {
      const draft = drafts[i];
      const dedupeKey = keys[i];
      const current = existing.get(dedupeKey) ?? null;
      const action = decideAction(current ? toExisting(current) : null, draft, declaration);

      const args: PersistArgs = {
        propertyId,
        detectorId: declaration.id,
        dedupeKey,
        draft: {
          ...draft,
          // A claim inherits the age of the weakest thing it rests on. The
          // detector may state its own; otherwise the feed's applies.
          asOf: draft.asOf ?? feedAsOf(feeds, declaration.inputs),
          weakestInputAgeDays:
            draft.weakestInputAgeDays ?? feedWeakestAge(feeds, declaration.inputs),
        },
        receiptQueryId: declaration.receiptQueryId,
        // The declared volume, turned down by however many rungs THIS hotel's
        // own indifference has bought. Applied to whichever disposition is in
        // play — a detector that overrode its default per finding is no more
        // exempt from being ignored than one that did not.
        disposition: quietenedDisposition(
          draft.disposition ?? declaration.defaultDisposition,
          states.get(declaration.id)?.stepsDown ?? 0,
        ),
        now,
        // Declaration-driven, like everything else the runner enforces: a
        // detector whose cards can be closed while the problem is still true
        // says which field identifies the occurrence, and the store carries the
        // clock forward when a re-opened row is the SAME occurrence. See
        // `occurrenceMarker` in types.ts for the tap this closes.
        occurrenceMarker: declaration.occurrenceMarker ?? null,
      };

      try {
        switch (action.kind) {
          case 'open': {
            const outcome = await openFinding(args);
            if (outcome === 'opened') summary.findingsOpened += 1;
            else if (outcome === 'updated') summary.findingsUpdated += 1;
            else summary.findingsSuppressed += 1;
            break;
          }
          case 'update':
            await refreshFinding(args, current!.id, action.status);
            summary.findingsUpdated += 1;
            break;
          case 'suppress':
            await touchSilenced(args, current!.id);
            summary.findingsSuppressed += 1;
            break;
          case 'escalate':
            await escalateFinding(args, current!.id);
            summary.findingsEscalated += 1;
            break;
        }

        // ── THE HANDS ──────────────────────────────────────────────────────
        // A card that Staxis can act on arrives with the fix attached. Three
        // gates, all of them here rather than in the detector, so a detector
        // cannot skip one:
        //
        //   • the DECLARATION offers a template at all
        //   • the disposition AFTER demotion is still 'propose' — a check this
        //     hotel has ignored down to a recommendation keeps its card and
        //     loses its button, which is what being ignored should cost
        //   • the finding is not SILENCED — 'suppress' is a manager's "stop
        //     bringing this up", and answering it with a new button would be
        //     the loudest possible way to ignore them
        if (
          declaration.actionTemplate &&
          args.disposition === 'propose' &&
          action.kind !== 'suppress'
        ) {
          const plan = declaration.actionTemplate(args.draft);
          if (plan) {
            const findingId = await findingIdFor(propertyId, dedupeKey, current?.id ?? null);
            if (findingId) {
              const outcome = await proposeAction(propertyId, findingId, plan);
              if (outcome === 'proposed') summary.actionsProposed += 1;
            }
          }
        }
      } catch (e) {
        summary.errors.push({
          detectorId: declaration.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Only a detector that actually RAN may expire its own findings. A
    // detector skipped for want of data has said nothing about whether the
    // problem is still there, and silence is not a clean bill of health.
    try {
      summary.findingsExpired += await expireStaleFindings(
        propertyId,
        declaration.id,
        declaration.staleAfterDays,
        now,
      );
    } catch (e) {
      summary.errors.push({
        detectorId: declaration.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  summary.skipped = skips;

  // ── THE JUDGE ───────────────────────────────────────────────────────────
  // After the ledger is settled, never before. The judge phrases and sorts what
  // the detectors found; letting it run mid-reconcile would mean judging a
  // half-written picture of the hotel.
  //
  // Deliberately NOT inside the detector loop and not per detector: one batched
  // call for the whole hotel is what makes the cost of a night a constant
  // instead of a function of how many detectors are registered.
  //
  // It never throws — a phrasing layer must not be able to fail a run whose
  // findings are already correct without it. Every failure comes back as a mode
  // on the run row instead.
  if (!dryRun && !opts.skipJudge) {
    summary.judge = await judgeFindingsForProperty({
      propertyId,
      now,
      modelClient: opts.judgeModelClient,
    });

    // ── THE QUESTION UNDER THE CARD'S REPLIES ─────────────────────────────
    //
    // AFTER the judge, because it reads the judge's own phrasing: the question
    // is about the sentence the card actually shows, and asking about the
    // detector's raw summary would be asking about a sentence nobody sees.
    //
    // Its own call, its own feature slot, its own spend hold. It could have
    // been two more keys on the judge's reply and cost nothing, and it is not,
    // for two reasons. One is honest bookkeeping: it is switchable in the AI
    // Control Center, and a feature a hotel can point at a different model has
    // to be a feature the ledger can see on its own. The other is blast radius
    // — a malformed question would have taken down the judge's phrasing for
    // twenty-five findings, and there is nothing about a question worth that.
    //
    // It never throws and its failure is invisible: every card keeps the
    // per-kind template question it already had, which is a complete card.
    await writeReplyQuestions({ propertyId, now, modelClient: opts.replyQuestionModelClient });
  }

  summary.durationMs = Date.now() - startedAt;

  if (!dryRun) {
    try {
      await recordRun(summary, now);
    } catch (e) {
      // A missing run row costs liveness reporting, not correctness. Loud, not fatal.
      log.error('[findings] run summary write failed', {
        propertyId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return summary;
}

/**
 * The id of the finding this draft just landed on.
 *
 * Known already on an update or an escalation. On a fresh open it is not —
 * `openFinding` returns what happened, not which row — so one scoped read
 * resolves it. Only runs for action-bearing detectors, which are the rare ones,
 * so this is not a per-finding cost.
 */
async function findingIdFor(
  propertyId: string,
  dedupeKey: string,
  known: string | null,
): Promise<string | null> {
  if (known) return known;
  const rows = await loadActiveFindings(propertyId, [dedupeKey]);
  return rows.get(dedupeKey)?.id ?? null;
}

/**
 * The disposition after demotion, guaranteed to be storable.
 *
 * `demoteDisposition` can land on DORMANT, which is a state, not a disposition
 * — the schema has no such value and a run that reached here with a dormant
 * detector would be a bug in the filter above. Falling back to 'fyi' rather
 * than throwing means the worst case is a card that is quieter than intended,
 * not a night with no findings.
 */
function quietenedDisposition(
  base: FindingDisposition,
  stepsDown: number,
): FindingDisposition {
  const quiet = demoteDisposition(base, stepsDown);
  return quiet === DORMANT ? 'fyi' : quiet;
}

/** The oldest as-of across the feeds a detector declared. */
function feedAsOf(feeds: Partial<Record<FeedId, FeedOutcome>>, inputs: readonly FeedId[]): Date | null {
  let oldest: Date | null = null;
  for (const feed of inputs) {
    const outcome = feeds[feed];
    if (!outcome || isFeedFailure(outcome) || !outcome.asOf) continue;
    if (!oldest || outcome.asOf.getTime() < oldest.getTime()) oldest = outcome.asOf;
  }
  return oldest;
}

/** The weakest (largest) input age across the feeds a detector declared. */
function feedWeakestAge(
  feeds: Partial<Record<FeedId, FeedOutcome>>,
  inputs: readonly FeedId[],
): number | null {
  let worst: number | null = null;
  for (const feed of inputs) {
    const outcome = feeds[feed];
    if (!outcome || isFeedFailure(outcome) || outcome.weakestInputAgeDays === null) continue;
    if (worst === null || outcome.weakestInputAgeDays > worst) worst = outcome.weakestInputAgeDays;
  }
  return worst;
}

export interface FleetRunResult {
  propertiesRun: number;
  summaries: FindingRunSummary[];
}

/**
 * Every hotel. Bounded concurrency, failure-isolated per hotel — one hotel's
 * broken feed must not stop the fleet, and the failure is recorded rather than
 * swallowed.
 */
export async function runFindingsForAllProperties(
  opts: FindingsRunOptions & { concurrency?: number } = {},
): Promise<FleetRunResult> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id')
    .order('id', { ascending: true })
    .limit(5000);
  if (error) throw new Error(`findings property scan failed: ${error.message}`);

  const ids = [...new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))];
  const outcomes = await runWithConcurrency(
    ids,
    (id) => runFindingsForProperty(id, opts),
    Math.max(1, Math.min(opts.concurrency ?? 4, 10)),
  );

  const summaries = outcomes.map((outcome) =>
    outcome.ok
      ? outcome.value
      : ({
          propertyId: outcome.input,
          runDate: '',
          detectorsRegistered: 0,
          detectorsChecked: 0,
          detectorsSkipped: 0,
          detectorsFailed: 1,
          detectorsDormant: 0,
          findingsOpened: 0,
          findingsUpdated: 0,
          findingsSuppressed: 0,
          findingsEscalated: 0,
          findingsExpired: 0,
          actionsProposed: 0,
          durationMs: 0,
          errors: [
            {
              detectorId: '*',
              error:
                outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
            },
          ],
          skipped: [],
          dormant: [],
          demotions: [],
          rearms: [],
          judge: { mode: 'skipped', findings: 0, costUsd: 0, guardRejections: 0 },
        } satisfies FindingRunSummary),
  );

  return { propertiesRun: ids.length, summaries };
}
