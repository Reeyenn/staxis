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
import { safeGoto } from './browser-utils/navigate.js';
import {
  verifyRecipe,
  recipeSigningMode,
  isRecipeSigningConfigured,
} from './recipe-signing.js';
import { createHash } from 'node:crypto';
import type {
  ActionRecipe,
  PMSArrival,
  PMSCredentials,
  PMSDeparture,
  PMSRoomDescriptor,
  PMSRoomStatus,
  Recipe,
  RecipeStep,
  TieredSelector,
} from './types.js';

/**
 * Codex adversarial review P1 — don't ship raw role/name strings to
 * production logs. Accessible names sometimes embed guest data (e.g.
 * "Open reservation for Jane Smith") and the worker's `info`/`warn`
 * logs land in Fly stdout. Hash the name (first 12 hex chars of SHA-256)
 * so durability telemetry stays useful — we can still spot the SAME
 * name resolving across runs by hash equality — without storing the
 * literal PII.
 */
function nameTelemetry(name: string): { nameHash: string; nameLength: number } {
  return {
    nameHash: createHash('sha256').update(name).digest('hex').slice(0, 12),
    nameLength: name.length,
  };
}

/** Derive the allowed-host bound from a recipe's login.startUrl. Used
 *  for every navigation AFTER the login startUrl itself — keeps replay
 *  pinned to the PMS domain that was recorded at mapping-time. Closes
 *  Codex 2026-05-16 P1 (Pattern B). */
function allowedHostFromRecipe(login: Recipe['login']): string {
  return new URL(login.startUrl).host;
}

interface RunOptions {
  recipe: Recipe;
  credentials: PMSCredentials;
  /**
   * HMAC over canonical-JSON of the recipe (Plan v2 F-AI-2). NULL means
   * the row is unsigned — recipe-runner refuses in enforce mode, logs and
   * proceeds in warn mode (default during the rollout). Always pass the
   * value loaded from the DB; do NOT pass null just to skip verification.
   */
  signature: Buffer | null;
  signedWithKeyId: string | null;
  /** ISO date for date-aware actions; default today in property's TZ. */
  date?: string;
  /** Look-back window for getHistoricalOccupancy. */
  historyDays?: number;
  onProgress?: (step: string, pct: number) => void;
}

export interface ExtractedData {
  rooms: PMSRoomDescriptor[];
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
  'getRoomStatus',
  'getHistoricalOccupancy',
]);

