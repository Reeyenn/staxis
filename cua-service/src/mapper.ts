/**
 * PMS mapper — uses Claude's computer-use tool to learn how to navigate
 * a PMS, then emits a Recipe (see types.ts) that the cheap recipe-runner
 * can replay forever after.
 *
 * This is the only place we burn Claude tokens at scale. Per the
 * architecture: one mapping run per (pms_type) ≈ $1-2 of API spend.
 * After that, every property using that PMS gets the recipe for free.
 *
 * Implementation:
 *   - Launch Playwright Chromium, navigate to the PMS login URL.
 *   - Hand Claude a screenshot + the goal. Claude returns either text or
 *     a `computer` tool_use block (click, type, screenshot, etc.).
 *   - Execute the action against Playwright, screenshot, send back as
 *     tool_result. Loop until Claude says it's done or we hit the cap.
 *
 * v0 scope (today): the mapper produces a recipe that contains a working
 * login flow and a navigation hint for the arrivals page. Each action
 * (getArrivals, getDepartures, etc.) is mapped as a separate Claude
 * conversation seeded with the post-login state. We start with arrivals
 * and getStaffRoster — those are the highest-value for the onboarding
 * dashboard. Other actions are TODO and fall back to 'unsupported' in
 * the recipe-runner.
 */

import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { anthropic, CLAUDE_MODEL, COMPUTER_TOOL, COMPUTER_USE_BETA, MAPPING_SYSTEM_PROMPT } from './anthropic-client.js';
import { log } from './log.js';
import type { PMSCredentials, PMSType, Recipe, RecipeStep, LoginSteps, ActionRecipe } from './types.js';

// 100 steps. Opus is more deliberate than Sonnet — it takes more
// per-step thinking but reaches the goal more reliably. This covers
// even pathological PMS UIs while the token + wallclock budgets are
// the real safety stops if the agent gets stuck.
const MAX_AGENT_STEPS = 100;
const VIEWPORT = { width: COMPUTER_TOOL.display_width_px, height: COMPUTER_TOOL.display_height_px };

// Token budget per mapping run. Without screenshot-history truncation
// each turn was re-sending ALL prior screenshots — quadratic blowup —
// and we'd hit 120K well before logging in to a complex PMS.
// truncateOldScreenshots() (below) keeps only the most recent N
// screenshots in the message history, which makes per-turn context
// stable instead of growing. With that, a 30-step run is comfortably
// under 200K. We cap at 400K as a safety stop for runaway loops
// (CAPTCHAs, model confusion). ~400K input tokens ≈ $1.20 on Sonnet 4.5.
const MAX_INPUT_TOKENS_PER_RUN = 400_000;
const MAX_OUTPUT_TOKENS_PER_RUN = 4_000;

// Wall-clock cap. Even with the token budget healthy, a stuck agent
// that's slow-rolling an Anthropic call shouldn't tie up a worker
// indefinitely. 5 minutes is generous for a real PMS exploration;
// past that the run is failing and we should give up.
const MAPPING_WALLCLOCK_BUDGET_MS = 5 * 60_000;

