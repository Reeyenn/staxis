/**
 * PMS mapper — vision-only.
 *
 * As of Plan v8 D.2 the legacy DOM tool (browser-tool.ts + browser-utils/)
 * has been deleted. The agent reasons over SCREENSHOTS from Anthropic's
 * official `computer_20251124` beta tool, clicks by pixel coordinate
 * (with Set-of-Mark numbered badges overlaid for grounding), and records
 * recipe steps as `click_at` / `type_text`.
 *
 * Cost expectation: ~$20-40 per full mapping run (login + ~13 targets) on
 * Opus 4.8 with adaptive thinking (per-job cap $40 via
 * CUA_FULL_LEARN_COST_CAP_MICROS). One-time per PMS family — all
 * downstream hotels on the same PMS reuse the recipe via deterministic
 * Playwright replay (recipe-runner.ts, no Claude in the loop).
 */

import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, getModeConfig, type MapperModelId } from './anthropic-client.js';
import { executeVisionAction, type VisionAction } from './browser-tool-vision.js';
import { requestHelp, checkHelpFlood, saveScreenshotToStorage, type HelpActionType } from './human-assist.js';
import { safeGoto } from './browser-utils/navigate.js';
import { log } from './log.js';
import { logClaudeUsage, getJobCostMicros } from './usage-log.js';
import { supabase } from './supabase.js';
import { env } from './env.js';
import { ActionLoopDetector, actionFingerprint, pageFingerprint } from './loop-detector.js';
import { judgeStepOutcome, captureScreenshotForCritic } from './critic.js';
import { captureHardenedScreenshot } from './screenshot-privacy.js';
import { clickTrustDeviceIfPresent } from './mfa-handler.js';
import { fetchLatestAuthCode } from './auth-code-helpers.js';
import { sendAdminSms } from './admin-sms.js';

// ── Cumulative-cost circuit-breaker (May 2026 audit pass-5) ───────────
// Each phase has its own token + wallclock budget (~$2.40 max per phase),
// but a 5-phase mapper run could compound to $12+ if every phase burns
// its budget. This cap aborts the whole job before that happens. $5
// covers ~5 successful mappings at typical spend (~$0.30-0.80 each);
// hitting it usually means the agent is stuck looping. Configurable via
// CUA_JOB_COST_CAP_MICROS env (in micro-dollars; default 5_000_000 = $5).
const JOB_COST_CAP_MICROS = env.CUA_JOB_COST_CAP_MICROS;
import type { PMSCredentials, PMSType, Recipe, RecipeStep, LoginSteps, ActionRecipe } from './types.js';
import { inferUrlTemplate, mapPlaceholdersToColumns } from './url-template.js';
import { requiredLearnedFor, missingRequiredColumns, MAX_COMPLETENESS_REASKS, TARGET_VALUE_CONTRACTS } from './target-contract.js';
import { inferDateFormat, sanitizeEnumMapping, mergeValueTranslation, pickDateFormat } from './value-learning.js';
import type { LearnedValueTranslations, LearnedDateFormat } from './types.js';
import {
  createPruneState,
  maybePruneHistory,
} from './history-pruning.js';

const MAX_AGENT_STEPS_LOGIN = 60;
// Higher cap for per-action mapping — action 4 (staff) is buried in
// admin menus on most PMSes and needs more exploration than login.
const MAX_AGENT_STEPS_PER_ACTION = 80;
const VIEWPORT = { width: 1280, height: 800 };

// Token + wallclock guards. Vision agent ships a 1280×800 screenshot
// (~1366 tokens) on most turns; the pruner (history-pruning.ts) keeps
// the most recent 3 images and elides older ones, pruning in batches
// every ~25 turns per Anthropic best-practices so older-content bytes
// stay byte-stable between prunes (prerequisite for prompt caching).
// Between prune events the working set may temporarily exceed the
// `keepLast` bound — accepted trade-off for cache stability.
const MAX_INPUT_TOKENS_PER_RUN = 800_000;
// Output cap matters most on the agent's FINAL turn, when it emits the
// parse-hint JSON. Verbose preambles ("I have all the info needed,
// now I'll construct the JSON…") + actual JSON can exceed 2048 tokens
// and we get a truncated response with no parseable JSON. 4096 gives
// plenty of headroom; per-turn tool_use blocks are tiny so we never
// approach this on intermediate turns. (Diagnosed 2026-05-09 from CA
// canary v6 — getArrivals failed with the agent mid-sentence right
// before the JSON.)
const MAX_OUTPUT_TOKENS_PER_TURN = 4096;
// Vision is 3-5× slower per target than the deleted DOM tool (image-token
// generation per screenshot, more turns to find an element visually).
// 15min/target is sized for the vision-mode step cap.
const PHASE_WALLCLOCK_BUDGET_MS = 15 * 60_000;
// Keep the last 3 screenshots in history. Vision conversations balloon
// with image tokens; truncating aggressively keeps each turn under the
// per-target cost cap. 3 is enough recent context to re-orient after
// each action, few enough that input-token cost stays bounded.
const HISTORY_KEEP_RECENT = 3;

// Adaptive-thinking headroom (2026-06-09 model upgrade). Opus 4.8 / Fable 5
// removed fixed `budget_tokens` (the API 400s on it) — `thinking: adaptive`
// lets the model decide per-turn how much to think, and those thinking
// tokens are drawn from max_tokens. This headroom keeps the VISIBLE-output
// ceiling at MAX_OUTPUT_TOKENS_PER_TURN (4096, sized for the final
// parse-hint JSON) even on a turn where the model thinks a lot. Thinking
// stays cheap on click-loop turns (the model thinks briefly or not at all);
// the per-job cost cap bounds the cumulative worst case.
const THINKING_HEADROOM_TOKENS = 8192;

/**
 * Plan v8 Phase B P0-2 — when the floor-met `{unavailable: true}` fires,
 * give a live admin a chance to unstick the agent before we mark the
 * target unavailable for the whole replay future.
 *
 * Returns one of:
 *   - { kind: 'continue', hintText }       → caller rewinds messages, pushes
 *                                            user-turn hint, re-enters loop
 *   - { kind: 'mark_unavailable', reason } → caller returns ActionMapFailure
 *   - { kind: 'takeover' }                 → caller enters takeover (Phase B chunk 2)
 *   - { kind: 'abort', reason }            → caller throws to fail the whole job
 *
 * Skips the help request entirely when: jobId is null, the help-flood
 * circuit-breaker is tripped, or no admin is online (handled inside
 * requestHelp). In all skip cases, returns { kind: 'mark_unavailable' }
 * so behavior matches today's "no help available, mark unavailable" path.
 */
async function maybeAskAdminBeforeUnavailable(args: {
  page: Page;
  jobId: string | null;
  targetKey: string;
  agentReason: string;
  signal?: AbortSignal;
}): Promise<
  | { kind: 'continue'; hintText: string }
  | { kind: 'mark_unavailable'; reason: string }
  | { kind: 'takeover' }
  | { kind: 'abort'; reason: string }
> {
  if (!args.jobId) {
    return { kind: 'mark_unavailable', reason: args.agentReason };
  }
  // P2-4 — circuit-breaker. After 3 unsuccessful requests, don't even ask.
  if (await checkHelpFlood(args.jobId)) {
    log.warn('mapper: help-flood circuit-breaker tripped — auto-abort', {
      jobId: args.jobId, targetKey: args.targetKey,
    });
    return { kind: 'abort', reason: 'help_request_flood' };
  }

  // Take a screenshot for the help card. Privacy-hardened (same gate as the
  // agent's own screenshots): captureHardenedScreenshot masks credential/SSN/CC
  // fields in every frame and only returns a buffer once that coverage is
  // verified. A null result means redaction couldn't be guaranteed (e.g. the
  // page was mid-navigation) — we must NOT upload an unredacted snapshot, so
  // fall through to mark_unavailable. This is what makes the help-request DB
  // row + admin UI genuinely free of credential PII.
  let screenshotPath: string;
  const helpBuf = await captureHardenedScreenshot(args.page);
  if (!helpBuf) {
    log.warn('mapper: help-request screenshot withheld (could not guarantee redaction) — falling through', {
      jobId: args.jobId, targetKey: args.targetKey,
    });
    return { kind: 'mark_unavailable', reason: args.agentReason };
  }
  try {
    screenshotPath = await saveScreenshotToStorage(args.jobId, args.targetKey, helpBuf);
  } catch (err) {
    log.warn('mapper: help-request screenshot upload failed — falling through', {
      err: (err as Error).message, jobId: args.jobId, targetKey: args.targetKey,
    });
    return { kind: 'mark_unavailable', reason: args.agentReason };
  }

  const scroll = await args.page
    .evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    .catch(() => ({ x: 0, y: 0 }));

  const help = await requestHelp({
    jobId: args.jobId,
    targetKey: args.targetKey,
    question: `Stuck on ${args.targetKey}: ${args.agentReason.slice(0, 200)}`,
    screenshotStoragePath: screenshotPath,
    scroll,
    viewport: { w: 1280, h: 800 },
    signal: args.signal ?? new AbortController().signal,
  });

  switch (help.actionType as HelpActionType) {
    case 'guidance':
      return {
        kind: 'continue',
        hintText: help.responseText ?? '(admin provided guidance but no text)',
      };
    case 'unavailable':
      return {
        kind: 'mark_unavailable',
        reason: `unavailable: ${help.responseText ?? 'admin marked'}`,
      };
    case 'takeover':
      // Phase B chunk 2 implements the takeover loop. For chunk 1, treat
      // takeover as "admin will handle it" → mark unavailable so the run
      // doesn't hang. The takeover handler in chunk 2 replaces this branch.
      log.warn('mapper: takeover requested — chunk 1 stub, marking unavailable', {
        jobId: args.jobId, targetKey: args.targetKey,
      });
      return { kind: 'mark_unavailable', reason: 'takeover requested (handler not yet implemented)' };
    case 'abort':
      return { kind: 'abort', reason: 'admin_aborted' };
  }
}

// READ_PAGE_TRUNCATE_CHARS moved to history-pruning.ts (the only call
// site after the extraction).

// ─── Plan v7 Phase 2a: per-target cost budgets ─────────────────────────────
// Per-target caps prevent one runaway target from blowing the global $10
// job cap before priority targets even run. Classification:
//   list_page         — obvious top-nav page, simple table
//   report_menu       — buried under Reports submenu, 2-3 clicks deep
//   drilldown_sample  — needs to drill into N=3 sample records to learn
//                       the per-record detail page selectors
const TARGET_BUDGET_MICROS: Record<string, number> = {
  list_page:        500_000,    // $0.50
  report_menu:    1_000_000,    // $1.00
  drilldown_sample: 1_200_000,  // $1.20 (drills 3 records)
};
const TARGET_STEP_CAPS: Record<string, number> = {
  list_page:        80,
  report_menu:      100,
  drilldown_sample: 60,         // per-record; multiply by sample count
};

/**
 * The full target catalogue for Plan v7's mapper. Ordered by priority —
 * if the global job cap trips partway through, the partial recipe still
 * contains the most valuable tables (room status, arrivals, etc.).
 *
 * `optional: true` means a clean `{unavailable: true}` from the agent is
 * a legitimate outcome (e.g. revenue/forecast on a franchise-tier PMS
 * that doesn't expose financials). Required targets that fail block
 * auto-promotion (see plan v7 promotion criteria).
 */
interface MapperTarget {
  /** Recipe.actions key — also the actionName passed to mapAction. */
  key: keyof Recipe['actions'];
  goal: string;
  requiredFields: string[];
  classification: 'list_page' | 'report_menu' | 'drilldown_sample';
  optional: boolean;
  progressLabel: string;
  progressPct: number;
}

// Defined after the GOAL strings below.
let TARGETS: MapperTarget[];

interface MapperOptions {
  pmsType: PMSType;
  credentials: PMSCredentials;
  onProgress?: (step: string, pct: number) => void;
  // For Claude API spend attribution. Both nullable so dev/test runs work.
  propertyId?: string | null;
  jobId?: string | null;
  /**
   * Plan v8 review P0-A — per-job cost cap override. When set, replaces
   * env.CUA_JOB_COST_CAP_MICROS for cap-check inside isJobOverBudget +
   * checkBudget. Vision canary jobs set this to $50; flip to $25 once
   * paper-cost is measured across PMS families.
   */
  jobCostCapMicros?: number;
  /**
   * Optional abort signal — passed to every anthropic.beta.messages.create()
   * call so the runJob timeout can actually cancel in-flight Claude requests
   * instead of letting them run to completion past the deadline. Added
   * 2026-05-12 after Codex audit flagged that timeouts only marked the DB
   * failed without interrupting the runaway work.
   */
  signal?: AbortSignal;
  /**
   * Claude model. Sonnet 4.6 is the default; admin can opt into Opus 4.7
   * per-job for hard PMSes via workflow_jobs.payload.model.
   */
  model?: MapperModelId;
  /**
   * Plan v8 self-repair — when the live polling finds a broken selector
   * for one feed, fire a tiny vision-Claude re-learn for JUST that
   * target instead of re-running the whole 13-target pass.
   *
   * When set, mapPMS pre-populates the actions accumulator with these,
   * so the per-target loop skips them (already known). Only targets NOT
   * present here actually get mapped. Cost: ~$2 vs ~$25 full re-learn.
   *
   * Typical flow: session-driver detects feed X dying → enqueues a repair
   * workflow_jobs row with payload.seed_actions = currentRecipe.actions
   * minus the failing X. mapping-driver passes through to here. mapPMS
   * runs ONLY target X, merges with seedActions, saves as new version.
   */
  seedActions?: Recipe['actions'];
  /**
   * feat/pms-universal-translate — on a partial self-repair, the SKIPPED targets
   * (seedActions) aren't re-learned, so their value translation would be lost
   * from the new recipe. These carry the prior recipe's learned translation
   * forward: the accumulators start from them and the re-learned target merges
   * on top. Empty for a fresh full mapping.
   */
  seedValueTranslations?: LearnedValueTranslations;
  seedDateFormat?: LearnedDateFormat;
}

/**
 * Pre-call budget check. Each `mapAction()` step loop can fire 60-80
 * Anthropic calls before mapPMS's between-phase guard runs again — a
 * stuck phase could blow past CUA_JOB_COST_CAP_MICROS by several dollars.
 * Codex audit 2026-05-12. Cheap (~50ms Supabase query) vs. each Anthropic
 * call (~3-30s + cost), so it's worth running before every turn.
 */
/**
 * Plan v8 final review B6 — reclaim-safe progress persistence.
 *
 * Loads any actions persisted by a prior attempt of THIS workflow job.
 * Returns {} for fresh jobs or any read failure (degrades gracefully —
 * worst case the mapper runs from scratch, same as before B6).
 */
async function loadPriorActions(jobId: string | null | undefined): Promise<Recipe['actions']> {
  if (!jobId) return {};
  const { data, error } = await supabase
    .from('workflow_jobs')
    .select('result')
    .eq('id', jobId)
    .maybeSingle();
  if (error || !data) return {};
  const result = data.result as { actionsSoFar?: Recipe['actions'] } | null;
  return result?.actionsSoFar ?? {};
}

/**
 * Persist the current actions accumulator into workflow_jobs.result so
 * a reclaim after crash can resume from here. Atomic single-row UPDATE.
 * Uses a top-level `actionsSoFar` key so we don't clobber any other
 * result fields a handler might add.
 */
