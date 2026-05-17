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
import { anthropic, BROWSER_TOOL, CLAUDE_MODEL, MAPPING_SYSTEM_PROMPT } from './anthropic-client.js';
import { executeBrowserAction, type BrowserAction } from './browser-tool.js';
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
const HISTORY_KEEP_RECENT = 1;
// Truncate any single read_page or get_page_text result over this size.
// 20K chars ≈ 5-6K tokens. Most pages have a few hundred interactive
// elements; this is more than enough for navigation, less than enough
// to drown the agent in noise.
const READ_PAGE_TRUNCATE_CHARS = 20_000;

interface MapperOptions {
  pmsType: PMSType;
  credentials: PMSCredentials;
  onProgress?: (step: string, pct: number) => void;
  // For Claude API spend attribution. Both nullable so dev/test runs work.
  propertyId?: string | null;
  jobId?: string | null;
  /**
   * Optional abort signal — passed to every anthropic.beta.messages.create()
   * call so the runJob timeout can actually cancel in-flight Claude requests
   * instead of letting them run to completion past the deadline. Added
   * 2026-05-12 after Codex audit flagged that timeouts only marked the DB
   * failed without interrupting the runaway work.
   */
  signal?: AbortSignal;
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
): Promise<{ over: false } | { over: true; spentMicros: number; capMicros: number }> {
  if (!jobId) return { over: false };
  const spentMicros = await getJobCostMicros(jobId);
  if (spentMicros >= JOB_COST_CAP_MICROS) {
    return { over: true, spentMicros, capMicros: JOB_COST_CAP_MICROS };
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

    // ─── Phase 1: learn the login flow ─────────────────────────────────────
    opts.onProgress?.('Logging in for the first time…', 25);
    const loginResult = await mapLogin(page, opts.credentials, {
      propertyId: opts.propertyId ?? null,
      jobId: opts.jobId ?? null,
      signal: opts.signal,
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
    const checkBudget = async (): Promise<MapperResult | null> => {
      if (!opts.jobId) return null;
      const spentMicros = await getJobCostMicros(opts.jobId);
      if (spentMicros >= JOB_COST_CAP_MICROS) {
        log.warn('cua mapper aborting — cumulative cost cap hit', {
          jobId: opts.jobId,
          spentMicros,
          capMicros: JOB_COST_CAP_MICROS,
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
            cap_micros: JOB_COST_CAP_MICROS,
          },
        };
      }
      return null;
    };

    // ─── Phase 2: per-action mapping ───────────────────────────────────────
    const actions: Recipe['actions'] = {};

    opts.onProgress?.('Finding the daily housekeeping report…', 40);
    {
      const overBudget = await checkBudget();
      if (overBudget) return overBudget;
    }
    const housekeepingReport = await mapAction({
      page,
      actionName: 'getRoomStatus',
      goal: HOUSEKEEPING_GOAL,
      requiredFields: ['roomNumber', 'roomType', 'status', 'condition'],
      postLoginUrl,
      credentials: opts.credentials,
      propertyId: opts.propertyId ?? null,
      jobId: opts.jobId ?? null,
      signal: opts.signal,
    });
    if (housekeepingReport.ok) actions.getRoomStatus = housekeepingReport.action;
    else log.warn('action mapping failed', { actionName: 'getRoomStatus', reason: housekeepingReport.reason, finalUrl: housekeepingReport.finalUrl });

    opts.onProgress?.('Finding today\'s arrivals…', 50);
    {
      const overBudget = await checkBudget();
      if (overBudget) return overBudget;
    }
    const arrivals = await mapAction({
      page,
      actionName: 'getArrivals',
      goal: ARRIVALS_GOAL,
      requiredFields: ['guestName', 'roomNumber', 'arrivalDate', 'departureDate'],
      postLoginUrl,
      credentials: opts.credentials,
      propertyId: opts.propertyId ?? null,
      jobId: opts.jobId ?? null,
      signal: opts.signal,
    });
    if (arrivals.ok) actions.getArrivals = arrivals.action;
    else log.warn('action mapping failed', { actionName: 'getArrivals', reason: arrivals.reason, finalUrl: arrivals.finalUrl });

    opts.onProgress?.('Finding today\'s departures…', 55);
    {
      const overBudget = await checkBudget();
      if (overBudget) return overBudget;
    }
    const departures = await mapAction({
      page,
      actionName: 'getDepartures',
      goal: DEPARTURES_GOAL,
      requiredFields: ['guestName', 'roomNumber', 'arrivalDate', 'departureDate'],
      postLoginUrl,
      credentials: opts.credentials,
      propertyId: opts.propertyId ?? null,
      jobId: opts.jobId ?? null,
      signal: opts.signal,
    });
    if (departures.ok) actions.getDepartures = departures.action;
    else log.warn('action mapping failed', { actionName: 'getDepartures', reason: departures.reason, finalUrl: departures.finalUrl });

    opts.onProgress?.('Finding the staff list…', 60);
    {
      const overBudget = await checkBudget();
      if (overBudget) return overBudget;
    }
    const staff = await mapAction({
      page,
      actionName: 'getStaffRoster',
      goal: STAFF_GOAL,
      requiredFields: ['name'],
      postLoginUrl,
      credentials: opts.credentials,
      propertyId: opts.propertyId ?? null,
      jobId: opts.jobId ?? null,
      signal: opts.signal,
    });
    if (staff.ok) actions.getStaffRoster = staff.action;
    else log.warn('action mapping failed', { actionName: 'getStaffRoster', reason: staff.reason, finalUrl: staff.finalUrl });

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
  ctx: { propertyId: string | null; jobId: string | null; signal?: AbortSignal },
): Promise<LoginMapResult | LoginMapFailure> {
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
  const goal =
    `Log into this hotel PMS. The username and password are NOT shown ` +
    `to you for security; pass these literal placeholder strings as the ` +
    `value when calling form_input or type, and the browser tool will ` +
    `substitute the real credentials before typing them into the page:\n` +
    `  username placeholder: "$username"\n` +
    `  password placeholder: "$password"\n\n` +

    `STEP-BY-STEP:\n` +
    `1. Call read_page with text="interactive" to see the form fields and ` +
    `their refs.\n` +
    `2. Call form_input with the username field's ref and value="$username".\n` +
    `3. Call form_input with the password field's ref and value="$password".\n` +
    `4. Click the submit button (form_input or left_click with the submit ref).\n` +
    `5. Wait for the next page (use wait if it's slow), then read_page again.\n` +
    `6. If you land on a property picker, click the FIRST property. If you ` +
    `land on a "Welcome" splash (Choice Advantage), click "Continue" or ` +
    `"Enter PMS".\n` +
    `7. Repeat read_page + click as needed to reach the dashboard.\n\n` +

    `WHEN YOU'RE LOGGED IN (you see a dashboard with hotel-specific data: ` +
    `room counts, today's date, guest names, navigation menu with ` +
    `reports/front-desk/etc.), reply with JSON ONLY (no commentary):\n` +
    `  {"loggedIn": true, "dashboardSelector": "<a CSS selector that's only ` +
    `present after login, like '.dashboard' or '#mainNav' or 'a[href*=\\"reports\\"]'>"}\n` +
    `Then stop.\n\n` +

    `IF login fails permanently (wrong creds, account locked, PMS down), ` +
    `reply with {"error": "<short reason>"} and stop.`;

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
      const budget = await isJobOverBudget(ctx.jobId);
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
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN,
      system: [
        {
          type: 'text',
          text: MAPPING_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [BROWSER_TOOL as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      messages: truncateOldHistory(messages, HISTORY_KEEP_RECENT) as Anthropic.Beta.Messages.BetaMessageParam[],
      betas: ['prompt-caching-2024-07-31'],
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
      model: CLAUDE_MODEL,
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
      const action = toolUse.input as BrowserAction;
      const exec = await executeBrowserAction(page, action, creds);
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
}): Promise<ActionMapSuccess | ActionMapFailure> {
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
    `\n\nWORKFLOW (do these in order, don't skip):\n` +
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
    `as unsupported and continue.\n\n` +

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

  for (let stepIdx = 0; stepIdx < MAX_AGENT_STEPS_PER_ACTION; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      return { ok: false, reason: 'token budget exceeded', finalUrl: args.page.url() };
    }
    if (Date.now() - phaseStartedAt > PHASE_WALLCLOCK_BUDGET_MS) {
      return { ok: false, reason: 'wallclock budget exceeded', finalUrl: args.page.url() };
    }
    // Per-turn budget check — see isJobOverBudget() comment.
    {
      const budget = await isJobOverBudget(args.jobId);
      if (budget.over) {
        log.warn('action mapper aborting — cumulative cost cap hit', {
          jobId: args.jobId ?? undefined, actionName: args.actionName, ...budget,
        });
        return { ok: false, reason: 'cost cap hit', finalUrl: args.page.url() };
      }
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
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN,
      system: [
        {
          type: 'text',
          text: MAPPING_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [BROWSER_TOOL as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      messages: truncateOldHistory(messages, HISTORY_KEEP_RECENT) as Anthropic.Beta.Messages.BetaMessageParam[],
      betas: ['prompt-caching-2024-07-31'],
    }, {
      ...(args.signal ? { signal: args.signal } : {}),
      headers: { 'idempotency-key': idempotencyKey },
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;

    void logClaudeUsage(response.usage ?? {}, {
      workload: 'cua_mapping_action',
      model: CLAUDE_MODEL,
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
      // This is a clean skip — the action just won't be in the recipe.
      if (parsed && parsed.unavailable === true) {
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
      const exec = await executeBrowserAction(args.page, action, args.credentials);
      if (exec.recordedStep) recordedSteps.push(exec.recordedStep);
      toolResults.push(makeToolResult(toolUse.id, exec));
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { ok: false, reason: 'mapper exhausted step budget', finalUrl: args.page.url() };
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

const STAFF_GOAL =
  `Find the STAFF / EMPLOYEES / USERS list — the page that shows who works ` +
  `at this property. Usually under "Staff", "Users", "Setup → Users", ` +
  `"Admin → Employees", or similar.\n\n` +
  `The right page is a list where each row is one staff member.\n\n` +
  `Columns we need:\n` +
  `  - Name (required)\n` +
  `  - Role / department / title (housekeeper, front desk, maintenance, etc.)\n` +
  `  - Phone number (if shown)\n` +
  `  - Email (if shown)`;