// How many recent screenshots to keep in the message history. Older
// screenshots get replaced with a small text marker. 3 is the
// sweet spot we tuned for Choice Advantage: enough visual memory
// for "the click I just made changed THIS region" reasoning, but
// few enough that 60-step runs stay under the token cap.
const SCREENSHOT_HISTORY_KEEP = 3;

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

    // After login, save the page state so subsequent action-mapping
    // sub-runs start from "logged in dashboard" instead of re-doing login.
    const postLoginUrl = page.url();
    log.info('login mapped', { postLoginUrl, steps: loginResult.steps.steps.length });

    // ─── Phase 2: map per-action navigation ───────────────────────────────
    // The goals below are intentionally specific about WHAT KIND OF REPORT
    // we need, not abstract "rooms list". This matches how PMS UIs are
    // actually structured: data lives under "Reports" / "Front Desk"
    // menus, named by what they show ("Housekeeping Check-off List",
    // "Daily Arrivals Report", etc.) — not in a top-level "Rooms" tab.
    //
    // Each goal also tells Claude the COLUMNS we need extracted, so it
    // can verify it's on the right page (not just the first list it sees)
    // and emit the column→selector mapping for the recipe-runner.
    const actions: Recipe['actions'] = {};

    opts.onProgress?.('Finding the daily housekeeping report…', 40);
    const housekeepingReport = await mapAction({
      page,
      goal:
        `Find the DAILY HOUSEKEEPING report — sometimes called "Housekeeping ` +
        `Check-off List", "Room Status Report", "Housekeeping Report", or ` +
        `"Daily Maid Sheet". This is a per-room snapshot showing every ` +
        `occupied + vacant room in the property and its current status.\n\n` +
        `It usually lives under "Reports", "Front Desk → Reports", or ` +
        `"Housekeeping" in the top-level menu. You may need to set filters ` +
        `(date = today, all rooms, all statuses) before the report renders.\n\n` +
        `The right page will show a table with one row per room. Look for ` +
        `these columns (names vary by PMS — match what's closest):\n` +
        `  - Room number (required)\n` +
        `  - Room type / category\n` +
        `  - Status (Occupied / Vacant)\n` +
        `  - Condition (Clean / Dirty / Inspected / Out of Order)\n` +
        `  - Stay/CO indicator (Stayover or Checkout)\n` +
        `  - Arrival date (for current/incoming guest)\n` +
        `  - Departure date\n` +
        `  - Assigned housekeeper (if shown)\n\n` +
        `If a CSV export option is present (button labeled "Export", "CSV", ` +
        `"Download"), include it in the recipe steps — CSV is more reliable ` +
        `than HTML scraping. Otherwise, capture the HTML row selector.`,
      postLoginUrl,
      credentials: opts.credentials,
    });
    if (housekeepingReport.ok) actions.getRoomStatus = housekeepingReport.action;

    opts.onProgress?.('Finding today\'s arrivals…', 50);
    const arrivals = await mapAction({
      page,
      goal:
        `Find today's ARRIVALS list — sometimes called "Arrivals", "Today's ` +
        `Arrivals", "Check-Ins", or "Expected Arrivals". This shows ` +
        `reservations whose arrival date is today.\n\n` +
        `Usually under "Front Desk", "Reservations", or "View" menu. ` +
        `The right page is a list/table where each row is one reservation.\n\n` +
        `Columns we need:\n` +
        `  - Guest name\n` +
        `  - Room number\n` +
        `  - Arrival date\n` +
        `  - Departure date\n` +
        `  - Number of nights\n` +
        `  - Number of adults / children\n` +
        `  - Confirmation number (if shown)`,
      postLoginUrl,
      credentials: opts.credentials,
    });
    if (arrivals.ok) actions.getArrivals = arrivals.action;

    opts.onProgress?.('Finding today\'s departures…', 55);
    const departures = await mapAction({
      page,
      goal:
        `Find today's DEPARTURES list — sometimes called "Departures", ` +
        `"Check-Outs", or "Today's Departures". Shows reservations whose ` +
        `departure date is today.\n\n` +
        `Usually right next to Arrivals in the menu.\n\n` +
        `Columns we need:\n` +
        `  - Guest name\n` +
        `  - Room number\n` +
        `  - Arrival date\n` +
        `  - Departure date\n` +
        `  - Confirmation number (if shown)\n` +
        `  - Checked-out flag (if shown)`,
      postLoginUrl,
      credentials: opts.credentials,
    });
    if (departures.ok) actions.getDepartures = departures.action;

    opts.onProgress?.('Finding the staff list…', 60);
    const staff = await mapAction({
      page,
      goal:
        `Find the STAFF / EMPLOYEES / USERS list — the page that shows ` +
        `who works at this property. Usually under "Staff", "Users", ` +
        `"Setup → Users", "Admin → Employees", or similar.\n\n` +
        `The right page is a list where each row is one staff member.\n\n` +
        `Columns we need:\n` +
        `  - Name (required)\n` +
        `  - Role / department / title (housekeeper, front desk, maintenance, etc.)\n` +
        `  - Phone number (if shown)\n` +
        `  - Email (if shown)`,
      postLoginUrl,
      credentials: opts.credentials,
    });
    if (staff.ok) actions.getStaffRoster = staff.action;

    // TODO: arrivals, departures, roomStatus, dashboardCounts, history.
    // These follow the same pattern but need PMS-specific parsing logic
    // that's worth iterating on with a real PMS in front of us.

    if (Object.keys(actions).length === 0) {
      return {
        ok: false,
        userMessage: 'We could log in but could not find any of the data pages. This usually means the PMS UI changed or your account is missing permissions.',
        detail: { phase: 'mapping_actions', mapped: [] },
      };
    }

    const recipe: Recipe = {
      schema: 1,
      description: `Auto-mapped recipe for ${opts.pmsType}. Actions: ${Object.keys(actions).join(', ')}.`,
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

  const recordedSteps: RecipeStep[] = [{ kind: 'goto', url: creds.loginUrl }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Conversation with Claude. We keep the entire history (screenshots
  // included) so Claude can reason about the sequence. Token cost grows
  // with steps — that's fine for a one-time mapping run, but we cap it
  // at MAX_INPUT_TOKENS_PER_RUN to prevent runaway spend.
  const goal =
    `Log into this hotel PMS using:\n` +
    `  username: "${creds.username}"\n` +
    `  password: "${creds.password}"\n\n` +

    `LOGIN FLOW PATTERNS to expect (most PMSes follow one of these):\n` +
    `  • Single-page: form on landing → enter creds → submit → dashboard\n` +
    `  • Two-step: enter username → click "Next" → enter password → submit → dashboard\n` +
    `  • Property picker: after creds, you land on a "Select Property" page ` +
    `with a list of hotels. Click the FIRST one (any will do for mapping). ` +
    `Some PMSes call this "Site", "Hotel", or "Location".\n` +
    `  • Choice Advantage specifically: lands on a "Welcome" splash page ` +
    `after login. Click "Continue", "Enter PMS", or the property name to ` +
    `reach the actual dashboard.\n\n` +

    `EFFICIENCY:\n` +
    `  • You should reach the dashboard in 5-10 actions for a normal PMS, ` +
    `up to 15 for one with a property picker. If you've taken 20+ actions ` +
    `and still aren't at the dashboard, you're stuck — emit ` +
    `{"error": "<what went wrong>"} so we can debug.\n` +
    `  • DO NOT re-enter the password if you see a "wrong credentials" ` +
    `or "session expired" message. Emit {"error": "..."} immediately.\n\n` +

    `WHEN YOU'RE LOGGED IN (you see a dashboard with hotel-specific data — ` +
    `room counts, today's date, guest names, navigation menu with reports/ ` +
    `front-desk/etc.), reply with JSON ONLY (no commentary):\n` +
    `  {"loggedIn": true, "dashboardSelector": "<a CSS selector that's only ` +
    `present after login, like '.dashboard' or '#mainNav' or 'a[href*=\\"reports\\"]'>"} \n` +
    `Then stop — don't click anything else.\n\n` +

    `If login fails permanently (wrong creds, account locked, PMS down), ` +
    `reply with {"error": "<short reason>"} and stop.`;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [
      { type: 'text', text: goal },
      await screenshotBlock(page),
    ]},
  ];

  const phaseStartedAt = Date.now();

  for (let stepIdx = 0; stepIdx < MAX_AGENT_STEPS; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      log.warn('mapper exceeded input token budget — bailing', {
        totalInputTokens, totalOutputTokens, stepIdx,
      });
      return {
        ok: false,
        userMessage: 'Mapping took longer than expected — please contact support so we can investigate.',
        detail: { phase: 'login_mapping', reason: 'token_budget_exceeded', totalInputTokens },
      };
    }
    if (Date.now() - phaseStartedAt > MAPPING_WALLCLOCK_BUDGET_MS) {
      log.warn('mapper exceeded wall-clock budget — bailing', {
        elapsedMs: Date.now() - phaseStartedAt, stepIdx,
      });
      return {
        ok: false,
        userMessage: 'Mapping took longer than expected — please contact support so we can investigate.',
        detail: { phase: 'login_mapping', reason: 'wallclock_budget_exceeded', elapsedMs: Date.now() - phaseStartedAt },
      };
    }

    const response = await anthropic.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: MAPPING_SYSTEM_PROMPT,
      // Computer-use is beta-gated on the Messages API. We pass the beta
      // header via `betas`. Cast through unknown because the SDK's
      // BetaToolUnion type narrows differently between SDK minor versions.
      tools: [COMPUTER_TOOL as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      // Truncate old screenshots before sending — keeps per-turn context
      // small enough that long mapping runs don't quadratically blow up.
      messages: truncateOldScreenshots(messages, SCREENSHOT_HISTORY_KEEP),
      betas: [COMPUTER_USE_BETA],
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;

    messages.push({ role: 'assistant', content: response.content as unknown as Anthropic.Messages.ContentBlock[] });

    // Check for end-of-turn (Claude is done).
    if (response.stop_reason === 'end_turn') {
      const finalText = extractFinalText(response.content as unknown as Anthropic.Messages.ContentBlock[]);
      const parsedRaw = tryParseJson(finalText);
      const parsed = parsedRaw as { loggedIn?: unknown; dashboardSelector?: unknown } | null;
      if (parsed && parsed.loggedIn) {
        const successSelector = typeof parsed.dashboardSelector === 'string'
          ? parsed.dashboardSelector
          : 'body';
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

    // Otherwise expect a tool_use block.
    const toolUse = response.content.find((c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use');
    if (!toolUse) break;

    const action = toolUse.input as ComputerAction;
    const exec = await executeComputerAction(page, action, creds);
    if (exec.recordedStep) recordedSteps.push(exec.recordedStep);

    // Reply with tool_result + new screenshot.
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: [
          await screenshotBlock(page),
          { type: 'text', text: exec.message },
        ],
      }],
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
  postLoginUrl: string;
  credentials: PMSCredentials;
}): Promise<ActionMapSuccess | ActionMapFailure> {
  // Navigate back to the post-login dashboard before starting this
  // action's mapping — gives every action a clean starting state.
  if (args.page.url() !== args.postLoginUrl) {
    await args.page.goto(args.postLoginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  }

  const recordedSteps: RecipeStep[] = [{ kind: 'goto', url: args.postLoginUrl }];
  let totalInputTokens = 0;

  const fullGoal =
    args.goal +
    `\n\nWhen you reach the page, reply with the JSON ` +
    `{"url": "<final URL>", "rowSelector": "<CSS selector matching one row in the list>", ` +
    `"columns": {<our field name>: "<selector relative to row>"}}` +
    `\nFields we need depend on the page — for rooms: roomNumber, floor, type. ` +
    `For staff: name, role, phone. Use empty selectors for fields not visible.`;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: [
      { type: 'text', text: fullGoal },
      await screenshotBlock(args.page),
    ]},
  ];

  const phaseStartedAt = Date.now();

  for (let stepIdx = 0; stepIdx < MAX_AGENT_STEPS; stepIdx++) {
    if (totalInputTokens > MAX_INPUT_TOKENS_PER_RUN) {
      log.warn('action mapper exceeded token budget — bailing', { totalInputTokens, stepIdx });
      return { ok: false, reason: 'token budget exceeded' };
    }
    if (Date.now() - phaseStartedAt > MAPPING_WALLCLOCK_BUDGET_MS) {
      log.warn('action mapper exceeded wall-clock budget — bailing', { elapsedMs: Date.now() - phaseStartedAt, stepIdx });
      return { ok: false, reason: 'wallclock budget exceeded' };
    }

    const response = await anthropic.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: MAPPING_SYSTEM_PROMPT,
      tools: [COMPUTER_TOOL as unknown as Anthropic.Beta.Messages.BetaToolUnion],
      // Truncate old screenshots — same fix as in mapLogin.
      messages: truncateOldScreenshots(messages, SCREENSHOT_HISTORY_KEEP),
      betas: [COMPUTER_USE_BETA],
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;

    messages.push({ role: 'assistant', content: response.content as unknown as Anthropic.Messages.ContentBlock[] });

    if (response.stop_reason === 'end_turn') {
      const finalText = extractFinalText(response.content as unknown as Anthropic.Messages.ContentBlock[]);
      const parsed = tryParseJson(finalText);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'rowSelector' in parsed &&
        'columns' in parsed
      ) {
        const p = parsed as { url?: string; rowSelector: string; columns: Record<string, string> };
        return {
          ok: true,
          action: {
            steps: recordedSteps,
            parse: {
              mode: 'table',
              hint: {
                rowSelector: p.rowSelector,
                columns: p.columns,
              },
            },
          },
        };
      }
      return { ok: false, reason: 'mapper returned no usable JSON' };
    }

    const toolUse = response.content.find((c): c is Anthropic.Messages.ToolUseBlock => c.type === 'tool_use');
    if (!toolUse) break;

    const action = toolUse.input as ComputerAction;
    const exec = await executeComputerAction(args.page, action, args.credentials);
    if (exec.recordedStep) recordedSteps.push(exec.recordedStep);

    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: [
          await screenshotBlock(args.page),
          { type: 'text', text: exec.message },
        ],
      }],
    });
  }

  return { ok: false, reason: 'mapper exhausted step budget' };
}