async function persistTargetProgress(
  jobId: string | null | undefined,
  actions: Recipe['actions'],
): Promise<void> {
  if (!jobId) return;
  // Merge with existing result via the workflow_jobs.result jsonb. We do
  // an UPDATE with a select-then-merge pattern (PostgREST jsonb_set RPC
  // isn't worth the indirection for a 13-key object updated 13 times
  // per job — once per target).
  const { data: row, error: selErr } = await supabase
    .from('workflow_jobs')
    .select('result')
    .eq('id', jobId)
    .maybeSingle();
  if (selErr || !row) return;
  const existingResult = (row.result as Record<string, unknown>) ?? {};
  const newResult = { ...existingResult, actionsSoFar: actions };
  await supabase.from('workflow_jobs').update({ result: newResult }).eq('id', jobId);
}

/**
 * Flag (or clear) "this learning run is parked on a 2FA screen waiting
 * for a code" on the job row. The admin Launch Bay panel polls
 * /api/admin/onboarding-detail every 5s and renders a code-entry box
 * while this flag is set, so Reeyen can type in a code that the PMS
 * texted to his phone. Same select-then-merge pattern as
 * persistTargetProgress — never clobbers actionsSoFar.
 */
async function setAwaitingMfa(
  jobId: string | null | undefined,
  awaiting: boolean,
): Promise<void> {
  if (!jobId) return;
  const { data: row, error: selErr } = await supabase
    .from('workflow_jobs')
    .select('result')
    .eq('id', jobId)
    .maybeSingle();
  if (selErr || !row) return;
  const existingResult = (row.result as Record<string, unknown>) ?? {};
  const newResult = {
    ...existingResult,
    awaiting_2fa: awaiting ? { since: new Date().toISOString() } : null,
  };
  await supabase.from('workflow_jobs').update({ result: newResult }).eq('id', jobId);
}

/**
 * Acquire a one-time 2FA code for the login the mapper is stuck on.
 *
 * Sequence: tick any "trust this device" checkbox (so the saved session
 * skips MFA for the next 30-90 days), flag the job awaiting_2fa for the
 * Launch Bay code box, nudge the admin by SMS (best-effort), then poll
 * pms_auth_codes for up to CUA_MFA_CODE_WAIT_MS. Codes arrive two ways:
 * Okta-style EMAILED codes land automatically via the getstaxis.com
 * inbox pipeline (seconds); codes TEXTED to the admin's phone arrive
 * when he types them into the hotel's Launch Bay panel.
 *
 * Returns the code, or null on timeout. Always clears the awaiting flag.
 */
async function acquireMfaCode(
  page: Page,
  ctx: { propertyId: string; jobId: string | null },
): Promise<string | null> {
  await clickTrustDeviceIfPresent(page).catch(() => ({ clicked: false, selector: null }));
  await setAwaitingMfa(ctx.jobId, true);

  // Fire-and-forget nudge — the PMS's own code text already pings the
  // admin's phone; this just tells him WHERE to type it.
  void (async () => {
    let hotelName = 'A hotel';
    try {
      const { data } = await supabase
        .from('properties')
        .select('name')
        .eq('id', ctx.propertyId)
        .maybeSingle();
      if (data?.name) hotelName = data.name;
    } catch { /* best-effort */ }
    await sendAdminSms(
      `Staxis: ${hotelName} hit a 2FA screen while the robot was learning its PMS. ` +
      `If a code was texted to you, open Admin → Onboarding, click the hotel, and type it in. ` +
      `Emailed codes are read automatically — no action needed.`,
    );
  })();

  try {
    // notBefore 2 min back: the PMS sends the code AFTER the login attempt
    // that landed us here, so anything older is a stale/foreign code. The
    // 15-min maxAge covers slow human round-trips within the wait window.
    const code = await fetchLatestAuthCode(ctx.propertyId, {
      maxAgeSeconds: 900,
      timeoutMs: env.CUA_MFA_CODE_WAIT_MS,
      pollMs: 3_000,
      notBefore: new Date(Date.now() - 120_000).toISOString(),
    });
    return code;
  } finally {
    await setAwaitingMfa(ctx.jobId, false).catch(() => {});
  }
}

/**
 * Persist the mapper browser's cookies/localStorage to scraper_session
 * after a successful login, so the per-hotel session-driver boots with
 * the SAME trusted-device state and (usually) skips MFA entirely on its
 * first poll login. Same row shape as SessionDriver.saveStorageState.
 */
