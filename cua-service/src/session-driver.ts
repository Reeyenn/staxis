/**
 * Per-hotel session driver — owns one persistent Playwright BrowserContext.
 *
 * The session-driver is the workhorse of plan v4: it stays logged into
 * one hotel's PMS 24/7, polls the active feeds every ~30 sec, and
 * writes the results into the new 15-table schema. The session-supervisor
 * boots one of these per enabled hotel and watches their heartbeats.
 *
 * Composition (the building blocks):
 *   - knowledge-file.ts: tells us where data lives in this PMS
 *   - cost-cap.ts: pauses Claude calls when $5/day reached
 *   - single-flight.ts: prevents overlapping reads
 *   - memory-monitor.ts: signals when to restart
 *   - mfa-handler.ts: trust device + paused-auth state
 *   - extractors/*: per-mode data extraction (csv/dom_table/fetch/inline)
 *   - persistence/new-schema-writer.ts: writes the 5 active feeds
 *
 * What this file ISN'T responsible for:
 *   - Spawning multiple drivers (session-supervisor.ts does that)
 *   - Workflow execution (workflow-runtime.ts does that, but acquires
 *     the browser-lock from here)
 *   - Mapping new PMSes (mapper.ts kept for that, not invoked from here
 *     in Phase 1)
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { supabase } from './supabase.js';
import { log } from './log.js';
import { env } from './env.js';
import { loadActive, type LoadedKnowledgeFile } from './knowledge-file.js';
import { checkBudget, markResumed, checkDailyMappingSpend } from './cost-cap.js';
import { schedule as singleFlight, getMetrics as getSingleFlightMetrics } from './single-flight.js';
import { shouldRestart } from './memory-monitor.js';
import {
  clickTrustDeviceIfPresent,
  detectMfaPrompt,
  pauseForMfa,
} from './mfa-handler.js';
// Plan v7 sole-path runtime (2026-05-24). Legacy choice-advantage
// normalizers + new-schema-writer hand-coded writers were retired —
// the generic-table-writer driven by mapper-produced TableTemplates
// is the only write path now.
import { saveGenericTable } from './persistence/generic-table-writer.js';
import { runSingleSourceTemplate } from './extractors/template-runner.js';
import { runMultiSourceTemplate } from './extractors/multi-source-runner.js';
import { recipeToTableTemplates } from './recipe-adapter.js';
import { safeGoto, normalizeUrl } from './browser-utils/navigate.js';
import type { Recipe, ScraperCredentialsRow, TableTemplate, ActionRecipe, TableRowHint } from './types.js';
// feature/cua-self-heal-reach — RUNG-2 cheap re-anchor (decision core + safety cores).
import { extractDomRows, readTableHeaders, headerGateOk } from './extractors/dom-rows.js';
import { certifyColumns } from './column-recovery.js';
import {
  checkFeedHealth,
  decideColumnReanchor,
  buildCandidateSelectors,
  applyColumnReanchor,
  requiredColumnsForTarget,
  MIN_REANCHOR_ROWS,
  type ColumnChange,
} from './reanchor.js';
import { promoteRecipeChange } from './mapping-driver.js';
import type { FreshExtractionShape, FixtureColumnVerdict } from './golden-fixtures.js';

const VIEWPORT = { width: 1280, height: 800 };
const POLL_INTERVAL_MS = 30_000;
const POLL_JITTER_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const READ_TIMEOUT_MS = 120_000;

// feature/cua-self-heal-reach — RUNG-2 re-anchor knobs.
/** DEFAULT OFF (monotonic): unset ⟹ self-repair goes straight to the $3 paid
 *  re-learn exactly as today. Flip to try the free re-anchor first. */
function reanchorEnabled(): boolean {
  return (process.env.CUA_REANCHOR_ENABLED ?? 'false').toLowerCase() === 'true';
}
/** The re-anchor live-page probe runs under the read mutex with this timeout. */
const REANCHOR_TIMEOUT_MS = 90_000;
/** Rows scraped for the re-anchor health/candidate probe. */
const REANCHOR_PROBE_CAP = 60;
/** Lifetime re-anchor attempts per feed per session — bounds any version-churn
 *  loop; beyond it, self-repair goes straight to the paid path. */
const MAX_REANCHOR_ATTEMPTS = 2;

/** ISO "today" (yyyy-mm-dd) in the PMS timezone for re-anchor value
 *  certification. Uses the PMS tz (the same CUA_PMS_TZ → America/Chicago default
 *  the runtime date-templating + cost-cap use) instead of the Fly box's UTC
 *  clock, so the date-window certification doesn't skew near midnight in
 *  far-from-UTC timezones (which would wrongly abstain a valid date column). */
function reanchorTodayIso(): string {
  return todayInTimezone(process.env.CUA_PMS_TZ || 'America/Chicago');
}

/** Transpose extracted rows → per-column value arrays (same row order). Missing
 *  cells read as '' so all column arrays stay length-aligned for cross-column
 *  certification checks. */
function transposeColumns(
  rows: Array<Record<string, string>>,
  cols: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of cols) out[c] = rows.map((r) => r[c] ?? '');
  return out;
}
// Plan v7 Phase 2c — knowledge hot-reload poll. Every 60s, the driver
// checks whether the active version for its pms_family has changed
// (e.g. mapping-driver promoted a new draft). If so, reload in place
// — no full driver restart needed.
const KNOWLEDGE_RELOAD_INTERVAL_MS = 60_000;

interface ScraperSessionRow {
  property_id: string;
  state: Record<string, unknown> | null;
  refreshed_at: string | null;
}

export interface SessionDriverOptions {
  propertyId: string;
  pmsFamily: string;
  workerMachineId: string;
}

// Plan v7 — priority order for the polling loop's table sweep.
// Lower number = runs earlier. Dashboard / in-house snapshot first
// (cheapest, most-displayed); then list pages; then drill-down.
const TABLE_PRIORITY: Record<string, number> = {
  pms_in_house_snapshot: 1,
  pms_reservations: 2,
  pms_rooms_inventory: 3,
  pms_room_status_log: 4,
  pms_housekeeping_assignments: 5,
  pms_work_orders_v2: 6,
  pms_revenue_daily: 7,
  pms_rates_and_inventory: 8,
  pms_channel_performance: 9,
  pms_forecast_daily: 10,
  pms_groups_and_blocks: 11,
  pms_guests: 12,         // drill-down: most expensive
  pms_lost_and_found: 13,
  pms_activity_log: 14,
};
function priorityOf(tableName: string): number {
  return TABLE_PRIORITY[tableName] ?? 99;
}

/**
 * Per-hotel session driver. Construct, call start(), it runs forever
 * until stop() is called or memory-monitor signals restart.
 */
export class SessionDriver {
  private readonly propertyId: string;
  private readonly pmsFamily: string;
  private readonly workerMachineId: string;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private knowledgeFile: LoadedKnowledgeFile | null = null;
  /** Plan v7 — version of the currently-loaded knowledge file. Compared
   *  against the active version in DB every 60s; mismatch = hot-reload. */
  private knowledgeFileVersion: number = 0;
  private knowledgeReloadHandle: NodeJS.Timeout | null = null;
  private credentials: { username: string; password: string; loginUrl: string } | null = null;
  private allowedHost: string | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  private heartbeatHandle: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  /** When > 0, browser is locked by workflow-runtime; reads pause. */
  private browserLockDepth = 0;

  /**
   * Plan v8 self-repair (the "middle ground" — recipe-runner spots a
   * dead selector and fires a tiny single-target re-learn, instead of
   * failing-forever or doing a full $25 re-mapping).
   *
   * Per-action consecutive-zero-rows counter. After CONSECUTIVE_ZERO_THRESHOLD
   * polls returning 0 rows for the same target, enqueue a repair job
   * (mapper.learn_pms_family with payload.seed_actions populated). The
   * idempotency_key prevents duplicate enqueue while the repair is
   * already in-flight.
   */
  private consecutiveZeroRowsByAction: Map<string, number> = new Map();

  /** feature/cua-self-heal-reach — lifetime rung-2 re-anchor attempts per feed
   *  this session (bounds version-churn; see MAX_REANCHOR_ATTEMPTS). */
  private reanchorAttemptsByAction: Map<string, number> = new Map();

  /** feature/cua-self-heal-reach — feeds whose zero-row streak tripped this poll.
   *  Self-heal is DEFERRED to AFTER the poll's single-flight read mutex releases
   *  (drainSelfHeal in pollOnce): the rung-2 re-anchor probe re-acquires that same
   *  per-hotel mutex, so running it inline (still inside the poll's lock) would
   *  always see the lock busy and fall straight through to the paid path. */
  private pendingSelfHeal: Set<keyof Recipe['actions']> = new Set();

  /**
   * feature/cua-per-hotel-data (Task 4) — consume template.incomplete at replay.
   * recipe-adapter flags a feed `incomplete` when it's genuinely un-locatable (a
   * csv flow with no recorded download trigger, a dom_table/inline feed with no
   * source URL, an inline feed needing interaction the inline extractor can't
   * replay). Such a feed can NEVER produce rows, so polling it every 30s only
   * burns a navigation, counts as a failed feed (dragging read_failure_streak),
   * and can mis-fire a paid self-repair. We skip it and surface it for review.
   *
   * Holds the action/table keys flagged incomplete for the CURRENT knowledge
   * version (incompleteness is a static property of the recipe, so within a
   * version this set is stable). Single source of truth: drives BOTH the
   * log-ONCE warn (not every 30s poll) AND the heartbeat `notes` annotation
   * (/admin/property-sessions). Cleared on knowledge hot-reload so a promoted
   * fix drops the flag and a still-broken feed re-surfaces under the new version.
   */
  private loggedIncompleteFeeds: Set<string> = new Set();

  constructor(opts: SessionDriverOptions) {
    this.propertyId = opts.propertyId;
    this.pmsFamily = opts.pmsFamily;
    this.workerMachineId = opts.workerMachineId;
  }

