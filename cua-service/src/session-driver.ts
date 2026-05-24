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
import { loadActive, type LoadedKnowledgeFile, type FeedSpec } from './knowledge-file.js';
import { checkBudget, markResumed } from './cost-cap.js';
import { schedule as singleFlight, getMetrics as getSingleFlightMetrics } from './single-flight.js';
import { shouldRestart } from './memory-monitor.js';
import {
  clickTrustDeviceIfPresent,
  detectMfaPrompt,
  pauseForMfa,
} from './mfa-handler.js';
import { extractDomTable } from './extractors/dom-table.js';
import { extractFetchApi } from './extractors/fetch-api.js';
import { extractDomInline } from './extractors/dom-inline.js';
import { extractCsvDownload } from './extractors/csv-download.js';
import {
  normalizeCaCsv,
  normalizeCaHkCenter,
  normalizeCaWorkOrders,
  normalizeCaDashboardCounts,
  type CaDashboardPage,
} from './extractors/choice-advantage.js';
import {
  saveReservations,
  saveRoomStatuses,
  saveHousekeepingAssignments,
  saveWorkOrders,
  saveInHouseSnapshot,
} from './persistence/new-schema-writer.js';
// Plan v7 Phase 2b — shadow-mode parallel write through the new
// template-driven path. When CUA_SHADOW_MODE=true, certain feeds ALSO
// write to pms_*_shadow tables; the daily parity-diff cron compares
// the two. Once a table passes 7 days of zero-diff, its CUA_USE_GENERIC_
// WRITER_<table>=true flag flips and the legacy normalizer path retires
// for that table.
import { saveGenericTable } from './persistence/generic-table-writer.js';
import { runMultiSourceTemplate } from './extractors/multi-source-runner.js';
import { dashboardCountsTemplateFromLegacy } from './recipe-adapter.js';
import { safeGoto } from './browser-utils/navigate.js';
import type { ScraperCredentialsRow } from './types.js';

const VIEWPORT = { width: 1280, height: 800 };
const POLL_INTERVAL_MS = 30_000;
const POLL_JITTER_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const READ_TIMEOUT_MS = 120_000;

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