async function saveTrustedSession(propertyId: string | null, page: Page): Promise<void> {
  if (!propertyId) return;
  try {
    const state = await page.context().storageState();
    const { error } = await supabase
      .from('scraper_session')
      .upsert(
        {
          property_id: propertyId,
          state: state as unknown as Record<string, unknown>,
          refreshed_at: new Date().toISOString(),
        },
        { onConflict: 'property_id' },
      );
    if (error) {
      log.warn('mapper: saveTrustedSession upsert failed (non-fatal)', {
        propertyId, err: error.message,
      });
    } else {
      log.info('mapper: trusted session saved for session-driver handoff', { propertyId });
    }
  } catch (err) {
    log.warn('mapper: saveTrustedSession failed (non-fatal)', {
      propertyId, err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function isJobOverBudget(
  jobId: string | null,
  /** Plan v8 review P0-A — per-job cap override (falls back to env default). */
  capMicrosOverride?: number,
): Promise<{ over: false } | { over: true; spentMicros: number; capMicros: number }> {
  if (!jobId) return { over: false };
  const capMicros = capMicrosOverride ?? JOB_COST_CAP_MICROS;
  const spentMicros = await getJobCostMicros(jobId);
  if (spentMicros >= capMicros) {
    return { over: true, spentMicros, capMicros };
  }
  return { over: false };
}

export type MapperResult =
  | { ok: true; recipe: Recipe }
  | { ok: false; userMessage: string; detail: Record<string, unknown> };

export async function mapPMS(opts: MapperOptions): Promise<MapperResult> {
  let browser: Browser | null = null;

  try {
    opts.onProgress?.('Opening browser…', 18);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    const model = opts.model;

    // ─── Phase 1: learn the login flow ─────────────────────────────────────
    opts.onProgress?.('Logging in for the first time…', 25);
    const loginResult = await mapLogin(page, opts.credentials, {
      propertyId: opts.propertyId ?? null,
      jobId: opts.jobId ?? null,
      signal: opts.signal,
      model,
      jobCostCapMicros: opts.jobCostCapMicros,
    });
    if (!loginResult.ok) {
      return { ok: false, userMessage: loginResult.userMessage, detail: loginResult.detail };
    }

    const postLoginUrl = page.url();
    log.info('login mapped', { postLoginUrl, steps: loginResult.steps.steps.length });

    // Hand the trusted-device cookies to the per-hotel session-driver so
    // its first poll login (usually) skips MFA entirely. Non-fatal.
    await saveTrustedSession(opts.propertyId ?? null, page);

    // Cumulative-cost guard — see JOB_COST_CAP_MICROS comment for rationale.
    // checkBudget queries claude_usage_log for spend so far on this job;
    // returns null when under budget, an over-budget failure result when over.
    // Skipped when jobId is null (one-off dev runs).
    // Plan v8 review P0-A — uses opts.jobCostCapMicros if set (vision $50
    // canary cap), else env default ($5). Without this fix, vision runs hit
    // the DOM $5 cap and die mid-map.
    const effectiveCapMicros = opts.jobCostCapMicros ?? JOB_COST_CAP_MICROS;
    const checkBudget = async (): Promise<MapperResult | null> => {
      if (!opts.jobId) return null;
      const spentMicros = await getJobCostMicros(opts.jobId);
      if (spentMicros >= effectiveCapMicros) {
        log.warn('cua mapper aborting — cumulative cost cap hit', {
          jobId: opts.jobId,
          spentMicros,
          capMicros: effectiveCapMicros,
        });
        return {
          ok: false,
          userMessage:
            'This mapping run is taking longer than expected. We stopped it to keep costs in check — ' +
            'please try again or contact support.',
          detail: {
            phase: 'mapper',
            reason: 'cost_cap_exceeded',
            spent_micros: spentMicros,
            cap_micros: effectiveCapMicros,
          },
        };
      }
      return null;
    };

    // ─── Phase 2 (Plan v7): per-target mapping loop ───────────────────────
    // Replaced the 4 hardcoded mapAction() calls with a loop over TARGETS.
    // Each entry declares its own goal + required-field list + classification
    // (drives per-target cost budget) + execution priority + optionality.
    //
    // Targets are ordered by business value — if the global cost cap trips
    // partway through, the partial recipe still contains the most valuable
    // tables (room status, arrivals, departures, in-house counts).
    //
    // Optional targets that report `unavailable: true` cleanly are NOT
    // counted as failures — they're a legitimate "this PMS tier doesn't
    // expose this" outcome (e.g. Choice Advantage franchise has no revenue
    // report). See plan v7's "auto-promotion criteria" for how downstream
    // consumes this.

    // Plan v8 final review B6 — per-target progress persistence.
    // Without this, a Fly machine crash mid-job + reclaim = full $25
    // vision pass re-run from scratch. By writing partial progress to
    // workflow_jobs.result after EACH target completes, a reclaim picks
    // up where the prior attempt left off (skips already-completed
    // targets). Combined with max_attempts=1 (B1 fix) this means
    // reclaim cost ≈ remaining-targets × per-target-cost, not full job
    // cost.
    //
    // Plan v8 self-repair (middle ground) — opts.seedActions pre-populates
    // the accumulator with the existing active recipe's actions, so the
    // loop skips them and only re-learns the failing one. Same skip
    // mechanism that B6 uses; just sourced from the job payload instead
    // of from prior partial progress.
    const priorActions = await loadPriorActions(opts.jobId);
    const seedActions = opts.seedActions ?? {};
    const actions: Recipe['actions'] = { ...seedActions, ...priorActions };
    if (Object.keys(seedActions).length > 0) {
      log.info('mapper: repair mode — seeded with existing actions', {
        jobId: opts.jobId ?? undefined,
        seededTargets: Object.keys(seedActions),
      });
    }
    if (Object.keys(priorActions).length > 0) {
      log.info('mapper: resuming from prior progress', {
        jobId: opts.jobId ?? undefined,
        priorTargets: Object.keys(priorActions),
      });
    }

    // feat/pms-universal-translate — accumulate self-learned VALUE translation
    // across targets: enum vocabularies keyed by `${table}.${column}`, and a
    // pool of raw date samples (one PMS = one date format, so pooling across
    // every date column maximizes the chance of seeing a disambiguating >12
    // token and learning the order with high confidence). On a partial repair,
    // SEED from the prior recipe so the skipped targets' translation survives.
    const learnedValueTranslations: LearnedValueTranslations = { ...(opts.seedValueTranslations ?? {}) };
    const learnedDateSamples: string[] = [];

    for (const target of TARGETS) {
      // Skip targets already mapped in a prior attempt (B6 reclaim path).
      if (actions[target.key]) {
        log.info('mapper: skipping target — already completed in prior attempt', {
          jobId: opts.jobId ?? undefined, actionName: target.key,
        });
        continue;
      }
      opts.onProgress?.(target.progressLabel, target.progressPct);
      const overBudget = await checkBudget();
      if (overBudget) {
        log.warn('mapper: global cost cap hit — stopping target loop', {
          completedTargets: Object.keys(actions),
          remainingTargets: TARGETS.slice(TARGETS.indexOf(target)).map((t) => t.key),
        });
        // Don't return overBudget here — emit a partial recipe with what
        // we've got. The auto-promotion gates downstream decide whether
        // it's enough to promote.
        break;
      }
      // Plan v7 — dispatch on target classification. Drill-down targets
      // use mapDrillDownAction (different agent loop, different output
      // shape — captures URL templates + per-field coverage). List/report
      // targets use the original mapAction.
      const result = target.classification === 'drilldown_sample'
        ? await mapDrillDownAction({
            page,
            actionName: target.key,
            goal: target.goal,
            requiredFields: target.requiredFields,
            postLoginUrl,
            credentials: opts.credentials,
            propertyId: opts.propertyId ?? null,
            jobId: opts.jobId ?? null,
            signal: opts.signal,
            model,
            jobCostCapMicros: opts.jobCostCapMicros,
          })
        : await mapAction({
            page,
            actionName: target.key,
            goal: target.goal,
            requiredFields: target.requiredFields,
            classification: target.classification,
            postLoginUrl,
            credentials: opts.credentials,
            propertyId: opts.propertyId ?? null,
            jobId: opts.jobId ?? null,
            signal: opts.signal,
            model,
            jobCostCapMicros: opts.jobCostCapMicros,
          });
      if (result.ok) {
        actions[target.key] = result.action;
        // feat/pms-universal-translate — fold this target's observed values
        // into the running learned-translation accumulators (sanitized against
        // the descriptor's canonical sets).
        accumulateLearnedValues(target.key, result, learnedValueTranslations, learnedDateSamples);
        // Plan v8 B6 — persist after each successful target so a crash
        // doesn't lose the work. Best-effort: on persist failure, keep
        // running (the next target will retry the persist with both).
        await persistTargetProgress(opts.jobId, actions).catch((err) => {
          log.warn('mapper: persistTargetProgress failed (non-fatal)', {
            jobId: opts.jobId ?? undefined, actionName: target.key, err: (err as Error).message,
          });
        });
      } else {
        // Failure on an OPTIONAL target = informational. Failure on a
        // REQUIRED target = logged louder and may block promotion.
        const level = target.optional ? 'info' : 'warn';
        log[level]('action mapping failed', {
          actionName: target.key,
          optional: target.optional,
          reason: result.reason,
          finalUrl: result.finalUrl,
        });
      }
    }

    if (Object.keys(actions).length === 0) {
      return {
        ok: false,
        userMessage:
          'We could log in but could not find any of the data pages. This usually means ' +
          'the PMS UI changed or your account is missing permissions.',
        detail: { phase: 'mapping_actions', mapped: [] },
      };
    }

    // feat/pms-universal-translate — finalize the learned date order from the
    // pooled samples (null/low-confidence when ambiguous → runtime heuristic).
    // Confidence-aware merge with any prior-recipe seed (partial repair): a
    // low-confidence repair inference must never downgrade a high-confidence
    // seed (Codex re-review #5).
    const learnedDateFormat = pickDateFormat(inferDateFormat(learnedDateSamples), opts.seedDateFormat);
    if (learnedDateFormat) {
      log.info('mapper: learned date format', {
        jobId: opts.jobId ?? undefined,
        order: learnedDateFormat.order,
        confidence: learnedDateFormat.confidence,
        sampleCount: learnedDateSamples.length,
      });
    }
    const learnedEnumCount = Object.keys(learnedValueTranslations).length;
    if (learnedEnumCount > 0) {
      log.info('mapper: learned enum vocabularies', {
        jobId: opts.jobId ?? undefined,
        columns: Object.keys(learnedValueTranslations),
      });
    }

    const recipe: Recipe = {
      schema: 1,
      description: `Auto-mapped recipe for ${opts.pmsType} (browser-tool mapper). Actions: ${Object.keys(actions).join(', ')}.`,
      login: loginResult.steps,
      actions,
      // ALWAYS emit valueTranslations (even {}) so this new-style recipe is
      // distinguishable at runtime from the legacy CA seed (whose field is
      // undefined): resolveColumnParser only uses the ca_* enum fallback when
      // the field is absent, so a brand-new PMS never falls back to CA parsers.
      valueTranslations: learnedValueTranslations,
      ...(learnedDateFormat ? { dateFormat: learnedDateFormat } : {}),
    };

    opts.onProgress?.('Recipe saved — running first extraction…', 65);
    return { ok: true, recipe };
  } catch (err) {
    const e = err as Error;
    log.error('mapper crashed', { err: e.message, stack: e.stack });
    return {
      ok: false,
      userMessage: 'Something unexpected went wrong while exploring your PMS. Please try again.',
      detail: { phase: 'mapper', message: e.message },
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Login mapping ───────────────────────────────────────────────────────

interface LoginMapResult {
  ok: true;
  steps: LoginSteps;
}
interface LoginMapFailure {
  ok: false;
  userMessage: string;
  detail: Record<string, unknown>;
}

async function mapLogin(
  page: Page,
  creds: PMSCredentials,
  ctx: {
    propertyId: string | null;
    jobId: string | null;
    signal?: AbortSignal;
    model?: MapperModelId;
    /** Plan v8 review P0-A — per-job cap override. */
    jobCostCapMicros?: number;
  },
): Promise<LoginMapResult | LoginMapFailure> {
  // Resolve tool + system prompt + beta header + model (vision-only now).
  const cfg = getModeConfig(ctx.model);
  // The login URL itself is the trust anchor — no allowedHost yet (we'll
  // pin to creds.loginUrl's host for every subsequent goto). safeGoto
  // still rejects javascript:/file:/private-IP URLs, so a misconfigured
  // creds row can't establish a malicious session.
  await safeGoto(page, creds.loginUrl, {
    allowedHost: null,
    context: 'mapper:login:startUrl',
  });
  await page.waitForTimeout(1500);

  const recordedSteps: RecipeStep[] = [{ kind: 'goto', url: creds.loginUrl }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Codex audit pass-6 P1 — pass placeholder strings, not the real
  // credentials. The browser tool substitutes them with the actual
  // values at form_input / type execution time, so the username and
  // password never enter the Claude conversation (and so don't end up
  // in Anthropic API logs, message history files, or any future model-
  // training capture).
  const credentialIntro =
    `Log into this hotel PMS. The username and password are NOT shown ` +
    `to you for security; pass these literal placeholder strings as the ` +
    `value when typing into the credential fields, and the tool will ` +
    `substitute the real credentials before sending them to the page:\n` +
    `  username placeholder: "$username"\n` +
    `  password placeholder: "$password"\n\n`;

  const successCriteria =
    `WHEN YOU'RE LOGGED IN (you see a dashboard with hotel-specific data: ` +
    `room counts, today's date, guest names, navigation menu with ` +
    `reports/front-desk/etc.), reply with JSON ONLY (no commentary):\n` +
    `  {"loggedIn": true, "dashboardSelector": "<a CSS selector that's only ` +
    `present after login, like '.dashboard' or '#mainNav' or 'a[href*=\\"reports\\"]'>"}\n` +
    `Then stop.\n\n` +

    `IF login fails permanently (wrong creds, account locked, PMS down), ` +
    `reply with {"error": "<short reason>"} and stop.`;

  const goal = credentialIntro +
    `STEP-BY-STEP:\n` +
    `1. Take a SCREENSHOT to see the login form.\n` +
    `2. left_click on the username input field's coordinate.\n` +
    `3. Send {action: "type", text: "$username"}. The tool substitutes ` +
    `the real username before it hits the page.\n` +
    `4. left_click on the password field's coordinate.\n` +
    `5. Send {action: "type", text: "$password"}.\n` +
    `6. Click the submit / log-in button.\n` +
    `7. Wait for the next page (use {action: "wait", duration: 2} if slow), ` +
    `then take a fresh screenshot.\n` +
    `8. If you land on a property picker, click the FIRST property. If ` +
    `you land on a "Welcome" splash (Choice Advantage), click "Continue" ` +
    `or "Enter PMS" or the property name.\n` +
    `9. Repeat screenshot + click as needed to reach the dashboard.\n\n` +
    successCriteria;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: goal }] },
  ];
  // Batched-pruning state — one per agent loop. See PRUNE_BATCH_TURNS
  // and maybePruneHistory() for the cache-friendliness rationale.
  const pruneState = createPruneState();

  const phaseStartedAt = Date.now();

  // Login-phase action-loop detector — same guard mapAction uses. Without
  // it, a login that keeps re-clicking the same (often misaligned) field
  // burns the whole login step budget instead of aborting early. Trips on
  // the 4th identical (action, page) tuple within the last 8 turns.
  const loopDetector = new ActionLoopDetector();

  // ── 2FA resolution state (2026-06-09) ──
  // mfaCodePending: a fetched code is in the agent's hands, waiting for it
  //   to be typed + submitted. While set, $auth_code substitution is live
  //   and detection doesn't re-fire.
  // suppressRecording: MFA-screen actions (trust tick, code typing, verify
  //   click) are excluded from the recorded login playbook — replaying a
  //   one-time code is meaningless, and the saved trusted-device cookie
  //   (saveTrustedSession) makes future logins skip MFA instead.
  let mfaCodePending = false;
  let pendingAuthCode: string | null = null;
  let suppressRecording = false;
  let mfaResolutions = 0;

  for (let stepIdx = 0; stepIdx < MAX_AGENT_STEPS_LOGIN; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      log.warn('mapper exceeded input token budget', { totalInputTokens, totalOutputTokens, stepIdx });
      return {
        ok: false,
        userMessage: 'Mapping took longer than expected — please contact support.',
        detail: { phase: 'login_mapping', reason: 'token_budget_exceeded', totalInputTokens },
      };
    }
    if (Date.now() - phaseStartedAt > PHASE_WALLCLOCK_BUDGET_MS) {
      log.warn('mapper exceeded wall-clock budget', { stepIdx });
      return {
        ok: false,
        userMessage: 'Mapping took longer than expected — please contact support.',
        detail: { phase: 'login_mapping', reason: 'wallclock_budget_exceeded' },
      };
    }
    // Per-turn budget check — see isJobOverBudget() comment.
    {
      const budget = await isJobOverBudget(ctx.jobId, ctx.jobCostCapMicros);
      if (budget.over) {
        log.warn('login mapper aborting — cumulative cost cap hit', { jobId: ctx.jobId ?? undefined, ...budget });
        return {
          ok: false,
          userMessage:
            'This mapping run is taking longer than expected. We stopped it to keep costs in check — ' +
            'please try again or contact support.',
          detail: {
            phase: 'login_mapping',
            reason: 'cost_cap_exceeded',
            spent_micros: budget.spentMicros,
            cap_micros: budget.capMicros,
          },
        };
      }
    }

    // MFA / OTP handling (2026-06-09 — was a hard abort before). When the
    // PMS bounces us to a one-time-code screen: tick trust-device, flag the
    // job awaiting_2fa (the Launch Bay panel shows a code box + the admin
    // gets an SMS nudge), and wait for the code to land in pms_auth_codes —
    // emailed codes arrive automatically via the getstaxis.com inbox
    // pipeline; texted codes arrive when the admin types them in. The code
    // is handed to the agent as the "$auth_code" placeholder (substituted
    // at type time, so the digits never enter the Claude conversation).
    if (mfaCodePending) {
      // A code is in the agent's hands. Watch for the screen to change;
      // once we're off the MFA page, resume recording playbook steps.
      const stillOnMfa = await detectMfaScreen(page);
      if (!stillOnMfa) {
        mfaCodePending = false;
        pendingAuthCode = null;
        suppressRecording = false;
        log.info('login mapper: 2FA cleared — resuming step recording', {
          jobId: ctx.jobId ?? undefined, stepIdx,
        });
      }
    } else {
      const mfaDetected = await detectMfaScreen(page);
      if (mfaDetected) {
        mfaResolutions += 1;
        if (!ctx.propertyId || mfaResolutions > 2) {
          // No property to look codes up for (one-off dev run), or the PMS
          // re-prompted after two resolved codes — give up with the
          // distinct reason the admin UI knows.
          log.warn('login mapper aborting — MFA unresolvable', {
            jobId: ctx.jobId ?? undefined, stepIdx, mfaResolutions, hasProperty: Boolean(ctx.propertyId),
          });
          return {
            ok: false,
            userMessage:
              'Your PMS asked for a one-time verification code (multi-factor login) ' +
              'and we couldn\'t complete it automatically. Please contact support to finish connecting.',
            detail: { phase: 'login_mapping', reason: 'mfa_required', currentUrl: page.url() },
          };
        }
        log.info('login mapper: 2FA screen detected — waiting for a code', {
          jobId: ctx.jobId ?? undefined, stepIdx, attempt: mfaResolutions,
        });
        const code = await acquireMfaCode(page, { propertyId: ctx.propertyId, jobId: ctx.jobId });
        if (!code) {
          log.warn('login mapper aborting — no 2FA code arrived in time', {
            jobId: ctx.jobId ?? undefined, stepIdx, waitedMs: env.CUA_MFA_CODE_WAIT_MS,
          });
          return {
            ok: false,
            userMessage:
              'Your PMS asked for a one-time verification code and none arrived in time. ' +
              'If the code goes to your phone, open the hotel on the Onboarding page and type it ' +
              'into the 2FA box there, then start the learning run again.',
            detail: { phase: 'login_mapping', reason: 'mfa_code_timeout', currentUrl: page.url() },
          };
        }
        pendingAuthCode = code;
        mfaCodePending = true;
        suppressRecording = true;
        messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text:
              'A one-time verification code for this 2FA screen has been retrieved. ' +
              'Do this now: (1) if a "remember/trust this device" checkbox is visible and ' +
              'unchecked, click it; (2) click the code input field; (3) send ' +
              '{action: "type", text: "$auth_code"} — the tool substitutes the real digits; ' +
              '(4) click the verify/submit button; (5) take a screenshot and continue logging in.',
          }],
        });
        // Fall through to the model call — this instruction is the next
        // thing the agent sees.
      }
    }

    // Beta-API call so we can attach `cache_control` to the system block.
    // The system prompt + tool definitions are stable across the entire
    // mapping run; caching them means each turn after the first only pays
    // ~10% of their input-token cost. This was the dominant fix for the
    // 400K-token-budget exhaustion on CA's deep menus. (Pattern from
    // anthropic-quickstarts/browser-use-demo loop.py.)
    // Deterministic per-turn idempotency key (audit/concurrency #15). If
    // the SDK's built-in retry (maxRetries=1 in anthropic-client.ts) fires
    // after the first request already reached Anthropic, the same key
    // goes out — giving Anthropic the option to dedupe the second
    // billing. Harmless if unsupported.
    const idempotencyKey = ctx.jobId
      ? `${ctx.jobId}:login:${stepIdx}`
      : `anon:login:${stepIdx}:${Date.now()}`;

    // Loop-detector input — fingerprint the page state Claude is about to
    // reason on (same pattern as mapAction). Computed BEFORE messages.create
    // so it matches the screenshot the model acts on. Best-effort: errors
    // fall back to a URL-only fingerprint inside the helper.
    const turnPageFingerprint = await pageFingerprint(page);

    // Adaptive thinking (Opus 4.8 / Fable 5 surface — budget_tokens 400s
    // there). Thinking tokens consume from max_tokens — the headroom keeps
    // the VISIBLE-output cap at MAX_OUTPUT_TOKENS_PER_TURN (4096) so a
    // long final JSON can't truncate. Prompt caching is GA — cache_control
    // needs no beta header.
    const response = await anthropic.beta.messages.create({
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN + THINKING_HEADROOM_TOKENS,
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: cfg.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [cfg.tool as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      messages: maybePruneHistory(messages, pruneState, stepIdx, HISTORY_KEEP_RECENT) as Anthropic.Beta.Messages.BetaMessageParam[],
      betas: cfg.betas,
    }, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers: { 'idempotency-key': idempotencyKey },
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;

    // Spend attribution for the admin Money tab. Fire-and-forget;
    // logClaudeUsage swallows its own failures.
    void logClaudeUsage(response.usage ?? {}, {
      workload: 'cua_mapping_login',
      model: cfg.model,
      propertyId: ctx.propertyId,
      jobId: ctx.jobId,
      metadata: { stepIdx },
    });

    // Beta and non-beta content shapes are structurally identical at the
    // wire layer; only the SDK's TypeScript types differ. Cast to keep
    // the rest of the code working with the regular Messages types.
    const responseContent = response.content as unknown as Anthropic.Messages.ContentBlock[];
    messages.push({ role: 'assistant', content: responseContent });

    if (response.stop_reason === 'end_turn') {
      const finalText = extractFinalText(responseContent);
      const parsed = tryParseJson(finalText) as { loggedIn?: unknown; dashboardSelector?: unknown; error?: unknown } | null;
      if (parsed && parsed.loggedIn) {
        // Sanity check the URL we landed on. We've seen the agent declare
        // "loggedIn: true" while sitting on chrome-error://chromewebdata
        // after a navigation timed out; downstream actions then can't
        // navigate back to anywhere useful. Reject and let the agent
        // recover (or surface a real failure to the user).
        const currentUrl = page.url();
        const loginHost = (() => { try { return new URL(creds.loginUrl).host; } catch { return null; } })();
        const currentHost = (() => { try { return new URL(currentUrl).host; } catch { return null; } })();
        const onPmsDomain = loginHost && currentHost && currentHost.split('.').slice(-2).join('.') === loginHost.split('.').slice(-2).join('.');
        if (!onPmsDomain) {
          log.warn('login claimed success but URL is off-domain', { currentUrl, loginUrl: creds.loginUrl });
          return {
            ok: false,
            userMessage: 'Login appeared to fail — the page navigated unexpectedly. Please double-check your credentials and login URL.',
            detail: { phase: 'login_mapping', currentUrl, loginUrl: creds.loginUrl, reason: 'post_login_off_domain' },
          };
        }
        // The on-domain check alone is weak evidence of login: a redirect
        // back to the login page (or an interstitial) is still on-domain.
        // Require a NON-TRIVIAL dashboard selector — 'body'/'html' match
        // any page including the login form, so they're no evidence at all
        // (C3) — AND assert it's actually visible before accepting. On
        // failure, push a hint and let the agent keep working rather than
        // recording a worthless 'body' success selector into the recipe.
        const successSelector = typeof parsed.dashboardSelector === 'string' ? parsed.dashboardSelector : '';
        const trivialSelector = successSelector === '' || successSelector === 'body' || successSelector === 'html';
        let selectorVisible = false;
        if (!trivialSelector) {
          selectorVisible = await page
            .locator(successSelector)
            .first()
            .isVisible({ timeout: 3000 })
            .catch(() => false);
        }
        if (trivialSelector || !selectorVisible) {
          log.warn('login claimed success but dashboard selector is missing/trivial/not visible', {
            reason: 'dashboard_selector_not_found',
            currentUrl, dashboardSelector: successSelector || null, trivialSelector, selectorVisible,
          });
          messages.push({
            role: 'user',
            content: [{
              type: 'text',
              text:
                `That doesn't confirm you're logged in: ${trivialSelector
                  ? `"${successSelector || '(none)'}" is too generic — 'body'/'html' match the login page too.`
                  : `the selector "${successSelector}" is not visible on the current page.`} ` +
                `Take a fresh screenshot. If you ARE on a dashboard with hotel-specific data, reply with ` +
                `{"loggedIn": true, "dashboardSelector": "<a CSS selector that exists ONLY after login, e.g. '#mainNav' or 'a[href*=\\"reports\\"]'>"}. ` +
                `If you're NOT logged in yet, keep working.`,
            }],
          });
          continue;
        }
        return {
          ok: true,
          steps: {
            startUrl: creds.loginUrl,
            steps: recordedSteps,
            successSelectors: [successSelector],
            timeoutMs: 30_000,
          },
        };
      }
      // 2026-05-12 (Codex audit): scrub creds out of model text before
      // returning. If Claude ever echoes the username/password (or login
      // URL) back in an error message, the job-runner persists the
      // detail blob to onboarding_jobs.error_detail — which means PMS
      // creds would leak into the database. Replace tokens with
      // placeholders here so the persisted error stays diagnostic
      // without storing the secret.
      const redact = (s: string): string => {
        let out = s;
        if (creds.username) out = out.split(creds.username).join('<username>');
        if (creds.password) out = out.split(creds.password).join('<password>');
        if (creds.loginUrl) out = out.split(creds.loginUrl).join('<loginUrl>');
        return out;
      };
      return {
        ok: false,
        userMessage: 'Could not log in. Please double-check your username and password.',
        detail: { phase: 'login_mapping', finalText: redact(finalText), parsed },
      };
    }

    // Claude can emit MULTIPLE tool_use blocks in a single assistant
    // turn (parallel tool calls). The Anthropic API requires that EVERY
    // tool_use has a matching tool_result in the next user message —
    // missing one trips a 400. So iterate all tool_uses, execute each,
    // and bundle all tool_results into a single user message. (Bug fix
    // 2026-05-09 — first browser-tool deploy hit this within seconds.)
    const toolUses = responseContent.filter((c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use');
    if (toolUses.length === 0) break;

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const exec = await executeVisionAction(page, toolUse.input as VisionAction, creds, 'login', {
        authCode: pendingAuthCode,
      });
      if (exec.recordedStep && !suppressRecording) recordedSteps.push(exec.recordedStep);
      toolResults.push(makeToolResult(toolUse.id, exec));
    }

    // Loop-detector — record each toolUse's (action, page) tuple against the
    // pre-action page fingerprint and abort if the agent is stuck re-trying
    // the same thing on the same starting state (same pattern as mapAction).
    for (const toolUse of toolUses) {
      const stuck = loopDetector.record(actionFingerprint(toolUse.input), turnPageFingerprint);
      if (stuck.stuck) {
        log.warn('login mapper: action-loop detector tripped — aborting login', {
          jobId: ctx.jobId ?? undefined, stepIdx, reason: stuck.reason,
        });
        return {
          ok: false,
          userMessage: 'We got stuck on the login page. Please double-check your credentials and login URL, or contact support.',
          detail: { phase: 'login_mapping', reason: 'loop detector tripped', currentUrl: page.url() },
        };
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return {
    ok: false,
    userMessage: 'Took too long to figure out the login form. Please contact support.',
    detail: { phase: 'login_mapping', maxSteps: MAX_AGENT_STEPS_LOGIN },
  };
}

// ─── Per-action mapping ───────────────────────────────────────────────────

interface ActionMapSuccess {
  ok: true;
  action: ActionRecipe;
  /** feat/pms-universal-translate — raw value observations the model emitted
   *  on the same vision turn it found the table, used by mapPMS to learn this
   *  PMS's date order + enum vocabulary. Optional (drill-down + older callers
   *  omit them). `valueSamples`: a few distinct raw cell strings per column;
   *  `enumMappings`: model-proposed raw→canonical for the named enum columns. */
  valueSamples?: Record<string, string[]>;
  enumMappings?: Record<string, Record<string, string>>;
}
interface ActionMapFailure { ok: false; reason: string; finalUrl: string }

/** Coerce a model-emitted `valueSamples` blob → Record<field, string[]> (or
 *  undefined). Defensive: the model can return junk shapes / non-arrays. */
function coerceValueSamples(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const vals = v.map((x) => String(x)).filter((s) => s.trim() !== '');
    if (vals.length > 0) out[k] = vals.slice(0, 8);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Coerce a model-emitted `enumMappings` blob → Record<field, Record<raw,
 *  canonical>> (or undefined). Non-string targets dropped; sanitized against
 *  the real canonical set later in mapPMS. */
function coerceEnumMappings(raw: unknown): Record<string, Record<string, string>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [col, m] of Object.entries(raw as Record<string, unknown>)) {
    if (!m || typeof m !== 'object') continue;
    const inner: Record<string, string> = {};
    for (const [rawVal, canon] of Object.entries(m as Record<string, unknown>)) {
      if (typeof canon === 'string' && String(rawVal).trim() !== '') inner[rawVal] = canon;
    }
    if (Object.keys(inner).length > 0) out[col] = inner;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * feat/pms-universal-translate — fold one successfully-mapped target's observed
 * values into the run's learned-translation accumulators. Enum mappings are
 * sanitized against the column's REAL canonical set (drops hallucinations /
 * abstentions); date samples are pooled across every date column for format
 * inference. No-op for targets without a value contract.
 */
function accumulateLearnedValues(
  actionKey: keyof Recipe['actions'],
  result: ActionMapSuccess,
  valueTranslations: LearnedValueTranslations,
  dateSamples: string[],
): void {
  const contract = TARGET_VALUE_CONTRACTS[actionKey];
  if (!contract) return;

  if (result.enumMappings) {
    for (const col of contract.columns) {
      if (!col.enumValues || col.enumValues.length === 0) continue;
      const raw = result.enumMappings[col.name];
      if (!raw) continue;
      const clean = sanitizeEnumMapping(raw, col.enumValues);
      mergeValueTranslation(valueTranslations, `${contract.table}.${col.name}`, clean);
    }
  }

  if (result.valueSamples) {
    for (const col of contract.columns) {
      if (col.type !== 'date') continue;
      const s = result.valueSamples[col.name];
      if (Array.isArray(s)) dateSamples.push(...s);
    }
  }
}

async function mapAction(args: {
  page: Page;
  actionName: string;
  goal: string;
  requiredFields: string[];
  postLoginUrl: string;
  credentials: PMSCredentials;
  propertyId: string | null;
  jobId: string | null;
  signal?: AbortSignal;
  /** Plan v7 — drives per-target step/cost caps. Defaults to 'list_page'
   *  if absent (back-compat for any caller from before TARGETS landed). */
  classification?: 'list_page' | 'report_menu' | 'drilldown_sample';
  model?: MapperModelId;
  /** Plan v8 review P0-A — per-job cap override (vision uses higher cap). */
  jobCostCapMicros?: number;
}): Promise<ActionMapSuccess | ActionMapFailure> {
  const cfg = getModeConfig(args.model);
  // Plan v7: per-target step + cost caps. Drill-down targets get fewer
  // steps PER record but execute against multiple samples; report-menu
  // targets get more steps to drill through reports submenus.
  const classification = args.classification ?? 'list_page';
  const targetStepCap = TARGET_STEP_CAPS[classification] ?? MAX_AGENT_STEPS_PER_ACTION;
  const targetCostCapMicros = TARGET_BUDGET_MICROS[classification] ?? Number.POSITIVE_INFINITY;

  // Plan v7 — `unavailable: true` floor. Agent can short-circuit a target
  // with {unavailable: true}, but only AFTER demonstrating real effort:
  // at least 1 read_page on the dashboard + 3 navigation/search attempts.
  // Prevents lazy 1-shot "this PMS doesn't have it" calls that fool the
  // auto-promotion gates.
  const UNAVAILABLE_FLOOR = { readPages: 1, navigations: 3 };
  let readPageCount = 0;
  let navigationCount = 0;
  // Track whether the target's per-target cost cap has tripped (soft-abort).
  // Set true after a tool_use round trip pushes us over targetCostCapMicros.
  // The current call always completes; we just don't start another round.
  let targetOverBudget = false;
  if (args.page.url() !== args.postLoginUrl) {
    // Pin to the credentials' login-URL host so a stale post-login URL
    // from a different domain can't redirect the authenticated session
    // off-site. The .catch(() => {}) preserves the prior best-effort
    // semantic for transient nav failures, but safeGoto's pre-check
    // still rejects schemes / private IPs before any network call.
    const allowedHost = new URL(args.credentials.loginUrl).host;
    await safeGoto(args.page, args.postLoginUrl, {
      allowedHost,
      context: 'mapper:action:postLoginUrl',
    }).catch(() => {});
    await args.page.waitForTimeout(1000);
  }

  const recordedSteps: RecipeStep[] = [{ kind: 'goto', url: args.postLoginUrl }];
  let totalInputTokens = 0;

  // feat/pms-universal-translate — value-learning hints. On the SAME vision
  // turn it locates the table, ask the model to also report a few raw sample
  // values per column (to learn THIS PMS's date order) and — for the columns we
  // know are enums — a raw→canonical mapping against the exact canonical set.
  // Both are PMS-agnostic: derived from the descriptor contract, no hardcoded
  // vocabulary or menu paths. This is what lets a brand-new PMS's date format
  // and status words translate with zero new hand-written code.
  const valueContract = TARGET_VALUE_CONTRACTS[args.actionName as keyof Recipe['actions']];
  const enumCols = (valueContract?.columns ?? []).filter((c) => c.enumValues && c.enumValues.length > 0);
  const enumHint = enumCols.length > 0
    ? `\n\nVALUE VOCABULARY (critical): for EACH status/category column below, read the ` +
      `distinct values shown in the table and map EACH one to exactly one canonical value. ` +
      `OMIT any you are unsure about — do NOT guess. Add to the first-line JSON:\n` +
      `  "enumMappings":{<field>:{"<raw value EXACTLY as shown>":"<canonical>"}}\n` +
      enumCols.map((c) => `  - ${c.name}: one of [${c.enumValues!.join(', ')}]`).join('\n')
    : '';
  const sampleHint =
    `\n\nVALUE SAMPLES: also add "valueSamples":{<field>:["<up to 5 distinct raw cell ` +
    `values copied EXACTLY as shown, with their separators>"]} for the date and amount ` +
    `columns. This learns how THIS PMS writes dates (is "06/07" June 7 or July 6?) and ` +
    `money — copy the values verbatim, do NOT reformat them.`;

  const fullGoal =
    args.goal +
    `\n\nWORKFLOW (use the computer tool):\n` +
    `1. Take a SCREENSHOT to see the dashboard.\n` +
    `2. SCAN the screenshot for any menu item / link / tab whose visible ` +
    `text matches the target (e.g. for housekeeping look for "Housekeeping", ` +
    `"Rooms", "Status", "Maid"; for revenue look for "Reports", "Audit", ` +
    `"Revenue", "Daily Summary"). Partial matches are fine.\n` +
    `3. left_click the most-likely target's coordinate. Look at the screenshot ` +
    `carefully — small misalignments will miss the element.\n` +
    `4. Take another screenshot to see the new page.\n` +
    `5. If you're not on the target page yet, repeat: scan, click, screenshot. ` +
    `Most data lives 1-3 levels under Reports / Front Desk / Setup menus.\n` +
    `6. Once on the target page (you see a table with one row per record), ` +
    `take a final screenshot and identify the table visually. Make your best ` +
    `guess at CSS selectors — most PMSes use \`tr\` or \`tbody tr\` for rows ` +
    `and \`td\` or \`td:nth-child(N)\` for columns. The runtime will verify ` +
    `your selectors on the first extraction; if wrong, a self-heal job will ` +
    `re-engage you.\n` +
    `7. If the page DOES NOT have the data we need (no equivalent report ` +
    `exists in this PMS, or it's behind a paid module), reply with ` +
    `{"unavailable": true, "reason": "<why>"} so we can mark this target ` +
    `as unsupported and continue.\n\n` +

    `WHEN DONE WITH A REAL PAGE — your reply MUST start with the JSON ` +
    `object on the first line. No preamble like "I found the page" or ` +
    `"Here's the result". Just the JSON, then optional brief notes ` +
    `after. Output is capped, so a long preamble can truncate the JSON.\n\n` +

    `EXACT FORMAT (first line of your reply):\n` +
    `  {"url":"<final URL>","rowSelector":"<CSS selector matching one row>",` +
    `"columns":{<our field name>:"<selector relative to row>"}}\n\n` +

    `Required fields for this page: ${args.requiredFields.join(', ')}\n` +
    `Use empty string for fields not visible on the page.` +
    enumHint + sampleHint + `\n\n` +

    `Step budget: you have up to ${MAX_AGENT_STEPS_PER_ACTION} actions. ` +
    `Spend the first ~5 on exploration (read_page + nav clicks); ` +
    `if you've used 50+ without finding the page, emit ` +
    `{"unavailable":true,"reason":"<what you tried>"} on the first line ` +
    `and stop. Skipping an action is better than burning the whole budget.`;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: fullGoal }] },
  ];
  // Batched-pruning state — one per agent loop. See PRUNE_BATCH_TURNS
  // and maybePruneHistory() for the cache-friendliness rationale.
  const pruneState = createPruneState();

  const phaseStartedAt = Date.now();

  // Per-target cost baseline — snapshot job spend at the START of this
  // target so the per-target soft-abort below measures THIS target's delta
  // rather than cumulative job spend. Without it, late targets get aborted
  // with zero exploration once cumulative spend crosses the cap (the old
  // cap*3 cumulative heuristic). Best-effort: a read failure leaves the
  // baseline at 0, which just makes the soft-abort behave like the global
  // cap for this one target.
  const targetStartSpentMicros = args.jobId ? await getJobCostMicros(args.jobId) : 0;

  // Per-target action-loop detector. Trips on the 4th identical
  // (action, page) tuple within the last 8 turns — defaults chosen so
  // legitimate "click 3 rows to select 3 items" patterns don't false-
  // positive. Fresh instance per mapAction call: a loop on `getArrivals`
  // doesn't poison `getDepartures`.
  const loopDetector = new ActionLoopDetector();

  // Completeness re-ask budget (fix/mapper-field-contract). Bounds how many
  // times the success branch re-prompts the model to fill missing REQUIRED
  // columns before accepting blanks. Without it a feed can "succeed" with
  // empty selectors and silently write 0 rows (validateRows rejects every row
  // for the absent descriptor column). The per-target step/cost/wallclock/
  // token caps below are the outer backstops; this just stops us accepting a
  // structurally-incomplete column map on the first emit.
  let completenessReasks = 0;

  for (let stepIdx = 0; stepIdx < targetStepCap; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      return { ok: false, reason: 'token budget exceeded', finalUrl: args.page.url() };
    }
    if (Date.now() - phaseStartedAt > PHASE_WALLCLOCK_BUDGET_MS) {
      return { ok: false, reason: 'wallclock budget exceeded', finalUrl: args.page.url() };
    }
    // Per-turn budget check — global job cap.
    {
      const budget = await isJobOverBudget(args.jobId, args.jobCostCapMicros);
      if (budget.over) {
        log.warn('action mapper aborting — cumulative job cost cap hit', {
          jobId: args.jobId ?? undefined, actionName: args.actionName, ...budget,
        });
        return { ok: false, reason: 'cost cap hit', finalUrl: args.page.url() };
      }
    }
    // Plan v7 — per-target soft-abort. If the prior round trip pushed us
    // over targetCostCapMicros, stop initiating new rounds. The most
    // recent assistant turn (in `messages` already) may have emitted JSON
    // already; if not we return with partial data flagged via `incomplete`.
    if (targetOverBudget) {
      log.warn('mapper: per-target cost cap exceeded — soft-abort', {
        jobId: args.jobId ?? undefined,
        actionName: args.actionName,
        classification,
        targetCostCapMicros,
        stepIdx,
      });
      // Fall through to the end-of-loop "no usable JSON" branch with a
      // clearer reason. mapPMS treats this as a non-fatal partial.
      return {
        ok: false,
        reason: `per-target cost cap exceeded for ${classification} ($${(targetCostCapMicros / 1_000_000).toFixed(2)})`,
        finalUrl: args.page.url(),
      };
    }

    // Beta-API call so we can attach `cache_control` to the system block.
    // The system prompt + tool definitions are stable across the entire
    // mapping run; caching them means each turn after the first only pays
    // ~10% of their input-token cost. This was the dominant fix for the
    // 400K-token-budget exhaustion on CA's deep menus. (Pattern from
    // anthropic-quickstarts/browser-use-demo loop.py.)
    // Deterministic per-turn idempotency key (audit/concurrency #15).
    const idempotencyKey = args.jobId
      ? `${args.jobId}:${args.actionName}:${stepIdx}`
      : `anon:${args.actionName}:${stepIdx}:${Date.now()}`;

    // Adaptive thinking — see THINKING_HEADROOM_TOKENS. The headroom keeps
    // the VISIBLE-output cap at 4096 (Codex review finding 2).

    // Loop-detector input #1 — fingerprint the page state Claude is
    // about to reason on. Used after toolResults are built to record
    // (action, page) tuples. Computed BEFORE messages.create so the
    // page state matches what Claude sees in the screenshot it's about
    // to act on. Best-effort: errors fall back to a URL-only fingerprint
    // inside the helper.
    const turnPageFingerprint = await pageFingerprint(args.page);

    const response = await anthropic.beta.messages.create({
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN + THINKING_HEADROOM_TOKENS,
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: cfg.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [cfg.tool as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      messages: maybePruneHistory(messages, pruneState, stepIdx, HISTORY_KEEP_RECENT) as Anthropic.Beta.Messages.BetaMessageParam[],
      betas: cfg.betas,
    }, {
      ...(args.signal ? { signal: args.signal } : {}),
      headers: { 'idempotency-key': idempotencyKey },
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;

    void logClaudeUsage(response.usage ?? {}, {
      workload: 'cua_mapping_action',
      model: cfg.model,
      propertyId: args.propertyId,
      jobId: args.jobId,
      metadata: { actionName: args.actionName, stepIdx },
    });

    const responseContent = response.content as unknown as Anthropic.Messages.ContentBlock[];
    messages.push({ role: 'assistant', content: responseContent });

    if (response.stop_reason === 'end_turn') {
      const finalText = extractFinalText(responseContent);
      const parsed = tryParseJson(finalText) as
        | { rowSelector?: unknown; columns?: unknown; url?: unknown; unavailable?: unknown; reason?: unknown; ask_admin?: unknown; question?: unknown; valueSamples?: unknown; enumMappings?: unknown }
        | null;

      // Success path: agent found the page and emitted parse hints.
      if (parsed && typeof parsed.rowSelector === 'string' && parsed.columns && typeof parsed.columns === 'object') {
        const learnedColumns = parsed.columns as Record<string, string>;

        // Completeness re-ask (fix/mapper-field-contract): a "successful" feed
        // whose learned column map is missing a REQUIRED descriptor column
        // writes 0 rows at runtime. Re-ask the model (bounded) with the exact
        // snake_case key names before accepting blanks; the promotion gate
        // parks the draft if they're still missing after the budget is spent.
        //
        // Scoped to the CORE feeds' descriptor contract (missingRequiredColumns
        // returns [] for non-core targets, whose requiredFields can include
        // off-page fields like a forecast run-date the model genuinely can't
        // supply). This keeps the re-ask symmetric with the promotion gate,
        // which is also REQUIRED_TARGETS-only.
        const missingRequired = missingRequiredColumns(args.actionName as keyof Recipe['actions'], learnedColumns);
        if (missingRequired.length > 0 && completenessReasks < MAX_COMPLETENESS_REASKS) {
          completenessReasks++;
          log.warn('mapper: required columns missing/blank — re-asking model', {
            actionName: args.actionName,
            missing: missingRequired,
            attempt: completenessReasks,
            maxAttempts: MAX_COMPLETENESS_REASKS,
          });
          // Same rewind idiom as the unavailable / ask_admin branches: pop the
          // assistant turn that emitted the incomplete JSON, push a user-turn
          // hint, reset the exploration floor, re-enter the agent loop.
          messages.pop();
          messages.push({
            role: 'user',
            content: [{
              type: 'text',
              text:
                `Hint from your supervisor: your "columns" map is missing required ` +
                `field(s): ${missingRequired.join(', ')}. Re-read the row and add a ` +
                `CSS selector (relative to the row) for EACH missing field, using ` +
                `these EXACT key names. If a field genuinely does not appear ` +
                `anywhere on this page, leave it as an empty string and proceed.`,
            }],
          });
          readPageCount = 0;
          navigationCount = 0;
          continue;
        }

        // feat/pms-universal-translate — pass the model's raw value
        // observations back to mapPMS for date-order + enum-vocabulary
        // learning. Coerced loosely here; mapPMS validates/sanitizes against
        // the descriptor's canonical sets.
        const learnedSamples = coerceValueSamples(parsed.valueSamples);
        const learnedEnums = coerceEnumMappings(parsed.enumMappings);
        return {
          ok: true,
          action: {
            steps: recordedSteps,
            parse: {
              mode: 'table',
              hint: {
                rowSelector: parsed.rowSelector,
                columns: learnedColumns,
              },
            },
          },
          ...(learnedSamples && { valueSamples: learnedSamples }),
          ...(learnedEnums && { enumMappings: learnedEnums }),
        };
      }
      // "Unavailable" path: agent explored, found nothing, told us so.
      // Plan v7 — require evidence of real effort before accepting it.
      // Without this floor, a lazy/confused agent can emit unavailable on
      // its first response and burn the per-target cost cap on a fake
      // "this PMS tier doesn't have it" outcome that fools auto-promotion.
      if (parsed && parsed.unavailable === true) {
        const floorMet =
          readPageCount >= UNAVAILABLE_FLOOR.readPages &&
          navigationCount >= UNAVAILABLE_FLOOR.navigations;
        if (!floorMet) {
          log.warn('mapper: rejecting premature unavailable claim — insufficient exploration', {
            actionName: args.actionName,
            readPageCount,
            navigationCount,
            floor: UNAVAILABLE_FLOOR,
            reason: typeof parsed.reason === 'string' ? parsed.reason : null,
          });
          return {
            ok: false,
            reason: `premature unavailable (only ${readPageCount} read_pages + ${navigationCount} navigations; floor requires ${UNAVAILABLE_FLOOR.readPages} + ${UNAVAILABLE_FLOOR.navigations})`,
            finalUrl: args.page.url(),
          };
        }
        // Plan v8 Phase B — ask an online admin before accepting unavailable.
        // P0-2: on 'guidance', REWIND messages + push user-turn hint + re-enter
        // loop (does NOT use synthetic tool_result — that's API-invalid after
        // end_turn). On 'mark_unavailable', preserve today's behavior.
        const agentReason = typeof parsed.reason === 'string' ? parsed.reason : 'no reason given';
        const helpOutcome = await maybeAskAdminBeforeUnavailable({
          page: args.page,
          jobId: args.jobId,
          targetKey: args.actionName,
          agentReason,
          signal: args.signal,
        });
        if (helpOutcome.kind === 'continue') {
          // Pop the assistant turn that emitted the unavailable JSON, push
          // a user-turn hint, reset floor counters, re-enter the agent loop.
          messages.pop();
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `Hint from your supervisor: ${helpOutcome.hintText}\n\nContinue working on this target.` }],
          });
          readPageCount = 0;
          navigationCount = 0;
          continue;
        }
        if (helpOutcome.kind === 'abort') {
          throw new Error(helpOutcome.reason);
        }
        return {
          ok: false,
          reason: helpOutcome.kind === 'takeover'
            ? 'takeover requested (handler not yet implemented)'
            : helpOutcome.reason,
          finalUrl: args.page.url(),
        };
      }
      // "Ask admin" escape hatch: the agent emitted the help-request JSON
      // from the system prompt ({"ask_admin": true, "question": "…"}). Route
      // it through the same admin-help hook as the unavailable branch so a
      // live admin can unstick the agent before we give up. Without this,
      // the agent's documented help-request format fell straight through to
      // the no-usable-JSON failure below (dead escape hatch).
      if (parsed && parsed.ask_admin === true) {
        const agentReason = typeof parsed.question === 'string' ? parsed.question : 'no reason given';
        const helpOutcome = await maybeAskAdminBeforeUnavailable({
          page: args.page,
          jobId: args.jobId,
          targetKey: args.actionName,
          agentReason,
          signal: args.signal,
        });
        if (helpOutcome.kind === 'continue') {
          messages.pop();
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `Hint from your supervisor: ${helpOutcome.hintText}\n\nContinue working on this target.` }],
          });
          readPageCount = 0;
          navigationCount = 0;
          continue;
        }
        if (helpOutcome.kind === 'abort') {
          throw new Error(helpOutcome.reason);
        }
        return {
          ok: false,
          reason: helpOutcome.kind === 'takeover'
            ? 'takeover requested (handler not yet implemented)'
            : helpOutcome.reason,
          finalUrl: args.page.url(),
        };
      }
      return {
        ok: false,
        reason: `no usable JSON — agent said: ${finalText.slice(0, 200)}`,
        finalUrl: args.page.url(),
      };
    }

    // Same multi-tool_use handling as in mapLogin — see comment there.
    const toolUses = responseContent.filter((c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use');
    if (toolUses.length === 0) break;

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const action = toolUse.input as VisionAction;
      const actionType = (action as { action?: string }).action ?? '';

      // Critic — pre-screenshot for click verbs (left_click, double_click).
      // Scrolls and waits have no meaningful "intended outcome" worth
      // grading. Best-effort: if the pre-screenshot capture fails we set
      // preScreenshotB64=null and the critic block below short-circuits.
      const isClick = actionType === 'left_click' || actionType === 'double_click';
      const preScreenshotB64 = isClick
        ? await captureScreenshotForCritic(args.page)
        : null;

      const exec = await executeVisionAction(args.page, action, args.credentials, 'action');
      if (exec.recordedStep) recordedSteps.push(exec.recordedStep);

      // Critic — judge the click outcome and optionally prepend a
      // "Critic note: …" line to the tool_result text so the agent can
      // reconsider. Fail-open: if any step fails (post-screenshot, the
      // anthropic call, parse) we treat the verdict as 'unclear' inside
      // judgeStepOutcome and don't mutate the output.
      let execForToolResult = exec;
      if (isClick && preScreenshotB64) {
        // Settle delay — Codex review high-3: an immediate post-click
        // screenshot can catch an animating/transitioning page (SPA
        // route change, modal fade-in, dropdown expansion) and the
        // critic would falsely judge "no change" or "wrong change".
        // 300ms is enough for most CSS animations and same-doc SPA
        // route swaps without adding meaningful latency. For full
        // page navigations the agent's next screenshot will catch the
        // settled state; a verdict='unclear' here is the right answer
        // for an in-flight navigation.
        await args.page.waitForTimeout(300).catch(() => {});
        const postScreenshotB64 = await captureScreenshotForCritic(args.page);
        if (postScreenshotB64) {
          const coord = (toolUse.input as { coordinate?: unknown }).coordinate;
          const verdict = await judgeStepOutcome({
            pre: preScreenshotB64,
            post: postScreenshotB64,
            actionDescription: `${actionType} at ${Array.isArray(coord) ? coord.join(',') : 'unknown'}`,
            intendedOutcome: `make progress toward: ${args.goal.slice(0, 200)}`,
            jobId: args.jobId,
            propertyId: args.propertyId,
            signal: args.signal,
          });
          if (verdict.verdict === 'failure') {
            const note =
              `Critic note: that click does not appear to have achieved <${args.actionName}>. ` +
              `${verdict.reason} Reconsider before next action.\n\n`;
            execForToolResult = { ...exec, output: note + exec.output };
          } else if (verdict.verdict === 'unclear') {
            log.warn('critic: unclear verdict — continuing', {
              jobId: args.jobId ?? undefined,
              actionName: args.actionName,
              stepIdx,
              reason: verdict.reason,
            });
          }
        }
      }

      toolResults.push(makeToolResult(toolUse.id, execForToolResult));

      // Plan v7 — track activity for the unavailable floor.
      // Vision-only: a screenshot is "actually looked at the page";
      // left_click / double_click / scroll count as navigation effort.
      if (actionType === 'screenshot') {
        readPageCount++;
      } else if (actionType === 'left_click' || actionType === 'double_click' ||
                 actionType === 'scroll') {
        navigationCount++;
      }
    }

    // Loop-detector input #2 — record each toolUse's (action, page)
    // tuple and abort if any one trips the detector. Page fingerprint is
    // `turnPageFingerprint` from above (the state Claude reasoned on),
    // not the post-action state — we're detecting "agent keeps trying
    // the same thing on the same starting state", which is the canonical
    // stuck-in-a-loop pattern.
    for (const toolUse of toolUses) {
      const stuck = loopDetector.record(actionFingerprint(toolUse.input), turnPageFingerprint);
      if (stuck.stuck) {
        log.warn('mapper: action-loop detector tripped — aborting target', {
          jobId: args.jobId ?? undefined,
          actionName: args.actionName,
          stepIdx,
          reason: stuck.reason,
        });
        return { ok: false, reason: 'loop detector tripped', finalUrl: args.page.url() };
      }
    }

    messages.push({ role: 'user', content: toolResults });

    // Plan v7 — per-target cost soft-abort. After each round trip, check
    // how much THIS target has spent (current job spend minus the baseline
    // snapped at target start); if it's blown past the per-target cap, set
    // the flag and let the next iteration return cleanly. We DON'T abort
    // mid-call — the in-flight Anthropic call is already paid for, so we
    // let it complete and return whatever it had. Measuring the delta (not
    // cumulative job spend) means late targets still get their full
    // per-target budget instead of being aborted with zero exploration.
    if (args.jobId && targetCostCapMicros !== Number.POSITIVE_INFINITY) {
      const totalSpent = await getJobCostMicros(args.jobId);
      const targetSpent = totalSpent - targetStartSpentMicros;
      if (targetSpent > targetCostCapMicros) {
        targetOverBudget = true;
      }
    }
  }

  return { ok: false, reason: 'mapper exhausted step budget', finalUrl: args.page.url() };
}

