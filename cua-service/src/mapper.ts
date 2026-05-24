/**
 * PMS mapper — DOM-aware (browser tool) version.
 *
 * Uses Anthropic's `browser` custom tool family (modeled on
 * anthropic-quickstarts/browser-use-demo) instead of the older pixel-click
 * `computer` tool. The agent reasons in DOM element refs (ref_1, ref_2, …)
 * which the tool resolves to live elements via window.__claudeElementMap.
 *
 * Output is still a Recipe (see types.ts) — the recipe shape is the same
 * but the recorded steps are selector-based (kind: 'click' / 'fill') rather
 * than coordinate-based (kind: 'click_at' / 'type_text'). This makes the
 * recipe survive PMS layout changes that would have broken the old mapper's
 * coordinate-based output.
 *
 * Cost expectation: ~$0.30-0.80 per full mapping run (login + 4 actions)
 * on Sonnet 4.6, vs $1-2 on Sonnet 4.5 with computer-use. The token spend
 * is dominated by read_page outputs (DOM trees), not screenshots — we
 * truncate older read_page results to keep per-turn context bounded.
 */

import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, BROWSER_TOOL, CLAUDE_MODEL, MAPPING_SYSTEM_PROMPT, getModeConfig } from './anthropic-client.js';
import { executeBrowserAction, type BrowserAction } from './browser-tool.js';
import { executeVisionAction, type VisionAction } from './browser-tool-vision.js';
import { safeGoto } from './browser-utils/navigate.js';
import { log } from './log.js';
import { logClaudeUsage, getJobCostMicros } from './usage-log.js';
import { env } from './env.js';

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

const MAX_AGENT_STEPS_LOGIN = 60;
// Higher cap for per-action mapping — action 4 (staff) is buried in
// admin menus on most PMSes and needs more exploration than login.
const MAX_AGENT_STEPS_PER_ACTION = 80;
const VIEWPORT = { width: 1280, height: 800 };

// Token + wallclock guards. Browser-tool's read_page is the heaviest call
// — DOM trees can be 5-30K tokens each. We aggressively truncate to keep
// per-turn context bounded:
//   - Only the LATEST read_page output is kept verbatim; older ones
//     become a 1-line marker. The agent only acts on the current state.
//   - Same for screenshots — only the latest is kept.
//   - We also TRUNCATE huge tool_result text (> READ_PAGE_TRUNCATE_CHARS)
//     before sending. CA's DOM trees can be 100K+ chars; sending those
//     once burns the budget on its own.
//
// Combined with prompt caching on the system prompt, a 60-step run on
// CA fits well under MAX_INPUT_TOKENS_PER_RUN.
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
const PHASE_WALLCLOCK_BUDGET_MS = 5 * 60_000;
// Plan v8 review P1-B — vision is 3-5× slower per target (more turns, image
// generation time per screenshot). 5min wallclock would constantly trip
// before vision even gets a chance to find anything. 15min matches the
// vision-mode per-target step cap headroom.
const PHASE_WALLCLOCK_BUDGET_MS_VISION = 15 * 60_000;
const HISTORY_KEEP_RECENT = 1;
// Plan v8 P0-1 — vision mode keeps last 3 screenshots in history (vs DOM's 1).
// Vision conversations balloon with image tokens; truncating aggressively
// keeps each turn under the per-target cost cap. 3 is a balance: enough
// recent context for the model to re-orient after each action, few enough
// that input-token cost stays bounded.
const HISTORY_KEEP_RECENT_VISION = 3;

/**
 * Plan v8 — mode-aware history retention. DOM mode keeps 1 image (screenshot
 * action is rare, mostly a fallback). Vision mode keeps 3 — every turn ships
 * a screenshot, and the model needs the recent few for continuity.
 */
function historyKeepFor(mode: 'dom' | 'vision'): number {
  return mode === 'vision' ? HISTORY_KEEP_RECENT_VISION : HISTORY_KEEP_RECENT;
}

/**
 * Plan v8 review P1-B — wallclock budget per phase, mode-aware. Vision needs
 * more headroom because each turn is slower (screenshot + image-token input)
 * and the model often takes 3-5× more turns to find an element via vision.
 */
