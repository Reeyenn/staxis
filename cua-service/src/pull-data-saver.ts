/**
 * Pull data saver — writes the steady-state pull output (rooms, staff,
 * arrivals/departures counts, room statuses) into the property's tables
 * in Supabase.
 *
 * Distinct from data-loader.ts (which is for ONBOARDING — first-time
 * extraction, populates room_inventory, inserts new staff). The pull
 * path is the every-15-min recurring write:
 *   - dashboard_by_date row for today's date (per-property snapshot —
 *     migration 0041 made this property-scoped)
 *   - rooms.status updates per room (live housekeeping state)
 *   - pull_metrics insert for observability
 *
 * What this DOESN'T touch:
 *   - properties.room_inventory (pull doesn't change room layout)
 *   - staff insert (pull doesn't add new staff — that's onboarding)
 *   - scraper_status (still used by the legacy single-tenant Railway
 *     scraper for the "live numbers" badge in the UI; will be migrated
 *     to multi-tenant in a follow-up)
 *
 * The aggregates (in_house, arrivals, departures) come from the
 * ExtractedData shape:
 *   - in_house    = roomStatus[].filter(s => s.status === 'occupied').length
 *   - arrivals    = arrivalsToday.length    (one row per arriving room)
 *   - departures  = departuresToday.length  (one row per departing room)
 * Matches what the Railway scraper writes for Mario today.
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import type { ExtractedData } from './recipe-runner.js';

export interface PullSaveSummary {
  inHouse: number;
  arrivals: number;
  departures: number;
  roomStatusUpdates: number;
}

export type PullSaveResult =
  | { ok: true; summary: PullSaveSummary }
  | { ok: false; error: string };

/**
 * Compute the local-date string (YYYY-MM-DD) in the property's timezone.
 * Defaults to America/Chicago — matches the legacy scraper's TIMEZONE
 * env var. Per-property timezone support is a future enhancement.
 */
function localDateForProperty(timezone = 'America/Chicago'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

export async function savePullData(args: {
  propertyId: string;
  data: ExtractedData;
  pullStartedAt: number;
}): Promise<PullSaveResult> {
  const errors: string[] = [];
  const nowIso = new Date().toISOString();
  const localDate = localDateForProperty();

  // ─── 1. Aggregate counts for dashboard_by_date ────────────────────────────
  const inHouse = args.data.roomStatus.filter(
    (r) => r.status === 'occupied',
  ).length;
  const arrivals = args.data.arrivalsToday.length;
  const departures = args.data.departuresToday.length;

  // ─── 2. dashboard_by_date upsert (per-property snapshot) ──────────────────
  // After migration 0041 the table is keyed on (date, property_id).
  // onConflict matches the composite PK so multiple pulls on the same
  // local date update the same row — last pull before midnight local
  // time becomes the frozen historical snapshot.
  const { error: dbdErr } = await supabase
    .from('dashboard_by_date')
    .upsert(
      {
        date:              localDate,
        property_id:       args.propertyId,
        in_house:          inHouse,
        arrivals:          arrivals,
        departures:        departures,
        // Guest counts not present in the recipe-runner output today —
        // future enhancement is to capture them via ParseHint extension.
        in_house_guests:   null,
        arrivals_guests:   null,
        departures_guests: null,
        pulled_at:         nowIso,
        // Clear error fields on a successful pull so the dashboard
        // freshness indicator resets.
        error_code:        null,
        error_message:     null,
        error_page:        null,
        errored_at:        null,
      },
      { onConflict: 'date,property_id' },
    );
  if (dbdErr) {
    log.warn('failed to upsert dashboard_by_date', { err: dbdErr.message });
    errors.push(`dashboard_by_date: ${dbdErr.message}`);
  }

  // ─── 3. rooms.status updates ──────────────────────────────────────────────
  // Map PMSRoomStatus.status (occupied/vacant_clean/vacant_dirty/inspected/
  // out_of_order/unknown) into the rooms.status enum the housekeeping UI
  // expects. The mapping is intentionally conservative — anything we can't
  // confidently classify is left untouched (we don't overwrite Maria's
  // manual edits with 'unknown').
  let roomStatusUpdates = 0;
  if (args.data.roomStatus.length > 0) {
    // Audit follow-up (CUA P1, 2026-05-17): replaced the per-row loop with
    // a single RPC. The original loop was both slow (N round-trips) AND
    // silently broken — it filtered on `room_number` (column doesn't
    // exist; the column is `number`), wrote `last_synced_at` (also
    // doesn't exist), and had no date scope (would have updated all
    // dates for that number if it had worked). The RPC fixes all three
    // and runs in one round-trip via a bulk UPDATE … FROM (VALUES …).
    // See supabase/migrations/0138_rpc_bulk_update_room_status.sql.
    const updates = args.data.roomStatus
      .filter(r => !!r.roomNumber)
      .map(r => ({ number: r.roomNumber, status: mapRoomStatus(r.status) }))
      .filter((r): r is { number: string; status: 'clean' | 'dirty' } => r.status === 'clean' || r.status === 'dirty');
    if (updates.length > 0) {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('staxis_bulk_update_room_status', {
        p_property: args.propertyId,
        p_date:     localDate,
        p_updates:  updates,
      });
      if (rpcErr) {
        log.warn('bulk room status update failed (non-fatal)', {
          propertyId: args.propertyId,
          attempted: updates.length,
          err: rpcErr.message,
        });
      } else {
        const result = (rpcData ?? {}) as { updated_count?: number };
        roomStatusUpdates = Number(result.updated_count ?? 0);
      }
    }
  }
  // nowIso captured at the top of the function is now only used by the
  // dashboard_by_date upsert above; reference it here so TS doesn't flag
  // it as unused on the audit follow-up rewrite.
  void nowIso;

  // ─── 4. pull_metrics row (observability) ──────────────────────────────────
  // Best-effort — never fail the pull on a metrics insert. The pull
  // already succeeded for the GM; the metrics row is for the dashboard.
  try {
    const { error: pmErr } = await supabase.from('pull_metrics').insert({
      property_id: args.propertyId,
      pull_type:   'cua_steady_state',
      ok:          errors.length === 0,
      error_code:  null,
      total_ms:    Date.now() - args.pullStartedAt,
      rows:        roomStatusUpdates,
    });
    if (pmErr) {
      log.warn('pull_metrics insert failed (non-fatal)', { err: pmErr.message });
    }
  } catch (err) {
    log.warn('pull_metrics insert threw (non-fatal)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join(' | ') };
  }
  return {
    ok: true,
    summary: { inHouse, arrivals, departures, roomStatusUpdates },
  };
}

/**
 * Map the recipe-runner's RoomCondition into the rooms.status enum used
 * by the housekeeping UI. Returns null when the source value is too
 * vague to safely write — leaves the existing DB value alone in that case.
 */
function mapRoomStatus(source: string): string | null {
  switch (source) {
    case 'occupied':       return 'occupied';
    case 'vacant_clean':   return 'clean';
    case 'vacant_dirty':   return 'dirty';
    case 'inspected':      return 'clean';      // inspected ≅ ready-to-rent
    case 'out_of_order':   return 'out_of_order';
    case 'unknown':        return null;
    default:               return null;
  }
}
