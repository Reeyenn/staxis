// ═══════════════════════════════════════════════════════════════════════════
// The cursor: where this hotel's eyes were last, and how many times it has
// woken today.
//
// ONE ROW PER HOTEL (migration 0459). Read at the top of every sweep, advanced
// by compare-and-set before any money is spent.
//
// ─── ADVANCE FIRST, THEN CALL THE MODEL ────────────────────────────────────
//
// The order is load-bearing and it is the opposite of what feels natural. A
// sweep claims its window BEFORE it does anything expensive with it, so:
//
//   • two overlapping sweeps cannot both act on the same events. The second
//     one's compare-and-set matches zero rows, it sees that, and it stops. No
//     advisory lock, no RPC: the claim is the write.
//   • a crash in the middle of the model call cannot re-fire on the same
//     events ten minutes later. The window is spent.
//
// The cost of that ordering is honest and small: a run that dies mid-call loses
// those events. It is the right direction to lose in. The events themselves are
// still in activity_log, the nightly findings run still reads the state of the
// hotel rather than its event stream, and a missed note is a note; a runaway
// loop is a bill.
//
// ─── NO CURSOR MEANS NO WAKE ───────────────────────────────────────────────
//
// If this table is missing (migrations are applied by hand, so the code always
// ships first) or unreadable, every function here answers "I could not", and
// the runner treats that as a refusal rather than as a fresh start. That is
// FAIL-CLOSED ON SPEND, deliberately: a sweep that could not remember where it
// looked would look at the same two hours of events every ten minutes and pay
// for a model call each time.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

const TABLE = 'companion_event_wake_state';

const COLUMNS =
  'property_id, last_looked_at, last_woke_at, wakes_day, wakes_today, looks_total, wakes_total';

export interface WakeState {
  propertyId: string;
  lastLookedAt: string;
  lastWokeAt: string | null;
  wakesDay: string | null;
  wakesToday: number;
  looksTotal: number;
  wakesTotal: number;
}

/**
 * "That table is not there yet."
 *
 * Migrations are applied by hand (project_migration_application_manual.md), so
 * the code reaches production before the table does and every table-backed
 * feature has to survive the gap. 42P01 is Postgres; PGRST205 is PostgREST's
 * schema cache saying the same thing. Kept local rather than imported from
 * ai/employee-switches.ts's copy for the same reason that one is local: this
 * module has no other business with that subsystem, and a shared helper would
 * couple two features that share nothing else.
 */
function isMissingRelationError(
  error: { code?: string | null; message?: string | null } | null,
): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === '42P01' || code === 'PGRST205') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('does not exist') && msg.includes(TABLE);
}

function toState(row: Record<string, unknown>): WakeState {
  const wakesToday = Number(row.wakes_today);
  return {
    propertyId: String(row.property_id ?? ''),
    lastLookedAt: String(row.last_looked_at ?? ''),
    lastWokeAt: typeof row.last_woke_at === 'string' ? row.last_woke_at : null,
    wakesDay: typeof row.wakes_day === 'string' ? row.wakes_day : null,
    wakesToday: Number.isFinite(wakesToday) && wakesToday > 0 ? Math.floor(wakesToday) : 0,
    looksTotal: Number(row.looks_total) || 0,
    wakesTotal: Number(row.wakes_total) || 0,
  };
}

export type WakeStateRead =
  | { ok: true; state: WakeState; seeded: boolean }
  | { ok: false };

/**
 * This hotel's cursor, creating it on first sight.
 *
 * A hotel with no row is SEEDED to `now` and reported as such. The runner does
 * not wake on a seeded row, and the reason is the obvious one: the window a
 * fresh cursor would define starts at the beginning of time, and "every work
 * order this hotel has ever opened" is not something that just happened.
 */