  /** Start the session — boots browser, restores state, kicks off polling + heartbeat. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info('session-driver: starting', {
      propertyId: this.propertyId,
      pmsFamily: this.pmsFamily,
      workerMachineId: this.workerMachineId,
    });

    await this.updateStatus({ status: 'starting' });

    // 1. Load knowledge file for this hotel's PMS family.
    this.knowledgeFile = await loadActive(this.pmsFamily);
    if (!this.knowledgeFile) {
      // Graceful pause — distinct from failed_restart. paused_no_knowledge_file
      // is admin-resolvable: someone needs to run the mapper or hand-seed
      // a knowledge file for this PMS. Plan v7 Phase 2c: also auto-enqueue
      // a mapper workflow job so the operator doesn't have to trigger it
      // manually. The workflow-runtime's no-driver claim path picks it
      // up; mapping-driver runs; auto-promotion may flip the new draft
      // to active; this driver's next start (after the supervisor reconciles)
      // loads the new recipe and goes alive. Whole flow: ~30-45 min.
      log.warn('session-driver: no active knowledge file — pausing + auto-enqueuing mapper', {
        propertyId: this.propertyId,
        pmsFamily: this.pmsFamily,
      });
      await this.updateStatus({
        status: 'paused_no_knowledge_file',
        paused_reason: `No active knowledge file for ${this.pmsFamily}. Auto-enqueued a mapper job; check /admin/property-sessions for progress.`,
      });
      await this.autoEnqueueMapperJob();
      this.running = false;
      return;
    }
    // Track loaded version for the hot-reload poll (Plan v7 Phase 2c —
    // when admin/auto promotes a new active version, we reload without
    // a full driver restart).
    this.knowledgeFileVersion = this.knowledgeFile.version;

    // 2. Load credentials.
    this.credentials = await this.loadCredentials();
    if (!this.credentials) {
      log.error('session-driver: no credentials for property', { propertyId: this.propertyId });
      await this.updateStatus({
        status: 'failed_restart',
        paused_reason: 'No active scraper_credentials row.',
      });
      this.running = false;
      return;
    }

    // Anchor the navigation host guard to the URL THIS hotel actually logs in
    // at (per-hotel > family — see currentLoginUrl). One active knowledge file
    // per pms_family fixes login.startUrl for every hotel on the family, so a
    // cloud PMS that gives each hotel its own subdomain (OPERA Cloud, Cloudbeds,
    // Mews, RoomKey) must anchor allowedHost to its own host or safeGoto would
    // false-reject its feed navigations as off-site. Derived after credentials
    // load because the per-hotel URL lives on the credentials row.
    this.allowedHost = this.currentAllowedHost();
    // Fail closed: an empty host means neither the per-hotel URL nor the family
    // startUrl could be parsed. Surface a failed_restart (admin-visible) rather
    // than letting a downstream new URL() throw uncaught and silently drop the
    // driver from the supervisor's map with no DB status.
    if (!this.allowedHost) {
      log.error('session-driver: could not derive a navigation host from the login URL', {
        propertyId: this.propertyId,
        pmsFamily: this.pmsFamily,
      });
      await this.updateStatus({
        status: 'failed_restart',
        paused_reason: 'Could not derive a navigation host — login URL is malformed.',
      });
      this.running = false;
      return;
    }

    // 3. Launch Playwright with saved storageState (if any).
    try {
      await this.bootBrowser();
    } catch (err) {
      log.error('session-driver: boot browser failed', {
        propertyId: this.propertyId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      await this.updateStatus({
        status: 'failed_restart',
        paused_reason: `Browser boot failed: ${(err as Error).message}`,
      });
      this.running = false;
      return;
    }

    // 4. Verify session — log in if needed.
    const loggedIn = await this.ensureLoggedIn();
    if (!loggedIn) {
      // ensureLoggedIn handled status update (paused_mfa or failed_restart).
      this.running = false;
      return;
    }

    // 5. Kick off polling + heartbeat. Reset restart_count here so a
    //    string of successful logins doesn't leave the dead-letter
    //    counter close to its limit from earlier failed attempts.
    await this.updateStatus({
      status: 'alive',
      last_alive_at: new Date().toISOString(),
      restart_count: 0,
      paused_reason: null,
      paused_until: null,
    });
    this.scheduleNextPoll();
    this.heartbeatHandle = setInterval(() => {
      void this.publishHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    // Plan v7 Phase 2c — knowledge hot-reload poll.
    this.knowledgeReloadHandle = setInterval(() => {
      void this.checkKnowledgeReload();
    }, KNOWLEDGE_RELOAD_INTERVAL_MS);

    log.info('session-driver: started', { propertyId: this.propertyId });
  }

  /** Graceful stop — save state, close browser. Does NOT update
   *  status; 'stopped' is reserved for admin-initiated halts. A graceful
   *  shutdown (SIGTERM during Fly deploy, supervisor restart, etc.)
   *  should leave the property_sessions row in whatever state it was so
   *  the next supervisor boot picks it back up via the reconcile loop. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.info('session-driver: stopping', { propertyId: this.propertyId });

    if (this.pollHandle) clearTimeout(this.pollHandle);
    if (this.heartbeatHandle) clearInterval(this.heartbeatHandle);
    if (this.knowledgeReloadHandle) clearInterval(this.knowledgeReloadHandle);

    // Save final storage state. context.storageState can fail if Fly
    // already started tearing down the firecracker VM — the warn is
    // expected on hard shutdowns and not actionable.
    if (this.context) {
      try {
        const state = await this.context.storageState();
        await this.saveStorageState(state as unknown as Record<string, unknown>);
      } catch (err) {
        log.warn('session-driver: final storageState save failed (non-fatal)', {
          propertyId: this.propertyId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.closeBrowser();
    this.running = false;
  }

  /** True iff the driver is actively running (start() succeeded and
   *  stop() hasn't been called). Supervisor uses this to detect drivers
   *  that silently exited and prune them from its map. */
  isRunning(): boolean {
    return this.running && !this.stopping;
  }

  /**
   * Acquire the browser lock for a workflow run. Returns a release
   * function. While the lock is held (depth > 0), the polling loop
   * skips its tick (the next scheduled tick will retry).
   */
  acquireBrowserLock(): () => void {
    this.browserLockDepth++;
    // Reader safety (single-flight reads, detectLoggedOut, re-login) assumes
    // EXACTLY ONE write lane drives this.page at a time — the lock is a
    // depth counter, not a serializing mutex. If a second writer ever
    // acquires concurrently (depth > 1), two code paths could drive the same
    // page at once and corrupt reads. There's only one write lane today
    // (workflow-runtime), so this must never happen; flag it loudly rather
    // than letting a future second lane silently race. Don't throw — the
    // caller still needs its release fn so the existing lane isn't wedged.
    if (this.browserLockDepth > 1) {
      log.error('session-driver: browser lock acquired concurrently (depth > 1) — reader safety assumes a single write lane', {
        propertyId: this.propertyId,
        depth: this.browserLockDepth,
      });
    }
    log.info('session-driver: browser lock acquired', {
      propertyId: this.propertyId,
      depth: this.browserLockDepth,
    });
    return () => {
      this.browserLockDepth--;
      log.info('session-driver: browser lock released', {
        propertyId: this.propertyId,
        depth: this.browserLockDepth,
      });
    };
  }

  /** Expose the page for workflow-runtime to drive writes. */
  getPageForWorkflow(): Page | null {
    return this.page;
  }

  // ─── Internals: boot + login ─────────────────────────────────────────

