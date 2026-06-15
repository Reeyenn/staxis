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
import { clearSetOfMark } from './set-of-mark.js';
import { requestHelp, checkHelpFlood, saveScreenshotToStorage, type HelpActionType } from './human-assist.js';
import type { TakeoverController } from './takeover.js';
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
import type { PMSCredentials, PMSType, Recipe, RecipeStep, LoginSteps, ActionRecipe, ApiHint, TableRowHint, TieredSelector, BoardPreview, BoardTargetDescriptor, BoardTargetState } from './types.js';
import { inferUrlTemplate, mapPlaceholdersToColumns, templateFromSample, substituteTemplate } from './url-template.js';
import { requiredLearnedFor, missingRequiredColumns, MAX_COMPLETENESS_REASKS, TARGET_VALUE_CONTRACTS, CORE_TARGET_CONTRACTS, coreTargetSharesRequiredSchema } from './target-contract.js';
import { shouldNudgeCommit, buildCommitNudge, COMMIT_DITHER_TURNS, type TabularSummary } from './commit-signal.js';
import {
  auditRequiredColumns,
  gateRecoveredColumn,
  certifyColumns,
  buildRecoveryHint,
  learnedForGate,
  expectedShapeFor,
  isBetterCandidate,
  VALUE_PROBE_ROW_CAP,
  DEADNESS_ROW_CAP,
  RECOVERY_DRILL_STEP_CAP,
  RECOVERY_DRILL_COST_CAP_MICROS,
  DETAIL_PER_POLL_MAX,
  type RecoveryProblem,
  type ColumnProofCarrier,
} from './column-recovery.js';
import {
  extractDomRows,
  extractDetailFields,
  readTableHeaders,
  headerGateOk,
  parseFirstNthIndex,
  type CapturedTableHeaders,
} from './extractors/dom-rows.js';
import { attachNetworkCapture, type NetworkCaptureHandle, type CapturedCall } from './network-capture.js';
import {
  chooseConsensusProposal,
  type DiscoveryProposalShape,
} from './proposal-entropy.js';
import {
  DISCOVERY_KEY_COLUMNS,
  DISCOVERY_SEMANTIC_DATE_COLUMNS,
  MIN_ORACLE_ROWS,
  MAX_ORACLE_ROWS,
  prefilterCandidates,
  extractRowsAtPath,
  findEnvelopeDecoy,
  projectRows,
  reconcileRows,
  sanitizeHeaders,
  checkDateParams,
  renderTemplateAtDate,
  isoAddDays,
  parseIsoDate,
  parseTextualDate,
  numericDateInterpretations,
  sameRegistrableDomain,
} from './oracle-verify.js';
import { inferDateFormat, sanitizeEnumMapping, mergeValueTranslation, pickDateFormat } from './value-learning.js';
import type { LearnedValueTranslations, LearnedDateFormat } from './types.js';
import {
  createPruneState,
  maybePruneHistory,
} from './history-pruning.js';

const MAX_AGENT_STEPS_LOGIN = 60;
// fix/cua-login-universal — how many times we let the agent re-claim
// "logged in" while the universal confirmation gate (isLoginConfirmed) still
// rejects it (credential form still up, or an MFA/one-time-code page). Past
// this we stop the churn and surface a clean failure instead of burning the
// whole login step budget. Kept small on purpose: the old behaviour retried a
// brittle visible-dashboard-selector probe ~7× (full vision round-trip + 3s
// timeout each), which is exactly the ~4-minute hang this change removes.
const MAX_LOGIN_CONFIRM_RETRIES = 2;
// Higher cap for per-action mapping — action 4 (staff) is buried in
// admin menus on most PMSes and needs more exploration than login.
const MAX_AGENT_STEPS_PER_ACTION = 80;
// Plan v10 (FIX 1) — deliberate-backtrack budget for the per-target agent loops.
// The navigation prompt tells the agent, when a click lands on the wrong page, to
// return to the dashboard and try a DIFFERENT (sibling) link — the guidance that
// first located the departures feed, so it must stay. But each return re-runs the
// "screenshot the dashboard" step, re-accumulating identical (screenshot,
// dashboard) tuples until the action-loop detector trips and a healthy retry
// becomes a hard "loop detector tripped" feed failure (room status today). We
// reset the loop detector on each DELIBERATE return so a fresh exploration leg
// starts clean, and cap the number of returns so the bounce can't run forever.
// 5 sits comfortably above the prompt's "return at least twice" floor, preserving
// the departures win; the per-target step/cost/wallclock caps remain the hard
// backstops, so a generous return budget is effectively free.
const MAX_DASHBOARD_RETURNS = 5;
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
 *   - { kind: 'continue', hintText, supervisorClick?, waitedMs }
 *       → caller rewinds messages, pushes user-turn hint, re-enters loop.
 *         When `supervisorClick` is set (admin answered 'takeover' by
 *         clicking on the help screenshot), the caller FIRST executes that
 *         click through executeVisionAction so it's recorded as a recipe
 *         step like any agent click (replay must include the founder's
 *         hop), then continues. `waitedMs` is the admin-wait time the
 *         caller credits back to its phase wallclock budget.
 *   - { kind: 'mark_unavailable', reason, viaAdmin? } → caller returns
 *         ActionMapFailure. `viaAdmin` distinguishes "an admin explicitly
 *         said this PMS doesn't have it" from "nobody answered" so the
 *         Learning Board can show unavailable vs failed without string
 *         matching.
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
  | { kind: 'continue'; hintText: string; supervisorClick?: { x: number; y: number }; waitedMs: number }
  | { kind: 'mark_unavailable'; reason: string; viaAdmin?: boolean }
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
  // Clear leftover Set-of-Mark badges first — the agent's last screenshot
  // leaves numbered circles painted on the page, and the founder would see
  // (and might aim at) them. Best-effort.
  await clearSetOfMark(args.page).catch(() => {});
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

  const waitStartedAt = Date.now();
  const help = await requestHelp({
    jobId: args.jobId,
    targetKey: args.targetKey,
    question: `Stuck on ${args.targetKey}: ${args.agentReason.slice(0, 200)}`,
    screenshotStoragePath: screenshotPath,
    scroll,
    viewport: { w: VIEWPORT.width, h: VIEWPORT.height },
    signal: args.signal ?? new AbortController().signal,
  });
  const waitedMs = Date.now() - waitStartedAt;

  switch (help.actionType as HelpActionType) {
    case 'guidance':
      return {
        kind: 'continue',
        hintText: help.responseText ?? '(admin provided guidance but no text)',
        waitedMs,
      };
    case 'unavailable':
      return {
        kind: 'mark_unavailable',
        reason: `unavailable: ${help.responseText ?? 'admin marked'}`,
        // Only an explicit admin answer means "this PMS really doesn't have
        // it" — timeout / no-admin / abort resolve as 'unavailable' too but
        // must not be presented as a verified PMS limitation.
        viaAdmin: help.source === 'admin_answered',
      };
    case 'takeover': {
      // Phase B chunk 2 — the admin clicked a spot on the help screenshot.
      // Validate against the capture viewport; the CALLER executes the
      // click (it owns recordedSteps) and re-enters the loop.
      const coord = validateSupervisorCoordinate(help.responseCoordinate);
      if (!coord) {
        log.warn('mapper: takeover answer had a missing/out-of-bounds coordinate — marking unavailable', {
          jobId: args.jobId, targetKey: args.targetKey, coordinate: help.responseCoordinate ?? null,
        });
        return { kind: 'mark_unavailable', reason: 'takeover requested with invalid coordinate' };
      }
      return {
        kind: 'continue',
        hintText: typeof help.responseText === 'string' ? help.responseText : '',
        supervisorClick: coord,
        waitedMs,
      };
    }
    case 'abort':
      return { kind: 'abort', reason: 'admin_aborted' };
  }
}

/**
 * Validate an admin-supplied takeover coordinate against the mapper's fixed
 * capture viewport (the screenshot the admin clicked was a viewport-sized,
 * fullPage:false capture, so click coords are viewport CSS pixels).
 * Exported for tests. Mirrors the route-side check in
 * /api/admin/mapper/assist — keep the two in sync.
 */
export function validateSupervisorCoordinate(
  raw: unknown,
): { x: number; y: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { x, y } = raw as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || xi >= VIEWPORT.width || yi < 0 || yi >= VIEWPORT.height) return null;
  return { x: xi, y: yi };
}

/**
 * Execute the founder's takeover click and compose the hint the agent sees.
 * The click goes through executeVisionAction — the SAME path as an agent
 * click — so it gets selector inference and is recorded as a recipe step
 * (the learned recipe must replay the founder's hop, or replays land on the
 * wrong page). Returns the recorded step (caller pushes it onto its
 * recordedSteps) and the supervisor hint text. Never throws: on execution
 * failure the hint degrades to "click there yourself".
 */
