// ═══════════════════════════════════════════════════════════════════════════
// The per-employee kill switch — reader, writer, and the direction it fails.
//
// WHAT IT DOES
// One boolean per AI employee, stored as a row in `ai_employee_switches`
// (migration 0373). Absence of a row means on. Only an explicit switched_off
// row stops anything, and every generation path in that employee's bundle asks
// this module before it does any work.
//
// WHAT IT IS NOT
// It is not the master switch. Nothing here schedules anything or starts
// anything; this module can only ever say "stop".
//
// ─── WHICH WAY IT FAILS, AND WHY ────────────────────────────────────────────
//
// A read that fails resolves to the LAST VALUE THIS INSTANCE SUCCESSFULLY READ,
// and only falls back to "on" if it has never read one. Not the two obvious
// alternatives, both of which are worse:
//
//   • fail to ON always — a founder switches the Morning Briefer off, the
//     database hiccups, and it starts writing again with nobody told. The one
//     control on the page stops meaning anything the moment it is under load.
//   • fail to OFF — one transient error silently stops a working employee at
//     every hotel at once. A kill switch that can fire itself is not a switch.
//
// Last-known-value is the honest middle: a decision that was read once survives
// a hiccup, and an instance that has never heard otherwise does the thing it
// was doing yesterday. This mirrors the two_factor reader's shape (a short TTL
// cache in front of one row) but NOT its direction — that flag is a security
// wall and fails toward enforcement; this one is an override on work that is
// already safe, and failing toward "keep working" is the conservative choice
// for it.
//
// The failure is self-limiting in the one place it matters: if the database is
// unreachable, the morning brief cannot gather its inputs either, so nothing
// gets written regardless of what this returns.
//
// TABLE-NOT-THERE is not a failure. Migrations are applied by hand, so the code
// ships before the table exists. A missing relation means nobody has ever
// switched anything off — which is exactly "on" — and is treated as a clean
// empty read, not an error.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { SCHEDULE_REGISTRY } from '@/lib/cron-schedule-registry';

/** "That table is not there yet." Migrations are applied by hand, so the code
 *  reaches production before the table does, and every table-backed feature has
 *  to survive the gap. 42P01 is Postgres; PGRST205 is PostgREST's schema cache
 *  saying the same thing. Kept local rather than imported from the promotion
 *  queue's copy — this module has no other business with that subsystem. */
function isMissingRelationError(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === '42P01' || code === 'PGRST205') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('does not exist') && msg.includes('ai_employee_switches');
}

/** Short enough that a founder flipping the switch sees it take effect while
 *  he is still looking at the page; long enough that a per-hotel read on every
 *  morning load is not thirteen round trips. */
const TTL_MS = 15_000;

export interface EmployeeSwitch {
  employeeId: string;
  switchedOff: boolean;
  switchedOffAt: string | null;
  switchedOffBy: string | null;
  note: string | null;
}

type SwitchMap = ReadonlyMap<string, EmployeeSwitch>;

const EMPTY: SwitchMap = new Map();

let cache: { value: SwitchMap; expiresAt: number } | null = null;
/** The last read that actually succeeded. Survives cache expiry on purpose —
 *  this is what a failed read falls back to. */
let lastKnown: SwitchMap | null = null;

interface Row {
  employee_id: string;
  switched_off: boolean | null;
  switched_off_at: string | null;
  switched_off_by: string | null;
  note: string | null;
}

function toMap(rows: Row[]): SwitchMap {
  const m = new Map<string, EmployeeSwitch>();
  for (const r of rows) {
    m.set(r.employee_id, {
      employeeId: r.employee_id,
      switchedOff: r.switched_off === true,
      switchedOffAt: r.switched_off_at,
      switchedOffBy: r.switched_off_by,
      note: r.note,
    });
  }
  return m;
}

/**
 * Every switch row, straight from the database. Throws nothing.
 *
 * Returns null — distinct from an empty map — when the read genuinely failed,
 * so callers can tell "nobody has switched anything off" from "we could not
 * find out". The admin page uses that difference to avoid printing a status it
 * cannot stand behind.
 */
export async function readEmployeeSwitchesFresh(): Promise<SwitchMap | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('ai_employee_switches')
      .select('employee_id, switched_off, switched_off_at, switched_off_by, note');

    if (error) {
      // Not applied yet is not an error: no table, no switches, everyone on.
      if (isMissingRelationError(error)) {
        lastKnown = EMPTY;
        return EMPTY;
      }
      log.warn('[ai-staff] could not read the employee switches', { err: error.message });
      return null;
    }
    const value = toMap((data ?? []) as Row[]);
    lastKnown = value;
    return value;
  } catch (e) {
    log.warn('[ai-staff] employee switch read threw', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Cached read for the generation paths. Falls back to the last value this
 *  instance read successfully, and to "nothing switched off" if there is none. */
export async function readEmployeeSwitches(): Promise<SwitchMap> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const fresh = await readEmployeeSwitchesFresh();
  const value = fresh ?? lastKnown ?? EMPTY;
  cache = { value, expiresAt: now + TTL_MS };
  return value;
}

/**
 * THE question every bundled generation path asks before doing any work.
 *
 * `true` means the founder stopped this employee and nothing should be
 * produced. Everything else — no row, an on row, an unreadable table, an id the
 * database has never heard of — is `false`.
 */
export async function isEmployeeSwitchedOff(employeeId: string): Promise<boolean> {
  const switches = await readEmployeeSwitches();
  return switches.get(employeeId)?.switchedOff === true;
}

/** Drop this instance's cache so the next read re-hits the database. Called
 *  right after a write so the founder sees his own change immediately. */
export function invalidateEmployeeSwitchCache(): void {
  cache = null;
}

/**
 * Flip one employee's switch.
 *
 * Switching OFF writes the decision and its provenance together — the table's
 * own check constraint refuses a row that claims an employee is off without
 * recording when. Switching back ON clears the provenance rather than deleting
 * the row, so "this was switched off at some point" stays visible in the
 * database even after it is switched back on.
 */
export async function setEmployeeSwitch(opts: {
  employeeId: string;
  switchedOff: boolean;
  byAccountId: string | null;
  note?: string | null;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = opts.switchedOff
    ? {
      employee_id: opts.employeeId,
      switched_off: true,
      switched_off_at: new Date().toISOString(),
      switched_off_by: opts.byAccountId,
      note: opts.note ?? null,
    }
    : {
      employee_id: opts.employeeId,
      switched_off: false,
      switched_off_at: null,
      switched_off_by: null,
      note: opts.note ?? null,
    };

  const { error } = await supabaseAdmin
    .from('ai_employee_switches')
    .upsert(row, { onConflict: 'employee_id' });

  if (error) {
    log.error('[ai-staff] could not write the employee switch', {
      employeeId: opts.employeeId,
      err: error.message,
    });
    return {
      ok: false,
      reason: isMissingRelationError(error)
        ? 'The switches table is not set up on this database yet.'
        : 'That did not save. Try again.',
    };
  }
  invalidateEmployeeSwitchCache();
  return { ok: true };
}

/**
 * The scheduled jobs that currently HAVE a schedule.
 *
 * Read from the schedule registry rather than vercel.json because the registry
 * is a module that ships with the bundle and vercel.json is a file that does
 * not — and because the registry is already the single source of truth those
 * schedules are drift-tested against. A job whose route exists but whose row is
 * not here is exactly what "off, waiting for the master switch" means.
 */
export function scheduledCronNames(): ReadonlySet<string> {
  return new Set(SCHEDULE_REGISTRY.map((e) => e.heartbeatName));
}