  private async bootBrowser(): Promise<void> {
    if (!this.knowledgeFile || !this.credentials) {
      throw new Error('precondition failed');
    }
    const stored = await this.loadStorageState();

    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      viewport: VIEWPORT,
      acceptDownloads: true,
      // storageState comes back as opaque jsonb from Supabase. Cast to
      // Playwright's expected shape. Malformed stored data will throw
      // from newContext and we fall back to fresh login in ensureLoggedIn.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storageState: (stored ?? undefined) as any,
    });
    this.page = await this.context.newPage();
  }

  /**
   * The login URL THIS hotel should navigate to. Precedence: the per-hotel
   * URL from scraper_credentials (ca_login_url) when present, else the PMS
   * family's shared knowledge-file login.startUrl.
   *
   * One active knowledge file per pms_family fixes login.startUrl for every
   * hotel on the family. Cloud PMSes (OPERA Cloud, Cloudbeds, Mews, RoomKey)
   * give each hotel its own subdomain, so without this the family startUrl
   * would point them all at a single tenant. Hotels with no per-hotel URL
   * (e.g. Choice Advantage) fall back to the family startUrl — unchanged.
   */
  private currentLoginUrl(): string {
    const familyStartUrl = this.knowledgeFile?.knowledge.login.startUrl ?? '';
    return resolveLoginUrl(this.credentials?.loginUrl, familyStartUrl);
  }

  /** Host for safeGoto's same-site guard, derived from exactly the URL we log
   *  in at (currentLoginUrl) so a per-hotel subdomain isn't false-rejected as
   *  off-site AND the guard can never skew from the navigation target. '' when
   *  no host can be derived — start() treats that as fail-closed. */
  private currentAllowedHost(): string {
    return resolveAllowedHost(this.currentLoginUrl());
  }

  /**
   * Re-point a login `goto` step at THIS hotel's login URL.
   *
   * The learner ALWAYS records the initial login navigation as
   * `{ kind: 'goto', url: <startUrl> }` (mapper.ts:1179), baking in the MAPPER
   * tenant's URL. One active knowledge file per pms_family means every hotel
   * replays that same baked goto — which, for a per-subdomain cloud PMS, shares
   * the family's registrable domain and so PASSES safeGoto's same-site guard,
   * silently funnelling the hotel back to the mapper's tenant. Re-pointing the
   * goto whose url is the family startUrl to currentLoginUrl() closes that hole.
   *
   * Only that one step is rewritten: every other recorded goto (intra-login
   * hops, SSO providers, shared-auth subdomains) is replayed exactly as learned
   * — blindly re-hosting those could break shared infra. No-op for hotels with
   * no per-hotel URL (currentLoginUrl() === family startUrl).
   */
  private loginGotoTarget(rawUrl: string): string {
    const familyStartUrl = this.knowledgeFile?.knowledge.login.startUrl ?? '';
    return resolveLoginGotoUrl(rawUrl, familyStartUrl, this.credentials?.loginUrl);
  }

  /**
   * feature/cua-per-hotel-data (Task 1) — re-point every runnable feed's source
   * URL(s) AND per-row detail URL template at THIS hotel's tenant origin (the
   * data-read analogue of loginGotoTarget). Mutates the freshly-built templates
   * in place: they're rebuilt from the knowledge file every poll, local to
   * runAllFeeds, so no shared/persisted state is touched. No-op for hotels with
   * no per-hotel URL (Choice Advantage) and for feeds not on the learned tenant
   * — see rehostFeedUrl.
   */
  private rehostFeedUrlsForHotel(templates: TableTemplate[]): void {
    const familyStartUrl = this.knowledgeFile?.knowledge.login.startUrl ?? '';
    const perHotelLoginUrl = this.credentials?.loginUrl;
    for (const template of templates) {
      for (const source of template.sources) {
        source.url = rehostFeedUrl(source.url, familyStartUrl, perHotelLoginUrl);
      }
      if (template.rowDetail) {
        template.rowDetail.urlTemplate = rehostFeedUrl(
          template.rowDetail.urlTemplate, familyStartUrl, perHotelLoginUrl,
        );
      }
    }
  }

  private async ensureLoggedIn(): Promise<boolean> {
    if (!this.page || !this.knowledgeFile || !this.credentials || !this.allowedHost) {
      throw new Error('ensureLoggedIn precondition failed');
    }
    const { login } = this.knowledgeFile.knowledge;
    // Precedence: the per-hotel login URL (scraper_credentials.ca_login_url)
    // wins over the family-shared startUrl; hotels with no per-hotel URL (e.g.
    // Choice Advantage) fall back to the family startUrl — see currentLoginUrl.
    // allowedHost stays null on this navigation: it's the session-establishing
    // goto, host-guarded only for scheme/private-IP, not same-site.
    const loginUrl = this.currentLoginUrl();

    // Probe: navigate to start URL. If we land on a login form, we're not logged in.
    try {
      await safeGoto(this.page, loginUrl, {
        allowedHost: null,
        context: 'session-driver:probe',
      });
    } catch (err) {
      log.warn('session-driver: probe goto failed', {
        propertyId: this.propertyId,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const successSelector = login.successSelectors[0];
    const onSuccessPage = successSelector
      ? await this.page.locator(successSelector).first().isVisible({ timeout: 3_000 }).catch(() => false)
      : false;

    if (onSuccessPage) {
      log.info('session-driver: existing session valid (no login needed)', {
        propertyId: this.propertyId,
      });
      return true;
    }

    log.info('session-driver: session expired — logging in', { propertyId: this.propertyId });

    // Match scraper.js convention: clear cookies before login. CA's
    // partial-session-cookie state can land us in a redirect chain that
    // bounces to j_security_check even with correct credentials.
    // Re-navigating to the start URL after clearing forces a fresh login
    // form render.
    try {
      await this.context!.clearCookies();
      await safeGoto(this.page, loginUrl, {
        allowedHost: null,
        context: 'session-driver:relogin',
      });
    } catch (err) {
      log.warn('session-driver: clearCookies/re-goto before login failed', {
        propertyId: this.propertyId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // MFA detection: if the probe landed us on an MFA prompt directly,
    // pause before attempting any login steps (the stored session was
    // valid until trust expired).
    const earlyMfa = await detectMfaPrompt(this.page);
    if (earlyMfa.mfa) {
      await pauseForMfa({
        propertyId: this.propertyId,
        detectedSelector: earlyMfa.selector,
        loginUrl,
      });
      return false;
    }

    // Execute login steps.
    try {
      for (const stepRaw of login.steps) {
        const step = stepRaw as Record<string, unknown>;
        await this.runLoginStep(step);
      }
    } catch (err) {
      log.error('session-driver: login step failed', {
        propertyId: this.propertyId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      await this.updateStatus({
        status: 'failed_restart',
        paused_reason: `Login failed: ${(err as Error).message}`,
      });
      return false;
    }

    // Click trust-device BEFORE submitting MFA (in case the next step is the MFA submit).
    if (login.trustDeviceSelectors && login.trustDeviceSelectors.length > 0) {
      await clickTrustDeviceIfPresent(this.page, login.trustDeviceSelectors);
    } else {
      await clickTrustDeviceIfPresent(this.page);
    }

    // Now check for MFA prompt after steps.
    const mfa = await detectMfaPrompt(this.page);
    if (mfa.mfa) {
      await pauseForMfa({
        propertyId: this.propertyId,
        detectedSelector: mfa.selector,
        loginUrl,
      });
      return false;
    }

    // Wait for login to actually succeed. CA's flow:
    //   - The browser POSTs the form to j_security_check
    //   - CA returns either:
    //     (a) 302 redirect to Welcome.init (success — URL becomes Welcome)
    //     (b) Re-render of login form with error (failure — URL still
    //         contains j_security_check OR back at Welcome.init with
    //         the j_username input visible)
    //   - The redirect chain can take 15-30 sec on slow networks (per
    //     scraper.js — choice.LogUserOff intermediate hops)
    //
    // So we wait for BOTH:
    //   1. The URL to leave j_security_check (positive signal)
    //   2. The username input to be gone (no re-render of login form)
    // Either failing → login failed.
    const loginTimeoutMs = login.timeoutMs ?? 30_000;
    try {
      await this.page!.waitForURL(
        (url) => {
          const s = url.toString();
          return !s.includes('j_security_check') && !s.includes('sign_in');
        },
        { timeout: loginTimeoutMs },
      );
    } catch (err) {
      log.error('session-driver: URL never left j_security_check', {
        propertyId: this.propertyId,
        url: safeUrl(this.page!),
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return false;
    }
    // Reactive MFA can land mid-redirect: the URL leaves j_security_check
    // (positive signal) but an MFA challenge is actually rendering, and the
    // username field being gone is NOT proof of login. Let the network
    // settle (best-effort — slow PMS redirect chains), then re-detect MFA.
    // If a challenge is up, pause for MFA rather than declaring success.
    await this.page!.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const postRedirectMfa = await detectMfaPrompt(this.page!);
    if (postRedirectMfa.mfa) {
      await pauseForMfa({
        propertyId: this.propertyId,
        detectedSelector: postRedirectMfa.selector,
        loginUrl,
      });
      return false;
    }
    // Now wait for the login form to be absent — catches the case where
    // CA redirected back to the login page (still URL-distinct from
    // j_security_check but with the form re-rendered).
    try {
      await this.page!.waitForSelector('input[name="j_username"], input[name="username"]', {
        state: 'detached',
        timeout: 10_000,
      });
    } catch (err) {
      log.error('session-driver: login form re-appeared after submit (bad credentials?)', {
        propertyId: this.propertyId,
        url: safeUrl(this.page!),
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return false;
    }
    const finalUrl = safeUrl(this.page!) ?? '';
    // Best-effort: also wait for a successSelector if configured, but
    // don't fail the login if it doesn't appear (it's a secondary hint).
    if (login.successSelectors.length > 0) {
      try {
        await Promise.race(
          login.successSelectors.map((sel) =>
            this.page!.waitForSelector(sel, { timeout: 5_000 }),
          ),
        );
      } catch {
        log.warn('session-driver: login succeeded by URL/form check but no successSelectors matched', {
          propertyId: this.propertyId,
          url: finalUrl,
          selectors: login.successSelectors,
        });
      }
    }

    // Save fresh storage state.
    if (this.context) {
      try {
        const state = await this.context.storageState();
        await this.saveStorageState(state as unknown as Record<string, unknown>);
      } catch (err) {
        log.warn('session-driver: post-login storageState save failed', {
          propertyId: this.propertyId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('session-driver: login complete', { propertyId: this.propertyId });
    return true;
  }

  /**
   * Phase-2 robustness (fix 1): cheap in-page check, run at the top of every
   * poll, that answers "is this page logged OUT?" WITHOUT navigating (the
   * poll already has us on a real PMS page).
   *
   * Returns true (logged-out) when EITHER:
   *   - a login-form input is visible (j_username / username / password), OR
   *   - an MFA prompt is visible (detectMfaPrompt), OR
   *   - the knowledge file's success selector is real (not body/html — C3)
   *     yet NOT present (the post-login chrome is gone).
   *
   * A 'body'/'html' success selector is treated as NO evidence of login
   * (C3): in that case we rely solely on the positive logged-out signals
   * (login form / MFA). False (treat as logged-in) on any probe error — the
   * existing zero-row streak guard remains the backstop, and we never want a
   * transient locator hiccup to force a needless re-login storm.
   */
  private async detectLoggedOut(): Promise<boolean> {
    if (!this.page || !this.knowledgeFile) return false;
    try {
      // Positive logged-out signal #1 — the login form is back.
      const loginFormVisible = await this.page
        .locator('input[name="j_username"], input[name="username"], input[type="password"]')
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      if (loginFormVisible) return true;

      // Positive logged-out signal #2 — an MFA challenge is showing.
      const mfa = await detectMfaPrompt(this.page);
      if (mfa.mfa) return true;

      // Negative signal — a REAL success selector should still be present.
      // body/html carry no evidence (C3), so they can't prove logged-in and
      // their absence can't prove logged-out; skip them.
      const successSelector = this.knowledgeFile.knowledge.login.successSelectors.find(
        (s) => !isWeakSelector(s),
      );
      if (successSelector) {
        const present = await this.page
          .locator(successSelector)
          .first()
          .isVisible({ timeout: 2_000 })
          .catch(() => false);
        if (!present) return true;
      }

      return false;
    } catch {
      // Probe failure is inconclusive — don't force a re-login on a hiccup.
      return false;
    }
  }

  private async runLoginStep(step: Record<string, unknown>): Promise<void> {
    if (!this.page || !this.credentials || !this.allowedHost) {
      throw new Error('runLoginStep precondition failed');
    }
    const kind = step.kind as string;
    const resolve = (value: string): string => {
      if (value === '$username') return this.credentials!.username;
      if (value === '$password') return this.credentials!.password;
      return value;
    };
    switch (kind) {
      case 'goto':
        // Re-point the learner's baked-in login goto to THIS hotel's URL
        // (see loginGotoTarget) so a per-subdomain cloud PMS isn't
        // funnelled back to the mapper's tenant by the recorded step.
        await safeGoto(this.page, this.loginGotoTarget(step.url as string), {
          allowedHost: this.allowedHost,
          context: 'session-driver:login:goto',
        });
        return;
      case 'fill':
        await this.page.fill(step.selector as string, resolve(step.value as string), { timeout: 10_000 });
        return;
      case 'click':
        // Ordered fallback: scraper.js uses clickFirstMatching that
        // tries selectors in order, escalating to force-click on miss.
        // CSS unions ("a, b, c") would let Playwright pick whichever
        // matches first in the DOM — possibly the wrong element (e.g.
        // a "Remember me" toggle instead of the Login submit). Treat
        // a comma-separated selector value as an ordered fallback list.
        await this.clickFirstMatching(step.selector as string);
        return;
      case 'wait_for':
        await this.page.waitForSelector(step.selector as string, {
          timeout: (step.timeoutMs as number | undefined) ?? 15_000,
        });
        return;
      case 'wait_ms':
        await new Promise((r) => setTimeout(r, step.ms as number));
        return;
      case 'select':
        await this.page.selectOption(step.selector as string, resolve(step.value as string));
        return;
      case 'press_key':
        await this.page.keyboard.press(step.key as string);
        return;
      case 'type_text':
        await this.page.keyboard.type(resolve(step.value as string));
        return;
      default:
        throw new Error(`unsupported login step kind: ${kind}`);
    }
  }

  // ─── Internals: polling loop ─────────────────────────────────────────

  private scheduleNextPoll(): void {
    if (this.stopping) return;
    const jitter = Math.floor((Math.random() - 0.5) * 2 * POLL_JITTER_MS);
    const delay = Math.max(5_000, POLL_INTERVAL_MS + jitter);
    this.pollHandle = setTimeout(() => {
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }, delay);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopping) return;
    // Skip if browser-locked by a workflow.
    if (this.browserLockDepth > 0) {
      log.info('session-driver: poll skipped — browser locked by workflow', {
        propertyId: this.propertyId,
      });
      return;
    }

    // Check for restart signal from memory-monitor.
    const restart = shouldRestart();
    if (restart.restart) {
      log.warn('session-driver: restart requested — stopping', {
        propertyId: this.propertyId,
        reason: restart.reason,
      });
      await this.stop();
      process.exit(0);
      return;
    }

    // Check cost-cap: paused → skip poll (auto-resume happens at midnight reset).
    const budget = await checkBudget(this.propertyId);
    if (!budget.ok) {
      log.info('session-driver: poll skipped — paused', {
        propertyId: this.propertyId,
        reason: budget.reason,
        spentMicros: budget.spentMicros,
      });
      return;
    }
    // If we were paused for cost and tally is reset, flip back to alive.
    const wasPausedCost = await this.isStatus('paused_cost_cap');
    if (wasPausedCost) {
      await markResumed(this.propertyId);
    }

    // Run via single-flight mutex.
    await singleFlight(this.propertyId, READ_TIMEOUT_MS, async (signal) => {
      await this.runAllFeeds(signal);
    }).catch((err) => {
      log.warn('session-driver: poll failed', {
        propertyId: this.propertyId,
        err: err instanceof Error ? err.message : String(err),
      });
    });

    // feature/cua-self-heal-reach — process queued self-heals AFTER the poll's
    // read mutex has RELEASED. The rung-2 re-anchor probe re-acquires that same
    // mutex; running it here (not inside runAllFeeds) is what lets it actually
    // take the lock. scheduleNextPoll only fires after pollOnce() resolves, so
    // a bounded re-anchor probe can't overlap the next poll.
    await this.drainSelfHeal();
  }

  /** Run each queued self-heal (rung-2 re-anchor → rung-1 paid re-learn) now that
   *  the poll mutex is free. Bounded (one entry per feed per threshold-trip);
   *  errors are isolated so one feed's failure never blocks another's. */
  private async drainSelfHeal(): Promise<void> {
    if (this.pendingSelfHeal.size === 0) return;
    const pending = [...this.pendingSelfHeal];
    this.pendingSelfHeal.clear();
    for (const actionKey of pending) {
      try {
        await this.attemptSelfHeal(actionKey);
      } catch (err) {
        log.warn('session-driver: self-heal drain error', {
          propertyId: this.propertyId, actionKey, err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Plan v7 sole-path runtime (2026-05-24): drive extraction off the
   * mapper-produced Recipe.actions in the knowledge file, translated to
   * TableTemplate[] by recipe-adapter, then run + save via the generic
   * pipeline. Replaces the legacy per-feed mode-switch that called
   * choice-advantage normalizers + new-schema-writer hand-coded writers.
   */
  private async runAllFeeds(signal: AbortSignal): Promise<void> {
    if (!this.knowledgeFile || !this.page || !this.allowedHost) return;

    const actions = this.knowledgeFile.knowledge.actions as Recipe['actions'] | undefined;
    if (!actions || Object.keys(actions).length === 0) {
      log.warn('session-driver: knowledge file has no recipe.actions — nothing to poll', {
        propertyId: this.propertyId,
        pmsFamily: this.pmsFamily,
        knowledgeFileVersion: this.knowledgeFileVersion,
      });
      return;
    }

    // Phase-2 robustness (fix 1): the 30s poll loop must re-check login on
    // EVERY tick. ensureLoggedIn/detectMfaPrompt only run at start(); without
    // this, an expired PMS session goes undetected and the extractors happily
    // scrape (and write) login-page chrome. If the current page shows the
    // login form / an MFA prompt — or lacks real evidence of being logged in
    // (a 'body'/'html' success selector is NO evidence per C3) — attempt a
    // single re-login via the existing ensureLoggedIn path. On failure, flip
    // to failed_restart so the supervisor respawns us (C2) and return WITHOUT
    // running feeds, so we never persist login-page data.
    let loggedOutThisPoll = false;
    if (await this.detectLoggedOut()) {
      loggedOutThisPoll = true;
      log.warn('session-driver: poll detected logged-out — attempting single re-login', {
        propertyId: this.propertyId,
        pmsFamily: this.pmsFamily,
      });
      const reloggedIn = await this.ensureLoggedIn().catch(() => false);
      if (!reloggedIn) {
        // ensureLoggedIn already set paused_mfa/failed_restart for its own
        // failure modes. For the plain logged-out-and-can't-recover case,
        // make the failed_restart explicit so the supervisor respawns us.
        await this.updateStatus({
          status: 'failed_restart',
          paused_reason: 'Polling detected logged-out and re-login failed.',
        });
        log.warn('session-driver: re-login failed — skipping feeds (failed_restart)', {
          propertyId: this.propertyId,
          pmsFamily: this.pmsFamily,
        });
        return;
      }
      // Re-login succeeded. Clear any zero-row streak so login-caused zeros
      // don't count toward self-repair; genuine drift rebuilds it later.
      this.consecutiveZeroRowsByAction.clear();
    }

    // Plan v8 self-repair guard: a zero-row streak is far more often an
    // expired PMS session (every feed returns empty) than selector drift.
    // Before running feeds, if any action is mid-streak, re-verify login and
    // re-login if needed — so a login expiry can't masquerade as drift and
    // burn paid re-mapping (~$2/run). Runs only when a streak already exists,
    // so it adds no overhead on the healthy path.
    const hasZeroStreak = Array.from(this.consecutiveZeroRowsByAction.values()).some((c) => c > 0);
    if (hasZeroStreak) {
      const loggedIn = await this.ensureLoggedIn().catch(() => false);
      if (!loggedIn) {
        log.warn('session-driver: zero-row streak + not logged in — skipping feeds, not firing self-repair (re-login/MFA pending)', {
          propertyId: this.propertyId,
          pmsFamily: this.pmsFamily,
        });
        return;
      }
      // Confirmed logged in (possibly just re-logged in). Clear the streak so
      // login-caused zeros don't count toward self-repair; genuine selector
      // drift rebuilds the streak across later confirmed-login polls.
      this.consecutiveZeroRowsByAction.clear();
    }

    // Recipe.actions → TableTemplate[]. Each template knows its target
    // pms_* table, write strategy, sources, fields, parsers.
    const recipe: Recipe = {
      schema: 1,
      login: this.knowledgeFile.knowledge.login as Recipe['login'],
      actions,
    };
    // feat/pms-universal-translate — hand the adapter the self-learned VALUE
    // translation saved in this family's knowledge file (date order + enum
    // vocabulary) so the generic parsers can normalize this PMS's strings.
    // Absent (e.g. the seeded Choice Advantage file) → ca_* / heuristic fallback.
    const adaptResult = recipeToTableTemplates(recipe, {
      valueTranslations: this.knowledgeFile.knowledge.valueTranslations,
      dateFormat: this.knowledgeFile.knowledge.dateFormat,
    });
    if (adaptResult.skipped.length > 0) {
      log.warn('session-driver: some actions skipped by adapter', {
        propertyId: this.propertyId,
        skipped: adaptResult.skipped,
      });
    }

    const results: Array<{ table: string; ok: boolean; rowsWritten?: number; reason?: string }> = [];
    // Read-health signal (fix 2): a sweep is "successful" iff at least one
    // feed both ran ok AND returned rows. Drives last_successful_read_at /
    // read_failure_streak below so the doctor + property-sessions UI can
    // tell a quietly-stuck session (logged-out, drifted) from a healthy one.
    let anySuccessfulFeed = false;

    // feature/cua-per-hotel-data (Task 4) — gate out feeds recipe-adapter flagged
    // `incomplete` (genuinely un-locatable). Skip them, record them in this
    // poll's results, and surface them for operator review (log once + heartbeat
    // note). Done BEFORE the per-hotel URL rewrite so we never bother re-hosting
    // a feed we're not going to run.
    const runnable: TableTemplate[] = [];
    for (const template of adaptResult.templates) {
      if (template.incomplete) {
        const key = (template.sourceActionKey as string | undefined) ?? template.tableName;
        results.push({ table: template.tableName, ok: false, reason: 'incomplete_feed_skipped_for_review' });
        if (!this.loggedIncompleteFeeds.has(key)) {
          this.loggedIncompleteFeeds.add(key);
          log.warn('session-driver: feed flagged incomplete (un-locatable) — skipping poll, needs operator review', {
            propertyId: this.propertyId,
            pmsFamily: this.pmsFamily,
            tableName: template.tableName,
            sourceActionKey: template.sourceActionKey,
            knowledgeFileVersion: this.knowledgeFileVersion,
          });
        }
        continue;
      }
      runnable.push(template);
    }

    // feature/cua-per-hotel-data (Task 1) — re-host each runnable feed's source +
    // detail URLs onto THIS hotel's tenant origin. The recipe's URLs were
    // recorded on the MAPPER tenant; one active knowledge file per pms_family
    // replays them for every hotel, so a per-subdomain cloud PMS (OPERA Cloud,
    // Cloudbeds, Mews, RoomKey) would log into ITS tenant (per-hotel login fix)
    // yet still READ the mapper tenant's data — the feed host shares the family
    // registrable domain, so safeGoto's same-site guard (registrable-domain, not
    // exact-host) waves it through. Mirrors the per-hotel login goto rewrite;
    // hotels with no per-hotel URL (Choice Advantage) are a no-op.
    this.rehostFeedUrlsForHotel(runnable);

    // Process in stable order: dashboard / in-house snapshot first
    // (cheapest, most-displayed), then list pages, then drill-down.
    const sorted = [...runnable].sort((a, b) => priorityOf(a.tableName) - priorityOf(b.tableName));

    for (const template of sorted) {
      if (signal.aborted) break;
      try {
        // feature/cua-tolerant-mapper — PMS-local view date for contextual
        // derivation (arrivals' arrival_date / departures' departure_date filled
        // from the day the page represents). Same tz the re-anchor + date
        // templating use, so a poll across midnight stamps the hotel's day.
        const runDateIso = reanchorTodayIso();
        const runResult = template.sources.length > 1
          ? await runMultiSourceTemplate({
              page: this.page,
              template,
              allowedHost: this.allowedHost,
              signal,
              runDateIso,
            })
          : await runSingleSourceTemplate({
              page: this.page,
              template,
              allowedHost: this.allowedHost,
              signal,
              runDateIso,
              // feature/cua-column-recovery — scope the per-row detail cache
              // by tenant AND knowledge-file version (a promoted repair's new
              // selectors must not consume extractions cached under the old).
              detailCacheScope: `${this.propertyId}:v${this.knowledgeFile?.version ?? 0}`,
            });

        if (!runResult.ok) {
          results.push({ table: template.tableName, ok: false, reason: runResult.reason });
          // Plan v8 self-repair — a run failure (broken navigation,
          // bad selector) counts toward consecutive-zero just like a
          // 0-row extraction. Both mean "selector probably drifted."
          // Suppress when this poll was logged-out (fix 2): a failure on a
          // logged-out page is a session artifact, not selector drift.
          // runFailed=true: the legitimately-empty-feed suppression must NOT
          // swallow real failures (a permanently failing work-order feed was
          // a silent black hole — column-recovery plan review P0). A sweep
          // ABORT is a scheduler artifact like a logged-out poll, not drift —
          // suppress it, or a mutex-overrun sweep would advance the streak and
          // fire paid repairs at healthy feeds (code review P2).
          this.maybeFireSelfRepair(template, 0, loggedOutThisPoll || signal.aborted, true);
          continue;
        }

        const saveResult = await saveGenericTable(
          this.propertyId,
          template.tableName,
          runResult.rows,
          // Fix 3: drive delta-vs-full reconcile safety off the TEMPLATE's
          // snapshotScope, not the descriptor default. A template that only
          // sees a partial view ('delta') must never trigger auto-resolve.
          { snapshotScope: template.snapshotScope },
        );
        results.push({
          table: template.tableName,
          ok: saveResult.ok,
          rowsWritten: saveResult.inserted + saveResult.updated + saveResult.autoResolved,
          reason: saveResult.errors[0],
        });
        // Read-health (fix 2): this feed ran ok and produced rows — the
        // session is genuinely reading the PMS, not staring at a login wall.
        if (runResult.rows.length > 0) anySuccessfulFeed = true;
        // Plan v8 self-repair — track zero-row streak; trigger repair
        // when threshold tripped. Non-zero row count resets the streak.
        // Suppress on a logged-out poll (fix 2).
        this.maybeFireSelfRepair(template, runResult.rows.length, loggedOutThisPoll);
      } catch (err) {
        log.warn('session-driver: template run threw', {
          propertyId: this.propertyId,
          tableName: template.tableName,
          err: err instanceof Error ? err.message : String(err),
        });
        results.push({ table: template.tableName, ok: false, reason: (err as Error).message });
      }
    }

    log.info('session-driver: poll complete', {
      propertyId: this.propertyId,
      results,
    });

    // Read-health signals (fix 2). On a sweep with at least one ok+rows
    // feed: stamp last_successful_read_at and zero the failure streak. On a
    // fully-empty sweep (every feed failed / drifted / login wall): bump the
    // streak so the doctor + property-sessions UI surface a quietly-stuck
    // session. Folded into a property_sessions update alongside last_alive_at
    // so it rides the same write the heartbeat path uses. Best-effort — a
    // failed update only loses a health stat, never the poll itself.
    try {
      if (anySuccessfulFeed) {
        const { error } = await supabase
          .from('property_sessions')
          .update({
            last_alive_at: new Date().toISOString(),
            last_successful_read_at: new Date().toISOString(),
            read_failure_streak: 0,
          })
          .eq('property_id', this.propertyId);
        if (error) {
          log.warn('session-driver: read-health (success) update failed', {
            propertyId: this.propertyId,
            err: error.message,
          });
        }
      } else {
        // Increment without an RPC: read the current streak, then write +1.
        // The cap is a soft monitoring signal, so an occasional lost bump
        // under concurrency is acceptable (matches the cost-cap rationale).
        const { data } = await supabase
          .from('property_sessions')
          .select('read_failure_streak')
          .eq('property_id', this.propertyId)
          .maybeSingle();
        const prev = (data as { read_failure_streak: number | null } | null)?.read_failure_streak ?? 0;
        const { error } = await supabase
          .from('property_sessions')
          .update({
            last_alive_at: new Date().toISOString(),
            read_failure_streak: prev + 1,
          })
          .eq('property_id', this.propertyId);
        if (error) {
          log.warn('session-driver: read-health (failure) update failed', {
            propertyId: this.propertyId,
            err: error.message,
          });
        }
      }
    } catch (err) {
      log.warn('session-driver: read-health update threw (non-fatal)', {
        propertyId: this.propertyId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Internals: heartbeat + status ───────────────────────────────────

  private async publishHeartbeat(): Promise<void> {
    const metrics = getSingleFlightMetrics(this.propertyId);
    const { error } = await supabase
      .from('property_sessions')
      .update({
        last_alive_at: new Date().toISOString(),
        worker_machine_id: this.workerMachineId,
        current_browser_url: this.page ? safeUrl(this.page) : null,
        // feature/cua-per-hotel-data (Task 4) — surface un-locatable feeds
        // skipped this version on /admin/property-sessions, alongside the
        // single-flight metrics (no schema change: folded into `notes`).
        notes:
          `polling: completed=${metrics.completed} skipped=${metrics.skipped} timedOut=${metrics.timedOut}` +
          (this.loggedIncompleteFeeds.size > 0
            ? ` | incomplete_feeds_skipped=${[...this.loggedIncompleteFeeds].sort().join(',')}`
            : ''),
      })
      .eq('property_id', this.propertyId);
    if (error) {
      log.warn('session-driver: heartbeat update failed', {
        propertyId: this.propertyId,
        err: error.message,
      });
    }
  }

  private async updateStatus(patch: Record<string, unknown>): Promise<void> {
    // Upsert pattern: insert if not exists, update if exists.
    const { error } = await supabase
      .from('property_sessions')
      .upsert(
        {
          property_id: this.propertyId,
          pms_family: this.pmsFamily,
          worker_machine_id: this.workerMachineId,
          ...patch,
        },
        { onConflict: 'property_id' },
      );
    if (error) {
      log.warn('session-driver: status update failed', {
        propertyId: this.propertyId,
        patch,
        err: error.message,
      });
    }
  }

  private async isStatus(status: string): Promise<boolean> {
    const { data } = await supabase
      .from('property_sessions')
      .select('status')
      .eq('property_id', this.propertyId)
      .maybeSingle();
    return data?.status === status;
  }

  // ─── Internals: credentials + session storage ────────────────────────

  private async loadCredentials(): Promise<{
    username: string;
    password: string;
    loginUrl: string;
  } | null> {
    // Read from the decrypted view, not the raw table (migration 0069
    // moved the actual values into vault-encrypted columns; the view
    // returns plaintext via decrypt_pms_credential).
    const { data, error } = await supabase
      .from('scraper_credentials_decrypted')
      .select('ca_login_url, ca_username, ca_password, is_active')
      .eq('property_id', this.propertyId)
      .eq('is_active', true)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as ScraperCredentialsRow;
    return {
      username: row.ca_username,
      password: row.ca_password,
      loginUrl: row.ca_login_url,
    };
  }

  private async loadStorageState(): Promise<Record<string, unknown> | null> {
    const { data, error } = await supabase
      .from('scraper_session')
      .select('state, refreshed_at')
      .eq('property_id', this.propertyId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as ScraperSessionRow;
    return row.state;
  }

  private async saveStorageState(state: Record<string, unknown>): Promise<void> {
    const { error } = await supabase
      .from('scraper_session')
      .upsert(
        {
          property_id: this.propertyId,
          state,
          refreshed_at: new Date().toISOString(),
        },
        { onConflict: 'property_id' },
      );
    if (error) {
      log.warn('session-driver: saveStorageState failed', {
        propertyId: this.propertyId,
        err: error.message,
      });
    }
  }

  /**
   * Ordered-fallback click. Splits a comma-separated selector list and
   * tries each in order with progressively-escalated strategies (plain
   * → force → JS-direct). Closes the bug where CSS unions like
   * `a#greenButton, input[type="submit"]` let Playwright pick the first
   * DOM match — possibly the wrong element (e.g., a "Remember me"
   * toggle adjacent to the actual Login button). Mirrors the
   * clickFirstMatching pattern from scraper.js.
   */
  private async clickFirstMatching(rawSelector: string): Promise<void> {
    if (!this.page) throw new Error('clickFirstMatching: no page');
    // Naive split on `,` — selectors containing `,` inside `:has-text("a,b")`
    // would be mis-split, but Playwright's :has-text rarely uses commas
    // in its arg in practice. Good enough for login button lists.
    const selectors = rawSelector
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const errors: string[] = [];
    for (const selector of selectors) {
      try {
        await this.page.click(selector, { timeout: 5_000 });
        return;
      } catch (err) {
        errors.push(`${selector}: ${(err as Error).message}`);
      }
      try {
        await this.page.click(selector, { timeout: 3_000, force: true });
        return;
      } catch (err) {
        errors.push(`${selector} (force): ${(err as Error).message}`);
      }
    }
    throw new Error(`clickFirstMatching exhausted ${selectors.length} selectors: ${errors.join(' | ')}`);
  }

  // ─── Plan v7 Phase 2c: knowledge hot-reload + mapper auto-enqueue ───

  /**
   * Polled every 60s. Compares loaded `knowledgeFileVersion` against
   * the active version in DB; reloads in place if they differ. Lets
   * mapping-driver's auto-promotion take effect within ~60s instead of
   * waiting for the next 3am nightly restart.
   */
  private async checkKnowledgeReload(): Promise<void> {
    if (this.stopping || !this.running) return;
    try {
      const latest = await loadActive(this.pmsFamily);
      if (!latest) return;
      if (latest.version === this.knowledgeFileVersion) return;
      log.info('session-driver: hot-reloading knowledge file', {
        propertyId: this.propertyId,
        pmsFamily: this.pmsFamily,
        oldVersion: this.knowledgeFileVersion,
        newVersion: latest.version,
      });
      this.knowledgeFile = latest;
      this.knowledgeFileVersion = latest.version;
      // Re-anchor the host guard to the per-hotel login URL (per-hotel >
      // family). Credentials don't change on a knowledge hot-reload, so this
      // must NOT silently revert allowedHost to the family startUrl's host —
      // that would re-break per-hotel subdomains ~60s after every promotion.
      this.allowedHost = this.currentAllowedHost();
      // feature/cua-per-hotel-data (Task 4) — a promoted version may fix (or
      // newly break) which feeds are un-locatable. Reset the incomplete-feed set
      // so a still-incomplete feed re-surfaces (re-logs + re-appears in the
      // heartbeat note) under the new version, and a fixed one stops being
      // flagged. Repopulated on the next poll from the new templates.
      this.loggedIncompleteFeeds.clear();
      // No browser restart needed — next pollOnce uses the new feeds.
    } catch (err) {
      log.warn('session-driver: knowledge hot-reload check failed', {
        propertyId: this.propertyId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Enqueue a mapper.learn_pms_family job when this driver enters
   * paused_no_knowledge_file. Idempotency key is per-PMS-family so
   * 3 hotels onboarding simultaneously on the same brand-new PMS
   * trigger ONE mapping run, not three.
   */
  private async autoEnqueueMapperJob(): Promise<void> {
    const idempotencyKey = `mapper.learn_pms_family:${this.pmsFamily}`;
    const { error } = await supabase.from('workflow_jobs').insert({
      property_id: this.propertyId,
      kind: 'mapper.learn_pms_family',
      payload: { pms_family: this.pmsFamily, property_id: this.propertyId },
      idempotency_key: idempotencyKey,
      // Plan v8 final review B1 — cost-bomb cap. Mapper jobs spend real
      // money ($25-50/run in vision mode). Default workflow_jobs.max_attempts
      // = 3 would silently turn a $25 cost cap into a $75 worst case PER
      // failed job. At 300-hotel onboarding wave with vision mode +
      // mapping failure on, say, 10 of them, that's $750 → $2,250 with
      // retries. Force max_attempts=1: a failed mapper requires admin
      // attention (re-trigger via UI) instead of silent auto-retry.
      max_attempts: 1,
      // status defaults to 'queued' per migration 0201.
      triggered_by: 'session-driver:paused_no_knowledge_file',
    });
    if (error) {
      // Duplicate idempotency_key violation = another hotel on the
      // same family already enqueued the job. That's the desired
      // outcome (one mapper run per family), so log info not warn.
      if (error.message.includes('idempotency')) {
        log.info('session-driver: mapper job already enqueued for this family', {
          pmsFamily: this.pmsFamily, idempotencyKey,
        });
      } else {
        log.warn('session-driver: mapper auto-enqueue failed', {
          propertyId: this.propertyId, err: error.message,
        });
      }
      return;
    }
    log.info('session-driver: mapper job auto-enqueued', {
      propertyId: this.propertyId, pmsFamily: this.pmsFamily, idempotencyKey,
    });
  }

  /**
   * Plan v8 self-repair — the "middle ground" between full re-mapping
   * ($25) and ignoring drift (silent data loss).
   *
   * Tracks consecutive zero-row polls per recipe action. When the
   * threshold trips, fires a single-target re-learn (~$2) via the same
   * mapper.learn_pms_family workflow kind, with payload.seed_actions
   * pre-populated with every action EXCEPT the failing one — so the
   * mapper skips the 12 known-good targets and only re-learns the
   * broken one. A complete result auto-promotes via the existing
   * promotion-gate logic (an INCOMPLETE one parks as a draft for the
   * admin's Promote click — founder-gated, feat/cua-partial-promotion).
   * Live polling picks up new selectors on the next hot-reload tick
   * (~60s) after a promotion.
   *
   * Idempotency key = `mapper.repair:{family}:{propertyId}:{actionKey}` prevents
   * double-enqueue while a repair is in-flight OR after a failed repair (failed
   * = constraint persists = no silent re-trigger; admin must manually retry from
   * the UI). Scoped PER-HOTEL (feature/cua-per-hotel-data): a family-only key let
   * ONE stuck hotel's lingering (failed, max_attempts=1) repair row block every
   * sibling on the same pms_family from ever enqueuing its own — one hotel's
   * broken feed silently froze self-repair fleet-wide. The aggregate
   * daily-mapping spend cap (checkDailyMappingSpend, below) stays the cost
   * backstop against many hotels repairing the same drifted family feed at once.
   */
  private maybeFireSelfRepair(template: TableTemplate, rowCount: number, suppress = false, runFailed = false): void {
    const actionKey = template.sourceActionKey;
    if (!actionKey) return;  // template can't be repaired (no source tag)

    // Phase-2 robustness: never count this poll toward the dead-selector
    // streak when the just-completed poll was logged-out (zeros are a
    // session-expiry artifact, not selector drift) OR when this feed is
    // one that's legitimately empty at small hotels (no work orders /
    // lost-and-found / group blocks today). Either case would otherwise
    // fire a paid mapper repair (~$2) for healthy, expected zeros.
    //
    // feature/cua-column-recovery — the legitimately-empty suppression applies
    // ONLY to "ran ok with zero rows". A run FAILURE (extractor error, dead
    // selector, detail-enrichment failure) on getWorkOrders et al. is drift
    // like anywhere else; swallowing it made a permanently-failing work-order
    // feed invisible forever (plan review P0).
    if (suppress || (!runFailed && isLegitimatelyEmptyFeed(actionKey))) {
      // Don't advance the streak; also don't reset a real drift streak on
      // the suppress case — just skip this poll's contribution.
      if (!runFailed && isLegitimatelyEmptyFeed(actionKey)) this.consecutiveZeroRowsByAction.set(actionKey, 0);
      return;
    }

    if (rowCount > 0) {
      this.consecutiveZeroRowsByAction.set(actionKey, 0);
      return;
    }

    const ZERO_THRESHOLD = 5;  // ~5 polls × 30s = ~2.5 min of nothing
    const count = (this.consecutiveZeroRowsByAction.get(actionKey) ?? 0) + 1;
    this.consecutiveZeroRowsByAction.set(actionKey, count);

    if (count < ZERO_THRESHOLD) return;

    log.warn('session-driver: zero-row threshold tripped — firing self-repair', {
      propertyId: this.propertyId,
      pmsFamily: this.pmsFamily,
      actionKey,
      consecutiveZeroPolls: count,
      tableName: template.tableName,
    });

    // Fire-and-forget — never let a repair-enqueue failure block the
    // next poll tick. Reset the counter after the attempt so we don't
    // hammer the workflow_jobs INSERT every 30s if something's wrong.
    this.consecutiveZeroRowsByAction.set(actionKey, 0);
    // feature/cua-self-heal-reach — QUEUE the self-heal; it runs in drainSelfHeal
    // AFTER this poll's read mutex releases (the re-anchor probe needs that same
    // mutex). Firing it inline here would deadlock-skip every time. `template` is
    // not needed downstream (the recipe action is the source of truth).
    this.pendingSelfHeal.add(actionKey);
    void template;
  }

  /**
   * feature/cua-self-heal-reach — rung-2 (free re-anchor) → rung-1 ($3 re-learn).
   * Fire-and-forget from maybeFireSelfRepair. Re-anchor is ABSTAIN-BY-DEFAULT and
   * fleet-safe (its promotion goes through the SAME sample-verify + golden-fixture
   * gauntlet as a paid re-learn); ANY doubt falls through to enqueueSelfRepairJob.
   */
  private async attemptSelfHeal(actionKey: keyof Recipe['actions']): Promise<void> {
    if (reanchorEnabled()) {
      try {
        const healed = await this.tryReanchor(actionKey);
        if (healed) {
          log.info('session-driver: rung-2 self-heal succeeded — skipped $3 paid re-learn', {
            propertyId: this.propertyId, pmsFamily: this.pmsFamily, actionKey,
          });
          return;
        }
      } catch (err) {
        log.warn('session-driver: rung-2 re-anchor threw — falling through to paid re-learn', {
          propertyId: this.propertyId, actionKey, err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await this.enqueueSelfRepairJob(actionKey);
  }

  /**
   * Attempt a FREE re-anchor of a drifted feed. Returns true ONLY when the feed
   * is confirmed healthy on a fresh extraction (transient) OR a confident
   * single-column re-anchor was minted AND auto-promoted through the fleet-safety
   * gauntlet. Every other outcome returns false (caller pays for the re-learn).
   *
   * The live-page probe runs UNDER THE READ MUTEX (schedule = skip-if-busy), so
   * it never overlaps a poll; a busy mutex ⟹ skip ⟹ abstain → paid path. The DB
   * promotion runs OUTSIDE the mutex (it touches no page).
   */
  private async tryReanchor(actionKey: keyof Recipe['actions']): Promise<boolean> {
    if (!this.page || !this.knowledgeFile || !this.allowedHost) return false;
    const attempts = this.reanchorAttemptsByAction.get(String(actionKey)) ?? 0;
    if (attempts >= MAX_REANCHOR_ATTEMPTS) return false; // bounded — avoid version churn

    const k = this.knowledgeFile.knowledge;
    const recipe: Recipe = {
      schema: 1,
      ...(k.description ? { description: k.description } : {}),
      login: k.login as Recipe['login'],
      actions: k.actions as Recipe['actions'],
      ...(k.hints ? { hints: k.hints as Recipe['hints'] } : {}),
      ...(k.valueTranslations ? { valueTranslations: k.valueTranslations } : {}),
      ...(k.dateFormat ? { dateFormat: k.dateFormat } : {}),
    };
    const action = recipe.actions[actionKey] as ActionRecipe | undefined;
    if (!action || action.parse.mode !== 'table') return false; // re-anchor is table-only

    // READ-mutex (skip-if-busy): the probe is a page read; it must not overlap a
    // poll. schedule() returns null ONLY when the mutex was busy (the probe
    // itself never returns null — it returns an explicit 'abstain'). A busy mutex
    // is a transient scheduling artifact, NOT a re-anchor attempt, so it doesn't
    // burn the per-feed attempt budget; we just yield to the paid path this time.
    const probe = await singleFlight(this.propertyId, REANCHOR_TIMEOUT_MS, (signal) =>
      this.probeReanchor(actionKey, recipe, action, signal),
    );
    if (probe === null) return false; // mutex busy → paid path (no attempt counted)

    // The probe RAN — count it against the bounded budget (abstain included) so a
    // persistently-drifted feed can't re-probe every streak forever.
    this.reanchorAttemptsByAction.set(String(actionKey), attempts + 1);
    if (probe.kind === 'abstain') return false; // ran, decided no → paid path

    if (probe.kind === 'healthy') {
      log.info('session-driver: rung-2 confirmed feed healthy on fresh extraction (transient) — no recipe change', {
        propertyId: this.propertyId, actionKey,
      });
      return true; // skip the paid re-learn; nothing to promote
    }

    // probe.kind === 'reanchor' — mint a candidate (changed selector only) and
    // run it through the SHARED fleet-safety gauntlet (gate → sample-verify →
    // golden-fixture → save → promote). Only an auto-promote actually heals.
    const candidate = applyColumnReanchor(recipe, actionKey, probe.changes);
    // The heal re-extracted + re-certified the feed's required columns with the
    // NEW selectors (probe.freshShape). Refresh the candidate's value-proof state
    // from that REAL evidence: a STALE unprovenRequiredColumns inherited from the
    // active recipe (e.g. a column onboarded empty, since populated) must not block
    // auto-promotion of a now-certified feed; a column STILL not certified must
    // keep the feed in founder review (review P1).
    const healedAction = candidate.actions[actionKey] as ActionRecipe & { unprovenRequiredColumns?: string[] };
    const stillUnproven = requiredColumnsForTarget(actionKey).filter((c) => {
      const v = probe.freshShape.columnVerdicts[c];
      return v !== undefined && v !== 'certified'; // shipping + judged + not certified
    });
    if (stillUnproven.length > 0) healedAction.unprovenRequiredColumns = stillUnproven;
    else delete healedAction.unprovenRequiredColumns;
    const seedActions: Recipe['actions'] = { ...recipe.actions };
    delete seedActions[actionKey];
    const promoted = await promoteRecipeChange({
      pmsFamily: this.pmsFamily,
      recipe: candidate,
      seedActions,
      changedTargets: [String(actionKey)],
      freshShapeFor: (key) => (key === String(actionKey) ? probe.freshShape : null),
      origin: 'reanchor',
      excludePropertyId: this.propertyId,
    });
    if (promoted.activated) {
      log.info('session-driver: rung-2 re-anchor PROMOTED a new recipe version', {
        propertyId: this.propertyId, actionKey, version: promoted.version,
        changes: probe.changes.map((c) => c.column),
      });
      return true; // hot-reload (~60s) picks up the healed recipe
    }
    log.info('session-driver: rung-2 re-anchor parked (not auto-promoted) — falling through to paid re-learn', {
      propertyId: this.propertyId, actionKey, decision: promoted.decision, reason: promoted.reason,
    });
    return false; // abstain-by-default: a non-activating heal yields to the paid path
  }

  /**
   * Live-page probe (runs under the read mutex). Re-navigates the feed, extracts
   * with the CURRENT selectors, and decides — entirely via the PURE reanchor core
   * + the SAME certify/header safety machinery the mapper uses:
   *   - rows present + all required certify          → { healthy } (transient)
   *   - exactly ONE required column drifted, and a UNIQUE header candidate
   *     value-certifies                              → { reanchor, changes, freshShape }
   *   - anything else (rowSelector drift, ≥2 drifted, ambiguous, no headers) → { abstain }
   *
   * Returns an explicit { abstain } (never null) so the caller can tell a real
   * probe-decided abstain from a busy-mutex skip (schedule()'s null).
   */
  private async probeReanchor(
    actionKey: keyof Recipe['actions'],
    recipe: Recipe,
    action: ActionRecipe,
    signal: AbortSignal,
  ): Promise<{ kind: 'healthy' } | { kind: 'abstain' } | { kind: 'reanchor'; changes: ColumnChange[]; freshShape: FreshExtractionShape }> {
    const abstain = (): { kind: 'abstain' } => ({ kind: 'abstain' });
    if (!this.page || !this.allowedHost || signal.aborted) return abstain();
    if (action.parse.mode !== 'table') return abstain();
    const hint = action.parse.hint as TableRowHint;

    // Resolve + re-host the feed's source URL exactly like a normal poll.
    const { templates } = recipeToTableTemplates(recipe, {
      valueTranslations: recipe.valueTranslations,
      dateFormat: recipe.dateFormat,
    });
    const template = templates.find((t) => t.sourceActionKey === actionKey);
    if (!template || template.incomplete || template.sources.length !== 1) return abstain();
    this.rehostFeedUrlsForHotel([template]);
    const sourceUrl = template.sources[0]!.url;
    if (!sourceUrl) return abstain();
    try {
      await safeGoto(this.page, sourceUrl, { allowedHost: this.allowedHost, context: 'reanchor:probe' });
    } catch {
      return abstain(); // can't even load the feed page — abstain (paid path)
    }
    if (signal.aborted) return abstain();

    const columns = hint.columns;
    const learned = { valueTranslations: recipe.valueTranslations, dateFormat: recipe.dateFormat };
    const todayIso = reanchorTodayIso();
    const requiredAll = requiredColumnsForTarget(actionKey);
    const shippingRequired = requiredAll.filter(
      (c) => typeof columns[c] === 'string' && columns[c]!.trim() !== '',
    );

    // Fresh extraction with the CURRENT selectors (+ Chat-6 tiered self-heal).
    const ext = await extractDomRows(this.page, hint.rowSelector, columns, {
      cap: REANCHOR_PROBE_CAP,
      ...(hint.columnsTiered ? { columnsTiered: hint.columnsTiered } : {}),
      ...(hint.rowSelectorTiered ? { rowSelectorTiered: hint.rowSelectorTiered } : {}),
    });
    const rows = ext.rows;
    // rowSelector drift / page wander (zero/near-zero rows) is NOT safely
    // re-anchorable from value evidence we don't have → abstain (paid path).
    if (rows.length < MIN_REANCHOR_ROWS) return abstain();
    if (shippingRequired.length === 0) return abstain();

    const allValues = transposeColumns(rows, Object.keys(columns));

    // CASE A — transient health: fresh extraction certifies → no change needed.
    const health = checkFeedHealth({
      actionKey, requiredColumns: shippingRequired, allValues, allSelectors: columns,
      rowCount: rows.length, learned, todayIso,
    });
    if (health.healthy) return { kind: 'healthy' };

    // CASE B — exactly one drifted required column, re-anchored by header.
    const verdicts = certifyColumns({
      actionKey, columns: shippingRequired, allValues, allSelectors: columns,
      learned, todayIso, hasValueEvidence: true,
    });
    const drifted = shippingRequired.filter((c) => verdicts.get(c)?.verdict !== 'certified');
    if (drifted.length !== 1) return abstain(); // 0 (contradiction) or ≥2 (too risky) → abstain
    const col = drifted[0]!;

    const headers = await readTableHeaders(this.page, hint.rowSelector);
    if (!headers || !headerGateOk(headers)) return abstain(); // can't trust header positions
    const liveHeaders = headers.cells.map((c) => ({ index: c.index, text: c.text }));

    const candidates = buildCandidateSelectors({ oldSelector: columns[col] ?? '', headers: liveHeaders });
    if (candidates.length === 0) return abstain(); // not positionally rebaseable → abstain

    const candidateResults = [];
    for (const cand of candidates) {
      if (signal.aborted) return abstain();
      const cext = await extractDomRows(this.page, hint.rowSelector, { [col]: cand.selector }, { cap: REANCHOR_PROBE_CAP });
      // The candidate uses the SAME rowSelector that yielded `rows`; if its match
      // count differs, the page shifted mid-probe (rowSelector instability) and
      // the per-row values would mis-align with otherValues → drop this candidate
      // rather than risk a mis-aligned (false) certification.
      if (cext.rows.length !== rows.length) continue;
      candidateResults.push({
        headerIndex: cand.headerIndex,
        selector: cand.selector,
        values: cext.rows.map((r) => r[col] ?? ''),
        headerText: cand.headerText,
      });
    }
    if (candidateResults.length === 0) return abstain();
    const otherValues: Record<string, string[]> = {};
    const otherSelectors: Record<string, string> = {};
    for (const [c, v] of Object.entries(allValues)) if (c !== col) otherValues[c] = v;
    for (const [c, s] of Object.entries(columns)) if (c !== col) otherSelectors[c] = s;

    const decision = decideColumnReanchor({
      actionKey, column: col, oldSelector: columns[col] ?? '',
      anchorHeaderText: hint.columnsTiered?.[col]?.roleName?.name,
      candidates: candidateResults, otherValues, otherSelectors, learned, todayIso,
    });
    if (decision.action !== 'reanchor') return abstain(); // abstain → paid path

    const changes: ColumnChange[] = [{ column: col, newSelector: decision.newSelector }];

    // Build the golden-fixture FRESH SHAPE from a re-extraction with the NEW
    // selector — real value evidence (catches a certified→failed regression).
    const healed = applyColumnReanchor(recipe, actionKey, changes);
    const healedAction = healed.actions[actionKey] as ActionRecipe;
    const healedHint = healedAction.parse.mode === 'table' ? healedAction.parse.hint : hint;
    const reext = await extractDomRows(this.page, healedHint.rowSelector, healedHint.columns, { cap: REANCHOR_PROBE_CAP });
    const healedValues = transposeColumns(reext.rows, Object.keys(healedHint.columns));
    const healedVerdicts = certifyColumns({
      actionKey, columns: shippingRequired, allValues: healedValues, allSelectors: healedHint.columns,
      learned, todayIso, hasValueEvidence: reext.rows.length > 0,
    });
    const shipCols = Object.keys(healedHint.columns).filter(
      (c) => typeof healedHint.columns[c] === 'string' && healedHint.columns[c]!.trim() !== '',
    );
    const columnVerdicts: Record<string, FixtureColumnVerdict> = {};
    for (const c of shipCols) {
      const v = healedVerdicts.get(c)?.verdict;
      columnVerdicts[c] = v === 'certified' ? 'certified' : v === 'failed' ? 'failed' : 'uncertain';
    }
    const freshShape: FreshExtractionShape = {
      parseMode: 'table',
      columns: shipCols,
      columnVerdicts,
      hasValueEvidence: reext.rows.length > 0,
      rowCount: reext.rows.length,
    };
    return { kind: 'reanchor', changes, freshShape };
  }

  private async enqueueSelfRepairJob(actionKey: keyof Recipe['actions']): Promise<void> {
    if (!this.knowledgeFile) return;

    // Money-path guard: a self-repair enqueues a paid mapper run (~$2 in
    // vision mode). The per-hotel $5 cap only gates the polling loop's own
    // Claude calls — mapping spend is deliberately excluded from it — so
    // without this check a string of drifting feeds could fire unbounded
    // paid repairs org-wide. Honor the aggregate daily mapping cap here
    // (same gate workflow-runtime/mapping-driver use): if the org is
    // over-cap, skip + log and let the next poll's streak retry once spend
    // resets. Fail-open on a query error (checkDailyMappingSpend already
    // logs + returns over=false) — the per-job cap remains the backstop.
    const mappingSpend = await checkDailyMappingSpend();
    if (mappingSpend.over) {
      log.warn('session-driver: self-repair skipped — daily mapping spend cap reached', {
        actionKey,
        propertyId: this.propertyId,
        pmsFamily: this.pmsFamily,
        spentMicros: mappingSpend.spentMicros,
        capMicros: mappingSpend.capMicros,
      });
      return;
    }

    const allActions = this.knowledgeFile.knowledge.actions as Recipe['actions'];
    if (!allActions || !(actionKey in allActions)) {
      log.warn('session-driver: self-repair skipped — target not in active recipe', {
        actionKey, propertyId: this.propertyId,
      });
      return;
    }
    const seedActions: Recipe['actions'] = { ...allActions };
    delete seedActions[actionKey];

    const idempotencyKey = `mapper.repair:${this.pmsFamily}:${this.propertyId}:${actionKey}`;
    const { error } = await supabase.from('workflow_jobs').insert({
      property_id: this.propertyId,
      kind: 'mapper.learn_pms_family',
      idempotency_key: idempotencyKey,
      // No silent auto-retry — failed repair requires admin to re-trigger
      // (matches the rule we set on the fresh-mapping autoEnqueue path).
      max_attempts: 1,
      triggered_by: `session-driver:auto-repair`,
      payload: {
        pms_family: this.pmsFamily,
        property_id: this.propertyId,
        // Tight cap — single target. $2 → $3 for feature/cua-column-recovery:
        // a repair re-learn may now legitimately spend focused re-asks plus a
        // $0.60-capped detail drill recovering blank required columns.
        cost_cap_micros: 3_000_000,
        // The whole point — seed all other actions so mapper skips them.
        seed_actions: seedActions,
        // Preserve previously-learned value translation across a partial repair
        // so the re-mapped recipe doesn't drop the OTHER feeds' enum vocabulary /
        // learned date order (those targets are skipped, so they aren't re-learned)
        // (Codex review #4).
        seed_value_translations: this.knowledgeFile.knowledge.valueTranslations,
        seed_date_format: this.knowledgeFile.knowledge.dateFormat,
        // For audit + Live Mapping UI to render context.
        repair_target_key: actionKey,
        repaired_from_version: this.knowledgeFile.version,
      },
    });
    if (error) {
      if (error.message.includes('idempotency') || error.code === '23505') {
        // Repair already in-flight OR a failed one is still on the
        // workflow_jobs row. Either way, don't re-fire. Admin's task
        // to retry from the UI when ready.
        log.info('session-driver: self-repair skipped — already enqueued', {
          actionKey, idempotencyKey, propertyId: this.propertyId,
        });
        return;
      }
      log.warn('session-driver: self-repair enqueue failed', {
        actionKey, propertyId: this.propertyId, err: error.message,
      });
      return;
    }
    log.info('session-driver: self-repair enqueued', {
      actionKey, propertyId: this.propertyId, pmsFamily: this.pmsFamily,
    });
  }

  private async closeBrowser(): Promise<void> {
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch {
      // best-effort
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

/**
 * Pick the login URL for one hotel: the per-hotel URL
 * (scraper_credentials.ca_login_url) when present, else the PMS family's
 * shared knowledge-file login.startUrl. Per-hotel wins so cloud PMSes that
 * give each hotel its own subdomain aren't all funnelled to one tenant by
 * the single active knowledge file per pms_family. Empty/whitespace/null
 * per-hotel URLs (e.g. Choice Advantage) fall back to the family startUrl —
 * byte-for-byte the pre-fix behavior. Exported for unit testing.
 *
 * The per-hotel value is normalized (normalizeUrl prepends https:// when the
 * scheme is missing) so a common data-entry input like "hotel-a.opera.com"
 * resolves to the SAME host the allowedHost guard is derived from — no skew
 * between the navigation target and the host guard. The family fallback is
 * returned verbatim (it is always a stored absolute URL) to keep the
 * no-per-hotel-URL path identical to before.
 */
export function resolveLoginUrl(
  perHotelLoginUrl: string | null | undefined,
  familyStartUrl: string,
): string {
  const perHotel = perHotelLoginUrl?.trim();
  return perHotel ? normalizeUrl(perHotel) : familyStartUrl;
}

/**
 * Host for safeGoto's same-site guard, derived from exactly the URL we log in
 * at (so the guard can never skew from the navigation target — both come from
 * resolveLoginUrl). Returns '' when no host can be derived: a malformed URL
 * (new URL throws) or a hostless scheme like mailto:/tel: (host === ''). The
 * caller treats '' as fail-closed (failed_restart) — never a silent wrong-host
 * guard, never a crash. Never throws. Exported for unit testing.
 */
export function resolveAllowedHost(loginUrl: string): string {
  try {
    return new URL(loginUrl).host;
  } catch {
    return '';
  }
}

/**
 * Re-point a recorded login `goto` step at this hotel's login URL. The learner
 * ALWAYS records the initial login navigation as `{ kind: 'goto', url: startUrl }`
 * (mapper.ts:1179), so the family knowledge file bakes in the MAPPER tenant's
 * URL. Replaying that verbatim funnels every hotel on a per-subdomain cloud PMS
 * back to the mapper's tenant — the baked host shares the family registrable
 * domain, so safeGoto's same-site guard passes and the wrong-tenant navigation
 * goes through. Only the goto whose url is the family startUrl is rewritten (to
 * the per-hotel URL); every other recorded goto — intra-login hops, SSO
 * providers, shared-auth subdomains — replays exactly as learned, since blindly
 * re-hosting those could break shared infrastructure. No-op when there is no
 * per-hotel URL. Exported for unit testing.
 */
export function resolveLoginGotoUrl(
  rawUrl: string,
  familyStartUrl: string,
  perHotelLoginUrl: string | null | undefined,
): string {
  if (rawUrl !== familyStartUrl) return rawUrl;
  return resolveLoginUrl(perHotelLoginUrl, familyStartUrl);
}

/**
 * feature/cua-per-hotel-data (Task 1) — re-host a recorded FEED url onto THIS
 * hotel's tenant origin: the data-read analogue of resolveLoginGotoUrl.
 *
 * The mapper records every feed URL on ITS tenant; one active knowledge file per
 * pms_family replays those same URLs for every hotel. So a per-subdomain cloud
 * PMS (OPERA Cloud, Cloudbeds, Mews, RoomKey) logs into its own tenant (the
 * per-hotel login fix) yet still READS the mapper tenant's data — the feed host
 * shares the family's registrable domain, so safeGoto's same-site guard
 * (registrable-domain, NOT exact-host) lets the wrong-tenant read through. This
 * swaps the ORIGIN (scheme + host[:port]) of feed URLs that live on the LEARNED
 * tenant for the per-hotel origin, leaving everything after the origin verbatim:
 *
 *   - No per-hotel URL (e.g. Choice Advantage) → returned verbatim — byte-for-
 *     byte the pre-fix behavior (family fallback).
 *   - Per-hotel origin == learned origin → verbatim (no-op). Covers the mapper
 *     tenant itself AND a single-host multi-tenant PMS like Choice Advantage,
 *     where tenancy is by login/session, not by host.
 *   - Feed URL NOT on the learned origin (a cross-host SSO / shared report host)
 *     → verbatim — exactly as resolveLoginGotoUrl leaves non-login gotos alone.
 *   - Otherwise → per-hotel origin + the recorded path/query/hash, unchanged.
 *
 * Pure string surgery on the path tail (the origin is matched by a
 * boundary-anchored regex that stops at the first '/', '?' or '#'), so the
 * {today}/{date}/{placeholder} tokens that ride feed + detail URLs — rendered at
 * navigation time by template-runner / substituteTemplate — survive verbatim. A
 * `new URL(rawUrl).toString()` round-trip would percent-encode '{'/'}' and break
 * them. Never throws; any unparseable input is returned unchanged (and safeGoto
 * stays the navigation guard regardless). Exported for unit testing.
 */
export function rehostFeedUrl(
  rawUrl: string,
  familyStartUrl: string,
  perHotelLoginUrl: string | null | undefined,
): string {
  const perHotel = perHotelLoginUrl?.trim();
  if (!perHotel || !rawUrl) return rawUrl;            // family fallback / nothing to rewrite
  const learned = feedOrigin(familyStartUrl);
  const perHotelO = feedOrigin(normalizeUrl(perHotel));
  const raw = feedOrigin(rawUrl);
  // Any origin unparseable (relative / malformed / no startUrl) → leave unchanged.
  if (!learned || !perHotelO || !raw) return rawUrl;
  // Same tenant already (the mapper tenant itself, or a single-host PMS) → no-op.
  if (learned.origin === perHotelO.origin) return rawUrl;
  // Only re-host feeds on the LEARNED tenant origin; cross-host URLs (SSO,
  // shared report servers) replay exactly as learned.
  if (raw.origin !== learned.origin) return rawUrl;
  // Swap the recorded origin (incl. any userinfo prefix) for the per-hotel
  // origin; the path/query/hash tail is preserved byte-for-byte.
  return perHotelO.origin + rawUrl.slice(raw.prefixLen);
}

/**
 * Parse the ORIGIN of an absolute http(s) URL WITHOUT a `new URL()` round-trip
 * (which would percent-encode the {today}/{date}/{placeholder} tokens feed +
 * detail URLs carry). Returns:
 *   - origin:    canonical scheme://host[:port] (lower-cased, userinfo stripped,
 *                trailing FQDN dot + explicit default port removed) — so
 *                equivalent host forms compare equal AND re-host correctly.
 *   - prefixLen: length of the matched prefix in the INPUT (scheme + any
 *                userinfo + host[:port]) so the caller slices off exactly the
 *                path/query/hash tail (which keeps its original case + tokens).
 * Boundary-anchored (stops at the first '/', '?' or '#') so it can't be tricked
 * into prefix-matching `https://learned.com.evil.com` as `https://learned.com`.
 * Returns null for a relative / malformed / non-http(s) URL — the caller leaves
 * those unchanged (safeGoto stays the navigation guard regardless).
 *
 * Deliberately an EXACT-origin check: navigate.ts's hostsAreSameSite is a
 * registrable-DOMAIN check, which is precisely what must NOT be used here —
 * sibling tenant subdomains share a registrable domain, and that same-site
 * pass-through is the wrong-tenant read this fix closes.
 */
function feedOrigin(url: string): { origin: string; prefixLen: number } | null {
  const m = /^(https?:\/\/)(?:[^/?#@]*@)?([^/?#]+)/i.exec(url);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();        // 'https://' | 'http://'
  let host = m[2]!.toLowerCase();            // host[:port]; userinfo already dropped
  // Canonicalize equivalent host forms so the comparison + re-host are exact and
  // can't be fooled by a trailing FQDN dot or an explicit default port (a hand-
  // crafted recipe URL of `learned.opera.com.` shares the per-hotel registrable
  // domain, so safeGoto's same-site guard would otherwise let the un-rehosted,
  // wrong-tenant read through). Placeholders never appear in the origin, so
  // normalizing here is token-safe.
  host = host.replace(/\.(?=:|$)/, '');                               // trailing '.' (before port or end)
  host = host.replace(scheme === 'https://' ? /:443$/ : /:80$/, '');  // explicit default port
  return { origin: scheme + host, prefixLen: m[0]!.length };
}

function todayInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

function safeUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}

/**
 * Phase-2 robustness (C3): a 'body' or 'html' success selector is NO
 * evidence of a successful login — it matches every page including the
 * login wall. Treat such selectors as weak so logged-out detection never
 * relies on them.
 */
function isWeakSelector(selector: string): boolean {
  const s = selector.trim().toLowerCase();
  return s === 'body' || s === 'html';
}

/**
 * Phase-2 robustness (fix 2): feeds that are routinely empty at small
 * limited-service hotels. Zero rows here is the NORMAL state, not selector
 * drift, so they must never count toward the paid self-repair streak.
 */
const LEGITIMATELY_EMPTY_FEEDS = new Set<keyof Recipe['actions']>([
  'getWorkOrders',
  'getLostAndFound',
  'getGroupsAndBlocks',
]);
function isLegitimatelyEmptyFeed(actionKey: keyof Recipe['actions']): boolean {
  return LEGITIMATELY_EMPTY_FEEDS.has(actionKey);
}

// Reference env to satisfy linters about the import being used.
void env;
