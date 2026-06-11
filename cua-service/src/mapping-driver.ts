/**
 * Mapping-driver (Plan v7 Phase 2c).
 *
 * Standalone Playwright runner for `mapper.learn_pms_family` workflow
 * jobs. Owns its own browser context — doesn't depend on an alive
 * SessionDriver. Spawns on-demand when the workflow-runtime claims a
 * mapper job, runs `mapPMS()`, saves a draft knowledge file, and exits.
 *
 * Why a separate driver: the workflow-runtime today only claims jobs
 * for hotels with `alive` drivers. But mapper triggers on
 * `paused_no_knowledge_file` — exactly when no driver is alive (the
 * session-driver paused because it couldn't load a recipe). Sharing
 * SessionDriver's browser would deadlock. Codex v2 P0 fix.
 *
 * Inputs (from workflow_jobs.payload):
 *   { pms_family: string, property_id: string }
 *
 * Outputs (in workflow_jobs.result):
 *   { ok: true, knowledge_file_id: string, targets_found: number,
 *     targets_unavailable: number, targets_failed: number,
 *     spent_micros: number }
 *
 *   { ok: false, error: string }
 *
 * Cost attribution: every Claude call made by this driver logs to
 * claude_usage_log with workload starting 'cua_mapping_' — migration
 * 0208 ensures those rows are tagged source='mapping' and excluded
 * from the per-hotel daily cost cap.
 */

import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { supabase } from './supabase.js';
import { log } from './log.js';
import { mapPMS, type MapperResult } from './mapper.js';
import { safeGoto, UnsafeNavigationError } from './browser-utils/navigate.js';
import { env } from './env.js';
import { signRecipe, isRecipeSigningConfigured } from './recipe-signing.js';
import { checkDailyMappingSpend, microsToDollars } from './cost-cap.js';
import type { PMSCredentials, PMSType, Recipe, ScraperCredentialsRow, LearnedValueTranslations, LearnedDateFormat } from './types.js';
import type { MapperModelId } from './anthropic-client.js';
import { columnsFromAction, missingRequiredColumns } from './target-contract.js';
import type { FeedGaps, FeedGapEntry } from './knowledge-file.js';

export interface MappingJobInput {
  pms_family: string;
  property_id: string;
  /** Optional: override the cost cap for this specific run. Repair jobs
   *  set a tight $2; when absent, a FULL learn defaults to
   *  CUA_FULL_LEARN_COST_CAP_MICROS ($40) — sized so a complete
   *  12-target Opus 4.8 run (~$20-40) finishes instead of dying at the
   *  generic $5 per-job default. */
  cost_cap_micros?: number;
  /** Plan v8 Phase A — per-job Claude model. Defaults to CLAUDE_MODEL
   *  (claude-opus-4-8 since 2026-06-09). Sonnet 4.6 for cheap repairs,
   *  Fable 5 for an unusually hard PMS. */
  model?: MapperModelId;
  /** Plan v8 self-repair — pre-populated actions accumulator. mapPMS
   *  uses this to SKIP targets already in the existing active recipe,
   *  iterating only the ones that need re-learning (typically one).
   *  ~$2 per repair vs ~$25 full re-learn. Session-driver enqueues
   *  repair jobs with this set to currentActiveRecipe.actions minus
   *  the failing target_key. */
  seed_actions?: Recipe['actions'];
  /** feat/pms-universal-translate — carried alongside seed_actions on a partial
   *  repair so the re-mapped recipe preserves the value translation already
   *  learned for the SKIPPED targets (which aren't re-learned). */
  seed_value_translations?: LearnedValueTranslations;
  seed_date_format?: LearnedDateFormat;
  /** feat/cua-partial-promotion — set by the daily backfill cron
   *  (/api/cron/pms-backfill-missing-feeds in the Next app). Seeded like a
   *  self-repair, but the promote-time guard additionally requires the gap
   *  set to SHRINK vs the current active before promoting (a self-repair's
   *  point is same-shape-better-selectors, so it must NOT get that check). */
  backfill_missing_feeds?: boolean;
}

export interface MappingJobResult {
  ok: boolean;
  knowledgeFileId?: string;
  knowledgeFileVersion?: number;
  targetsFound?: number;
  targetsUnavailable?: number;
  targetsFailed?: number;
  spentMicros?: number;
  /** Plan v7 — promotion gate outcome.
   *  - 'auto_promote': draft passed gates AND was promoted to active in
   *    the same transaction. Live drivers will hot-reload to it within
   *    ~60s (session-driver knowledge polling).
   *  - 'park_partial' (feat/cua-partial-promotion, founder-gated): the
   *    recipe met the partial bar but is INCOMPLETE — saved as a draft
   *    with feed gaps recorded in the envelope's `feedGaps`, NOT
   *    activated. The admin reviews what it learned and clicks Promote
   *    (Manage maps → /api/admin/live-mapper/promote); only then does it
   *    go live — with the "still learning" annotations intact, the app's
   *    honesty UI active, and the daily backfill retrying the gaps.
   *  - 'park_draft': draft saved, NOT promoted. Admin sees CTA to review
   *    (self-repair regression / promote-failure / no-progress backfill).
   *  - 'quarantine': draft saved with status='quarantined'. Below the
   *    partial-promotion bar (near-empty recipe); admin must investigate.
   */
  promotionDecision?: 'auto_promote' | 'park_partial' | 'park_draft' | 'quarantine';
  promotionReason?: string;
  error?: string;
}

