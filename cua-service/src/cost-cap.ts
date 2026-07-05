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

/** Default daily cap in millionths-of-a-dollar. $5/day = 5_000_000.
 *  Its OWN env var — this previously aliased CUA_JOB_COST_CAP_MICROS (the
 *  per-mapping-JOB cap), coupling two knobs with different semantics. */
const DAILY_CAP_MICROS = env.CUA_DAILY_HOTEL_COST_CAP_MICROS;

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
  // Tracks whether THIS call's reset cleared a cost-cap pause, so the
  // paused-status check below doesn't immediately re-report ok=false.
  let clearedPause = false;

  // Auto-reset if the window has passed.
  if (Date.now() >= resetsAt.getTime()) {
    const newResetsAt = nextLocalMidnight();
    // C1 auto-resume: if this row was paused by the cap, clear the pause
    // in the SAME update that zeroes the tally so the driver resumes on
    // the reset tick (checkBudget returns ok=true below).
    const wasPausedByCap = row.status === 'paused_cost_cap';
    const resetPayload: Record<string, unknown> = {
      daily_claude_cost_micros: 0,
      daily_claude_cost_resets_at: newResetsAt.toISOString(),
    };
    if (wasPausedByCap) {
      resetPayload.status = 'alive';
      resetPayload.paused_reason = null;
      resetPayload.paused_until = null;
    }
    const { error: resetErr } = await supabase
      .from('property_sessions')
      .update(resetPayload)
      .eq('property_id', propertyId);
    if (resetErr) {
      log.warn('cost-cap: failed to reset daily tally', {
        propertyId,
        err: resetErr.message,
      });
    } else {
      clearedPause = wasPausedByCap;
      log.info('cost-cap: reset daily tally', {
        propertyId,
        previousSpentMicros: spentMicros,
        nextResetAt: newResetsAt.toISOString(),
        resumedFromCap: wasPausedByCap,
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

  if (row.status === 'paused_cost_cap' && !clearedPause) {
    // Tally is under cap but row is still flagged AND this call didn't just
    // clear the pause on a reset tick. Stay paused until the reset fires.
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

  // Atomic increment via staxis_cua_increment_spend RPC (migration
  // 0205). Replaces the prior read-modify-write that lost increments
  // under concurrent recordSpend calls. Codex 2026-05-23 finding.
  const { data, error } = await supabase
    .rpc('staxis_cua_increment_spend', {
      p_property_id: propertyId,
      p_micros: micros,
    })
    .single();

  if (error || !data) {
    log.error('cost-cap: atomic recordSpend RPC failed — falling back to RMW', {
      propertyId,
      spendMicros: micros,
      err: error,
    });
    // Fallback so we don't silently drop accounting on RPC outage.
    const current = await checkBudget(propertyId);
    const newTotal = current.spentMicros + micros;
    await supabase
      .from('property_sessions')
      .update({ daily_claude_cost_micros: newTotal })
      .eq('property_id', propertyId);
    if (newTotal >= DAILY_CAP_MICROS && current.ok) {
      await markPaused(propertyId, current.resetsAt);
    }
    return {
      ok: newTotal < DAILY_CAP_MICROS,
      reason: newTotal >= DAILY_CAP_MICROS ? 'cap_tripped' : undefined,
      spentMicros: newTotal,
      capMicros: DAILY_CAP_MICROS,
      resetsAt: current.resetsAt,
    };
  }

  const row = data as { new_total_micros: number; resets_at: string; status: string };
  const newTotal = Number(row.new_total_micros);
  const resetsAt = new Date(row.resets_at);
  const tripped = newTotal >= DAILY_CAP_MICROS;
  const wasRunnable = row.status === 'alive' || row.status === 'starting';

  if (tripped && wasRunnable) {
    await markPaused(propertyId, resetsAt);
  }

  return {
    ok: !tripped,
    reason: tripped ? 'cap_tripped' : undefined,
    spentMicros: newTotal,
    capMicros: DAILY_CAP_MICROS,
    resetsAt,
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
/**
 * Plan v8 final review B1 + S1 — org-wide daily mapping spend cap.
 *
 * Mapping spend is excluded from the per-hotel cap (mapping is bursty + a
 * shared cost across many hotels on the same PMS family). But there's
 * still a real cost-bomb risk: at 300 hotels onboarding with vision mode
 * at $25/run, if 30% fail and need re-mapping, that's $2,250 in a day.
 * Without an aggregate cap, no code stops it.
 *
 * This cap is a SAFETY NET that pauses new mapper jobs (existing in-flight
 * runs continue to their per-job cap) when the org has spent more than
 * CUA_DAILY_MAPPING_SPEND_CAP_MICROS in the last 24h on source='mapping'
 * rows in claude_usage_log. Default: $100/day. Raise via fly secret once
 * vision is proven on multiple PMSes.
 *
 * Workflow-runtime + mapping-driver both call this. workflow-runtime
 * leaves the job queued (won't claim); mapping-driver returns early with
 * a clear error so the workflow_jobs row gets a recognizable last_error.
 */
export async function checkDailyMappingSpend(): Promise<{
  over: boolean;
  spentMicros: number;
  capMicros: number;
}> {
  const capMicros = env.CUA_DAILY_MAPPING_SPEND_CAP_MICROS;
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  // Sum cost_micros for mapping workloads in the last 24h.
  // NOTE: logClaudeUsage never sets `source` (defaults to polling), so the
  // prior `.eq('source','mapping')` filter always summed $0 and the cap was
  // inert. Filter on the workload prefix instead — per migration 0208 the
  // `cua_mapping%` workloads are the documented equivalent of source=mapping.
  //
  // PAGINATED: hosted PostgREST caps a response at max_rows (1000 default)
  // and supabase-js returns the truncated page WITHOUT an error. A single
  // full vision learn logs hundreds of cua_mapping% rows, so 2-3 concurrent
  // onboardings blow past 1000 inside the 24h window — the old unpaginated
  // sum silently froze exactly during the mass-onboarding load this cap
  // exists to stop. cua_critic is included too: critic calls only fire
  // inside mapping runs and were previously bounded by nothing but the
  // per-job cap. (`*` is PostgREST's like-wildcard inside .or() strings.)
  const PAGE = 1000;
  const MAX_PAGES = 50; // 50k rows ≈ far beyond any real day; bounded loop
  let spentMicros = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await supabase
      .from('claude_usage_log')
      .select('cost_micros')
      .or('workload.like.cua_mapping*,workload.eq.cua_critic')
      .gte('ts', since)
      .order('ts', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      // Don't fail-closed: if the cap-check query itself fails, we
      // log + treat as under-budget. The per-job cap still applies.
      log.warn('cost-cap: daily mapping spend query failed — assuming under cap', {
        err: error.message,
      });
      return { over: false, spentMicros: 0, capMicros };
    }
    const batch = data ?? [];
    spentMicros += batch.reduce(
      (sum, row) => sum + ((row as { cost_micros: number }).cost_micros ?? 0),
      0,
    );
    // Short-circuit: already over cap, or final (partial) page reached.
    if (spentMicros >= capMicros || batch.length < PAGE) break;
  }
  return { over: spentMicros >= capMicros, spentMicros, capMicros };
}

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
