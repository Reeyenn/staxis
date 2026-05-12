/**
 * Recipe runner — replays a saved Recipe via Playwright (no Claude calls).
 *
 * This is the cheap, fast path: every recipe step is a deterministic
 * browser action, no vision model in the loop. A full extraction
 * (rooms + staff + 90-day history + arrivals + departures) takes
 * roughly 60-90 seconds per property and costs nothing in API tokens.
 *
 * If a recipe step fails (selector missing, timeout, login rejection),
 * we return a structured error. The job-runner converts that into the
 * onboarding_jobs.error field shown to the GM. Recipes that fail
 * repeatedly trigger a re-mapping run.
 */

import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { log } from './log.js';
import type {
  ActionRecipe,
  PMSArrival,
  PMSCredentials,
  PMSDeparture,
  PMSRoomDescriptor,
  PMSRoomStatus,
  PMSStaffMember,
  Recipe,
  RecipeStep,
} from './types.js';

interface RunOptions {
  recipe: Recipe;
  credentials: PMSCredentials;
  /** ISO date for date-aware actions; default today in property's TZ. */
  date?: string;
  /** Look-back window for getHistoricalOccupancy. */
  historyDays?: number;
  onProgress?: (step: string, pct: number) => void;
}

export interface ExtractedData {
  rooms: PMSRoomDescriptor[];
  staff: PMSStaffMember[];
  arrivalsToday: PMSArrival[];
  departuresToday: PMSDeparture[];
  roomStatus: PMSRoomStatus[];
  history: Array<{ date: string; occupied: number; totalRooms: number }>;
}

export type ExtractionResult =
  | { ok: true;  data: ExtractedData }
  | { ok: false; userMessage: string; detail: Record<string, unknown> };

const VIEWPORT = { width: 1280, height: 800 };

/**
 * Thrown by runActionAsTable when (a) a recipe step throws (selector
 * missing, navigation timeout, parser error) or (b) a required action
 * returns zero rows (recipe stale — selector matches nothing). The
 * job-runner converts these into onboarding_jobs.error so the GM sees
 * "we hit a snag pulling X" instead of silently empty data.
 *
 * Codex audit pass-6 P0 — runActionAsTable used to swallow both cases
 * and return []. The hotel manager would open the app, see zero
 * arrivals, and have no idea our system silently failed.
 */
class RecipeActionFailedError extends Error {
  constructor(
    public readonly actionName: string,
    public readonly reason: string,
    public readonly underlying?: string,
  ) {
    super(`Action "${actionName}" failed: ${reason}`);
    this.name = 'RecipeActionFailedError';
  }
}

/**
 * Required actions MUST return at least one row — a hotel always has
 * rooms, staff, and a non-empty room-status snapshot. Optional actions
 * may legitimately return zero rows (e.g. arrivals on a slow Sunday)
 * and we don't fail the job for those.
 */
const REQUIRED_ACTIONS: ReadonlySet<string> = new Set([
  'getRoomLayout',
  'getStaffRoster',
  'getRoomStatus',
  'getHistoricalOccupancy',
]);