// Plan v7 promotion-gate criteria.
// Required targets MUST all be found (or quarantine). Business-critical
// net-new targets need ≥ 3 found to auto-promote (otherwise park-as-draft).
const REQUIRED_TARGETS: Array<keyof Recipe['actions']> = [
  'getRoomStatus', 'getArrivals', 'getDepartures', 'getWorkOrders',
];
const BUSINESS_CRITICAL_TARGETS: Array<keyof Recipe['actions']> = [
  'getGuests', 'getRevenueDaily', 'getRatesAndInventory', 'getChannelPerformance',
  'getForecastDaily', 'getGroupsAndBlocks',
];
const MIN_BUSINESS_CRITICAL_FOR_AUTO = 3;

/**
 * feat/cua-partial-promotion — the minimum bar for promoting a recipe with
 * required-feed gaps. A partial recipe ships only if at least ONE complete
 * core operational loop is trustworthy:
 *   - housekeeping loop: getRoomStatus (rooms boards, housekeeper mobile,
 *     dashboard ring — honest under gaps via the app's statusSource
 *     neutralization), OR
 *   - front-desk loop: getArrivals AND getDepartures (BOTH — either alone
 *     implies confidently-wrong checkout/arrival lists).
 * Below the bar (e.g. only getWorkOrders, or only getDepartures) the recipe
 * is near-empty → quarantine, exactly as before this feature. Expressed
 * purely in catalogue target names — zero PMS-specific logic.
 */
function meetsPartialPromotionBar(trustworthy: ReadonlySet<string>): boolean {
  return trustworthy.has('getRoomStatus') ||
    (trustworthy.has('getArrivals') && trustworthy.has('getDepartures'));
}

/**
 * Per-target gap audit for a mapped recipe: required targets that are absent
 * ('not_found') or present-but-dead ('incomplete_columns' — required
 * descriptor columns blank, every row rejected at write time), plus absent
 * business-critical targets. Computed on EVERY gate evaluation and persisted
 * in the signed envelope whenever non-empty (see saveDraftKnowledgeFile), so
 * any promotion path — auto, partial, or manual admin promote of a parked
 * draft — yields a gap-annotated active row for the app's honesty layer.
 */
export function computeFeedGaps(actions: Recipe['actions']): FeedGaps {
  const missingRequired: FeedGapEntry[] = [];
  for (const t of REQUIRED_TARGETS) {
    const action = actions[t];
    if (!action) {
      missingRequired.push({ target: t, reason: 'not_found' });
      continue;
    }
    const missingCols = missingRequiredColumns(t, columnsFromAction(action));
    if (missingCols.length > 0) {
      missingRequired.push({ target: t, reason: 'incomplete_columns', missingColumns: missingCols });
    }
  }
  const found = new Set(Object.keys(actions));
  const missingBusinessCritical = BUSINESS_CRITICAL_TARGETS
    .filter((t) => !found.has(t))
    .map((t) => String(t));
  return {
    computedAt: new Date().toISOString(),
    missingRequired,
    missingBusinessCritical,
  };
}

/**
 * Canonical, order-stable keys for a gap set, used for progress comparison
 * (the backfill promote-guard + its tests). Deliberately EXCLUDES
 * `computedAt` (always differs) and `missingColumns` (a different set of
 * blank columns on the same dead feed is not progress).
 */
export function feedGapEntryKeys(gaps: FeedGaps): string[] {
  return [
    ...gaps.missingRequired.map((g) => `required:${g.target}:${g.reason}`),
    ...gaps.missingBusinessCritical.map((t) => `bc:${t}`),
  ].sort();
}

// ─── Live event broadcast (Plan v8 Phase B chunk 2) ─────────────────────
//
// The Live Mapping admin console subscribes to two Supabase realtime
// channels for each in-flight mapper job:
//   1. postgres_changes on mapping_help_requests filtered by job_id —
//      drives the help-request panel (Phase B chunk 1 wired this).
//   2. broadcast channel `mapping:{jobId}` — drives the activity feed
//      (this file).
//
// This is intentionally COARSE-GRAINED for v1: lifecycle events only
// (start, preflight_passed, mapping_started, target_started,
// target_completed, mapping_completed). Per-action streaming + screenshot
// frames are deferred to a follow-up — the admin can already see "what
// target the agent is on" + "is anything stuck waiting for me" from
// these events.

type MappingEventType =
  | 'mapping_started'
  | 'preflight_passed'
  | 'preflight_failed'
  | 'mapping_in_progress'   // generic progress tick from mapPMS onProgress
  | 'mapping_completed'
  | 'mapping_failed';

interface MappingEvent {
  type: MappingEventType;
  jobId: string;
  label?: string;       // human-readable progress label
  pct?: number;         // 0-100 for the progress bar
  detail?: Record<string, unknown>;
  at: string;           // ISO timestamp
}

/**
 * Plan v8 hardening (Codex P1) — channel-per-job, not channel-per-event.
 *
 * Earlier version created and unsubscribed a fresh Supabase realtime
 * channel for every progress event. At 300 hotels × ~50 events per job
 * that's 15K channel lifecycle cycles per onboarding wave, which churns
 * the realtime WebSocket pool harder than Supabase's per-connection
 * limits expect.
 *
 * Now: openBroadcastChannel(jobId) at the top of runMappingJob, all
 * subsequent broadcasts reuse it, closeBroadcastChannel(channel) in the
 * finally block. One channel per job lifecycle.
 */
type MappingBroadcastChannel = ReturnType<typeof supabase.channel>;

/**
 * Plan v8 final review A1 — open AND subscribe the channel so subsequent
 * .send() calls go over the persistent WebSocket. Without .subscribe(),
 * Supabase JS silently falls back to a REST POST per send — defeating
 * the channel-per-job optimization. We subscribe with a 3s timeout so a
 * flaky realtime endpoint doesn't block job startup (graceful degrade
 * to REST-per-send on timeout — that's the OLD behavior, not worse).
 */
