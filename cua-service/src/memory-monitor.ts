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

import { readFileSync } from 'node:fs';
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

/**
 * The nightly-restart dedup marker (lastNightlyRestartDate) lives in memory and
 * is LOST when the process restarts. If a nightly restart reboots the process
 * while the clock is still inside the 03:00–03:59 window, the fresh process
 * would find lastNightlyRestartDate=null, see the window is still open, and
 * immediately request ANOTHER restart → a restart loop until 04:00. Requiring
 * the process to have been up at least as long as the 1-hour window guarantees
 * a just-rebooted process can't re-trigger until the window has closed.
 */
const MIN_UPTIME_FOR_NIGHTLY_RESTART_S = 60 * 60;

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
  /** Whole-machine memory used — cgroup memory.current on Fly (counts the
   *  out-of-process Chromium), Node RSS as a local-dev fallback. This is the
   *  value utilizationPct is computed from. */
  machineUsedMb: number;
  /** Total available memory on this machine (cgroup memory.max or FLY_VM_MEMORY_MB). */
  machineLimitMb: number | null;
  /** machineUsedMb / machineLimitMb as a pct (or null when limit unknown). */
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
        `Memory pressure: ${sample.machineUsedMb.toFixed(0)}MB / ${sample.machineLimitMb}MB = ${sample.utilizationPct.toFixed(1)}% >= threshold ${DEFAULT_RESTART_THRESHOLD_PCT}% (Node RSS ${sample.rssMb.toFixed(0)}MB)`,
      );
      return;
    }

    // Nightly restart check. The uptime gate breaks the restart loop that
    // would otherwise occur when a nightly restart reboots the process inside
    // the same 03:00 window (the in-memory dedup marker is lost on restart).
    const todayLocal = todayInTimezone(NIGHTLY_RESTART_TIMEZONE);
    if (
      isNightlyRestartWindow() &&
      state.lastNightlyRestartDate !== todayLocal &&
      process.uptime() >= MIN_UPTIME_FOR_NIGHTLY_RESTART_S
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
  const rssMb = m.rss / 1024 / 1024;

  // process.memoryUsage().rss is the NODE process only. Playwright launches
  // Chromium as SEPARATE OS processes, and a Chromium leak — the exact failure
  // this monitor exists to catch — never moves Node's RSS, so an RSS-based
  // threshold is blind to it. The cgroup accounts every process on the machine
  // and is what Fly's OOM killer enforces, so measure from cgroup memory.current
  // when available, falling back to Node RSS only in local dev (no cgroup v2).
  const cg = readCgroupMemoryMb();
  const usedMb = cg ? cg.currentMb : rssMb;
  const limitMb = cg?.limitMb ?? machineMemoryLimitMb();
  const utilizationPct = limitMb !== null ? (usedMb / limitMb) * 100 : null;
  return {
    capturedAt: new Date(),
    heapUsedMb: m.heapUsed / 1024 / 1024,
    heapTotalMb: m.heapTotal / 1024 / 1024,
    rssMb,
    externalMb: m.external / 1024 / 1024,
    machineUsedMb: usedMb,
    machineLimitMb: limitMb,
    utilizationPct,
  };
}

/**
 * Whole-machine memory usage from the Linux cgroup v2 controller. memory.current
 * is the bytes charged to this machine's cgroup across ALL processes (Node +
 * every Chromium/renderer process) and is exactly what the OOM killer accounts
 * against memory.max. Returns null off-Linux / when the cgroup files aren't
 * readable (e.g. macOS local dev), so the caller falls back to Node RSS.
 */
function readCgroupMemoryMb(): { currentMb: number; limitMb: number | null } | null {
  try {
    const current = Number.parseInt(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(), 10);
    if (!Number.isFinite(current)) return null;
    let limitMb: number | null = null;
    try {
      const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      const parsed = Number.parseInt(raw, 10);
      // memory.max is the literal string "max" when the cgroup is unbounded.
      if (raw !== 'max' && Number.isFinite(parsed)) limitMb = parsed / 1024 / 1024;
    } catch {
      /* memory.max unreadable → caller falls back to the FLY_VM_MEMORY_MB env limit */
    }
    return { currentMb: current / 1024 / 1024, limitMb };
  } catch {
    return null; // not on cgroup v2 (local dev) — fall back to RSS
  }
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