export async function runRecipeExtraction(opts: RunOptions): Promise<ExtractionResult> {
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      // Keep cookies/storage alive across recipe steps within one run.
      acceptDownloads: true,
    });
    const page = await context.newPage();

    // ─── Login ────────────────────────────────────────────────────────────
    opts.onProgress?.('Logging into your PMS…', 65);
    const loginOk = await runLogin(page, opts.recipe.login, opts.credentials);
    if (!loginOk.ok) {
      return {
        ok: false,
        userMessage: 'Could not log into your PMS — please verify your username/password.',
        detail: { phase: 'login', ...loginOk.detail },
      };
    }

    // ─── Run each supported action ────────────────────────────────────────
    const data: ExtractedData = {
      rooms: [],
      staff: [],
      arrivalsToday: [],
      departuresToday: [],
      roomStatus: [],
      history: [],
    };

    if (opts.recipe.actions.getRoomLayout) {
      opts.onProgress?.('Pulling room list…', 72);
      data.rooms = await runActionAsTable<PMSRoomDescriptor>(
        page, 'getRoomLayout', opts.recipe.actions.getRoomLayout, opts.credentials,
      );
    }
    if (opts.recipe.actions.getStaffRoster) {
      opts.onProgress?.('Pulling staff roster…', 78);
      data.staff = await runActionAsTable<PMSStaffMember>(
        page, 'getStaffRoster', opts.recipe.actions.getStaffRoster, opts.credentials,
      );
    }
    if (opts.recipe.actions.getArrivals) {
      opts.onProgress?.('Pulling today\'s arrivals…', 82);
      data.arrivalsToday = await runActionAsTable<PMSArrival>(
        page, 'getArrivals', opts.recipe.actions.getArrivals, opts.credentials,
      );
    }
    if (opts.recipe.actions.getDepartures) {
      opts.onProgress?.('Pulling today\'s departures…', 85);
      data.departuresToday = await runActionAsTable<PMSDeparture>(
        page, 'getDepartures', opts.recipe.actions.getDepartures, opts.credentials,
      );
    }
    if (opts.recipe.actions.getRoomStatus) {
      opts.onProgress?.('Pulling room status…', 88);
      data.roomStatus = await runActionAsTable<PMSRoomStatus>(
        page, 'getRoomStatus', opts.recipe.actions.getRoomStatus, opts.credentials,
      );
    }
    if (opts.recipe.actions.getHistoricalOccupancy) {
      opts.onProgress?.('Pulling 90 days of history…', 89);
      // History rows: { date, occupied, totalRooms }
      type HistoryRow = { date: string; occupied: number; totalRooms: number };
      data.history = await runActionAsTable<HistoryRow>(
        page, 'getHistoricalOccupancy', opts.recipe.actions.getHistoricalOccupancy, opts.credentials,
      );
    }

    return { ok: true, data };
  } catch (err) {
    // Codex audit pass-6 P0 — distinguish a structured action failure
    // (recipe broke on action X, returned zero rows or threw) from a
    // generic runner crash. The structured case names the specific
    // action so the GM-facing message can say "we couldn't pull
    // arrivals" instead of "something went wrong."
    if (err instanceof RecipeActionFailedError) {
      log.error('recipe action failed', {
        actionName: err.actionName,
        reason: err.reason,
        underlying: err.underlying,
      });
      return {
        ok: false,
        userMessage:
          `We couldn't pull ${humanizeAction(err.actionName)} from your PMS — ` +
          `the page layout may have changed. We'll re-map and try again.`,
        detail: {
          phase: 'recipe_runner',
          action: err.actionName,
          reason: err.reason,
          underlying: err.underlying,
        },
      };
    }
    const e = err as Error;
    log.error('recipe-runner crashed', { err: e.message });
    return {
      ok: false,
      userMessage: 'We hit an unexpected error while pulling data. Please try again.',
      detail: { phase: 'recipe_runner', message: e.message },
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function humanizeAction(actionName: string): string {
  switch (actionName) {
    case 'getRoomLayout':         return 'the room list';
    case 'getStaffRoster':        return 'the staff roster';
    case 'getArrivals':           return "today's arrivals";
    case 'getDepartures':         return "today's departures";
    case 'getRoomStatus':         return 'room status';
    case 'getHistoricalOccupancy':return 'occupancy history';
    default:                      return actionName;
  }
}

// ─── Step execution ───────────────────────────────────────────────────────

async function runStep(page: Page, step: RecipeStep, creds: PMSCredentials): Promise<void> {
  switch (step.kind) {
    case 'goto':
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
    case 'fill': {
      const value = step.value === '$username' ? creds.username
                  : step.value === '$password' ? creds.password
                  : step.value;
      await page.fill(step.selector, value, { timeout: 10_000 });
      return;
    }
    case 'click':
      await page.click(step.selector, { timeout: 10_000 });
      return;
    case 'click_at':
      // Coordinate-based replay — the mapper recorded a click at (x, y)
      // because Claude clicked at pixel coordinates rather than a CSS
      // selector. Brittle to UI resizes but adequate for v0.
      await page.mouse.click(step.x, step.y);
      return;
    case 'type_text': {
      // The mapper substituted credentials with $username / $password
      // placeholders. Resolve them now using the property's real creds.
      const value = step.value === '$username' ? creds.username
                  : step.value === '$password' ? creds.password
                  : step.value;
      await page.keyboard.type(value);
      return;
    }
    case 'wait_for':
      await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? 15_000 });
      return;
    case 'wait_ms':
      await new Promise((r) => setTimeout(r, step.ms));
      return;
    case 'select':
      await page.selectOption(step.selector, step.value);
      return;
    case 'press_key':
      await page.keyboard.press(step.key);
      return;
    case 'eval_text':
      // We don't store bindings cross-step in v0 — placeholder.
      return;
    case 'screenshot':
      // No-op in production runs (the screenshot would just go to a buffer
      // and be discarded). Useful for debugging when we capture them.
      return;
  }
}