async function openBroadcastChannel(jobId: string): Promise<MappingBroadcastChannel> {
  const channel = supabase.channel(`mapping:${jobId}`);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 3_000);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' ||
          status === 'CLOSED' || status === 'TIMED_OUT') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return channel;
}

async function broadcastMappingEvent(
  channel: MappingBroadcastChannel | null,
  evt: MappingEvent,
): Promise<void> {
  if (!channel) return;
  try {
    await channel.send({
      type: 'broadcast',
      event: evt.type,
      payload: evt,
    });
  } catch (err) {
    // Best-effort — never let a broadcast failure abort the mapper.
    log.warn('mapping-driver: broadcast failed (non-fatal)', {
      jobId: evt.jobId, type: evt.type,
      err: (err as Error).message,
    });
  }
}

async function closeBroadcastChannel(channel: MappingBroadcastChannel | null): Promise<void> {
  if (!channel) return;
  try { await channel.unsubscribe(); } catch { /* noop */ }
}

/**
 * Run a mapping job end-to-end. Called by the workflow-runtime's
 * mapper-kind handler.
 */
export async function runMappingJob(
  input: MappingJobInput,
  jobId: string,
  signal: AbortSignal,
): Promise<MappingJobResult> {
  log.info('mapping-driver: starting', {
    jobId,
    pmsFamily: input.pms_family,
    propertyId: input.property_id,
  });

  // Plan v8 final review B1 — org-wide daily mapping spend cap. Per-job
  // cap stops a single run from bleeding past its budget; THIS stops the
  // 300-hotel wave from aggregate-bombing even if each individual run
  // honored its per-job cap. Check BEFORE opening the channel + browser
  // so a paused run leaves zero side effects.
  const dailyCap = await checkDailyMappingSpend();
  if (dailyCap.over) {
    log.warn('mapping-driver: refusing — org daily mapping spend cap exceeded', {
      jobId,
      spentDollars: microsToDollars(dailyCap.spentMicros),
      capDollars: microsToDollars(dailyCap.capMicros),
    });
    return {
      ok: false,
      error: `org daily mapping spend cap exceeded ($${microsToDollars(dailyCap.spentMicros).toFixed(2)} of $${microsToDollars(dailyCap.capMicros).toFixed(2)}). Raise CUA_DAILY_MAPPING_SPEND_CAP_MICROS via fly secrets to unblock.`,
    };
  }

  // Plan v8 hardening — one realtime channel per job, reused across all
  // lifecycle events. Closed in the finally block at the bottom.
  const channel: MappingBroadcastChannel = await openBroadcastChannel(jobId);

  try {
  // Plan v8 Phase B chunk 2 — Live Mapping admin UI watches for these.
  await broadcastMappingEvent(channel, {
    type: 'mapping_started',
    jobId,
    label: 'Starting',
    pct: 5,
    detail: { pmsFamily: input.pms_family, propertyId: input.property_id },
    at: new Date().toISOString(),
  });

  // 1. Load credentials for the representative property.
  const credentials = await loadCredentials(input.property_id);
  if (!credentials) {
    return { ok: false, error: 'no active scraper_credentials for representative property' };
  }

  // 1.5. Pre-flight check: try to actually load the login URL with no
  //      Claude involvement at all. If the URL is wrong, the PMS is down,
  //      it redirects to a different domain, or it serves a non-login
  //      page (T&C wall, maintenance page), abort with $0 spent on the
  //      Anthropic API. This is the single biggest money-saver: failed
  //      mapping runs that were going to fail anyway now cost $0 instead
  //      of $4-10. Adds ~5-15s to the happy path.
  //
  //      Vision-only preflight (Plan v8 D.2): accepts either an
  //      input[type="password"] DOM hint OR a canvas-rendered login page
  //      (the latter is the exact PMS shape vision is for).
  log.info('mapping-driver: pre-flight starting', { jobId, loginUrl: credentials.loginUrl });
  const preflight = await preflightLoginPage(credentials.loginUrl, signal);
  if (!preflight.ok) {
    log.warn('mapping-driver: pre-flight failed — aborting before Claude is called', {
      jobId,
      reason: preflight.reason,
    });
    await broadcastMappingEvent(channel, {
      type: 'preflight_failed',
      jobId,
      label: 'Pre-flight failed',
      detail: { reason: preflight.reason },
      at: new Date().toISOString(),
    });
    return { ok: false, error: `pre-flight check failed (no Claude spend): ${preflight.reason}` };
  }
  log.info('mapping-driver: pre-flight passed', { jobId });
  await broadcastMappingEvent(channel, {
    type: 'preflight_passed',
    jobId,
    label: 'Login URL OK',
    pct: 15,
    at: new Date().toISOString(),
  });

  // 2. Run mapPMS. The mapper opens its own browser via chromium.launch.
  // Plan v8 review P0-A: thread per-job cost cap through. Without this
  // vision-mode jobs would hit the DOM mode's $5 env default and abort.
  // 2026-06-09: when the trigger didn't set a cap (auto-enqueue from
  // paused_no_knowledge_file, admin regenerate), default a FULL learn to
  // CUA_FULL_LEARN_COST_CAP_MICROS ($40) — a complete 12-target Opus 4.8
  // run costs ~$20-40, so the generic $5 default would kill it half-way
  // and park a partial recipe.
  const result = await mapPMS({
    credentials,
    pmsType: input.pms_family as PMSType,
    propertyId: input.property_id,
    jobId,
    signal,
    model: input.model,
    jobCostCapMicros: input.cost_cap_micros ?? env.CUA_FULL_LEARN_COST_CAP_MICROS,
    // Plan v8 self-repair — pre-seed the actions accumulator so the
    // mapper only iterates targets NOT in this set. Empty for full
    // mappings (fresh PMS family); populated for repairs.
    seedActions: input.seed_actions,
    seedValueTranslations: input.seed_value_translations,
    seedDateFormat: input.seed_date_format,
    onProgress: (label, pct) => {
      log.info('mapping-driver: progress', { jobId, label, pct });
      // Plan v8 Phase B chunk 2 — pipe mapper progress to the Live
      // Mapping admin UI. mapper.ts emits these from mapPMS at:
      // login start/done, each target start, each target done. Fire-
      // and-forget; broadcastMappingEvent never throws.
      void broadcastMappingEvent(channel, {
        type: 'mapping_in_progress',
        jobId,
        label,
        pct,
        at: new Date().toISOString(),
      });
    },
  });

  if (!result.ok) {
    await broadcastMappingEvent(channel, {
      type: 'mapping_failed',
      jobId,
      label: 'Mapping failed',
      detail: { reason: result.userMessage },
      at: new Date().toISOString(),
    });
    return { ok: false, error: result.userMessage };
  }

  // 3. Evaluate the auto-promotion gate (Plan v7 — replaces the "≥60%
  //    of targets" magic number with required-target-class checks).
  const gate = evaluatePromotionGate(result.recipe, input.seed_actions);
  log.info('mapping-driver: promotion gate evaluated', {
    jobId, decision: gate.decision, reason: gate.reason,
  });

  // 3.5. feat/cua-partial-promotion — promote-time guards for SEEDED jobs.
  //      A seeded job's seed snapshot can go stale: another repair/backfill
  //      may have promoted a better active while this job sat queued (the
  //      no-driver lane runs mapper jobs serially). The gate's seed guard
  //      only compares against THIS job's seed, so without re-checking the
  //      CURRENT active a stale-seeded result could go live (auto_promote)
  //      or be offered to the admin (park_partial) while silently lacking
  //      a feed the family just gained. Backfills additionally must make
  //      actual gap progress — a backfill that re-found the same dead feed
  //      would otherwise park an equal-quality draft daily (noise for the
  //      admin, and it would defeat the cron's no-progress breaker, which
  //      counts park_partial as progress).
  if ((gate.decision === 'auto_promote' || gate.decision === 'park_partial') && input.seed_actions) {
    const guard = await checkSeededPromotionGuards(
      input.pms_family,
      result.recipe,
      gate.feedGaps,
      input.backfill_missing_feeds === true,
    );
    if (!guard.ok) {
      // Hunter re-review P1-2: a BACKFILL that made no gap progress must not
      // persist a draft at all — its content is identical-in-coverage to the
      // active, the admin has nothing to review, and (founder-gated flow)
      // the cron's draft-awaiting-review gate would latch on it FOREVER,
      // silently killing the promised daily retries after attempt #1. The
      // job result still records the park_draft outcome (breaker counts it);
      // stale-seed parks DO save — those are genuinely reviewable.
      if (guard.skipSave) {
        log.warn('mapping-driver: backfill made no gap progress — not persisting a draft', {
          jobId, reason: guard.reason,
        });
        await broadcastMappingEvent(channel, {
          type: 'mapping_completed',
          jobId,
          label: 'Done — park_draft (no progress, draft not saved)',
          pct: 100,
          detail: { promotionDecision: 'park_draft', promotionReason: guard.reason },
          at: new Date().toISOString(),
        });
        return {
          ok: true,
          promotionDecision: 'park_draft',
          promotionReason: guard.reason,
          ...computeStats(result),
        };
      }
      log.warn('mapping-driver: seeded promotion guard parked the draft', {
        jobId, reason: guard.reason,
      });
      gate.decision = 'park_draft';
      gate.reason = guard.reason;
    }
  }

  // 4. Save the draft knowledge file with the right status.
  //    auto_promote → save as draft, then promote in step 5
  //    park_partial → save as draft with feedGaps; NOT activated — the
  //      admin clicks Promote (founder-gated; the honesty UI + daily
  //      backfill take over once it's live)
  //    park_draft → save as draft, admin reviews
  //    quarantine → save with status='quarantined', admin investigates
  //    feedGaps are embedded whenever non-empty REGARDLESS of decision, so a
  //    parked draft an admin later promotes manually still carries them.
  const initialStatus = gate.decision === 'quarantine' ? 'quarantined' : 'draft';
  const draft = await saveDraftKnowledgeFile(
    input.pms_family, result.recipe, initialStatus, gate.feedGaps,
    // Hunter re-review P2-5 — the admin reviewing Manage maps needs to see
    // WHY a draft parked, not just which targets it has.
    `${gate.decision}: ${gate.reason}`,
  );
  if (!draft.ok) {
    return { ok: false, error: `recipe mapped successfully but draft save failed: ${draft.error}` };
  }

  // 5. ONLY a complete recipe auto-activates (founder decision 2026-06-11:
  //    every INCOMPLETE recipe waits for his Promote click — park_partial
  //    stays a draft here; shouldActivateImmediately is the pinned seam).
  //    Atomically demote prior active + promote this draft. The partial
  //    unique index pms_knowledge_files_one_active_per_family (migration
  //    0201) means we MUST demote before promote or the second update
  //    fails. Doing both serially is fine — the index enforces
  //    post-condition.
  if (shouldActivateImmediately(gate.decision)) {
    const promoted = await promoteDraft(input.pms_family, draft.id);
    if (!promoted.ok) {
      log.warn('mapping-driver: promotion failed, leaving as draft', {
        jobId, knowledgeFileId: draft.id, reason: promoted.error,
      });
      // Still return ok — the draft is saved; admin can promote
      // manually. Decision is downgraded to park_draft for clarity.
      gate.decision = 'park_draft';
      gate.reason = `promotion failed: ${promoted.error}`;
    } else {
      // Hunter re-review P1-1 — a family whose first learn just completed
      // has its session(s) parked at paused_no_knowledge_file, and the
      // supervisor only respawns starting/alive/paused_cost_cap. Without
      // this nudge the recipe is active but no robot ever polls it. Same
      // revive the admin promote route performs.
      await reviveNoKnowledgeSessions(input.pms_family);
    }
  }

  const stats = computeStats(result);
  log.info('mapping-driver: complete', {
    jobId,
    knowledgeFileId: draft.id,
    knowledgeFileVersion: draft.version,
    promotionDecision: gate.decision,
    ...stats,
  });

  await broadcastMappingEvent(channel, {
    type: 'mapping_completed',
    jobId,
    label: `Done — ${gate.decision}`,
    pct: 100,
    detail: {
      knowledgeFileId: draft.id,
      knowledgeFileVersion: draft.version,
      promotionDecision: gate.decision,
      promotionReason: gate.reason,
      ...stats,
    },
    at: new Date().toISOString(),
  });

  return {
    ok: true,
    knowledgeFileId: draft.id,
    knowledgeFileVersion: draft.version,
    promotionDecision: gate.decision,
    promotionReason: gate.reason,
    ...stats,
  };
  } finally {
    // Plan v8 hardening — close the per-job channel once, regardless of
    // success/failure/exception. Without this finally a thrown exception
    // would leak the WebSocket channel handle.
    await closeBroadcastChannel(channel);
  }
}

