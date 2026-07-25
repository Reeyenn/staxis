// ═══════════════════════════════════════════════════════════════════════════
// Canonical dimensions — the two dictionaries from migration 0356.
//
// The problem both solve is the same one: a thing arrives from the PMS as a
// bare string, and from then on it is matched by string comparison. "MARIA
// GARCIA" and "Maria  Garcia" are different housekeepers. Every spelling of
// "Booking.com" is its own revenue line.
//
// Neither table changes any behaviour by existing. Both start EMPTY and fill
// from real events — an alias when a human links a name to a person, a
// dimension value when a report actually prints one. Nothing here invents
// history, and an unmapped value always degrades to itself rather than
// vanishing from a report.
//
// Server-only: both tables are RLS deny-all for the browser roles, so every
// call here goes through supabaseAdmin from an /api route or a server module.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

/** How a name got linked to a person. Mirrors the CHECK in 0356. */
export type StaffAliasSource = 'pms_import' | 'manager' | 'auto_exact' | 'auto_first_name';

/** The three free-text dimensions worth canonicalising. Mirrors the CHECK. */
export type PmsDimension = 'channel' | 'room_class' | 'rate_plan';

/**
 * The normalization the DATABASE applies to alias_raw and raw_value, mirrored
 * here so callers can dedupe before a round-trip.
 *
 * The database is authoritative — alias_norm and value_norm are GENERATED
 * columns, which is the entire point of 0356: two divergent TypeScript
 * normalizeName() implementations already exist in this repo and they disagree
 * about punctuation. If this function ever drifts from the SQL, the UNIQUE
 * index still holds the line; the worst case is a redundant upsert.
 */
export function normalizeDimensionValue(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Record that `aliasRaw` means `staffId` at this property.
 *
 * Called when a human makes the link — a manager or the agent assigning a room
 * to a named person. Deliberately NOT called from read paths that GUESS a
 * match by name: a guess is not a receipt, and writing one would launder it
 * into a fact. Unresolved names are still worth recording (pass staffId=null),
 * because "we have seen this name and do not know who it is" is exactly what
 * an operator needs to see.
 *
 * Best-effort: an alias is a convenience, never the reason an assignment
 * fails. Errors are logged and swallowed.
 */
export async function recordStaffAlias(
  propertyId: string,
  aliasRaw: string,
  staffId: string | null,
  source: StaffAliasSource,
): Promise<void> {
  const trimmed = (aliasRaw ?? '').trim();
  if (!propertyId || !trimmed) return;

  try {
    // The unique key is (property_id, alias_norm), and alias_norm is GENERATED
    // — PostgREST cannot upsert onto a generated column, so this is an
    // explicit find-then-write against the normalized value.
    const { data: existing, error: readErr } = await supabaseAdmin
      .from('staff_aliases')
      .select('id, staff_id, seen_count')
      .eq('property_id', propertyId)
      .eq('alias_norm', normalizeDimensionValue(trimmed))
      .maybeSingle();
    if (readErr) throw readErr;

    if (!existing) {
      const { error } = await supabaseAdmin.from('staff_aliases').insert({
        property_id: propertyId,
        staff_id: staffId,
        alias_raw: trimmed,
        source,
      });
      if (error) throw error;
      return;
    }

    // Never overwrite a known link with a null one: forgetting who someone is
    // because a later report printed their name without context would be a
    // regression, not an update.
    const row = existing as { id: string; staff_id: string | null; seen_count: number };
    const { error } = await supabaseAdmin
      .from('staff_aliases')
      .update({
        staff_id: staffId ?? row.staff_id,
        seen_count: (row.seen_count ?? 0) + 1,
        last_seen_at: new Date().toISOString(),
        ...(staffId && !row.staff_id ? { source } : {}),
      })
      .eq('id', row.id);
    if (error) throw error;
  } catch (err) {
    log.warn('[dimensions] recordStaffAlias failed (non-fatal)', {
      propertyId, source, msg: (err as Error).message,
    });
  }
}

/**
 * Every name string this property has been seen using, mapped to the staff
 * member it means. Names nobody has identified yet are omitted — the caller
 * falls back to its own matching for those, which is exactly today's
 * behaviour.
 *
 * Returns an empty map on any failure. This is an accelerator, not a
 * dependency: an empty result must degrade to name matching, never to "this
 * housekeeper has no rooms".
 */
export async function loadStaffAliasMap(propertyId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!propertyId) return out;
  try {
    const { data, error } = await supabaseAdmin
      .from('staff_aliases')
      .select('alias_norm, staff_id')
      .eq('property_id', propertyId)
      .not('staff_id', 'is', null);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ alias_norm: string; staff_id: string | null }>) {
      if (row.staff_id) out.set(row.alias_norm, row.staff_id);
    }
  } catch (err) {
    log.warn('[dimensions] loadStaffAliasMap failed — falling back to name matching', {
      propertyId, msg: (err as Error).message,
    });
  }
  return out;
}