// ─── Per-action mapping (DRILL-DOWN variant) ─────────────────────────────
//
// Plan v7 — for targets classified as `drilldown_sample` (pms_guests,
// pms_lost_and_found, pms_activity_log), the mapper drills into N=3
// sample records from a list page to learn the detail-page URL pattern
// AND the per-record field selectors. Output includes:
//   - list selectors (cheap, high-throughput)
//   - per-record detail selectors (expensive, on-demand only)
//   - URL template inferred from the 3 sample URLs (verified at runtime
//     when extracting), with placeholder→list-column mappings
//   - per-field coverage observed across samples (e.g. "email: 2/3")
//
// Why a separate function: drill-down has a fundamentally different
// output JSON shape (samples[] array vs single rowSelector/columns),
// different goal/system-prompt phrasing, and post-processing (URL
// inference + coverage tally) that mapAction doesn't need.

interface DrillDownSamplePayload {
  url?: unknown;
  rowData?: unknown;
  detailColumns?: unknown;
}
interface DrillDownAgentPayload {
  listUrl?: unknown;
  listRowSelector?: unknown;
  listColumns?: unknown;
  samples?: unknown;
  unavailable?: unknown;
  reason?: unknown;
  ask_admin?: unknown;
  question?: unknown;
}

async function mapDrillDownAction(args: {
  page: Page;
  actionName: string;
  goal: string;
  requiredFields: string[];
  postLoginUrl: string;
  credentials: PMSCredentials;
  propertyId: string | null;
  jobId: string | null;
  signal?: AbortSignal;
  model?: MapperModelId;
  /** Plan v8 review P0-A — per-job cap override (vision uses higher cap). */
  jobCostCapMicros?: number;
}): Promise<ActionMapSuccess | ActionMapFailure> {
  const cfg = getModeConfig(args.model);

  // Reuse the post-login navigation setup from mapAction.
  if (args.page.url() !== args.postLoginUrl) {
    const allowedHost = new URL(args.credentials.loginUrl).host;
    await safeGoto(args.page, args.postLoginUrl, {
      allowedHost,
      context: 'mapper:drilldown:postLoginUrl',
    }).catch(() => {});
    await args.page.waitForTimeout(1000);
  }

  const recordedSteps: RecipeStep[] = [{ kind: 'goto', url: args.postLoginUrl }];
  let totalInputTokens = 0;

  const classification = 'drilldown_sample';
  const targetStepCap = TARGET_STEP_CAPS[classification]!;
  const targetCostCapMicros = TARGET_BUDGET_MICROS[classification]!;
  // Drill-down samples = 3; cost scales roughly with sample count.
  const SAMPLE_COUNT = 3;

  const fullGoal =
    args.goal +
    `\n\nDRILL-DOWN WORKFLOW:\n` +
    `1. Take a SCREENSHOT to see the dashboard menus.\n` +
    `2. Navigate to the LIST page by clicking visible menus (e.g. ` +
    `reservations list, lost-items list).\n` +
    `3. Look at the list visually. Make your best-guess CSS selectors for ` +
    `the row + the columns of fields visible IN THE ROW (most PMSes use ` +
    `\`tr\` for rows + \`td:nth-child(N)\` for cells).\n` +
    `4. Pick up to ${SAMPLE_COUNT} sample rows (fewer is fine if the list ` +
    `has only 1-2 records — even ONE sample is enough). For each one:\n` +
    `   - Capture the row's data (so we can map URL placeholders to columns)\n` +
    `   - Click into the row to open the detail page\n` +
    `   - Capture the detail page URL (will be used for template inference)\n` +
    `   - Capture detail-page-only field selectors (fields NOT shown in the list)\n` +
    `   - Navigate back to the list before the next sample\n` +
    `5. Emit the final JSON in this shape:\n` +
    `   {\n` +
    `     "listUrl": "...",\n` +
    `     "listRowSelector": "...",\n` +
    `     "listColumns": {"reservation_id": "td:nth-child(1)", ...},\n` +
    `     "samples": [\n` +
    `       {\n` +
    `         "url": "/Reservation/view?id=ABC123",\n` +
    `         "rowData": {"reservation_id": "ABC123", ...},\n` +
    `         "detailColumns": {"email": ".guest-email", "phone": ".guest-phone", ...}\n` +
    `       },\n` +
    `       // ${SAMPLE_COUNT - 1} more samples\n` +
    `     ]\n` +
    `   }\n` +
    `\n` +
    `If you genuinely can't find the list page (e.g. the PMS doesn't have ` +
    `a Lost & Found module), emit {"unavailable": true, "reason": "..."} ` +
    `per the system-prompt floor (≥1 screenshot, ≥3 navigations first).\n` +
    `If you FOUND the list page but it has ZERO rows (e.g. no items today), ` +
    `that is NOT unavailable — emit the JSON with the list selectors and an ` +
    `empty "samples": [] array.\n\n` +
    `Required fields: ${args.requiredFields.join(', ')}\n` +
    `Output the JSON on the first line of your reply — no preamble.`;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: fullGoal }] },
  ];
  // Batched-pruning state — one per agent loop. See PRUNE_BATCH_TURNS
  // and maybePruneHistory() for the cache-friendliness rationale.
  const pruneState = createPruneState();

  const phaseStartedAt = Date.now();
  // Same unavailable-floor tracking as mapAction.
  const UNAVAILABLE_FLOOR = { readPages: 1, navigations: 3 };
  let readPageCount = 0;
  let navigationCount = 0;
  let targetOverBudget = false;

  // Drill-down step budget = per-target × sample-count (since each sample
  // is its own back-and-forth).
  const effectiveStepCap = targetStepCap * SAMPLE_COUNT;

  // Per-target cost baseline — snapshot job spend at the START so the
  // soft-abort below measures THIS target's delta, not cumulative job
  // spend (which would abort late targets with zero exploration). See the
  // matching note in mapAction.
  const targetStartSpentMicros = args.jobId ? await getJobCostMicros(args.jobId) : 0;

  // Action-loop detector — same guard mapAction uses. A drill-down that
  // keeps re-clicking the same row on the same list state burns the (large)
  // drill-down step budget; trip on the 4th identical (action, page) tuple.
  const loopDetector = new ActionLoopDetector();

  for (let stepIdx = 0; stepIdx < effectiveStepCap; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      return { ok: false, reason: 'token budget exceeded', finalUrl: args.page.url() };
    }
    if (Date.now() - phaseStartedAt > PHASE_WALLCLOCK_BUDGET_MS) {
      return { ok: false, reason: 'wallclock budget exceeded', finalUrl: args.page.url() };
    }
    const budget = await isJobOverBudget(args.jobId, args.jobCostCapMicros);
    if (budget.over) {
      log.warn('drilldown mapper aborting — cumulative job cost cap hit', {
        jobId: args.jobId ?? undefined, actionName: args.actionName, ...budget,
      });
      return { ok: false, reason: 'cost cap hit', finalUrl: args.page.url() };
    }
    if (targetOverBudget) {
      log.warn('drilldown mapper: per-target cost cap exceeded — soft-abort', {
        actionName: args.actionName, targetCostCapMicros, stepIdx,
      });
      return {
        ok: false,
        reason: `per-target cost cap exceeded for drilldown_sample ($${(targetCostCapMicros / 1_000_000).toFixed(2)})`,
        finalUrl: args.page.url(),
      };
    }

    const idempotencyKey = args.jobId
      ? `${args.jobId}:drilldown:${args.actionName}:${stepIdx}`
      : `anon:drilldown:${args.actionName}:${stepIdx}:${Date.now()}`;

    // Loop-detector input — fingerprint the page state Claude is about to
    // reason on (same pattern as mapAction). Computed BEFORE messages.create
    // so it matches the screenshot the model acts on.
    const turnPageFingerprint = await pageFingerprint(args.page);

    // Adaptive thinking — see THINKING_HEADROOM_TOKENS. The headroom keeps
    // the VISIBLE-output cap at MAX_OUTPUT_TOKENS_PER_TURN (4096).
    const response = await anthropic.beta.messages.create({
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN + THINKING_HEADROOM_TOKENS,
      thinking: { type: 'adaptive' },
      system: [
        { type: 'text', text: cfg.systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      tools: [cfg.tool as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      messages: maybePruneHistory(messages, pruneState, stepIdx, HISTORY_KEEP_RECENT) as Anthropic.Beta.Messages.BetaMessageParam[],
      betas: cfg.betas,
    }, {
      ...(args.signal ? { signal: args.signal } : {}),
      headers: { 'idempotency-key': idempotencyKey },
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;
    void logClaudeUsage(response.usage ?? {}, {
      workload: 'cua_mapping_drilldown',
      model: cfg.model,
      propertyId: args.propertyId,
      jobId: args.jobId,
      metadata: { actionName: args.actionName, stepIdx },
    });

    const responseContent = response.content as unknown as Anthropic.Messages.ContentBlock[];
    messages.push({ role: 'assistant', content: responseContent });

    if (response.stop_reason === 'end_turn') {
      const finalText = extractFinalText(responseContent);
      const parsed = tryParseJson(finalText) as DrillDownAgentPayload | null;

      // Unavailable path — same floor check as mapAction.
      if (parsed && parsed.unavailable === true) {
        const floorMet =
          readPageCount >= UNAVAILABLE_FLOOR.readPages &&
          navigationCount >= UNAVAILABLE_FLOOR.navigations;
        if (!floorMet) {
          return {
            ok: false,
            reason: `premature unavailable in drilldown (${readPageCount} read_pages + ${navigationCount} navigations)`,
            finalUrl: args.page.url(),
          };
        }
        // Plan v8 Phase B — same admin-help hook as mapAction. See P0-2.
        const agentReason = typeof parsed.reason === 'string' ? parsed.reason : 'no reason given';
        const helpOutcome = await maybeAskAdminBeforeUnavailable({
          page: args.page,
          jobId: args.jobId,
          targetKey: args.actionName,
          agentReason,
          signal: args.signal,
        });
        if (helpOutcome.kind === 'continue') {
          messages.pop();
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `Hint from your supervisor: ${helpOutcome.hintText}\n\nContinue working on this drill-down target.` }],
          });
          readPageCount = 0;
          navigationCount = 0;
          continue;
        }
        if (helpOutcome.kind === 'abort') {
          throw new Error(helpOutcome.reason);
        }
        return {
          ok: false,
          reason: helpOutcome.kind === 'takeover'
            ? 'takeover requested (handler not yet implemented)'
            : helpOutcome.reason,
          finalUrl: args.page.url(),
        };
      }

      // Success path — validate shape, infer URL template, compute coverage.
      // C4: don't require a full SAMPLE_COUNT of drilled records. URL-template
      // inference works with a single sample, so accept >= min(SAMPLE_COUNT,
      // observed). And an EMPTY list (zero rows — e.g. a hotel with no
      // lost-and-found items today) is a legitimate success, not a failure:
      // we record the list selectors and skip detail-template inference.
      if (
        parsed &&
        typeof parsed.listUrl === 'string' &&
        typeof parsed.listRowSelector === 'string' &&
        parsed.listColumns && typeof parsed.listColumns === 'object' &&
        Array.isArray(parsed.samples)
      ) {
        const samples = parsed.samples as DrillDownSamplePayload[];
        // Empty list = zero rows on the list page. Capture the list-page
        // selectors (the runtime can still extract the empty list and
        // re-learn detail selectors once real records appear) and return a
        // list-only recipe — no drillDown block, since there's nothing to
        // infer a detail-URL template from.
        if (samples.length === 0) {
          log.info('mapper: drilldown list page is empty — recording list-only recipe', {
            jobId: args.jobId ?? undefined, actionName: args.actionName, listUrl: parsed.listUrl,
          });
          return {
            ok: true,
            action: {
              steps: recordedSteps,
              parse: {
                mode: 'table',
                hint: {
                  rowSelector: parsed.listRowSelector,
                  columns: parsed.listColumns as Record<string, string>,
                },
              },
            },
          };
        }
        // Accept whatever the agent drilled (>=1); URL-template inference
        // needs only one sample. Don't slice past what we actually have.
        const effectiveSamples = Math.min(SAMPLE_COUNT, samples.length);
        const sampleUrls: string[] = [];
        const sampleRowData: Array<Record<string, string>> = [];
        const sampleDetailColumns: Array<Record<string, string>> = [];
        for (const s of samples.slice(0, effectiveSamples)) {
          if (typeof s.url !== 'string' || !s.rowData || typeof s.rowData !== 'object' ||
              !s.detailColumns || typeof s.detailColumns !== 'object') {
            return {
              ok: false,
              reason: 'drilldown samples malformed (each needs url + rowData + detailColumns)',
              finalUrl: args.page.url(),
            };
          }
          sampleUrls.push(s.url);
          sampleRowData.push(s.rowData as Record<string, string>);
          sampleDetailColumns.push(s.detailColumns as Record<string, string>);
        }

        // URL template inference.
        const inference = inferUrlTemplate(sampleUrls);
        const detailUrlTemplate = inference.ok ? inference.template : sampleUrls[0]!;
        const placeholderToColumn = inference.ok
          ? mapPlaceholdersToColumns(inference.placeholders, sampleRowData)
          : {};
        // Map placeholders to friendlier names — use the column name as
        // the new placeholder (e.g. var_0 → pms_reservation_id).
        const detailUrlParams: Record<string, string> = {};
        for (const [placeholder, columnName] of Object.entries(placeholderToColumn)) {
          detailUrlParams[columnName] = columnName;
        }

        // Per-field coverage: for each detail field, count samples where
        // the selector returned a non-empty value. Agent reports this
        // implicitly by whether the field appears in each sample's
        // detailColumns.
        const allDetailFields = new Set<string>();
        for (const dc of sampleDetailColumns) {
          for (const k of Object.keys(dc)) allDetailFields.add(k);
        }
        const fieldCoverage: Record<string, string> = {};
        const mergedDetailColumns: Record<string, string> = {};
        for (const field of allDetailFields) {
          let present = 0;
          for (const dc of sampleDetailColumns) {
            if (dc[field] && String(dc[field]).length > 0) present++;
          }
          fieldCoverage[field] = `${present}/${effectiveSamples}`;
          // Use the first non-empty selector as the canonical one.
          for (const dc of sampleDetailColumns) {
            if (dc[field] && String(dc[field]).length > 0) {
              mergedDetailColumns[field] = String(dc[field]);
              break;
            }
          }
        }

        return {
          ok: true,
          action: {
            steps: recordedSteps,
            parse: {
              mode: 'table',
              hint: {
                rowSelector: parsed.listRowSelector,
                columns: parsed.listColumns as Record<string, string>,
              },
            },
            drillDown: {
              listUrl: parsed.listUrl,
              listRowSelector: parsed.listRowSelector,
              listColumns: parsed.listColumns as Record<string, string>,
              detailUrlTemplate,
              detailUrlParams,
              detailColumns: mergedDetailColumns,
              fieldCoverage,
              samplesDrilled: effectiveSamples,
              // Plan v7 calls for a 4th-sample verification drill; for the
              // initial Phase 2a ship we treat successful inference as
              // verification. A follow-up enhancement (Phase 2c polish)
              // will add the explicit 4th drill.
              templateVerified: inference.ok,
            },
          },
        };
      }

      // "Ask admin" escape hatch — same hook as the unavailable branch.
      // The agent emitted the help-request JSON from the system prompt
      // ({"ask_admin": true, "question": "…"}); route it to a live admin
      // instead of letting it fall through to the no-usable-JSON failure.
      if (parsed && parsed.ask_admin === true) {
        const agentReason = typeof parsed.question === 'string' ? parsed.question : 'no reason given';
        const helpOutcome = await maybeAskAdminBeforeUnavailable({
          page: args.page,
          jobId: args.jobId,
          targetKey: args.actionName,
          agentReason,
          signal: args.signal,
        });
        if (helpOutcome.kind === 'continue') {
          messages.pop();
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `Hint from your supervisor: ${helpOutcome.hintText}\n\nContinue working on this drill-down target.` }],
          });
          readPageCount = 0;
          navigationCount = 0;
          continue;
        }
        if (helpOutcome.kind === 'abort') {
          throw new Error(helpOutcome.reason);
        }
        return {
          ok: false,
          reason: helpOutcome.kind === 'takeover'
            ? 'takeover requested (handler not yet implemented)'
            : helpOutcome.reason,
          finalUrl: args.page.url(),
        };
      }

      return {
        ok: false,
        reason: `drilldown: no usable JSON — agent said: ${finalText.slice(0, 200)}`,
        finalUrl: args.page.url(),
      };
    }

    const toolUses = responseContent.filter((c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use');
    if (toolUses.length === 0) break;

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const action = toolUse.input as VisionAction;
      const exec = await executeVisionAction(args.page, action, args.credentials, 'action');
      if (exec.recordedStep) recordedSteps.push(exec.recordedStep);
      toolResults.push(makeToolResult(toolUse.id, exec));

      const actionType = (action as { action?: string }).action ?? '';
      // Vision-only: a screenshot is "actually looked at the page";
      // click/scroll count as navigation effort.
      if (actionType === 'screenshot') readPageCount++;
      else if (actionType === 'left_click' || actionType === 'double_click' ||
               actionType === 'scroll') navigationCount++;
    }

    // Loop-detector — record each toolUse's (action, page) tuple against
    // the pre-action page fingerprint and abort if stuck (same pattern as
    // mapAction).
    for (const toolUse of toolUses) {
      const stuck = loopDetector.record(actionFingerprint(toolUse.input), turnPageFingerprint);
      if (stuck.stuck) {
        log.warn('drilldown mapper: action-loop detector tripped — aborting target', {
          jobId: args.jobId ?? undefined, actionName: args.actionName, stepIdx, reason: stuck.reason,
        });
        return { ok: false, reason: 'loop detector tripped', finalUrl: args.page.url() };
      }
    }

    messages.push({ role: 'user', content: toolResults });

    // Per-target cost soft-abort — measure THIS target's delta from the
    // baseline snapped at target start, not cumulative job spend (which
    // would abort late targets with zero exploration).
    if (args.jobId) {
      const totalSpent = await getJobCostMicros(args.jobId);
      if (totalSpent - targetStartSpentMicros > targetCostCapMicros) targetOverBudget = true;
    }
  }

  return { ok: false, reason: 'drilldown exhausted step budget', finalUrl: args.page.url() };
}