// ─── Promotion gate ────────────────────────────────────────────────────

export function evaluatePromotionGate(
  recipe: Recipe,
  seedActions?: Recipe['actions'],
): {
  decision: 'auto_promote' | 'park_partial' | 'park_draft' | 'quarantine';
  reason: string;
  feedGaps: FeedGaps;
} {
  const found = new Set(Object.keys(recipe.actions));
  const feedGaps = computeFeedGaps(recipe.actions);

  // Plan v8 self-repair guard — a repair job seeds the existing recipe's
  // actions (minus the one failing target) and re-learns just that one,
  // so a successful repair yields seed-count + 1 actions. If the re-learn
  // FAILS the mapper hands back a recipe with FEWER actions than the seed,
  // yet the checks below could still promote it — silently dropping the
  // feed forever. Park it as a draft for review instead of letting a
  // partial repair (or a missing-feed backfill that found nothing) regress
  // live coverage.
  if (seedActions && Object.keys(recipe.actions).length < Object.keys(seedActions).length + 1) {
    return {
      decision: 'park_draft',
      reason: `self-repair failed to re-learn the target — mapped recipe has ${Object.keys(recipe.actions).length} actions vs seed's ${Object.keys(seedActions).length} (expected ≥ ${Object.keys(seedActions).length + 1}); parking as draft so a repair never drops a working feed`,
      feedGaps,
    };
  }

  // feat/cua-partial-promotion — a required target counts as TRUSTWORTHY only
  // when its key exists AND its learned column map has every required
  // descriptor column non-blank. A present-but-incomplete feed writes ZERO
  // rows at runtime (validateRows rejects every row), so for promotion
  // purposes it is exactly as dead as a missing one; it lands in
  // feedGaps.missingRequired with reason 'incomplete_columns'.
  //
  // INTENTIONAL on seeded paths: gaps scan ALL required targets, including
  // seeded ones — a repair/backfill must not promote a recipe whose
  // pre-existing seeded feed is dead without recording that gap. (Carried
  // over from fix/mapper-field-contract; do not narrow to relearned targets.)
  const gappedRequired = new Set(feedGaps.missingRequired.map((g) => g.target));
  const trustworthyRequired = new Set<string>(
    REQUIRED_TARGETS.map((t) => String(t)).filter((t) => !gappedRequired.has(t)),
  );
  const businessCriticalFound = BUSINESS_CRITICAL_TARGETS.filter((t) => found.has(t));

  // All 4 required trustworthy → the pre-existing full path.
  if (feedGaps.missingRequired.length === 0) {
    if (businessCriticalFound.length >= MIN_BUSINESS_CRITICAL_FOR_AUTO) {
      return {
        decision: 'auto_promote',
        reason: `all required + ${businessCriticalFound.length}/${BUSINESS_CRITICAL_TARGETS.length} business-critical (${businessCriticalFound.join(', ')})`,
        feedGaps,
      };
    }
    // Founder decision 2026-06-11: INCOMPLETE recipes never auto-activate —
    // they park as a gap-annotated draft for his Promote click (Manage
    // maps). Monotonicity still holds: a 4/4-required recipe parks exactly
    // like a 3/4 one that meets the bar below; neither ships without him.
    // The BC gaps are recorded in feedGaps so the promoted file goes live
    // with the honesty annotations + daily backfill retries intact.
    return {
      decision: 'park_partial',
      reason: `all required found but only ${businessCriticalFound.length}/${BUSINESS_CRITICAL_TARGETS.length} business-critical (need ${MIN_BUSINESS_CRITICAL_FOR_AUTO} for full promotion) — parked for admin review; missing business-critical recorded for retry: ${feedGaps.missingBusinessCritical.join(', ')}`,
      feedGaps,
    };
  }

  // Some required feeds are missing/dead. If at least one complete core
  // operational loop survives, the recipe is WORTH the admin's review —
  // park it as a gap-annotated draft for the Promote click (founder-gated;
  // never auto-activated). Otherwise it's near-empty and quarantines
  // exactly as before this feature.
  if (meetsPartialPromotionBar(trustworthyRequired)) {
    const gapSummary = feedGaps.missingRequired
      .map((g) => g.reason === 'incomplete_columns'
        ? `${g.target} (dead — missing columns: ${(g.missingColumns ?? []).join(', ')})`
        : g.target)
      .join('; ');
    return {
      decision: 'park_partial',
      reason: `partial recipe parked for admin review — trustworthy: ${[...trustworthyRequired].join(', ')}; still missing required: ${gapSummary}${feedGaps.missingBusinessCritical.length > 0 ? `; missing business-critical: ${feedGaps.missingBusinessCritical.join(', ')}` : ''}`,
      feedGaps,
    };
  }

  return {
    decision: 'quarantine',
    reason: `below the partial-promotion bar (need getRoomStatus, or getArrivals + getDepartures, learned and complete) — missing/dead required targets: ${feedGaps.missingRequired.map((g) => `${g.target} (${g.reason})`).join(', ')}`,
    feedGaps,
  };
}

