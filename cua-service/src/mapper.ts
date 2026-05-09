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

const MAX_AGENT_STEPS = 30;
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
// screenshots get replaced with a small text marker — the agent only
// needs the CURRENT view to decide its next action; prior screenshots
// are mostly clutter once the agent has reacted to them. The action
// log (text in tool_result blocks) preserves "where did I come from".
const SCREENSHOT_HISTORY_KEEP = 2;

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
    // For v0 we map two: getRoomLayout (rooms list) and getStaffRoster.
    // Arrivals/departures/room-status fall back to the same mapping flow
    // in the next iteration — TODO. The recipe-runner will return
    // 'unsupported' for any action whose recipe is missing.
    const actions: Recipe['actions'] = {};

    opts.onProgress?.('Finding the rooms list…', 40);
    const rooms = await mapAction({
      page,
      goal: 'Navigate to the rooms list / room registry — the page that shows every room in the property and its number, type, and floor.',
      postLoginUrl,
      credentials: opts.credentials,
    });
    if (rooms.ok) actions.getRoomLayout = rooms.action;

    opts.onProgress?.('Finding the staff roster…', 55);
    const staff = await mapAction({
      page,
      goal: 'Navigate to the staff / employees / users list — the page that shows housekeeping staff names and contact info.',
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
    `Log into this hotel PMS using these credentials: ` +
    `username "${creds.username}", password "${creds.password}". ` +
    `Once logged in (you see a dashboard with hotel data), reply with ` +
    `the JSON {"loggedIn": true, "dashboardSelector": "<a CSS selector ` +
    `that's only present after login>"} and stop. Don't click anything ` +
    `else after that. If login fails, reply with {"error": "<reason>"}.`;

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
      max_tokens: 1024,
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
      max_tokens: 1024,
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

    case 'key':
      await page.keyboard.press(action.text);
      return { message: `pressed ${action.text}`, recordedStep: { kind: 'press_key', key: action.text } };

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