async function runLogin(
  page: Page,
  login: Recipe['login'],
  creds: PMSCredentials,
): Promise<{ ok: true } | { ok: false; detail: Record<string, unknown> }> {
  try {
    await page.goto(login.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    for (const step of login.steps) {
      await runStep(page, step, creds);
    }
    // Confirm login by waiting for any of the success selectors.
    const selectors = login.successSelectors.length > 0 ? login.successSelectors : ['body'];
    await Promise.race(
      selectors.map((sel) => page.waitForSelector(sel, { timeout: login.timeoutMs ?? 15_000 })),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: { message: (err as Error).message } };
  }
}

// ─── Parsers ──────────────────────────────────────────────────────────────

async function runActionAsTable<T>(
  page: Page,
  actionName: string,
  action: ActionRecipe,
  creds: PMSCredentials,
): Promise<T[]> {
  // Codex audit pass-6 P0 — old behavior was: catch any error, log a
  // warn, return []. The job marked as success with empty data and
  // the GM had no way to know the recipe broke. This rewrite throws
  // a structured RecipeActionFailedError that the top-level runner
  // converts into a real failure result. Required actions also throw
  // when the table comes back empty (stale rowSelector), since a
  // hotel can't actually have zero rooms or zero staff.
  let rows: unknown[];
  try {
    for (const step of action.steps) {
      await runStep(page, step, creds);
    }

    if (action.parse.mode !== 'table') {
      throw new RecipeActionFailedError(
        actionName,
        `unsupported parse mode "${action.parse.mode}" — recipe needs re-mapping`,
      );
    }

    const hint = action.parse.hint;
    rows = await page.$$eval(
      hint.rowSelector,
      (els: Element[], columns: Record<string, string>) => {
        return els.map((el: Element) => {
          const out: Record<string, string> = {};
          for (const [field, sel] of Object.entries(columns)) {
            if (!sel) continue;
            const target = sel === '.' ? el : el.querySelector(sel);
            out[field] = target ? (target.textContent ?? '').trim() : '';
          }
          return out;
        });
      },
      hint.columns,
    );
  } catch (err) {
    // Re-throw our own typed error untouched; wrap anything else.
    if (err instanceof RecipeActionFailedError) throw err;
    throw new RecipeActionFailedError(
      actionName,
      'recipe step or selector failed at runtime',
      (err as Error).message,
    );
  }

  // Required actions can't legitimately be empty. A zero-row return
  // here means the recipe's rowSelector is stale (PMS UI changed and
  // the selector now matches nothing). Fail explicitly so the runner
  // surfaces the issue and triggers a re-map; a hotel can't actually
  // have zero rooms or zero staff. Optional actions (arrivals,
  // departures) may legitimately be 0 on a slow day — those pass.
  if (rows.length === 0 && REQUIRED_ACTIONS.has(actionName)) {
    throw new RecipeActionFailedError(
      actionName,
      'rowSelector matched zero rows — recipe likely stale (PMS UI may have changed)',
    );
  }

  return rows as T[];
}