// ─── Tool-result formatting ──────────────────────────────────────────────

function makeToolResult(
  toolUseId: string,
  exec: { output: string; screenshotB64?: string; isError?: boolean },
): Anthropic.Messages.ToolResultBlockParam {
  const content: Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam> = [];
  // Anthropic best-practices guidance (https://claude.com/blog/best-practices-
  // for-computer-and-browser-use-with-claude): place TEXT BEFORE IMAGE in
  // tool_result content. The model attends to text as it processes the
  // screenshot, so a leading text block ("Left-clicked at (320, 480).")
  // primes recognition of what it should now be looking at — measurable
  // improvement in click accuracy on dense PMS pages.
  // Codex audit pass-6 P1 — wrap PMS-derived text in an explicit
  // untrusted-content boundary. The system prompt instructs Claude to
  // treat anything inside this tag strictly as data, never as
  // instructions. Errors and short status messages from the tool
  // wrapper itself (e.g. "selector not found") are NOT page content
  // and don't need the wrapper.
  const wrappedText = exec.isError
    ? exec.output
    : `<untrusted_pms_content>\n${exec.output}\n</untrusted_pms_content>`;
  content.push({ type: 'text', text: wrappedText });
  if (exec.screenshotB64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: exec.screenshotB64 },
    });
  }
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: exec.isError ?? false,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Detect a one-time-code / MFA login screen. Returns true when the page
 * shows a common OTP/MFA prompt (visible "verification code" / "one-time
 * code" / "two-factor" / "authentication code" text) OR a 6-digit code
 * input. Used in mapLogin to bail with a distinct `mfa_required` reason
 * instead of spinning until the step budget times out.
 *
 * Best-effort: any evaluate error returns false so the caller proceeds
 * exactly as it did before this check existed.
 */
async function detectMfaScreen(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText ?? '').toLowerCase();
      const phrases = [
        'verification code',
        'one-time code',
        'one time code',
        'one-time passcode',
        'two-factor',
        'two factor',
        'authentication code',
        'security code',
        'enter the code',
      ];
      if (phrases.some((p) => text.includes(p))) return true;
      // A dedicated 6-digit code input is a strong MFA signal even when the
      // surrounding copy is unusual. Match maxlength=6 numeric/otp inputs or
      // a one-time-code autocomplete hint.
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.some((el) => {
        const input = el as HTMLInputElement;
        const maxLen = input.getAttribute('maxlength');
        const inputMode = (input.getAttribute('inputmode') ?? '').toLowerCase();
        const autocomplete = (input.getAttribute('autocomplete') ?? '').toLowerCase();
        if (autocomplete.includes('one-time-code')) return true;
        if (maxLen === '6' && (input.type === 'tel' || input.type === 'number' || inputMode === 'numeric')) return true;
        return false;
      });
    });
  } catch {
    return false;
  }
}

