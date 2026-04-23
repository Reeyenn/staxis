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
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isValidDateStr, errToString } from '@/lib/utils';

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
  try {
    const body: RequestBody = await req.json();
    const { pid, date } = body;

    if (!pid || !date) {
      return NextResponse.json({ error: 'Missing pid or date' }, { status: 400 });
    }
    if (!isValidDateStr(date)) {
      return NextResponse.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 });
    }

    // Pull the plan snapshot for this date — that's the last CSV pull.
    const { data: planRow, error: planErr } = await supabaseAdmin
      .from('plan_snapshots')
      .select('rooms, pulled_at')
      .eq('property_id', pid)
      .eq('date', date)
      .maybeSingle();

    if (planErr) throw planErr;

    if (!planRow) {
      return NextResponse.json(
        { error: `No plan_snapshots row found for (${pid}, ${date}) — no CSV has been pulled for that date yet.` },
        { status: 404 },
      );
    }

    const csvRooms = ((planRow.rooms ?? []) as PlanRoom[]);
    if (csvRooms.length === 0) {
      return NextResponse.json(
        { error: `plan_snapshots row has no rooms array — CSV pull may have failed.` },
        { status: 404 },
      );
    }

    // Pull existing room rows for this date so we can preserve assignments.
    const { data: existing, error: existErr } = await supabaseAdmin
      .from('rooms')
      .select('id, number')
      .eq('property_id', pid)
      .eq('date', date);
    if (existErr) throw existErr;

    const existingByNumber = new Map<string, { id: string }>();
    for (const r of (existing ?? [])) {
      if (r.number) existingByNumber.set(r.number as string, { id: r.id as string });
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
        // Overwrite type + status with CSV baseline. Clear stale progress
        // timestamps (fresh baseline). Preserve assigned_to/assigned_name so
        // Maria's shift Send is not blown away. Preserve is_dnd flags.
        const patch: Record<string, unknown> = {
          type,
          status,
          started_at:   null,
          completed_at: null,
          issue_note:   null,
          help_requested: false,
        };
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

    return NextResponse.json({
      ok: true,
      date,
      created,
      updated,
      total: created + updated,
      csvPulledAt: pulledAt,
    });
  } catch (err: unknown) {
    const msg = errToString(err);
    console.error('[populate-rooms-from-plan] Error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