interface FeedRunResult {
  feed: string;
  ok: boolean;
  reason?: string;
  rowsWritten?: number;
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
  private credentials: { username: string; password: string; loginUrl: string } | null = null;
  private allowedHost: string | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  private heartbeatHandle: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  /** When > 0, browser is locked by workflow-runtime; reads pause. */
  private browserLockDepth = 0;

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
      // Graceful pause — distinct from failed_restart (which is the
      // dead-letter signal for transient crashes). paused_no_knowledge_file
      // is admin-resolvable: someone needs to run the mapper or hand-seed
      // a knowledge file for this PMS. Funnel UI surfaces this in the
      // "Needs help" stage with a clear CTA. Don't bump restart_count —
      // not a transient failure, no point hitting the dead-letter cap.
      log.warn('session-driver: no active knowledge file — pausing', {
        propertyId: this.propertyId,
        pmsFamily: this.pmsFamily,
      });
      await this.updateStatus({
        status: 'paused_no_knowledge_file',
        paused_reason: `No active knowledge file for ${this.pmsFamily}. Run the mapper or hand-seed a knowledge file to onboard this PMS.`,
      });
      this.running = false;
      return;
    }

    this.allowedHost = new URL(this.knowledgeFile.knowledge.login.startUrl).host;

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

  private async ensureLoggedIn(): Promise<boolean> {
    if (!this.page || !this.knowledgeFile || !this.credentials || !this.allowedHost) {
      throw new Error('ensureLoggedIn precondition failed');
    }
    const { login } = this.knowledgeFile.knowledge;

    // Probe: navigate to start URL. If we land on a login form, we're not logged in.
    try {
      await safeGoto(this.page, login.startUrl, {
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
      await safeGoto(this.page, login.startUrl, {
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
        loginUrl: login.startUrl,
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
        loginUrl: login.startUrl,
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
        await safeGoto(this.page, step.url as string, {
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
  }

  private async runAllFeeds(signal: AbortSignal): Promise<void> {
    if (!this.knowledgeFile || !this.page) return;
    const feeds = this.knowledgeFile.knowledge.feeds;
    const results: FeedRunResult[] = [];
    const today = todayInTimezone('America/Chicago');

    // CA-specific dispatch for Phase 1. When more PMS families come,
    // dispatch on this.pmsFamily and call the right normalizer.
    const isCa = this.pmsFamily === 'choice_advantage';

    // Process feeds in a stable order so dashboard updates feel monotonic.
    const order: string[] = [
      'dashboard_counts',
      'arrivals_departures',
      'room_status',
      'housekeeping',
      'work_orders',
    ];

    for (const feedName of order) {
      if (signal.aborted) break;
      const feed = feeds[feedName];
      if (!feed) continue;
      try {
        const r = await this.runFeed(feedName, feed, today, isCa, signal);
        results.push(r);
      } catch (err) {
        log.warn('session-driver: feed run threw', {
          propertyId: this.propertyId,
          feed: feedName,
          err: err instanceof Error ? err.message : String(err),
        });
        results.push({ feed: feedName, ok: false, reason: (err as Error).message });
      }
      // Plan v7 — parallel shadow write during the parity window.
      // Fire-and-forget; doesn't block the polling loop or fail the feed.
      void this.shadowWriteFeed(feedName, feed, signal);
    }

    log.info('session-driver: poll complete', {
      propertyId: this.propertyId,
      results,
    });
  }

  private async runFeed(
    feedName: string,
    feed: FeedSpec,
    today: string,
    isCa: boolean,
    signal: AbortSignal,
  ): Promise<FeedRunResult> {
    if (!this.page || !this.allowedHost) {
      return { feed: feedName, ok: false, reason: 'no page or allowedHost' };
    }
    switch (feed.mode) {
      case 'csv_download': {
        const result = await extractCsvDownload({
          page: this.page,
          feedSpec: feed,
          allowedHost: this.allowedHost,
          signal,
        });
        if (!result.ok) return { feed: feedName, ok: false, reason: result.reason };
        if (!isCa) return { feed: feedName, ok: true };
        const normalized = normalizeCaCsv(result.rows, { today });
        const r = await saveReservations(this.propertyId, normalized.reservations);
        const h = await saveHousekeepingAssignments(this.propertyId, normalized.housekeeping);
        const s = await saveRoomStatuses(this.propertyId, normalized.roomStatuses);
        return {
          feed: feedName,
          ok: r.ok && h.ok && s.ok,
          rowsWritten: r.inserted + h.upserted + s.statusChanges,
        };
      }
      case 'dom_table': {
        const result = await extractDomTable({
          page: this.page,
          feedSpec: feed,
          allowedHost: this.allowedHost,
          signal,
        });
        if (!result.ok) return { feed: feedName, ok: false, reason: result.reason };
        if (!isCa) return { feed: feedName, ok: true };
        if (feedName === 'room_status' || feedName === 'housekeeping') {
          // dom-table returns Record<string,string>[]; normalizeCaHkCenter
          // declares the `number` field required but tolerates absence at
          // runtime — accept the type cast.
          const normalized = normalizeCaHkCenter(
            result.rows as unknown as Parameters<typeof normalizeCaHkCenter>[0],
            { today },
          );
          const s = await saveRoomStatuses(this.propertyId, normalized.roomStatuses);
          const h = await saveHousekeepingAssignments(this.propertyId, normalized.housekeeping);
          return {
            feed: feedName,
            ok: s.ok && h.ok,
            rowsWritten: s.statusChanges + h.upserted,
          };
        }
        return { feed: feedName, ok: true };
      }
      case 'fetch_api': {
        const result = await extractFetchApi({ page: this.page, feedSpec: feed, signal });
        if (!result.ok) return { feed: feedName, ok: false, reason: result.reason };
        if (!isCa) return { feed: feedName, ok: true };
        if (feedName === 'work_orders') {
          const normalized = normalizeCaWorkOrders(result.data, { oooOnly: true });
          const w = await saveWorkOrders(this.propertyId, normalized);
          return {
            feed: feedName,
            ok: w.ok,
            rowsWritten: w.inserted + w.updated + w.reopened,
          };
        }
        return { feed: feedName, ok: true };
      }
      case 'dom_inline': {
        // Dashboard counts: special-cased CA flow with 3 URLs.
        if (isCa && feedName === 'dashboard_counts') {
          return this.runCaDashboardCounts(feed, signal);
        }
        const result = await extractDomInline({
          page: this.page,
          feedSpec: feed,
          allowedHost: this.allowedHost,
          signal,
        });
        return { feed: feedName, ok: result.ok, reason: result.reason };
      }
    }
  }

  /**
   * Plan v7 Phase 2b — fire-and-forget shadow write through the new
   * template-driven path. Runs in parallel with the legacy path during
   * the parity window. Failures are logged but don't fail the feed.
   *
   * Today: handles dashboard_counts (the multi-source case). Extend to
   * other feeds as the parity gate qualifies them.
   */
  private async shadowWriteFeed(feedName: string, feed: FeedSpec, signal: AbortSignal): Promise<void> {
    if (!env.CUA_SHADOW_MODE) return;
    if (!this.page || !this.allowedHost) return;
    try {
      if (feedName === 'dashboard_counts') {
        const template = dashboardCountsTemplateFromLegacy(feed as Parameters<typeof dashboardCountsTemplateFromLegacy>[0]);
        if (!template) return;
        const result = await runMultiSourceTemplate({
          page: this.page,
          template,
          allowedHost: this.allowedHost,
          signal,
        });
        if (!result.ok) {
          log.warn('shadow write: template runner failed', {
            propertyId: this.propertyId, feedName, reason: result.reason,
          });
          return;
        }
        await saveGenericTable(this.propertyId, template.tableName, result.rows, { shadowMode: true });
      }
      // Other feeds (arrivals_departures, room_status, housekeeping,
      // work_orders) will be added here as the parity gate progresses.
      // Each needs its own knowledgeFeedToTemplate helper in
      // recipe-adapter.ts.
    } catch (err) {
      log.warn('shadow write: threw', {
        propertyId: this.propertyId, feedName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runCaDashboardCounts(
    feed: FeedSpec,
    signal: AbortSignal,
  ): Promise<FeedRunResult> {
    if (!this.page || !this.allowedHost) {
      return { feed: 'dashboard_counts', ok: false, reason: 'no page' };
    }
    // Feed spec for CA dashboard has extra.pages = { inHouse: url, arrivals: url, departures: url }.
    const pages = (feed.extra?.pages as Record<string, string> | undefined) ?? {};
    if (!pages.inHouse || !pages.arrivals || !pages.departures) {
      return {
        feed: 'dashboard_counts',
        ok: false,
        reason: 'feedSpec.extra.pages missing inHouse/arrivals/departures URLs',
      };
    }
    const fields = feed.columns ?? { roomCount: 'label:has-text("Room Count:") + * .CHI_Data' };
    const fetchPage = async (url: string): Promise<CaDashboardPage> => {
      const r = await extractDomInline({
        page: this.page!,
        feedSpec: { mode: 'dom_inline', url, columns: fields },
        allowedHost: this.allowedHost!,
        signal,
      });
      if (!r.ok) return { roomCount: null };
      return {
        roomCount: r.data.roomCount ?? null,
        guestCount: r.data.guestCount ?? null,
      };
    };

    const [inHouse, arrivals, departures] = await Promise.all([
      fetchPage(pages.inHouse),
      fetchPage(pages.arrivals),
      fetchPage(pages.departures),
    ]);

    if (signal.aborted) return { feed: 'dashboard_counts', ok: false, reason: 'aborted' };

    const snapshot = normalizeCaDashboardCounts({ inHouse, arrivals, departures });
    const result = await saveInHouseSnapshot(this.propertyId, snapshot);
    return { feed: 'dashboard_counts', ok: result.ok, reason: result.message };
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
        notes: `polling: completed=${metrics.completed} skipped=${metrics.skipped} timedOut=${metrics.timedOut}`,
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

// Reference env to satisfy linters about the import being used.
void env;