/**
 * feat/cua-partial-promotion — promote-time re-check of a SEEDED job's result
 * against the CURRENT active knowledge file (the gate's seed guard only sees
 * the job's own — possibly stale — seed snapshot).
 *
 *  1. Superset guard (self-repair AND backfill): every action key on the
 *     current active must exist in the new recipe. If the active advanced
 *     while this job was queued/running, promoting the stale-seeded result
 *     would silently drop the newly-gained feed.
 *  2. Gap-shrink guard (backfill ONLY): the new gap set must be a strict
 *     subset of the active's. A backfill that found nothing new (e.g.
 *     re-learned the same incomplete feed) parks instead of churning a new
 *     active version daily — which also makes "no progress" reliably visible
 *     to the cron's circuit breaker as promotion_decision='park_draft'.
 *     NOT applied to self-repair: its entire point is same-shape recipes
 *     with better selectors. NOT applied to unseeded full learns: an admin
 *     regenerate may legitimately drop a feed the PMS no longer exposes.
 *
 * Fail-safe shape: no current active (deleted/quarantined since enqueue) →
 * proceed (anything is better than nothing); query error → park (admin can
 * promote the draft manually). Read-only — never writes the envelope.
 * Atomicity note: check-then-promote keeps promoteDraft's existing
 * non-transactional semantics; mapper jobs run serially in one lane, so the
 * residual race is admin-manual-promote-vs-job, same as before this feature.
 */