function extractFinalText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Find a parseable JSON object anywhere in the text.
 *
 * The agent doesn't always follow the "JSON only, no preamble" rule —
 * we routinely see responses like:
 *   "I have full clarity on the Departures page. The columns are
 *    `{name: 'guest', selector: '.foo'}`. The full result is:
 *    {\"url\":\"...\",\"rowSelector\":\"...\",\"columns\":{...}}"
 *
 * The naive `/\{[\s\S]*\}/` regex matches GREEDILY from the first `{`
 * to the last `}`, which on the example above grabs both the markdown
 * code-snippet braces AND the real JSON, producing an unparseable blob.
 *
 * Strategy: walk every `{` position; for each, scan forward counting
 * brace depth (respecting strings + escapes) until balanced; try
 * JSON.parse on that span; return the FIRST object that parses to
 * something with the shape we want. This is robust to embedded brace
 * pairs, partial truncation, code fences, etc.
 */
function tryParseJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();

  // 1. Whole-string parse (cheapest path — works when agent obeyed the
  //    JSON-only instruction).
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through */ }

  // 2. Walk every '{' and try parsing the balanced span starting there.
  //    Prefer the LARGEST successful parse (more likely the real result,
  //    not a code-snippet brace pair).
  let best: unknown = null;
  let bestSize = 0;

  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '{') continue;
    const end = scanBalancedBrace(cleaned, start);
    if (end < 0) continue;
    const span = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(span);
      if (parsed && typeof parsed === 'object' && span.length > bestSize) {
        best = parsed;
        bestSize = span.length;
      }
    } catch { /* try next */ }
  }
  return best;
}

