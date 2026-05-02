/**
 * POST /api/populate-rooms-from-plan
 *
 * Manual "load all 74 rooms from the CSV" button on the Rooms tab.
 * Reads plan_snapshots(property_id=pid, date=date) (the last CSV pull at 6am or
 * 7pm) and seeds every room in that snapshot into the `rooms` table so the
 * Rooms tab grid shows the full property, not just the 15 rooms Maria assigned.
 *
 * Behavior:
 *   • NEW row (doesn't exist yet) → create with type + status from CSV
 *   • EXISTING row → overwrite type + status from CSV, clear stale progress;
 *     PRESERVE assigned_to/assigned_name/is_dnd/stayover_* so Maria's Send
 *     shift confirmations work and HK progress are not lost.
 *
 * This endpoint is fired only when the user clicks the button. Nothing
 * calls it automatically.
 *
 * Body: { pid, date, uid?: string }  (uid ignored — legacy)
 */
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateDateStr, LIMITS } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

interface RequestBody {
  pid: string;
  date: string;
  /** Legacy — ignored. */
  uid?: string;
}

// CSV room → rooms.type
// Mirrors send-shift-confirmations' logic so both endpoints agree.
//   stayType === 'C/O'             → 'checkout'   (↗ icon)
//   status === 'OCC'               → 'stayover'   (🔒 icon; covers "Stay" AND
//                                                  arrivals where stayType is blank
//                                                  — both have a guest in-room)
//   VAC / OOO / anything else      → 'vacant'     (no icon)
function mapRoomType(
  stayType: string | null | undefined,
  status: string | null | undefined,
): 'checkout' | 'stayover' | 'vacant' {
  if (stayType === 'C/O') return 'checkout';
  if (status === 'OCC') return 'stayover';
  return 'vacant';
}

// CSV `condition` → rooms.status. Anything other than a literal "Clean" is dirty.
function mapRoomStatus(condition: string | null | undefined): 'clean' | 'dirty' {
  return condition === 'Clean' ? 'clean' : 'dirty';
}