async function checkSeededPromotionGuards(
  pmsFamily: string,
  newRecipe: Recipe,
  newGaps: FeedGaps,
  isBackfill: boolean,
): Promise<{ ok: true } | { ok: false; reason: string; skipSave?: boolean }> {
  const { data, error } = await supabase
    .from('pms_knowledge_files')
    .select('version, knowledge')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      reason: `could not verify the current active recipe before promoting a seeded result (${error.message}) — parking for admin review`,
    };
  }
  if (!data) return { ok: true };
  return evaluateSeededPromotionGuard(
    {
      version: data.version as number,
      knowledge: (data.knowledge ?? {}) as { actions?: Record<string, unknown>; feedGaps?: FeedGaps },
    },
    newRecipe.actions,
    newGaps,
    isBackfill,
  );
}

/** Pure decision core of checkSeededPromotionGuards — exported for tests.
 *  `skipSave: true` on the no-gap-progress backfill failure means "do not
 *  even persist this draft" (coverage-identical to the active; saving it
 *  would latch the cron's draft-awaiting-review gate forever). */
export function evaluateSeededPromotionGuard(
  active: { version: number; knowledge: { actions?: Record<string, unknown>; feedGaps?: FeedGaps } },
  newActions: Recipe['actions'],
  newGaps: FeedGaps,
  isBackfill: boolean,
): { ok: true } | { ok: false; reason: string; skipSave?: boolean } {
  const activeActions = Object.keys(active.knowledge.actions ?? {});
  const newActionKeys = new Set(Object.keys(newActions));
  const dropped = activeActions.filter((k) => !newActionKeys.has(k));
  if (dropped.length > 0) {
    return {
      ok: false,
      reason: `active recipe advanced during this job — promoting would drop now-live feed(s): ${dropped.join(', ')} (active v${active.version}); parking for admin review`,
    };
  }

  if (isBackfill) {
    const activeGaps = active.knowledge.feedGaps
      ?? computeFeedGaps((active.knowledge.actions ?? {}) as Recipe['actions']);
    const activeKeys = new Set(feedGapEntryKeys(activeGaps));
    const newKeys = feedGapEntryKeys(newGaps);
    const isSubset = newKeys.every((k) => activeKeys.has(k));
    if (!isSubset || newKeys.length >= activeKeys.size) {
      return {
        ok: false,
        reason: `backfill made no gap progress vs active v${active.version} (active gaps: ${activeKeys.size}, new gaps: ${newKeys.length}) — outcome recorded, draft not saved`,
        skipSave: true,
      };
    }
  }
  return { ok: true };
}

/**
 * THE founder gate, as a pure seam (hunter re-review P2-6): only a COMPLETE
 * recipe activates itself; every other outcome waits for a human. Pinned by
 * the contract tests so a future `|| 'park_partial'` can't sneak activation
 * back in without a red test.
 */
