/**
 * Helper for persisting `property_misconfigured` events to `app_events`.
 *
 * Why this exists:
 *   Phase 3.5 (2026-05-13) added a `PropertyMisconfiguredError` raised
 *   by the ML service when a property is missing `total_rooms` or
 *   `timezone`. The Python side `print()`s a JSON line to stdout, but
 *   nothing wrote those events to the DB. Codex adversarial review
 *   2026-05-13 (#2) flagged this: the smoke test queries
 *   `app_events.event_type='property_misconfigured'` and the rows
 *   never existed. The "log + skip" design was operator-invisible.
 *
 *   This helper persists at the TS cron boundary — TS already has
 *   supabase admin auth and is orchestrating per-property loops, so
 *   it's the cleanest insertion point. The doctor's
 *   `property_misconfigured_recent` check reads back from here.
 *
 * Idempotent under the schema: `app_events` has no uniqueness
 * constraint on (property_id, event_type, ts), so multiple events per
 * day per property are allowed — that's intentional, the doctor
 * surfaces the count and the 90-day retention (migration 0103) caps
 * the table size.
 *
 * Failure mode: insert errors are logged but NEVER thrown. A bad
 * event write must not break the orchestrating cron run.
 */
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export type MisconfiguredLayer =
  | 'demand'
  | 'supply'
  | 'inventory_rate'
  | 'optimizer'
  | 'orchestrator';

export interface MisconfiguredEventInput {
  requestId?: string;
  propertyId: string;
  /** Which ML layer or the orchestrator detected the misconfiguration. */
  layer?: MisconfiguredLayer;
  /** The property field that was invalid — e.g. `total_rooms`, `timezone`. */
  field: string;
  /**
   * When the field was remapped to `unknown_field` by the parser
   * (allowlist miss), this preserves the original raw name so operator
   * forensics can recover the typo. Codex round-3 review 2026-05-13 (E2).
   */
  originalField?: string;
  /** The bad value, captured for debugging (stringified). */
  value: unknown;
}

/**
 * Minimal client surface this helper actually uses. Extracted as an
 * interface so tests can inject a mock without monkey-patching the
 * supabaseAdmin module export (which is a `const` and not reassignable
 * in ESM). Prod always uses the real supabaseAdmin client.
 */
export interface AppEventsClient {
  from(table: 'app_events'): {
    insert(row: Record<string, unknown>): Promise<{ error: unknown }>;
  };
}

export async function emitPropertyMisconfiguredEvent(
  input: MisconfiguredEventInput,
  client: AppEventsClient = supabaseAdmin as unknown as AppEventsClient,
): Promise<void> {
  try {
    const { error } = await client.from('app_events').insert({
      property_id: input.propertyId,
      user_id: null,
      user_role: 'system',
      event_type: 'property_misconfigured',
      metadata: {
        layer: input.layer ?? 'orchestrator',
        field: input.field,
        // E2: persist the original (pre-allowlist) field name when the
        // parser remapped to 'unknown_field'. Recoverable from
        // app_events instead of only Vercel logs.
        ...(input.originalField ? { original_field: input.originalField } : {}),
        value: input.value === null || input.value === undefined ? null : String(input.value),
        request_id: input.requestId ?? null,
      },
    });
    if (error) {
      log.warn('emitPropertyMisconfiguredEvent: insert failed', {
        requestId: input.requestId,
        propertyId: input.propertyId,
        err: error as unknown as Error,
      });
    }
  } catch (err) {
    log.warn('emitPropertyMisconfiguredEvent: insert threw', {
      requestId: input.requestId,
      propertyId: input.propertyId,
      err: err as Error,
    });
  }
}

/**
 * Known property fields the ML service can report as misconfigured.
 * Codex follow-up 2026-05-13 (C4): allowlist so a typo on the Python
 * side (e.g. `total_roomz`) doesn't propagate uselessly to the doctor.
 * Unknown fields are remapped to `unknown_field` and the original
 * field name is preserved in `original_field` for forensic logs.
 */