type PlanRoom = {
  number: string;
  roomType?: string;
  status?: string | null;          // OCC / VAC / OOO
  condition?: string | null;       // Clean / Dirty
  stayType?: string | null;        // "Stay" | "C/O" | null
  service?: string | null;         // Full / None (Choice brand cycle, ignored)
  stayoverDay?: number | null;
  stayoverMinutes?: number | null;
  arrival?: string | null;
};

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  // Auth: writes/upserts every room row for the date. Without auth, any
  // caller could rewrite our rooms table.
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  try {
    const body = await req.json().catch(() => null) as RequestBody | null;
    if (!body || typeof body !== 'object') {
      return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const pidV = validateUuid(body.pid, 'pid');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const dateV = validateDateStr(body.date, { allowFutureDays: LIMITS.SHIFT_DATE_FUTURE_DAYS, allowPastDays: 14, label: 'date' });
    if (dateV.error) return err(dateV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

    const pid = pidV.value!;
    const date = dateV.value!;

    if (!(await userHasPropertyAccess(session.userId, pid))) {
      return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
    }
    // 20/hour/property is plenty: this is a manual button click that
    // upserts ~74 rows. Anything more than ~1/min is either a bug or abuse.
    const limit = await checkAndIncrementRateLimit('populate-rooms-from-plan', pid);
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

    // Pull the plan snapshot for this date — that's the last CSV pull.
    const { data: planRow, error: planErr } = await supabaseAdmin
      .from('plan_snapshots')
      .select('rooms, pulled_at')
      .eq('property_id', pid)
      .eq('date', date)
      .maybeSingle();

    if (planErr) throw planErr;

    if (!planRow) {
      return err(
        `No plan_snapshots row found for (${pid}, ${date}) — no CSV has been pulled for that date yet.`,
        { requestId, status: 404, code: ApiErrorCode.NotFound },
      );
    }

    const csvRooms = ((planRow.rooms ?? []) as PlanRoom[]);
    if (csvRooms.length === 0) {
      return err(
        `plan_snapshots row has no rooms array — CSV pull may have failed.`,
        { requestId, status: 404, code: ApiErrorCode.NotFound },
      );
    }

    // Pull existing room rows for this date so we can preserve assignments.
    // Include `status` so we can detect rooms that are currently in_progress
    // (housekeeper has tapped Start). The CSV reports "Dirty" for those
    // rooms — the PMS doesn't know about our internal Start tap — and we
    // need to NOT wipe started_at on rooms that are mid-clean.
    const { data: existing, error: existErr } = await supabaseAdmin
      .from('rooms')
      .select('id, number, status')
      .eq('property_id', pid)
      .eq('date', date);
    if (existErr) throw existErr;

    const existingByNumber = new Map<string, { id: string; status: string | null }>();
    for (const r of (existing ?? [])) {
      if (r.number) existingByNumber.set(r.number as string, {
        id: r.id as string,
        status: (r.status as string | null) ?? null,
      });
    }

    let created = 0;
    let updated = 0;

    // Split into two arrays: rows to insert vs rows to update. This lets us
    // issue one insert (efficient) and parallel updates (preserves the
    // per-row PRESERVE semantics for assigned_to/is_dnd/etc.).
    const toInsert: Array<Record<string, unknown>> = [];
    // PromiseLike (not Promise) — Supabase query-builder chains are
    // thenables; Promise.all accepts PromiseLike.
    const updates: PromiseLike<unknown>[] = [];

    for (const csv of csvRooms) {
      const num = csv.number;
      if (!num) continue;

      const type = mapRoomType(csv.stayType, csv.status);
      const status = mapRoomStatus(csv.condition);

      const row = existingByNumber.get(num);
      if (row) {
        // Overwrite type + status with CSV baseline. Preserve assigned_to /
        // assigned_name (so Maria's shift Send isn't blown away) and is_dnd.
        //
        // Timestamps (started_at / completed_at): we used to wipe these
        // any time the CSV reported "dirty" — which the comments below
        // claim was safe ("dirty = real reset"). It wasn't.
        //
        // The PMS only flips a room to "Clean" when housekeeping checks
        // out the room in the PMS. Until that moment, the CSV reports
        // "Dirty" — even while a housekeeper is mid-clean. So a clean
        // that takes longer than the scraper interval (60 min) lost its
        // started_at to the next hourly pull, and when the housekeeper
        // finally tapped Done the page fell back to started_at =
        // completed_at and the cleaning_event landed with duration 0
        // and got auto-discarded as under_3min.
        //
        // Maria 2026-05-02: 'everyone is using Start and Done correctly'
        // — and yet 70 of 76 events on production were sub-3-min. This
        // was the cause.
        //
        // Fix: when the room is currently in_progress in OUR table, the
        // housekeeper has tapped Start and not yet Done; the CSV has no
        // way to know that, so its "dirty" reading is stale relative to
        // our state. Preserve our timestamps. Only wipe when the room is
        // genuinely between cleans (not in_progress).
        const patch: Record<string, unknown> = {
          type,
          status,
          issue_note:   null,
          help_requested: false,
        };
        const isMidClean = row.status === 'in_progress';
        if (status === 'dirty' && !isMidClean) {
          patch.started_at = null;
          patch.completed_at = null;
        }
        // Don't downgrade an in_progress room to dirty. Dirty is the
        // PMS-baseline view; in_progress is OUR view of housekeeping
        // state. Letting the CSV overwrite would also drop the room
        // out of the active-cleaning UI mid-shift.
        if (isMidClean) {
          patch.status = 'in_progress';
        }
        if (csv.stayoverDay !== null && csv.stayoverDay !== undefined) {
          patch.stayover_day = csv.stayoverDay;
        } else {
          patch.stayover_day = null;
        }
        if (csv.stayoverMinutes !== null && csv.stayoverMinutes !== undefined) {
          patch.stayover_minutes = csv.stayoverMinutes;
        } else {
          patch.stayover_minutes = null;
        }
        if (csv.arrival !== null && csv.arrival !== undefined) {
          patch.arrival = csv.arrival;
        } else {
          patch.arrival = null;
        }
        updates.push(
          supabaseAdmin
            .from('rooms')
            .update(patch)
            .eq('id', row.id)
            .then(({ error }) => { if (error) throw error; }),
        );
        updated++;
      } else {
        // New row — seed everything.
        const payload: Record<string, unknown> = {
          property_id: pid,
          number: num,
          date,
          type,
          status,
          priority: 'standard',
        };
        if (csv.stayoverDay !== null && csv.stayoverDay !== undefined) {
          payload.stayover_day = csv.stayoverDay;
        }
        if (csv.stayoverMinutes !== null && csv.stayoverMinutes !== undefined) {
          payload.stayover_minutes = csv.stayoverMinutes;
        }
        if (csv.arrival) {
          payload.arrival = csv.arrival;
        }
        toInsert.push(payload);
        created++;
      }
    }

    // Insert the new ones in one batch. On-conflict upsert guards against a
    // racy double-click creating duplicates.
    if (toInsert.length > 0) {
      const { error: insErr } = await supabaseAdmin
        .from('rooms')
        .upsert(toInsert, { onConflict: 'property_id,date,number' });
      if (insErr) throw insErr;
    }

    if (updates.length > 0) {
      await Promise.all(updates);
    }

    const pulledAt = planRow.pulled_at ? String(planRow.pulled_at) : null;

    return ok({
      date,
      created,
      updated,
      total: created + updated,
      csvPulledAt: pulledAt,
    }, { requestId });
  } catch (caughtErr: unknown) {
    // Don't echo errToString back — Postgres / supabase-js errors leak
    // schema details. Log full error server-side, generic 500 to caller.
    console.error('[populate-rooms-from-plan] Error:', errToString(caughtErr));
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