export async function runRecipeExtraction(opts: RunOptions): Promise<ExtractionResult> {
  let browser: Browser | null = null;

  try {
    // ─── Recipe signature verification (Plan v2 F-AI-2) ────────────────
    // Refuse to run a tampered or unsigned recipe in enforce mode. In
    // warn mode (the rollout default) we log mismatches but proceed so
    // operators can flip the enforcement only after the doctor's
    // `recipes_all_signed` check is green.
    if (isRecipeSigningConfigured() || opts.signature) {
      const verify = verifyRecipe(opts.recipe, opts.signature, opts.signedWithKeyId);
      if (!verify.ok) {
        const mode = recipeSigningMode();
        const detail = {
          phase: 'recipe_verify',
          reason: verify.reason,
          mode,
        };
        if (mode === 'enforce') {
          log.error('recipe-runner refusing tampered/unsigned recipe', detail);
          return {
            ok: false,
            userMessage:
              "We couldn't verify the integrity of your hotel's automation recipe. " +
              'Please contact support — we may need to re-learn your PMS.',
            detail,
          };
        }
        // warn mode: log loudly but proceed. The warn metric is the
        // doctor's lever to know when 100% of rows are signed and the
        // env flip is safe.
        log.warn('recipe signature verification failed (warn mode — proceeding)', detail);
      } else {
        if (verify.keyGeneration === 'previous') {
          log.warn('recipe verified with PREVIOUS signing key (resign soon)', {
            phase: 'recipe_verify',
          });
        }
      }
    }

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

    // Codex 2026-05-16 P1 fix (Pattern B): allowed-host bound for every
    // post-login goto in this run. Derived from the recipe's recorded
    // startUrl host; any action step trying to navigate off this site
    // (off-domain SSRF or attacker-injected URL) is refused by safeGoto.
    const allowedHost = allowedHostFromRecipe(opts.recipe.login);

    // ─── Run each supported action ────────────────────────────────────────
    const data: ExtractedData = {
      rooms: [],
      arrivalsToday: [],
      departuresToday: [],
      roomStatus: [],
      history: [],
    };

    if (opts.recipe.actions.getRoomLayout) {
      opts.onProgress?.('Pulling room list…', 72);
      data.rooms = await runActionAsTable<PMSRoomDescriptor>(
        page, 'getRoomLayout', opts.recipe.actions.getRoomLayout, opts.credentials, allowedHost,
      );
    }
    // getStaffRoster branch removed in v8 Phase D.1.
    if (opts.recipe.actions.getArrivals) {
      opts.onProgress?.('Pulling today\'s arrivals…', 82);
      data.arrivalsToday = await runActionAsTable<PMSArrival>(
        page, 'getArrivals', opts.recipe.actions.getArrivals, opts.credentials, allowedHost,
      );
    }
    if (opts.recipe.actions.getDepartures) {
      opts.onProgress?.('Pulling today\'s departures…', 85);
      data.departuresToday = await runActionAsTable<PMSDeparture>(
        page, 'getDepartures', opts.recipe.actions.getDepartures, opts.credentials, allowedHost,
      );
    }
    if (opts.recipe.actions.getRoomStatus) {
      opts.onProgress?.('Pulling room status…', 88);
      data.roomStatus = await runActionAsTable<PMSRoomStatus>(
        page, 'getRoomStatus', opts.recipe.actions.getRoomStatus, opts.credentials, allowedHost,
      );
    }
    if (opts.recipe.actions.getHistoricalOccupancy) {
      opts.onProgress?.('Pulling 90 days of history…', 89);
      // History rows: { date, occupied, totalRooms }
      type HistoryRow = { date: string; occupied: number; totalRooms: number };
      data.history = await runActionAsTable<HistoryRow>(
        page, 'getHistoricalOccupancy', opts.recipe.actions.getHistoricalOccupancy, opts.credentials, allowedHost,
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
    case 'getArrivals':           return "today's arrivals";
    case 'getDepartures':         return "today's departures";
    case 'getRoomStatus':         return 'room status';
    case 'getHistoricalOccupancy':return 'occupancy history';
    default:                      return actionName;
  }
}

// ─── Step execution ───────────────────────────────────────────────────────

/**
 * Resolve credential placeholders for a recipe step value. Plan v2 F-AI-2
 * defence-in-depth: even if recipe signing is bypassed (key compromise,
 * rollout in warn mode), credentials are only resolved inside `login.steps`.
 * A non-login step that references `$username` / `$password` throws here
 * rather than typing the real credential into an attacker-chosen selector.
 */
function resolveValueWithScope(
  rawValue: string,
  creds: PMSCredentials,
  allowCredentialPlaceholders: boolean,
): string {
  if (rawValue === '$username' || rawValue === '$password') {
    if (!allowCredentialPlaceholders) {
      throw new Error(
        `credential_placeholder_outside_login: recipe step requested ${rawValue} ` +
        'from a non-login step. Refusing to type credentials into a selector ' +
        'the login phase did not record.'
      );
    }
    return rawValue === '$username' ? creds.username : creds.password;
  }
  return rawValue;
}

/**
 * Plan v9 F2 — tiered click. Tries Playwright tiers in order:
 *   1. page.getByRole(role, { name }).click()    — most durable
 *   2. page.locator(css).click()                  — fast & precise but brittle
 *   3. page.locator('xpath=' + xpath).click()     — last resort
 *
 * Logs `resolved_tier` so we have telemetry on selector durability over
 * weeks of polling. Returns `true` on success, throws on full exhaustion.
 *
 * Each tier gets its own 5s timeout — total worst case is ~15s for an
 * element that doesn't exist at all, which is what the legacy click
 * step's 10s timeout would have spent already.
 */
async function clickWithTieredFallback(
  page: Page,
  tier: TieredSelector,
  /** Optional legacy CSS string — used when `tier.css` is unset (back-compat). */
  legacyCss?: string,
  /** For telemetry — caller passes the step kind ('click' / 'click_at'). */
  context: string = 'click',
): Promise<{ resolvedTier: 'role_name' | 'css' | 'xpath' }> {
  const TIER_TIMEOUT_MS = 5_000;
  // Tier 1: role + accessible name.
  //
  // Codex adversarial review P1 fix: pass `exact: true` so Playwright
  // matches the FULL accessible name, not a substring. Without it,
  // recorded `Edit` would also resolve `Edit reservation`, `Edit guest`,
  // etc., and `.first()` would silently click whichever is topmost. We
  // also drop `.first()`: when multiple elements share the exact role+
  // name (rare but possible — e.g. two identical "Continue" buttons in
  // separate panels), Playwright's strict-mode locator action throws
  // and we fall through to tier 2 (CSS) rather than guess.
  if (tier.roleName) {
    try {
      await page
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .getByRole(tier.roleName.role as any, { name: tier.roleName.name, exact: true })
        .click({ timeout: TIER_TIMEOUT_MS });
      log.info('recipe-runner: tier resolved', {
        context,
        resolvedTier: 'role_name',
        role: tier.roleName.role,
        ...nameTelemetry(tier.roleName.name),
      });
      return { resolvedTier: 'role_name' };
    } catch (err) {
      log.warn('recipe-runner: role_name tier failed, falling back', {
        context,
        role: tier.roleName.role,
        ...nameTelemetry(tier.roleName.name),
        message: (err as Error).message,
      });
    }
  }
  // Tier 2: CSS.
  const css = tier.css ?? legacyCss;
  if (css) {
    try {
      await page.locator(css).first().click({ timeout: TIER_TIMEOUT_MS });
      log.info('recipe-runner: tier resolved', {
        context,
        resolvedTier: 'css',
        css,
      });
      return { resolvedTier: 'css' };
    } catch (err) {
      log.warn('recipe-runner: css tier failed, falling back', {
        context,
        css,
        message: (err as Error).message,
      });
    }
  }
  // Tier 3: xpath.
  if (tier.xpath) {
    try {
      await page.locator(`xpath=${tier.xpath}`).first().click({ timeout: TIER_TIMEOUT_MS });
      log.info('recipe-runner: tier resolved', {
        context,
        resolvedTier: 'xpath',
        xpath: tier.xpath,
      });
      return { resolvedTier: 'xpath' };
    } catch (err) {
      log.warn('recipe-runner: xpath tier failed', {
        context,
        xpath: tier.xpath,
        message: (err as Error).message,
      });
    }
  }
  // Exhausted every tier the caller supplied.
  throw new Error(
    `tiered_click_exhausted: tried roleName=${tier.roleName ? 'yes' : 'no'} ` +
      `css=${css ? 'yes' : 'no'} xpath=${tier.xpath ? 'yes' : 'no'}`,
  );
}

async function runStep(
  page: Page,
  step: RecipeStep,
  creds: PMSCredentials,
  allowedHost: string,
  allowCredentialPlaceholders: boolean,
): Promise<void> {
  switch (step.kind) {
    case 'goto':
      // Codex 2026-05-16 P1 fix (Pattern B): every recipe goto is bound
      // to the recipe's registered host. A poisoned recipe row pointing
      // at attacker.example throws UnsafeNavigationError here BEFORE
      // the authenticated PMS session ever touches the network.
      await safeGoto(page, step.url, {
        allowedHost,
        context: 'recipe-runner:step:goto',
      });
      return;
    case 'fill': {
      const value = resolveValueWithScope(step.value, creds, allowCredentialPlaceholders);
      await page.fill(step.selector, value, { timeout: 10_000 });
      return;
    }
    case 'click':
      // Plan v9 F2 — when the step carries tiered selectors, try them in
      // order and only fall back to the legacy single-selector click if
      // every tier exhausts. Recipes recorded BEFORE this feature have
      // no `tieredSelector`, so they take the legacy path and replay
      // exactly as before.
      if (step.tieredSelector) {
        await clickWithTieredFallback(page, step.tieredSelector, step.selector, 'click');
      } else {
        await page.click(step.selector, { timeout: 10_000 });
      }
      return;
    case 'click_at':
      // Plan v9 F2 — when the vision-mode click handler recorded a
      // role+name alongside the coordinate, try `getByRole` first. If
      // that fails (the PMS UI shifted), fall back to the recorded
      // coordinate — same behavior as before the upgrade.
      //
      // Codex adversarial review P1 fix: `exact: true` to avoid silent
      // substring matches, no `.first()` so ambiguity surfaces and we
      // fall through to coord. Telemetry hashes the name to avoid PII
      // leaks to Fly stdout.
      if (step.roleName) {
        try {
          await page
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .getByRole(step.roleName.role as any, { name: step.roleName.name, exact: true })
            .click({ timeout: 5_000 });
          log.info('recipe-runner: tier resolved', {
            context: 'click_at',
            resolvedTier: 'role_name',
            role: step.roleName.role,
            ...nameTelemetry(step.roleName.name),
          });
          return;
        } catch (err) {
          log.warn('recipe-runner: click_at role_name tier failed, falling back to coordinate', {
            role: step.roleName.role,
            ...nameTelemetry(step.roleName.name),
            x: step.x,
            y: step.y,
            message: (err as Error).message,
          });
        }
      }
      // Coordinate-based replay — the mapper recorded a click at (x, y)
      // because Claude clicked at pixel coordinates rather than a CSS
      // selector. Brittle to UI resizes but adequate as a backstop.
      await page.mouse.click(step.x, step.y);
      log.info('recipe-runner: tier resolved', {
        context: 'click_at',
        resolvedTier: 'coordinate',
        x: step.x,
        y: step.y,
      });
      return;
    case 'type_text': {
      // The mapper substituted credentials with $username / $password
      // placeholders. Resolve them now — but ONLY inside login.steps
      // (Plan v2 F-AI-2 defence-in-depth).
      const value = resolveValueWithScope(step.value, creds, allowCredentialPlaceholders);
      await page.keyboard.type(value);
      return;
    }
    case 'wait_for':
      await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? 15_000 });
      return;
    case 'wait_ms':
      await new Promise((r) => setTimeout(r, step.ms));
      return;
    case 'select': {
      // Plan v2.1 MP-1 — route step.value through the same placeholder
      // scope check that fill/type_text use. selectOption matches against
      // <option value="…"> rather than typing, so a poisoned `$password`
      // here wouldn't leak the credential — but symmetric coverage
      // preserves the documented invariant that credential placeholders
      // never resolve outside login.steps.
      const value = resolveValueWithScope(step.value, creds, allowCredentialPlaceholders);
      await page.selectOption(step.selector, value);
      return;
    }
    case 'press_key':
      await page.keyboard.press(step.key);
      return;
    case 'eval_text':
      // Disabled: cross-step bindings were never wired up and a future
      // re-enable shouldn't slip past an audit. If you need it, route
      // through a dedicated step kind with a security review.
      throw new Error('eval_text step kind is disabled (see recipe-runner.ts for context)');
    case 'screenshot':
      // Disabled in prod: the screenshot would just go to a buffer and
      // be discarded. Surfacing as an explicit throw rather than a
      // silent no-op so a future maintainer doesn't accidentally
      // re-enable it without a security review.
      throw new Error('screenshot step kind is disabled (see recipe-runner.ts for context)');
  }
}