export function shouldActivateImmediately(
  decision: 'auto_promote' | 'park_partial' | 'park_draft' | 'quarantine',
): boolean {
  return decision === 'auto_promote';
}

/**
 * Flip sessions parked at paused_no_knowledge_file back to 'starting' so the
 * supervisor respawns them (≤30s) now that an active recipe exists. Best-
 * effort: a failure only delays polling until the next nightly restart.
 */
async function reviveNoKnowledgeSessions(pmsFamily: string): Promise<void> {
  const { error } = await supabase
    .from('property_sessions')
    .update({ status: 'starting', paused_reason: null, paused_until: null })
    .eq('pms_family', pmsFamily)
    .eq('status', 'paused_no_knowledge_file');
  if (error) {
    log.warn('mapping-driver: could not revive paused_no_knowledge_file sessions', {
      pmsFamily, err: error.message,
    });
  }
}

async function promoteDraft(
  pmsFamily: string,
  newDraftId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Demote prior active first (partial unique index enforces one active
  // per family — promote-before-demote would violate it).
  const { error: demErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'deprecated', deprecated_at: new Date().toISOString() })
    .eq('pms_family', pmsFamily)
    .eq('status', 'active');
  if (demErr) return { ok: false, error: `demote failed: ${demErr.message}` };

  const { error: promErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'active', promoted_to_active_at: new Date().toISOString() })
    .eq('id', newDraftId);
  if (promErr) return { ok: false, error: `promote failed: ${promErr.message}` };

  return { ok: true };
}

// ─── Pre-flight check ───────────────────────────────────────────────────

/**
 * Sanity-check the login URL before spending any Claude tokens. Catches:
 *  - Wrong/stale URL (404, no DNS, bad scheme)
 *  - PMS down (timeout, 5xx, no response)
 *  - T&C wall / maintenance page (no `<input type="password">` on the
 *    landing page — a legitimate PMS login always exposes one)
 *  - Unsafe URLs (private IP, non-http(s) scheme) via safeGoto's checks
 *
 * Goes through safeGoto so all the URL safety guards apply. NEVER calls
 * Anthropic, so the worst case is ~$0 + 20s of compute vs the mapper
 * agent's $4-10 + 5-45min when it fails the same way deeper in.
 *
 * Note on the selector check: we look for `input[type="password"]` as
 * proof of a real login form. This is the single workhorse signal — a
 * 404 page, T&C wall, maintenance page, or redirect to a vendor's
 * marketing site all reliably fail it. A correct login page always
 * exposes one.
 */
