/**
 * POST /api/sync-room-assignments
 *
 * Mirrors the room-level `assigned_to`/`assigned_name` writes that
 * /api/send-shift-confirmations does — BUT without sending any SMS or
 * touching shift_confirmations.
 *
 * Called by the Schedule tab's debounced autosave so that every drag-and-drop
 * change is reflected on the `rooms` rows themselves in real time. This fixes
 * the bug where clicking the crew-row "Link" button before hitting Send would
 * open the HK's page with stale (or no) rooms — because the HK page queries
 * `rooms where assigned_to = staffId` and only the Send flow used to write
 * that field.
 *
 * Body:
 *   {
 *     pid, shiftDate,                           // required
 *     staff: [
 *       { staffId, staffName, assignedRooms }  // room NUMBERS
 *     ],
 *     allowClearAll?: boolean,                  // bypass "all empty" failsafe
 *     uid?: string,                             // legacy — ignored
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isValidDateStr, errToString } from '@/lib/utils';

interface StaffEntry {
  staffId: string;
  staffName: string;
  assignedRooms?: string[];
}

interface RequestBody {
  pid: string;
  shiftDate: string;
  staff: StaffEntry[];
  allowClearAll?: boolean;
  uid?: string;
}

type PlanRoom = { number: string; stayType?: string | null };

function deriveRoomType(
  number: string,
  planRooms: PlanRoom[] | null,
): 'checkout' | 'stayover' {
  if (!planRooms) return 'checkout';
  const match = planRooms.find(r => r.number === number);
  if (!match) return 'checkout';
  return match.stayType === 'Stay' ? 'stayover' : 'checkout';
}

export async function POST(req: NextRequest) {
  try {
    const body: RequestBody = await req.json();
    const { pid, shiftDate, staff } = body;

    if (!pid || !shiftDate || !Array.isArray(staff)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!isValidDateStr(shiftDate)) {
      return NextResponse.json({ error: 'Invalid shiftDate' }, { status: 400 });
    }

    // ── Failsafe: refuse to wipe all assignments without explicit opt-in ────
    const hasAnyAssignment = staff.some(s => (s.assignedRooms ?? []).length > 0);
    const allowClearAll = body.allowClearAll === true;
    if (!hasAnyAssignment && !allowClearAll) {
      return NextResponse.json({
        error: 'Refusing to clear all room assignments without allowClearAll=true',
      }, { status: 400 });
    }

    // Pull plan snapshot so we can seed any new (future-date) rooms with the
    // correct checkout/stayover flag — same behaviour as send-shift-confirmations.
    const { data: planRow } = await supabaseAdmin
      .from('plan_snapshots')
      .select('rooms')
      .eq('property_id', pid)
      .eq('date', shiftDate)
      .maybeSingle();
    const planRooms = (planRow?.rooms as PlanRoom[] | null) ?? null;

    // Build the (roomNumber → who) map.
    const assignmentMap = new Map<string, { staffId: string; staffName: string }>();
    for (const entry of staff) {
      for (const num of (entry.assignedRooms ?? [])) {
        assignmentMap.set(num, { staffId: entry.staffId, staffName: entry.staffName });
      }
    }

    const { data: existing, error: roomsErr } = await supabaseAdmin
      .from('rooms')
      .select('id, number, assigned_to, assigned_name')
      .eq('property_id', pid)
      .eq('date', shiftDate);
    if (roomsErr) throw roomsErr;

    const existingByNumber = new Map<string, {
      id: string;
      number: string;
      assigned_to: string | null;
      assigned_name: string | null;
    }>();
    for (const r of (existing ?? [])) {
      if (r.number) existingByNumber.set(r.number as string, {
        id: r.id as string,
        number: r.number as string,
        assigned_to: (r.assigned_to as string | null) ?? null,
        assigned_name: (r.assigned_name as string | null) ?? null,
      });
    }

    const toInsert: Array<Record<string, unknown>> = [];
    // PromiseLike (not Promise) — Supabase query-builder chains are
    // thenables; Promise.all accepts PromiseLike.
    const updates: PromiseLike<unknown>[] = [];
    let writes = 0;

    // Assign / update rooms that are in the new assignment map.
    for (const [num, who] of assignmentMap) {
      const row = existingByNumber.get(num);
      if (row) {
        if (row.assigned_to !== who.staffId || row.assigned_name !== who.staffName) {
          updates.push(
            supabaseAdmin
              .from('rooms')
              .update({ assigned_to: who.staffId, assigned_name: who.staffName })
              .eq('id', row.id)
              .then(({ error }) => { if (error) throw error; }),
          );
          writes++;
        }
      } else {
        toInsert.push({
          property_id: pid,
          number: num,
          date: shiftDate,
          type: deriveRoomType(num, planRooms),
          status: 'dirty',
          priority: 'standard',
          assigned_to: who.staffId,
          assigned_name: who.staffName,
        });
        writes++;
      }
    }

    // Clear assignments on rooms that USED to be assigned but aren't anymore.
    for (const [num, row] of existingByNumber) {
      if (assignmentMap.has(num)) continue;
      if (!row.assigned_to) continue;
      updates.push(
        supabaseAdmin
          .from('rooms')
          .update({ assigned_to: null, assigned_name: null })
          .eq('id', row.id)
          .then(({ error }) => { if (error) throw error; }),
      );
      writes++;
    }

    if (toInsert.length > 0) {
      const { error: insErr } = await supabaseAdmin
        .from('rooms')
        .upsert(toInsert, { onConflict: 'property_id,date,number' });
      if (insErr) throw insErr;
    }
    if (updates.length > 0) {
      await Promise.all(updates);
    }

    return NextResponse.json({ ok: true, writes });
  } catch (err) {
    console.error('sync-room-assignments error:', err);
    try {
      await supabaseAdmin.from('error_logs').insert({
        source: '/api/sync-room-assignments',
        message: errToString(err),
        stack: err instanceof Error ? err.stack ?? null : null,
      });
    } catch {}
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
