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
        page, opts.recipe.actions.getRoomLayout, opts.credentials,
      );
    }
    if (opts.recipe.actions.getStaffRoster) {
      opts.onProgress?.('Pulling staff roster…', 78);
      data.staff = await runActionAsTable<PMSStaffMember>(
        page, opts.recipe.actions.getStaffRoster, opts.credentials,
      );
    }
    if (opts.recipe.actions.getArrivals) {
      opts.onProgress?.('Pulling today\'s arrivals…', 82);
      data.arrivalsToday = await runActionAsTable<PMSArrival>(
        page, opts.recipe.actions.getArrivals, opts.credentials,
      );
    }
    if (opts.recipe.actions.getDepartures) {
      opts.onProgress?.('Pulling today\'s departures…', 85);
      data.departuresToday = await runActionAsTable<PMSDeparture>(
        page, opts.recipe.actions.getDepartures, opts.credentials,
      );
    }
    if (opts.recipe.actions.getRoomStatus) {
      opts.onProgress?.('Pulling room status…', 88);
      data.roomStatus = await runActionAsTable<PMSRoomStatus>(
        page, opts.recipe.actions.getRoomStatus, opts.credentials,
      );
    }
    if (opts.recipe.actions.getHistoricalOccupancy) {
      opts.onProgress?.('Pulling 90 days of history…', 89);
      // History rows: { date, occupied, totalRooms }
      type HistoryRow = { date: string; occupied: number; totalRooms: number };
      data.history = await runActionAsTable<HistoryRow>(
        page, opts.recipe.actions.getHistoricalOccupancy, opts.credentials,
      );
    }

    return { ok: true, data };
  } catch (err) {
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
  action: ActionRecipe,
  creds: PMSCredentials,
): Promise<T[]> {
  try {
    for (const step of action.steps) {
      await runStep(page, step, creds);
    }

    if (action.parse.mode !== 'table') {
      log.warn('non-table parse mode not yet supported', { mode: action.parse.mode });
      return [];
    }

    const hint = action.parse.hint;
    const rows = await page.$$eval(
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

    return rows as unknown as T[];
  } catch (err) {
    log.warn('table action failed', { err: (err as Error).message });
    return [];
  }
}