function phaseWallclockFor(mode: 'dom' | 'vision'): number {
  return mode === 'vision' ? PHASE_WALLCLOCK_BUDGET_MS_VISION : PHASE_WALLCLOCK_BUDGET_MS;
}
// Truncate any single read_page or get_page_text result over this size.
// 20K chars ≈ 5-6K tokens. Most pages have a few hundred interactive
// elements; this is more than enough for navigation, less than enough
// to drown the agent in noise.
const READ_PAGE_TRUNCATE_CHARS = 20_000;

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
   * checkBudget. Vision-mode jobs set this to $50 during canary; flip to
   * $25 once paper-cost is measured. DOM-mode jobs keep the $5 env default.
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
   * Plan v8 Phase A — mapper mode.
   *   'dom'    — custom browser tool with DOM accessibility tree + refs
   *              (cheap, works on PMSes with parseable HTML, ~$3-6/run)
   *   'vision' — Anthropic's computer_20251124 beta tool with screenshots
   *              + pixel coordinates (works on canvas/Flash/DOS-style
   *              PMSes, ~$15-25/run; requires computer-use-2025-11-24
   *              beta header which getModeConfig handles)
   * Default 'dom' for backward compat. Per-job override via
   * workflow_jobs.payload.mapper_mode (mapping-driver reads + passes here).
   */
  mode?: 'dom' | 'vision';
  /**
   * Plan v8 Phase A — Claude model. Sonnet 4.6 is the cheap default; admin
   * can opt into Opus 4.7 per-job for hard PMSes via the same payload route.
   * Both models support the computer-use-2025-11-24 beta header.
   */
  model?: 'claude-sonnet-4-6' | 'claude-opus-4-7';
}