/**
 * Note that a report printed these raw category values.
 *
 * canonical_code is left NULL: nobody has said what the value means yet, and
 * pretending otherwise is how "Booking.com" and "booking.com" become one
 * revenue line by accident instead of by decision. Readers use
 * `coalesce(canonical_code, raw_value)`, so an unmapped value behaves exactly
 * as it does today.
 *
 * Best-effort and deduped by the caller-visible normalization, so calling it
 * once per report with the whole batch is cheap.
 */
export async function recordDimensionValues(
  propertyId: string,
  dimension: PmsDimension,
  rawValues: Array<string | null | undefined>,
  pmsFamily?: string | null,
): Promise<void> {
  if (!propertyId) return;

  // One row per distinct normalized value, keeping the first raw spelling seen
  // so an operator sees a real example rather than a lowercased one.
  const distinct = new Map<string, string>();
  for (const v of rawValues) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const norm = normalizeDimensionValue(trimmed);
    if (!distinct.has(norm)) distinct.set(norm, trimmed);
  }
  if (distinct.size === 0) return;

  try {
    const { data, error } = await supabaseAdmin
      .from('pms_dimension_values')
      .select('id, value_norm, seen_count')
      .eq('property_id', propertyId)
      .eq('dimension', dimension)
      .in('value_norm', [...distinct.keys()]);
    if (error) throw error;

    const known = new Map(
      ((data ?? []) as Array<{ id: string; value_norm: string; seen_count: number }>)
        .map((r) => [r.value_norm, r]),
    );

    const fresh = [...distinct.entries()]
      .filter(([norm]) => !known.has(norm))
      .map(([, raw]) => ({
        property_id: propertyId,
        dimension,
        raw_value: raw,
        pms_family: pmsFamily ?? null,
      }));
    if (fresh.length > 0) {
      const { error: insErr } = await supabaseAdmin.from('pms_dimension_values').insert(fresh);
      if (insErr) throw insErr;
    }

    const now = new Date().toISOString();
    for (const row of known.values()) {
      await supabaseAdmin
        .from('pms_dimension_values')
        .update({ seen_count: (row.seen_count ?? 0) + 1, last_seen_at: now })
        .eq('id', row.id);
    }
  } catch (err) {
    log.warn('[dimensions] recordDimensionValues failed (non-fatal)', {
      propertyId, dimension, msg: (err as Error).message,
    });
  }
}

/**
 * What a raw value should be called. Falls back to the raw value itself when
 * nobody has mapped it — an unmapped channel still shows up in the report,
 * spelled the way the PMS spelled it.
 */
export function canonicalOrRaw(
  raw: string | null | undefined,
  canonicalByNorm: Map<string, string>,
): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return canonicalByNorm.get(normalizeDimensionValue(raw)) ?? raw;
}
