/**
 * Memory pressure monitor + auto-restart.
 *
 * Plan v4 architecture decision #2 (per Codex's adversarial finding +
 * my own senior-engineer pass): Playwright + Chromium running 24/7 in a
 * single Node process is notoriously prone to memory leaks. Without
 * intervention, the worker will OOM within 2-4 days.
 *
 * This module is the safety net:
 *   - Polls process memory every 30 sec.
 *   - When heap or RSS exceeds the configured threshold (default 80%
 *     of the Fly machine's memory limit), trigger a graceful restart.
 *   - Scheduled nightly restart at 03:00 local even when memory is fine
 *     — preventive maintenance against slow leaks that don't trigger
 *     the pressure threshold.
 *
 * Restart strategy:
 *   - Set a flag → next time the session-supervisor finishes its
 *     current tick, exit with code 0.
 *   - Fly auto-restarts the machine. Session storageState is in
 *     Supabase so re-login isn't required.
 *
 * Why not just process.exit() immediately: an abrupt exit mid-tick can
 * leave the browser in a weird state, or kill a workflow in progress.
 * Cooperative shutdown via the supervisor is safer.
 */

import { log } from './log.js';
import { env } from './env.js';

/** RAM utilization threshold (% of available) above which we restart. */
const DEFAULT_RESTART_THRESHOLD_PCT = 80;

/** Poll interval for memory checks. */
const POLL_INTERVAL_MS = 30_000;

/** Hour of day (local time) for scheduled nightly restart. */
const NIGHTLY_RESTART_HOUR = 3;

/** Timezone used for nightly restart scheduling. */
const NIGHTLY_RESTART_TIMEZONE = 'America/Chicago';

interface MonitorState {
  /** Set by the monitor when restart is requested; checked by supervisor. */
  restartRequested: boolean;
  /** Why we requested restart, for logging. */
  reason: string | null;
  /** Most recent memory sample. */
  lastSample: MemorySample | null;
  /** Last time a nightly restart was triggered (so we don't loop). */
  lastNightlyRestartDate: string | null;
}

export interface MemorySample {
  capturedAt: Date;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  externalMb: number;
  /** Total available memory on this machine (Fly VM_MEMORY_MB env var). */
  machineLimitMb: number | null;
  /** RSS / machineLimitMb as a pct (or null when limit unknown). */
  utilizationPct: number | null;
}

const state: MonitorState = {
  restartRequested: false,
  reason: null,
  lastSample: null,
  lastNightlyRestartDate: null,
};

let pollHandle: NodeJS.Timeout | null = null;

/**
 * Start the monitor. Idempotent: a second call is a no-op.
 */
export function start(): void {
  if (pollHandle) return;
  log.info('memory-monitor: starting', {
    pollIntervalMs: POLL_INTERVAL_MS,
    thresholdPct: DEFAULT_RESTART_THRESHOLD_PCT,
    nightlyRestartHourLocal: NIGHTLY_RESTART_HOUR,
  });
  pollHandle = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // Trigger an immediate tick so the first sample appears in metrics
  // without waiting POLL_INTERVAL_MS.
  void tick();
}

/**
 * Stop the monitor. Called during graceful shutdown.
 */
export function stop(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

/**
 * Check if a restart has been requested. Session-supervisor calls this
 * after each tick; when true, it should finish current work + exit(0).
 */
export function shouldRestart(): { restart: boolean; reason: string | null } {
  return {
    restart: state.restartRequested,
    reason: state.reason,
  };
}

/**
 * Most recent memory sample for heartbeat / diagnostics.
 */
export function getLastSample(): MemorySample | null {
  return state.lastSample;
}

/**
 * Internal: poll memory + check pressure + check nightly window.
 */
async function tick(): Promise<void> {
  try {
    const sample = sample_memory();
    state.lastSample = sample;

    // Memory pressure check.
    if (
      sample.utilizationPct !== null &&
      sample.utilizationPct >= DEFAULT_RESTART_THRESHOLD_PCT
    ) {
      requestRestart(
        `Memory pressure: RSS ${sample.rssMb.toFixed(0)}MB / ${sample.machineLimitMb}MB = ${sample.utilizationPct.toFixed(1)}% >= threshold ${DEFAULT_RESTART_THRESHOLD_PCT}%`,
      );
      return;
    }

    // Nightly restart check.
    const todayLocal = todayInTimezone(NIGHTLY_RESTART_TIMEZONE);
    if (
      isNightlyRestartWindow() &&
      state.lastNightlyRestartDate !== todayLocal
    ) {
      state.lastNightlyRestartDate = todayLocal;
      requestRestart(`Nightly preventive restart (${todayLocal} ${NIGHTLY_RESTART_HOUR}:00 ${NIGHTLY_RESTART_TIMEZONE})`);
    }
  } catch (err) {
    log.warn('memory-monitor: tick failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function sample_memory(): MemorySample {
  const m = process.memoryUsage();
  const limitMb = machineMemoryLimitMb();
  const rssMb = m.rss / 1024 / 1024;
  const utilizationPct = limitMb !== null ? (rssMb / limitMb) * 100 : null;
  return {
    capturedAt: new Date(),
    heapUsedMb: m.heapUsed / 1024 / 1024,
    heapTotalMb: m.heapTotal / 1024 / 1024,
    rssMb,
    externalMb: m.external / 1024 / 1024,
    machineLimitMb: limitMb,
    utilizationPct,
  };
}

/**
 * Fly.io injects FLY_VM_MEMORY_MB on every machine. Fall back to
 * VM_MEMORY_MB / FLY_MEMORY_MB (older aliases). Returns null on macOS
 * local dev where none is set.
 */
function machineMemoryLimitMb(): number | null {
  return env.FLY_VM_MEMORY_MB ?? env.VM_MEMORY_MB ?? env.FLY_MEMORY_MB ?? null;
}

function requestRestart(reason: string): void {
  if (state.restartRequested) return; // already requested, don't override
  state.restartRequested = true;
  state.reason = reason;
  log.warn('memory-monitor: restart requested', { reason });
}

function isNightlyRestartWindow(): boolean {
  const localHourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: NIGHTLY_RESTART_TIMEZONE,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  const localHour = Number.parseInt(localHourStr.replace(/[^0-9]/g, ''), 10);
  return localHour === NIGHTLY_RESTART_HOUR;
}

function todayInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