export async function readWakeState(
  propertyId: string,
  now: Date,
): Promise<WakeStateRead> {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select(COLUMNS)
      .eq('property_id', propertyId)
      .limit(1);

    if (error) {
      if (isMissingRelationError(error)) {
        log.warn('[companion/event-wake] the cursor table is not applied yet; sweeping nothing', {
          propertyId,
        });
      } else {
        log.warn('[companion/event-wake] cursor read failed; this hotel sits this sweep out', {
          propertyId,
          err: error.message,
        });
      }
      return { ok: false };
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length > 0) return { ok: true, state: toState(rows[0]), seeded: false };

    const seededAt = now.toISOString();
    const { error: insertError } = await supabaseAdmin
      .from(TABLE)
      .insert({ property_id: propertyId, last_looked_at: seededAt, updated_at: seededAt });
    if (insertError) {
      // A race with another sweep is the expected cause: both saw no row, both
      // inserted, one lost on the primary key. Re-read rather than guess.
      const { data: retry } = await supabaseAdmin
        .from(TABLE)
        .select(COLUMNS)
        .eq('property_id', propertyId)
        .limit(1);
      const retryRows = (retry ?? []) as Array<Record<string, unknown>>;
      if (retryRows.length > 0) return { ok: true, state: toState(retryRows[0]), seeded: false };
      log.warn('[companion/event-wake] could not seed the cursor; this hotel sits this sweep out', {
        propertyId,
        err: insertError.message,
      });
      return { ok: false };
    }

    return {
      ok: true,
      seeded: true,
      state: {
        propertyId,
        lastLookedAt: seededAt,
        lastWokeAt: null,
        wakesDay: null,
        wakesToday: 0,
        looksTotal: 0,
        wakesTotal: 0,
      },
    };
  } catch (e) {
    log.warn('[companion/event-wake] cursor read threw; this hotel sits this sweep out', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return { ok: false };
  }
}

/**
 * Claim the window: advance the cursor, but only from exactly where we read it.
 *
 * COMPARE-AND-SET. `.eq('last_looked_at', priorIso)` is the whole concurrency
 * story: whichever sweep gets there first moves the cursor, and the other one
 * matches zero rows and is told so. Returns false on a lost race, on a failed
 * write, and on a missing table — every one of which means "do not spend money
 * on this window", which is the same instruction.
 */
export async function claimWakeWindow(opts: {
  propertyId: string;
  priorLastLookedAt: string;
  priorLooksTotal: number;
  untilIso: string;
  now: Date;
}): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .update({
        last_looked_at: opts.untilIso,
        // Folded into the claim rather than written by a second statement: the
        // claim happens on EVERY sweep, quiet or not, so it is already the one
        // write that counts looks, and a separate update would be a second
        // round trip per hotel per ten minutes for a statistic.
        looks_total: opts.priorLooksTotal + 1,
        updated_at: opts.now.toISOString(),
      })
      .eq('property_id', opts.propertyId)
      .eq('last_looked_at', opts.priorLastLookedAt)
      .select('property_id');

    if (error) {
      log.warn('[companion/event-wake] could not claim the window; nothing is spent on it', {
        propertyId: opts.propertyId,
        err: error.message,
      });
      return false;
    }
    return ((data ?? []) as unknown[]).length > 0;
  } catch (e) {
    log.warn('[companion/event-wake] claiming the window threw; nothing is spent on it', {
      propertyId: opts.propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Record that the model was actually called for this hotel.
 *
 * COUNTS THE ATTEMPT, not the outcome. It is written once the gate has decided
 * to wake and before anything is known about the reply, so a wake that produced
 * nothing, a wake whose model died, and a wake the spend cap refused all spend a
 * slot against MAX_WAKES_PER_DAY.
 *
 * Deliberately generous in the safe direction. A counter that only counted
 * successes would let a model that answers "nothing" all day run without a
 * ceiling, and a counter written after the call would undercount whenever a run
 * crashed mid-flight, which is the expensive way to be wrong. The cost of this
 * choice is that a hotel whose budget ran out also burns its wake slots, which
 * changes nothing: it was not going to get a call either way.
 *
 * `wakesDayNow` is the hotel's OWN calendar day. A day boundary read off UTC
 * would reset the counter in the middle of the night shift.
 */
export async function recordWake(opts: {
  propertyId: string;
  wakesDayNow: string;
  priorWakesDay: string | null;
  priorWakesToday: number;
  priorWakesTotal: number;
  now: Date;
}): Promise<void> {
  const sameDay = opts.priorWakesDay === opts.wakesDayNow;
  try {
    const { error } = await supabaseAdmin
      .from(TABLE)
      .update({
        last_woke_at: opts.now.toISOString(),
        wakes_day: opts.wakesDayNow,
        wakes_today: (sameDay ? opts.priorWakesToday : 0) + 1,
        wakes_total: opts.priorWakesTotal + 1,
        updated_at: opts.now.toISOString(),
      })
      .eq('property_id', opts.propertyId);
    if (error) {
      // LOUD. A lost wake count is a lost ceiling, and this is the cheap half
      // of the spend control. The dollar cap still stands behind it.
      log.error('[companion/event-wake] the wake counter did not save; only the dollar cap is left', {
        propertyId: opts.propertyId,
        err: error.message,
      });
    }
  } catch (e) {
    log.error('[companion/event-wake] the wake counter threw; only the dollar cap is left', {
      propertyId: opts.propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
