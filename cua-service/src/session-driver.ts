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
import { checkBudget, markResumed } from './cost-cap.js';
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
import { safeGoto } from './browser-utils/navigate.js';
import type { Recipe, ScraperCredentialsRow, TableTemplate } from './types.js';

const VIEWPORT = { width: 1280, height: 800 };
const POLL_INTERVAL_MS = 30_000;
const POLL_JITTER_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const READ_TIMEOUT_MS = 120_000;
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

    // Recipe.actions → TableTemplate[]. Each template knows its target
    // pms_* table, write strategy, sources, fields, parsers.
    const recipe: Recipe = {
      schema: 1,
      login: this.knowledgeFile.knowledge.login as Recipe['login'],
      actions,
    };
    const adaptResult = recipeToTableTemplates(recipe);
    if (adaptResult.skipped.length > 0) {
      log.warn('session-driver: some actions skipped by adapter', {
        propertyId: this.propertyId,
        skipped: adaptResult.skipped,
      });
    }

    const results: Array<{ table: string; ok: boolean; rowsWritten?: number; reason?: string }> = [];

    // Process in stable order: dashboard / in-house snapshot first
    // (cheapest, most-displayed), then list pages, then drill-down.
    const sorted = [...adaptResult.templates].sort((a, b) => priorityOf(a.tableName) - priorityOf(b.tableName));

    for (const template of sorted) {
      if (signal.aborted) break;
      try {
        const runResult = template.sources.length > 1
          ? await runMultiSourceTemplate({
              page: this.page,
              template,
              allowedHost: this.allowedHost,
              signal,
            })
          : await runSingleSourceTemplate({
              page: this.page,
              template,
              allowedHost: this.allowedHost,
              signal,
            });

        if (!runResult.ok) {
          results.push({ table: template.tableName, ok: false, reason: runResult.reason });
          // Plan v8 self-repair — a run failure (broken navigation,
          // bad selector) counts toward consecutive-zero just like a
          // 0-row extraction. Both mean "selector probably drifted."
          this.maybeFireSelfRepair(template, 0);
          continue;
        }

        const saveResult = await saveGenericTable(
          this.propertyId,
          template.tableName,
          runResult.rows,
        );
        results.push({
          table: template.tableName,
          ok: saveResult.ok,
          rowsWritten: saveResult.inserted + saveResult.updated + saveResult.autoResolved,
          reason: saveResult.errors[0],
        });
        // Plan v8 self-repair — track zero-row streak; trigger repair
        // when threshold tripped. Non-zero row count resets the streak.
        this.maybeFireSelfRepair(template, runResult.rows.length);
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
      this.allowedHost = new URL(latest.knowledge.login.startUrl).host;
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
   * broken one. New recipe version auto-promotes via the existing
   * promotion-gate logic. Live polling picks up the new selectors on
   * the next hot-reload tick (~60s).
   *
   * Idempotency key = `mapper.repair:{family}:{actionKey}` prevents
   * double-enqueue while a repair is in-flight OR after a failed
   * repair (failed = constraint persists = no silent re-trigger; admin
   * must manually retry from the UI).
   */
  private maybeFireSelfRepair(template: TableTemplate, rowCount: number): void {
    const actionKey = template.sourceActionKey;
    if (!actionKey) return;  // template can't be repaired (no source tag)

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
    void this.enqueueSelfRepairJob(actionKey);
  }

  private async enqueueSelfRepairJob(actionKey: keyof Recipe['actions']): Promise<void> {
    if (!this.knowledgeFile) return;
    const allActions = this.knowledgeFile.knowledge.actions as Recipe['actions'];
    if (!allActions || !(actionKey in allActions)) {
      log.warn('session-driver: self-repair skipped — target not in active recipe', {
        actionKey, propertyId: this.propertyId,
      });
      return;
    }
    const seedActions: Recipe['actions'] = { ...allActions };
    delete seedActions[actionKey];

    const idempotencyKey = `mapper.repair:${this.pmsFamily}:${actionKey}`;
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
        // Repairs always vision — DOM would re-fail the same way.
        mapper_mode: 'vision',
        // Tight cap — single target.
        cost_cap_micros: 2_000_000,
        // The whole point — seed all other actions so mapper skips them.
        seed_actions: seedActions,
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