/**
 * From `start` (a position of '{'), find the matching '}'. Respects
 * string literals (with backslash escapes). Returns -1 if unbalanced.
 */
function scanBalancedBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = false; continue; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ─── Per-action goal prompts ─────────────────────────────────────────────

const HOUSEKEEPING_GOAL =
  `Find the DAILY HOUSEKEEPING report — sometimes called "Housekeeping ` +
  `Check-off List", "Room Status Report", "Housekeeping Report", or ` +
  `"Daily Maid Sheet". This is a per-room snapshot showing every occupied ` +
  `+ vacant room in the property and its current status.\n\n` +
  `Usually under "Reports", "Front Desk → Reports", or "Housekeeping". ` +
  `You may need to set filters (date=today, all rooms, all statuses) ` +
  `before the report renders.\n\n` +
  `The right page shows a TABLE with one row per room. Use these EXACT keys ` +
  `in your "columns" object (column labels vary by PMS — match what's closest):\n` +
  `  - room_number (required)\n` +
  `  - status (required — the room's current housekeeping/occupancy state; ` +
  `pick the single column that best represents it, e.g. Occupied / Vacant / ` +
  `Clean / Dirty / Inspected / Out of Order)\n` +
  `  - changed_by (optional — who last changed the status, if shown)`;

const ARRIVALS_GOAL =
  `Find today's ARRIVALS list — sometimes called "Arrivals", "Today's ` +
  `Arrivals", "Check-Ins", or "Expected Arrivals". Shows reservations whose ` +
  `arrival date is today.\n\n` +
  `Usually under "Front Desk", "Reservations", or "View" menu. The right ` +
  `page is a list/table where each row is one reservation.\n\n` +
  `Use these EXACT keys in your "columns" object:\n` +
  `  - pms_reservation_id (required — the reservation's unique id; usually the ` +
  `Confirmation # / Reservation # shown on the row)\n` +
  `  - guest_name (required)\n` +
  `  - arrival_date (required)\n` +
  `  - departure_date (required)\n` +
  `  - room_number (optional — may be blank before assignment)\n` +
  `  - status (optional — reservation status if shown)`;
// num_nights + rate_per_night_cents carry value parsers in the contract (so
// they're type-safe IF ever learned) but are deliberately left OUT of the prose.
// validateRows rejects the WHOLE row when an OPTIONAL field's value is out of
// range / unparseable (a misread "2102" nights exceeds 0207's 0-365 range; a
// stray char in a cents cell), and the gate doesn't check optionals — so one bad
// optional value would silently drop a good reservation. num_nights is also
// derivable from arrival_date/departure_date, so prompting for it gains nothing.

const DEPARTURES_GOAL =
  `Find today's DEPARTURES list — sometimes called "Departures", "Check-Outs", ` +
  `or "Today's Departures". Shows reservations whose departure date is today. ` +
  `Usually right next to Arrivals in the menu.\n\n` +
  `Use these EXACT keys in your "columns" object (same reservation table as ` +
  `arrivals):\n` +
  `  - pms_reservation_id (required — the reservation's unique id; usually the ` +
  `Confirmation # / Reservation # shown on the row)\n` +
  `  - guest_name (required)\n` +
  `  - arrival_date (required)\n` +
  `  - departure_date (required)\n` +
  `  - room_number (optional)`;
// num_nights left out of the prose — see the note on ARRIVALS_GOAL.

// STAFF_GOAL removed in v8 Phase D.1 along with the getStaffRoster target.

// ─── Plan v7 Phase 2a: 9 net-new targets ─────────────────────────────────
// Each target maps to one v4 pms_* table. Targets vary in difficulty:
// list_page (1-2 clicks), report_menu (Reports submenu drill, 2-3 clicks),
// drilldown_sample (per-record drill, sample N=3 to learn detail page).
// See plan v7 for the full classification.

const GUESTS_GOAL =
  `Find a GUEST PROFILE — the page that shows guest contact info, loyalty ` +
  `tier, lifetime stays, and stay history. This is a DRILL-DOWN target: ` +
  `start from the reservations list, click into 3 sample reservations, ` +
  `and on each detail page click "Guest" / "Profile" / the guest's name.\n\n` +
  `The right page is a single-record detail view (one guest, not a list).\n\n` +
  `Per the drill-down rules in the system prompt: capture 3 sample URLs, ` +
  `infer the URL template (e.g. \`/Guest/view?id={pms_guest_id}\`), and ` +
  `verify with a 4th drill. Report per-field observed coverage.\n\n` +
  `Fields we need (mark required vs nice-to-have in your output):\n` +
  `  - pms_guest_id (required — the PMS's stable guest identifier)\n` +
  `  - name (required)\n` +
  `  - email (nice-to-have — often missing for walk-ins)\n` +
  `  - phone (nice-to-have)\n` +
  `  - loyalty_tier / loyalty_points (nice-to-have — if PMS has loyalty)\n` +
  `  - lifetime_stays / lifetime_value (nice-to-have)\n` +
  `  - last_stay_date (nice-to-have)`;

const REVENUE_DAILY_GOAL =
  `Find the DAILY REVENUE SUMMARY report — sometimes called "Night Audit ` +
  `Report", "Daily Revenue Summary", "Revenue by Day", or "Day-End ` +
  `Report". Shows ONE ROW per date with rooms revenue, F&B, taxes, ` +
  `occupancy %, ADR, RevPAR.\n\n` +
  `Usually under "Reports → Revenue", "Reports → Financial", or "Night ` +
  `Audit → Reports". On smaller franchise-tier PMSes this report may not ` +
  `exist — if so, emit unavailable per the system prompt rules (after ` +
  `meeting the evidence floor).\n\n` +
  `Columns we need:\n` +
  `  - date (required)\n` +
  `  - rooms_revenue_cents (required)\n` +
  `  - fnb_revenue_cents (nice-to-have)\n` +
  `  - tax_cents (nice-to-have)\n` +
  `  - occupied_rooms (required)\n` +
  `  - occupancy_pct (required — or computed from occupied/total)\n` +
  `  - adr_cents (required — Average Daily Rate)\n` +
  `  - revpar_cents (required — RevPAR)`;

const FORECAST_DAILY_GOAL =
  `Find the OCCUPANCY/REVENUE FORECAST — sometimes called "Forecast", ` +
  `"Pace Report", "Revenue Forecast", or "Projected Occupancy". Shows ` +
  `forward-looking dates with projected occupancy / ADR / revenue.\n\n` +
  `Usually under "Reports → Forecast", "Reports → Pace", or "Revenue ` +
  `Management". Often only on enterprise/Hilton-tier PMSes — if not ` +
  `present, emit unavailable per the system prompt rules.\n\n` +
  `Columns we need:\n` +
  `  - forecast_date (required — the FUTURE date being forecasted)\n` +
  `  - snapshot_date (required — when the forecast was generated, usually today)\n` +
  `  - projected_occupancy_pct (required)\n` +
  `  - projected_adr_cents (nice-to-have)\n` +
  `  - projected_revenue_cents (nice-to-have)\n` +
  `  - vs_same_day_last_year_pct (nice-to-have)`;

const CHANNEL_PERFORMANCE_GOAL =
  `Find the BOOKING CHANNEL / SOURCE PERFORMANCE report — sometimes ` +
  `called "Source Summary", "Channel Production", "OTA Breakdown", or ` +
  `"Reservations by Source". Shows ONE ROW per channel per day: ` +
  `Expedia / Booking.com / Brand.com / Direct / Walk-in / etc.\n\n` +
  `Usually under "Reports → Channels", "Reports → Source Analysis", or ` +
  `"Revenue Management". Most modern PMSes have this; tiny franchise ` +
  `PMSes may not.\n\n` +
  `Columns we need:\n` +
  `  - date (required)\n` +
  `  - channel (required — string, e.g. "Expedia")\n` +
  `  - bookings_count (required)\n` +
  `  - rooms_sold (required)\n` +
  `  - revenue_cents (required)\n` +
  `  - commission_rate_pct (nice-to-have)`;

const ACTIVITY_LOG_GOAL =
  `Find the AUDIT / ACTIVITY LOG — sometimes called "User Activity", ` +
  `"Audit Trail", "Operations Log", or "System Log". Shows ONE ROW per ` +
  `action: who did what, when (folio charges, room changes, ` +
  `check-ins/outs, comp authorizations).\n\n` +
  `DRILL-DOWN target: this often requires filtering by date range or ` +
  `user before the log renders. Find the top-level log page, then drill ` +
  `into 3 sample entries to capture the detail view.\n\n` +
  `Usually under "Reports → Audit", "Setup → Logs", or "Admin → Activity". ` +
  `Often admin-only; may be unavailable on read-only credentials.\n\n` +
  `Columns we need:\n` +
  `  - captured_at (required — timestamp)\n` +
  `  - pms_user (required — who did it)\n` +
  `  - action (required — what they did, e.g. "folio_charge")\n` +
  `  - target (nice-to-have — what they did it TO, e.g. room number)\n` +
  `  - details (nice-to-have — free-text or jsonb context)`;

