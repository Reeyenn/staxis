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

interface SessionRow {
  property_id: string;
  pms_family: string;
  status: string;
  restart_count: number;
}

export class SessionSupervisor {
  private drivers = new Map<string, SessionDriver>();
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

      // Start drivers for newly-enabled hotels.
      for (const session of enabled) {
        if (this.drivers.has(session.property_id)) continue;
        if (session.restart_count >= MAX_RESTARTS_PER_HOUR) {
          // Too many restarts — leave it paused for ops.
          log.warn('session-supervisor: skipping start (too many restarts)', {
            propertyId: session.property_id,
            restartCount: session.restart_count,
            limit: MAX_RESTARTS_PER_HOUR,
          });
          continue;
        }

        const driver = new SessionDriver({
          propertyId: session.property_id,
          pmsFamily: session.pms_family,
          workerMachineId: this.workerMachineId,
        });
        this.drivers.set(session.property_id, driver);

        // Fire-and-forget: start runs forever; we don't await it.
        void driver.start().catch((err) => {
          log.error('session-supervisor: driver.start() threw', {
            propertyId: session.property_id,
            err: err instanceof Error ? err : new Error(String(err)),
          });
          this.drivers.delete(session.property_id);
        });
      }

      // Stop drivers for hotels that were disabled.
      for (const [propertyId, driver] of this.drivers.entries()) {
        if (!enabledById.has(propertyId)) {
          log.info('session-supervisor: stopping driver (hotel disabled)', { propertyId });
          await driver.stop();
          this.drivers.delete(propertyId);
        }
      }
    } catch (err) {
      log.warn('session-supervisor: reconcile failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async loadEnabledSessions(): Promise<SessionRow[]> {
    const { data, error } = await supabase
      .from('property_sessions')
      .select('property_id, pms_family, status, restart_count')
      .neq('status', 'stopped');
    if (error) {
      log.warn('session-supervisor: loadEnabledSessions failed', { err: error.message });
      return [];
    }
    return (data ?? []) as SessionRow[];
  }
}