/**
 * Pre-call budget check. Each `mapAction()` step loop can fire 60-80
 * Anthropic calls before mapPMS's between-phase guard runs again — a
 * stuck phase could blow past CUA_JOB_COST_CAP_MICROS by several dollars.
 * Codex audit 2026-05-12. Cheap (~50ms Supabase query) vs. each Anthropic
 * call (~3-30s + cost), so it's worth running before every turn.
 */
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

    // Plan v8 Phase A: resolve mode once for the whole run. Same mode used
    // by login, mapAction, mapDrillDownAction. Per-job override via opts.mode.
    const mode = opts.mode ?? 'dom';
    const model = opts.model;

    // ─── Phase 1: learn the login flow ─────────────────────────────────────
    opts.onProgress?.('Logging in for the first time…', 25);
    const loginResult = await mapLogin(page, opts.credentials, {
      propertyId: opts.propertyId ?? null,
      jobId: opts.jobId ?? null,
      signal: opts.signal,
      mode,
      model,
      jobCostCapMicros: opts.jobCostCapMicros,
    });
    if (!loginResult.ok) {
      return { ok: false, userMessage: loginResult.userMessage, detail: loginResult.detail };
    }

    const postLoginUrl = page.url();
    log.info('login mapped', { postLoginUrl, steps: loginResult.steps.steps.length });

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

    const actions: Recipe['actions'] = {};

    for (const target of TARGETS) {
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
            mode,
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
            mode,
            model,
            jobCostCapMicros: opts.jobCostCapMicros,
          });
      if (result.ok) {
        actions[target.key] = result.action;
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

    const recipe: Recipe = {
      schema: 1,
      description: `Auto-mapped recipe for ${opts.pmsType} (browser-tool mapper). Actions: ${Object.keys(actions).join(', ')}.`,
      login: loginResult.steps,
      actions,
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
    /** Plan v8 — picked at mapPMS entry; same mode used for login + targets. */
    mode: 'dom' | 'vision';
    model?: 'claude-sonnet-4-6' | 'claude-opus-4-7';
    /** Plan v8 review P0-A — per-job cap override. */
    jobCostCapMicros?: number;
  },
): Promise<LoginMapResult | LoginMapFailure> {
  // Plan v8: resolve tool + system prompt + beta header + model by mode.
  // Mode-aware Anthropic call replaces direct CLAUDE_MODEL / BROWSER_TOOL /
  // MAPPING_SYSTEM_PROMPT references below.
  const cfg = getModeConfig(ctx.mode, ctx.model);
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
    (ctx.mode === 'vision'
      ? `STEP-BY-STEP (vision mode):\n` +
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
        `9. Repeat screenshot + click as needed to reach the dashboard.\n\n`
      : `STEP-BY-STEP:\n` +
        `1. Call read_page with text="interactive" to see the form fields and ` +
        `their refs.\n` +
        `2. Call form_input with the username field's ref and value="$username".\n` +
        `3. Call form_input with the password field's ref and value="$password".\n` +
        `4. Click the submit button (form_input or left_click with the submit ref).\n` +
        `5. Wait for the next page (use wait if it's slow), then read_page again.\n` +
        `6. If you land on a property picker, click the FIRST property. If you ` +
        `land on a "Welcome" splash (Choice Advantage), click "Continue" or ` +
        `"Enter PMS".\n` +
        `7. Repeat read_page + click as needed to reach the dashboard.\n\n`) +
    successCriteria;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: goal }] },
  ];

  const phaseStartedAt = Date.now();

  for (let stepIdx = 0; stepIdx < MAX_AGENT_STEPS_LOGIN; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      log.warn('mapper exceeded input token budget', { totalInputTokens, totalOutputTokens, stepIdx });
      return {
        ok: false,
        userMessage: 'Mapping took longer than expected — please contact support.',
        detail: { phase: 'login_mapping', reason: 'token_budget_exceeded', totalInputTokens },
      };
    }
    if (Date.now() - phaseStartedAt > phaseWallclockFor(ctx.mode)) {
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

    const response = await anthropic.beta.messages.create({
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN,
      system: [
        {
          type: 'text',
          text: cfg.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [cfg.tool as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      messages: truncateOldHistory(messages, historyKeepFor(ctx.mode)) as Anthropic.Beta.Messages.BetaMessageParam[],
      betas: ['prompt-caching-2024-07-31', ...cfg.betas],
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
        const successSelector = typeof parsed.dashboardSelector === 'string' ? parsed.dashboardSelector : 'body';
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
      // Plan v8 Phase A: dispatch by mode. VisionAction and BrowserAction
      // have different shapes; cast at the call edge.
      // Plan v2 F-AI-7: login phase — the policy layer allows writes on
      // login-shaped controls and refuses everything else (DOM mode has
      // ref-derived hints; vision mode passes empty hint per P1-1 Option I).
      const exec = ctx.mode === 'vision'
        ? await executeVisionAction(page, toolUse.input as VisionAction, creds, 'login')
        : await executeBrowserAction(page, toolUse.input as BrowserAction, creds, 'login');
      if (exec.recordedStep) recordedSteps.push(exec.recordedStep);
      toolResults.push(makeToolResult(toolUse.id, exec));
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

interface ActionMapSuccess { ok: true;  action: ActionRecipe }
interface ActionMapFailure { ok: false; reason: string; finalUrl: string }

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
  /** Plan v8 Phase A — picked at mapPMS entry; same mode used for all targets. */
  mode: 'dom' | 'vision';
  model?: 'claude-sonnet-4-6' | 'claude-opus-4-7';
  /** Plan v8 review P0-A — per-job cap override (vision uses higher cap). */
  jobCostCapMicros?: number;
}): Promise<ActionMapSuccess | ActionMapFailure> {
  // Plan v8: resolve config once at the top of the per-target loop.
  const cfg = getModeConfig(args.mode, args.model);
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

  const fullGoal =
    args.goal +
    (args.mode === 'vision'
      ? `\n\nWORKFLOW (vision mode — use the computer tool):\n` +
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
        `as unsupported and continue.\n\n`
      : `\n\nWORKFLOW (do these in order, don't skip):\n` +
        `1. Call \`read_page\` with text="interactive" — this gives you ALL ` +
        `clickable links/buttons on the dashboard with their refs.\n` +
        `2. SCAN the read_page output for any item whose name or aria-label ` +
        `matches the target page (e.g. for housekeeping look for "Housekeeping", ` +
        `"Rooms", "Status", "Maid"; for staff look for "Users", "Staff", "Setup", ` +
        `"Admin", "Employees"). The match doesn't have to be exact — partial is fine.\n` +
        `3. If a single obvious match exists, click that ref and read_page again.\n` +
        `4. If NO single match, click the most likely menu item (e.g. "Reports", ` +
        `"Setup", or a hamburger icon). Then read_page on the resulting submenu — ` +
        `submenus often hold the target.\n` +
        `5. If you've clicked through 2 menu levels and STILL don't see the target, ` +
        `try the \`find\` tool with the keyword (e.g. find("housekeeping")). It ` +
        `searches the whole DOM tree, not just visible items.\n` +
        `6. Once on the target page, look for a TABLE with one row per record. ` +
        `Identify a stable rowSelector. For each required field, find a column ` +
        `selector relative to one row.\n` +
        `7. If the page DOES NOT have the data we need (e.g. no Housekeeping ` +
        `report exists in this PMS, or it's behind a paid module), reply with ` +
        `{"unavailable": true, "reason": "<why>"} so we can mark this action ` +
        `as unsupported and continue.\n\n`) +

    `WHEN DONE WITH A REAL PAGE — your reply MUST start with the JSON ` +
    `object on the first line. No preamble like "I found the page" or ` +
    `"Here's the result". Just the JSON, then optional brief notes ` +
    `after. Output is capped, so a long preamble can truncate the JSON.\n\n` +

    `EXACT FORMAT (first line of your reply):\n` +
    `  {"url":"<final URL>","rowSelector":"<CSS selector matching one row>",` +
    `"columns":{<our field name>:"<selector relative to row>"}}\n\n` +

    `Required fields for this page: ${args.requiredFields.join(', ')}\n` +
    `Use empty string for fields not visible on the page.\n\n` +

    `Step budget: you have up to ${MAX_AGENT_STEPS_PER_ACTION} actions. ` +
    `Spend the first ~5 on exploration (read_page + nav clicks); ` +
    `if you've used 50+ without finding the page, emit ` +
    `{"unavailable":true,"reason":"<what you tried>"} on the first line ` +
    `and stop. Skipping an action is better than burning the whole budget.`;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: fullGoal }] },
  ];

  const phaseStartedAt = Date.now();

  for (let stepIdx = 0; stepIdx < targetStepCap; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      return { ok: false, reason: 'token budget exceeded', finalUrl: args.page.url() };
    }
    if (Date.now() - phaseStartedAt > phaseWallclockFor(args.mode)) {
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

    const response = await anthropic.beta.messages.create({
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN,
      system: [
        {
          type: 'text',
          text: cfg.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [cfg.tool as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      messages: truncateOldHistory(messages, historyKeepFor(args.mode)) as Anthropic.Beta.Messages.BetaMessageParam[],
      betas: ['prompt-caching-2024-07-31', ...cfg.betas],
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
        | { rowSelector?: unknown; columns?: unknown; url?: unknown; unavailable?: unknown; reason?: unknown }
        | null;

      // Success path: agent found the page and emitted parse hints.
      if (parsed && typeof parsed.rowSelector === 'string' && parsed.columns && typeof parsed.columns === 'object') {
        return {
          ok: true,
          action: {
            steps: recordedSteps,
            parse: {
              mode: 'table',
              hint: {
                rowSelector: parsed.rowSelector,
                columns: parsed.columns as Record<string, string>,
              },
            },
          },
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
        return {
          ok: false,
          reason: `unavailable: ${typeof parsed.reason === 'string' ? parsed.reason : 'no reason given'}`,
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
      const action = toolUse.input as BrowserAction;
      // Plan v2 F-AI-7: action phase — write-style actions (type /
      // form_input / click) are refused. Mapper must navigate + read +
      // emit the JSON recipe; no mutations on the data pages.
      // Plan v8 Phase A: dispatch by mode (DOM vs vision executor).
      const exec = args.mode === 'vision'
        ? await executeVisionAction(args.page, toolUse.input as VisionAction, args.credentials, 'action')
        : await executeBrowserAction(args.page, action, args.credentials, 'action');
      if (exec.recordedStep) recordedSteps.push(exec.recordedStep);
      toolResults.push(makeToolResult(toolUse.id, exec));

      // Plan v7 — track activity for the unavailable floor.
      // DOM: read_page / get_page_text. Vision: screenshot. All count as
      // "actually looked at the page" evidence. Navigations / clicks count
      // toward the navigation budget regardless of mode.
      const actionType = (action as { action?: string }).action ?? '';
      if (actionType === 'read_page' || actionType === 'get_page_text' || actionType === 'screenshot') {
        readPageCount++;
      } else if (actionType === 'navigate' || actionType === 'left_click' ||
                 actionType === 'double_click' || actionType === 'find' ||
                 actionType === 'scroll_to' || actionType === 'form_input') {
        navigationCount++;
      }
    }

    messages.push({ role: 'user', content: toolResults });

    // Plan v7 — per-target cost soft-abort. After each round trip, check
    // cumulative job spend; if we've blown past the per-target cap, set
    // the flag and let the next iteration return cleanly. We DON'T abort
    // mid-call — the in-flight Anthropic call is already paid for, so we
    // let it complete and return whatever it had.
    if (args.jobId && targetCostCapMicros !== Number.POSITIVE_INFINITY) {
      const totalSpent = await getJobCostMicros(args.jobId);
      // Per-target budget is cumulative-relative — we don't have a clean
      // way to measure THIS target's spend separately from earlier targets,
      // so we approximate: if total job spend exceeds (priorTargets×cap +
      // thisTargetCap), this target has likely blown its budget. The
      // checkBudget global cap is the harder backstop.
      if (totalSpent > targetCostCapMicros * 3) {  // soft heuristic
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
  /** Plan v8 Phase A — same mode for all targets across the mapping run. */
  mode: 'dom' | 'vision';
  model?: 'claude-sonnet-4-6' | 'claude-opus-4-7';
  /** Plan v8 review P0-A — per-job cap override (vision uses higher cap). */
  jobCostCapMicros?: number;
}): Promise<ActionMapSuccess | ActionMapFailure> {
  // Plan v8: resolve config once at top.
  const cfg = getModeConfig(args.mode, args.model);

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
    (args.mode === 'vision'
      ? `\n\nDRILL-DOWN WORKFLOW (vision mode):\n` +
        `1. Take a SCREENSHOT to see the dashboard menus.\n` +
        `2. Navigate to the LIST page by clicking visible menus (e.g. ` +
        `reservations list, lost-items list).\n` +
        `3. Look at the list visually. Make your best-guess CSS selectors for ` +
        `the row + the columns of fields visible IN THE ROW (most PMSes use ` +
        `\`tr\` for rows + \`td:nth-child(N)\` for cells).\n`
      : `\n\nDRILL-DOWN WORKFLOW (do these in order):\n` +
        `1. read_page to see the dashboard menus.\n` +
        `2. Navigate to the LIST page (e.g. reservations list, lost-items list).\n` +
        `3. Capture the list page selectors: a stable rowSelector + columns ` +
        `for the fields visible IN THE ROW.\n`) +
    `4. Pick ${SAMPLE_COUNT} sample rows. For each one:\n` +
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
    `per the system-prompt floor (≥1 read_page, ≥3 navigations first).\n\n` +
    `Required fields: ${args.requiredFields.join(', ')}\n` +
    `Output the JSON on the first line of your reply — no preamble.`;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: fullGoal }] },
  ];

  const phaseStartedAt = Date.now();
  // Same unavailable-floor tracking as mapAction.
  const UNAVAILABLE_FLOOR = { readPages: 1, navigations: 3 };
  let readPageCount = 0;
  let navigationCount = 0;
  let targetOverBudget = false;

  // Drill-down step budget = per-target × sample-count (since each sample
  // is its own back-and-forth).
  const effectiveStepCap = targetStepCap * SAMPLE_COUNT;

  for (let stepIdx = 0; stepIdx < effectiveStepCap; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      return { ok: false, reason: 'token budget exceeded', finalUrl: args.page.url() };
    }
    if (Date.now() - phaseStartedAt > phaseWallclockFor(args.mode)) {
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

    const response = await anthropic.beta.messages.create({
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN,
      system: [
        { type: 'text', text: cfg.systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      tools: [cfg.tool as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      messages: truncateOldHistory(messages, historyKeepFor(args.mode)) as Anthropic.Beta.Messages.BetaMessageParam[],
      betas: ['prompt-caching-2024-07-31', ...cfg.betas],
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
        return {
          ok: false,
          reason: `unavailable: ${typeof parsed.reason === 'string' ? parsed.reason : 'no reason given'}`,
          finalUrl: args.page.url(),
        };
      }

      // Success path — validate shape, infer URL template, compute coverage.
      if (
        parsed &&
        typeof parsed.listUrl === 'string' &&
        typeof parsed.listRowSelector === 'string' &&
        parsed.listColumns && typeof parsed.listColumns === 'object' &&
        Array.isArray(parsed.samples) &&
        parsed.samples.length >= SAMPLE_COUNT
      ) {
        const samples = parsed.samples as DrillDownSamplePayload[];
        const sampleUrls: string[] = [];
        const sampleRowData: Array<Record<string, string>> = [];
        const sampleDetailColumns: Array<Record<string, string>> = [];
        for (const s of samples.slice(0, SAMPLE_COUNT)) {
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
          fieldCoverage[field] = `${present}/${SAMPLE_COUNT}`;
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
              samplesDrilled: SAMPLE_COUNT,
              // Plan v7 calls for a 4th-sample verification drill; for the
              // initial Phase 2a ship we treat successful inference as
              // verification. A follow-up enhancement (Phase 2c polish)
              // will add the explicit 4th drill.
              templateVerified: inference.ok,
            },
          },
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
      const action = toolUse.input as BrowserAction;
      // Plan v8 Phase A: dispatch by mode (DOM vs vision executor).
      const exec = args.mode === 'vision'
        ? await executeVisionAction(args.page, toolUse.input as VisionAction, args.credentials, 'action')
        : await executeBrowserAction(args.page, action, args.credentials, 'action');
      if (exec.recordedStep) recordedSteps.push(exec.recordedStep);
      toolResults.push(makeToolResult(toolUse.id, exec));

      const actionType = (action as { action?: string }).action ?? '';
      // Both DOM (read_page/get_page_text) and vision (screenshot) count
      // toward the "explored at least one page" floor — the agent must
      // have actually looked at SOMETHING before claiming unavailable.
      if (actionType === 'read_page' || actionType === 'get_page_text' || actionType === 'screenshot') readPageCount++;
      else if (actionType === 'navigate' || actionType === 'left_click' ||
               actionType === 'double_click' || actionType === 'find' ||
               actionType === 'scroll_to' || actionType === 'form_input') navigationCount++;
    }

    messages.push({ role: 'user', content: toolResults });

    if (args.jobId) {
      const totalSpent = await getJobCostMicros(args.jobId);
      if (totalSpent > targetCostCapMicros * 3) targetOverBudget = true;
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
  if (exec.screenshotB64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: exec.screenshotB64 },
    });
  }
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
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: exec.isError ?? false,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function extractFinalText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Walk the message history and elide older heavy content. Two passes:
 *   1. ELIDE — older instances (past `keepLast`) of screenshots and
 *      large text blocks (read_page output, get_page_text) become a
 *      one-line marker.
 *   2. TRUNCATE — even kept text blocks are capped at
 *      READ_PAGE_TRUNCATE_CHARS, with a clear note so the agent knows
 *      output was clipped. CA's DOM trees are 100K+ chars — sending
 *      one whole one burns the budget on its own.
 *
 * Without this, a 60-step run on a deep menu structure exhausts the
 * 400K input-token cap before reaching the data page. (Diagnosed
 * 2026-05-09 from CA canary v4 — 3/4 actions all failed at "token
 * budget exceeded" despite reaching the right URL.)
 */
function truncateOldHistory(
  messages: Anthropic.Messages.MessageParam[],
  keepLast: number,
): Anthropic.Messages.MessageParam[] {
  let imagesSeen = 0;
  let bigTextSeen = 0;
  const BIG_TEXT_THRESHOLD = 1500;

  const trimText = (text: string) => {
    if (text.length <= READ_PAGE_TRUNCATE_CHARS) return text;
    const head = text.slice(0, READ_PAGE_TRUNCATE_CHARS);
    return `${head}\n\n[…truncated ${text.length - READ_PAGE_TRUNCATE_CHARS} chars — page is large; use \`find\` for narrower searches]`;
  };

  const reversed = [...messages].reverse().map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const newContent = msg.content.map((block) => {
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const inner = block.content.map((b) => {
          if (b.type === 'image') {
            imagesSeen++;
            if (imagesSeen > keepLast) {
              return { type: 'text' as const, text: '[older screenshot elided]' };
            }
            return b;
          }
          if (b.type === 'text' && b.text.length > BIG_TEXT_THRESHOLD) {
            bigTextSeen++;
            if (bigTextSeen > keepLast) {
              return { type: 'text' as const, text: `[older read_page output elided — was ${b.text.length} chars]` };
            }
            // Kept — but still truncate if very large.
            return { ...b, text: trimText(b.text) };
          }
          return b;
        });
        return { ...block, content: inner };
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
  return reversed.reverse();
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
  `The right page shows a TABLE with one row per room. Look for these ` +
  `columns (names vary by PMS — match what's closest):\n` +
  `  - Room number (required)\n` +
  `  - Room type / category\n` +
  `  - Status (Occupied / Vacant)\n` +
  `  - Condition (Clean / Dirty / Inspected / Out of Order)\n` +
  `  - Stay/CO indicator (Stayover or Checkout)\n` +
  `  - Arrival date (for current/incoming guest)\n` +
  `  - Departure date\n` +
  `  - Assigned housekeeper (if shown)`;

const ARRIVALS_GOAL =
  `Find today's ARRIVALS list — sometimes called "Arrivals", "Today's ` +
  `Arrivals", "Check-Ins", or "Expected Arrivals". Shows reservations whose ` +
  `arrival date is today.\n\n` +
  `Usually under "Front Desk", "Reservations", or "View" menu. The right ` +
  `page is a list/table where each row is one reservation.\n\n` +
  `Columns we need:\n` +
  `  - Guest name\n` +
  `  - Room number\n` +
  `  - Arrival date\n` +
  `  - Departure date\n` +
  `  - Number of nights\n` +
  `  - Number of adults / children\n` +
  `  - Confirmation number (if shown)`;

const DEPARTURES_GOAL =
  `Find today's DEPARTURES list — sometimes called "Departures", "Check-Outs", ` +
  `or "Today's Departures". Shows reservations whose departure date is today. ` +
  `Usually right next to Arrivals in the menu.\n\n` +
  `Columns we need:\n` +
  `  - Guest name\n` +
  `  - Room number\n` +
  `  - Arrival date\n` +
  `  - Departure date\n` +
  `  - Confirmation number (if shown)\n` +
  `  - Checked-out flag (if shown)`;

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
  `  - priority (nice-to-have — "high" / "medium" / "low")\n` +
  `  - status (required — "open" / "in_progress" / "resolved")\n` +
  `  - assigned_to (nice-to-have)\n` +
  `  - out_of_order (required — boolean: does this take the room offline?)`;

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
    requiredFields: ['roomNumber', 'roomType', 'status', 'condition'],
    classification: 'list_page',
    optional: false,
    progressLabel: 'Finding the daily housekeeping report…',
    progressPct: 40,
  },
  {
    key: 'getArrivals',
    goal: ARRIVALS_GOAL,
    requiredFields: ['guestName', 'roomNumber', 'arrivalDate', 'departureDate'],
    classification: 'list_page',
    optional: false,
    progressLabel: "Finding today's arrivals…",
    progressPct: 44,
  },
  {
    key: 'getDepartures',
    goal: DEPARTURES_GOAL,
    requiredFields: ['guestName', 'roomNumber', 'arrivalDate', 'departureDate'],
    classification: 'list_page',
    optional: false,
    progressLabel: "Finding today's departures…",
    progressPct: 48,
  },
  {
    key: 'getWorkOrders',
    goal: WORK_ORDERS_GOAL,
    requiredFields: ['pms_work_order_id', 'description', 'status', 'out_of_order'],
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
];