const LOST_AND_FOUND_GOAL =
  `Find the LOST AND FOUND log — sometimes called "Lost Items", ` +
  `"Found Property", or under "Housekeeping → Lost & Found". Shows ` +
  `items left by guests, where found, and claim status.\n\n` +
  `DRILL-DOWN target: list page may not show all detail fields. Find ` +
  `the list, drill into 3 sample items to capture detail-page selectors ` +
  `for description/photos/claim history.\n\n` +
  `Columns we need:\n` +
  `  - pms_item_id (nice-to-have — some PMSes don't issue ids)\n` +
  `  - item_description (required)\n` +
  `  - location_found (required — room number or area)\n` +
  `  - found_at (required — date)\n` +
  `  - status (required — "unclaimed" / "claimed" / "disposed")\n` +
  `  - claimed_by_guest (nice-to-have — name if claimed)`;

const GROUPS_AND_BLOCKS_GOAL =
  `Find the GROUP / BLOCK reservations — group bookings (weddings, ` +
  `conferences, corporate events). Sometimes called "Groups", "Blocks", ` +
  `"Group Reservations", or "Block Management". Shows allotments with ` +
  `pickup rates.\n\n` +
  `Usually under "Reservations → Groups", "Group Sales", or "Block ` +
  `Manager". DRILL-DOWN if needed: list view → click each group for ` +
  `block details.\n\n` +
  `Columns we need:\n` +
  `  - pms_group_id (required)\n` +
  `  - group_name (required)\n` +
  `  - block_start_date (required)\n` +
  `  - block_end_date (required)\n` +
  `  - rooms_blocked (required)\n` +
  `  - rooms_picked_up (required)\n` +
  `  - pickup_pct (nice-to-have — can be computed)\n` +
  `  - cutoff_date (nice-to-have)`;

const RATES_AND_INVENTORY_GOAL =
  `Find the RATE MANAGER / RATE PLAN page — sometimes called "Rate ` +
  `Manager", "Rate Plans", "Inventory Grid", "Channel Manager", or ` +
  `"Yield Management". Shows per-room-type, per-date rates with ` +
  `available inventory.\n\n` +
  `Usually under "Rates", "Revenue Management", or "Inventory". This ` +
  `is the busiest data shape — often a GRID (date × room type) rather ` +
  `than a table. Find it; report the row+column structure.\n\n` +
  `Columns we need (one row per room_type × date × rate_plan):\n` +
  `  - date (required)\n` +
  `  - room_type (required)\n` +
  `  - rate_plan (required — e.g. "Best Available Rate")\n` +
  `  - rate_amount_cents (required)\n` +
  `  - available_rooms (required)\n` +
  `  - rate_parity_status (nice-to-have — "parity" / "above" / "below")`;

const WORK_ORDERS_GOAL =
  `Find the WORK ORDERS / MAINTENANCE TICKETS / OUT-OF-ORDER ROOMS list. ` +
  `Sometimes called "Maintenance", "Work Orders", "OOO Rooms", or ` +
  `"Engineering". Shows open + in-progress + resolved orders.\n\n` +
  `On Choice Advantage, there's a JSON endpoint (WorkOrders.jx) — try ` +
  `to find a "Work Orders" menu item; the click usually fires a fetch ` +
  `for the JSON. Report the fetch URL + body shape.\n\n` +
  `Columns we need:\n` +
  `  - pms_work_order_id (required)\n` +
  `  - room_number (required if room-scoped)\n` +
  `  - description (required)\n` +
  `  - priority (nice-to-have — "urgent" / "high" / "medium" / "low")\n` +
  `  - status (required — "open" / "in_progress" / "closed" / "deferred" / "resolved")\n` +
  `  - assigned_to (nice-to-have)\n` +
  `  - out_of_order (required — boolean: does this take the room offline?)`;

// ─── feat/pms-universal-translate: 5 net-new money / booking feeds ──────────
// PMS-AGNOSTIC goals — describe the report by its common names + likely menu
// areas (hints, not hardcoded paths) and the EXACT snake_case keys to emit.
// All money fields are optional + carry the generic_currency parser, so a
// blank / unreadable cell becomes null rather than dropping the row.

const GUEST_BALANCES_GOAL =
  `Find the GUEST BALANCES / OUTSTANDING FOLIOS / ACCOUNTS-RECEIVABLE list — ` +
  `sometimes called "Balances", "Folios", "Guest Ledger", "In-House Balances", ` +
  `"AR", or "Outstanding Accounts". Shows which guests currently OWE money.\n\n` +
  `Usually under "Front Desk", "Cashier", "Reports", or "Accounting". Each row ` +
  `is one folio/guest account.\n\n` +
  `Use these EXACT keys in your "columns" object:\n` +
  `  - pms_folio_id (required — the folio / account / bill unique id; use the ` +
  `reservation or confirmation # if that's what identifies the bill)\n` +
  `  - guest_name (optional)\n` +
  `  - room_number (optional)\n` +
  `  - balance_cents (optional — the amount owed now; a credit may be negative)\n` +
  `  - deposit_cents (optional — any deposit on file)\n` +
  `  - folio_status (optional — e.g. open / settled, copied verbatim)`;

const PAYMENTS_DAILY_GOAL =
  `Find TODAY'S PAYMENTS / CASHIER / DEPOSIT summary — sometimes called ` +
  `"Cashier Report", "Payments", "Collections", "Deposits", "Shift Report", or ` +
  `part of "Night Audit". Shows how much was COLLECTED today, ideally split by ` +
  `tender (cash vs card).\n\n` +
  `Usually under "Cashier", "Night Audit", "Reports", or "Front Desk". This is ` +
  `usually a SUMMARY (one set of totals for the day), not a per-guest list.\n\n` +
  `Use these EXACT keys in your "columns" object:\n` +
  `  - business_date (required — the date these totals are for)\n` +
  `  - cash_collected_cents (optional)\n` +
  `  - card_collected_cents (optional)\n` +
  `  - deposits_collected_cents (optional)\n` +
  `  - total_collected_cents (optional — total collected today, all tenders)`;

const FUTURE_BOOKINGS_GOAL =
  `Find the ON-THE-BOOKS / FUTURE RESERVATIONS list — reservations whose ` +
  `arrival date is in the FUTURE (not today). Sometimes called "Reservations", ` +
  `"On the Books", "Booking Pace", or "Arrivals" with a future date range. We ` +
  `want UPCOMING bookings to see how full future dates are.\n\n` +
  `If you can pick a date range, choose upcoming dates (the next few weeks). ` +
  `Usually under "Reservations" or "Front Desk". Each row is one reservation.\n\n` +
  `Use these EXACT keys in your "columns" object:\n` +
  `  - pms_reservation_id (required — the reservation's unique id / confirmation #)\n` +
  `  - arrival_date (required)\n` +
  `  - departure_date (optional)\n` +
  `  - guest_name (optional)\n` +
  `  - room_type (optional)\n` +
  `  - status (optional — copied verbatim)`;

const NO_SHOWS_GOAL =
  `Find the NO-SHOWS list — reservations that were expected but never checked ` +
  `in (usually for LAST NIGHT / the most recent business day). Sometimes called ` +
  `"No Shows", "No-Show Report", or a "No Show" status in a reservations / ` +
  `night-audit report.\n\n` +
  `Usually under "Night Audit", "Reports", or "Front Desk".\n\n` +
  `Use these EXACT keys in your "columns" object:\n` +
  `  - pms_reservation_id (required — the reservation's unique id / confirmation #)\n` +
  `  - arrival_date (required — the date the guest was due to arrive)\n` +
  `  - guest_name (optional)\n` +
  `  - room_number (optional)`;

const CANCELLATIONS_GOAL =
  `Find the CANCELLATIONS list — reservations that were cancelled. Sometimes ` +
  `called "Cancellations", "Cancelled Reservations", "Cancel Report", or a ` +
  `"Cancelled" status in a reservations report.\n\n` +
  `Usually under "Reports", "Reservations", or "Night Audit".\n\n` +
  `Use these EXACT keys in your "columns" object:\n` +
  `  - pms_reservation_id (required — the reservation's unique id / confirmation #)\n` +
  `  - cancelled_date (required — the date the reservation was cancelled)\n` +
  `  - guest_name (optional)\n` +
  `  - arrival_date (optional — the date they were due to arrive)\n` +
  `  - reason (optional — cancellation reason if shown)`;

// ─── TARGETS — the full Plan v7 mapper catalogue ──────────────────────────
// Ordered by business priority. Top entries run first so that even on a
// global-cap abort the partial recipe still contains the most valuable
// tables. Each entry's classification drives per-target step + cost budgets
// (see TARGET_BUDGET_MICROS + TARGET_STEP_CAPS).

TARGETS = [
  // Tier 1 — core operational data (required for any hotel to be useful).
  {
    key: 'getRoomStatus',
    goal: HOUSEKEEPING_GOAL,
    // Descriptor-aligned snake_case keys (pms_room_status_log). changed_at is
    // required but timestamptz → writer-stamped, so not learned. See
    // target-contract.ts.
    requiredFields: requiredLearnedFor('getRoomStatus'),
    classification: 'list_page',
    optional: false,
    progressLabel: 'Finding the daily housekeeping report…',
    progressPct: 40,
  },
  {
    key: 'getArrivals',
    goal: ARRIVALS_GOAL,
    // Descriptor-aligned snake_case keys (pms_reservations natural key +
    // required cols). See target-contract.ts.
    requiredFields: requiredLearnedFor('getArrivals'),
    classification: 'list_page',
    optional: false,
    progressLabel: "Finding today's arrivals…",
    progressPct: 44,
  },
  {
    key: 'getDepartures',
    goal: DEPARTURES_GOAL,
    // Same table as arrivals (pms_reservations). See target-contract.ts.
    requiredFields: requiredLearnedFor('getDepartures'),
    classification: 'list_page',
    optional: false,
    progressLabel: "Finding today's departures…",
    progressPct: 48,
  },
  {
    key: 'getWorkOrders',
    goal: WORK_ORDERS_GOAL,
    // Already snake_case pre-fix; routed through the contract so all 4 core
    // feeds share one source of truth. See target-contract.ts.
    requiredFields: requiredLearnedFor('getWorkOrders'),
    classification: 'list_page',
    optional: false,
    progressLabel: 'Finding maintenance + work orders…',
    progressPct: 52,
  },

  // Tier 2 — business-critical net-new (revenue / rates / channels).
  // Auto-promotion needs ≥3 of these to clear the gate (plan v7).
  {
    key: 'getRevenueDaily',
    goal: REVENUE_DAILY_GOAL,
    requiredFields: ['date', 'rooms_revenue_cents', 'occupied_rooms', 'adr_cents'],
    classification: 'report_menu',
    optional: true,        // franchise tiers may not expose this
    progressLabel: 'Finding the daily revenue summary…',
    progressPct: 56,
  },
  {
    key: 'getRatesAndInventory',
    goal: RATES_AND_INVENTORY_GOAL,
    requiredFields: ['date', 'room_type', 'rate_plan', 'rate_amount_cents'],
    classification: 'report_menu',
    optional: true,
    progressLabel: 'Finding rate plans + available inventory…',
    progressPct: 60,
  },
  {
    key: 'getChannelPerformance',
    goal: CHANNEL_PERFORMANCE_GOAL,
    requiredFields: ['date', 'channel', 'bookings_count', 'revenue_cents'],
    classification: 'report_menu',
    optional: true,
    progressLabel: 'Finding the booking-channel breakdown…',
    progressPct: 64,
  },

  // Tier 3 — drill-down + supplementary data.
  {
    key: 'getGuests',
    goal: GUESTS_GOAL,
    requiredFields: ['pms_guest_id', 'name'],
    classification: 'drilldown_sample',
    optional: false,       // guest data is too valuable to skip
    progressLabel: 'Drilling into guest profiles…',
    progressPct: 68,
  },
  // getStaffRoster removed in v8 Phase D.1 — no pms_staff_roster table in
  // the v4 schema and the runtime had no writer for it. Was Tier-3 legacy.

  // Tier 4 — nice-to-have (forecast, groups, lost & found, audit log).
  {
    key: 'getForecastDaily',
    goal: FORECAST_DAILY_GOAL,
    requiredFields: ['forecast_date', 'snapshot_date', 'projected_occupancy_pct'],
    classification: 'report_menu',
    optional: true,
    progressLabel: 'Looking for the occupancy/revenue forecast…',
    progressPct: 76,
  },
  {
    key: 'getGroupsAndBlocks',
    goal: GROUPS_AND_BLOCKS_GOAL,
    requiredFields: ['pms_group_id', 'group_name', 'block_start_date', 'rooms_blocked'],
    classification: 'report_menu',
    optional: true,
    progressLabel: 'Finding group bookings + blocks…',
    progressPct: 80,
  },
  {
    key: 'getLostAndFound',
    goal: LOST_AND_FOUND_GOAL,
    requiredFields: ['item_description', 'location_found', 'found_at', 'status'],
    classification: 'drilldown_sample',
    optional: true,
    progressLabel: 'Finding the lost-and-found log…',
    progressPct: 83,
  },
  {
    key: 'getActivityLog',
    goal: ACTIVITY_LOG_GOAL,
    requiredFields: ['captured_at', 'pms_user', 'action'],
    classification: 'drilldown_sample',
    optional: true,        // admin-only on most PMSes
    progressLabel: 'Looking for the audit / activity log…',
    progressPct: 86,
  },

  // Tier 5 — feat/pms-universal-translate: money + future-booking feeds. All
  // optional (never gate promotion / never regress the core feeds). Their
  // values translate via the UNIVERSAL generic parsers (target-contract
  // TARGET_VALUE_CONTRACTS routes their date/_cents columns automatically).
  {
    key: 'getGuestBalances',
    goal: GUEST_BALANCES_GOAL,
    requiredFields: ['pms_folio_id'],
    classification: 'list_page',
    optional: true,
    progressLabel: 'Finding guest balances / who owes…',
    progressPct: 88,
  },
  {
    key: 'getPaymentsDaily',
    goal: PAYMENTS_DAILY_GOAL,
    requiredFields: ['business_date'],
    classification: 'report_menu',
    optional: true,
    progressLabel: "Finding today's payments / cashier totals…",
    progressPct: 90,
  },
  {
    key: 'getFutureBookings',
    goal: FUTURE_BOOKINGS_GOAL,
    requiredFields: ['pms_reservation_id', 'arrival_date'],
    classification: 'list_page',
    optional: true,
    progressLabel: 'Finding upcoming reservations (booking pace)…',
    progressPct: 92,
  },
  {
    key: 'getNoShows',
    goal: NO_SHOWS_GOAL,
    requiredFields: ['pms_reservation_id', 'arrival_date'],
    classification: 'report_menu',
    optional: true,
    progressLabel: 'Finding last night’s no-shows…',
    progressPct: 94,
  },
  {
    key: 'getCancellations',
    goal: CANCELLATIONS_GOAL,
    requiredFields: ['pms_reservation_id', 'cancelled_date'],
    classification: 'report_menu',
    optional: true,
    progressLabel: 'Finding cancelled reservations…',
    progressPct: 96,
  },
];
