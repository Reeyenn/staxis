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

import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { chromium } from 'playwright';
import { supabase } from './supabase.js';
import { log } from './log.js';
import { mapPMS, mapLogin, saveTrustedSession, scaleCostCapForModel, type MapperResult } from './mapper.js';
import { safeGoto, UnsafeNavigationError } from './browser-utils/navigate.js';
import { env } from './env.js';
import { signRecipe, isRecipeSigningConfigured } from './recipe-signing.js';
import { checkDailyMappingSpend, microsToDollars } from './cost-cap.js';
import { createLiveFramePublisher } from './live-frame.js';
import { createTakeoverController } from './takeover.js';
import type { PMSCredentials, PMSType, Recipe, ScraperCredentialsRow, LearnedValueTranslations, LearnedDateFormat, BoardTargetDescriptor, BoardTargetState } from './types.js';
import type { MapperModelId } from './anthropic-client.js';
import { effectiveColumnsFromAction, missingRequiredColumns } from './target-contract.js';
import type { FeedGaps, FeedGapEntry, RecipeVerification } from './knowledge-file.js';
import {
  computeCommitScore,
  decideCommit,
  valueFingerprint,
  fingerprintsMatch,
  DEFAULT_COMMIT_THRESHOLD,
  DEFAULT_REQUIRED_PASSES,
  type CommitSignals,
  type SignalVerdict,
} from './commit-gate.js';
import { reconcileCrossFeed, parseCounter, type FeedObservation } from './cross-feed-reconcile.js';
import { DISCOVERY_KEY_COLUMNS } from './oracle-verify.js';
import { CORE_TARGET_CONTRACTS } from './target-contract.js';
// feature/cua-self-heal-reach — one-fix-generalizes (sample-verify) + golden-fixture gates.
import { recipeToTableTemplates } from './recipe-adapter.js';
import { runSingleSourceTemplate } from './extractors/template-runner.js';
import { captureLiveFeedProvenance, uploadLiveFeedSample, upsertFeedValues } from './feed-capture.js';
import { loadActive } from './knowledge-file.js';
// rehostFeedUrl lives in session-driver; session-driver imports promoteRecipeChange
// from here, so this is a cycle — but BOTH cross-module references are call-time
// (inside functions/methods), never load-time, so it resolves safely under CJS+ESM.
import { rehostFeedUrl } from './session-driver.js';
import { requiredColumnsForTarget } from './reanchor.js';
import {
  loadGoldenFixture,
  gateAgainstFixture,
  type FreshExtractionShape,
  type FixtureColumnVerdict,
} from './golden-fixtures.js';

// ── best-class verification config knobs (feature/cua-bestclass-verify) ──
// Read from process.env (env.ts is out of scope for this change). ALL DEFAULT
// to today's behaviour: enforcement OFF (signals computed + persisted for
// observability, but never downgrade), one required pass, the calibrated
// threshold. Flip CUA_VERIFY_ENFORCE=true (+ optionally raise the passes) for
// the prove-it-before-family-wide rollout posture.
// ON by default — a learned map must pass the confidence gate before
// auto-promoting, else it PARKS as a draft for founder review; =false is an
// emergency kill.
const verifyEnforceOn = (): boolean =>
  (process.env.CUA_VERIFY_ENFORCE ?? 'true').toLowerCase() === 'true';
const verifyThreshold = (): number =>
  clampFloatCfg(process.env.CUA_VERIFY_COMMIT_THRESHOLD, DEFAULT_COMMIT_THRESHOLD, 0, 1);
const verifyRequiredPasses = (): number =>
  clampIntCfg(process.env.CUA_VERIFY_REQUIRED_PASSES, DEFAULT_REQUIRED_PASSES, 1, 9);
const secondModelVoteOn = (): boolean =>
  (process.env.CUA_VERIFY_SECOND_MODEL_ENABLED ?? 'false').toLowerCase() === 'true';