// ─── Computer-action executor (the bridge between Claude and Playwright) ──

type ComputerAction =
  | { action: 'screenshot' }
  | { action: 'left_click';  coordinate: [number, number] }
  | { action: 'type';        text: string }
  | { action: 'key';         text: string }
  | { action: 'mouse_move';  coordinate: [number, number] }
  | { action: 'scroll';      coordinate: [number, number]; scroll_direction: 'up' | 'down'; scroll_amount: number }
  | { action: 'wait';        duration: number };

async function executeComputerAction(
  page: Page,
  action: ComputerAction,
  creds: PMSCredentials,
): Promise<{ message: string; recordedStep?: RecipeStep }> {
  switch (action.action) {
    case 'screenshot':
      return { message: 'screenshot taken' };

    case 'left_click': {
      const [x, y] = action.coordinate;
      await page.mouse.click(x, y);
      // Record the actual click coordinates so the recipe-runner can
      // replay them. Without this, the recipe was a no-op and login
      // never worked. (Severity-CRITICAL fix from 2026-05-07 review.)
      return {
        message: `clicked (${x}, ${y})`,
        recordedStep: { kind: 'click_at', x, y },
      };
    }

    case 'type': {
      // If the typed text matches a credential, store as placeholder
      // ($username / $password) so we don't leak creds into the recipe
      // — the runner substitutes the real values at execution time.
      let recordedValue: '$username' | '$password' | string = action.text;
      if (action.text === creds.username) recordedValue = '$username';
      if (action.text === creds.password) recordedValue = '$password';

      await page.keyboard.type(action.text);
      return {
        message: `typed ${action.text === creds.password ? '<password>' : action.text}`,
        recordedStep: { kind: 'type_text', value: recordedValue },
      };
    }

    case 'key': {
      // Claude's computer-use tool emits keys like "ctrl", "alt", "shift",
      // "ctrl+a", "Return", etc. Playwright's keyboard.press() accepts
      // a different set: single keys (Enter, Tab, Escape) or chords
      // joined with "+" using PascalCase modifier names (Control+A).
      // Normalize before pressing; if the key still isn't accepted,
      // catch the error and report it back to the agent as text so the
      // mapping run continues instead of crashing.
      const normalized = normalizeKey(action.text);
      try {
        await page.keyboard.press(normalized);
        return { message: `pressed ${normalized}`, recordedStep: { kind: 'press_key', key: normalized } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('key press unsupported by Playwright — surfacing to agent', {
          requested: action.text, normalized, err: msg,
        });
        return { message: `key "${action.text}" was not accepted by the browser (${msg}). Try a different key or a click instead.` };
      }
    }

    case 'mouse_move':
      await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      return { message: 'mouse moved' };

    case 'scroll': {
      await page.mouse.wheel(0, action.scroll_direction === 'down' ? action.scroll_amount * 100 : -action.scroll_amount * 100);
      return { message: `scrolled ${action.scroll_direction}` };
    }

    case 'wait':
      await new Promise((r) => setTimeout(r, action.duration * 1000));
      return { message: `waited ${action.duration}s` };

    default: {
      const a = action as { action: string };
      return { message: `unsupported action: ${a.action}` };
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function screenshotBlock(page: Page): Promise<Anthropic.Messages.ImageBlockParam> {
  const buf = await page.screenshot({ fullPage: false });
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: buf.toString('base64'),
    },
  };
}

function extractFinalText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Normalize a key string from Claude's computer-use tool format into
 * Playwright's keyboard.press() format.
 *
 * Claude emits:  "ctrl", "alt", "shift", "ctrl+a", "Return", "tab", ...
 * Playwright wants: "Control", "Alt", "Shift", "Control+A", "Enter",
 *                   "Tab" — PascalCase, modifiers spelled out, "+" join.
 *
 * If a single bare modifier ("ctrl") arrives — which Playwright's
 * press() rejects — we map it to its PascalCase form. The downstream
 * try/catch handles any keys we miss here by returning the error to
 * the agent as text instead of crashing the run.
 */
function normalizeKey(raw: string): string {
  const modifierMap: Record<string, string> = {
    ctrl:    'Control',
    control: 'Control',
    alt:     'Alt',
    shift:   'Shift',
    cmd:     'Meta',
    command: 'Meta',
    win:     'Meta',
    windows: 'Meta',
    meta:    'Meta',
    super:   'Meta',
    return:  'Enter',
    enter:   'Enter',
    esc:     'Escape',
    escape:  'Escape',
    tab:     'Tab',
    space:   'Space',
    backspace: 'Backspace',
    delete:  'Delete',
    up:      'ArrowUp',
    down:    'ArrowDown',
    left:    'ArrowLeft',
    right:   'ArrowRight',
  };
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  const mapped = parts.map((p) => {
    const lower = p.toLowerCase();
    if (modifierMap[lower]) return modifierMap[lower];
    // Single character: uppercase it (Playwright wants "A" not "a" for chords).
    if (p.length === 1) return p.toUpperCase();
    // Multi-char unknown — capitalize first letter as a best guess.
    return p.charAt(0).toUpperCase() + p.slice(1);
  });
  return mapped.join('+');
}

/**
 * Walk the message history and replace all but the most-recent `keepLast`
 * screenshots with a short text marker. This is the fix for the quadratic
 * context blowup that was making 10+ -step mapping runs hit the input
 * token cap before reaching the dashboard. The agent only needs the
 * CURRENT screenshot to decide its next action; older ones are clutter
 * after the agent has already reacted to them. Text in tool_result
 * blocks preserves the "what I did" trail.
 *
 * Returns a NEW array — does not mutate the input.
 */
function truncateOldScreenshots(
  messages: Anthropic.Messages.MessageParam[],
  keepLast: number,
): Anthropic.Messages.MessageParam[] {
  // Walk newest-first, count screenshots, keep first `keepLast`.
  let screenshotsSeen = 0;
  const reversed = [...messages].reverse().map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const newContent = msg.content.map((block) => {
      // Top-level image (the initial user message form).
      if (block.type === 'image') {
        screenshotsSeen++;
        if (screenshotsSeen > keepLast) {
          return { type: 'text' as const, text: '[Older screenshot elided to save tokens]' };
        }
        return block;
      }
      // Image inside a tool_result (the per-turn form).
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const innerContent = block.content.map((b) => {
          if (b.type === 'image') {
            screenshotsSeen++;
            if (screenshotsSeen > keepLast) {
              return { type: 'text' as const, text: '[Older screenshot elided to save tokens]' };
            }
          }
          return b;
        });
        return { ...block, content: innerContent };
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
  return reversed.reverse();
}

function tryParseJson(text: string): unknown {
  // Strip markdown code fences if present — Claude often wraps JSON in ```json ... ```
  const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Find the first {…} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// ─── Type imports (deferred to avoid circular issues) ─────────────────────

import type Anthropic from '@anthropic-ai/sdk';