const KNOWN_MISCONFIGURED_FIELDS = ['timezone', 'total_rooms'] as const;

/**
 * Statuses that count as "misconfigured property" for cron-heartbeat
 * purposes. Each cron filters its results array using this set so
 * `degraded` heartbeats only fire on real misconfigurations — NOT on
 * intentional admin states (e.g. `'skipped_ai_off'` from the inventory
 * predict cron). Codex round-4 review 2026-05-13 (G4): single source
 * of truth so a future skipped reason added to the ML service must be
 * acknowledged here, not silently miscounted.
 */
export const MISCONFIG_STATUSES: ReadonlySet<string> = new Set(['skipped']);

/**
 * Sentinel values that mean "missing" across the TS/Python boundary.
 * Codex follow-up 2026-05-13 (C2): TS-detected skips wrote `null`,
 * Python's repr() preserved `None`, `''`, `"NULL"`, etc. — operators
 * querying app_events would see three different sentinels for the
 * same condition. Normalize all of them to a single canonical `null`.
 */
// D3: include empty string because stripSurroundingQuotes will turn "''"
// (Python repr of '') into '', which should still map to null. The
// quoted forms stay in the set in case stripSurroundingQuotes isn't
// applied somewhere downstream (defense in depth).
const NULL_SENTINELS = new Set(['', 'None', 'null', 'NULL', "''", '""', 'undefined']);

/**
 * Parse a ML-service error string like
 *   "property_misconfigured: total_rooms=0"
 *   "property_misconfigured: timezone=None"
 * into { field, value }. Returns null if the string doesn't match the
 * expected shape — the caller should log + skip silently in that case
 * (the structured event won't be written but the cron continues).
 *
 * Codex follow-up 2026-05-13 (C2 + C4):
 *   - Field is allowlist-checked. Unknown fields surface as
 *     `unknown_field` with the original name preserved.
 *   - Value is normalized: Python's repr() sentinels for "missing"
 *     (None, '', NULL, etc.) all collapse to JS null.
 */
export interface ParsedPropertyMisconfiguredError {
  field: string;
  /** Set when field was not in the allowlist (the original raw name). */
  originalField?: string;
  /** null if the value matched a known "missing" sentinel; else the raw string. */
  value: string | null;
}

/**
 * Strip surrounding single or double quotes if present. Codex round-3
 * review 2026-05-13 (D3): Python's `f"{value!r}"` previously emitted
 * surrounding quotes for string-typed values (e.g. timezone='Mars/Olympus'
 * → "'Mars/Olympus'"). The Python side now uses `printable_value` to
 * avoid this, but this stripper stays as defense-in-depth — older
 * error messages from in-flight cron runs, manual debugging, or
 * future repr-using callers won't store quoted values.
 */
function stripSurroundingQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function parsePropertyMisconfiguredError(
  message: string,
): ParsedPropertyMisconfiguredError | null {
  if (!message.startsWith('property_misconfigured:')) return null;
  const rest = message.slice('property_misconfigured:'.length).trim();
  const eq = rest.indexOf('=');
  if (eq < 0) return null;
  const rawField = rest.slice(0, eq).trim();
  // D3: strip surrounding quotes before sentinel check + storage so a
  // quoted "'None'" still maps to null and a real value like
  // "'Mars/Olympus'" surfaces as Mars/Olympus (no spurious quotes).
  const rawValue = stripSurroundingQuotes(rest.slice(eq + 1).trim());
  if (!rawField) return null;

  const normalizedField: string = (KNOWN_MISCONFIGURED_FIELDS as readonly string[]).includes(rawField)
    ? rawField
    : 'unknown_field';
  const normalizedValue: string | null = NULL_SENTINELS.has(rawValue) ? null : rawValue;

  if (normalizedField === 'unknown_field') {
    return { field: 'unknown_field', originalField: rawField, value: normalizedValue };
  }
  return { field: normalizedField, value: normalizedValue };
}