async function executeSupervisorClick(args: {
  page: Page;
  credentials: PMSCredentials;
  click: { x: number; y: number };
  adminNote: string;
  jobId: string | null;
  targetKey: string;
}): Promise<{ recordedStep?: RecipeStep; hintText: string }> {
  const trimmedNote = args.adminNote.trim();
  // The assist route writes 'Supervisor clicked on the screen' into
  // response_text when the founder sent a click with no note — display copy
  // for the history list, not an instruction; don't echo it to the agent.
  const note = trimmedNote.length > 0 && trimmedNote !== 'Supervisor clicked on the screen'
    ? ` They also said: "${trimmedNote}".`
    : '';
  const pointingHint =
    `Click at coordinate (${args.click.x}, ${args.click.y}) — I pointed at that exact spot ` +
    `on the screen you showed me; my remote click did not execute, so perform it yourself.${note}`;
  try {
    const exec = await executeVisionAction(
      args.page,
      { action: 'left_click', coordinate: [args.click.x, args.click.y] },
      args.credentials,
      'action',
    );
    // executeVisionAction never throws — real failures (viewport drift,
    // element gone, Playwright errors) come back as {isError:true}. Telling
    // the agent "the click was performed" on that path would be a false
    // statement against an unchanged page.
    if (exec.isError) {
      log.warn('mapper: supervisor takeover click reported an error — degrading to a pointing hint', {
        jobId: args.jobId ?? undefined, targetKey: args.targetKey,
        output: exec.output.slice(0, 200),
      });
      return { hintText: pointingHint };
    }
    // Let any resulting navigation/render settle before the agent re-reads.
    await args.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await args.page.waitForTimeout(800);
    log.info('mapper: supervisor takeover click executed', {
      jobId: args.jobId ?? undefined, targetKey: args.targetKey,
      x: args.click.x, y: args.click.y, recorded: Boolean(exec.recordedStep),
    });
    return {
      recordedStep: exec.recordedStep,
      hintText:
        `I just clicked at (${args.click.x}, ${args.click.y}) on the screen you showed me — ` +
        `that click has been performed in your browser and the page may have changed.${note} ` +
        `Read the page you are on NOW and continue from here.`,
    };
  } catch (err) {
    log.warn('mapper: supervisor takeover click failed — degrading to a pointing hint', {
      err: (err as Error).message, jobId: args.jobId ?? undefined, targetKey: args.targetKey,
    });
    return { hintText: pointingHint };
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

// Plan v10 (FIX 2) — optional feeds get a TIGHTER cost + step budget than the
// required (promotion-gating) feeds. A nice-to-have (cancellations, no-shows,
// lost & found, …) must not out-spend the core feeds grinding report / drill-down
// menus for data the hotel may not even use — in the last live run the optional
// report-menu feeds together cost more than all four core feeds combined. We
// scale the by-classification budget down by a flat fraction for OPTIONAL targets
// only; required feeds (and any legacy caller that can't prove optionality) keep
// the full budget, so this can NEVER starve a promotion-gating feed. Keyed purely
// off the optional flag — zero PMS-specific logic.
const OPTIONAL_BUDGET_FRACTION = 0.5;
const MIN_OPTIONAL_STEP_CAP = 12; // floor so the fraction can't make a feed un-mappable

type TargetClassification = 'list_page' | 'report_menu' | 'drilldown_sample';

/**
 * Per-target step + cost caps, tightened for OPTIONAL feeds (FIX 2). `optional`
 * MUST be a definite boolean derived from MapperTarget.optional: only an explicit
 * `true` tightens, so a required feed — or any legacy caller that passes `false`
 * via `required === false` being unproven — keeps the full by-classification
 * budget. Unknown classifications fall back to the same defaults the call sites
 * used before (full step cap, infinite cost cap), and an infinite cost cap is
 * never scaled (no NaN). Exported for unit tests.
 */
export function targetBudget(
  classification: TargetClassification,
  optional: boolean,
): { stepCap: number; costCapMicros: number } {
  const baseStep = TARGET_STEP_CAPS[classification] ?? MAX_AGENT_STEPS_PER_ACTION;
  const baseCost = TARGET_BUDGET_MICROS[classification] ?? Number.POSITIVE_INFINITY;
  if (!optional) return { stepCap: baseStep, costCapMicros: baseCost };
  return {
    stepCap: Math.max(MIN_OPTIONAL_STEP_CAP, Math.floor(baseStep * OPTIONAL_BUDGET_FRACTION)),
    costCapMicros: Number.isFinite(baseCost)
      ? Math.floor(baseCost * OPTIONAL_BUDGET_FRACTION)
      : baseCost,
  };
}
// (Plan v9 trialed a REQUIRED_TARGET_BUDGET_MULTIPLIER here — a bigger per-target
// budget for the 4 required feeds. Reverted 2026-06-11: the two live runs proved
// departures is a FINDABILITY problem, not a budget one — the multiplier never
// cracked it and only inflated the cost of a feed that was already lost (~$14 /
// 82 min). The real levers are the navigation-guidance prompt below + the
// human-assist takeover. `MapActionArgs.required` is KEPT — the prompt still uses
// it to tell the model a feed is essential, just without inflating its budget.)

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
  /**
   * feature/cua-live-view — continuous Learning Board live view. Called
   * with each vision screenshot the agent takes (`exec.screenshotB64` —
   * ALREADY privacy-hardened by captureHardenedScreenshot; see
   * live-frame.ts PRIVACY CONTRACT). Implementations must be synchronous
   * fire-and-forget and never throw; the mapper does not await them.
   */
  onLiveFrame?: (pngBase64: string) => void;
  /**
   * feature/cua-live-assist — founder-initiated, robot-paused takeover.
   * When set, mapActionCore polls it at the top of each step; on an open
   * takeover the founder drives the page click-by-click (Finish/Cancel/Skip).
   * Absent (dev/test/no-board runs) → the agent loop runs untouched.
   */
  takeover?: TakeoverController;
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
  /**
   * feature/cua-coverage-editor — single-target ALLOWLIST. When set, the
   * per-target loop maps ONLY these keys (in addition to the seedActions skip),
   * so the coverage editor's "edit one feed" / "add one feed" runs learn EXACTLY
   * the requested feed instead of hunting every unlearned catalogue target.
   * Without it (the default), an absent-target seeded job would grind the whole
   * catalogue (repair-feed's documented over-hunt). Undefined = today's
   * behaviour (map every un-seeded target). Empty array = map nothing.
   */
  onlyTargets?: string[];
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
 * Learning Board sibling of loadPriorActions — reload per-feed board state
 * persisted by a prior attempt of this job, so a reclaim doesn't wipe found
 * feeds off the admin board. Same graceful degradation: {} on any failure.
 */
async function loadPriorBoardTargets(
  jobId: string | null | undefined,
): Promise<Record<string, BoardTargetState>> {
  if (!jobId) return {};
  const { data, error } = await supabase
    .from('workflow_jobs')
    .select('result')
    .eq('id', jobId)
    .maybeSingle();
  if (error || !data) return {};
  const result = data.result as { boardTargets?: Record<string, BoardTargetState> } | null;
  return result?.boardTargets ?? {};
}

/**
 * Merge a patch into workflow_jobs.result via a two-step select-then-merge
 * (PostgREST jsonb_set RPC isn't worth the indirection for a small object
 * updated once per target). NOT atomic — safe because the mapper is the
 * only mid-run result writer (cost-cap updates touch a separate column;
 * the runtime touches result only at completion). A zombie attempt
 * surviving past reclaim would be last-write-wins — pre-existing runtime
 * gap, unchanged here. Best-effort: callers treat failure as non-fatal.
 */
async function mergeJobResult(
  jobId: string | null | undefined,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!jobId) return;
  const { data: row, error: selErr } = await supabase
    .from('workflow_jobs')
    .select('result')
    .eq('id', jobId)
    .maybeSingle();
  if (selErr || !row) return;
  const existingResult = (row.result as Record<string, unknown>) ?? {};
  const newResult = { ...existingResult, ...patch };
  await supabase.from('workflow_jobs').update({ result: newResult }).eq('id', jobId);
}

/**
 * Flag (or clear) "this learning run is parked on a 2FA screen waiting
 * for a code" on the job row. The admin Launch Bay panel polls
 * /api/admin/onboarding-detail every 5s and renders a code-entry box
 * while this flag is set, so Reeyen can type in a code that the PMS
 * texted to his phone. Goes through mergeJobResult — never clobbers
 * actionsSoFar / boardTargets / targetCatalog.
 */
async function setAwaitingMfa(
  jobId: string | null | undefined,
  awaiting: boolean,
): Promise<void> {
  await mergeJobResult(jobId, {
    awaiting_2fa: awaiting ? { since: new Date().toISOString() } : null,
  });
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
  | {
      ok: true;
      recipe: Recipe;
      /** Learning Board — final per-feed state + catalogue. The workflow
       *  runtime REPLACES workflow_jobs.result at completion (markCompleted),
       *  so these must ride the handler result chain (mapping-driver →
       *  index.ts adapter) or the board blanks the moment a run succeeds. */
      targetCatalog: BoardTargetDescriptor[];
      boardTargets: Record<string, BoardTargetState>;
    }
  | { ok: false; userMessage: string; detail: Record<string, unknown> };

export async function mapPMS(opts: MapperOptions): Promise<MapperResult> {
  let browser: Browser | null = null;

  // ── CUA Learning Board — feed catalogue ───────────────────────────────
  // Written to workflow_jobs.result immediately (before login even starts)
  // so the admin board can render every feed as "waiting in line" while the
  // robot logs in. Pure description of the generic TARGETS list — no PMS-
  // specific content. Best-effort: board writes never fail a mapping run.
  const targetCatalog: BoardTargetDescriptor[] = TARGETS.map((t) => ({
    key: t.key,
    label: t.progressLabel,
    goal: t.goal,
    optional: t.optional,
    // feature/cua-live-assist — the board disables Take over / Skip for
    // drilldown_sample feeds (mapDrillDownAction has no takeover gate in v1).
    classification: t.classification,
  }));
  await mergeJobResult(opts.jobId, { targetCatalog }).catch((err) => {
    log.warn('mapper: board catalog persist failed (non-fatal)', {
      jobId: opts.jobId ?? undefined, err: (err as Error).message,
    });
  });

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
      onLiveFrame: opts.onLiveFrame,
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

    // ── CUA Learning Board — per-feed state ──────────────────────────────
    // Seeded from any prior attempt (reclaim) so found feeds never vanish
    // from the board across worker restarts, and from repair seeds (the
    // skipped targets below would otherwise never appear). A dead attempt's
    // dangling 'searching' is dropped — this attempt re-runs that target,
    // and if it budget-breaks first the feed must read "waiting", not stay
    // an immortal spinner.
    const boardTargets: Record<string, BoardTargetState> = await loadPriorBoardTargets(opts.jobId);
    for (const [key, st] of Object.entries(boardTargets)) {
      if (st.status === 'searching') delete boardTargets[key];
    }
    for (const key of Object.keys(actions)) {
      const existing = boardTargets[key];
      if (!existing || existing.status !== 'found') {
        boardTargets[key] = { status: 'found', carried: true, finishedAt: new Date().toISOString() };
      }
    }
    await mergeJobResult(opts.jobId, { boardTargets }).catch((err) => {
      log.warn('mapper: board seed persist failed (non-fatal)', {
        jobId: opts.jobId ?? undefined, err: (err as Error).message,
      });
    });

    // feat/pms-universal-translate — accumulate self-learned VALUE translation
    // across targets: enum vocabularies keyed by `${table}.${column}`, and a
    // pool of raw date samples (one PMS = one date format, so pooling across
    // every date column maximizes the chance of seeing a disambiguating >12
    // token and learning the order with high confidence). On a partial repair,
    // SEED from the prior recipe so the skipped targets' translation survives.
    const learnedValueTranslations: LearnedValueTranslations = { ...(opts.seedValueTranslations ?? {}) };
    const learnedDateSamples: string[] = [];

    // feature/cua-coverage-editor — single-target allowlist. null = no
    // restriction (today's behaviour). A Set so the loop check is O(1).
    const onlyTargets = opts.onlyTargets ? new Set(opts.onlyTargets) : null;
    if (onlyTargets) {
      log.info('mapper: single-target mode — mapping only the requested feed(s)', {
        jobId: opts.jobId ?? undefined, onlyTargets: [...onlyTargets],
      });
    }

    for (const target of TARGETS) {
      // Skip targets already mapped in a prior attempt (B6 reclaim path).
      if (actions[target.key]) {
        log.info('mapper: skipping target — already completed in prior attempt', {
          jobId: opts.jobId ?? undefined, actionName: target.key,
        });
        continue;
      }
      // feature/cua-coverage-editor — when an allowlist is set, map only those
      // targets. Skipped targets aren't touched (no board 'searching' churn).
      if (onlyTargets && !onlyTargets.has(target.key)) {
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
      // Learning Board — mark searching only AFTER the budget check above:
      // a budget break must leave unreached feeds as "waiting in line",
      // never strand a phantom spinner.
      boardTargets[target.key] = { status: 'searching', startedAt: new Date().toISOString() };
      await mergeJobResult(opts.jobId, { boardTargets }).catch(() => {});
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
            required: !target.optional,
            postLoginUrl,
            credentials: opts.credentials,
            propertyId: opts.propertyId ?? null,
            jobId: opts.jobId ?? null,
            signal: opts.signal,
            model,
            jobCostCapMicros: opts.jobCostCapMicros,
            onLiveFrame: opts.onLiveFrame,
          })
        : await mapAction({
            page,
            actionName: target.key,
            goal: target.goal,
            requiredFields: target.requiredFields,
            classification: target.classification,
            required: !target.optional,
            postLoginUrl,
            credentials: opts.credentials,
            propertyId: opts.propertyId ?? null,
            jobId: opts.jobId ?? null,
            signal: opts.signal,
            model,
            jobCostCapMicros: opts.jobCostCapMicros,
            // feature/cua-column-recovery — the date order learned from
            // earlier targets this run (plus any repair seed), so the
            // recovery value-gate parses candidate dates exactly like the
            // runtime eventually will.
            provisionalDateFormat: pickDateFormat(inferDateFormat(learnedDateSamples), opts.seedDateFormat),
            onLiveFrame: opts.onLiveFrame,
            // feature/cua-live-assist — founder takeover gate (list/report
            // feeds). Drill-down feeds use mapDrillDownAction (no gate in v1).
            takeover: opts.takeover,
          });
      if (result.ok) {
        actions[target.key] = result.action;
        // feat/pms-universal-translate — fold this target's observed values
        // into the running learned-translation accumulators (sanitized against
        // the descriptor's canonical sets).
        accumulateLearnedValues(target.key, result, learnedValueTranslations, learnedDateSamples);
        const startedAt = boardTargets[target.key]?.startedAt;
        boardTargets[target.key] = {
          status: 'found',
          ...(startedAt ? { startedAt } : {}),
          finishedAt: new Date().toISOString(),
          ...(result.boardPreview ? { preview: result.boardPreview } : {}),
        };
        // Plan v8 B6 — persist after each successful target so a crash
        // doesn't lose the work. Board state rides the same single UPDATE.
        // Best-effort: on persist failure, keep running (the next target
        // will retry the persist with both).
        await mergeJobResult(opts.jobId, { actionsSoFar: actions, boardTargets }).catch((err) => {
          log.warn('mapper: target progress persist failed (non-fatal)', {
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
        const startedAt = boardTargets[target.key]?.startedAt;
        boardTargets[target.key] = {
          // `unavailable` is the structured agent/admin declaration — the
          // board renders it "not available in this PMS" vs plain "couldn't
          // find it". No string matching on reason text.
          status: result.unavailable ? 'unavailable' : 'failed',
          ...(startedAt ? { startedAt } : {}),
          finishedAt: new Date().toISOString(),
          reason: result.reason.slice(0, 300),
        };
        await mergeJobResult(opts.jobId, { boardTargets }).catch(() => {});
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
    return { ok: true, recipe, targetCatalog, boardTargets };
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

/**
 * fix/cua-login-universal — the universal, PMS-neutral test for "the login
 * actually completed", used to accept a model `{loggedIn:true}` claim.
 *
 * Deliberately does NOT require a visible dashboard CSS selector. Dashboards
 * render in iframes / canvas / shadow DOM, and some PMS keep the post-login
 * URL identical to the login-action URL — so probing a named selector's
 * visibility is unreliable across families and caused a ~4-minute confirmation
 * loop (full vision round-trip + 3s isVisible per wrong guess, retried ~7×).
 *
 * Instead we accept when ALL of:
 *  - `onPmsDomain`        — still on the PMS registrable domain (off-domain =
 *                           a failed/redirected nav; rejected separately with a
 *                           distinct error). Reuses sameRegistrableDomain so
 *                           ccTLDs (co.uk, com.au, …) bucket correctly.
 *  - `credentialsSubmitted` — the agent actually typed the password this run.
 *                           This is the positive corroborator that "no login
 *                           form on screen" needs: without it, a pre-password
 *                           screen (2-step username page, SSO chooser, splash)
 *                           — which also has no password field — would
 *                           false-accept. It's DOM-independent, so it holds for
 *                           iframe / shadow-DOM / canvas logins too.
 *  - `!loginFormVisible`  — the credential form is gone (no visible password
 *                           input, shadow DOM included). A re-rendered login
 *                           form means bad creds, not success.
 *  - `!mfaChallengeVisible` — not sitting on a one-time-code / MFA interstitial
 *                           (handled separately; never accepted as "logged in").
 *
 * Pure + exported so the truth table is unit-testable. Mirrors the runtime
 * replay confirmation in session-driver.ts (URL-moved + form-detached + MFA
 * re-check, with the success selector only a non-gating hint).
 */
export function isLoginConfirmed(signals: {
  onPmsDomain: boolean;
  credentialsSubmitted: boolean;
  loginFormVisible: boolean;
  mfaChallengeVisible: boolean;
}): boolean {
  return (
    signals.onPmsDomain &&
    signals.credentialsSubmitted &&
    !signals.loginFormVisible &&
    !signals.mfaChallengeVisible
  );
}

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
    /** feature/cua-live-view — see MapperOptions.onLiveFrame. */
    onLiveFrame?: (pngBase64: string) => void;
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
    `WHEN YOU'RE LOGGED IN — you've reached the main operational screen with ` +
    `property-specific data and/or a primary navigation menu. Depending on the ` +
    `PMS this may be a dashboard, a room rack, a reservations grid, an arrivals/` +
    `departures list, or a report/home menu — anything past the login and any ` +
    `welcome/property-picker screens, where the username/password fields are ` +
    `gone. Reply with JSON ONLY (no commentary):\n` +
    `  {"loggedIn": true, "dashboardSelector": "<a CSS selector for something ` +
    `only present after login, e.g. a nav container or menu link>"}\n` +
    `The selector is a best-effort hint, not a gate — if you can't name a good ` +
    `one, still report {"loggedIn": true}. Then stop.\n\n` +

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
    `8. If you land on an interstitial, splash, "welcome", or property-picker ` +
    `screen — anything that isn't the main operational screen yet — continue ` +
    `through it: select the property or click the primary "continue"/"enter"/` +
    `proceed action (if it's a list with no obvious primary, pick the first ` +
    `option) to reach the main operational screen.\n` +
    `9. Repeat screenshot + click as needed to reach the main operational ` +
    `screen.\n\n` +
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

  // fix/cua-login-universal — login-confirmation state.
  // credentialsSubmitted: flips true once the agent types the $password
  //   placeholder. The positive corroborator isLoginConfirmed() needs so that
  //   "no login form on screen" can't false-accept a pre-password page (2-step
  //   username screen, SSO chooser, splash). DOM-independent, so it holds for
  //   iframe / shadow-DOM / canvas logins where the form isn't queryable.
  // loginConfirmRetries: counts rejected `{loggedIn:true}` claims so we cap the
  //   re-confirm churn at MAX_LOGIN_CONFIRM_RETRIES instead of spinning.
  let credentialsSubmitted = false;
  let loginConfirmRetries = 0;

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
        // Sanity-check the page we landed on before trusting the claim. We've
        // seen the agent declare "loggedIn: true" while sitting on
        // chrome-error://chromewebdata after a nav timeout, on a re-rendered
        // login form (bad creds), or on an MFA interstitial. The OLD gate
        // required a *visible* dashboard CSS selector, which churned for ~4
        // minutes on PMS whose dashboard lives in an iframe / keeps the URL on
        // the login-action URL. Replace it with a universal, PMS-neutral gate
        // (isLoginConfirmed): on-domain + credentials-actually-submitted +
        // login-form-gone + not-MFA. The selector is now only a recorded hint.
        const currentUrl = page.url();
        const loginHost = (() => { try { return new URL(creds.loginUrl).host; } catch { return null; } })();
        const currentHost = (() => { try { return new URL(currentUrl).host; } catch { return null; } })();
        // sameRegistrableDomain handles multi-label ccTLDs (co.uk, com.au, …)
        // that a naive last-two-labels compare would mis-bucket. KEEP the
        // off-domain rejection — a post-login nav off the PMS domain (SSO bounce,
        // error redirect) is a real failure, surfaced with its distinct message.
        const onPmsDomain = Boolean(loginHost && currentHost && sameRegistrableDomain(currentHost, loginHost));
        if (!onPmsDomain) {
          log.warn('login claimed success but URL is off-domain', { currentUrl, loginUrl: creds.loginUrl });
          return {
            ok: false,
            userMessage: 'Login appeared to fail — the page navigated unexpectedly. Please double-check your credentials and login URL.',
            detail: { phase: 'login_mapping', currentUrl, loginUrl: creds.loginUrl, reason: 'post_login_off_domain' },
          };
        }

        // Universal confirmation signals (PMS-neutral, no selector visibility).
        const loginFormVisible = await loginFormPresent(page);
        const mfaChallengeVisible = await detectMfaScreen(page);

        if (isLoginConfirmed({ onPmsDomain, credentialsSubmitted, loginFormVisible, mfaChallengeVisible })) {
          // Confirmed. Record the model's dashboardSelector as a NON-GATING
          // hint (drop 'body'/'html'/'' — they match the login page too, so
          // they're no evidence and pollute the recipe). We do NOT require it
          // to be visible; a best-effort 1s probe (down from 3s) only enriches
          // the log so selector quality stays observable. session-driver and
          // recipe-runner treat successSelectors as a secondary hint and
          // tolerate an empty list (they skip / filter it).
          const successSelector = typeof parsed.dashboardSelector === 'string' ? parsed.dashboardSelector : '';
          const trivialSelector = successSelector === '' || successSelector === 'body' || successSelector === 'html';
          let selectorVisible = false;
          if (!trivialSelector) {
            selectorVisible = await page
              .locator(successSelector)
              .first()
              .isVisible({ timeout: 1000 })
              .catch(() => false);
          }
          log.info('login confirmed by universal gate', {
            jobId: ctx.jobId ?? undefined, stepIdx, currentUrl,
            dashboardSelector: trivialSelector ? null : successSelector,
            selectorVisible, recorded: !trivialSelector,
          });
          return {
            ok: true,
            steps: {
              startUrl: creds.loginUrl,
              steps: recordedSteps,
              successSelectors: trivialSelector ? [] : [successSelector],
              timeoutMs: 30_000,
            },
          };
        }

        // Not confirmed. Figure out why so the hint + the log are specific, and
        // cap the re-confirm churn (the agent re-claiming "logged in" while the
        // gate still rejects) instead of burning the whole step budget.
        const rejectReason = !credentialsSubmitted
          ? 'credentials_not_submitted'
          : mfaChallengeVisible
            ? 'mfa_screen'
            : loginFormVisible
              ? 'login_form_present'
              : 'unconfirmed';
        loginConfirmRetries += 1;
        log.warn('login claim not confirmed by universal gate', {
          jobId: ctx.jobId ?? undefined, stepIdx, reason: rejectReason,
          currentUrl, credentialsSubmitted, loginFormVisible, mfaChallengeVisible,
          attempt: loginConfirmRetries,
        });
        if (loginConfirmRetries > MAX_LOGIN_CONFIRM_RETRIES) {
          return {
            ok: false,
            userMessage:
              "We couldn't confirm the login finished. Please double-check your username, password, " +
              'and login URL, or contact support.',
            detail: {
              phase: 'login_mapping', reason: 'login_unconfirmed',
              rejectReason, currentUrl,
            },
          };
        }
        const hint =
          rejectReason === 'mfa_screen'
            ? "That looks like a one-time verification / security-code screen, not the logged-in app. Complete it, then continue."
            : rejectReason === 'login_form_present'
              ? "A username/password field is still on screen, so you're not logged in yet. Finish entering the credentials and submit, then continue."
              : rejectReason === 'credentials_not_submitted'
                ? "You haven't submitted the password yet — enter the username and password and submit before reporting success."
                : "That doesn't look like the logged-in app yet. Wait for the page to finish loading, take a fresh screenshot, and keep going.";
        messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text:
              `${hint} Once you've reached the main operational screen (and the login form is gone), ` +
              `reply with {"loggedIn": true, "dashboardSelector": "<a selector only present after login, or omit if none>"}.`,
          }],
        });
        continue;
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
      // fix/cua-login-universal — note when the agent actually submitted the
      // password. This is the positive corroborator isLoginConfirmed requires
      // before "login form gone" can mean "logged in", so a premature loggedIn
      // claim on a pre-password screen (2-step username page, SSO chooser,
      // splash) can't slip through. Keyed on the executor's RECORDED step
      // (value === '$password' whether the agent typed the placeholder or the
      // raw secret) — NOT the raw model text — so a non-substituted
      // "$password\n", or MFA '$auth_code' typing, can't flip it. DOM-
      // independent → holds for iframe / shadow-DOM / canvas logins.
      if (exec.recordedStep?.kind === 'type_text' && exec.recordedStep.value === '$password') {
        credentialsSubmitted = true;
      }
      if (exec.recordedStep && !suppressRecording) recordedSteps.push(exec.recordedStep);
      // feature/cua-live-view — tee the (already privacy-hardened)
      // screenshot to the Learning Board's live view. Fire-and-forget.
      if (exec.screenshotB64) ctx.onLiveFrame?.(exec.screenshotB64);
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
  /** feat/cua-mapper-discovery — true when this success was committed by
   *  bail() (lastGoodAction after a loop/cost/step abort) rather than the
   *  clean success return. On a bail the page may have wandered off the feed
   *  (e.g. loop detector tripped mid-exploration), so the DOM oracle could be
   *  scraping a DIFFERENT-but-table-shaped page; structured discovery must
   *  never run on these — it could verify a self-consistent WRONG feed. */
  viaBail?: boolean;
  /** Learning Board — captured at clean-success time (rowCount + ≤3 real
   *  rows / drill-down records) so the admin board can show what the robot
   *  actually found. Display-only; never read by replay. */
  boardPreview?: BoardPreview;
}
interface ActionMapFailure {
  ok: false;
  reason: string;
  finalUrl: string;
  /** Learning Board — true when the AGENT declared the feed unavailable
   *  (floor-met {unavailable:true}) or an admin explicitly marked it so.
   *  Distinguishes "this PMS doesn't have it" from "couldn't find it"
   *  without string matching. */
  unavailable?: boolean;
}

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

interface MapActionArgs {
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
  /** Plan v9 — true for the promotion-gating feeds (optional:false). Used by the
   *  agent prompt to tell the model this feed is ESSENTIAL (so it persists +
   *  backtracks instead of giving up early). Plan v10 (FIX 2): `required === false`
   *  also tightens the per-target budget (see targetBudget). Required + any caller
   *  that omits this flag keep the full budget. */
  required?: boolean;
  model?: MapperModelId;
  /** Plan v8 review P0-A — per-job cap override (vision uses higher cap). */
  jobCostCapMicros?: number;
  /** feature/cua-column-recovery — the run's pooled date-order inference so
   *  far (pickDateFormat over earlier targets' samples + any repair seed).
   *  The recovery value-gate parses candidate date cells with the SAME config
   *  the runtime will eventually get; without it an ambiguous-order PMS could
   *  gate differently at mapping time than it parses at poll time. */
  provisionalDateFormat?: LearnedDateFormat;
  /** feature/cua-live-view — see MapperOptions.onLiveFrame. */
  onLiveFrame?: (pngBase64: string) => void;
  /** feature/cua-live-assist — see MapperOptions.takeover. */
  takeover?: TakeoverController;
  /** fix/cua-two-oracle — EARLY structured discovery, wired by mapAction. When
   *  the success branch finds a structurally-sound table that is blind on a
   *  required column, mapActionCore runs the backend-JSON reader BEFORE burning
   *  the paid re-ask/drill recovery. Bound by mapAction to attemptStructured-
   *  Discovery with the shared deps; omitted when network capture is off. */
  runStructuredDiscovery?: (
    success: ActionMapSuccess,
    capturedCalls: CapturedCall[],
    feedPageUrl: string,
  ) => Promise<ActionMapSuccess | null>;
  /** Snapshot the captured calls at the first committable (structurally-sound)
   *  emit — i.e. before any paid re-ask/drill recovery runs. The 50-slot capture
   *  LRU evicts the feed's JSON during a multi-minute recovery, so the early-
   *  discovery attempt must use this early snapshot, not a late capture.recent(). */
  snapshotCapturedCalls?: () => CapturedCall[];
  /** Shared mutable flag so mapAction's LATE discovery skips when mapActionCore
   *  already ran the (single) paid identify call for this feed. */
  discoveryState?: { earlyAttempted: boolean };
}

/**
 * Plan v10 (FIX 1) — read page.url() without throwing. Playwright's url() can
 * throw on a closing/closed context; the per-step backtrack check sits on the
 * hottest path, so a throw there must degrade to "" (→ not the dashboard →
 * backtrack logic simply doesn't fire) rather than crash the target. Mirrors the
 * guard pageFingerprint already applies in loop-detector.ts.
 */
function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/**
 * Plan v10 (FIX 1) — is the page currently back on the post-login dashboard?
 * Compares origin + pathname only (ignoring query / hash / trailing slash) so a
 * Home/logo click that re-lands on the dashboard — possibly with a cache-buster
 * query — still counts as a return. PMS-agnostic: the dashboard is, by
 * definition, postLoginUrl. Malformed/empty URLs → false (the safe default that
 * simply doesn't fire the backtrack logic). Exported for unit tests.
 */
export function isDashboardUrl(currentUrl: string, postLoginUrl: string): boolean {
  try {
    const cur = new URL(currentUrl);
    const dash = new URL(postLoginUrl);
    if (cur.origin !== dash.origin) return false;
    const norm = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
    return norm(cur.pathname) === norm(dash.pathname);
  } catch {
    return false;
  }
}

/**
 * Plan v10 (FIX 1) — tracks DELIBERATE returns to the dashboard during a
 * per-target agent loop, shared by mapAction and mapDrillDownAction (both land on
 * postLoginUrl before their loop, so `wasOnDashboard` starts true). Call
 * `onTurn(url)` at the TOP of each step. It returns:
 *   - 'reset' the first MAX_DASHBOARD_RETURNS times the agent transitions back
 *     ONTO the dashboard → caller should new-up its loop detector so the fresh
 *     exploration leg doesn't inherit the prior leg's (screenshot, dashboard)
 *     tuples (the false positive that loop-fails required feeds);
 *   - 'cap' once that budget is spent → caller should stop bouncing and commit
 *     its best attempt / declare unavailable instead of looping forever;
 *   - 'none' otherwise.
 * A transition is "was NOT on the dashboard last turn, IS now" — so sitting on
 * the dashboard re-screenshotting in place is NOT a return (and still trips the
 * loop detector, correctly), and a stuck loop on a wrong page (no dashboard
 * transition) still trips too.
 */
export class DashboardReturnTracker {
  private returns = 0;
  private wasOnDashboard = true;
  constructor(
    private readonly postLoginUrl: string,
    private readonly maxReturns: number = MAX_DASHBOARD_RETURNS,
  ) {}

  onTurn(currentUrl: string): 'none' | 'reset' | 'cap' {
    const onDashboardNow = isDashboardUrl(currentUrl, this.postLoginUrl);
    let verdict: 'none' | 'reset' | 'cap' = 'none';
    if (onDashboardNow && !this.wasOnDashboard) {
      this.returns += 1;
      verdict = this.returns > this.maxReturns ? 'cap' : 'reset';
    }
    this.wasOnDashboard = onDashboardNow;
    return verdict;
  }

  get count(): number {
    return this.returns;
  }
}

/**
 * Per-target learn loop, wrapped with STRUCTURED DISCOVERY
 * (feat/cua-mapper-discovery). Passive network capture is attached for the
 * duration of the target so the feed page's own data calls are observable;
 * when the agent lands a clean DOM table on a CORE feed, discovery tries to
 * find + VERIFY the JSON endpoint behind it (oracle-verify.ts) and upgrade
 * the recipe to `parse:{mode:'api'}`.
 *
 * Fail-safe by construction:
 *  - capture attach failure → discovery disabled, DOM path untouched;
 *  - bail()-committed successes (viaBail) never run discovery — the page may
 *    have wandered, and a wandered page can self-consistently verify a WRONG
 *    feed (oracle and capture would both describe the wrong page);
 *  - ANY throw inside discovery → the DOM success is returned unchanged;
 *  - detach() runs in finally on every path (incl. the admin-abort throws).
 */
// extractDomRows now lives in extractors/dom-rows.ts — ONE implementation
// shared with the runtime dom_table extractor (incl. the '@attr' convention),
// so "verified at mapping time" can never drift from "extracted at poll time".

// Learning Board preview caps — keep the persisted result jsonb small.
const BOARD_PREVIEW_MAX_ROWS = 3;
const BOARD_PREVIEW_MAX_CELL_CHARS = 80;
// Previews persist in workflow_jobs.result indefinitely (vs help screenshots,
// which the expire cron deletes after ~15min). Guest names match what the
// admin already sees on screenshots, but contact details have no business
// being retained in a job log — drop them by canonical field name. Generic:
// contract field names, not PMS vocabulary.
const BOARD_PREVIEW_DROPPED_FIELDS = /email|phone|mobile/i;

export function truncatePreviewRows(
  rows: Array<Record<string, string>>,
): Array<Record<string, string>> {
  return rows.slice(0, BOARD_PREVIEW_MAX_ROWS).map((row) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (BOARD_PREVIEW_DROPPED_FIELDS.test(k)) continue;
      out[k] = v.length > BOARD_PREVIEW_MAX_CELL_CHARS
        ? `${v.slice(0, BOARD_PREVIEW_MAX_CELL_CHARS - 1)}…`
        : v;
    }
    return out;
  });
}

/**
 * Learning Board — capture a tiny "what the robot actually sees" preview
 * (live row count + first 3 rows) from the feed page at clean-success time.
 * MUST run before attemptStructuredDiscovery: discovery can navigate the
 * page back to postLoginUrl and upgrade parse to mode:'api', after which
 * the feed rows are no longer on screen. Never throws; undefined on any
 * failure (the board just shows ✓ without a preview).
 */
async function captureBoardPreview(
  page: Page,
  action: ActionRecipe,
): Promise<BoardPreview | undefined> {
  if (action.parse.mode !== 'table') return undefined;
  const hint = action.parse.hint;
  try {
    const { rows, totalMatched } = await extractDomRows(
      page, hint.rowSelector, hint.columns, { cap: BOARD_PREVIEW_MAX_ROWS },
    );
    return { rowCount: totalMatched, sample: truncatePreviewRows(rows), sampleKind: 'rows' };
  } catch (err) {
    log.info('mapper: board preview capture failed (non-fatal)', {
      err: (err as Error).message,
    });
    return undefined;
  }
}

/**
 * fix/cua-mapper-commit — purely-structural probe of the CURRENT page, feeding
 * the deterministic commit-nudge (commit-signal.ts). Counts repeating,
 * >=2-column tabular structures — native <table> and ARIA role=grid/table — and
 * the most columns / DATA rows in any of them. UNIVERSAL: shape counts only, no
 * PMS vocabulary / page name / URL. Never navigates.
 *
 * Fail-safe: ANY error (page closing/navigating mid-flight) OR a >2s stall
 * resolves to an all-zero summary → hasCommittableStructure() is false → no
 * nudge → EXACTLY today's behavior. The probe can therefore never make a run
 * worse than it is now; at worst it stays silent. Runs at most once per
 * candidate page (the caller gates it behind the dither/dashboard/stable
 * checks), so the extra page.evaluate is not paid every turn.
 */
async function summarizeTabularStructure(page: Page): Promise<TabularSummary> {
  const empty: TabularSummary = { tableCount: 0, maxColumns: 0, maxDataRows: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // .catch on the evaluate so that if the 2s timeout wins the race, a LATER
    // rejection from the still-pending evaluate (page closed/navigated) is
    // swallowed here rather than surfacing as an unhandled rejection.
    const probe = page
      .evaluate((): TabularSummary => {
        let tableCount = 0;
        let maxColumns = 0;
        let maxDataRows = 0;
        const note = (cols: number, dataRows: number) => {
          if (cols < 2) return; // 1-column => nav menu / list, not a data table
          tableCount += 1;
          if (cols > maxColumns) maxColumns = cols;
          if (dataRows > maxDataRows) maxDataRows = dataRows;
        };
        // Native HTML tables.
        for (const t of Array.from(document.querySelectorAll('table'))) {
          const trs = Array.from(t.querySelectorAll('tr'));
          if (trs.length === 0) continue;
          let cols = 0;
          for (const tr of trs) {
            const n = tr.querySelectorAll('td, th').length;
            if (n > cols) cols = n;
          }
          // A data row contains at least one <td> (header-only rows excluded).
          const dataRows = trs.filter((tr) => tr.querySelector('td')).length;
          note(cols, dataRows);
        }
        // ARIA grids / tables (div-based renderers that opt into roles).
        for (const g of Array.from(document.querySelectorAll('[role="grid"], [role="table"]'))) {
          const rows = Array.from(g.querySelectorAll('[role="row"]'));
          if (rows.length === 0) continue;
          let cols = 0;
          for (const r of rows) {
            const n = r.querySelectorAll('[role="cell"], [role="gridcell"], [role="columnheader"]').length;
            if (n > cols) cols = n;
          }
          const dataRows = rows.filter((r) => r.querySelector('[role="cell"], [role="gridcell"]')).length;
          note(cols, dataRows);
        }
        return { tableCount, maxColumns, maxDataRows };
      })
      .catch((): TabularSummary => empty);
    const timeout = new Promise<TabularSummary>((resolve) => {
      timer = setTimeout(() => resolve(empty), 2000);
    });
    return await Promise.race([probe, timeout]);
  } catch {
    return empty;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapAction(args: MapActionArgs): Promise<ActionMapSuccess | ActionMapFailure> {
  let capture: NetworkCaptureHandle | null = null;
  try {
    capture = attachNetworkCapture(args.page);
  } catch (err) {
    log.warn('mapper: network capture attach failed — structured discovery off for this target', {
      actionName: args.actionName,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    // fix/cua-two-oracle — build the discovery deps ONCE and share them between
    // the EARLY in-core attempt (before paid recovery) and the LATE post-success
    // attempt. `discoveryState` ensures at most ONE paid identify call per feed.
    const deps = makeDefaultDiscoveryDeps(args);
    const discoveryState = { earlyAttempted: false };
    const runStructuredDiscovery = capture
      ? async (
          success: ActionMapSuccess,
          capturedCalls: CapturedCall[],
          feedPageUrl: string,
        ): Promise<ActionMapSuccess | null> => {
          try {
            return await attemptStructuredDiscovery(
              {
                actionName: args.actionName as keyof Recipe['actions'],
                success,
                capturedCalls,
                loginUrl: args.credentials.loginUrl,
                feedPageUrl,
                jobId: args.jobId,
                signal: args.signal,
              },
              deps,
            );
          } catch (err) {
            log.warn('mapper: structured discovery threw — keeping DOM recipe', {
              actionName: args.actionName,
              err: err instanceof Error ? err.message : String(err),
            });
            return null;
          }
        }
      : undefined;

    const result = await mapActionCore({
      ...args,
      ...(runStructuredDiscovery && capture
        ? {
            runStructuredDiscovery,
            snapshotCapturedCalls: () => capture!.recent(),
            discoveryState,
          }
        : {}),
    });
    // Learning Board — preview BEFORE discovery (which can navigate away /
    // swap parse to api-mode). viaBail successes are skipped for the same
    // reason discovery skips them: the page may have wandered off the feed
    // and a wrong-page preview would be presented as "what it captured".
    if (result.ok && !result.viaBail && result.action.parse.mode === 'table') {
      result.boardPreview = await captureBoardPreview(args.page, result.action);
    }
    // feature/cua-column-recovery — an action that gained a drillDown block
    // (stage-2 recovery) skips structured discovery: a mode:'api' upgrade
    // would collide with the adapter's drillDown collapse, and the DOM oracle
    // is missing the very required columns the drill just recovered, so the
    // reconcile would abstain anyway.
    // fix/cua-two-oracle — also skip when mapActionCore already ran the (single)
    // EARLY discovery attempt: re-running here would pay a second identify call
    // and use a staler capture.recent() (the early snapshot was the freshest).
    if (
      !result.ok || result.viaBail || result.action.parse.mode !== 'table'
      || result.action.drillDown || !capture || !runStructuredDiscovery
      || discoveryState.earlyAttempted
    ) {
      return result;
    }
    const upgraded = await runStructuredDiscovery(result, capture.recent(), args.page.url());
    return upgraded ?? result;
  } finally {
    try { capture?.detach(); } catch { /* idempotent per contract */ }
  }
}

/**
 * feature/cua-feed-extract — the URL of the LAST recorded `goto` step (the
 * anchor recipe-adapter derives a feed's source URL from). '' when none.
 */
export function lastRecordedGotoUrl(steps: RecipeStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.kind === 'goto') return s.url;
  }
  return '';
}

/**
 * feature/cua-feed-extract — record the feed's REAL landing URL.
 *
 * The #1 onboarding blocker: a feed reached by CLICKING through menus recorded
 * only `click_at` steps, never a `goto` for the page it landed on — so
 * recipe-adapter derived the feed's source URL as the LAST goto (= the
 * dashboard/postLoginUrl) and the dom_table extractor navigated to the
 * dashboard, waited for a row selector that never appeared, and returned ZERO
 * rows.
 *
 * Called at the TOP of each agent turn (the prior turn's navigation has
 * settled, so `page.url()` is reliable). Whenever click-navigation has moved
 * the page to a NEW url since the last recorded goto, we append a `goto` for
 * it. Effects, by feed shape:
 *   - menu-nav to a distinct URL → a trailing goto becomes the source URL, so
 *     replay navigates STRAIGHT to the feed (the click steps fall BEFORE the
 *     goto and recipe-adapter drops them — direct nav beats replaying clicks);
 *   - nav-then-in-page-interaction (report page + a "Generate"/filter click
 *     that keeps the URL) → the goto is recorded BEFORE that click, so the
 *     click survives as a replayable pre-step after the source URL;
 *   - SPA route swap (URL unchanged) → no goto; the click stays in the step
 *     list and recipe-adapter carries it as a pre-step replayed at extraction.
 *
 * Compared on the audit-normalized URL so a cache-buster query can't
 * masquerade as navigation while a semantic `?view=arrivals` still does. Pure +
 * idempotent: a no-op when the URL is unchanged, unreadable, or unseeded.
 */
export function recordLandingGoto(steps: RecipeStep[], currentUrl: string): void {
  if (currentUrl === '') return;
  const lastGoto = lastRecordedGotoUrl(steps);
  // recordedSteps always seeds a leading goto(postLoginUrl); defend anyway so a
  // malformed step list never starts emitting bare gotos.
  if (lastGoto === '') return;
  if (normalizeUrlForAudit(currentUrl) === normalizeUrlForAudit(lastGoto)) return;
  steps.push({ kind: 'goto', url: currentUrl });
}

async function mapActionCore(args: MapActionArgs): Promise<ActionMapSuccess | ActionMapFailure> {
  const cfg = getModeConfig(args.model);
  // Plan v7: per-target step + cost caps. Drill-down targets get fewer
  // steps PER record but execute against multiple samples; report-menu
  // targets get more steps to drill through reports submenus.
  const classification = args.classification ?? 'list_page';
  // Plan v10 (FIX 2) — optional feeds get a tighter cost + step budget; required
  // feeds (and any caller that omits `required`) keep the full one. Only an
  // explicit `required === false` tightens, so this can never starve a required
  // feed.
  const { stepCap: targetStepCap, costCapMicros: targetCostCapMicros } =
    targetBudget(classification, args.required === false);

  // fix/cua-two-oracle (build #4) — per-target cost ENVELOPE. Starts at the base
  // per-classification cap. ONLY after a committable, structurally-sound table
  // is found for a REQUIRED CORE feed do we widen it — and only ADDITIVELY by
  // the detail-drill's own envelope, so a found feed's certification (early
  // discovery → re-ask → drill) isn't guillotined mid-flight. This is NARROW by
  // design: the 2026-06-11 revert removed a FIND-PHASE multiplier that inflated
  // the cost of feeds that were never found; this widening fires AFTER a table
  // is found and is bounded (base + one drill envelope ≈ $1.10), so it can't
  // recreate that. The job-wide cap (isJobOverBudget) stays the hard ceiling.
  const isRequiredCoreFeed = !!CORE_TARGET_CONTRACTS[args.actionName as keyof Recipe['actions']];
  let effectiveTargetCostCapMicros = targetCostCapMicros;
  const widenEnvelopeForFoundCoreFeed = (audit: PageAudit): void => {
    if (!isRequiredCoreFeed) return;
    if (effectiveTargetCostCapMicros === Number.POSITIVE_INFINITY) return;
    if (!structurallySoundForDiscovery(audit, args.actionName as keyof Recipe['actions'])) return;
    const widened = targetCostCapMicros + RECOVERY_DRILL_COST_CAP_MICROS;
    if (widened > effectiveTargetCostCapMicros) {
      effectiveTargetCostCapMicros = widened;
      log.info('mapper: committable core table found — widening per-target certification envelope', {
        jobId: args.jobId ?? undefined,
        actionName: args.actionName,
        baseCapMicros: targetCostCapMicros,
        effectiveCapMicros: effectiveTargetCostCapMicros,
      });
    }
  };

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
    `\n\nCOMMIT RULE (read first): The FIRST page you reach that shows this feed's ` +
    `data as a repeating table or list — i.e. you can see the columns/headers for ` +
    `the required fields below — IS the answer. Emit the success JSON immediately. ` +
    `Do NOT keep looking for a cleaner, fancier, or "report"-named version. Two ` +
    `things are NOT reasons to keep searching: (a) the table has ZERO data rows ` +
    `right now — a correct page that is simply empty today (e.g. no departures yet) ` +
    `is a COMPLETE, valid capture; read the column selectors from the header row and ` +
    `emit them; (b) the page is not titled "Report" — the data SHAPE is what matters, ` +
    `not the page's name. The ONLY reason to keep navigating is if the page is a ` +
    `DIFFERENT feed than your target (check the heading — e.g. you need DEPARTURES ` +
    `but you are on ARRIVALS): then return to the dashboard and pick the adjacent ` +
    `item. A dashboard summary TILE of totals is not the feed — find the page that ` +
    `lists the individual records.\n\n` +
    `WORKFLOW (use the computer tool):\n` +
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
    `5b. IF A CLICK LANDS YOU ON THE WRONG PAGE — back on the home/dashboard, or ` +
    `on a DIFFERENT feed than your target (e.g. you wanted DEPARTURES but you're ` +
    `looking at ARRIVALS) — do NOT keep clicking forward from that wrong page. ` +
    `First go BACK to the dashboard (click the Home link or the hotel logo, ` +
    `usually top-left), then pick a DIFFERENT link. Sibling pages like ` +
    `Arrivals/Departures and Check-In/Check-Out usually sit right next to each ` +
    `other — if you already found one, its sibling is normally the adjacent menu ` +
    `item, so look there.\n` +
    `6. Once on the target page (you see a table/list whose COLUMNS match the ` +
    `required fields — even if it has ZERO data rows right now), take a final ` +
    `screenshot. Each column HEADER is tagged with a numbered badge (e.g. "H1", ` +
    `"H2", …). Map each required field to a column by its HEADER MEANING FIRST: ` +
    `read the header text, decide which header is that field, and note its column ` +
    `position N (counting cells from 1, left to right). THEN write that column's ` +
    `selector as \`td:nth-child(N)\` for the SAME N. Anchoring on the header — not ` +
    `a pixel guess — is what lets us re-find the column if the PMS later reorders ` +
    `or renames its columns. Most PMSes use \`tr\` or \`tbody tr\` for rows. The ` +
    `runtime verifies your selectors on the first extraction; if wrong, a ` +
    `self-heal job re-engages you.\n` +
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

    (args.required
      ? `Step budget: up to ${targetStepCap} actions for this ESSENTIAL feed. ` +
        `The sync is BLOCKED without it, so do NOT give up easily: if a link takes ` +
        `you to the wrong page, return to the dashboard (Home link / hotel logo) and ` +
        `try a different one. Only emit {"unavailable":true,"reason":"<what you tried>"} ` +
        `if you have genuinely exhausted every plausible menu AFTER returning to the ` +
        `dashboard at least twice.`
      : `Step budget: you have up to ${targetStepCap} actions. ` +
        `Spend the first ~5 on exploration (read_page + nav clicks); ` +
        `if you've used ${Math.round(targetStepCap * 0.6)}+ without finding the page, emit ` +
        `{"unavailable":true,"reason":"<what you tried>"} on the first line ` +
        `and stop. Skipping an optional extra is better than burning the whole budget.`);

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: fullGoal }] },
  ];
  // Batched-pruning state — one per agent loop. See PRUNE_BATCH_TURNS
  // and maybePruneHistory() for the cache-friendliness rationale.
  const pruneState = createPruneState();

  const phaseStartedAt = Date.now();
  // Time spent waiting for an admin in maybeAskAdminBeforeUnavailable.
  // Credited back in the wallclock check below — a founder who takes 4
  // minutes to answer must not eat the agent's own exploration budget
  // (otherwise the help is followed by instant "wallclock budget exceeded").
  let helpWaitMs = 0;

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
  let loopDetector = new ActionLoopDetector();
  // Plan v10 (FIX 1) — deliberate-backtrack tracker. Resets the loop detector on
  // each return to the dashboard (so a healthy "try a sibling link" leg starts
  // clean) and caps the returns so the bounce terminates gracefully. See
  // MAX_DASHBOARD_RETURNS.
  const dashboardTracker = new DashboardReturnTracker(args.postLoginUrl);

  // Completeness re-ask budget (fix/mapper-field-contract). Bounds how many
  // times the success branch re-prompts the model to fill missing REQUIRED
  // columns before accepting blanks. Without it a feed can "succeed" with
  // empty selectors and silently write 0 rows (validateRows rejects every row
  // for the absent descriptor column). The per-target step/cost/wallclock/
  // token caps below are the outer backstops; this just stops us accepting a
  // structurally-incomplete column map on the first emit.
  let completenessReasks = 0;

  // feature/cua-column-recovery — recovery state.
  //  - pendingRecovery: required columns that failed verification at least
  //    once this action. Every later emission must pass the VALUE gate for
  //    them: a hallucinated selector that "fills" the column with the wrong
  //    cell's values is worse than a blank.
  //  - bestCandidate: the emission with the fewest outstanding required
  //    columns (ties → newest). Aborts and worse re-emissions ship THIS —
  //    a re-ask that breaks a previously-good column can never regress the
  //    returned map.
  //  - recoveryDrillAttempted: stage-2 (single-record detail drill) runs at
  //    most ONCE per action per mapping run.
  const pendingRecovery = new Set<string>();
  let bestCandidate: { success: ActionMapSuccess; audit: PageAudit } | null = null;
  let recoveryDrillAttempted = false;
  // fix/cua-two-oracle — captured-calls snapshot taken at the FIRST committable
  // emit (LRU eviction guard); reused by the single early-discovery attempt.
  let earlyCapturedCalls: CapturedCall[] | null = null;

  // Crash-safety for the re-ask (fix: core feeds were quarantining). Once the
  // agent has emitted a VALID table parse, remember it. If a later re-ask
  // churns into a loop / cost-cap / step abort, we MUST NOT throw the feed
  // away — committing the (possibly incomplete) table we already found lands a
  // recoverable park_draft, whereas dropping it quarantines the whole PMS
  // (every required core feed missing → no map for any hotel on that brand).
  // `bail` is the single exit used by every abort path: it returns the last
  // good parse if we have one, else the real failure.
  let lastGoodAction: ActionMapSuccess | null = null;
  const bail = (reason: string): ActionMapSuccess | ActionMapFailure =>
    lastGoodAction
      ? { ...lastGoodAction, viaBail: true }
      : { ok: false, reason, finalUrl: args.page.url() };

  // fix/cua-mapper-commit — deterministic commit-nudge state. When the agent
  // lingers on the same page for several turns (dithering, not navigating) and
  // that page already shows a committable tabular structure, the mapper appends
  // a one-time "commit checkpoint" reminder so a feed that's actually FOUND gets
  // captured instead of grinding to a cost-cap / loop-detector death.
  //
  // Eligibility is deliberately narrow so it can never deterministically commit a
  // WRONG page:
  //   - CORE feed only — optional/report feeds get NO post-emit value check
  //     (auditLearnedColumnsOnPage returns empty for non-core), so a nudge there
  //     could bless an arbitrary table; they rely on the prompt fixes.
  //   - UNIQUE required-column schema only — a schema sibling (getArrivals vs
  //     getDepartures, identical required columns) is indistinguishable to the
  //     audit, so nudging one risks committing the other; siblings rely on the
  //     model's heading/identity read in the COMMIT RULE + goal instead. The
  //     feeds that DO nudge (room status, work orders) carry value audits
  //     (status enum / out_of_order boolean) that genuinely gate a wrong shape.
  const nudgeEligibleTarget =
    requiredLearnedFor(args.actionName as keyof Recipe['actions']).length > 0 &&
    !coreTargetSharesRequiredSchema(args.actionName as keyof Recipe['actions']);
  let prevTurnFingerprint: string | null = null;
  let samePageStreak = 0;
  const commitNudgedFingerprints = new Set<string>();

  for (let stepIdx = 0; stepIdx < targetStepCap; stepIdx++) {
    // ── feature/cua-live-assist — founder takeover gate ──────────────────
    // Cheap no-op (one indexed read) unless the founder pressed Take over /
    // Skip on the Learning Board. When a takeover is live, maybeRun owns the
    // ENTIRE multi-click loop and returns only on finish/cancel/skip/timeout —
    // so the founder's clicks consume ZERO stepIdx (they never re-enter this
    // for-loop) and the agent's decision logic below is untouched. We credit
    // the human time to helpWaitMs so the wall-clock budget (next check) isn't
    // starved — identical to the existing supervisor-wait credit at the
    // unavailable/ask_admin branches.
    if (args.takeover) {
      const t = await args.takeover.maybeRun({
        page: args.page,
        credentials: args.credentials,
        actionKey: args.actionName,
        signal: args.signal,
        recordStep: (s) => recordedSteps.push(s),
      });
      helpWaitMs += t.waitedMs;
      if (t.kind === 'cancelled') {
        // Founder drove and couldn't find it → not-found, mapPMS moves on.
        return { ok: false, reason: t.reason, finalUrl: args.page.url() };
      }
      if (t.kind === 'skipped') {
        return { ok: false, reason: t.reason, finalUrl: args.page.url() };
      }
      if (t.kind === 'finished') {
        // Founder confirmed THIS page is the feed. Hand back to the EXISTING
        // extraction by appending a supervisor instruction to the trailing
        // user turn (loop-top is always user; a standalone push would be
        // consecutive-user → API-invalid). The unchanged agent loop then reads
        // this page and emits rowSelector+columns — we do NOT fork it.
        const finishHint = {
          type: 'text' as const,
          text:
            'SUPERVISOR OVERRIDE: I (your supervisor) navigated the browser to the correct page ' +
            `for "${args.actionName}". Do NOT navigate away. Read the page you are on NOW and emit the ` +
            'first-line JSON {"url": "<current url>", "rowSelector": "...", "columns": {...}} for THIS page. ' +
            'If it is a list/table, give the row selector and per-column selectors; capture the columns you can see.',
        };
        const last = messages[messages.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content)) {
          last.content.push(finishHint);
        } else {
          messages.push({ role: 'user', content: [finishHint] });
        }
        // Mirror the supervisor-hint reset so a post-takeover agent isn't
        // instantly eligible to re-declare unavailable.
        readPageCount = 0;
        navigationCount = 0;
        // Wave-1 stitch hardening: also clear the commit-nudge dither state so a
        // founder-confirmed page starts nudge accounting fresh and can't inherit
        // a pre-takeover dither streak (the one place the takeover gate + the
        // commit-nudge share an iteration). Mirrors the resets above.
        samePageStreak = 0;
        prevTurnFingerprint = null;
        // fall through — this iteration's Claude call now carries the override.
      }
      // kind === 'none' → no takeover; proceed with the normal agent step.
    }
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      return bail('token budget exceeded');
    }
    if (Date.now() - phaseStartedAt - helpWaitMs > PHASE_WALLCLOCK_BUDGET_MS) {
      return bail('wallclock budget exceeded');
    }
    // Per-turn budget check — global job cap.
    {
      const budget = await isJobOverBudget(args.jobId, args.jobCostCapMicros);
      if (budget.over) {
        log.warn('action mapper aborting — cumulative job cost cap hit', {
          jobId: args.jobId ?? undefined, actionName: args.actionName, ...budget,
        });
        return bail('cost cap hit');
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
      return bail(`per-target cost cap exceeded for ${classification} ($${(targetCostCapMicros / 1_000_000).toFixed(2)})`);
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

    // fix/cua-mapper-commit — dither tracking for the commit-nudge. Same-page
    // streak = consecutive turns the model has REASONED on the identical page
    // fingerprint (it keeps clicking no-ops / re-screenshotting instead of
    // committing or navigating). The nudge gate below additionally re-checks the
    // fingerprint AFTER this turn's action, so a turn that actually navigated (or
    // an SPA route swap that kept the URL) can't inherit a stale streak.
    samePageStreak = prevTurnFingerprint !== null && turnPageFingerprint === prevTurnFingerprint
      ? samePageStreak + 1
      : 0;
    prevTurnFingerprint = turnPageFingerprint;

    // Plan v10 (FIX 1) — deliberate-backtrack accounting. Runs at the TOP of the
    // step (before this step's actions are recorded into the loop detector at the
    // bottom) so a reset clears the prior leg's tuples before the new leg's first
    // dashboard screenshot lands. A 'reset' clears the false-positive screenshot
    // accumulation that loop-fails required feeds; 'cap' stops an endless bounce
    // and commits the best attempt instead of letting the detector hard-fail.
    const backtrack = dashboardTracker.onTurn(safeUrl(args.page));
    if (backtrack === 'cap') {
      log.warn('mapper: dashboard-return cap reached — committing best attempt instead of bouncing', {
        jobId: args.jobId ?? undefined,
        actionName: args.actionName,
        dashboardReturns: dashboardTracker.count,
        maxReturns: MAX_DASHBOARD_RETURNS,
      });
      return bail(`exhausted ${MAX_DASHBOARD_RETURNS} dashboard returns without locating ${args.actionName}`);
    }
    if (backtrack === 'reset') {
      loopDetector = new ActionLoopDetector();
      log.info('mapper: deliberate dashboard return — loop detector reset for a fresh leg', {
        jobId: args.jobId ?? undefined,
        actionName: args.actionName,
        dashboardReturns: dashboardTracker.count,
        maxReturns: MAX_DASHBOARD_RETURNS,
      });
    }

    // feature/cua-feed-extract — anchor the feed's real landing URL. Runs at the
    // turn top (prior turn's click-navigation has settled) so a click-reached
    // feed records a goto for the page it landed on, instead of leaving the
    // recipe pointing at the dashboard. See recordLandingGoto for the per-shape
    // behaviour (direct-nav URL vs. replayable pre-steps). Best-effort: an
    // unreadable url is a no-op and the pre-step fallback in recipe-adapter
    // still reaches the feed by replaying the recorded clicks.
    recordLandingGoto(recordedSteps, safeUrl(args.page));

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
        // feat/pms-universal-translate — raw value observations the model
        // emitted on the same turn it found the table (date order + enum vocab).
        const learnedSamples = coerceValueSamples(parsed.valueSamples);
        const learnedEnums = coerceEnumMappings(parsed.enumMappings);
        const success: ActionMapSuccess = {
          ok: true,
          action: {
            // Snapshot — recordedSteps keeps growing across re-asks/drills;
            // by-reference sharing would retroactively mutate an OLDER best
            // candidate's recipe with later wandering (code review P1).
            steps: [...recordedSteps],
            parse: { mode: 'table', hint: { rowSelector: parsed.rowSelector, columns: learnedColumns } },
          },
          ...(learnedSamples && { valueSamples: learnedSamples }),
          ...(learnedEnums && { enumMappings: learnedEnums }),
        };

        // Completeness verification (feature/cua-column-recovery, supersedes
        // the fix/mapper-field-contract string-only check): a "successful"
        // feed whose required columns are structurally missing, extract blank
        // from every row, or extract values the runtime parser can't use,
        // writes 0 usable rows at poll time. Audit the emitted map against
        // the LIVE DOM, then run bounded recovery for whatever is dead.
        //
        // Scoped to the CORE feeds' descriptor contract (the audit returns
        // empty for non-core targets, whose requiredFields can include
        // off-page fields like a forecast run-date the model genuinely can't
        // supply). This keeps recovery symmetric with the promotion gate,
        // which is also REQUIRED_TARGETS-only.
        const audit = await auditLearnedColumnsOnPage({
          page: args.page,
          actionKey: args.actionName as keyof Recipe['actions'],
          emittedUrl: typeof parsed.url === 'string' ? parsed.url : null,
          rowSelector: parsed.rowSelector,
          columns: learnedColumns,
          payloadEnums: learnedEnums,
          payloadSamples: learnedSamples,
          provisionalDateFormat: args.provisionalDateFormat,
          pendingRecovery,
        });
        for (const col of audit.outstanding.keys()) pendingRecovery.add(col);

        // Best-candidate tracking: an abort (or a re-ask that breaks a
        // previously-good column) must never ship a WORSE map than one we
        // already verified. VERIFIED beats unverified at any size — a
        // structural-only audit (wandered page / failed probe) proves nothing
        // about values, so it can never displace a measured candidate (code
        // review P1). Ties go to the newest candidate. bail() commits the
        // finalized best — recovery churn can only park, never quarantine a
        // feed we actually found.
        if (isBetterCandidate(
          { verified: audit.verified, outstandingCount: audit.outstanding.size },
          bestCandidate
            ? { verified: bestCandidate.audit.verified, outstandingCount: bestCandidate.audit.outstanding.size }
            : null,
        )) {
          bestCandidate = { success, audit };
        }
        // Always non-null from here (the comparator accepts anything over
        // null); the fallback only narrows the type.
        const best = bestCandidate ?? { success, audit };
        lastGoodAction = finalizeRecoveredSuccess(best);

        // Accept-now only when this emission is CLEAN BY MEASUREMENT — or was
        // never under recovery at all. An unverified audit with columns still
        // pending recovery must not short-circuit (its non-blank selector
        // strings are exactly the evidence we already proved insufficient).
        // Return the FINALIZED best (lastGoodAction), not the raw success: for a
        // value-verified clean emission this is identical, but for an unverified
        // accept (empty/unreadable feed, pendingRecovery still empty) it carries
        // the `unprovenRequiredColumns` stamp so the promotion gate parks the
        // feed for founder review instead of auto-promoting a guessed column
        // (feature/cua-prove-columns).
        if (audit.outstanding.size === 0 && (audit.verified || pendingRecovery.size === 0)) {
          return lastGoodAction;
        }

        // ── fix/cua-two-oracle (build #2 + #4): EARLY backend-JSON discovery ──
        // The table is FOUND but blind on a required column. BEFORE burning the
        // paid Stage-1 re-asks (which can blow the per-target cost cap and bail
        // viaBail, skipping discovery entirely), widen the cost envelope for a
        // committable core table and try the cheap backend-JSON reader — with
        // the SECOND ORACLE certifying a DOM-blind semantic date column. If it
        // emits a verified api recipe, skip recovery entirely.
        widenEnvelopeForFoundCoreFeed(best.audit);
        if (
          args.runStructuredDiscovery && args.snapshotCapturedCalls && args.discoveryState
          && !args.discoveryState.earlyAttempted
          && best.success.action.parse.mode === 'table' && !best.success.viaBail
          && structurallySoundForDiscovery(best.audit, args.actionName as keyof Recipe['actions'])
        ) {
          // Snapshot captured calls ONCE, at the first committable emit — the
          // 50-slot LRU evicts the feed's JSON during the multi-minute recovery
          // that may follow, so a late capture.recent() could miss it.
          if (!earlyCapturedCalls) earlyCapturedCalls = args.snapshotCapturedCalls();
          if (earlyCapturedCalls.length > 0) {
            args.discoveryState.earlyAttempted = true;
            const feedPageUrl = best.audit.pageUrl;
            const upgraded = await args.runStructuredDiscovery(best.success, earlyCapturedCalls, feedPageUrl);
            if (upgraded) {
              log.info('mapper: early structured discovery upgraded a blind feed to api — skipping paid recovery', {
                jobId: args.jobId ?? undefined,
                actionName: args.actionName,
              });
              return upgraded;
            }
            // Abstained: discovery navigated to postLoginUrl for its replay
            // context and does NOT restore the feed page. The Stage-1 re-ask /
            // drill below MUST continue from the FEED page, not the dashboard
            // (review P0-3) — navigate back before proceeding.
            if (safeUrl(args.page) !== feedPageUrl) {
              await safeGoto(args.page, feedPageUrl, {
                allowedHost: new URL(args.credentials.loginUrl).host,
                context: 'mapper:earlydiscovery:restore',
              }).catch(() => {});
              await args.page.waitForTimeout(500);
            }
          }
        }

        // Stage 1 — focused on-page re-ask. Bounded by MAX_COMPLETENESS_REASKS
        // plus the surrounding step/cost/wallclock/token caps (this `continue`
        // re-enters the same capped for-loop).
        if (completenessReasks < MAX_COMPLETENESS_REASKS) {
          completenessReasks++;
          log.warn('mapper: required columns blank/dead — focused recovery re-ask', {
            actionName: args.actionName,
            outstanding: Object.fromEntries(audit.outstanding),
            attempt: completenessReasks,
            maxAttempts: MAX_COMPLETENESS_REASKS,
            valueVerified: audit.verified,
          });
          // Same rewind idiom as the unavailable / ask_admin branches: pop the
          // assistant turn that emitted the incomplete JSON, push a user-turn
          // hint, reset the exploration floor, re-enter the agent loop.
          messages.pop();
          messages.push({
            role: 'user',
            content: [{
              type: 'text',
              text: buildRecoveryHint(
                args.actionName as keyof Recipe['actions'],
                audit.problems,
                completenessReasks,
                MAX_COMPLETENESS_REASKS,
              ),
            }],
          });
          readPageCount = 0;
          navigationCount = 0;
          // The re-ask is a deliberate new instruction — the model re-reading
          // the same row is NOT a stuck loop, so reset the loop detector so the
          // re-ask turns can't false-trip it and abort a recoverable feed.
          loopDetector = new ActionLoopDetector();
          continue;
        }

        // Stage 2 — the value likely isn't in the list view at all. Open ONE
        // sample record, map the missing column(s) on its detail page, and
        // mechanically verify on a second record. Hard-bounded: at most once
        // per action, RECOVERY_DRILL_STEP_CAP turns, its own $0.60 envelope
        // measured from drill start (deliberately EXEMPT from the per-target
        // soft-abort, which is typically already spent by now; the job cost
        // cap, wallclock and token ceilings still apply).
        // fix/cua-two-oracle (build #3) — no longer gated on `best.audit.verified`:
        // the verified-page guarantee MOVES into drillPreconditions, which fails
        // closed unless best.audit has ≥2 distinct-key probe rows — and only a
        // VALUE-verified audit produces probe rows (structuralOnly returns []).
        // So an unverified/wandered audit still cannot drive the drill, but a
        // feed whose latest emit degraded yet has a verified BEST candidate now
        // recovers its missing column from a record page (the no-backend-JSON
        // path, incl. Choice Advantage arrivals).
        if (!recoveryDrillAttempted) {
          recoveryDrillAttempted = true;
          const pre = drillPreconditions(args.actionName as keyof Recipe['actions'], best.audit);
          if (pre.ok) {
            // The drill MUST run against the page the best candidate was
            // VERIFIED on — its rowSelector/probeRows/sampleKey describe that
            // page, and drillDown.listUrl is persisted from it. The model may
            // have wandered since (code review P1) — navigate back first.
            const feedPageUrl = best.audit.pageUrl;
            if (args.page.url() !== feedPageUrl) {
              await safeGoto(args.page, feedPageUrl, {
                allowedHost: new URL(args.credentials.loginUrl).host,
                context: 'mapper:colrecovery:tofeed',
              }).catch(() => {});
              await args.page.waitForTimeout(800);
            }
            const drill = await mapMissingColumnsViaDrilldown({
              page: args.page,
              actionName: args.actionName,
              credentials: args.credentials,
              propertyId: args.propertyId,
              jobId: args.jobId,
              signal: args.signal,
              model: args.model,
              jobCostCapMicros: args.jobCostCapMicros,
              feedPageUrl,
              rowSelector: best.success.action.parse.mode === 'table'
                ? best.success.action.parse.hint.rowSelector
                : parsed.rowSelector,
              missingCols: [...best.audit.outstanding.keys()],
              probeRows: best.audit.probeRows,
              payloadEnums: best.success.enumMappings,
              provisionalDateFormat: args.provisionalDateFormat,
              deadlineAt: phaseStartedAt + helpWaitMs + PHASE_WALLCLOCK_BUDGET_MS,
              tokensAlreadyUsed: totalInputTokens,
            });
            totalInputTokens += drill.tokensUsed;
            // Back to the feed page either way — the Learning Board preview
            // reads the CURRENT page right after mapActionCore returns.
            await safeGoto(args.page, feedPageUrl, {
              allowedHost: new URL(args.credentials.loginUrl).host,
              context: 'mapper:colrecovery:return',
            }).catch(() => {});
            await args.page.waitForTimeout(800);
            if (drill.ok && drill.drillDown) {
              log.info('mapper: recovered required column(s) from the record detail page', {
                actionName: args.actionName,
                recovered: Object.keys(drill.drillDown.detailColumns),
                template: drill.drillDown.detailUrlTemplate,
              });
              return finalizeRecoveredSuccess(best, drill);
            }
            log.warn('mapper: detail-page column recovery failed — feed keeps honest gaps', {
              actionName: args.actionName,
              reason: drill.reason,
            });
          } else {
            log.warn('mapper: detail-page column recovery skipped — preconditions unmet', {
              actionName: args.actionName,
              reason: pre.reason,
            });
          }
        }

        // Recovery budget spent: ship the best candidate with residual gaps
        // applied honestly (missing/dead/rejected → blank selector so the
        // promotion gate parks the feed and the daily backfill retries;
        // `unparseable` keeps its selector — see finalizeRecoveredSuccess).
        return finalizeRecoveredSuccess(best);
      }
      // "Unavailable" path: agent explored, found nothing, told us so.
      // Plan v7 — require evidence of real effort before accepting it.
      // Without this floor, a lazy/confused agent can emit unavailable on
      // its first response and burn the per-target cost cap on a fake
      // "this PMS tier doesn't have it" outcome that fools auto-promotion.
      if (parsed && parsed.unavailable === true) {
        // feature/cua-column-recovery — a cornered model can flip to
        // `unavailable` mid-recovery. We HAVE a verified table by then;
        // dropping it would quarantine a feed that exists. Commit the best
        // candidate instead of believing the claim.
        if (lastGoodAction) {
          return bail('agent claimed unavailable after a table was already found (recovery fatigue)');
        }
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
          // Takeover: execute the founder's click FIRST (recorded as a
          // recipe step via executeVisionAction — replay must include it).
          let hintText = helpOutcome.hintText;
          if (helpOutcome.supervisorClick) {
            const sup = await executeSupervisorClick({
              page: args.page,
              credentials: args.credentials,
              click: helpOutcome.supervisorClick,
              adminNote: helpOutcome.hintText,
              jobId: args.jobId,
              targetKey: args.actionName,
            });
            if (sup.recordedStep) recordedSteps.push(sup.recordedStep);
            hintText = sup.hintText;
          }
          messages.pop();
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `Hint from your supervisor: ${hintText}\n\nContinue working on this target.` }],
          });
          readPageCount = 0;
          navigationCount = 0;
          helpWaitMs += helpOutcome.waitedMs;
          continue;
        }
        if (helpOutcome.kind === 'abort') {
          throw new Error(helpOutcome.reason);
        }
        return {
          ok: false,
          reason: helpOutcome.reason,
          finalUrl: args.page.url(),
          // Floor-met branch: the agent itself declared this feed
          // unavailable after real exploration (admin may have confirmed).
          unavailable: true,
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
          let hintText = helpOutcome.hintText;
          if (helpOutcome.supervisorClick) {
            const sup = await executeSupervisorClick({
              page: args.page,
              credentials: args.credentials,
              click: helpOutcome.supervisorClick,
              adminNote: helpOutcome.hintText,
              jobId: args.jobId,
              targetKey: args.actionName,
            });
            if (sup.recordedStep) recordedSteps.push(sup.recordedStep);
            hintText = sup.hintText;
          }
          messages.pop();
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `Hint from your supervisor: ${hintText}\n\nContinue working on this target.` }],
          });
          readPageCount = 0;
          navigationCount = 0;
          helpWaitMs += helpOutcome.waitedMs;
          continue;
        }
        if (helpOutcome.kind === 'abort') {
          throw new Error(helpOutcome.reason);
        }
        // feature/cua-column-recovery — same fatigue guard as the
        // unavailable branch: never drop an already-found table.
        if (lastGoodAction) {
          return bail('agent gave up via ask_admin after a table was already found');
        }
        return {
          ok: false,
          reason: helpOutcome.reason,
          finalUrl: args.page.url(),
          // ask_admin branch: the agent only asked a question — "unavailable"
          // is true only when an admin explicitly said the PMS lacks it.
          ...(helpOutcome.viaAdmin ? { unavailable: true } : {}),
        };
      }
      // feature/cua-column-recovery — prose/garbage mid-recovery must commit
      // the best verified table, not throw the feed away.
      if (lastGoodAction) {
        return bail(`no usable JSON after recovery re-ask — agent said: ${finalText.slice(0, 120)}`);
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
      if (exec.recordedStep) {
        recordedSteps.push(exec.recordedStep);
        // feature/cua-feed-extract — anchor the landing URL right after THIS
        // action too, not only at the turn top. A single turn can batch a
        // navigating click followed by an in-page click (e.g. open a report,
        // then a "Generate"/filter click that keeps the URL); recording the
        // goto here keeps it BEFORE the later click so that click survives as a
        // replayable pre-step instead of being stranded after a trailing goto.
        // Zero added latency (just a URL read); the turn-top call stays the
        // backstop for a navigation that only commits after this point.
        recordLandingGoto(recordedSteps, safeUrl(args.page));
      }
      // feature/cua-live-view — tee the (already privacy-hardened)
      // screenshot to the Learning Board's live view. Fire-and-forget.
      if (exec.screenshotB64) args.onLiveFrame?.(exec.screenshotB64);

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
            // Commit-aware note (fix/cua-mapper-commit): a no-op click while the
            // agent is ALREADY on the right page used to read as "you failed to
            // reach the target — reconsider", nudging it to wander off a correct
            // page. Reframe as commit-or-redirect: if a matching table is already
            // visible, commit; otherwise go back and try a different link.
            const note =
              `Critic note: that click did not visibly move you forward. ${verdict.reason} ` +
              `If you are ALREADY looking at a table/list whose columns match this feed's ` +
              `required fields, stop clicking and emit the success JSON now (an empty table ` +
              `is a valid capture). Otherwise return to the dashboard and try a different link.\n\n`;
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

    // fix/cua-mapper-commit — deterministic commit-nudge. Decided BEFORE the
    // loop-detector trip check (which can `bail` and return) so the reminder is
    // actually delivered this turn, and a nudge turn RESETS the loop detector
    // (seeded with this turn's tuples) so the freshly-reminded model gets a clean
    // leg instead of racing the 4th-identical-tuple trip — same idiom as the
    // recovery re-ask. Cheap gates run first; the page-fingerprint + structural
    // probes run only on a genuine candidate turn. The page must be UNCHANGED
    // across the turn (post-action fingerprint == the pre-action one the streak
    // was built on) so a turn that navigated — or an SPA route swap that kept the
    // URL — can't inherit a stale streak and get nudged on a page just reached.
    // The nudge is model-mediated: the model still emits selectors and the column
    // audit still verifies them, so it can never by itself commit a wrong page.
    let commitNudgeText: string | null = null;
    if (nudgeEligibleTarget && samePageStreak >= COMMIT_DITHER_TURNS) {
      const turnEndUrl = safeUrl(args.page);
      // Exclude the dashboard — a 2-column summary tile must never be nudged into
      // a feed (the structural probe alone can't tell a totals tile from a feed).
      if (turnEndUrl !== '' && !isDashboardUrl(turnEndUrl, args.postLoginUrl)) {
        const turnEndFingerprint = await pageFingerprint(args.page);
        if (
          turnEndFingerprint === turnPageFingerprint &&
          !commitNudgedFingerprints.has(turnEndFingerprint)
        ) {
          const structure = await summarizeTabularStructure(args.page);
          if (shouldNudgeCommit({ samePageStreak, structure, alreadyNudgedThisPage: false })) {
            commitNudgedFingerprints.add(turnEndFingerprint);
            commitNudgeText = buildCommitNudge({
              actionName: args.actionName,
              requiredFields: args.requiredFields,
              structure,
            });
            log.info('mapper: structural commit-nudge fired — reminding agent to capture', {
              jobId: args.jobId ?? undefined,
              actionName: args.actionName,
              stepIdx,
              samePageStreak,
              columns: structure.maxColumns,
              dataRows: structure.maxDataRows,
            });
          }
        }
      }
    }

    if (commitNudgeText) {
      // Deliberate intervention — reset the loop detector so the reminded model
      // gets a clean leg (mirrors the deliberate-backtrack + recovery-re-ask
      // resets). Seed it with THIS turn's tuples so the reset clears the dithering
      // history but does NOT grant a free pass: if the model ignores the reminder
      // and keeps repeating, the fresh detector still converges and trips.
      loopDetector = new ActionLoopDetector();
      for (const toolUse of toolUses) {
        loopDetector.record(actionFingerprint(toolUse.input), turnPageFingerprint);
      }
    } else {
      // Loop-detector input #2 — record each toolUse's (action, page) tuple and
      // abort if any one trips the detector. Page fingerprint is
      // `turnPageFingerprint` from above (the state Claude reasoned on), not the
      // post-action state — we're detecting "agent keeps trying the same thing on
      // the same starting state", which is the canonical stuck-in-a-loop pattern.
      for (const toolUse of toolUses) {
        const stuck = loopDetector.record(actionFingerprint(toolUse.input), turnPageFingerprint);
        if (stuck.stuck) {
          log.warn('mapper: action-loop detector tripped — aborting target', {
            jobId: args.jobId ?? undefined,
            actionName: args.actionName,
            stepIdx,
            reason: stuck.reason,
          });
          return bail('loop detector tripped');
        }
      }
    }

    // The commit-nudge rides along as a trusted supervisor text block AFTER the
    // tool_result blocks (API-valid: tool results lead the user turn, extra
    // text/image blocks may follow). Same trusted-instruction channel as the
    // recovery re-ask / supervisor-hint user turns — it carries only our own
    // required-field names + generic guidance, never any PMS-derived page text.
    const userTurnContent: Anthropic.Messages.ContentBlockParam[] = [...toolResults];
    if (commitNudgeText) {
      userTurnContent.push({ type: 'text', text: commitNudgeText });
    }
    messages.push({ role: 'user', content: userTurnContent });

    // Plan v7 — per-target cost soft-abort. After each round trip, check
    // how much THIS target has spent (current job spend minus the baseline
    // snapped at target start); if it's blown past the per-target cap, set
    // the flag and let the next iteration return cleanly. We DON'T abort
    // mid-call — the in-flight Anthropic call is already paid for, so we
    // let it complete and return whatever it had. Measuring the delta (not
    // cumulative job spend) means late targets still get their full
    // per-target budget instead of being aborted with zero exploration.
    // fix/cua-two-oracle — compare against the EFFECTIVE cap, which is widened
    // (additively, by one drill envelope) once a committable core table is
    // found, so certification isn't guillotined mid-flight. Until a table is
    // found it equals the base cap, so a LOST feed still stops at the base cap.
    if (args.jobId && effectiveTargetCostCapMicros !== Number.POSITIVE_INFINITY) {
      const totalSpent = await getJobCostMicros(args.jobId);
      const targetSpent = totalSpent - targetStartSpentMicros;
      if (targetSpent > effectiveTargetCostCapMicros) {
        targetOverBudget = true;
      }
    }
  }

  return bail('mapper exhausted step budget');
}