function clampFloatCfg(raw: string | undefined, def: number, lo: number, hi: number): number {
  const n = raw == null ? def : parseFloat(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}
function clampIntCfg(raw: string | undefined, def: number, lo: number, hi: number): number {
  const n = raw == null ? def : parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

// ── self-heal/reach gate knobs (feature/cua-self-heal-reach) ──
// ALL default OFF: a recipe change auto-promotes exactly as today until an
// operator opts in. The gates are downgrade-only, so flipping them on can only
// HOLD a change for review, never re-park an existing live recipe.
const sampleVerifyEnabled = (): boolean =>
  (process.env.CUA_SAMPLE_VERIFY_ENABLED ?? 'false').toLowerCase() === 'true';
/** How many sibling hotels to replay (read-only, bounded). Default 2, max 5. */
const sampleVerifyN = (): number =>
  clampIntCfg(process.env.CUA_SAMPLE_VERIFY_N, 2, 1, 5);
const goldenFixtureGateEnabled = (): boolean =>
  (process.env.CUA_GOLDEN_FIXTURES_ENABLED ?? 'false').toLowerCase() === 'true';

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
  /** feature/cua-coverage-editor — single-target allowlist. When the coverage
   *  editor enqueues an "edit one feed" / "add one feed" run, it sets this so
   *  the mapper learns EXACTLY the requested target instead of hunting every
   *  unlearned catalogue target. Threaded straight to mapPMS's onlyTargets. */
  only_targets?: string[];
  /** feature/cua-coverage-editor — assist-first (start-paused). Set with a
   *  single-element only_targets: runMappingJob pre-opens a 'requested' takeover
   *  for that feed so the robot pauses for the founder the moment it reaches it
   *  (no race with the autonomous agent). Opened INSIDE the run so the finally's
   *  takeover.close() always cleans it up — a never-run job never opens one. */
  assist_first?: boolean;
  /** feature/cua-coverage-editor — set by edit-feed when it seeds the run from
   *  an existing DRAFT (founder re-mapping a feed on a not-yet-live map). Such a
   *  re-map must NEVER auto-go-live: even if the gate would auto_promote, it gets
   *  downgraded to park_draft so the draft stays parked for founder review. Never
   *  touches the active-map promote path (a seeded re-map of a LIVE family still
   *  flows through the normal seeded guards). */
  never_auto_promote?: boolean;
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
  /** Verification visibility (additive, advisory) — the multi-signal commit
   *  score [0,1] and per-signal verdicts that fed the promotion decision, so
   *  the admin can SEE why a map auto-promoted or parked without opening the
   *  knowledge file. Present only on a fresh full learn (when verification was
   *  computed); absent on seeded repair/backfill/coverage-edit jobs. Mirrors
   *  knowledge.verification.{score,signals}; never drives the gate. */
  verificationScore?: number;
  verificationSignals?: Record<string, string>;
  /** Learning Board — final per-feed state, carried from mapPMS through the
   *  index.ts handler adapter into workflow_jobs.result. markCompleted
   *  REPLACES result at completion, so dropping these anywhere along the
   *  chain blanks the admin board the moment a run succeeds. */
  targetCatalog?: BoardTargetDescriptor[];
  boardTargets?: Record<string, BoardTargetState>;
  error?: string;
}

/**
 * The mapper.learn_pms_family handler adapter (index.ts) — shapes a
 * successful MappingJobResult into the object the workflow runtime writes
 * to workflow_jobs.result at completion. Pulled out as a pure function so
 * a unit test pins the Learning Board pass-through: markCompleted REPLACES
 * result, so any key dropped here vanishes from the admin board the moment
 * a run succeeds (the exact bug class this branch exists to prevent).
 * Aggregate keys stay snake_case (pre-existing consumers); the board keys
 * stay camelCase to match the mapper's mid-run merges (actionsSoFar
 * precedent) so the board reads ONE contract.
 */
export function mappingJobResultToWorkflowResult(
  result: MappingJobResult,
): Record<string, unknown> {
  return {
    knowledge_file_id: result.knowledgeFileId,
    knowledge_file_version: result.knowledgeFileVersion,
    targets_found: result.targetsFound,
    targets_unavailable: result.targetsUnavailable,
    targets_failed: result.targetsFailed,
    spent_micros: result.spentMicros,
    promotion_decision: result.promotionDecision,
    promotion_reason: result.promotionReason,
    // Verification visibility (additive, advisory) — score + per-signal
    // verdicts surfaced alongside the decision in workflow_jobs.result.
    verification_score: result.verificationScore,
    verification_signals: result.verificationSignals,
    targetCatalog: result.targetCatalog,
    boardTargets: result.boardTargets,
  };
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
    // feature/cua-column-recovery — judge the EFFECTIVE column map: list
    // columns plus any recovered detail columns the runtime is guaranteed to
    // extract (shared eligibility predicate with recipe-adapter). The
    // completeness check itself is unchanged.
    const missingCols = missingRequiredColumns(t, effectiveColumnsFromAction(t, action));
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
  | 'live_frame'            // feature/cua-live-view — a fresh frame landed at
                            // `${jobId}/live.png`; METADATA ONLY (the image
                            // stays in the private bucket — this channel is
                            // anon-subscribable). Board re-fetches a signed URL.
  | 'takeover'              // feature/cua-live-assist — founder takeover state
                            // changed (paused / new frame / ended). METADATA
                            // ONLY; the board refetches GET /api/admin/mapper/
                            // live/[jobId] for the takeover session + frame URL.
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

  // feature/cua-live-view — continuous "robot's screen" for the Learning
  // Board. The mapper tees every (already privacy-hardened) vision
  // screenshot into publish(); the publisher heartbeat-gates, overwrites
  // the single per-job frame object, then this notify broadcasts a
  // metadata-only nudge. close() in the finally removes the frame object.
  const liveFrames = createLiveFramePublisher(jobId, {
    notify: () => void broadcastMappingEvent(channel, {
      type: 'live_frame',
      jobId,
      at: new Date().toISOString(),
    }),
  });

  // feature/cua-live-assist — founder-initiated, robot-paused takeover. The
  // mapper polls this at the top of each step; on an open takeover the founder
  // drives the page click-by-click. notify() nudges the board to refetch the
  // takeover session + the fresh click-target frame; close() removes the
  // takeover frame object on job end (mirrors liveFrames.close()).
  const takeover = createTakeoverController(jobId, {
    notify: () => void broadcastMappingEvent(channel, {
      type: 'takeover',
      jobId,
      at: new Date().toISOString(),
    }),
    onLiveFrame: (pngBase64) => liveFrames.publish(pngBase64),
  });

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

  // 1.7. feature/cua-coverage-editor — assist-first (start-paused). For a
  //      single-feed edit/add, pre-open a 'requested' takeover for that feed so
  //      the robot pauses for the founder the instant it reaches it (no race
  //      with the autonomous agent). Opened HERE, inside the run, so the
  //      finally's takeover.close() always cleans it up — a never-claimed job
  //      never leaves a phantom takeover (senior review P1).
  const assistTarget = input.assist_first && input.only_targets?.length === 1
    ? input.only_targets[0]
    : null;
  if (assistTarget) {
    const { error: takeoverErr } = await supabase
      .from('mapper_takeover_sessions')
      .insert({ job_id: jobId, status: 'requested', target_key: assistTarget });
    if (takeoverErr) {
      // Non-fatal: the founder can still press "Take over" on the board.
      log.warn('mapping-driver: assist-first takeover pre-open failed (non-fatal)', {
        jobId, target: assistTarget, err: takeoverErr.message,
      });
    } else {
      log.info('mapping-driver: assist-first — pre-opened takeover for founder', { jobId, target: assistTarget });
    }
  }

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
    // fix/cua-discovery-budget — scale ONLY the absent-cap DEFAULT by the run
    // model (Opus ×2 → $60). An explicit cost_cap_micros (repair/edit/backfill) is
    // a deliberate tight cap and is NEVER scaled. scaleCostCapForModel resolves an
    // undefined model to the actual default (Opus), so the cap can't silently stay
    // at the Sonnet base.
    jobCostCapMicros: input.cost_cap_micros ?? scaleCostCapForModel(env.CUA_FULL_LEARN_COST_CAP_MICROS, input.model),
    // Plan v8 self-repair — pre-seed the actions accumulator so the
    // mapper only iterates targets NOT in this set. Empty for full
    // mappings (fresh PMS family); populated for repairs.
    seedActions: input.seed_actions,
    seedValueTranslations: input.seed_value_translations,
    seedDateFormat: input.seed_date_format,
    // feature/cua-coverage-editor — single-target allowlist (edit/add one feed).
    onlyTargets: input.only_targets,
    // feature/cua-live-view — tee each vision screenshot to the Learning
    // Board's live view. publish() is fire-and-forget and never throws.
    onLiveFrame: (pngBase64) => liveFrames.publish(pngBase64),
    // feature/cua-live-assist — founder takeover controller (gate polled at
    // the top of each mapActionCore step).
    takeover,
    onProgress: (label, pct, meta) => {
      log.info('mapping-driver: progress', {
        jobId, label, pct,
        ...(meta?.feedKey ? { feedKey: meta.feedKey } : {}),
        ...(meta?.phase ? { phase: meta.phase } : {}),
      });
      // Plan v8 Phase B chunk 2 — pipe mapper progress to the Live
      // Mapping admin UI. mapper.ts emits these from mapPMS at:
      // login start/done, each target start, each target done. Fire-
      // and-forget; broadcastMappingEvent never throws.
      // feature/cua-mapper-phases-captures — when the tick carries structured
      // feedKey/phase (per-target ticks do; login/setup ticks don't), ride them
      // on the event's existing `detail` escape hatch so the realtime live
      // ticker can show the phase without polling the job result. The durable
      // currentActivity write itself lives in mapper.ts (where mergeJobResult
      // and the feedKey/phase actually are); this is purely the live broadcast.
      void broadcastMappingEvent(channel, {
        type: 'mapping_in_progress',
        jobId,
        label,
        pct,
        ...(meta?.feedKey || meta?.phase
          ? { detail: { feedKey: meta?.feedKey, phase: meta?.phase } }
          : {}),
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

  // 2.9. feature/cua-bestclass-verify — compute the multi-signal verification
  //      verdict, but ONLY for a FRESH, full, unseeded learn. A self-repair /
  //      backfill / coverage-edit seeds an existing recipe and is EXEMPT (same
  //      rationale as the gate's seeded-target exemption), so a repair is never
  //      newly parked. Signals are always computed + persisted for ops
  //      visibility; they only DOWNGRADE auto-promotion when CUA_VERIFY_ENFORCE
  //      is on. Fail-open: a thrown verification never blocks the learn.
  const isFreshFullLearn =
    !input.seed_actions && !input.backfill_missing_feeds &&
    !(input.only_targets && input.only_targets.length > 0);
  let verification: ComputedVerification | null = null;
  if (isFreshFullLearn) {
    try {
      verification = await computeRecipeVerification({
        pmsFamily: input.pms_family,
        recipe: result.recipe,
        boardTargets: result.boardTargets,
        jobId,
        propertyId: input.property_id,
        signal,
      });
      log.info('mapping-driver: best-class verification computed', {
        jobId,
        score: verification.gateInput.score,
        enforce: verification.gateInput.enforce,
        consistentPasses: verification.gateInput.consistentPasses,
        requiredPasses: verification.gateInput.requiredPasses,
        note: verification.gateInput.note,
      });
    } catch (err) {
      log.warn('mapping-driver: best-class verification threw — proceeding without it (advisory)', {
        jobId, err: (err as Error).message,
      });
      verification = null;
    }
  }

  // 3. Evaluate the auto-promotion gate (Plan v7 — replaces the "≥60%
  //    of targets" magic number with required-target-class checks).
  const gate = evaluatePromotionGate(result.recipe, input.seed_actions, verification?.gateInput);
  log.info('mapping-driver: promotion gate evaluated', {
    jobId, decision: gate.decision, reason: gate.reason,
  });

  // 3.1. feature/cua-coverage-editor — a DRAFT-SEEDED re-map (founder editing a
  //      feed on a not-yet-live map) must PARK, never auto-go-live. edit-feed
  //      sets never_auto_promote on these. We ONLY downgrade auto_promote here;
  //      park_partial / park_draft / quarantine already wait for a human, and
  //      the gate math itself is untouched (this is a post-gate clamp). The
  //      active-map promote path is unaffected: a seeded re-map of a LIVE family
  //      doesn't carry this flag and still runs the normal seeded guards below.
  if (input.never_auto_promote && gate.decision === 'auto_promote') {
    log.info('mapping-driver: never_auto_promote — parking draft-seeded re-map for founder review', {
      jobId, was: gate.reason,
    });
    gate.decision = 'park_draft';
    gate.reason = 'parked: founder re-mapped a draft feed — review before live';
  }

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

  // 3.7. feature/cua-self-heal-reach — ONE-FIX-GENERALIZES sample-verify +
  //      GOLDEN-FIXTURE regression gates. Both DEFAULT OFF and run ONLY when the
  //      recipe would otherwise auto-promote (nothing to downgrade on a parked
  //      draft) — so with the flags unset this whole block is skipped and the
  //      decision is byte-identical to today. Each only DOWNGRADES auto_promote
  //      → park_draft; the live fleet is never re-parked. Fail-OPEN: a thrown
  //      sample-verify is advisory (already caught inside computeSampleVerifyGate).
  if (gate.decision === 'auto_promote' && (sampleVerifyEnabled() || goldenFixtureGateEnabled())) {
    // A SEEDED job re-learned only the non-seeded target(s) → gate exactly those.
    // An UNSEEDED full learn (fresh family OR admin regenerate of a family that
    // already has live siblings) replaced the WHOLE recipe → gate EVERY emitted
    // feed, not just the required core, so a regressed business-critical feed
    // can't go fleet-wide unchecked (Codex P1). Bounded by sampleVerifyN siblings.
    const changedTargets = input.seed_actions
      ? Object.keys(result.recipe.actions).filter((k) => !(k in (input.seed_actions as Record<string, unknown>)))
      : Object.keys(result.recipe.actions);
    let sampleVerify: SampleVerifyGateInput | undefined;
    let goldenFixture: GoldenFixtureGateInput | undefined;
    if (goldenFixtureGateEnabled()) {
      goldenFixture = computeGoldenFixtureGate({
        pmsFamily: input.pms_family,
        recipe: result.recipe,
        targets: changedTargets,
        freshShapeFor: (k) => recipeFreshShape(result.recipe, k),
      });
    }
    if (sampleVerifyEnabled() && changedTargets.length > 0) {
      sampleVerify = await computeSampleVerifyGate({
        pmsFamily: input.pms_family,
        recipe: result.recipe,
        changedTargets,
        excludePropertyId: input.property_id,
        deps: defaultSampleVerifyDeps(),
      });
    }
    if (sampleVerify || goldenFixture) {
      const regate = evaluatePromotionGate(result.recipe, input.seed_actions, verification?.gateInput, sampleVerify, goldenFixture);
      if (regate.decision !== gate.decision) {
        log.info('mapping-driver: self-heal/reach gate downgraded promotion', {
          jobId, from: gate.decision, to: regate.decision, reason: regate.reason,
        });
      }
      gate.decision = regate.decision;
      gate.reason = regate.reason;
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
    // feature/cua-bestclass-verify — persist the verification telemetry +
    // pass^N counter inside the signed envelope (only on fresh learns).
    verification?.persist,
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
      // Verification visibility (additive, advisory) — score + signals beside
      // the decision; undefined on seeded repair/backfill (no fresh learn).
      verificationScore: verification?.persist.score,
      verificationSignals: verification?.persist.signals,
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
    // Verification visibility (additive, advisory) — only present on a fresh
    // full learn; mirrors the persisted knowledge.verification.
    verificationScore: verification?.persist.score,
    verificationSignals: verification?.persist.signals,
    ...stats,
    // Learning Board — see MappingJobResult doc.
    targetCatalog: result.targetCatalog,
    boardTargets: result.boardTargets,
  };
  } finally {
    // feature/cua-live-view — stop accepting frames, await any in-flight
    // upload, delete the per-job live frame object. Before the channel
    // close so the (best-effort) teardown ordering can't drop a final
    // notify on a closed channel. Runs on success/failure/throw/abort.
    await liveFrames.close();
    // feature/cua-live-assist — remove the takeover frame object too (best-
    // effort), so a job that ended mid-takeover doesn't leak a redacted PNG.
    await takeover.close();
    // Plan v8 hardening — close the per-job channel once, regardless of
    // success/failure/exception. Without this finally a thrown exception
    // would leak the WebSocket channel handle.
    await closeBroadcastChannel(channel);
  }
}

// ─── Promotion gate ────────────────────────────────────────────────────

/**
 * feature/cua-bestclass-verify — the calibrated multi-signal verdict the
 * orchestration feeds into the gate. ABSENT ⟹ today's behaviour (the gate
 * decides exactly as before). When present AND `enforce`, a recipe that would
 * AUTO-PROMOTE is held for founder review (park_partial — never quarantine,
 * never re-park) unless it clears the calibrated threshold AND pass^N. The
 * orchestration only ever passes this for FRESH, unseeded full learns, so a
 * self-repair / backfill / coverage-edit (and every already-live recipe, which
 * the gate is never re-run on) is exempt — the live fleet cannot mass re-park.
 */
export interface VerificationGateInput {
  enforce: boolean;
  score: number;
  threshold: number;
  consistentPasses: number;
  requiredPasses: number;
  /** Short human note appended to the gate reason (signal summary). */
  note?: string;
}

/**
 * feature/cua-self-heal-reach — ONE-FIX-GENERALIZES sample-verify result, fed
 * into the gate. A per-family recipe is shared by EVERY hotel on the family, so a
 * version that auto-promotes goes live fleet-wide at once. Before that, the
 * promotion sequence replays the changed feed(s) READ-ONLY on a SAMPLE of OTHER
 * sibling hotels. If the new selectors POSITIVELY fail on ANY sampled sibling
 * (rows extracted but a required column is blank there), this downgrades
 * auto_promote → park_draft so the founder reviews instead of breaking the fleet.
 *
 * DOWNGRADE-ONLY + DEFAULT-OFF + ABSENT ⟹ today's behaviour: `enabled:false` (or
 * absent) is a no-op; an inconclusive sibling (offline, session expired, empty
 * day) NEVER downgrades — only a positive failure does — so a single offline
 * sibling can't starve the fleet's promotions.
 */
export interface SampleVerifyGateInput {
  enabled: boolean;
  /** Sibling hotels actually replayed. */
  sampled: number;
  /** Siblings where the changed feed POSITIVELY failed under the new selectors. */
  failedSiblings: number;
  note?: string;
}

/**
 * feature/cua-self-heal-reach — GOLDEN-FIXTURE regression result, fed into the
 * gate. Compares the candidate recipe's per-feed extraction SHAPE against a
 * committed known-good snapshot (golden-fixtures.ts). A feed where a
 * previously-CERTIFIED column was dropped or value-regressed → blocked.
 *
 * DOWNGRADE-ONLY + DEFAULT-OFF + ABSENT-FIXTURE ⟹ skip: with no fixture (the
 * normal state until one is captured + committed) `regressedFeeds` is empty and
 * this is a no-op — the live fleet is never re-parked on rollout.
 */
export interface GoldenFixtureGateInput {
  enabled: boolean;
  /** Feeds that regressed vs their golden fixture (certified→failed/dropped). */
  regressedFeeds: string[];
  note?: string;
}

export function evaluatePromotionGate(
  recipe: Recipe,
  seedActions?: Recipe['actions'],
  verification?: VerificationGateInput,
  sampleVerify?: SampleVerifyGateInput,
  goldenFixture?: GoldenFixtureGateInput,
): {
  decision: 'auto_promote' | 'park_partial' | 'park_draft' | 'quarantine';
  reason: string;
  feedGaps: FeedGaps;
} {
  const found = new Set(Object.keys(recipe.actions));
  const feedGaps = computeFeedGaps(recipe.actions);

  // feature/cua-prove-columns — a required target is TRUSTWORTHY FOR AUTO-PROMOTION
  // only when each required column was PROVEN: oracle-reconciled (mode:'api', the
  // JSON path, whose rows are reconciled against the DOM oracle) OR first-emission
  // value-certified (mode:'table', the new DOM-path check). A table feed that
  // carries `unprovenRequiredColumns` (columns kept but NOT value-certified — the
  // page was empty/unreadable at onboarding so no value evidence existed, or the
  // value parsed as the wrong type on every sampled row) must NEVER auto-go-live
  // with a guessed column; it parks for founder review (park_partial). The field
  // is read STRUCTURALLY (ActionRecipe is owned by types.ts, out of scope here)
  // and is ABSENT ⟹ proven: legacy live recipes have no field and stay trusted,
  // so a backfill/promote re-check never mass-reparks the fleet (monotonic).
  //
  // feature/cua-tolerant-mapper — `unprovenRequiredColumns` is stamped only from
  // ESSENTIALS (finalizeRecoveredSuccess), so a blank/derived contextual date
  // never lands here and never holds a feed for review. No change needed.
  const unprovenByTarget = new Map<string, string[]>();
  for (const t of REQUIRED_TARGETS) {
    const action = recipe.actions[t];
    if (!action) continue;                      // missing → already a computeFeedGaps gap
    if (action.parse?.mode === 'api') continue; // oracle-reconciled JSON path — already strong
    // SEEDED targets are already LIVE — they passed this gate (or the founder's
    // Promote click) on a prior job, so a stale `unprovenRequiredColumns` they
    // carry (e.g. a feed onboarded empty, then founder-approved) must NOT re-park
    // a successful self-repair/backfill that only re-learned a DIFFERENT target.
    // The field is never stripped from the active recipe, so without this a repair
    // would silently fail to auto-promote forever (Claude review P1). Only freshly
    // learned targets (absent from the seed) are subject to value-certification.
    // Require a REAL seeded action (not just key presence): a malformed seed with
    // `{ target: null }` must NOT be treated as already-live and exempt (review #2).
    if (seedActions && seedActions[t] != null) continue;
    const carried = (action as { unprovenRequiredColumns?: unknown }).unprovenRequiredColumns;
    if (!Array.isArray(carried) || carried.length === 0) continue; // certified / legacy
    // Count only columns still SHIPPING (non-blank) — a blanked column is already
    // a computeFeedGaps gap (incomplete_columns), not an "unproven but live" one.
    const cols = effectiveColumnsFromAction(t, action);
    const live = carried.filter(
      (c): c is string => typeof c === 'string' && typeof cols[c] === 'string' && cols[c]!.trim() !== '',
    );
    if (live.length > 0) unprovenByTarget.set(String(t), live);
  }
  const unprovenNote = unprovenByTarget.size > 0
    ? ` — required columns not value-certified (need founder review): ${[...unprovenByTarget].map(([t, cols]) => `${t} (${cols.join(', ')})`).join('; ')}`
    : '';

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

  // All 4 required present + column-complete (non-blank). Auto-promote ONLY when
  // every required column is also value-PROVEN AND enough business-critical feeds
  // landed — otherwise park for the founder's Promote click.
  if (feedGaps.missingRequired.length === 0) {
    if (unprovenByTarget.size === 0 && businessCriticalFound.length >= MIN_BUSINESS_CRITICAL_FOR_AUTO) {
      // feature/cua-bestclass-verify — when enforcement is ON, a recipe that
      // would auto-promote must additionally clear the calibrated multi-signal
      // threshold AND pass^N. Failing either holds it for the founder's Promote
      // click (park_partial) — never quarantine, never a live re-park (this
      // branch is only reached for fresh learns the orchestration verified).
      if (verification?.enforce) {
        const d = decideCommit({
          score: verification.score,
          threshold: verification.threshold,
          consistentPasses: verification.consistentPasses,
          requiredPasses: verification.requiredPasses,
        });
        if (!d.commit) {
          return {
            decision: 'park_partial',
            reason: `held for founder review by best-class verification — ${d.reason}${verification.note ? `; ${verification.note}` : ''}`,
            feedGaps,
          };
        }
      }
      // feature/cua-self-heal-reach — two MORE downgrade-only gates, applied only
      // in the auto-promote branch and only when ENABLED + POSITIVELY failing.
      // Both park_draft (never quarantine): the prior active is untouched, the
      // candidate is saved for founder review. Absent/disabled ⟹ no effect, so
      // the live fleet is never re-parked when these roll out (monotonic).
      if (sampleVerify?.enabled && sampleVerify.failedSiblings > 0) {
        return {
          decision: 'park_draft',
          reason: `held for founder review — one-fix-generalizes sample-verify failed on ${sampleVerify.failedSiblings}/${sampleVerify.sampled} sibling hotel(s)${sampleVerify.note ? `; ${sampleVerify.note}` : ''}`,
          feedGaps,
        };
      }
      if (goldenFixture?.enabled && goldenFixture.regressedFeeds.length > 0) {
        return {
          decision: 'park_draft',
          reason: `held for founder review — golden-fixture regression on: ${goldenFixture.regressedFeeds.join(', ')}${goldenFixture.note ? `; ${goldenFixture.note}` : ''}`,
          feedGaps,
        };
      }
      const verifyNote = verification
        ? ` [verify score ${verification.score.toFixed(2)}≥${verification.threshold}, passes ${verification.consistentPasses}/${verification.requiredPasses}${verification.enforce ? '' : ', advisory'}]`
        : '';
      return {
        decision: 'auto_promote',
        reason: `all required + ${businessCriticalFound.length}/${BUSINESS_CRITICAL_TARGETS.length} business-critical (${businessCriticalFound.join(', ')})${verifyNote}`,
        feedGaps,
      };
    }
    // Founder decision 2026-06-11: INCOMPLETE recipes never auto-activate —
    // they park as a gap-annotated draft for his Promote click (Manage
    // maps). Monotonicity still holds: a 4/4-required recipe parks exactly
    // like a 3/4 one that meets the bar below; neither ships without him.
    // The BC gaps are recorded in feedGaps so the promoted file goes live
    // with the honesty annotations + daily backfill retries intact.
    //
    // feature/cua-prove-columns — a required column that ships but was NOT
    // value-certified (unprovenByTarget) is treated exactly like a BC shortfall
    // here: never auto-go-live, always founder-reviewed. The column keeps its
    // selector (it may be correct) so a single Promote click ships it; we just
    // refuse to do it automatically with a guessed column.
    const bcClause = businessCriticalFound.length >= MIN_BUSINESS_CRITICAL_FOR_AUTO
      ? `${businessCriticalFound.length}/${BUSINESS_CRITICAL_TARGETS.length} business-critical`
      : `only ${businessCriticalFound.length}/${BUSINESS_CRITICAL_TARGETS.length} business-critical (need ${MIN_BUSINESS_CRITICAL_FOR_AUTO} for full promotion)`;
    return {
      decision: 'park_partial',
      reason: `all required found but ${bcClause}${unprovenNote} — parked for admin review; missing business-critical recorded for retry: ${feedGaps.missingBusinessCritical.join(', ')}`,
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
      reason: `partial recipe parked for admin review — trustworthy: ${[...trustworthyRequired].join(', ')}; still missing required: ${gapSummary}${feedGaps.missingBusinessCritical.length > 0 ? `; missing business-critical: ${feedGaps.missingBusinessCritical.join(', ')}` : ''}${unprovenNote}`,
      feedGaps,
    };
  }

  return {
    decision: 'quarantine',
    reason: `below the partial-promotion bar (need getRoomStatus, or getArrivals + getDepartures, learned and complete) — missing/dead required targets: ${feedGaps.missingRequired.map((g) => `${g.target} (${g.reason})`).join(', ')}`,
    feedGaps,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// feature/cua-self-heal-reach — ONE-FIX-GENERALIZES (sample-verify) + GOLDEN-
// FIXTURE gate computations, the read-only sibling replay, and the shared
// promotion gauntlet the rung-2 re-anchor (session-driver) reuses so a re-anchor
// is held to the SAME fleet-safety bar as a paid re-learn.
// ════════════════════════════════════════════════════════════════════════════

export type SiblingVerifyVerdict = 'pass' | 'fail' | 'inconclusive';
export interface SiblingVerifyResult {
  propertyId: string;
  actionKey: string;
  verdict: SiblingVerifyVerdict;
  reason: string;
}

/** A sibling must yield at least this many rows before a blank-column verdict is
 *  trusted — below it the feed is too thin to tell "selector wrong" from "quiet
 *  hotel", so it reads inconclusive (never a false fail). */
const SAMPLE_VERIFY_MIN_ROWS = 3;
const SAMPLE_VERIFY_REPLAY_TIMEOUT_MS = 60_000;
/** A required column present on < this fraction of a sibling's rows is read as a
 *  POSITIVE selector failure (the candidate points at the wrong/empty cell there). */
const SAMPLE_VERIFY_MIN_COVERAGE = 0.5;
/** Hard caps on the WHOLE gate (siblings × changed feeds can be large for an
 *  unseeded full re-learn). Bound both the replay COUNT and the wall-clock so a
 *  promotion is never blocked for minutes; un-replayed feeds are simply not
 *  sampled (never a false fail). */
const SAMPLE_VERIFY_MAX_TOTAL_REPLAYS = 16;
const SAMPLE_VERIFY_TOTAL_BUDGET_MS = 180_000;

/** Injectable seam: the gate's selection + aggregation is unit-testable with
 *  fakes; production wires the real Supabase + Playwright replay. */
export interface SampleVerifyDeps {
  /** Eligible sibling property_ids on the family (excludes the mapper tenant +
   *  any non-`alive` hotel so a cost-capped/paused hotel is never woken), bounded. */
  selectSiblings: (pmsFamily: string, excludePropertyId: string | null, limit: number) => Promise<string[]>;
  /** Replay ONE changed feed READ-ONLY on ONE sibling under the candidate recipe. */
  replayFeedOnSibling: (propertyId: string, recipe: Recipe, actionKey: string) => Promise<SiblingVerifyResult>;
}

/** PURE. Verdict counts; only POSITIVE failures matter (inconclusive never
 *  downgrades — a single offline sibling can't starve fleet promotions). */
export function aggregateSampleVerify(results: SiblingVerifyResult[]): {
  sampled: number; failed: number; passed: number; inconclusive: number; failedSiblings: number;
} {
  const sampled = new Set(results.map((r) => r.propertyId)).size;
  const failedSiblings = new Set(results.filter((r) => r.verdict === 'fail').map((r) => r.propertyId)).size;
  return {
    sampled,
    failed: results.filter((r) => r.verdict === 'fail').length,
    passed: results.filter((r) => r.verdict === 'pass').length,
    inconclusive: results.filter((r) => r.verdict === 'inconclusive').length,
    failedSiblings,
  };
}

export async function computeSampleVerifyGate(args: {
  pmsFamily: string;
  recipe: Recipe;
  changedTargets: string[];
  excludePropertyId: string | null;
  deps: SampleVerifyDeps;
}): Promise<SampleVerifyGateInput> {
  if (args.changedTargets.length === 0) {
    return { enabled: true, sampled: 0, failedSiblings: 0, note: 'no changed feeds to sample' };
  }
  const siblings = await args.deps.selectSiblings(args.pmsFamily, args.excludePropertyId, sampleVerifyN());
  if (siblings.length === 0) {
    return { enabled: true, sampled: 0, failedSiblings: 0, note: 'no eligible sibling hotels' };
  }
  const results: SiblingVerifyResult[] = [];
  const deadline = Date.now() + SAMPLE_VERIFY_TOTAL_BUDGET_MS;
  let replays = 0;
  let truncated = false;
  outer:
  for (const propertyId of siblings) {
    for (const actionKey of args.changedTargets) {
      if (replays >= SAMPLE_VERIFY_MAX_TOTAL_REPLAYS || Date.now() >= deadline) {
        truncated = true;
        break outer;
      }
      replays++;
      try {
        results.push(await args.deps.replayFeedOnSibling(propertyId, args.recipe, actionKey));
      } catch (err) {
        results.push({ propertyId, actionKey, verdict: 'inconclusive', reason: (err as Error).message });
      }
    }
  }
  const agg = aggregateSampleVerify(results);
  return {
    enabled: true,
    sampled: agg.sampled,
    failedSiblings: agg.failedSiblings,
    note: `pass=${agg.passed} fail=${agg.failed} inconclusive=${agg.inconclusive}${truncated ? ' (budget-truncated)' : ''}`,
  };
}

/**
 * Read-only replay of ONE feed on ONE sibling in a FRESH, ISOLATED browser. Never
 * touches the sibling's live session-driver page/process; reuses the sibling's
 * STORED session (scraper_session) so it does NOT fresh-login (which could evict
 * a single-session PMS and disturb the sibling's polling). Any ambiguity →
 * 'inconclusive' (never a false 'fail').
 */
async function replaySiblingFeedReadOnly(
  propertyId: string,
  recipe: Recipe,
  actionKey: string,
): Promise<SiblingVerifyResult> {
  const out = (verdict: SiblingVerifyVerdict, reason: string): SiblingVerifyResult => ({ propertyId, actionKey, verdict, reason });
  const credentials = await loadCredentials(propertyId);
  if (!credentials) return out('inconclusive', 'no_credentials');
  const { data: sess } = await supabase
    .from('scraper_session').select('state').eq('property_id', propertyId).maybeSingle();
  const storageState = (sess as { state?: Record<string, unknown> } | null)?.state;
  if (!storageState) return out('inconclusive', 'no_stored_session');

  const { templates } = recipeToTableTemplates(recipe);
  const template = templates.find((t) => t.sourceActionKey === actionKey);
  if (!template) return out('inconclusive', 'feed_not_in_recipe');
  if (template.incomplete) return out('inconclusive', 'feed_incomplete');
  if (template.sources.length !== 1) return out('inconclusive', 'multi_source_unsupported');

  // Re-host the feed URL onto THIS sibling's tenant origin (per-subdomain PMS).
  // The recipe URL is the MAPPER tenant's; without this, safeGoto's same-site
  // (registrable-domain) guard would let a wrong-tenant read through and the
  // replay would "verify" against the mapper's data → a false pass. Same-host
  // PMS (Choice Advantage) → no-op.
  const familyStartUrl = recipe.login?.startUrl ?? '';
  for (const source of template.sources) {
    source.url = rehostFeedUrl(source.url, familyStartUrl, credentials.loginUrl);
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      // Reuse the sibling's STORED session (jsonb) — never a fresh login.
      storageState: storageState as BrowserContextOptions['storageState'],
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const allowedHost = new URL(credentials.loginUrl).host;
    const run = await runSingleSourceTemplate({
      page, template, allowedHost, signal: AbortSignal.timeout(SAMPLE_VERIFY_REPLAY_TIMEOUT_MS),
    });
    if (!run.ok) return out('inconclusive', `run_failed:${run.reason ?? ''}`);
    if (run.rows.length < SAMPLE_VERIFY_MIN_ROWS) return out('inconclusive', `too_few_rows:${run.rows.length}`);
    const required = requiredColumnsForTarget(actionKey as keyof Recipe['actions']);
    if (required.length === 0) return out('pass', 'no_required_columns_to_check');
    for (const col of required) {
      const nonBlank = run.rows.filter((r) => {
        const v = r[col];
        return v !== null && v !== undefined && String(v).trim() !== '';
      }).length;
      const coverage = nonBlank / run.rows.length;
      if (coverage < SAMPLE_VERIFY_MIN_COVERAGE) {
        return out('fail', `required_column_blank_on_sibling:${col}(${coverage.toFixed(2)})`);
      }
    }
    return out('pass', `${run.rows.length} rows, required columns present`);
  } catch (err) {
    return out('inconclusive', (err as Error).message);
  } finally {
    if (browser) await browser.close().catch(() => { /* best-effort */ });
  }
}

/** fix/cua-freeform-capture-live — recipe to drive an on-demand capture. Prefer
 *  the ACTIVE map; for a hotel whose map is still a PARKED DRAFT (no active map,
 *  paused_no_knowledge_file → never polls) fall back to the latest non-deleted
 *  draft — exactly what the coverage editor renders its feeds from, so the
 *  capture matches the feed the founder is editing. */
async function loadActiveOrLatestDraftRecipe(pmsFamily: string): Promise<Recipe | null> {
  const active = await loadActive(pmsFamily);
  if (active) return active.knowledge as unknown as Recipe;
  const { data } = await supabase
    .from('pms_knowledge_files')
    .select('knowledge')
    .eq('pms_family', pmsFamily)
    .eq('status', 'draft')
    .is('deleted_at', null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const knowledge = (data as { knowledge?: unknown } | null)?.knowledge;
  return knowledge ? (knowledge as Recipe) : null;
}

const ON_DEMAND_CAPTURE_LAUNCH_TIMEOUT_MS = 30_000;
const ON_DEMAND_CAPTURE_NAV_TIMEOUT_MS = 45_000;
const ON_DEMAND_CAPTURE_SHOT_TIMEOUT_MS = 20_000;
// Nominal per-login cap passed to mapLogin. NOTE: this is INERT on the jobless
// capture path (mapLogin's per-turn budget gate keys on jobId, which is null
// here), so the REAL cost bounds are: the 90s wall-clock race below, mapLogin's
// internal step/token budget, the immediate MFA abstain (jobless logins never
// enter the 10-min code poll), and the org-wide daily mapping cap checked before
// we spend. A single re-login is ~$0.05-0.20. Kept for when a real jobId is wired.
const ON_DEMAND_CAPTURE_RELOGIN_CAP_MICROS = 1_000_000; // $1.00 (nominal)
const ON_DEMAND_CAPTURE_RELOGIN_TIMEOUT_MS = 90_000;

/** Universal "we got bounced to the PMS login form" signal — a visible password
 *  field. Data feed pages never render one; every PMS login page does. Best-
 *  effort, never throws. */
async function isOnLoginPage(page: Page): Promise<boolean> {
  try {
    return await page.locator('input[type="password"]').first().isVisible({ timeout: 2_000 });
  } catch { return false; }
}

/**
 * fix/cua-freeform-capture-live — ON-DEMAND drag-map capture.
 *
 * The freeform "drag on the screenshot" editor needs a screenshot + per-column
 * geometry (the sibling .boxes.json) for a feed. Normally the session-driver
 * refreshes that during polls — but a hotel whose map is still a PARKED DRAFT
 * has NO active session (paused_no_knowledge_file) and never polls, so the
 * drag-map never appears and the founder literally can't drag anything (the
 * exact Comfort Suites / Choice Advantage case).
 *
 * This first tries the STORED session (scraper_session.state — FREE, no Claude),
 * navigates to the ONE feed using its (active or latest-draft) recipe, and writes
 * screenshot + geometry to the STABLE live/{property}/{feed} keys the coverage
 * editor reads. If the stored session is EXPIRED (the feed nav bounces to the PMS
 * login page — common for a parked-draft hotel that never polls), it falls back
 * to ONE vision re-login (the only Claude-spending branch), gated by the org
 * daily mapping cap + bounded by a 90s race + immediate MFA abstain, then refreshes
 * the stored cookies so the NEXT capture is free again. Best-effort: any failure
 * returns a reason and the editor degrades to "try Re-map".
 */
export async function captureFeedOnDemand(args: {
  propertyId: string;
  pmsFamily: string;
  feedKey: string;
  /** The job-level abort signal (workflow-runtime fires it on the job timeout).
   *  Threaded into the nav + checked before launch so a hung browser can't pin
   *  the shared no-driver lane past the job budget (review P-MEDIUM-1). */
  signal?: AbortSignal;
}): Promise<{ ok: boolean; reason?: string }> {
  const { propertyId, pmsFamily, feedKey, signal } = args;
  if (signal?.aborted) return { ok: false, reason: 'aborted' };
  const credentials = await loadCredentials(propertyId);
  if (!credentials) return { ok: false, reason: 'no_credentials' };

  const { data: sess } = await supabase
    .from('scraper_session').select('state').eq('property_id', propertyId).maybeSingle();
  const storageState = (sess as { state?: Record<string, unknown> } | null)?.state;
  if (!storageState) return { ok: false, reason: 'no_stored_session' };

  const recipe = await loadActiveOrLatestDraftRecipe(pmsFamily);
  if (!recipe) return { ok: false, reason: 'no_recipe' };

  const { templates } = recipeToTableTemplates(recipe);
  const template = templates.find((t) => t.sourceActionKey === feedKey);
  if (!template) return { ok: false, reason: 'feed_not_in_recipe' };
  if (template.incomplete) return { ok: false, reason: 'feed_incomplete' };
  if (template.sources.length !== 1) return { ok: false, reason: 'multi_source_unsupported' };

  // Re-host the feed URL onto THIS hotel's tenant origin (per-subdomain PMS);
  // same-host PMS (Choice Advantage) → no-op. Without it safeGoto's same-site
  // guard could read the wrong tenant.
  const familyStartUrl = recipe.login?.startUrl ?? '';
  for (const source of template.sources) {
    source.url = rehostFeedUrl(source.url, familyStartUrl, credentials.loginUrl);
  }
  const rowSelector = template.sources[0]?.selectors?.rowSelector;

  let browser: Browser | null = null;
  try {
    // Bound the launch so a stuck Chromium spawn can't pin the shared no-driver
    // lane (review P-MEDIUM-1). newContext/newPage are fast; the nav + screenshot
    // below are independently bounded.
    browser = await chromium.launch({ headless: true, timeout: ON_DEMAND_CAPTURE_LAUNCH_TIMEOUT_MS });
    const context = await browser.newContext({
      // Reuse the STORED session (jsonb) — never a fresh login.
      storageState: storageState as BrowserContextOptions['storageState'],
      acceptDownloads: true,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const allowedHost = new URL(credentials.loginUrl).host;
    const navSignal = (): AbortSignal => {
      const navTimeout = AbortSignal.timeout(ON_DEMAND_CAPTURE_NAV_TIMEOUT_MS);
      return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, navTimeout]) : navTimeout;
    };
    // Navigate to the feed (goto + preSteps). The EXTRACTION result is ignored —
    // we just need the page sitting ON the feed table so the capture sees it.
    let run = await runSingleSourceTemplate({ page, template, allowedHost, signal: navSignal() });

    // The STORED session can be expired (a parked-draft hotel never polls, so its
    // cookies are never refreshed) — the feed nav then bounces to the PMS login
    // page and we'd screenshot THAT (no table → the founder's "no_table"). If we
    // landed on a login form, log in fresh via the PROVEN mapper login (handles
    // CA's Okta nag + trusted-device, so it usually skips MFA), REFRESH the stored
    // cookies so the next capture is free, then re-navigate to the feed.
    if (await isOnLoginPage(page)) {
      // This is the ONE branch that spends Claude $ (a vision re-login). Gate it
      // behind the org-wide daily mapping-spend net BEFORE spending, mirroring
      // runMappingJob — the cheap stored-cookie path above never reaches here.
      const dailyCap = await checkDailyMappingSpend();
      if (dailyCap.over) {
        log.warn('capture-feed: refusing re-login — org daily mapping spend cap exceeded', {
          propertyId, feedKey, spentDollars: microsToDollars(dailyCap.spentMicros),
        });
        return { ok: false, reason: 'daily_cap' };
      }
      log.info('capture-feed: stored session expired — re-logging in', { propertyId, feedKey });
      // Bound the login so it can't hang the shared no-driver lane. CA's
      // trusted-device cookie usually skips MFA; a jobless login abstains
      // IMMEDIATELY on a real MFA screen (mapper.ts) rather than polling for a
      // code, so the 90s race is the wall-clock bound, not a 10-min MFA wait.
      // .catch keeps the background promise from becoming an unhandled rejection
      // when the timeout wins (finally closes the browser, unwinding mapLogin).
      const loginPromise = mapLogin(page, credentials, {
        propertyId, jobId: null, signal,
        jobCostCapMicros: ON_DEMAND_CAPTURE_RELOGIN_CAP_MICROS,
      }).then((r) => ({ ok: r.ok })).catch(() => ({ ok: false }));
      const login = await Promise.race([
        loginPromise,
        new Promise<{ ok: boolean }>((resolve) => setTimeout(() => resolve({ ok: false }), ON_DEMAND_CAPTURE_RELOGIN_TIMEOUT_MS)),
      ]);
      if (!login.ok) return { ok: false, reason: 'relogin_needed' };
      await saveTrustedSession(propertyId, page);
      run = await runSingleSourceTemplate({ page, template, allowedHost, signal: navSignal() });
      // Still on the login wall after a "successful" login → MFA/credentials issue.
      if (await isOnLoginPage(page)) return { ok: false, reason: 'relogin_needed' };
    }
    if (!run.ok) {
      log.warn('capture-feed: feed run not ok — capturing current page anyway', {
        propertyId, feedKey, reason: run.reason,
      });
    }
    // captureLiveFeedProvenance is best-effort + never throws; bound it anyway so
    // a hung screenshot can't pin the job past its budget.
    await Promise.race([
      captureLiveFeedProvenance({ page, propertyId, feedKey, ...(rowSelector ? { rowSelector } : {}) }),
      new Promise<void>((resolve) => setTimeout(resolve, ON_DEMAND_CAPTURE_SHOT_TIMEOUT_MS)),
    ]);
    // Persist a small live SAMPLE of what was read (the "Captured" preview).
    // sampleRows survives the contract gate (blank required cols), so the founder
    // still sees the values — including a blank column they then drag to fix.
    // Feed-level PAGE values (e.g. "Guest Count: 23") ride along in the sample's
    // pageValues block AND are stored durably once per feed (pms_feed_values).
    await uploadLiveFeedSample(propertyId, feedKey, run.sampleRows ?? run.rows, run.feedValues);
    await upsertFeedValues(propertyId, feedKey, run.feedValues, (template.pageColumns?.length ?? 0) > 0);
    return { ok: true };
  } catch (err) {
    if (err instanceof UnsafeNavigationError) return { ok: false, reason: `unsafe_url:${err.reason}` };
    return { ok: false, reason: (err as Error).message.slice(0, 200) };
  } finally {
    if (browser) await browser.close().catch(() => { /* best-effort */ });
  }
}

function defaultSampleVerifyDeps(): SampleVerifyDeps {
  return {
    selectSiblings: async (pmsFamily, excludePropertyId, limit) => {
      const { data, error } = await supabase
        .from('property_sessions').select('property_id, status').eq('pms_family', pmsFamily);
      if (error || !data) return [];
      return (data as Array<{ property_id: string; status: string }>)
        .filter((r) => r.property_id !== excludePropertyId && r.status === 'alive')
        .map((r) => r.property_id)
        .slice(0, limit);
    },
    replayFeedOnSibling: (propertyId, recipe, actionKey) => replaySiblingFeedReadOnly(propertyId, recipe, actionKey),
  };
}

/** PURE. Derive a golden-fixture FRESH SHAPE from the candidate recipe itself
 *  (the mapping-driver path has no per-feed live re-extraction). A column is
 *  'certified' unless the recipe carries it in `unprovenRequiredColumns`. Catches
 *  the structural regression a re-learn can introduce: a previously-certified
 *  column DROPPED from the new recipe. (The re-anchor path supplies REAL values
 *  → certified→failed is caught there too.) */
export function recipeFreshShape(recipe: Recipe, actionKey: string): FreshExtractionShape | null {
  const action = recipe.actions[actionKey as keyof Recipe['actions']];
  if (!action) return null;
  const colMap = effectiveColumnsFromAction(actionKey as keyof Recipe['actions'], action);
  const columns = Object.keys(colMap).filter((c) => typeof colMap[c] === 'string' && colMap[c]!.trim() !== '');
  const carried = (action as { unprovenRequiredColumns?: unknown }).unprovenRequiredColumns;
  const unproven = new Set(Array.isArray(carried) ? carried.filter((c): c is string => typeof c === 'string') : []);
  const columnVerdicts: Record<string, FixtureColumnVerdict> = {};
  for (const c of columns) columnVerdicts[c] = unproven.has(c) ? 'uncertain' : 'certified';
  // hasValueEvidence:false on purpose — this path has NO live re-extraction, only
  // recipe structure. So the golden-fixture gate uses it ONLY to detect a DROPPED
  // certified column (a structural regression a re-learn can introduce); a
  // certified→failed VALUE regression needs real rows and is caught on the
  // re-anchor path's freshShape, which carries honest hasValueEvidence.
  return { parseMode: action.parse.mode, columns, columnVerdicts, hasValueEvidence: false, rowCount: -1 };
}

export function computeGoldenFixtureGate(args: {
  pmsFamily: string;
  recipe: Recipe;
  targets: string[];
  /** Re-anchor supplies REAL fresh shapes (live values); the mapping path passes
   *  recipeFreshShape (structural). */
  freshShapeFor: (actionKey: string) => FreshExtractionShape | null;
}): GoldenFixtureGateInput {
  const regressed: string[] = [];
  for (const actionKey of args.targets) {
    const fixture = loadGoldenFixture(args.pmsFamily, actionKey);
    if (!fixture) continue; // ABSENT ⟹ skip (no gate)
    const fresh = args.freshShapeFor(actionKey);
    if (!fresh) continue;
    const verdict = gateAgainstFixture({ fixture, fresh });
    if (verdict.regressed) {
      regressed.push(actionKey);
      log.warn('mapping-driver: golden-fixture regression', { pmsFamily: args.pmsFamily, actionKey, reason: verdict.reason });
    }
  }
  return { enabled: true, regressedFeeds: regressed };
}

export interface PromoteRecipeChangeArgs {
  pmsFamily: string;
  recipe: Recipe;
  /** All actions EXCEPT the changed one(s) — the seed-guard exemption (a repair
   *  shape). The changed target(s) are freshly proven, so they are NOT seeded. */
  seedActions?: Recipe['actions'];
  /** Targets that changed (sample-verify + golden-fixture scope). */
  changedTargets: string[];
  /** Re-anchor supplies REAL fresh shapes for golden-fixture; absent → structural. */
  freshShapeFor?: (actionKey: string) => FreshExtractionShape | null;
  /** Origin label for logs / the draft gate note (e.g. 'reanchor'). */
  origin: string;
  /** The hotel that originated the change — excluded from sibling sampling. */
  excludePropertyId?: string | null;
}

export interface PromoteRecipeChangeResult {
  ok: boolean;
  decision: 'auto_promote' | 'park_partial' | 'park_draft' | 'quarantine';
  reason: string;
  activated: boolean;
  draftId?: string;
  version?: number;
  error?: string;
}

/**
 * The SHARED promotion gauntlet for an out-of-band recipe change (the rung-2
 * re-anchor). Runs the SAME sequence runMappingJob does — base gate → (auto-
 * promote only) sample-verify + golden-fixture → save signed draft → promote —
 * so a cheap re-anchor is held to the EXACT fleet-safety bar as a paid re-learn.
 * Activates ONLY on auto_promote; anything else saves a draft for founder review
 * and leaves the current active untouched (never zero-active).
 */
export async function promoteRecipeChange(args: PromoteRecipeChangeArgs): Promise<PromoteRecipeChangeResult> {
  let gate = evaluatePromotionGate(args.recipe, args.seedActions);
  if (gate.decision === 'auto_promote') {
    let sampleVerify: SampleVerifyGateInput | undefined;
    let goldenFixture: GoldenFixtureGateInput | undefined;
    if (goldenFixtureGateEnabled()) {
      goldenFixture = computeGoldenFixtureGate({
        pmsFamily: args.pmsFamily,
        recipe: args.recipe,
        targets: args.changedTargets,
        freshShapeFor: args.freshShapeFor ?? ((k) => recipeFreshShape(args.recipe, k)),
      });
    }
    if (sampleVerifyEnabled()) {
      try {
        sampleVerify = await computeSampleVerifyGate({
          pmsFamily: args.pmsFamily,
          recipe: args.recipe,
          changedTargets: args.changedTargets,
          excludePropertyId: args.excludePropertyId ?? null,
          deps: defaultSampleVerifyDeps(),
        });
      } catch (err) {
        log.warn('promoteRecipeChange: sample-verify threw — proceeding without it', { origin: args.origin, err: (err as Error).message });
      }
    }
    if (sampleVerify || goldenFixture) {
      gate = evaluatePromotionGate(args.recipe, args.seedActions, undefined, sampleVerify, goldenFixture);
    }
  }

  const initialStatus = gate.decision === 'quarantine' ? 'quarantined' : 'draft';
  const draft = await saveDraftKnowledgeFile(
    args.pmsFamily, args.recipe, initialStatus, gate.feedGaps, `${args.origin}/${gate.decision}: ${gate.reason}`,
  );
  if (!draft.ok) {
    return { ok: false, decision: gate.decision, reason: gate.reason, activated: false, error: draft.error };
  }
  let activated = false;
  if (shouldActivateImmediately(gate.decision)) {
    const promoted = await promoteDraft(args.pmsFamily, draft.id);
    if (promoted.ok) {
      activated = true;
      await reviveNoKnowledgeSessions(args.pmsFamily);
    } else {
      gate.decision = 'park_draft';
      gate.reason = `promotion failed: ${promoted.error}`;
    }
  }
  return { ok: true, decision: gate.decision, reason: gate.reason, activated, draftId: draft.id, version: draft.version };
}

// ─── Best-class verification (feature/cua-bestclass-verify) ─────────────────
//
// Computed ONCE per FRESH, unseeded full learn (the orchestration gates on
// that), NEVER at the 30s poll. Folds four INDEPENDENT signals into the
// calibrated commit decision the gate consumes, and persists the telemetry +
// pass^N counter into the signed envelope. Cross-feed + fingerprint are pure
// (free); the second-model vote is env-gated OFF by default; the prior-pass
// read is one cheap query. Everything fail-OPEN: any error degrades to "no
// signal", never blocks a learn.

/** Build cross-feed-reconcile inputs from the Learning-Board previews carried
 *  out of mapPMS (boardTargets). getDashboardCounts is a single-row counter
 *  feed → its first preview row supplies the dashboard counters; every other
 *  feed contributes its rowCount (and a truncated sample). NEVER routes
 *  getDashboardCounts through reconcileRows. Pure + exported for tests. */
export function gatherCrossFeedObservation(
  boardTargets: Record<string, BoardTargetState> | undefined,
): { feeds: Record<string, FeedObservation>; dashboardCounters: Record<string, number | null> } {
  const feeds: Record<string, FeedObservation> = {};
  const dashboardCounters: Record<string, number | null> = {};
  for (const [key, st] of Object.entries(boardTargets ?? {})) {
    const preview = st?.preview;
    if (!preview) continue;
    if (key === 'getDashboardCounts') {
      const row = preview.sample?.[0];
      if (row) for (const [col, val] of Object.entries(row)) dashboardCounters[col] = parseCounter(val);
      continue;
    }
    const obs: FeedObservation = {};
    if (typeof preview.rowCount === 'number') obs.rowCount = preview.rowCount;
    if (Array.isArray(preview.sample)) {
      obs.rows = preview.sample;
      // NEVER mark the board preview "complete": its rows are RAW DOM text
      // (un-translated — e.g. "Occ"/"VC", not the canonical occupied/vacant_clean
      // the exact predicate expects) and truncated to ≤3. Either alone makes an
      // exact predicate count unsound (review P2: a tiny-property preview could
      // exact-count 0 against a positive counter → false mismatch). Cross-feed
      // therefore uses ONLY the SOUND lower-bound (rowCount ≥ counter) from this
      // wiring. The exact path stays in cross-feed-reconcile.ts for callers that
      // pass canonical full rows (a documented follow-up: canonicalize preview
      // statuses to enable exact occupancy reconcile).
      obs.rowsComplete = false;
    }
    feeds[key] = obs;
  }
  return { feeds, dashboardCounters };
}

/**
 * STRUCTURAL fingerprint of the recipe's REQUIRED feeds — the pass^N
 * consistency anchor. Adversarial review (both reviewers, P1) showed a
 * fingerprint derived from the ≤3-row live preview NEVER converges: the specific
 * rows differ between two onboarding passes minutes apart (occupancy changes,
 * paging), so the counter reset to 1 every time and pass^N (N≥2) could never
 * accumulate. This builds the anchor from STABLE recipe structure instead — feed
 * present + parse mode + sorted mapped columns + the learned enum vocabulary —
 * so an unchanged recipe re-derives an IDENTICAL fingerprint (converges), AND
 * two hotels on the SAME family with the same structure corroborate each other
 * (genuine "before it goes family-wide"). The live preview is used ONLY for the
 * one-shot degenerate-key SANITY flag, never for the cross-pass string. Pure +
 * exported. */
export function computeRecipeFingerprint(
  recipe: Recipe,
  boardTargets: Record<string, BoardTargetState> | undefined,
): { fingerprint: string; sane: boolean } {
  const parts: string[] = [];
  let sane = true;
  for (const t of REQUIRED_TARGETS) {
    const action = recipe.actions[t];
    if (!action) continue;
    const mode = action.parse?.mode ?? 'none';
    const colMap = effectiveColumnsFromAction(t, action);
    const cols = Object.keys(colMap)
      .filter((c) => typeof colMap[c] === 'string' && colMap[c]!.trim() !== '')
      .sort();
    const table = CORE_TARGET_CONTRACTS[t]?.table;
    const vocab = table ? learnedVocabFor(recipe.valueTranslations, table) : '';
    parts.push(`${String(t)}|${mode}|${cols.join(',')}|${vocab}`);

    // One-shot sanity (degenerate key) from the live preview — NOT part of the
    // cross-pass string (those rows vary between passes).
    const keyField = DISCOVERY_KEY_COLUMNS[t];
    const rows = boardTargets?.[String(t)]?.preview?.sample;
    if (keyField && Array.isArray(rows) && rows.length > 0) {
      const fp = valueFingerprint({ feed: String(t), rows, keyField });
      if (!fp.sane) sane = false;
    }
  }
  return { fingerprint: parts.sort().join(';'), sane };
}

/** Sorted, stable summary of the learned enum vocabulary for a table from
 *  recipe.valueTranslations (keyed `${table}.${col}`) — part of the structural
 *  fingerprint so a recipe that re-learned a DIFFERENT status vocabulary is a
 *  different shape, while the SAME vocabulary corroborates. */
function learnedVocabFor(
  valueTranslations: Recipe['valueTranslations'] | undefined,
  table: string,
): string {
  if (!valueTranslations) return '';
  const cols: string[] = [];
  for (const [key, mapping] of Object.entries(valueTranslations)) {
    if (!key.startsWith(`${table}.`)) continue;
    const col = key.slice(table.length + 1);
    const canon = [...new Set(Object.values(mapping ?? {}).map((v) => String(v)))].sort();
    cols.push(`${col}=${canon.join('/')}`);
  }
  return cols.sort().join('&');
}

/** Reconcile (proof) signal for the score: 'fail' iff a required target ships a
 *  live, non-blank required column that was NOT value-certified / api-reconciled
 *  (the same shape the gate's unprovenByTarget uses). Mirrors — does not fork —
 *  the proof state; reconcileRows / certifyColumns own the verdicts. */
function reconcileSignalForRecipe(recipe: Recipe): SignalVerdict {
  for (const t of REQUIRED_TARGETS) {
    const action = recipe.actions[t];
    if (!action) continue;
    if (action.parse?.mode === 'api') continue; // oracle-reconciled JSON path
    const carried = (action as { unprovenRequiredColumns?: unknown }).unprovenRequiredColumns;
    if (!Array.isArray(carried) || carried.length === 0) continue;
    const cols = effectiveColumnsFromAction(t, action);
    const live = carried.some(
      (c): c is string => typeof c === 'string' && typeof cols[c] === 'string' && cols[c]!.trim() !== '',
    );
    if (live) return 'fail';
  }
  return 'pass';
}

export interface ComputedVerification {
  gateInput: VerificationGateInput;
  persist: RecipeVerification;
}

/**
 * Compute the full verification verdict for a fresh learn: gather the four
 * signals, score them, read the prior family pass^N counter, and assemble both
 * the gate input and the envelope telemetry to persist. Read-only DB access;
 * fail-open throughout.
 */
export async function computeRecipeVerification(args: {
  pmsFamily: string;
  recipe: Recipe;
  boardTargets?: Record<string, BoardTargetState>;
  jobId: string | null;
  propertyId: string | null;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the real (env-gated, fail-open) vote. */
  secondModelVote?: (a: SecondModelVoteArgs) => Promise<SignalVerdict>;
}): Promise<ComputedVerification> {
  const enforce = verifyEnforceOn();
  const threshold = verifyThreshold();
  const requiredPasses = verifyRequiredPasses();

  // (b) cross-feed reconciliation.
  const obs = gatherCrossFeedObservation(args.boardTargets);
  const crossFeedResult = reconcileCrossFeed({ feeds: obs.feeds, dashboardCounters: obs.dashboardCounters });
  const crossFeed: SignalVerdict =
    crossFeedResult.signal === 'fail' ? 'fail' : crossFeedResult.signal === 'pass' ? 'pass' : 'abstain';

  // (c) value-fingerprint: degenerate distribution ⟹ fail; else decided below
  //     by cross-pass consistency.
  const fp = computeRecipeFingerprint(args.recipe, args.boardTargets);

  // (a) reconcile/certify proof state.
  const reconcile = reconcileSignalForRecipe(args.recipe);

  // (d) cheap second-model vote (env-gated OFF by default → 'abstain'). Skip the
  //     paid call entirely if the job is already aborting (don't honor a doomed
  //     request) — fail-open to 'abstain'.
  const voteFn = args.secondModelVote ?? secondModelRecipeVote;
  let secondModel: SignalVerdict = 'abstain';
  if (!args.signal?.aborted) {
    try {
      secondModel = await voteFn({
        recipe: args.recipe, boardTargets: args.boardTargets,
        jobId: args.jobId, propertyId: args.propertyId, signal: args.signal,
      });
    } catch {
      secondModel = 'abstain'; // fail-open
    }
  }

  // ── pass^N: read the family's most-recent prior verification fingerprint ──
  const prior = await loadPriorVerification(args.pmsFamily);
  const matchedPrior = fingerprintsMatch(prior?.fingerprint, fp.fingerprint);
  const fingerprint: SignalVerdict = !fp.sane ? 'fail' : matchedPrior ? 'pass' : 'abstain';

  const signals: CommitSignals = { reconcile, crossFeed, fingerprint, secondModel };
  const { score } = computeCommitScore(signals);

  // A "consistent pass" is one that BOTH met the threshold AND re-derived the
  // same fingerprint as the prior qualifying pass. A sub-threshold pass resets
  // the counter to 0 (nothing to build on); a fresh/divergent shape resets to 1.
  const qualifies = score >= threshold;
  const priorQualified = (prior?.consistentPasses ?? 0) > 0;
  const consistentPasses = !qualifies ? 0 : (priorQualified && matchedPrior) ? (prior!.consistentPasses ?? 0) + 1 : 1;

  const note = `signals reconcile=${reconcile} crossFeed=${crossFeed} fingerprint=${fingerprint} secondModel=${secondModel}`;

  return {
    gateInput: { enforce, score, threshold, consistentPasses, requiredPasses, note },
    persist: {
      threshold, score, consistentPasses, requiredPasses,
      enforced: enforce,
      fingerprint: fp.fingerprint,
      computedAt: new Date().toISOString(),
      signals: { reconcile, crossFeed, fingerprint, secondModel },
    },
  };
}

/** The most-recent prior verification telemetry for a family (latest version,
 *  any status) — drives the pass^N counter. Fail-open: any error ⟹ null (the
 *  counter simply starts fresh). */
async function loadPriorVerification(pmsFamily: string): Promise<RecipeVerification | null> {
  try {
    const { data, error } = await supabase
      .from('pms_knowledge_files')
      .select('knowledge')
      .eq('pms_family', pmsFamily)
      .is('deleted_at', null)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const v = (data.knowledge as { verification?: RecipeVerification } | null)?.verification;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export interface SecondModelVoteArgs {
  recipe: Recipe;
  boardTargets?: Record<string, BoardTargetState>;
  jobId: string | null;
  propertyId: string | null;
  signal?: AbortSignal;
}

const VOTE_SYSTEM =
  'You are a strict reviewer of an automatically-learned data-extraction recipe ' +
  'for a hotel PMS. You are given, per required feed, the column→source mapping ' +
  'and a few sample values. Judge whether the mapping is PLAUSIBLE (each column ' +
  'name matches the kind of value sampled for it). Respond on TWO lines, no ' +
  'preamble, no markdown:\nVERDICT: <approve|unclear|reject>\nREASON: <one short sentence>\n' +
  '- approve: every sampled value matches its column meaning.\n' +
  '- reject: at least one column is clearly mapped to the WRONG kind of value ' +
  '(e.g. a date in a name column, a status string in an id column).\n' +
  '- unclear: you cannot tell from the samples.';

/**
 * Cheap second-model sanity vote on the learned recipe (mirrors critic.ts:
 * Sonnet, fail-open, cost-attributed, abort-aware). ENV-GATED OFF by default —
 * returns 'abstain' with zero LLM cost unless CUA_VERIFY_SECOND_MODEL_ENABLED=
 * true. Onboarding-only (called from computeRecipeVerification). Lazy-imports
 * the SDK + usage log so the module-load graph (and the test suite) is
 * unaffected when the vote is off.
 */
export async function secondModelRecipeVote(args: SecondModelVoteArgs): Promise<SignalVerdict> {
  if (!secondModelVoteOn()) return 'abstain';
  try {
    const prompt = buildVotePrompt(args.recipe, args.boardTargets);
    if (!prompt) return 'abstain'; // nothing concrete to judge
    const { anthropic } = await import('./anthropic-client.js');
    const resp = await anthropic.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: VOTE_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      },
      args.signal ? { signal: args.signal } : undefined,
    );
    try {
      const { logClaudeUsage } = await import('./usage-log.js');
      await logClaudeUsage(resp.usage ?? {}, {
        // Reuse the mapping-action workload so this onboarding-only spend is
        // tagged source='mapping' (excluded from the per-hotel daily cost cap,
        // migration 0208); the phase metadata distinguishes the verify vote.
        workload: 'cua_mapping_action',
        model: 'claude-sonnet-4-6',
        propertyId: args.propertyId,
        jobId: args.jobId,
        metadata: { phase: 'second_model_verify_vote' },
      });
    } catch { /* cost log is best-effort */ }
    const text = resp.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text?: string }).text ?? '')
      .join('\n');
    const m = text.match(/VERDICT\s*:\s*(approve|unclear|reject)/i);
    const v = m?.[1]?.toLowerCase();
    return v === 'approve' ? 'pass' : v === 'reject' ? 'fail' : 'abstain';
  } catch {
    return 'abstain'; // fail-open: a vote error never blocks a learn
  }
}

/** Build a compact, PII-light vote prompt from the required feeds' column maps +
 *  a couple of sample values. Returns '' when there's nothing concrete. */
function buildVotePrompt(
  recipe: Recipe,
  boardTargets: Record<string, BoardTargetState> | undefined,
): string {
  const lines: string[] = [];
  for (const t of REQUIRED_TARGETS) {
    const action = recipe.actions[t];
    if (!action) continue;
    const cols = effectiveColumnsFromAction(t, action);
    const colNames = Object.keys(cols).filter((c) => (cols[c] ?? '').trim() !== '');
    if (colNames.length === 0) continue;
    lines.push(`FEED ${String(t)}:`);
    const sample = boardTargets?.[String(t)]?.preview?.sample?.[0] ?? {};
    for (const c of colNames) {
      const raw = sample[c];
      const masked = /name|guest|assigned|changed_by/i.test(c) && typeof raw === 'string'
        ? raw.replace(/[A-Za-z]/g, 'x').replace(/\d/g, '#')
        : raw;
      const shown = masked == null ? '(no sample)' : String(masked).slice(0, 40);
      lines.push(`  ${c} ⟵ ${shown}`);
    }
  }
  return lines.length > 0 ? `Recipe to review:\n${lines.join('\n')}` : '';
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
    .is('deleted_at', null)
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
  const nowIso = new Date().toISOString();

  // These are separate, non-transactional statements (no migration is in
  // scope to add a demote+promote RPC — the truly atomic fix, mirroring
  // FAILSAFES.md's promote_shadow_model_run). So the only authoritative truth
  // is the DB, and every state-changing UPDATE below CONFIRMS its row-level
  // effect with `.select().maybeSingle()` — a Supabase UPDATE reports no error
  // even when it matched ZERO rows, so an unconfirmed update can't be trusted
  // to mean "it happened". Small read helpers keep the never-zero-active logic
  // honest and DRY (inlined here to respect this change's edit scope).
  const familyActiveExists = async (): Promise<boolean | null> => {
    const { data, error } = await supabase
      .from('pms_knowledge_files')
      .select('id').eq('pms_family', pmsFamily).eq('status', 'active').is('deleted_at', null).maybeSingle();
    if (error) return null; // unknown — caller decides conservatively
    return !!data;
  };
  const draftIsActive = async (): Promise<boolean> => {
    const { data } = await supabase
      .from('pms_knowledge_files')
      .select('status').eq('id', newDraftId).maybeSingle();
    return (data?.status as string | undefined) === 'active';
  };
  // Re-activate the EXACT row we removed, by id. Guarded on status='deprecated'
  // + the one-active partial index → can never create a second active (a
  // would-be double-write just matches 0 rows). Returns true only if a row
  // actually flipped, so a 0-row no-op is never mistaken for a restore.
  const restoreActiveById = async (id: string, promotedAt: string | null): Promise<boolean> => {
    const { data, error } = await supabase
      .from('pms_knowledge_files')
      .update({ status: 'active', promoted_to_active_at: promotedAt ?? nowIso, deprecated_at: null })
      .eq('id', id).eq('status', 'deprecated')
      .is('deleted_at', null)
      .select('id').maybeSingle();
    return !error && !!data;
  };
  // Last-DITCH only: promote the newest deprecated row. Used solely when the
  // by-id restore could not be applied (the exact row changed under us). This
  // may promote a DIFFERENT deprecated recipe than the one we removed, but it
  // restores SERVICE rather than stranding the family at zero active — an
  // acceptable last resort. Ported from the deleted knowledge-file.ts
  // quarantine→promote-previous-active logic. Returns true only if a row flipped.
  const restoreNewestDeprecated = async (): Promise<boolean> => {
    const { data: prev } = await supabase
      .from('pms_knowledge_files')
      .select('id').eq('pms_family', pmsFamily).eq('status', 'deprecated')
      .is('deleted_at', null)
      .order('version', { ascending: false }).limit(1).maybeSingle();
    if (!prev) return false;
    return restoreActiveById(prev.id as string, null);
  };

  // Snapshot the EXACT active row up front. Capturing its id (vs guessing by
  // version rank later) is what lets us, on any failure, (a) restore the right
  // recipe by id, and (b) NOT resurrect deprecated history for a family that
  // was already at zero active — a first learn, or one an admin deliberately
  // took offline. `priorActive === null` means "we removed nothing".
  const { data: priorActive, error: priorErr } = await supabase
    .from('pms_knowledge_files')
    .select('id, promoted_to_active_at')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  if (priorErr) {
    // We could not read the current active. REFUSE to start mutating: a failed
    // snapshot would silently become `priorActive = null`, disabling the by-id
    // recovery below — so a later demote+promote failure could strand the
    // family at zero active. Bail before touching anything; the caller parks
    // the draft and nothing has changed.
    return { ok: false, error: `could not read current active before promote: ${priorErr.message}` };
  }

  // Demote the prior active FIRST — the partial unique index
  // pms_knowledge_files_one_active_per_family forbids two active rows, so we
  // can't promote-then-demote.
  const { error: demErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'deprecated', deprecated_at: nowIso })
    .eq('pms_family', pmsFamily)
    .eq('status', 'active');
  if (demErr) {
    // The demote response errored, but it MAY have committed server-side (a
    // lost ack). Branch on what we can observe:
    //   - active still exists → the demote didn't take → bail safely (the
    //     prior active is live).
    //   - active gone, OR the re-read itself failed (stillActive === null) —
    //     and we HAD a prior active → attempt the guarded by-id restore. It
    //     flips priorActive back to active ONLY if it is now 'deprecated' (the
    //     committed case); if the demote didn't actually take, the
    //     `.eq('status','deprecated')` guard makes it a safe 0-row no-op. So
    //     trying it even when stillActive is unknown can only help, never
    //     double-activate.
    //   - we never had an active (priorActive === null) → restore NOTHING; do
    //     not resurrect a deliberately-offline family.
    const stillActive = await familyActiveExists();
    if (stillActive !== true && priorActive) {
      const restored = await restoreActiveById(
        priorActive.id as string, priorActive.promoted_to_active_at as string | null,
      );
      if (restored) {
        log.warn('mapping-driver: promoteDraft demote errored after committing — restored the prior active by id (no zero-active window)', {
          pmsFamily, newDraftId, restoredId: priorActive.id, err: demErr.message,
        });
      } else if (stillActive === false) {
        log.error('mapping-driver: promoteDraft demote errored after committing AND the by-id restore failed — family may have NO active recipe', {
          pmsFamily, newDraftId, priorActiveId: priorActive.id, err: demErr.message,
        });
      }
    } else if (stillActive === null) {
      log.error('mapping-driver: promoteDraft demote errored and the active-state re-read also failed (no prior active to restore)', {
        pmsFamily, newDraftId, err: demErr.message,
      });
    }
    return { ok: false, error: `demote failed: ${demErr.message}` };
  }

  // Promote the new draft. Status-guarded (ported from the deleted
  // knowledge-file.ts promoteToActive) so we only flip a real draft/deprecated
  // row; maybeSingle returns null data + null error when nothing matched (e.g.
  // the draft was concurrently changed) — treated as a failure, not a no-op.
  const { data: promoted, error: promErr } = await supabase
    .from('pms_knowledge_files')
    .update({ status: 'active', promoted_to_active_at: nowIso })
    .eq('id', newDraftId)
    .eq('pms_family', pmsFamily)
    .in('status', ['draft', 'deprecated'])
    .select('id')
    .maybeSingle();
  if (!promErr && promoted) return { ok: true };

  const failReason = promErr?.message ?? 'draft was not in a promotable (draft/deprecated) state — no row matched';

  // Partial-success guard: a promote can COMMIT server-side yet still surface
  // an error/empty response (lost ack), or a concurrent promote may have
  // activated this same draft. If the draft is already active, the desired
  // end-state holds — return ok so the caller revives sessions instead of
  // spuriously rolling back (which would trip the one-active unique index)
  // and reporting a false failure.
  if (await draftIsActive()) {
    log.warn('mapping-driver: promoteDraft promote reported an error but the draft is active — treating as success', {
      pmsFamily, newDraftId, reason: failReason,
    });
    return { ok: true };
  }

  // The new draft did NOT go live. Restore an active ONLY if THIS call removed
  // one. If priorActive was null — the family was already at zero active (a
  // first learn, or an admin who deliberately took it offline) — do NOT
  // resurrect a deprecated recipe: leave the draft parked, return failure, and
  // let the caller downgrade to park_draft for manual review.
  if (priorActive) {
    // (1) Undo the exact demotion, by id.
    if (await restoreActiveById(priorActive.id as string, priorActive.promoted_to_active_at as string | null)) {
      log.warn('mapping-driver: promoteDraft promote failed — restored the previously-active recipe by id (no zero-active window)', {
        pmsFamily, newDraftId, restoredId: priorActive.id, reason: failReason,
      });
    } else if (await restoreNewestDeprecated()) {
      // (2) The by-id restore didn't apply (row changed beneath us) — last
      //     ditch: promote the newest deprecated to restore service.
      log.warn('mapping-driver: promoteDraft promote failed and the by-id rollback did not apply — restored newest deprecated as last-known-good', {
        pmsFamily, newDraftId, reason: failReason,
      });
    } else if (await draftIsActive()) {
      // (3) Nothing to restore because the promote actually applied after all
      //     (the earlier re-read mis-fired). The draft is live — success.
      log.warn('mapping-driver: promoteDraft — draft is active after all; treating as success', {
        pmsFamily, newDraftId,
      });
      return { ok: true };
    } else {
      log.error('mapping-driver: promoteDraft promote failed and NO active could be restored — family may have NO active recipe', {
        pmsFamily, newDraftId, reason: failReason,
      });
    }
  } else {
    log.warn('mapping-driver: promoteDraft promote failed; no prior active existed, so leaving the new draft parked (not resurrecting deprecated history)', {
      pmsFamily, newDraftId, reason: failReason,
    });
  }

  return { ok: false, error: `promote failed: ${failReason}` };
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

// Exported for feature/cua-coverage-editor: the delete-feed worker job
// (recipe-edit.ts) reuses this EXACT signed-write path so a hand-built
// "active recipe minus one feed" lands as a properly HMAC-signed new draft
// version (the app can't re-sign — RECIPE_SIGNING_KEY is Fly-only).
export async function saveDraftKnowledgeFile(
  pmsFamily: string,
  recipe: Recipe,
  status: 'draft' | 'quarantined' = 'draft',
  feedGaps?: FeedGaps,
  gateNote?: string,
  verification?: RecipeVerification,
): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  // (pms_family, version) is UNIQUE. Under concurrency two jobs for the same
  // family read the same max(version) and both try to insert max+1; the loser
  // gets a 23505 and — without a retry — the mapped recipe (worth $2–25 of
  // model spend) is thrown away. So the whole "read max → build envelope →
  // sign → insert" sequence runs in a bounded retry loop: on a version
  // collision we re-read the max and try again. Bounded (≤3) so a genuinely
  // stuck constraint can't spin forever.
  //
  // The envelope is rebuilt EACH attempt on purpose: its `description` stamps
  // nextVersion, so a retry at a higher version must re-derive AND re-sign the
  // envelope — otherwise signed≠stored and the row would fail load-time verify.
  const MAX_INSERT_ATTEMPTS = 3;
  let lastCollision = '';
  for (let attempt = 1; attempt <= MAX_INSERT_ATTEMPTS; attempt++) {
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
      // feature/cua-bestclass-verify — persist the verification telemetry +
      // pass^N counter inside the SAME signed envelope (only when computed: a
      // fresh learn). Absent on seeded/edit jobs and on legacy rows, keeping
      // their exact prior signed shape — so old signed rows still verify+load.
      ...(verification ? { verification } : {}),
    };

    // canonicalJson-stability: sign AND store the JSON-normalized envelope
    // (JSON.parse(JSON.stringify(...))) so the signed bytes equal exactly what
    // jsonb persists and returns. jsonb silently drops any present-but-
    // `undefined` nested field; signing the raw in-memory object could then
    // digest a key the stored/read-back row lacks → a permanent verify
    // 'mismatch' (a recipe-less family under enforce). No current builder
    // emits such a field, but normalizing here makes signed===stored
    // regression-proof against a future one. For undefined-free data this is a
    // structural no-op, so existing signatures stay valid.
    const stored = JSON.parse(JSON.stringify(knowledge)) as typeof knowledge;

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
        // Sign the EXACT object we persist below (`stored`, JSON-normalized).
        const sig = signRecipe(stored as unknown as Recipe);
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
        // Not a version collision — never retry; return immediately.
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
        knowledge: stored,        // the exact object we signed (JSON-normalized)
        created_by: 'mapper:mapping-driver',
        notes: `Mapped at ${new Date().toISOString()}. Targets: ${Object.keys(recipe.actions).join(', ')}.` +
          (gateNote ? ` Gate: ${gateNote}` : ''),
        // Store the HMAC as a PostgREST bytea HEX LITERAL ('\xDEADBEEF…').
        // Passing the raw Buffer made supabase-js JSON-serialize it as
        // {"type":"Buffer","data":[…]} and persist THAT TEXT into the bytea
        // column — so every stored signature was ~138 bytes of JSON garbage and
        // verifyRecipe (a 32-byte HMAC) could never match → enforce-mode refused
        // to load the active recipe. decodeBytea() reads the '\x' hex back.
        signature: signatureBytes ? '\\x' + signatureBytes.toString('hex') : null,
        signed_with_key_id: signedWithKeyId,
        signed_at: signedAt,
      })
      .select('id')
      .single();
    if (!insErr && inserted) return { ok: true, id: inserted.id as string, version: nextVersion };

    // A 23505 here can ONLY be the (pms_family, version) unique constraint:
    // this insert is status 'draft'/'quarantined', never 'active', so the
    // partial one_active_per_family index can't fire. Treat it as a lost
    // version race and retry with a freshly-read max. Any other error (or the
    // final attempt) is terminal.
    if (insErr?.code === '23505' && attempt < MAX_INSERT_ATTEMPTS) {
      lastCollision = insErr.message;
      log.warn('saveDraftKnowledgeFile: version collision — retrying with a fresh max(version)', {
        pmsFamily, attemptedVersion: nextVersion, attempt, maxAttempts: MAX_INSERT_ATTEMPTS,
      });
      continue;
    }
    return { ok: false, error: `insert failed: ${insErr?.message ?? 'unknown'}` };
  }

  // Exhausted the retry budget on repeated version collisions.
  return {
    ok: false,
    error: `insert failed after ${MAX_INSERT_ATTEMPTS} version-collision retries: ${lastCollision || 'unknown'}`,
  };
}

function computeStats(result: MapperResult & { ok: true }): {
  targetsFound: number;
  /**
   * Left UNKNOWN (omitted, not 0) on purpose. The real unavailable/failed
   * counts live in mapper.ts's run log and aren't threaded through
   * MapperResult yet (follow-up owned by the mapper chat). Previously this
   * hardcoded 0, which the stored workflow result then surfaced as a
   * confident "0 failed" even when targets were dropped — a false negative.
   * Omitting the keys lets the admin board render "unknown" instead. Optional
   * here so the value flows cleanly into MappingJobResult's `number?` fields.
   */
  targetsUnavailable?: number;
  targetsFailed?: number;
} {
  // Recipe.actions has entries for SUCCESSFULLY mapped targets only.
  const found = Object.keys(result.recipe.actions).length;
  // Do NOT fabricate unavailable/failed counts — report only what we can
  // honestly know (targetsFound). See the return-type doc above.
  return { targetsFound: found };
}
