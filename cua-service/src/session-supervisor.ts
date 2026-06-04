/**
 * Session supervisor — boots and watches per-hotel session drivers.
 *
 * Plan v4 architecture: at scale, one Fly machine hosts ONE hotel
 * (one BrowserContext) for clean isolation. But the supervisor model
 * lets us also run multi-tenant — useful for local dev, and as the
 * code path if/when we decide to pool at scale.
 *
 * Supervisor responsibilities:
 *   - On boot: query property_sessions for all hotels whose status is
 *     NOT 'stopped'. Start a SessionDriver for each. Persist a map
 *     property_id -> driver.
 *   - Periodically (every 30 sec) reconcile: pick up newly-enabled
 *     hotels, stop drivers for hotels that were marked 'stopped'.
 *   - Watch driver health: if a driver exits unexpectedly, increment
 *     restart_count and respawn (up to a limit, then mark
 *     failed_restart and stop).
 *   - On SIGTERM: stop all drivers gracefully (each saves its
 *     storageState before exit).
 *
 * In a single-tenant deploy (one machine = one hotel), there's exactly
 * one driver and the reconcile loop is mostly idle.
 */

import { supabase } from './supabase.js';
import { log, makeWorkerId } from './log.js';
import { SessionDriver } from './session-driver.js';
import { start as startMemoryMonitor, stop as stopMemoryMonitor } from './memory-monitor.js';

const RECONCILE_INTERVAL_MS = 30_000;
const MAX_RESTARTS_PER_HOUR = 5;
const RESTART_DECAY_MS = 60 * 60 * 1000; // 1h — restart_count window resets after this

interface SessionRow {
  property_id: string;
  pms_family: string;
  status: string;
  restart_count: number;
}

export class SessionSupervisor {
  private drivers = new Map<string, SessionDriver>();
  /**
   * In-memory timestamp (ms) of the last restart bump per property_id.
   * Used to give MAX_RESTARTS_PER_HOUR a genuine per-hour window: if the
   * prior bump was over an hour ago, restart_count is reset to 0 before
   * the next increment so a transient first-login failure can't climb to
   * the ceiling and wedge the hotel forever. Kept in memory (not a DB
   * column) per the hardening spec.
   */
  private lastRestartAt = new Map<string, number>();
  private readonly workerMachineId: string;
  private reconcileHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor() {
    this.workerMachineId = makeWorkerId();
  }

  /** Start the supervisor — boot drivers + start reconcile loop + memory monitor. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info('session-supervisor: starting', { workerMachineId: this.workerMachineId });

    startMemoryMonitor();
    await this.reconcileOnce();

    this.reconcileHandle = setInterval(() => {
      void this.reconcileOnce();
    }, RECONCILE_INTERVAL_MS);
  }

  /** Graceful stop — stop all drivers, then exit. */
  async stop(): Promise<void> {
    log.info('session-supervisor: stopping all drivers', {
      driverCount: this.drivers.size,
    });
    if (this.reconcileHandle) {
      clearInterval(this.reconcileHandle);
      this.reconcileHandle = null;
    }
    stopMemoryMonitor();
    await Promise.allSettled(Array.from(this.drivers.values()).map((d) => d.stop()));
    this.drivers.clear();
    this.lastRestartAt.clear();
    this.running = false;
  }

  /** Expose a driver by property_id (used by workflow-runtime). */
  getDriver(propertyId: string): SessionDriver | null {
    return this.drivers.get(propertyId) ?? null;
  }

