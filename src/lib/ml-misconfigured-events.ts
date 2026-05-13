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
 * Parse a ML-service error string like
 *   "property_misconfigured: total_rooms=0"
 *   "property_misconfigured: timezone=None"
 * into { field, value }. Returns null if the string doesn't match the
 * expected shape — the caller should log + skip silently in that case
 * (the structured event won't be written but the cron continues).
 */
export function parsePropertyMisconfiguredError(
  message: string,
): { field: string; value: string } | null {
  if (!message.startsWith('property_misconfigured:')) return null;
  const rest = message.slice('property_misconfigured:'.length).trim();
  const eq = rest.indexOf('=');
  if (eq < 0) return null;
  const field = rest.slice(0, eq).trim();
  const value = rest.slice(eq + 1).trim();
  if (!field) return null;
  return { field, value };
}