async function runLogin(
  page: Page,
  login: Recipe['login'],
  creds: PMSCredentials,
): Promise<{ ok: true } | { ok: false; detail: Record<string, unknown> }> {
  try {
    // The login startUrl IS the trust anchor — every subsequent goto is
    // pinned to ITS host. The startUrl itself doesn't need an allowedHost
    // check, but safeGoto still rejects javascript:/file:/private-IP URLs
    // so even a poisoned recipe row can't establish a malicious session.
    const allowedHost = allowedHostFromRecipe(login);
    await safeGoto(page, login.startUrl, {
      allowedHost: null,
      context: 'recipe-runner:login:startUrl',
    });
    for (const step of login.steps) {
      // Plan v2 F-AI-2: login phase is the ONLY place credential
      // placeholders may resolve. resolveValueWithScope throws otherwise.
      await runStep(page, step, creds, allowedHost, /* allowCredentialPlaceholders */ true);
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
  allowedHost: string,
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
      // Plan v2 F-AI-2: action steps must NOT resolve credentials. A
      // poisoned recipe filling `$password` into a same-origin form
      // would throw here rather than typing the real credential.
      await runStep(page, step, creds, allowedHost, /* allowCredentialPlaceholders */ false);
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

  // Plan v2 M-3 — cap the row count we serialize into JS objects.
  // A poisoned recipe with `rowSelector: '*'` (or even a too-broad
  // legitimate selector after a PMS UI change) would otherwise pull
  // the entire same-site DOM into memory. 5000 rows is comfortably
  // above any real-world hotel (Comfort Suites has 61 rooms; the
  // largest Choice Hotel has ~800) but stops the memory-DoS case.
  const MAX_ROWS_PER_ACTION = 5000;
  if (rows.length > MAX_ROWS_PER_ACTION) {
    throw new RecipeActionFailedError(
      actionName,
      `too_many_rows: ${rows.length} matched, cap is ${MAX_ROWS_PER_ACTION}. ` +
        'Either the rowSelector is too broad or the PMS page has unusual content. ' +
        'Re-run the mapper to refit the selector.',
    );
  }

  return rows as T[];
}
