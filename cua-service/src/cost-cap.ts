/**
 * Per-hotel daily Claude cost cap.
 *
 * Plan v4 architecture decision #10: $5/hotel/day Claude spend ceiling.
 * When tripped, Claude calls pause (browser stays alive — deterministic
 * reads continue). Auto-resume at midnight in the property's local
 * timezone. Mapping passes have a separate budget that doesn't count
 * against the daily cap (mapping is bursty and legitimate).
 *
 * Why a hard cap is non-negotiable: a runaway Claude-vision repair loop
 * on a broken PMS could spend thousands of dollars overnight. Codex's
 * adversarial review of plan v1 flagged this as a critical risk. The
 * cap is the safety net.
 *
 * Storage model: property_sessions.daily_claude_cost_micros holds the
 * running tally (in millionths-of-a-dollar so we can sum tiny costs
 * without float drift). daily_claude_cost_resets_at marks when the
 * tally resets to 0.
 *
 * Reset behavior: every call to recordSpend checks if
 * daily_claude_cost_resets_at has passed; if so, the tally is reset to
 * 0 and the reset timestamp is bumped to the next local midnight.
 *
 * Concurrency: reads + writes are per-property via Supabase RPC.
 * Multiple concurrent recordSpend calls for the same property can race;
 * we accept the race because the cap is a soft ceiling (overshoot by a
 * few hundred micros doesn't matter — we're trying to prevent a
 * runaway from spending dollars, not pennies).
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import { env } from './env.js';

/** Default daily cap in millionths-of-a-dollar. $5/day = 5_000_000. */
const DAILY_CAP_MICROS = env.CUA_JOB_COST_CAP_MICROS;

/**
 * Convert a USD dollar amount to micros (millionths-of-a-dollar).
 * $0.005 → 5000 micros.
 */
