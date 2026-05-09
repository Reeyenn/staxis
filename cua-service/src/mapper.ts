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
import { log } from './log.js';
import type { PMSCredentials, PMSType, Recipe, RecipeStep, LoginSteps, ActionRecipe } from './types.js';

const MAX_AGENT_STEPS = 60;
const VIEWPORT = { width: 1280, height: 800 };

// Token + wallclock guards. Browser-tool's read_page is the heaviest call
// — DOM trees can be 5-30K tokens each. truncateOldHistory() keeps the
// last N results so a 60-step run stays under the input cap.
const MAX_INPUT_TOKENS_PER_RUN = 400_000;
const MAX_OUTPUT_TOKENS_PER_TURN = 2048;
const PHASE_WALLCLOCK_BUDGET_MS = 5 * 60_000;
const HISTORY_KEEP_RECENT = 3;

interface MapperOptions {
  pmsType: PMSType;
  credentials: PMSCredentials;
  onProgress?: (step: string, pct: number) => void;
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
    const loginResult = await mapLogin(page, opts.credentials);
    if (!loginResult.ok) {
      return { ok: false, userMessage: loginResult.userMessage, detail: loginResult.detail };
    }

    const postLoginUrl = page.url();
    log.info('login mapped', { postLoginUrl, steps: loginResult.steps.steps.length });

    // ─── Phase 2: per-action mapping ───────────────────────────────────────
    const actions: Recipe['actions'] = {};

    opts.onProgress?.('Finding the daily housekeeping report…', 40);
    const housekeepingReport = await mapAction({
      page,
      goal: HOUSEKEEPING_GOAL,
      requiredFields: ['roomNumber', 'roomType', 'status', 'condition'],
      postLoginUrl,
      credentials: opts.credentials,
    });
    if (housekeepingReport.ok) actions.getRoomStatus = housekeepingReport.action;

    opts.onProgress?.('Finding today\'s arrivals…', 50);
    const arrivals = await mapAction({
      page,
      goal: ARRIVALS_GOAL,
      requiredFields: ['guestName', 'roomNumber', 'arrivalDate', 'departureDate'],
      postLoginUrl,
      credentials: opts.credentials,
    });
    if (arrivals.ok) actions.getArrivals = arrivals.action;

    opts.onProgress?.('Finding today\'s departures…', 55);
    const departures = await mapAction({
      page,
      goal: DEPARTURES_GOAL,
      requiredFields: ['guestName', 'roomNumber', 'arrivalDate', 'departureDate'],
      postLoginUrl,
      credentials: opts.credentials,
    });
    if (departures.ok) actions.getDepartures = departures.action;