// ─── Blank required-column recovery (feature/cua-column-recovery) ──────────
//
// mapActionCore's success branch calls these. The decision logic (deadness
// classification, value gate, hint text) lives in column-recovery.ts (pure,
// unit-tested); this section is the Playwright/Anthropic glue: probe the live
// page, run the bounded single-record detail drill, and assemble the final
// ActionMapSuccess with residual gaps applied honestly.

export interface PageAudit {
  /** True when value-level verification actually ran (page matched the
   *  emitted URL, extraction worked, ≥1 row). False degrades the audit to
   *  the historical string-only structural check. */
  verified: boolean;
  /** The page URL the audit ran against — stage 2 must drill THIS page, not
   *  whatever the model wandered to afterwards (code review P1). */
  pageUrl: string;
  /** First VALUE_PROBE_ROW_CAP extracted rows — reused by the gate + drill. */
  probeRows: Array<Record<string, string>>;
  totalMatched: number;
  /** column → why it is unrecovered. 'rejected' = a recovery candidate that
   *  failed the value gate (its selector must not ship — wrong values are
   *  worse than blanks). */
  outstanding: Map<string, 'missing' | 'dead' | 'unparseable' | 'rejected'>;
  /** feature/cua-prove-columns — required columns that SHIP (selector kept,
   *  non-blank) but could NOT be value-certified because the page yielded no
   *  value evidence (empty feed / wandered / probe failure, i.e. verified=false).
   *  Distinct from `outstanding`: these keep their selector (they may be correct)
   *  but must never auto-promote — the promotion gate routes them to founder
   *  review. Optional so hand-built test audits stay valid. */
  uncertain?: Set<string>;
  problems: RecoveryProblem[];
  /** feature/cua-semantic-columns — the live header row captured on the feed
   *  page during this audit (when we were confident we're on the right page).
   *  finalizeRecoveredSuccess uses it to author per-column header anchors. Absent
   *  on degraded/structural audits where the page wasn't trustworthy. */
  headers?: CapturedTableHeaders;
}