  /** All currently-running drivers. */
  listDrivers(): Array<{ propertyId: string; driver: SessionDriver }> {
    return Array.from(this.drivers.entries()).map(([propertyId, driver]) => ({
      propertyId,
      driver,
    }));
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async reconcileOnce(): Promise<void> {
    try {
      const enabled = await this.loadEnabledSessions();
      const enabledById = new Map(enabled.map((s) => [s.property_id, s]));

      // First: prune dead drivers from the map. A driver whose start()
      // returned without throwing (e.g. login failed, knowledge file
      // missing) leaves this.drivers populated with a non-running
      // instance. Without this prune, the spawn loop below sees
      // `this.drivers.has(propertyId)` and silently skips forever —
      // hotel sits dead with no respawn. Found 2026-05-23 in the
      // Comfort Suites Beaumont login regression test.
      for (const [propertyId, driver] of this.drivers.entries()) {
        if (!driver.isRunning()) {
          log.info('session-supervisor: pruning dead driver from map', { propertyId });
          this.drivers.delete(propertyId);
        }
      }

      // Start drivers for newly-enabled hotels (or hotels whose driver
      // just got pruned).
      for (const session of enabled) {
        if (this.drivers.has(session.property_id)) continue;
        // Per-hour ceiling, with decay: if the last restart bump for this
        // hotel was over an hour ago, the window has elapsed and the
        // persisted restart_count is stale — ignore it (bumpRestartCount
        // will reset it to 0 below). Without this, a hotel that hit the
        // ceiling once would be skipped forever even after the hour passed.
        const last = this.lastRestartAt.get(session.property_id);
        const windowElapsed = last === undefined || Date.now() - last > RESTART_DECAY_MS;
        if (!windowElapsed && session.restart_count >= MAX_RESTARTS_PER_HOUR) {
          // Too many restarts within the last hour — leave it paused for ops.
          log.warn('session-supervisor: skipping start (too many restarts)', {
            propertyId: session.property_id,
            restartCount: session.restart_count,
            limit: MAX_RESTARTS_PER_HOUR,
          });
          // Move the row into the 'failed_restart' dead-letter state so it
          // leaves the runnable set (loadEnabledSessions only selects
          // 'starting'/'alive'/'paused_cost_cap') and surfaces in the admin
          // UI instead of sitting in 'starting' forever. The operator's
          // existing Resume action recovers it (clears status + restart_count).
          await supabase
            .from('property_sessions')
            .update({
              status: 'failed_restart',
              paused_reason: `Exceeded ${MAX_RESTARTS_PER_HOUR} restarts within the last hour. Resume from /admin/property-sessions once the underlying issue is fixed.`,
            })
            .eq('property_id', session.property_id);
          continue;
        }

        // Bump restart_count atomically before spawning so we don't
        // infinitely thrash on a hotel whose login keeps failing.
        // Resets when the driver successfully reaches `alive`.
        await this.bumpRestartCount(session.property_id);

        const driver = new SessionDriver({
          propertyId: session.property_id,
          pmsFamily: session.pms_family,
          workerMachineId: this.workerMachineId,
        });
        this.drivers.set(session.property_id, driver);

        // Fire-and-forget: start runs forever; we don't await it.
        // If it returns/throws, the next reconcile prunes it via the
        // dead-driver check at the top of this method.
        void driver.start().catch((err) => {
          log.error('session-supervisor: driver.start() threw', {
            propertyId: session.property_id,
            err: err instanceof Error ? err : new Error(String(err)),
          });
          this.drivers.delete(session.property_id);
        });
      }

      // Stop drivers for hotels that were intentionally stopped by an
      // admin (status='stopped'). We DON'T treat the absence of a row
      // as "disabled" — only an explicit 'stopped' status.
      for (const [propertyId, driver] of this.drivers.entries()) {
        const session = enabledById.get(propertyId);
        if (!session) {
          log.info('session-supervisor: stopping driver (no enabled row)', { propertyId });
          await driver.stop();
          this.drivers.delete(propertyId);
          // Forget the restart window so a later re-enable starts fresh.
          this.lastRestartAt.delete(propertyId);
        }
      }
    } catch (err) {
      log.warn('session-supervisor: reconcile failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async loadEnabledSessions(): Promise<SessionRow[]> {
    // 'paused_mfa' don't get drivers spawned — that's an intentional
    // pause awaiting a manual resume.
    // 'failed_restart' is the dead-letter state (too many restarts).
    // 'paused_cost_cap' DOES stay in the set (C1): the cost-cap pause is
    // time-based — the driver keeps its slot through the pause window and
    // self-resumes at the midnight budget reset (cost-cap.ts flips the
    // status back to 'alive'). Pruning it here would kill the driver and
    // nothing would ever bring it back.
    const { data, error } = await supabase
      .from('property_sessions')
      .select('property_id, pms_family, status, restart_count')
      .in('status', ['starting', 'alive', 'paused_cost_cap']);
    if (error) {
      log.warn('session-supervisor: loadEnabledSessions failed', { err: error.message });
      return [];
    }
    return (data ?? []) as SessionRow[];
  }

  private async bumpRestartCount(propertyId: string): Promise<void> {
    // Read-modify-write. Two concurrent supervisors would race and one
    // increment would be lost — acceptable for a soft restart counter
    // that's bounded by MAX_RESTARTS_PER_HOUR=5. In Plan v4's
    // one-Fly-machine-per-hotel deployment topology, there's only ever
    // one supervisor managing a given hotel anyway.
    const { data } = await supabase
      .from('property_sessions')
      .select('restart_count')
      .eq('property_id', propertyId)
      .maybeSingle();
    // Per-hour decay: if the previous bump for this hotel was over an
    // hour ago (or we've never bumped it this process), start the window
    // fresh from 0 so MAX_RESTARTS_PER_HOUR is a true per-hour ceiling
    // and a transient first-login failure can't wedge the hotel forever.
    const now = Date.now();
    const last = this.lastRestartAt.get(propertyId);
    const windowElapsed = last === undefined || now - last > RESTART_DECAY_MS;
    const base = windowElapsed ? 0 : ((data?.restart_count as number | undefined) ?? 0);
    this.lastRestartAt.set(propertyId, now);
    await supabase
      .from('property_sessions')
      .update({ restart_count: base + 1 })
      .eq('property_id', propertyId);
  }
}