async function preflightLoginPage(
  loginUrl: string,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (signal.aborted) {
    return { ok: false, reason: 'job aborted before pre-flight could start' };
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);

    // Honor the workflow's AbortController — kill the browser if the
    // caller cancels mid-pre-flight.
    const abortHandler = () => {
      browser?.close().catch(() => {});
    };
    signal.addEventListener('abort', abortHandler);

    try {
      // First navigation of the job — `allowedHost: null` per safeGoto's
      // contract (this is what establishes the PMS session host).
      try {
        await safeGoto(page, loginUrl, {
          allowedHost: null,
          context: 'mapping-driver-preflight',
          waitUntil: 'domcontentloaded',
          timeoutMs: 15_000,
        });
      } catch (err) {
        if (err instanceof UnsafeNavigationError) {
          return { ok: false, reason: `unsafe login URL (${err.reason}): ${err.message.slice(0, 200)}` };
        }
        return { ok: false, reason: `failed to load: ${(err as Error).message.slice(0, 200)}` };
      }

      // Look for a password input — proves this is a real login form.
      // If absent, accept canvas-rendered login pages (the exact PMS shape
      // vision mode handles). Otherwise this is likely a T&C page,
      // maintenance page, or a vendor URL change.
      try {
        await page.waitForSelector('input[type="password"]', {
          timeout: 5_000,
          state: 'attached',
        });
        return { ok: true };
      } catch {
        const isCanvasLogin = await page.evaluate(() => {
          const hasCanvas = document.querySelector('canvas') !== null;
          if (!hasCanvas) return false;
          const text = (document.body?.innerText ?? '').toLowerCase();
          return text.includes('login') || text.includes('password') ||
                 text.includes('sign in') || text.includes('sign-in');
        }).catch(() => false);
        if (isCanvasLogin) {
          return { ok: true };
        }
        const finalUrl = page.url().slice(0, 120);
        return {
          ok: false,
          reason: `no password input AND no canvas login on ${finalUrl} — likely T&C, maintenance, or wrong URL`,
        };
      }
    } finally {
      signal.removeEventListener('abort', abortHandler);
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ─── Internals ──────────────────────────────────────────────────────────

async function loadCredentials(propertyId: string): Promise<PMSCredentials | null> {
  const { data, error } = await supabase
    .from('scraper_credentials_decrypted')
    .select('ca_login_url, ca_username, ca_password, is_active')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as ScraperCredentialsRow;
  return {
    loginUrl: row.ca_login_url,
    username: row.ca_username,
    password: row.ca_password,
  };
}

async function saveDraftKnowledgeFile(
  pmsFamily: string,
  recipe: Recipe,
  status: 'draft' | 'quarantined' = 'draft',
  feedGaps?: FeedGaps,
  gateNote?: string,
): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  // Find the highest existing version for this family; new version = max+1.
  const { data: existing, error: selErr } = await supabase
    .from('pms_knowledge_files')
    .select('version')
    .eq('pms_family', pmsFamily)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selErr) return { ok: false, error: `version lookup failed: ${selErr.message}` };
  const nextVersion = ((existing?.version as number | undefined) ?? 0) + 1;

  // Recipe → knowledge file jsonb shape. The recipe-adapter handles the
  // detailed translation; here we wrap the recipe in the knowledge file
  // envelope expected by `pms_knowledge_files.knowledge` (per migration
  // 0203's seeded shape).
  const knowledge = {
    schema: 1,
    description: recipe.description ?? `Auto-mapped by mapping-driver (v${nextVersion})`,
    login: recipe.login,
    actions: recipe.actions,
    hints: recipe.hints ?? {},
    // feat/pms-universal-translate — persist self-learned value translation in
    // the SAME envelope that gets signed (so verifyRecipe at load stays
    // consistent) and reloaded by the session-driver. Only present when the
    // mapper actually learned them, so recipes without them keep their exact
    // prior signed shape.
    ...(recipe.valueTranslations ? { valueTranslations: recipe.valueTranslations } : {}),
    ...(recipe.dateFormat ? { dateFormat: recipe.dateFormat } : {}),
    // feat/cua-partial-promotion — persist which feeds are missing/dead so
    // the app's honesty layer (src/lib/pms/feed-status.ts) can mark them
    // "still learning" instead of rendering fake-empty data. Embedded only
    // when non-empty, so clean recipes keep their exact prior signed shape.
    // Inside the signed envelope on purpose: the app reads it, never writes.
    ...(feedGaps && (feedGaps.missingRequired.length > 0 || feedGaps.missingBusinessCritical.length > 0)
      ? { feedGaps }
      : {}),
  };

  // Plan v8 P1-7 — sign the recipe before persisting. Closes the takeover-
  // mode recipe-injection vector: when admin drives the browser in Live
  // Mapping, admin-recorded click_at / type_text steps land in this same
  // insert. A compromised or socially-engineered admin could otherwise
  // inject {kind: 'goto', url: 'attacker.example'} or {kind: 'fill',
  // selector: ..., value: '$password'}. Signing ties the recipe to the
  // active key; replay-time verifyRecipe refuses tampered rows under
  // RECIPE_SIGNING_ENFORCE=enforce. When no key is configured (legacy
  // dev), we log + skip — recipe-runner runs in warn mode and proceeds.
  let signatureBytes: Buffer | null = null;
  let signedWithKeyId: string | null = null;
  let signedAt: string | null = null;
  if (isRecipeSigningConfigured()) {
    try {
      // Sign/verify split-brain fix — the DB stores the `knowledge`
      // ENVELOPE (recipe re-wrapped with schema/description + an empty
      // `hints` default), but verifyRecipe canonicalJson-s that exact
      // stored envelope at load time. Signing the bare `recipe` here
      // produced a digest over a different shape, so verification NEVER
      // matched — and under enforce mode that silently halts ALL polling.
      // Sign the same envelope object that gets persisted.
      const sig = signRecipe(knowledge as unknown as Recipe);
      signatureBytes = sig.signature;
      signedWithKeyId = sig.signedWithKeyId;
      signedAt = sig.signedAt;
    } catch (err) {
      // Plan v8 Phase B review P1-5 (Codex finding) — under enforce mode,
      // saving unsigned would silently break the hotel: recipe-runner
      // refuses unsigned recipes on every poll, and the operator's only
      // signal is a doctor red row. Fail the save loudly so the admin
      // sees a clear error + can investigate (key corruption, HSM hiccup,
      // env mismatch). In warn mode, preserve today's behavior (log +
      // save unsigned — recipe-runner will log a warning and proceed).
      if (env.RECIPE_SIGNING_ENFORCE === 'enforce') {
        const msg = `signRecipe failed under enforce mode — refusing to save unsigned recipe: ${(err as Error).message}`;
        log.warn('saveDraftKnowledgeFile: ' + msg, { pmsFamily, version: nextVersion });
        return { ok: false, error: msg };
      }
      log.warn('saveDraftKnowledgeFile: signRecipe failed — saving unsigned (warn mode)', {
        err: (err as Error).message, pmsFamily, version: nextVersion,
      });
    }
  } else {
    log.info('saveDraftKnowledgeFile: signing key not configured — saving unsigned', {
      pmsFamily, version: nextVersion,
    });
  }

  const { data: inserted, error: insErr } = await supabase
    .from('pms_knowledge_files')
    .insert({
      pms_family: pmsFamily,
      version: nextVersion,
      status,                   // 'draft' (gate may promote) or 'quarantined'
      knowledge,
      created_by: 'mapper:mapping-driver',
      notes: `Mapped at ${new Date().toISOString()}. Targets: ${Object.keys(recipe.actions).join(', ')}.` +
        (gateNote ? ` Gate: ${gateNote}` : ''),
      signature: signatureBytes,
      signed_with_key_id: signedWithKeyId,
      signed_at: signedAt,
    })
    .select('id')
    .single();
  if (insErr || !inserted) return { ok: false, error: `insert failed: ${insErr?.message ?? 'unknown'}` };
  return { ok: true, id: inserted.id as string, version: nextVersion };
}

function computeStats(result: MapperResult & { ok: true }): {
  targetsFound: number;
  targetsUnavailable: number;
  targetsFailed: number;
} {
  // Recipe.actions has entries for SUCCESSFULLY mapped targets only.
  // Unavailable + failed counts come from the mapper's run log; we
  // approximate from what's in the recipe vs what the TARGETS catalogue
  // expects (13 entries).
  const found = Object.keys(result.recipe.actions).length;
  // TODO: surface unavailable/failed counts via mapper return shape
  // extension. For now report 0 (the admin UI shows which targets are
  // present by inspecting recipe.actions keys).
  return {
    targetsFound: found,
    targetsUnavailable: 0,
    targetsFailed: 0,
  };
}