// fix/cua-two-oracle — INERT query params that spuriously differ between the
// model's reported URL and the live URL (cache busters, session/CSRF tokens,
// volatile timestamps). Stripped ONLY for the audit's same-page comparison.
// SEMANTIC params (type=arrival, view=…, date=…) are KEPT — so a page that
// differs by a real query param is NOT treated as the same page (a departures
// page must never audit/drill as arrivals). Weak generic names count as inert
// only when their value is numeric (a timestamp/version, not `t=arrivals`).
const AUDIT_INERT_PARAMS_STRONG = new Set([
  '_', '_t', 'cb', 'nocache', 'cachebuster', 'rnd', 'rand', '__rnd', 'cache',
  'jsessionid', 'phpsessid', 'sid', 'sessionid', 'session', 'csrf', 'csrftoken',
  'xsrf', '_csrf', 'authenticity_token',
]);
const AUDIT_INERT_PARAMS_WEAK = new Set(['ts', 't', 'r', 'v']);

/** Normalize a URL for the audit's same-page check: drop the hash, a trailing
 *  slash, and inert params; sort the rest so param order can't matter. On an
 *  unparseable URL, fall back to a hash-stripped raw string (today's behavior).
 *  PURELY about URL shape — no PMS vocabulary. */
export function normalizeUrlForAudit(u: string): string {
  let parsed: URL;
  try { parsed = new URL(u); } catch { return u.split('#')[0] ?? u; }
  const kept: Array<[string, string]> = [];
  for (const [k, v] of parsed.searchParams) {
    const lower = k.toLowerCase();
    if (AUDIT_INERT_PARAMS_STRONG.has(lower)) continue;
    // Weak generic names (t, v, r, ts) are inert ONLY when their value is
    // cache-buster-shaped (≥6-digit epoch or a float) — a SMALL integer like
    // t=2 is almost certainly a semantic tab/page selector (arrivals vs
    // departures) and MUST be kept (Codex review high finding).
    if (AUDIT_INERT_PARAMS_WEAK.has(lower) && /^\d{6,}$|^\d+\.\d+$/.test(v)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  const path = parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  const query = kept.map(([k, v]) => `${k}=${v}`).join('&');
  return `${parsed.origin}${path}${query === '' ? '' : `?${query}`}`;
}

/**
 * fix/cua-two-oracle — is a feed's audit a COMMITTABLE table worth running
 * backend-JSON discovery against (and worth widening the cost envelope for)?
 * "Structurally sound" = value-verified audit (so probeRows reflect the real
 * page), a readable+distinct key column on the probe rows, and ≥ the discovery
 * row floor. PURELY shape/contract — no PMS vocabulary. This is exactly the
 * precondition early discovery needs (a key to bijection against ≥MIN rows),
 * and the gate for the cost-envelope widening so a LOST feed (no committable
 * table) still stops at the base cap.
 */
export function structurallySoundForDiscovery(
  audit: PageAudit,
  actionKey: keyof Recipe['actions'],
): boolean {
  if (!audit.verified) return false;
  const keyCol = DISCOVERY_KEY_COLUMNS[actionKey];
  if (!keyCol) return false;
  if (audit.outstanding.has(keyCol)) return false; // key itself blind → not sound
  if (audit.totalMatched < MIN_ORACLE_ROWS) return false;
  const keys = audit.probeRows.map((r) => (r[keyCol] ?? '').trim()).filter((v) => v !== '');
  return new Set(keys).size >= 2;
}

async function auditLearnedColumnsOnPage(args: {
  page: Page;
  actionKey: keyof Recipe['actions'];
  emittedUrl: string | null;
  rowSelector: string;
  columns: Record<string, string>;
  payloadEnums?: Record<string, Record<string, string>>;
  payloadSamples?: Record<string, string[]>;
  provisionalDateFormat?: LearnedDateFormat;
  pendingRecovery: Set<string>;
}): Promise<PageAudit> {
  const outstanding = new Map<string, 'missing' | 'dead' | 'unparseable' | 'rejected'>();
  const problems: RecoveryProblem[] = [];
  const pageUrl = args.page.url();
  const todayIso = new Date().toISOString().slice(0, 10);

  if (requiredLearnedFor(args.actionKey).length === 0) {
    // Non-core target — not column-gated, nothing to verify.
    return { verified: false, pageUrl, probeRows: [], totalMatched: 0, outstanding, problems };
  }

  // feature/cua-semantic-columns — the live header row, captured below once we've
  // confirmed we're on the right feed page. Threaded into EVERY audit return from
  // that point (incl. the empty-feed structural path) so finalize can author
  // header anchors even for a feed that's empty today. Closure-captured by
  // structuralOnly; undefined until the capture line, so the wandered-page return
  // above structuralOnly's capture never carries (stale) headers.
  let capturedHeaders: CapturedTableHeaders | undefined;

  const structuralOnly = (reason: string): PageAudit => {
    for (const col of missingRequiredColumns(args.actionKey, args.columns)) {
      outstanding.set(col, 'missing');
      problems.push({ column: col, kind: 'missing' });
    }
    // Columns ALREADY under recovery stay suspect on a degraded audit: their
    // selector strings being non-blank is exactly the evidence verification
    // already proved insufficient. Without this, a wandered page or failed
    // probe mid-recovery would bless a junk selector (code review P1).
    for (const col of args.pendingRecovery) {
      if (outstanding.has(col)) continue;
      if (!(col in args.columns)) continue;
      outstanding.set(col, 'rejected');
      problems.push({
        column: col,
        kind: 'rejected',
        detail: `could not re-verify (${reason}) — return to the feed page and re-emit from there`,
      });
    }
    // feature/cua-prove-columns — every OTHER required column that still ships
    // (present, non-blank, not already flagged) is UNCERTAIN: a structural-only
    // audit gathered zero value evidence (empty feed today / wandered page /
    // probe failure), so its selector — though it may be perfect — was never
    // proven. Keep the selector (don't blank a possibly-correct column) but mark
    // it unproven so the promotion gate parks the feed for founder review instead
    // of auto-promoting a guessed column. certifyColumns is the single source of
    // the verdict semantics (hasValueEvidence:false → uncertain).
    const uncertain = new Set<string>();
    const unjudged = requiredLearnedFor(args.actionKey).filter(
      (col) => !outstanding.has(col) && (args.columns[col] ?? '').trim() !== '',
    );
    for (const [col, v] of certifyColumns({
      actionKey: args.actionKey,
      columns: unjudged,
      allValues: {},
      allSelectors: args.columns,
      todayIso,
      hasValueEvidence: false,
    })) {
      if (v.verdict === 'uncertain') uncertain.add(col);
    }
    log.info('mapper: column audit degraded to structural check', {
      actionName: args.actionKey, reason,
      outstanding: [...outstanding.keys()], uncertain: [...uncertain],
    });
    return { verified: false, pageUrl, probeRows: [], totalMatched: 0, outstanding, uncertain, problems, ...(capturedHeaders ? { headers: capturedHeaders } : {}) };
  };

  // Wandered-page guard: the model can emit its JSON after navigating away;
  // probing the wrong page would poison every classification below.
  // fix/cua-two-oracle (build #3) — normalize BOTH urls (drop hash, trailing
  // slash, inert cache-buster/session params) before comparing, so a SPURIOUS
  // diff (the model reported the URL with a stale cache-buster / session id)
  // no longer demotes the audit to structural-only and silently blocks the
  // detail-drill. A genuine page difference (different path, or a SEMANTIC
  // query param like type=arrival) still demotes — we never audit a wandered
  // page, and never re-scrape the current one (that would bless a wrong page).
  if (args.emittedUrl) {
    if (normalizeUrlForAudit(args.page.url()) !== normalizeUrlForAudit(args.emittedUrl)) {
      return structuralOnly(`page url ${args.page.url().slice(0, 80)} differs from emitted url`);
    }
  }

  // feature/cua-semantic-columns — capture the header row now that the page is
  // confirmed to be the feed page. Best-effort (null on failure); finalize only
  // authors anchors when the header gate passes, so a missing/spanning header
  // simply yields no tiered shape (positional-only, exactly as today).
  capturedHeaders = (await readTableHeaders(args.page, args.rowSelector)) ?? undefined;

  let extraction: { rows: Array<Record<string, string>>; totalMatched: number };
  try {
    extraction = await extractDomRows(args.page, args.rowSelector, args.columns, { cap: DEADNESS_ROW_CAP });
  } catch (err) {
    return structuralOnly(`probe extraction failed: ${(err as Error).message.slice(0, 120)}`);
  }
  if (extraction.rows.length === 0) {
    // Legitimately empty feed today (no arrivals / no work orders) or a
    // non-DOM page — value checks are vacuous either way.
    return structuralOnly('zero rows matched on the page');
  }

  // The gate parses with the SAME config the runtime will get: pooled date
  // order so far, refined by THIS payload's own date samples, plus the
  // payload's sanitized enum mappings.
  const payloadDateSamples: string[] = [];
  for (const col of CORE_TARGET_CONTRACTS[args.actionKey]?.columns ?? []) {
    if (col.type !== 'date') continue;
    const s = args.payloadSamples?.[col.name];
    if (Array.isArray(s)) payloadDateSamples.push(...s);
  }
  const provisional = pickDateFormat(inferDateFormat(payloadDateSamples), args.provisionalDateFormat);
  const learned = learnedForGate(args.actionKey, args.payloadEnums, provisional);

  const audit = auditRequiredColumns(args.actionKey, args.columns, extraction.rows, learned);
  for (const col of audit.structurallyMissing) {
    outstanding.set(col, 'missing');
    problems.push({ column: col, kind: 'missing' });
  }
  for (const col of audit.dead) {
    outstanding.set(col, 'dead');
    problems.push({ column: col, kind: 'dead', probedRows: extraction.rows.length });
  }
  for (const col of audit.unparseable) {
    outstanding.set(col, 'unparseable');
    problems.push({ column: col, kind: 'unparseable', probedRows: extraction.rows.length });
  }

  // Value checks (both the recovery re-ask gate AND first-emission certification)
  // run over the FULL deadness window (extraction.rows, ≤ DEADNESS_ROW_CAP), NOT
  // the 8-row probe: a legitimately SPARSE required column (out_of_order set on 1
  // row in 50) is blank in the first 8 rows but real — judging it on the probe
  // alone would `all_blank`-reject a correct selector. The full window makes the
  // gate's all-blank verdict consistent with auditRequiredColumns' deadness scan
  // (a truly empty column is already classified 'dead' above). probeRows is kept
  // only for the RETURNED audit (the drill's per-record URL templating).
  const probeRows = extraction.rows.slice(0, VALUE_PROBE_ROW_CAP);
  const allValues: Record<string, string[]> = {};
  for (const col of Object.keys(args.columns)) {
    allValues[col] = extraction.rows.map((r) => (r[col] ?? '').trim());
  }

  // Columns kept (selector present, non-blank) but NOT value-certified: they must
  // not auto-go-live unproven, yet blanking them could erase a correct selector
  // or cascade to quarantine — so they keep the selector and route to founder
  // review via the promotion gate's unprovenRequiredColumns. Shared by both loops.
  const uncertain = new Set<string>();

  // Acceptance gate for columns ALREADY under recovery that now extract something
  // (the focused re-ask loop owns these). A `semantic_date_window` miss is the ONE
  // failure down-ranked to uncertain (keep + park) rather than rejected (blank):
  // a CORRECT date column re-learned on a rolling multi-day arrivals/departures
  // view trips it, and blanking a correct column could cascade to quarantine —
  // identical treatment to the first-emission path below. Every other failure is
  // a strong wrong-column signal → 'rejected' (blank + keep recovering).
  for (const col of args.pendingRecovery) {
    if (outstanding.has(col)) continue;
    if (!(col in args.columns)) continue;
    const verdict = gateRecoveredColumn({
      actionKey: args.actionKey,
      column: col,
      values: allValues[col] ?? [],
      allValues,
      selector: args.columns[col] ?? '',
      allSelectors: args.columns,
      learned,
      todayIso,
    });
    if (!verdict.ok) {
      if (verdict.reason.startsWith('semantic_date_window')) {
        uncertain.add(col);
      } else {
        outstanding.set(col, 'rejected');
        problems.push({ column: col, kind: 'rejected', detail: verdict.reason });
      }
    }
  }

  // feature/cua-prove-columns — FIRST-EMISSION certification. Previously a clean
  // first emission returned here after only the missing/dead/unparseable audit,
  // so a wrong-but-plausible required column on a plain HTML table (a swapped
  // check-in/check-out, a rate cell mapped to a date column, a status string
  // mapped to the key) shipped silently — the JSON-oracle path proves columns,
  // the DOM path did not. Run the SAME strong value checks on every required
  // column that still ships clean (present, non-blank, never flagged, and not
  // already owned by the recovery loop above).
  //   - 'failed' → BLANK + recover (worse-than-blank: a provably wrong selector
  //     must not ship): joins `outstanding` as 'rejected', exactly like a recovery
  //     rejection — it enters the focused re-ask loop and, if unrecovered,
  //     finalizes BLANK (→ a promotion-gate gap).
  //   - 'uncertain' → KEEP the selector but record it unproven: a plain-text
  //     column we can't corroborate (thin/constant/mirrors another column), or a
  //     date column that only tripped the soft semantic-window heuristic on a
  //     wider-than-today feed — both may be correct, so never blank them; the
  //     promotion gate parks the feed for founder review instead.
  const unjudged = requiredLearnedFor(args.actionKey).filter(
    (col) =>
      !outstanding.has(col) &&
      !args.pendingRecovery.has(col) &&
      (args.columns[col] ?? '').trim() !== '',
  );
  for (const [col, verdict] of certifyColumns({
    actionKey: args.actionKey,
    columns: unjudged,
    allValues,
    allSelectors: args.columns,
    learned,
    todayIso,
    hasValueEvidence: true,
  })) {
    if (verdict.verdict === 'failed') {
      outstanding.set(col, 'rejected');
      problems.push({ column: col, kind: 'rejected', detail: `first-emission: ${verdict.reason}` });
    } else if (verdict.verdict === 'uncertain') {
      uncertain.add(col);
    }
  }

  return { verified: true, pageUrl, probeRows, totalMatched: extraction.totalMatched, outstanding, uncertain, problems, ...(capturedHeaders ? { headers: capturedHeaders } : {}) };
}

/**
 * Final ActionMapSuccess for a recovery-audited candidate. Residual policy
 * (plan review P1-6): 'missing'/'dead'/'rejected' columns ship BLANK — the
 * promotion gate parks the feed honestly and the daily backfill retries;
 * shipping a selector that verified dead/wrong would either churn paid
 * self-repairs (runtime blank-guard) or write wrong values. 'unparseable'
 * keeps its selector: the classification needs ≥3 zero-parse samples, but a
 * different day's rows may parse, and the runtime nulls junk per-row anyway.
 * With a successful drill, the recovered columns ride drillDown.detailColumns
 * and the drillDown's listColumns mirror the finalized map (the eligibility
 * predicate resolves placeholders against it).
 */
/**
 * feature/cua-semantic-columns — author the DURABLE per-column HEADER anchors
 * from the live header row captured during the audit. For each FINAL column whose
 * positional css carries a rebaseable `:nth-child(K)` AND whose K maps to a
 * non-blank header cell, emit a TieredSelector { roleName:{role,name:<header>},
 * css }. The flat `columns` map is always still written; this is purely additive.
 *
 * Returns {} (no tiered shape) when the header gate fails (no header row /
 * colspan / header-vs-body cell-count mismatch) or no column resolves an anchor —
 * so headerless feeds (CA housekeeping center, scalar inline feeds) and legacy
 * recipes keep their exact positional-only shape and replay byte-identically.
 */
function buildColumnHeaderAnchors(
  columns: Record<string, string>,
  rowSelector: string,
  headers: CapturedTableHeaders | undefined,
): { columnsTiered?: Record<string, TieredSelector>; rowSelectorTiered?: TieredSelector } {
  if (!headers || !headerGateOk(headers)) return {};
  const textByIndex = new Map<number, string>();
  for (const c of headers.cells) {
    if (c.index >= 1 && c.raw.trim() !== '') textByIndex.set(c.index, c.raw);
  }
  const tiered: Record<string, TieredSelector> = {};
  let any = false;
  for (const [field, cssRaw] of Object.entries(columns)) {
    const css = (cssRaw ?? '').trim();
    if (css === '') continue;            // blanked/dead column — no anchor
    const idx = parseFirstNthIndex(css);
    if (idx == null) continue;            // non-positional (class/attr) — reorder-immune
    const headerText = textByIndex.get(idx);
    if (!headerText) continue;            // no header text at that column index
    tiered[field] = { roleName: { role: headers.roleKind, name: headerText }, css };
    any = true;
  }
  if (!any) return {};
  return { columnsTiered: tiered, rowSelectorTiered: { css: rowSelector } };
}

export function finalizeRecoveredSuccess(
  candidate: { success: ActionMapSuccess; audit: PageAudit },
  drill?: RecoveryDrillResult,
): ActionMapSuccess {
  const { success, audit } = candidate;
  if (success.action.parse.mode !== 'table') return success;
  const hint = success.action.parse.hint;
  const finalColumns: Record<string, string> = { ...hint.columns };
  for (const [col, cls] of audit.outstanding) {
    if (cls === 'unparseable') continue;
    finalColumns[col] = '';
  }
  const drillDown = drill?.ok && drill.drillDown
    ? { ...drill.drillDown, listColumns: finalColumns }
    : undefined;
  // Per-COLUMN deep merge — a drill's mapping for a column must extend, not
  // replace, vocabulary the list turn already learned (code review P1).
  const enumMappings: Record<string, Record<string, string>> = { ...(success.enumMappings ?? {}) };
  for (const [col, mapping] of Object.entries(drill?.enumMappings ?? {})) {
    enumMappings[col] = { ...(enumMappings[col] ?? {}), ...mapping };
  }
  const valueSamples: Record<string, string[]> = { ...(success.valueSamples ?? {}) };
  for (const [col, samples] of Object.entries(drill?.valueSamples ?? {})) {
    valueSamples[col] = [...new Set([...(valueSamples[col] ?? []), ...samples])];
  }

  // feature/cua-prove-columns — record required columns that SHIP but were NOT
  // value-certified, so the promotion gate refuses to auto-promote them (it
  // parks the feed for founder review instead of letting a guessed column go
  // live). Two kinds, both keep their selector: (1) `uncertain` — no value
  // evidence existed (empty/unreadable feed at onboarding); (2) `unparseable` —
  // present but parsed as the wrong type on every sampled row (residual policy
  // keeps the selector for a different-day retry, but it must not auto-go-live).
  // A column the drill recovered on the detail page is proven-by-drill → excluded.
  // Filtered to columns still non-blank in the finalized map. Empty/absent ⟹
  // proven, so legacy recipes and fully-certified feeds keep their exact shape.
  const drilledColumns = new Set(
    drill?.ok && drill.drillDown ? Object.keys(drill.drillDown.detailColumns) : [],
  );
  const unproven = new Set<string>(audit.uncertain ?? []);
  for (const [col, cls] of audit.outstanding) {
    if (cls === 'unparseable') unproven.add(col);
  }
  const unprovenRequiredColumns = [...unproven].filter(
    (col) => !drilledColumns.has(col) && (finalColumns[col] ?? '').trim() !== '',
  );

  // feature/cua-semantic-columns — author header anchors against the FINAL
  // (post-recovery) list columns + the header row captured during the audit.
  // Written alongside the flat columns; absent ⟹ positional-only (back-compat).
  const headerAnchors = buildColumnHeaderAnchors(finalColumns, hint.rowSelector, audit.headers);

  const action: ActionRecipe = {
    ...success.action,
    parse: { mode: 'table', hint: { ...hint, columns: finalColumns, ...headerAnchors } },
    ...(drillDown ? { drillDown } : {}),
  };
  if (unprovenRequiredColumns.length > 0) {
    (action as ColumnProofCarrier).unprovenRequiredColumns = unprovenRequiredColumns;
  }

  return {
    ...success,
    action,
    ...(Object.keys(valueSamples).length > 0 ? { valueSamples } : {}),
    ...(Object.keys(enumMappings).length > 0 ? { enumMappings } : {}),
  };
}

/** Cheap pre-checks so a doomed drill never spends a single model turn. */
export function drillPreconditions(
  actionKey: keyof Recipe['actions'],
  audit: PageAudit,
): { ok: true; keyColumn: string } | { ok: false; reason: string } {
  const keyColumn = DISCOVERY_KEY_COLUMNS[actionKey];
  if (!keyColumn) return { ok: false, reason: 'no key column configured for this target' };
  // fix/cua-two-oracle — explicit fail-closed: the drill builds a per-record URL
  // template from probeRows, which only a VALUE-verified audit produces (a
  // structural-only/wandered audit returns probeRows:[]). Belt-and-suspenders so
  // the drill can never anchor on stale rows from an unverified audit, now that
  // the caller no longer pre-gates on audit.verified (Codex review).
  if (!audit.verified) return { ok: false, reason: 'audit not value-verified — cannot anchor a detail URL template' };
  if (audit.outstanding.has(keyColumn)) {
    return {
      ok: false,
      reason: `key column ${keyColumn} is itself unrecovered — per-row detail URLs cannot be anchored`,
    };
  }
  const keys = audit.probeRows
    .map((r) => (r[keyColumn] ?? '').trim())
    .filter((v) => v !== '');
  if (keys.length < 2 || new Set(keys).size < 2) {
    return { ok: false, reason: 'need ≥2 probe rows with distinct key values to verify a URL template' };
  }
  if (audit.totalMatched > DETAIL_PER_POLL_MAX) {
    return {
      ok: false,
      reason: `list has ${audit.totalMatched} rows — beyond the runtime's ${DETAIL_PER_POLL_MAX}-row per-poll detail cap`,
    };
  }
  return { ok: true, keyColumn };
}

interface RecoveryDrillResult {
  ok: boolean;
  drillDown?: NonNullable<ActionRecipe['drillDown']>;
  enumMappings?: Record<string, Record<string, string>>;
  valueSamples?: Record<string, string[]>;
  reason?: string;
  tokensUsed: number;
}

/**
 * Stage 2 — recover still-missing required columns from ONE record's detail
 * page. A small focused agent loop (modeled on mapDrillDownAction's machinery
 * but deliberately NOT that function: it re-learns a whole feed from 3 samples
 * at ~3× the cost and would discard the verified list mapping).
 *
 * Trust model: the model only contributes (a) the click path to a detail page
 * and (b) candidate selectors. Everything load-bearing is verified
 * mechanically with Playwright: the detail URL is navigated directly; values
 * are extracted with the shared dom-rows reader and value-gated; the URL
 * template is anchored on the REAL probe row's key (never model-reported row
 * data, which could be hallucinated to match); and the template is proven on
 * a SECOND record before acceptance, including a stale-record check for PMSes
 * that ignore unknown URL params.
 */
async function mapMissingColumnsViaDrilldown(args: {
  page: Page;
  actionName: string;
  credentials: PMSCredentials;
  propertyId: string | null;
  jobId: string | null;
  signal?: AbortSignal;
  model?: MapperModelId;
  jobCostCapMicros?: number;
  feedPageUrl: string;
  rowSelector: string;
  missingCols: string[];
  probeRows: Array<Record<string, string>>;
  payloadEnums?: Record<string, Record<string, string>>;
  provisionalDateFormat?: LearnedDateFormat;
  deadlineAt: number;
  /** Caller's input-token spend so far — the drill shares the action's
   *  MAX_INPUT_TOKENS_PER_RUN ceiling rather than getting a fresh one. */
  tokensAlreadyUsed: number;
}): Promise<RecoveryDrillResult> {
  const cfg = getModeConfig(args.model);
  const actionKey = args.actionName as keyof Recipe['actions'];
  let tokensUsed = 0;
  const fail = (reason: string): RecoveryDrillResult => ({ ok: false, reason, tokensUsed });

  const keyColumn = DISCOVERY_KEY_COLUMNS[actionKey];
  if (!keyColumn) return fail('no key column for target');
  const keyOf = (r: Record<string, string>): string => (r[keyColumn] ?? '').trim();
  const sampleRow = args.probeRows.find((r) => keyOf(r) !== '');
  if (!sampleRow) return fail('no probe row with a non-blank key value');
  const sampleKey = keyOf(sampleRow);
  const verifyRow = args.probeRows.find((r) => keyOf(r) !== '' && keyOf(r) !== sampleKey);
  if (!verifyRow) return fail('need two probe rows with distinct key values');
  const verifyKey = keyOf(verifyRow);

  const allowedHost = new URL(args.credentials.loginUrl).host;
  const costBaseline = args.jobId ? await getJobCostMicros(args.jobId) : 0;

  const expectedLines = args.missingCols
    .map((c) => `  - ${c}: ${expectedShapeFor(actionKey, c)}`)
    .join('\n');
  const prompt =
    `You just mapped the "${args.actionName}" list page at:\n` +
    `  ${args.feedPageUrl}\n` +
    `Rows match the CSS selector \`${args.rowSelector}\`.\n\n` +
    `These REQUIRED fields could NOT be read from the list rows:\n${expectedLines}\n\n` +
    `They should appear on a record's DETAIL page. Do exactly this:\n` +
    `1. Take a SCREENSHOT — you are on the list page.\n` +
    `2. Open the detail page for ONE specific record: the row whose ${keyColumn} ` +
    `is "${sampleKey}". Usually clicking that row, or the id/link cell inside it. ` +
    `Use a read-only VIEW page — never an edit/modify form.\n` +
    `3. On the detail page, take a screenshot and locate each missing field. ` +
    `Build a CSS selector for each (document-level, not row-relative). To read an ` +
    `HTML ATTRIBUTE instead of element text, append @attributeName to the selector — ` +
    `e.g. "input#status@value", ".ooo-flag@title", "a.record-link@href".\n` +
    `4. Reply with FIRST-LINE JSON only (no preamble):\n` +
    `   {"detailUrl":"<the detail page's FULL URL from the address bar>",` +
    `"detailColumns":{"<field>":"<selector>"},` +
    `"enumMappings":{"<field>":{"<raw value as shown>":"<canonical>"}},` +
    `"valueSamples":{"<field>":["<raw value copied exactly>"]}}\n` +
    `   enumMappings only for status/category fields; valueSamples only for date/amount ` +
    `fields. If a field truly is not on the detail page, OMIT it from detailColumns.\n\n` +
    `Budget: at most ${RECOVERY_DRILL_STEP_CAP} actions. Your selectors are verified ` +
    `mechanically on a second record afterwards — a wrong guess is worse than omitting the field.`;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ];
  const drillSteps: RecipeStep[] = []; // recorded for executeVisionAction's contract, then DISCARDED — replay must not include drill clicks
  const loopDet = new ActionLoopDetector();

  for (let stepIdx = 0; stepIdx < RECOVERY_DRILL_STEP_CAP; stepIdx++) {
    if (Date.now() > args.deadlineAt) return fail('wallclock budget exceeded');
    if (args.tokensAlreadyUsed + tokensUsed > MAX_INPUT_TOKENS_PER_RUN) {
      return fail('token budget exceeded');
    }
    const budget = await isJobOverBudget(args.jobId, args.jobCostCapMicros);
    if (budget.over) return fail('job cost cap hit');
    // Per-turn pre-check, same semantics as the per-target soft-abort: the
    // in-flight call is already paid for, so a result that lands ON the turn
    // that crosses the cap is still returned — overshoot is bounded by one
    // turn's cost.
    if (args.jobId) {
      const spent = await getJobCostMicros(args.jobId);
      if (spent - costBaseline > RECOVERY_DRILL_COST_CAP_MICROS) {
        return fail(`recovery drill cost cap ($${(RECOVERY_DRILL_COST_CAP_MICROS / 1_000_000).toFixed(2)}) exceeded`);
      }
    }

    const turnPageFingerprint = await pageFingerprint(args.page);
    const idempotencyKey = args.jobId
      ? `${args.jobId}:colrecovery:${args.actionName}:${stepIdx}`
      : `anon:colrecovery:${args.actionName}:${stepIdx}:${Date.now()}`;

    const response = await anthropic.beta.messages.create({
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN + THINKING_HEADROOM_TOKENS,
      thinking: { type: 'adaptive' },
      system: [
        { type: 'text', text: cfg.systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      tools: [cfg.tool as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      messages: messages as Anthropic.Beta.Messages.BetaMessageParam[],
      betas: cfg.betas,
    }, {
      ...(args.signal ? { signal: args.signal } : {}),
      headers: { 'idempotency-key': idempotencyKey },
    });

    tokensUsed += response.usage?.input_tokens ?? 0;
    void logClaudeUsage(response.usage ?? {}, {
      workload: 'cua_mapping_colrecovery',
      model: cfg.model,
      propertyId: args.propertyId,
      jobId: args.jobId,
      metadata: { actionName: args.actionName, stepIdx },
    });

    const responseContent = response.content as unknown as Anthropic.Messages.ContentBlock[];
    messages.push({ role: 'assistant', content: responseContent });

    if (response.stop_reason === 'end_turn') {
      const finalText = extractFinalText(responseContent);
      const parsed = tryParseJson(finalText) as {
        detailUrl?: unknown; detailColumns?: unknown;
        enumMappings?: unknown; valueSamples?: unknown;
        unavailable?: unknown; ask_admin?: unknown;
      } | null;
      if (!parsed || typeof parsed.detailUrl !== 'string' || !parsed.detailColumns || typeof parsed.detailColumns !== 'object') {
        return fail(parsed && (parsed.unavailable === true || parsed.ask_admin === true)
          ? 'agent declared the detail fields unavailable'
          : `no usable drill JSON — agent said: ${finalText.slice(0, 160)}`);
      }

      // Only the fields we asked for, with non-blank selectors.
      const detailColumns: Record<string, string> = {};
      for (const [col, sel] of Object.entries(parsed.detailColumns as Record<string, unknown>)) {
        if (typeof sel !== 'string' || sel.trim() === '') continue;
        if (!args.missingCols.includes(col)) continue;
        detailColumns[col] = sel.trim();
      }
      if (Object.keys(detailColumns).length === 0) {
        return fail('drill returned no selectors for the missing fields');
      }

      // Scope learned-value contributions to the fields this drill owns — an
      // unsolicited re-emission of e.g. `priority` must not later REPLACE the
      // richer vocabulary the list turn learned (code review P1).
      const onlyMissing = <T>(m: Record<string, T> | undefined): Record<string, T> | undefined => {
        if (!m) return undefined;
        const out: Record<string, T> = {};
        for (const col of args.missingCols) if (m[col] !== undefined) out[col] = m[col]!;
        return Object.keys(out).length > 0 ? out : undefined;
      };
      const drillEnums = onlyMissing(coerceEnumMappings(parsed.enumMappings));
      const drillSamples = onlyMissing(coerceValueSamples(parsed.valueSamples));
      const dateSamples: string[] = [];
      for (const col of CORE_TARGET_CONTRACTS[actionKey]?.columns ?? []) {
        if (col.type !== 'date') continue;
        const s = drillSamples?.[col.name];
        if (Array.isArray(s)) dateSamples.push(...s);
      }
      const learned = learnedForGate(
        actionKey,
        { ...(args.payloadEnums ?? {}), ...(drillEnums ?? {}) },
        pickDateFormat(inferDateFormat(dateSamples), args.provisionalDateFormat),
      );
      const todayIso = new Date().toISOString().slice(0, 10);

      let detailUrl: string;
      try {
        detailUrl = new URL(parsed.detailUrl, args.page.url()).toString();
      } catch {
        return fail(`unparseable detail URL: ${String(parsed.detailUrl).slice(0, 120)}`);
      }

      // ── Mechanical verification, record 1 (the model's sample) ──────────
      try {
        await safeGoto(args.page, detailUrl, { allowedHost, context: 'mapper:colrecovery:sample' });
      } catch (err) {
        return fail(`sample detail page failed to load: ${(err as Error).message.slice(0, 160)}`);
      }
      await args.page.waitForTimeout(600);
      let fields1: Record<string, string>;
      try {
        fields1 = await extractDetailFields(args.page, detailColumns);
      } catch (err) {
        return fail(`sample detail extraction failed: ${(err as Error).message.slice(0, 120)}`);
      }
      const gateAll = (values: Record<string, string>, label: string): string | null => {
        const allValues: Record<string, string[]> = {};
        for (const [c, v] of Object.entries(values)) allValues[c] = [v];
        for (const col of Object.keys(detailColumns)) {
          const verdict = gateRecoveredColumn({
            actionKey,
            column: col,
            values: [values[col] ?? ''],
            allValues,
            selector: detailColumns[col]!,
            allSelectors: detailColumns,
            learned,
            todayIso,
          });
          if (!verdict.ok) return `${label}: ${col} failed value gate (${verdict.reason})`;
        }
        return null;
      };
      const gate1 = gateAll(fields1, 'sample record');
      if (gate1) return fail(gate1);

      // ── URL template from the REAL probe row (never model row data) ─────
      const sampleValues: Record<string, string> = {};
      for (const [c, v] of Object.entries(sampleRow)) {
        if ((v ?? '').trim() !== '') sampleValues[c] = (v ?? '').trim();
      }
      const tmpl = templateFromSample(detailUrl, sampleValues, keyColumn);
      if (!tmpl.ok || !tmpl.template || !tmpl.placeholders) {
        return fail(`url templating failed: ${tmpl.reason ?? 'unknown'}`);
      }

      // ── Mechanical verification, record 2 (template substitution) ───────
      const verifyValues: Record<string, string> = {};
      for (const p of tmpl.placeholders) {
        const v = (verifyRow[p] ?? '').trim();
        if (v === '') return fail(`verification row has a blank value for URL param "${p}"`);
        verifyValues[p] = v;
      }
      let url2: string;
      try {
        url2 = substituteTemplate(tmpl.template, verifyValues);
      } catch (err) {
        return fail(`template substitution failed: ${(err as Error).message.slice(0, 120)}`);
      }
      try {
        await safeGoto(args.page, url2, { allowedHost, context: 'mapper:colrecovery:verify' });
      } catch (err) {
        return fail(`verification detail page failed to load: ${(err as Error).message.slice(0, 160)}`);
      }
      await args.page.waitForTimeout(600);
      let fields2: Record<string, string>;
      try {
        fields2 = await extractDetailFields(args.page, detailColumns);
      } catch (err) {
        return fail(`verification detail extraction failed: ${(err as Error).message.slice(0, 120)}`);
      }
      const gate2 = gateAll(fields2, 'verification record');
      if (gate2) return fail(gate2);

      // Stale-record guard: a PMS that ignores the id param re-renders the
      // SAME record for url2 — values gate-pass while being record 1's.
      // Word-boundary matching so verifyKey "123" inside sampleKey "1234"
      // (or inside totals/phones) can't fake a pass; an eval failure fails
      // CLOSED — this is the only protection against that silent-wrong-data
      // case (code review P1/P2).
      let bodyText: string;
      try {
        bodyText = await args.page.evaluate(() => document.body?.innerText ?? '');
      } catch {
        return fail('stale-record check could not read the verification page');
      }
      const keyPresent = (key: string): boolean => {
        const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`).test(bodyText);
      };
      if (keyPresent(sampleKey) && !keyPresent(verifyKey)) {
        return fail('verification page still shows the sample record — the URL parameter appears to be ignored');
      }

      const fieldCoverage: Record<string, string> = {};
      for (const col of Object.keys(detailColumns)) fieldCoverage[col] = '2/2';
      const detailUrlParams: Record<string, string> = {};
      for (const p of tmpl.placeholders) detailUrlParams[p] = p;
      return {
        ok: true,
        drillDown: {
          listUrl: args.feedPageUrl,
          listRowSelector: args.rowSelector,
          // Overwritten with the finalized list map by finalizeRecoveredSuccess.
          listColumns: {},
          detailUrlTemplate: tmpl.template,
          detailUrlParams,
          detailColumns,
          fieldCoverage,
          samplesDrilled: 1,
          templateVerified: true,
        },
        ...(drillEnums ? { enumMappings: drillEnums } : {}),
        ...(drillSamples ? { valueSamples: drillSamples } : {}),
        tokensUsed,
      };
    }

    const toolUses = responseContent.filter((c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use');
    if (toolUses.length === 0) {
      return fail('model turn produced neither tool use nor final JSON');
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const exec = await executeVisionAction(args.page, toolUse.input as VisionAction, args.credentials, 'action');
      if (exec.recordedStep) drillSteps.push(exec.recordedStep);
      toolResults.push(makeToolResult(toolUse.id, exec));
    }
    for (const toolUse of toolUses) {
      const stuck = loopDet.record(actionFingerprint(toolUse.input), turnPageFingerprint);
      if (stuck.stuck) return fail('loop detector tripped in recovery drill');
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return fail('recovery drill exhausted step budget');
}

// ─── Structured discovery (feat/cua-mapper-discovery) ────────────────────
//
// "Read the clean data behind the page": when the agent lands a DOM table on
// a CORE feed, look through the network calls the page itself made
// (network-capture.ts, passive + PII-redacted) for the JSON endpoint serving
// the same rows, VERIFY it against the DOM-scraped oracle (oracle-verify.ts),
// and only then emit `parse:{mode:'api'}`. Every uncertain path abstains and
// keeps today's DOM recipe — a wrong endpoint or a stale date param would
// produce a full well-formed-but-WRONG rowset that silently corrupts the DB.
//
// Verification ladder (ALL must pass):
//   1. fresh oracle scrape of the live page with the agent's own selectors
//      (≥5 rows, untruncated, anchored to the agent's same-turn valueSamples);
//   2. pure prefilter of captured calls (same-site, no session tokens, no
//      mutation verbs, ≥90% key-value overlap) — zero LLM cost when nothing
//      plausible was captured;
//   3. ONE bounded LLM call proposing {candidate, jsonPath, columns} — a
//      HYPOTHESIS only, never trusted;
//   4. mechanical reconcile: 100% DOM⊆API key coverage, bijective count (or
//      the date-bound pagination exception), parser-exact corroboration of
//      every mapped column, enum vocabulary derivation with contradiction +
//      diversity gates;
//   5. date templating: every date-like token must equal the feed's business
//      date and become {today:FORMAT}; anything else (other dates, epochs,
//      encoded dates, dates in id-named params) → abstain;
//   6. live replay-confirm from the post-login page with sanitized headers +
//      rendered template (proves the request still works WITHOUT the stripped
//      cookies/CSRF headers, in the same context the runtime will use);
//   7. date-shift probe: render yesterday, require uniformly-yesterday rows —
//      proves the templated param is load-bearing and its M/D order is right.

const DISCOVERY_IDENTIFY_SYSTEM =
  'You are matching a hotel-PMS web page\'s own JSON network call to the table displayed on that page. ' +
  'You will see the table rows we scraped from the DOM (ground truth; some values may be shape-masked for privacy) ' +
  'and up to 3 captured JSON calls with sample rows (values may be privacy-masked). ' +
  'Pick the ONE candidate whose array holds the SAME records as the DOM rows, and map our snake_case column names ' +
  'to the JSON field names on each row (use dot-paths like "guest.name" for nested fields). ' +
  'Reply with ONLY a JSON object on the first line — no preamble, no markdown. ' +
  'Either {"none":true} when no candidate clearly matches, or ' +
  '{"candidateIndex":<n>,"jsonPath":"<dot-path to the row array, empty string if the response is the array>",' +
  '"columns":{"<our_column>":"<json field dot-path>"}}. ' +
  'Map ONLY fields you can actually see on the sample row. NEVER guess — omit anything uncertain. ' +
  'The mapping is mechanically verified afterwards; a wrong guess is worse than {"none":true}.';

/** Injectable side-effect seams so the discovery pipeline is unit-testable
 *  without Playwright or the Anthropic API. Defaults (makeDefaultDiscoveryDeps)
 *  are the real implementations. */
export interface DiscoveryDeps {
  /** Scrape the CURRENT page with the agent's learned selectors (dom-table
   *  semantics: '.'=row element, textContent.trim(), skip empty selectors). */
  extractOracleRows: (
    rowSelector: string,
    columns: Record<string, string>,
    cap: number,
  ) => Promise<Array<Record<string, string>>>;
  /** A bounded identify call; returns the model's raw text. `sample` (default 0)
   *  distinguishes the N draws of the semantic-entropy abstain loop so the
   *  default impl can vary its idempotency key — without that, every draw would
   *  reuse one cached response and the entropy signal would be vacuous. */
  identify: (prompt: string, sample?: number) => Promise<string>;
  /** In-page fetch with the page's cookies (mirrors extractors/fetch-api.ts,
   *  plus cache:'no-store' so a cached response can't fake a pass). */
  replayFetch: (req: {
    url: string;
    method: string;
    body?: string;
    headers?: Record<string, string>;
  }) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
  /** Navigate to the post-login page so replay-confirm runs in the same
   *  context the runtime poll loop will use (Referer / server-session page
   *  scoping differences become a learn-time abstain, not a silent runtime
   *  wrong-context rowset). */
  gotoPostLogin: () => Promise<void>;
  isOverBudget: () => Promise<boolean>;
  now: () => number;
}

function makeDefaultDiscoveryDeps(args: MapActionArgs): DiscoveryDeps {
  return {
    extractOracleRows: (rowSelector, columns, cap) =>
      extractDomRows(args.page, rowSelector, columns, { cap }).then((r) => r.rows),

    identify: async (prompt, sample = 0) => {
      // Per-sample idempotency key: the N-sample entropy loop must get N
      // INDEPENDENT draws. A fixed key would make Anthropic return one cached
      // response for every draw → entropy always 0 → the abstain signal is
      // useless. The `:s${sample}` suffix keeps each draw independently
      // idempotent (a retry of draw i reuses draw i's key).
      const idempotencyKey = args.jobId
        ? `${args.jobId}:${args.actionName}:discovery:s${sample}`
        : `anon:${args.actionName}:discovery:s${sample}:${Date.now()}`;
      const cfg = getModeConfig(args.model);
      const response = await anthropic.messages.create({
        model: cfg.model,
        max_tokens: 1500,
        system: DISCOVERY_IDENTIFY_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }, {
        ...(args.signal ? { signal: args.signal } : {}),
        headers: { 'idempotency-key': idempotencyKey },
      });
      void logClaudeUsage(response.usage ?? {}, {
        workload: 'cua_mapping_action',
        model: cfg.model,
        propertyId: args.propertyId,
        jobId: args.jobId,
        metadata: { actionName: args.actionName, phase: 'structured_discovery' },
      });
      return response.content
        .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    },

    replayFetch: async (req) => {
      if (args.signal?.aborted) return { ok: false, reason: 'aborted' };
      try {
        const data = await args.page.evaluate(
          async (a: { url: string; method: string; body?: string; headers?: Record<string, string>; timeoutMs: number }) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), a.timeoutMs);
            try {
              const resp = await fetch(a.url, {
                method: a.method,
                credentials: 'include',
                cache: 'no-store',
                headers: a.headers ?? {},
                ...(a.body !== undefined ? { body: a.body } : {}),
                signal: ctrl.signal,
              });
              if (!resp.ok) return { __fetchError: `HTTP ${resp.status}` };
              return await resp.json();
            } catch (e) {
              return { __fetchError: e instanceof Error ? e.message : String(e) };
            } finally {
              clearTimeout(timer);
            }
          },
          { ...req, timeoutMs: 20_000 },
        );
        if (data && typeof data === 'object' && '__fetchError' in (data as Record<string, unknown>)) {
          return { ok: false, reason: (data as { __fetchError: string }).__fetchError };
        }
        return { ok: true, data };
      } catch (err) {
        return { ok: false, reason: `evaluate failed: ${(err as Error).message}` };
      }
    },

    gotoPostLogin: async () => {
      const allowedHost = new URL(args.credentials.loginUrl).host;
      await safeGoto(args.page, args.postLoginUrl, {
        allowedHost,
        context: 'mapper:discovery:replay-context',
      });
      await args.page.waitForTimeout(800);
    },

    isOverBudget: async () => {
      const budget = await isJobOverBudget(args.jobId, args.jobCostCapMicros);
      return budget.over;
    },

    now: () => Date.now(),
  };
}

export interface StructuredDiscoveryInput {
  actionName: keyof Recipe['actions'];
  /** The clean DOM-table success from mapActionCore (never a viaBail one). */
  success: ActionMapSuccess;
  capturedCalls: CapturedCall[];
  loginUrl: string;
  /** page.url() at success time — the feed page the oracle is scraped from. */
  feedPageUrl: string;
  jobId: string | null;
  signal?: AbortSignal;
}

const NAME_MASK_COLS = /name|changed_by|assigned_to/i;

/**
 * The full discovery pipeline. Returns the UPGRADED success (parse swapped to
 * mode:'api', enum vocabulary extended with verified API-side raws) or null —
 * in which case the caller keeps the DOM success unchanged. Never throws for
 * expected failures; the wrapper catches anything unexpected.
 */
export async function attemptStructuredDiscovery(
  input: StructuredDiscoveryInput,
  deps: DiscoveryDeps,
): Promise<ActionMapSuccess | null> {
  const abstain = (reason: string, extra?: Record<string, unknown>): null => {
    log.info('mapper: structured discovery abstained — keeping DOM recipe', {
      actionName: input.actionName,
      jobId: input.jobId ?? undefined,
      reason,
      ...extra,
    });
    return null;
  };

  // Static/expected short-circuits return silently — 14 of the 18 targets are
  // non-core and would otherwise emit a pointless log line every run.
  const envFlag = (process.env.CUA_STRUCTURED_DISCOVERY_ENABLED ?? 'true').toLowerCase();
  if (envFlag === '0' || envFlag === 'false') return null;
  const contract = CORE_TARGET_CONTRACTS[input.actionName];
  const keyCol = DISCOVERY_KEY_COLUMNS[input.actionName];
  if (!contract || !keyCol) return null;
  if (input.signal?.aborted) return abstain('aborted');
  if (input.success.viaBail) return abstain('via_bail');
  if (input.success.action.parse.mode !== 'table') return abstain('not_table_parse');
  if (input.capturedCalls.length === 0) return abstain('no_captured_calls');
  if (await deps.isOverBudget()) return abstain('job_over_budget');

  // ── best-class verification knobs (feature/cua-bestclass-verify) ──
  // Read from process.env (mirrors the CUA_STRUCTURED_DISCOVERY_ENABLED read
  // above so tests can mutate per-case; env.ts is out of scope for this change).
  // ALL DEFAULT TO TODAY'S BEHAVIOUR: 1 identify draw, 1 replay pass. The
  // cost-multiplying paths only activate when explicitly raised, and only ever
  // at onboarding (this pipeline never runs at the 30s poll).
  const clampInt = (raw: string | undefined, def: number, lo: number, hi: number): number => {
    const n = raw == null ? def : parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const clampFloat = (raw: string | undefined, def: number, lo: number, hi: number): number => {
    const n = raw == null ? def : parseFloat(raw);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const identifySampleCount = (): number => clampInt(process.env.CUA_DISCOVERY_IDENTIFY_SAMPLES, 1, 1, 5);
  const identifyMaxEntropy = (): number => clampFloat(process.env.CUA_DISCOVERY_MAX_ENTROPY, 0.5, 0, 1);
  const identifyMinDominance = (): number => clampFloat(process.env.CUA_DISCOVERY_MIN_DOMINANCE, 0.5, 0, 1);
  const replayPassCount = (): number => clampInt(process.env.CUA_VERIFY_REPLAY_PASSES, 1, 1, 5);

  const tableHint = input.success.action.parse.hint;

  // ── 1. Fresh oracle scrape ──
  let domRows: Array<Record<string, string>>;
  try {
    domRows = await deps.extractOracleRows(tableHint.rowSelector, tableHint.columns, MAX_ORACLE_ROWS + 1);
  } catch (err) {
    return abstain('oracle_extract_failed', { err: err instanceof Error ? err.message : String(err) });
  }
  if (domRows.length === 0) return abstain('oracle_empty');
  if (domRows.length > MAX_ORACLE_ROWS) return abstain('oracle_truncated');
  if (domRows.length < MIN_ORACLE_ROWS) return abstain('oracle_too_small', { rows: domRows.length });

  // Anchor the scrape to the table the MODEL identified: its same-turn
  // valueSamples must largely appear among the scraped cells. Guards against
  // a too-generic rowSelector matching a different table on the page.
  const samples = Object.values(input.success.valueSamples ?? {}).flat().slice(0, 20);
  if (samples.length > 0) {
    const cellVals = new Set<string>();
    for (const r of domRows) for (const v of Object.values(r)) cellVals.add(v.trim());
    const hits = samples.filter((s) => cellVals.has(s.trim())).length;
    if (hits / samples.length < 0.5) {
      return abstain('oracle_sample_anchor_failed', { hits, samples: samples.length });
    }
  }

  // ── 2. Business-date anchor (date-keyed targets) ──
  // The page DISPLAYS the hotel's business date — that is the ground truth a
  // captured date param is compared against (no runner-vs-hotel clock games).
  // Sanity window: it must be runner-local or UTC "today", else the agent left
  // a non-today filter applied and nothing about this page is "today's feed".
  const semanticDateCol = DISCOVERY_SEMANTIC_DATE_COLUMNS[input.actionName];
  const localToday = isoFromLocalClock(deps.now());
  const utcToday = new Date(deps.now()).toISOString().slice(0, 10);
  let anchorIso: string | null = null;
  // SECOND ORACLE (fix/cua-two-oracle): set when the live DOM is blind on the
  // feed's semantic date column (selector absent OR reads blank on EVERY row —
  // a checkout date the page paints by JS / hides on a detail page). The column
  // is then certified by temporal proofs (today-anchor + yesterday + tomorrow
  // date-shift) instead of the absent DOM cell. SOME-but-not-all blank stays a
  // hard abstain (a wrong selector reading blank on a few rows must not be
  // laundered into "the page hides it").
  let domBlindSemanticDate = false;
  if (semanticDateCol) {
    const sel = tableHint.columns[semanticDateCol];
    const raws = sel && sel.trim() !== ''
      ? new Set(domRows.map((r) => (r[semanticDateCol] ?? '').trim()))
      : new Set<string>(['']);
    const allBlank = [...raws].every((v) => v === '');
    if (allBlank) {
      // Wrong-selector smell (review #3): if the model CLAIMED to read dates for
      // this column (valueSamples) but the live selector is blank, the selector
      // is wrong — the column is NOT genuinely hidden — so there is no real DOM
      // oracle and the API field must not be blind-trusted. Abstain.
      const claimed = input.success.valueSamples?.[semanticDateCol];
      if (Array.isArray(claimed) && claimed.some((s) => s.trim() !== '')) {
        return abstain('blind_date_selector_suspect');
      }
      domBlindSemanticDate = true;
    } else {
      if (raws.size !== 1) return abstain('oracle_date_not_uniform');
      const raw = [...raws][0]!;
      const interps = interpretDomDate(raw);
      anchorIso = interps.find((i) => i === localToday || i === utcToday) ?? null;
      if (!anchorIso) return abstain('oracle_date_not_today', { raw: raw.slice(0, 20) });
    }
  }
  const blindDateColumns = domBlindSemanticDate ? [semanticDateCol!] : undefined;

  // ── 3. Pure prefilter ──
  const pre = prefilterCandidates({
    calls: input.capturedCalls,
    domRows,
    keyColumn: keyCol,
    loginUrl: input.loginUrl,
    feedPageUrl: input.feedPageUrl,
  });
  if (pre.candidates.length === 0) {
    return abstain('no_plausible_candidates', {
      captured: input.capturedCalls.length,
      skipped: pre.skipped,
    });
  }

  // ── 4. LLM identify (hypothesis only) — N-sample SEMANTIC-ENTROPY abstain ──
  // A single identify() can be confidently WRONG on an ambiguous page (two
  // near-identical arrays, two plausible date fields). When CUA_DISCOVERY_
  // IDENTIFY_SAMPLES > 1 we draw the proposal N times and abstain unless the
  // draws AGREE ON MEANING (proposal-entropy.ts). This is ONBOARDING-ONLY (this
  // whole pipeline never runs at the 30s poll) and DEFAULTS TO 1 — a single draw
  // is one cluster, entropy 0, behaviourally identical to today's one call.
  const valueContract = TARGET_VALUE_CONTRACTS[input.actionName];
  const prompt = buildIdentifyPrompt({
    actionName: input.actionName,
    contract,
    domRows,
    candidates: pre.candidates,
  });

  const contractCols = new Set(contract.columns.map((c) => c.name));
  /** Parse one raw identify response → a normalized, contract-filtered proposal
   *  with the key column present, or null (malformed / {none} / unmappable —
   *  counts as the "none" meaning in clustering, diluting consensus). */
  const normalizeProposal = (rawText: string): DiscoveryProposalShape | null => {
    const p = tryParseJson(rawText) as
      | { none?: unknown; candidateIndex?: unknown; jsonPath?: unknown; columns?: unknown }
      | null;
    if (!p || p.none === true) return null;
    const ci = typeof p.candidateIndex === 'number' ? p.candidateIndex : -1;
    if (ci < 0 || ci >= pre.candidates.length) return null;
    if (!p.columns || typeof p.columns !== 'object') return null;
    const cols: Record<string, string> = {};
    for (const [col, path] of Object.entries(p.columns as Record<string, unknown>)) {
      if (typeof path !== 'string' || path.trim() === '') continue;
      if (!contractCols.has(col)) continue; // extra fields would be dropped by the writer anyway
      cols[col] = path.trim();
    }
    if (!cols[keyCol]) return null;
    return { candidateIndex: ci, jsonPath: typeof p.jsonPath === 'string' ? p.jsonPath.trim() : '', columns: cols };
  };

  const sampleCount = identifySampleCount();
  const proposalSamples: Array<DiscoveryProposalShape | null> = [];
  let identifyCalls = 0;
  for (let s = 0; s < sampleCount; s++) {
    // Budget governs the loop: each draw is a paid call. The first draw always
    // runs (the top-of-function isOverBudget already passed); re-check before
    // each EXTRA draw so N-sampling can never blow the per-job cost cap.
    if (s > 0 && await deps.isOverBudget()) break;
    if (input.signal?.aborted) return abstain('aborted');
    let rawText: string;
    try {
      rawText = await deps.identify(prompt, s);
    } catch (err) {
      if (identifyCalls === 0) {
        return abstain('identify_call_failed', { err: err instanceof Error ? err.message : String(err) });
      }
      break; // a later draw failed — decide on the draws we have
    }
    identifyCalls++;
    proposalSamples.push(normalizeProposal(rawText));
  }
  if (identifyCalls === 0) return abstain('identify_call_failed', { reason: 'no_draws' });

  // When N>1 was requested, require a MAJORITY of the draws to actually land
  // (review): a budget-truncated 1-of-5 must not be silently trusted as if it
  // were the full sample — abstain instead (keeps the safe DOM recipe).
  const consensus = chooseConsensusProposal(proposalSamples, {
    minSamples: sampleCount > 1 ? Math.ceil(sampleCount / 2) : 1,
    maxEntropy: identifyMaxEntropy(),
    minDominance: identifyMinDominance(),
  });
  if (!consensus.ok) {
    return abstain(`identify_no_consensus:${consensus.reason}`, {
      samples: consensus.samples, entropy: Number(consensus.entropy.toFixed(3)), agreement: Number(consensus.agreement.toFixed(3)),
    });
  }
  if (sampleCount > 1) {
    log.info('mapper: identify consensus across samples', {
      actionName: input.actionName, jobId: input.jobId ?? undefined,
      draws: identifyCalls, agreement: Number(consensus.agreement.toFixed(3)), entropy: Number(consensus.entropy.toFixed(3)),
    });
  }
  const idx = consensus.proposal.candidateIndex;
  const jsonPath = consensus.proposal.jsonPath;
  const columns: Record<string, string> = { ...consensus.proposal.columns };

  // ── 5. Mechanical reconcile against the captured body ──
  const cand = pre.candidates[idx]!;
  const extracted = extractRowsAtPath(cand.call.responseBody, jsonPath);
  if (!extracted.ok) return abstain(`extract_failed:${extracted.reason}`);
  // Envelope-decoy guard: until the runtime resolves jsonPath exclusively, a
  // body carrying BOTH our verified nested array AND an unrelated top-level
  // rows|results|data array would have the runtime ingest the wrong one.
  {
    const decoy = findEnvelopeDecoy(cand.call.responseBody, jsonPath);
    if (decoy) return abstain(`envelope_decoy:${decoy}`);
  }
  const enumValueSets: Record<string, string[]> = {};
  for (const c of valueContract?.columns ?? []) {
    if (c.enumValues && c.enumValues.length > 0) enumValueSets[c.name] = c.enumValues;
  }
  const verdict = reconcileRows({
    actionKey: input.actionName,
    domRows,
    apiRows: projectRows(extracted.rows, columns),
    mappedColumns: Object.keys(columns),
    domEnumMappings: input.success.enumMappings,
    enumValueSets,
    anchorIso,
    ...(blindDateColumns ? { blindDateColumns } : {}),
    mode: 'learn',
  });
  if (!verdict.reconciles) return abstain(`reconcile_failed:${verdict.reason}`);
  for (const col of verdict.droppedOptionalColumns ?? []) delete columns[col];

  // ── SECOND-ORACLE static gates (only when DOM-blind on the semantic date) ──
  // reconcile signalled the column as trusted-unverified; before emitting we
  // pin down the column's IDENTITY (not just that it follows the date window),
  // then certify VALUE via the temporal proofs in steps 8-9b.
  if (domBlindSemanticDate) {
    if (!verdict.trustedUnverifiedColumns?.includes(semanticDateCol!)) {
      return abstain('blind_date_not_flagged');
    }
    // jsonPath uniqueness: the blind column must not alias another mapped
    // column's field — mapping two columns to one JSON field is a wrong-mapping
    // smell that key-bijection + temporal proofs cannot catch.
    const blindPath = columns[semanticDateCol!];
    if (Object.entries(columns).some(([c, p]) => c !== semanticDateCol && p === blindPath)) {
      return abstain('blind_date_path_aliased');
    }
    // Sibling discriminator (Codex P0-1): the OTHER required date column must be
    // DOM-verified (mapped, not itself blind) and NON-UNIFORM (≥2 distinct
    // non-blank raws). A mislabeled arrivals-as-departures page has a uniformly-
    // today sibling and fails this — the only signal that distinguishes a
    // uniformly-today field wrongly picked for the blind date from the genuine
    // window date.
    const siblingDateCol = (CORE_TARGET_CONTRACTS[input.actionName]?.columns ?? [])
      .filter((c) => c.required && c.type === 'date' && c.name !== semanticDateCol)
      .map((c) => c.name)[0];
    if (!siblingDateCol) return abstain('blind_date_no_sibling_discriminator');
    if (!columns[siblingDateCol]) return abstain('blind_date_sibling_unmapped');
    if (verdict.trustedUnverifiedColumns?.includes(siblingDateCol)) {
      return abstain('blind_date_sibling_also_blind');
    }
    const sibRaws = new Set(domRows.map((r) => (r[siblingDateCol] ?? '').trim()).filter((v) => v !== ''));
    if (sibRaws.size < 2) return abstain('blind_date_sibling_uniform');
  }
  // Anchor (today) key set — used by the blind date-shift proofs to prove the
  // param SELECTS records by date, not merely echoes a stamped date (below).
  const normKeyLoose = (v: unknown): string => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const anchorKeys: Set<string> = domBlindSemanticDate
    ? new Set(domRows.map((r) => normKeyLoose(r[keyCol])).filter((v) => v !== ''))
    : new Set();

  // ── 6. Header sanitization ──
  const sanitized = sanitizeHeaders(cand.call.requestHeaders, {
    method: cand.call.method,
    body: cand.call.requestBody,
  });
  if (!sanitized.ok) return abstain(`headers_rejected:${sanitized.reason}`);

  // ── 7. Date templating ──
  let effectiveAnchor = anchorIso ?? localToday;
  let templ = checkDateParams({
    url: cand.call.url,
    body: cand.call.requestBody,
    anchorIso: effectiveAnchor,
    nowMs: deps.now(),
  });
  if (!templ.ok && !anchorIso && utcToday !== localToday) {
    // Non-date-keyed target near midnight: the request may carry UTC's today.
    effectiveAnchor = utcToday;
    templ = checkDateParams({
      url: cand.call.url,
      body: cand.call.requestBody,
      anchorIso: effectiveAnchor,
      nowMs: deps.now(),
    });
  }
  if (!templ.ok) return abstain(`date_templating_failed:${templ.reason}`);
  const templatedCount = templ.templatedCount ?? 0;
  // A templated date on a target with no semantic date column cannot be
  // probe-verified (nothing in the response proves which day it served).
  if (templatedCount > 0 && !semanticDateCol) return abstain('untestable_date_param');
  // SECOND ORACLE: a DOM-blind semantic date can ONLY be certified by the
  // date-shift probes, which need a load-bearing templated date param. No
  // templated date ⇒ no proof possible ⇒ abstain (the drill recovers it).
  if (domBlindSemanticDate && templatedCount === 0) return abstain('blind_date_no_templated_param');

  // ── 8. Replay-confirm from the runtime's context ──
  if (input.signal?.aborted) return abstain('aborted');
  try {
    await deps.gotoPostLogin();
  } catch (err) {
    return abstain('replay_context_nav_failed', { err: err instanceof Error ? err.message : String(err) });
  }

  const variants: Array<{ url: string; body?: string }> = [
    { url: templ.url!, ...(templ.bodyTemplate !== undefined ? { body: templ.bodyTemplate } : {}) },
  ];
  if (templ.altUrl !== undefined || templ.altBodyTemplate !== undefined) {
    variants.push({
      url: templ.altUrl ?? templ.url!,
      ...((templ.altBodyTemplate ?? templ.bodyTemplate) !== undefined
        ? { body: templ.altBodyTemplate ?? templ.bodyTemplate }
        : {}),
    });
  }

  // On the anchor day every variant renders identically, so confirm once.
  const replay = await deps.replayFetch({
    url: renderTemplateAtDate(variants[0]!.url, effectiveAnchor),
    method: cand.call.method,
    ...(variants[0]!.body !== undefined
      ? { body: renderTemplateAtDate(variants[0]!.body, effectiveAnchor) }
      : {}),
    ...(sanitized.headers ? { headers: sanitized.headers } : {}),
  });
  if (!replay.ok) return abstain(`replay_failed:${replay.reason ?? 'unknown'}`);
  // NOTE: replay.data is the live response — RAW guest PII (the redaction
  // pipeline only covers network-capture). It is reconciled in memory and
  // discarded: never logged, never persisted, never sent to the LLM.
  const replayRows = extractRowsAtPath(replay.data, jsonPath);
  if (!replayRows.ok) return abstain(`replay_extract_failed:${replayRows.reason}`);
  {
    const decoy = findEnvelopeDecoy(replay.data, jsonPath);
    if (decoy) return abstain(`replay_envelope_decoy:${decoy}`);
  }
  const replayVerdict = reconcileRows({
    actionKey: input.actionName,
    domRows,
    apiRows: projectRows(replayRows.rows, columns),
    mappedColumns: Object.keys(columns),
    domEnumMappings: input.success.enumMappings,
    enumValueSets,
    anchorIso,
    ...(blindDateColumns ? { blindDateColumns } : {}),
    mode: 'replay',
  });
  if (!replayVerdict.reconciles) return abstain(`replay_reconcile_failed:${replayVerdict.reason}`);
  // A column can pass on the captured body yet fail on the LIVE replay (the
  // server varies a field by context) — emitting it would write wrong-but-
  // well-formed optional values forever. Drop replay-stage casualties too.
  for (const col of replayVerdict.droppedOptionalColumns ?? []) {
    delete columns[col];
    if (verdict.derivedEnumMappings) delete verdict.derivedEnumMappings[col];
  }

  // ── 8b. pass^N replay consistency (feature/cua-bestclass-verify) ──
  // The replay-confirm above proves the endpoint reconciles ONCE. A flaky /
  // load-balanced / occasionally-stale endpoint can pass a single confirm by
  // luck. When CUA_VERIFY_REPLAY_PASSES > 1 we re-fetch the SAME anchor-day
  // request that many MORE times (reusing the existing replay machinery) and
  // require every pass to still reconcile in 'replay' mode against the SAME
  // (post-drop) column set — any wobble abstains. HTTP-only, no LLM; gated to
  // onboarding; DEFAULT 1 ⟹ no extra fetches, today's behaviour.
  const extraReplayPasses = replayPassCount() - 1;
  for (let p = 0; p < extraReplayPasses; p++) {
    if (input.signal?.aborted) return abstain('aborted');
    const rerun = await deps.replayFetch({
      url: renderTemplateAtDate(variants[0]!.url, effectiveAnchor),
      method: cand.call.method,
      ...(variants[0]!.body !== undefined
        ? { body: renderTemplateAtDate(variants[0]!.body, effectiveAnchor) }
        : {}),
      ...(sanitized.headers ? { headers: sanitized.headers } : {}),
    });
    if (!rerun.ok) return abstain(`replay_consistency_fetch_failed:${rerun.reason ?? 'unknown'}`);
    const rerunRows = extractRowsAtPath(rerun.data, jsonPath);
    if (!rerunRows.ok) return abstain(`replay_consistency_extract_failed:${rerunRows.reason}`);
    if (findEnvelopeDecoy(rerun.data, jsonPath)) return abstain('replay_consistency_envelope_decoy');
    const rerunVerdict = reconcileRows({
      actionKey: input.actionName,
      domRows,
      apiRows: projectRows(rerunRows.rows, columns),
      mappedColumns: Object.keys(columns),
      domEnumMappings: input.success.enumMappings,
      enumValueSets,
      anchorIso,
      ...(blindDateColumns ? { blindDateColumns } : {}),
      mode: 'replay',
    });
    if (!rerunVerdict.reconciles) return abstain(`replay_consistency_failed:${rerunVerdict.reason}`);
  }
  if (extraReplayPasses > 0) {
    log.info('mapper: replay pass^N consistency confirmed', {
      actionName: input.actionName, jobId: input.jobId ?? undefined, passes: extraReplayPasses + 1,
    });
  }

  // ── SECOND-ORACLE today-anchor proof (live replay) ──
  // The LIVE replay rows' blind semantic date must be uniformly == today and
  // self-describing. This + the tomorrow probe (step 9b) is what separates the
  // genuine window date from a co-moving audit timestamp (changed_at), which
  // the captured-body reconcile alone cannot tell apart.
  if (domBlindSemanticDate) {
    if (!replayVerdict.trustedUnverifiedColumns?.includes(semanticDateCol!)) {
      return abstain('blind_date_replay_not_flagged');
    }
    const todayProj = projectRows(replayRows.rows, columns).slice(0, 50);
    if (todayProj.length === 0) return abstain('blind_date_today_anchor_empty');
    for (const r of todayProj) {
      if (selfDescribingIso(r[semanticDateCol!]) !== effectiveAnchor) {
        return abstain('blind_date_today_anchor_failed');
      }
    }
  }

  // ── 9. Date-shift probe ──
  // Render YESTERDAY once and require uniformly-yesterday rows (or an empty
  // set). Proves (a) the templated param is load-bearing — a server that
  // ignores it returns today's rows and we abstain — and (b) the chosen M/D
  // order is right (the wrong order renders a different/invalid date and
  // fails). Without this, an ignored or mis-ordered date param would surface
  // only as silently wrong rows weeks later.
  let chosen = templatedCount === 0 ? variants[0]! : null;
  if (!chosen) {
    const probeIso = isoAddDays(effectiveAnchor, -1);
    for (const variant of variants) {
      if (input.signal?.aborted) return abstain('aborted');
      const probe = await deps.replayFetch({
        url: renderTemplateAtDate(variant.url, probeIso),
        method: cand.call.method,
        ...(variant.body !== undefined ? { body: renderTemplateAtDate(variant.body, probeIso) } : {}),
        ...(sanitized.headers ? { headers: sanitized.headers } : {}),
      });
      if (!probe.ok) continue; // a wrong-order render may 400 — try the alternate
      const probeRows = extractRowsAtPath(probe.data, jsonPath);
      if (!probeRows.ok) {
        // Empty yesterday is a WEAK pass — acceptable only when the format
        // order was unambiguous on the learn day (a single variant). With two
        // candidate orders, an empty set proves neither, and locking in the
        // wrong order could make a lenient server serve wrong-day rows later.
        // NEVER a weak pass for a DOM-blind date: with no DOM oracle the blind
        // column's value is wholly trusted to the probes, so it must see a real
        // non-empty uniformly-yesterday set.
        if (probeRows.reason === 'jsonpath_empty_array' && variants.length === 1 && !domBlindSemanticDate) {
          chosen = variant;
          break;
        }
        continue;
      }
      const projected = projectRows(probeRows.rows, columns).slice(0, 50);
      let allYesterday = projected.length > 0;
      let anyAnchorDay = false;
      for (const r of projected) {
        const iso = isoOfApiDateValue(r[semanticDateCol!]);
        if (iso === effectiveAnchor) anyAnchorDay = true;
        if (iso !== probeIso) allYesterday = false;
      }
      if (anyAnchorDay) return abstain('probe_param_ignored');
      if (allYesterday) {
        // Blind date: the yesterday rows must be DIFFERENT records than today's.
        // An endpoint that ignores the param but ECHOES the requested date into
        // the field (reportDate/businessDate) renders uniformly-yesterday yet
        // returns the SAME reservations — disjoint keys reject it (Codex
        // blocker). A real date filter returns disjoint sets (a reservation
        // departs/arrives on exactly one date).
        if (domBlindSemanticDate) {
          const probeKeys = projected.map((r) => normKeyLoose(r[keyCol])).filter((v) => v !== '');
          if (probeKeys.length === 0 || probeKeys.some((k) => anchorKeys.has(k))) {
            return abstain('blind_date_shift_keys_not_disjoint');
          }
        }
        chosen = variant; break;
      }
    }
    if (!chosen) return abstain('probe_inconclusive');
  }

  // ── 9b. FORWARD (tomorrow) probe — the decisive blind-date guard ──
  // BLOCKER from the adversarial review: a `changed_at` / `processed_at`
  // timestamp that co-moves BACKWARD with the date window passes today-anchor
  // AND the yesterday probe with no DOM oracle to catch it. But an audit
  // timestamp can NEVER be in the future, while a real arrival/departure date
  // CAN. So for a DOM-blind semantic date we additionally require the column to
  // render uniformly TOMORROW, non-empty, self-describing — a co-moving
  // past-timestamp confound fails this; the genuine window date passes.
  if (domBlindSemanticDate) {
    if (input.signal?.aborted) return abstain('aborted');
    const tomorrowIso = isoAddDays(effectiveAnchor, 1);
    const fwd = await deps.replayFetch({
      url: renderTemplateAtDate(chosen.url, tomorrowIso),
      method: cand.call.method,
      ...(chosen.body !== undefined ? { body: renderTemplateAtDate(chosen.body, tomorrowIso) } : {}),
      ...(sanitized.headers ? { headers: sanitized.headers } : {}),
    });
    if (!fwd.ok) return abstain('blind_date_forward_probe_failed');
    const fwdRows = extractRowsAtPath(fwd.data, jsonPath);
    if (!fwdRows.ok) return abstain('blind_date_forward_probe_empty');
    const fwdProj = projectRows(fwdRows.rows, columns).slice(0, 50);
    if (fwdProj.length === 0) return abstain('blind_date_forward_probe_empty');
    for (const r of fwdProj) {
      if (selfDescribingIso(r[semanticDateCol!]) !== tomorrowIso) {
        return abstain('blind_date_forward_not_tomorrow');
      }
    }
    // Tomorrow's rows must also be DIFFERENT records than today's (same
    // echo/ignored-param guard as the yesterday probe, in the forward direction).
    const fwdKeys = fwdProj.map((r) => normKeyLoose(r[keyCol])).filter((v) => v !== '');
    if (fwdKeys.length === 0 || fwdKeys.some((k) => anchorKeys.has(k))) {
      return abstain('blind_date_forward_keys_not_disjoint');
    }
  }

  // ── 10. Emit ──
  const hint: ApiHint = {
    url: chosen.url,
    method: cand.call.method.toUpperCase() === 'POST' ? 'POST' : 'GET',
    ...(chosen.body !== undefined ? { bodyTemplate: chosen.body } : {}),
    ...(sanitized.headers ? { headers: sanitized.headers } : {}),
    ...(jsonPath !== '' ? { jsonPath } : {}),
    columns,
  };
  const mergedEnums = mergeDerivedEnumMappings(input.success.enumMappings, verdict.derivedEnumMappings);
  log.info('mapper: structured discovery VERIFIED — emitting api recipe', {
    actionName: input.actionName,
    jobId: input.jobId ?? undefined,
    url: hint.url.slice(0, 160),
    method: hint.method,
    jsonPath: jsonPath === '' ? '(root)' : jsonPath,
    columnCount: Object.keys(columns).length,
    matched: verdict.matchedCount,
    surplus: verdict.surplus,
    paginationException: verdict.usedPaginationException ?? false,
    templatedDates: templatedCount,
    droppedColumns: verdict.droppedOptionalColumns ?? [],
    maskAcceptedColumns: verdict.maskAcceptedColumns ?? [],
  });
  return {
    ...input.success,
    action: { ...input.success.action, parse: { mode: 'api', hint } },
    ...(mergedEnums ? { enumMappings: mergedEnums } : {}),
  };
}

/** Runner-local calendar date (the Date getters apply the process TZ). */
function isoFromLocalClock(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every calendar-valid ISO reading of a DOM date cell. */
function interpretDomDate(raw: string): string[] {
  const direct = parseIsoDate(raw) ?? parseTextualDate(raw);
  if (direct) return [direct];
  return numericDateInterpretations(raw);
}

/** ISO of an API-side date value when unambiguous; null otherwise. */
function isoOfApiDateValue(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const direct = parseIsoDate(v) ?? parseTextualDate(v);
  if (direct) return direct;
  const interps = numericDateInterpretations(v);
  return interps.length === 1 ? interps[0]! : null;
}

/** ISO of an API date value ONLY when SELF-DESCRIBING (ISO YYYY-MM-DD or
 *  textual-month). Unlike isoOfApiDateValue this NEVER guesses a numeric M/D
 *  order: a DOM-blind date column has no DOM-learned order, so a numeric or
 *  ambiguous value must never be trusted by the blind-date temporal proofs
 *  (fix/cua-two-oracle, review P1). */
function selfDescribingIso(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  return parseIsoDate(v) ?? parseTextualDate(v);
}

/** Union the agent's DOM enum vocabulary with the verified API-side raws.
 *  Collisions were already rejected as contradictions during reconcile. */
function mergeDerivedEnumMappings(
  dom: Record<string, Record<string, string>> | undefined,
  derived: Record<string, Record<string, string>> | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!derived || Object.keys(derived).length === 0) return dom;
  const out: Record<string, Record<string, string>> = {};
  for (const [col, m] of Object.entries(dom ?? {})) out[col] = { ...m };
  for (const [col, m] of Object.entries(derived)) out[col] = { ...(out[col] ?? {}), ...m };
  return out;
}

/** Truncate + privacy-shape a value for the identify prompt. DOM cells in
 *  name-ish columns are masked (letters→x, digits→#) — the LLM maps columns
 *  by key names and value SHAPES, it never needs real guest names. Captured
 *  API sample rows are already redacted upstream (response-redaction.ts). */
function promptValue(col: string, value: unknown): string {
  let s = String(value ?? '');
  if (NAME_MASK_COLS.test(col)) s = s.replace(/[A-Za-z]/g, 'x').replace(/\d/g, '#');
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function buildIdentifyPrompt(args: {
  actionName: keyof Recipe['actions'];
  contract: NonNullable<(typeof CORE_TARGET_CONTRACTS)[keyof Recipe['actions']]>;
  domRows: Array<Record<string, string>>;
  candidates: Array<{ call: CapturedCall; arrays: Array<{ jsonPath: string; rows: Array<Record<string, unknown>> }> }>;
}): string {
  const lines: string[] = [];
  lines.push(`TARGET FEED: ${args.actionName}`);
  lines.push('OUR COLUMNS (snake_case, * = required):');
  for (const c of args.contract.columns) {
    lines.push(`  ${c.name}${c.required ? '*' : ''} (${c.type})`);
  }
  lines.push('');
  lines.push(`DOM TABLE ROWS (ground truth, ${args.domRows.length} total; first 3 shown, name values shape-masked):`);
  for (const row of args.domRows.slice(0, 3)) {
    const cells = Object.entries(row).map(([k, v]) => `${k}=${JSON.stringify(promptValue(k, v))}`);
    lines.push(`  { ${cells.join(', ')} }`);
  }
  lines.push('');
  lines.push('CAPTURED JSON CALLS:');
  args.candidates.forEach((cand, i) => {
    const bodyNote = cand.call.requestBody
      ? ` body=${JSON.stringify(cand.call.requestBody.slice(0, 300))}`
      : '';
    lines.push(`#${i} ${cand.call.method.toUpperCase()} ${cand.call.url.slice(0, 300)}${bodyNote}`);
    for (const arr of cand.arrays.slice(0, 2)) {
      const sample = arr.rows[0]!;
      const cells = Object.entries(sample)
        .slice(0, 25)
        .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(promptValue(k, typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 60) : v))}`);
      lines.push(`   rows at ${JSON.stringify(arr.jsonPath)} (${arr.rows.length} rows), sample row: { ${cells.join(', ')} }`);
    }
  });
  lines.push('');
  lines.push('Which candidate (if any) holds the SAME records as the DOM rows? Output the JSON object only.');
  return lines.join('\n');
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
  /** Plan v10 (FIX 2) — `required === false` tightens this drill-down's budget
   *  (optional getLostAndFound / getActivityLog). Required getGuests (and any
   *  caller that omits this) keeps the full budget. */
  required?: boolean;
  /** Plan v8 review P0-A — per-job cap override (vision uses higher cap). */
  jobCostCapMicros?: number;
  /** feature/cua-live-view — see MapperOptions.onLiveFrame. */
  onLiveFrame?: (pngBase64: string) => void;
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
  // Plan v10 (FIX 2) — optional drill-downs (lost & found, activity log) get a
  // tighter budget; the required getGuests drill-down keeps the full one. Step
  // cap is PER record; effectiveStepCap below multiplies by SAMPLE_COUNT
  // (optional: 30/sample → 90 total; required: 60/sample → 180 total).
  const { stepCap: targetStepCap, costCapMicros: targetCostCapMicros } =
    targetBudget(classification, args.required === false);
  // Drill-down samples = 3; cost scales roughly with sample count.
  const SAMPLE_COUNT = 3;

  const fullGoal =
    args.goal +
    `\n\nDRILL-DOWN WORKFLOW:\n` +
    `1. Take a SCREENSHOT to see the dashboard menus.\n` +
    `2. Navigate to the LIST page by clicking visible menus (e.g. ` +
    `reservations list, lost-items list).\n` +
    `3. Look at the list visually. Its column HEADERS are tagged with numbered ` +
    `badges (e.g. "H1", "H2", …). Map each row field to a column by its HEADER ` +
    `MEANING first, note that header's column position N, and write the cell ` +
    `selector as \`td:nth-child(N)\` for the SAME N (most PMSes use \`tr\` for ` +
    `rows). Header-anchoring — not a pixel guess — is what lets us re-find a ` +
    `column if the PMS reorders or renames its columns later.\n` +
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
  // Admin-wait credit — see the matching note in mapActionCore.
  let helpWaitMs = 0;
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
  let loopDetector = new ActionLoopDetector();
  // Plan v10 (FIX 1) — same deliberate-backtrack tracker mapAction uses. The
  // drill-down's required getGuests feed backtracks to find its list page; reset
  // the detector on each return so re-screenshotting the dashboard can't
  // loop-fail it, and cap the returns.
  const dashboardTracker = new DashboardReturnTracker(args.postLoginUrl);

  for (let stepIdx = 0; stepIdx < effectiveStepCap; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      return { ok: false, reason: 'token budget exceeded', finalUrl: args.page.url() };
    }
    if (Date.now() - phaseStartedAt - helpWaitMs > PHASE_WALLCLOCK_BUDGET_MS) {
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

    // Plan v10 (FIX 1) — deliberate-backtrack accounting (mirrors mapAction). Top
    // of the step, before this step's actions are recorded into the loop detector.
    const backtrack = dashboardTracker.onTurn(safeUrl(args.page));
    if (backtrack === 'cap') {
      log.warn('drilldown mapper: dashboard-return cap reached — giving up instead of bouncing', {
        jobId: args.jobId ?? undefined,
        actionName: args.actionName,
        dashboardReturns: dashboardTracker.count,
        maxReturns: MAX_DASHBOARD_RETURNS,
      });
      return {
        ok: false,
        reason: `exhausted ${MAX_DASHBOARD_RETURNS} dashboard returns without locating ${args.actionName}`,
        finalUrl: safeUrl(args.page),
      };
    }
    if (backtrack === 'reset') {
      loopDetector = new ActionLoopDetector();
      log.info('drilldown mapper: deliberate dashboard return — loop detector reset for a fresh leg', {
        jobId: args.jobId ?? undefined,
        actionName: args.actionName,
        dashboardReturns: dashboardTracker.count,
        maxReturns: MAX_DASHBOARD_RETURNS,
      });
    }

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
          let hintText = helpOutcome.hintText;
          if (helpOutcome.supervisorClick) {
            const sup = await executeSupervisorClick({
              page: args.page,
              credentials: args.credentials,
              click: helpOutcome.supervisorClick,
              adminNote: helpOutcome.hintText,
              jobId: args.jobId,
              targetKey: args.actionName,
            });
            if (sup.recordedStep) recordedSteps.push(sup.recordedStep);
            hintText = sup.hintText;
          }
          messages.pop();
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `Hint from your supervisor: ${hintText}\n\nContinue working on this drill-down target.` }],
          });
          readPageCount = 0;
          navigationCount = 0;
          helpWaitMs += helpOutcome.waitedMs;
          continue;
        }
        if (helpOutcome.kind === 'abort') {
          throw new Error(helpOutcome.reason);
        }
        return {
          ok: false,
          reason: helpOutcome.reason,
          finalUrl: args.page.url(),
          // Floor-met branch — agent declared unavailable (see mapActionCore).
          unavailable: true,
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
            // Learning Board — legitimately empty list today.
            boardPreview: { rowCount: 0, sampleKind: 'rows' },
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
          // Learning Board — the drilled sample records ARE real captured
          // data; reuse them instead of re-scraping (the page is sitting on
          // a detail record, not the list, at this point).
          boardPreview: {
            sample: truncatePreviewRows(sampleRowData),
            sampleKind: 'records',
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
          let hintText = helpOutcome.hintText;
          if (helpOutcome.supervisorClick) {
            const sup = await executeSupervisorClick({
              page: args.page,
              credentials: args.credentials,
              click: helpOutcome.supervisorClick,
              adminNote: helpOutcome.hintText,
              jobId: args.jobId,
              targetKey: args.actionName,
            });
            if (sup.recordedStep) recordedSteps.push(sup.recordedStep);
            hintText = sup.hintText;
          }
          messages.pop();
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `Hint from your supervisor: ${hintText}\n\nContinue working on this drill-down target.` }],
          });
          readPageCount = 0;
          navigationCount = 0;
          helpWaitMs += helpOutcome.waitedMs;
          continue;
        }
        if (helpOutcome.kind === 'abort') {
          throw new Error(helpOutcome.reason);
        }
        return {
          ok: false,
          reason: helpOutcome.reason,
          finalUrl: args.page.url(),
          // ask_admin branch — unavailable only on an explicit admin answer.
          ...(helpOutcome.viaAdmin ? { unavailable: true } : {}),
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
      // feature/cua-live-view — tee the (already privacy-hardened)
      // screenshot to the Learning Board's live view. Fire-and-forget.
      if (exec.screenshotB64) args.onLiveFrame?.(exec.screenshotB64);
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
 * Detect a one-time-code / MFA login screen. Used in mapLogin to (a) pause for
 * a code via the 2FA flow instead of spinning, and (b) as a hard guard in the
 * login-confirmation gate (isLoginConfirmed) — an MFA interstitial is never
 * accepted as "logged in".
 *
 * fix/cua-login-universal — strengthened to stay reliable across 10+ PMS
 * families and languages, because the looser confirmation gate now leans on
 * it: an MFA page has no password field, so MFA detection is the main thing
 * standing between "challenge screen" and a false "logged in". Three signals,
 * all language-independent except the (best-effort) phrase list:
 *   - VISIBLE input whose NAME/id/autocomplete matches otp|mfa|2fa|totp|
 *     one-time|passcode (specific tokens that essentially never appear on a
 *     normal logged-in page). Deliberately NOT "verification" — that would
 *     false-match the hidden ASP.NET `__RequestVerificationToken` antiforgery
 *     field present on every page of many PMS;
 *   - autocomplete="one-time-code" (web standard), or a VISIBLE 6-digit numeric
 *     input (the OTP norm; bare-length stays at 6 to avoid matching hotel
 *     room-number / confirmation-number / PIN fields — 4/8-digit codes still
 *     match via the name or autocomplete branch);
 *   - common code-screen phrases in several languages (innerText is inherently
 *     visible text, so hidden tokens don't leak in here either).
 * Shadow-DOM piercing + frame-aware (some PMS render the challenge in an
 * iframe), and HIDDEN inputs are ignored so antiforgery/CSRF tokens can't
 * masquerade as a code field.
 *
 * Best-effort: any evaluate error returns false so the caller proceeds exactly
 * as it did before this check existed.
 */
async function detectMfaScreen(page: Page): Promise<boolean> {
  return anyFrameMatches(page, () => {
    const text = (document.body?.innerText ?? '').toLowerCase();
    const phrases = [
      // English
      'verification code', 'one-time code', 'one time code', 'one-time passcode',
      'two-factor', 'two factor', 'multi-factor', 'authentication code',
      'security code', 'enter the code',
      // Common localizations (language ≠ PMS-specific) — keep the universal
      // path working for non-English PMS.
      'código de verificación', 'código de seguridad', // ES
      'code de vérification', 'code de sécurité',       // FR
      'verifizierungscode', 'sicherheitscode', 'bestätigungscode', // DE
      'código de verificação',                          // PT
      'codice di verifica', 'codice di sicurezza',      // IT
      'verificatiecode',                                // NL
    ];
    if (phrases.some((p) => text.includes(p))) return true;
    // Collect inputs across the light DOM AND open shadow roots.
    const inputs: HTMLInputElement[] = [];
    const walk = (root: ParentNode) => {
      root.querySelectorAll('*').forEach((el) => {
        if (el instanceof HTMLInputElement) inputs.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };
    walk(document);
    const visible = (el: HTMLElement): boolean => {
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const codeNameRe = /otp|mfa|2fa|totp|one[-_]?time|passcode/i;
    return inputs.some((input) => {
      // Ignore hidden inputs — antiforgery tokens (__RequestVerificationToken),
      // CSRF fields, etc. are never the visible code box the user types into.
      if (!visible(input)) return false;
      const nameBlob =
        (input.getAttribute('name') ?? '') + ' ' + input.id + ' ' +
        (input.getAttribute('autocomplete') ?? '');
      const autocomplete = (input.getAttribute('autocomplete') ?? '').toLowerCase();
      const maxLen = input.getAttribute('maxlength');
      const inputMode = (input.getAttribute('inputmode') ?? '').toLowerCase();
      const numeric = input.type === 'tel' || input.type === 'number' || inputMode === 'numeric';
      if (autocomplete.includes('one-time-code')) return true;
      if (codeNameRe.test(nameBlob)) return true;
      if (maxLen === '6' && numeric) return true;
      return false;
    });
  });
}

/**
 * fix/cua-login-universal — is a live credential-entry form on screen? Used by
 * the login-confirmation gate to reject a premature "logged in" claim that's
 * actually still sitting on the login (or a re-rendered/re-auth) page.
 *
 * Universal signal: a VISIBLE password input. It's the one cross-PMS marker of
 * a credential form with a low false-positive rate (a generic text input is
 * indistinguishable from a search box). Pierces open shadow roots and scans all
 * accessible frames so web-component and iframe-hosted logins are seen.
 * Best-effort — any evaluate error returns false so confirmation proceeds (the
 * credentials-submitted corroborator and the MFA guard still apply). Known
 * limitation: a login form inside a CROSS-origin iframe can't be read; the
 * credentials-submitted gate still prevents accepting before the agent types
 * the password.
 */
async function loginFormPresent(page: Page): Promise<boolean> {
  return anyFrameMatches(page, () => {
    const inputs: HTMLInputElement[] = [];
    const walk = (root: ParentNode) => {
      root.querySelectorAll('*').forEach((el) => {
        if (el instanceof HTMLInputElement) inputs.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };
    walk(document);
    const visible = (el: HTMLElement): boolean => {
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    // `.type` is the IDL property — always normalized lowercase, so this is
    // case-robust without an attribute-selector `i` flag.
    return inputs.some((el) => el.type === 'password' && visible(el));
  });
}

/**
 * fix/cua-login-universal — run a DOM predicate in EVERY accessible frame (the
 * top document + same-origin child frames) and return true if any frame yields
 * true. Cross-origin frames throw on evaluate and are skipped. Best-effort: a
 * total failure returns false so callers proceed exactly as before. Frame-aware
 * because some PMS render the login form OR the post-login app inside an iframe,
 * and a top-document-only probe would miss a re-rendered login / MFA challenge
 * there and false-accept.
 */
async function anyFrameMatches(page: Page, predicate: () => boolean): Promise<boolean> {
  try {
    const results = await Promise.all(
      page.frames().map((frame) => frame.evaluate(predicate).catch(() => false)),
    );
    return results.some(Boolean);
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
  `Find the page that shows EVERY room and its current housekeeping/occupancy ` +
  `status — a per-room status list (one row per room). It may be called a ` +
  `"Room Status" report, a housekeeping board or grid, a "Check-off List", a ` +
  `"Daily Maid Sheet", or simply the room list — ANY page that shows room-by-room ` +
  `status IS the right one; you do NOT need a separately-named "report".\n\n` +
  `It often sits under "Housekeeping", "Front Desk", "Rooms", or "Reports". ` +
  `You may need to set filters (date=today, all rooms, all statuses) ` +
  `before it renders.\n\n` +
  `Use these EXACT keys ` +
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
  `  - room_number (optional)\n\n` +
  `If there are no departures right now, the page may show an empty list or a ` +
  `"no records" message — that is STILL the correct page; capture it (read the ` +
  `column selectors from the header row). Make sure the heading says ` +
  `Departures / Check-Outs, not Arrivals — they sit next to each other.`;
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
  `Some PMSes render this list only after you open the section — a click on the ` +
  `menu item may load the list via a background request rather than showing a ` +
  `table immediately. If the menu item does not show a list right away, click it, ` +
  `wait for the list to appear, then capture it.\n\n` +
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

const ROOM_LAYOUT_GOAL =
  `Find the ROOM LIST / ROOM CONFIGURATION — the master list of every physical ` +
  `room in the hotel (NOT today's housekeeping status, NOT reservations). One ` +
  `ROW per room, showing the room number and its fixed attributes (room type, ` +
  `bed config, floor, max occupancy). Sometimes called "Rooms", "Room List", ` +
  `"Room Setup", "Room Configuration", "Room Inventory", "Unit List", or "Room ` +
  `Types & Rooms".\n\n` +
  `Usually under "Setup", "Configuration", "Property", "Admin", or "Rooms" — ` +
  `often 2-3 clicks deep in a settings menu. It is a STATIC list (it does not ` +
  `change daily), so any page that enumerates all rooms with their types is the ` +
  `answer; do NOT confuse it with the live housekeeping board.\n\n` +
  `Use these EXACT keys in your "columns" object:\n` +
  `  - room_number (required — the room's number/name, the unique id)\n` +
  `  - room_type (optional — room type / class / category code)\n` +
  `  - bed_config (optional — e.g. "1 King", "2 Queen")\n` +
  `  - floor (optional)\n` +
  `  - max_occupancy (optional — max guests, a number)`;

const DASHBOARD_COUNTS_GOAL =
  `Capture the LIVE "RIGHT NOW" OCCUPANCY COUNTERS shown on the home dashboard ` +
  `— the summary numbers for how full the hotel is this moment: occupied rooms, ` +
  `vacant clean / vacant dirty, out-of-order, arrivals still to come today, ` +
  `departures still to come today.\n\n` +
  `IMPORTANT — this feed is the EXCEPTION to the "a dashboard tile of totals is ` +
  `not the feed" rule below: for THIS target the dashboard's summary counters ` +
  `ARE exactly what we want. Do NOT drill into a per-room or per-reservation ` +
  `list — stay on the home/dashboard page and read the counters there. These ` +
  `are single NUMBERS (one value each), not a repeating table.\n\n` +
  `Emit a "rowSelector" that matches the SINGLE container element wrapping the ` +
  `counters (so it matches exactly one element), and put a selector to each ` +
  `counter's number in "columns". Use these EXACT keys (include only the ones ` +
  `actually shown):\n` +
  `  - total_occupied_rooms (the count of rooms currently occupied)\n` +
  `  - total_vacant_clean (optional)\n` +
  `  - total_vacant_dirty (optional)\n` +
  `  - total_ooo (optional — out-of-order rooms)\n` +
  `  - arrivals_remaining_today (optional — arrivals not yet checked in)\n` +
  `  - departures_remaining_today (optional — departures not yet checked out)\n` +
  `  - total_guests_in_house (optional)`;

const HISTORICAL_OCCUPANCY_GOAL =
  `Find a HISTORICAL DAILY OCCUPANCY report — one ROW per PAST date showing how ` +
  `full the hotel was that day (occupied rooms, occupancy %). Sometimes called ` +
  `"Occupancy History", "Daily Occupancy", "Historical Statistics", "Manager's ` +
  `Report" (history view), "Trend Report", or "Daily Operating Report" across a ` +
  `date range.\n\n` +
  `Usually under "Reports → Statistics", "Reports → Occupancy", or "Reports → ` +
  `Manager". If you can pick a date range, choose RECENT PAST dates (the last ` +
  `week or two). On smaller franchise-tier PMSes this may not exist — if so, ` +
  `emit unavailable per the system prompt rules (after the evidence floor). Do ` +
  `NOT confuse it with the FORWARD-looking forecast/pace report.\n\n` +
  `Use these EXACT keys in your "columns" object:\n` +
  `  - date (required — the business date this row is for)\n` +
  `  - occupied_rooms (required — rooms sold that night)\n` +
  `  - occupancy_pct (optional — percent occupied)\n` +
  `  - available_rooms (optional — rooms available to sell)\n` +
  `  - adr_cents (optional — Average Daily Rate, if shown)\n` +
  `  - rooms_revenue_cents (optional — room revenue, if shown)`;

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

  // feature/cua-feed-extract — two ACTIVE feeds that had write-routes
  // (pms_in_house_snapshot / pms_rooms_inventory) but were never in TARGETS, so
  // the learner never learned them. Optional so they never gate or regress the
  // 4 core required feeds; placed in Tier 1 because both are live operational
  // data. getDashboardCounts IS the in-house snapshot (no separate target).
  {
    key: 'getDashboardCounts',
    goal: DASHBOARD_COUNTS_GOAL,
    // pms_in_house_snapshot: property_id is the PK (writer-stamped) and the
    // counts are all optional integers; total_occupied_rooms is the one we
    // most need, so it's the prompt's required field.
    requiredFields: ['total_occupied_rooms'],
    classification: 'list_page',
    optional: true,
    progressLabel: 'Reading the live occupancy dashboard…',
    progressPct: 53,
  },
  {
    key: 'getRoomLayout',
    goal: ROOM_LAYOUT_GOAL,
    // pms_rooms_inventory natural key is (property_id, room_number); room_number
    // is the one column the model must emit.
    requiredFields: ['room_number'],
    classification: 'report_menu',  // room setup is usually 2-3 clicks deep
    optional: true,
    progressLabel: 'Finding the room list / room types…',
    progressPct: 54,
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
    // feature/cua-feed-extract — historical daily occupancy. Shares the
    // pms_revenue_daily table with getRevenueDaily (upsert by property_id+date),
    // but focuses on the OCCUPANCY columns and PAST dates. Optional — never
    // gates promotion.
    key: 'getHistoricalOccupancy',
    goal: HISTORICAL_OCCUPANCY_GOAL,
    requiredFields: ['date', 'occupied_rooms'],
    classification: 'report_menu',
    optional: true,
    progressLabel: 'Finding historical daily occupancy…',
    progressPct: 58,
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

/**
 * feature/cua-feed-extract — test accessor for the ordered target keys the
 * learner actually loops over (the `for (const target of TARGETS)` in mapPMS).
 * Lets a unit test assert a net-new feed is genuinely enrolled, not just routed.
 */
export function targetKeysForTests(): Array<keyof Recipe['actions']> {
  return TARGETS.map((t) => t.key);
}