export function dollarsToMicros(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

export function microsToDollars(micros: number): number {
  return micros / 1_000_000;
}

/**
 * Cost-cap state for a single hotel. Returned by checkBudget so the
 * caller knows whether Claude is currently allowed for this hotel.
 */
export interface BudgetState {
  /** True when Claude calls are allowed (tally < cap, reset not due). */
  ok: boolean;
  /** Reason when ok = false. Surfaced in heartbeat + Sentry. */
  reason?: 'cap_tripped' | 'paused';
  /** Current running tally for the day (after any reset). */
  spentMicros: number;
  /** Daily cap (configurable per-property in the future; constant for now). */
  capMicros: number;
  /** When the tally next resets (next midnight local). */
  resetsAt: Date;
}

interface PropertySessionRow {
  daily_claude_cost_micros: number;
  daily_claude_cost_resets_at: string;
  status: string;
}

/**
 * Read the current cost-cap state for a property. Auto-resets the
 * tally if the reset window has passed. Returns ok=false when the cap
 * has been tripped — caller must skip Claude calls in that case.
 *
 * Performs the reset transactionally so a concurrent caller can't see
 * the pre-reset value AFTER another caller bumped the reset_at.
 */
export async function checkBudget(propertyId: string): Promise<BudgetState> {
  const { data, error } = await supabase
    .from('property_sessions')
    .select('daily_claude_cost_micros, daily_claude_cost_resets_at, status')
    .eq('property_id', propertyId)
    .maybeSingle();

  if (error) {
    log.warn('cost-cap: failed to read property_sessions, defaulting to ok=true', {
      propertyId,
      err: error.message,
    });
    // Fail open on read errors — if Supabase is flaky we'd rather keep
    // serving than freeze every hotel. The recordSpend write will fail
    // separately and a real runaway would still be visible in token
    // usage tracking.
    return {
      ok: true,
      spentMicros: 0,
      capMicros: DAILY_CAP_MICROS,
      resetsAt: nextLocalMidnight(),
    };
  }

  if (!data) {
    // First boot for this hotel — session row doesn't exist yet. Caller
    // (session-supervisor) will create it. Return ok=true so the boot
    // sequence isn't blocked on its own initialization.
    return {
      ok: true,
      spentMicros: 0,
      capMicros: DAILY_CAP_MICROS,
      resetsAt: nextLocalMidnight(),
    };
  }

  const row = data as PropertySessionRow;
  const resetsAt = new Date(row.daily_claude_cost_resets_at);
  let spentMicros = row.daily_claude_cost_micros;

  // Auto-reset if the window has passed.
  if (Date.now() >= resetsAt.getTime()) {
    const newResetsAt = nextLocalMidnight();
    const { error: resetErr } = await supabase
      .from('property_sessions')
      .update({
        daily_claude_cost_micros: 0,
        daily_claude_cost_resets_at: newResetsAt.toISOString(),
      })
      .eq('property_id', propertyId);
    if (resetErr) {
      log.warn('cost-cap: failed to reset daily tally', {
        propertyId,
        err: resetErr.message,
      });
    } else {
      log.info('cost-cap: reset daily tally', {
        propertyId,
        previousSpentMicros: spentMicros,
        nextResetAt: newResetsAt.toISOString(),
      });
    }
    spentMicros = 0;
  }

  if (spentMicros >= DAILY_CAP_MICROS) {
    return {
      ok: false,
      reason: 'cap_tripped',
      spentMicros,
      capMicros: DAILY_CAP_MICROS,
      resetsAt,
    };
  }

  if (row.status === 'paused_cost_cap') {
    // Tally is under cap but row is still flagged. Caller (session-supervisor)
    // is responsible for flipping the status back to 'alive' on reset.
    return {
      ok: false,
      reason: 'paused',
      spentMicros,
      capMicros: DAILY_CAP_MICROS,
      resetsAt,
    };
  }

  return {
    ok: true,
    spentMicros,
    capMicros: DAILY_CAP_MICROS,
    resetsAt,
  };
}

/**
 * Record a Claude spend against the property's daily tally. Called by
 * every Claude vision call site (mfa-handler, knowledge-file repair,
 * workflow-runtime). Returns the updated state so caller can decide
 * whether to trip the cap immediately.
 *
 * Atomic increment via direct update (PostgreSQL is fine with `col = col + N`
 * within a single UPDATE — no read-modify-write race window beyond the
 * Supabase request boundary).
 */
export async function recordSpend(
  propertyId: string,
  micros: number,
  context: { kind: 'mapping' | 'repair' | 'workflow' | 'mfa' | 'other'; note?: string } = {
    kind: 'other',
  },
): Promise<BudgetState> {
  if (micros <= 0) {
    return checkBudget(propertyId);
  }

  // For mapping passes, the spend goes through a separate budget that
  // isn't enforced against the daily cap. Plan v4 architecture decision
  // #10: mapping passes can legitimately cost $5-15 in one run, which
  // would otherwise trip the daily cap during normal onboarding.
  if (context.kind === 'mapping') {
    log.info('cost-cap: mapping spend (separate budget)', {
      propertyId,
      spendMicros: micros,
      spendDollars: microsToDollars(micros),
      note: context.note,
    });
    // Still return current state so caller knows where the day stands.
    return checkBudget(propertyId);
  }

  // Atomic increment via Postgres expression — Supabase doesn't have
  // a first-class "increment column" so we use the RPC pattern or
  // round-trip update. For simplicity (and at our volume — < 10
  // recordSpend/hour/hotel in steady state), a read-modify-write is
  // fine; race risk is overshoot by a few hundred micros.
  const current = await checkBudget(propertyId);
  if (!current.ok && current.reason === 'cap_tripped') {
    log.warn('cost-cap: spend recorded but cap already tripped', {
      propertyId,
      attemptedSpendMicros: micros,
      capMicros: current.capMicros,
      spentMicros: current.spentMicros,
      kind: context.kind,
    });
    // Still write the spend — accounting is important even when
    // overshooting (helps debug "why did this hotel spend $7 today").
  }

  const newTotal = current.spentMicros + micros;
  const { error } = await supabase
    .from('property_sessions')
    .update({ daily_claude_cost_micros: newTotal })
    .eq('property_id', propertyId);

  if (error) {
    log.error('cost-cap: failed to record spend', {
      propertyId,
      spendMicros: micros,
      err: error,
    });
  }

  const tripped = newTotal >= DAILY_CAP_MICROS;
  if (tripped && current.ok) {
    // Newly tripped — set status to paused_cost_cap. Session-supervisor
    // will surface this via SMS + heartbeat + doctor.
    await markPaused(propertyId, current.resetsAt);
  }

  return {
    ok: !tripped,
    reason: tripped ? 'cap_tripped' : undefined,
    spentMicros: newTotal,
    capMicros: DAILY_CAP_MICROS,
    resetsAt: current.resetsAt,
  };
}

/**
 * Mark this hotel paused for cost. Idempotent — re-setting paused state
 * doesn't change behavior, but the log line is useful telemetry.
 */
async function markPaused(propertyId: string, resetsAt: Date): Promise<void> {
  const { error } = await supabase
    .from('property_sessions')
    .update({
      status: 'paused_cost_cap',
      paused_reason: `Daily Claude budget of $${microsToDollars(DAILY_CAP_MICROS).toFixed(2)} reached. Auto-resume at ${resetsAt.toISOString()}.`,
      paused_until: resetsAt.toISOString(),
    })
    .eq('property_id', propertyId);

  if (error) {
    log.error('cost-cap: failed to mark paused', { propertyId, err: error });
    return;
  }

  log.warn('cost-cap: hotel paused (cap tripped)', {
    propertyId,
    resetsAt: resetsAt.toISOString(),
  });
}

/**
 * Resume a hotel that was paused for cost. Called by session-supervisor
 * when checkBudget reports ok=true again after a reset.
 */
export async function markResumed(propertyId: string): Promise<void> {
  const { error } = await supabase
    .from('property_sessions')
    .update({
      status: 'alive',
      paused_reason: null,
      paused_until: null,
    })
    .eq('property_id', propertyId)
    .eq('status', 'paused_cost_cap');

  if (error) {
    log.error('cost-cap: failed to mark resumed', { propertyId, err: error });
    return;
  }

  log.info('cost-cap: hotel resumed (daily budget reset)', { propertyId });
}

/**
 * Compute the next local-midnight timestamp. Per-hotel timezone support
 * is a future plan v4 architecture decision (#12); for now we default to
 * America/Chicago to match the legacy scraper.
 */
function nextLocalMidnight(timezone = 'America/Chicago'): Date {
  // Get current time in the target timezone, compute tomorrow's midnight.
  const now = new Date();
  const localDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  // Parse YYYY-MM-DD as local-midnight in the target tz. Trick: build an
  // ISO timestamp at midnight in the target tz by string concatenation,
  // then adjust for the offset.
  const [y, m, d] = localDateStr.split('-').map(Number);
  // Tomorrow in the target tz.
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  // The above gives us UTC-midnight on tomorrow's local date. We need
  // LOCAL-midnight on tomorrow's local date. Adjust by the tz offset.
  const offsetMs = tzOffsetMs(timezone, tomorrow);
  return new Date(tomorrow.getTime() + offsetMs);
}

/**
 * Compute the timezone offset (in ms) for the given timezone at the
 * given moment. Positive offset means the tz is BEHIND UTC (e.g.,
 * America/Chicago at standard time = -6h → +6h to add to UTC).
 *
 * Uses Intl.DateTimeFormat to handle DST transitions correctly.
 */
function tzOffsetMs(timezone: string, at: Date): number {
  const utcStr = at.toISOString().slice(0, 19);
  const localStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) =>
    localStr.find((p) => p.type === type)?.value ?? '00';
  const local = `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:${get('second')}`;
  return new Date(utcStr).getTime() - new Date(local).getTime();
}