    opts.onProgress?.('Finding the staff list…', 60);
    const staff = await mapAction({
      page,
      goal: STAFF_GOAL,
      requiredFields: ['name'],
      postLoginUrl,
      credentials: opts.credentials,
    });
    if (staff.ok) actions.getStaffRoster = staff.action;

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

async function mapLogin(page: Page, creds: PMSCredentials): Promise<LoginMapResult | LoginMapFailure> {
  await page.goto(creds.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1500);

  const recordedSteps: RecipeStep[] = [{ kind: 'goto', url: creds.loginUrl }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const goal =
    `Log into this hotel PMS using:\n` +
    `  username: "${creds.username}"\n` +
    `  password: "${creds.password}"\n\n` +

    `STEP-BY-STEP:\n` +
    `1. Call read_page with text="interactive" to see the form fields and ` +
    `their refs.\n` +
    `2. Call form_input with the username field's ref and the username value.\n` +
    `3. Call form_input with the password field's ref and the password value.\n` +
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

  for (let stepIdx = 0; stepIdx < MAX_AGENT_STEPS; stepIdx++) {
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

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN,
      system: MAPPING_SYSTEM_PROMPT,
      tools: [BROWSER_TOOL as unknown as Anthropic.Messages.Tool],
      messages: truncateOldHistory(messages, HISTORY_KEEP_RECENT),
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const finalText = extractFinalText(response.content);
      const parsed = tryParseJson(finalText) as { loggedIn?: unknown; dashboardSelector?: unknown; error?: unknown } | null;
      if (parsed && parsed.loggedIn) {
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
      return {
        ok: false,
        userMessage: 'Could not log in. Please double-check your username and password.',
        detail: { phase: 'login_mapping', finalText, parsed },
      };
    }

    const toolUse = response.content.find((c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use');
    if (!toolUse) break;

    const action = toolUse.input as BrowserAction;
    const exec = await executeBrowserAction(page, action, creds);
    if (exec.recordedStep) recordedSteps.push(exec.recordedStep);

    messages.push({
      role: 'user',
      content: [makeToolResult(toolUse.id, exec)],
    });
  }

  return {
    ok: false,
    userMessage: 'Took too long to figure out the login form. Please contact support.',
    detail: { phase: 'login_mapping', maxSteps: MAX_AGENT_STEPS },
  };
}

// ─── Per-action mapping ───────────────────────────────────────────────────

interface ActionMapSuccess { ok: true;  action: ActionRecipe }
interface ActionMapFailure { ok: false; reason: string }

async function mapAction(args: {
  page: Page;
  goal: string;
  requiredFields: string[];
  postLoginUrl: string;
  credentials: PMSCredentials;
}): Promise<ActionMapSuccess | ActionMapFailure> {
  if (args.page.url() !== args.postLoginUrl) {
    await args.page.goto(args.postLoginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await args.page.waitForTimeout(1000);
  }

  const recordedSteps: RecipeStep[] = [{ kind: 'goto', url: args.postLoginUrl }];
  let totalInputTokens = 0;

  const fullGoal =
    args.goal +
    `\n\nWORKFLOW:\n` +
    `1. Call read_page with text="interactive" to see the menu.\n` +
    `2. Click the menu item that most likely leads to the target page.\n` +
    `3. read_page again. If you see the target page (a list/table with the ` +
    `expected columns), proceed to step 4. Otherwise, navigate further.\n` +
    `4. Once on the target page, identify the row selector and column ` +
    `selectors (relative to one row).\n\n` +

    `WHEN DONE, reply with JSON ONLY:\n` +
    `  {"url": "<final URL>", "rowSelector": "<CSS selector matching one row>", ` +
    `"columns": {<our field name>: "<selector relative to row>"}}\n\n` +

    `Required fields for this page: ${args.requiredFields.join(', ')}\n` +
    `Use empty string for fields not visible on the page.`;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: fullGoal }] },
  ];

  const phaseStartedAt = Date.now();

  for (let stepIdx = 0; stepIdx < MAX_AGENT_STEPS; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      return { ok: false, reason: 'token budget exceeded' };
    }
    if (Date.now() - phaseStartedAt > PHASE_WALLCLOCK_BUDGET_MS) {
      return { ok: false, reason: 'wallclock budget exceeded' };
    }

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS_PER_TURN,
      system: MAPPING_SYSTEM_PROMPT,
      tools: [BROWSER_TOOL as unknown as Anthropic.Messages.Tool],
      messages: truncateOldHistory(messages, HISTORY_KEEP_RECENT),
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const finalText = extractFinalText(response.content);
      const parsed = tryParseJson(finalText);
      if (parsed && typeof parsed === 'object' && 'rowSelector' in parsed && 'columns' in parsed) {
        const p = parsed as { url?: string; rowSelector: string; columns: Record<string, string> };
        return {
          ok: true,
          action: {
            steps: recordedSteps,
            parse: { mode: 'table', hint: { rowSelector: p.rowSelector, columns: p.columns } },
          },
        };
      }
      return { ok: false, reason: 'mapper returned no usable JSON' };
    }

    const toolUse = response.content.find((c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use');
    if (!toolUse) break;

    const action = toolUse.input as BrowserAction;
    const exec = await executeBrowserAction(args.page, action, args.credentials);
    if (exec.recordedStep) recordedSteps.push(exec.recordedStep);

    messages.push({
      role: 'user',
      content: [makeToolResult(toolUse.id, exec)],
    });
  }

  return { ok: false, reason: 'mapper exhausted step budget' };
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
  content.push({ type: 'text', text: exec.output });
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
 * Walk the message history and elide older heavy content — both screenshots
 * (image blocks inside tool_result) and large read_page text blocks. Keeps
 * the most recent `keepLast` instances of each in full; older ones become
 * a tiny placeholder.
 *
 * Without this, a 30-step mapping run quadratically blows up because every
 * turn re-sends ALL prior screenshots + DOM trees.
 */
function truncateOldHistory(
  messages: Anthropic.Messages.MessageParam[],
  keepLast: number,
): Anthropic.Messages.MessageParam[] {
  let imagesSeen = 0;
  let bigTextSeen = 0;
  const BIG_TEXT_THRESHOLD = 1500;

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
          }
          if (b.type === 'text' && b.text.length > BIG_TEXT_THRESHOLD) {
            bigTextSeen++;
            if (bigTextSeen > keepLast) {
              return { type: 'text' as const, text: `[older read_page output elided — was ${b.text.length} chars]` };
            }
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

function tryParseJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
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
