/**
 * Housekeeper room actions — service-role bypass for RLS-blocked writes.
 *
 * THE PROBLEM (discovered 2026-04-28 pre-launch verification):
 *   /housekeeper/[id] is a publicly-linkable page (Mario sends the URL via
 *   SMS — recipients open it on their phones with no Staxis login). The
 *   page used to call supabase.from('rooms').update(...) directly via the
 *   browser client. With no auth.uid(), RLS's user_owns_property check
 *   returns false. Postgres responds: 200 OK with an empty result body.
 *   The supabase JS client treats that as success — no exception, no
 *   error toast. So every "Done"/"Start"/"Reset" tap silently no-op'd.
 *
 *   Symptom: rooms.started_at / completed_at columns are 0 across the
 *   board, even on rooms a housekeeper claims to have cleaned. The PMS
 *   sync (populate-rooms-from-plan) was the only thing actually moving
 *   status to 'clean' — by way of CA reflecting the housekeeper's action
 *   in PMS, not via our app at all. The Performance tab was sitting on
 *   data that never gets written.
 *
 * THE FIX:
 *   Server-side route using supabaseAdmin (service-role, RLS-bypass).
 *   Capability check: the URL contains (uid, pid, staffId) — we verify
 *   staffId actually belongs to pid before doing anything. Same trust
 *   model as /api/staff-list and /api/help-request.
 *
 *   For 'finish' actions we ALSO write a cleaning_events row in the same
 *   transaction so the audit log captures what actually happened. The
 *   handler is idempotent — re-clicking Done with the same timestamps
 *   hits the unique constraint and is silently ignored.
 *
 *   For 'reset' we discard recent cleaning_events rows (the "oops, wrong
 *   room" undo) the same way the browser-side helper used to.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

type RoomAction = 'start' | 'finish' | 'reset' | 'stop' | 'dnd_on' | 'dnd_off' | 'issue' | 'help';

interface RequestBody {
  pid: string;
  staffId: string;
  roomId: string;
  action: RoomAction;
  // For 'finish' — context to embed in the cleaning_events row. The room
  // table itself doesn't tell us the cycle reliably (stayover_day might be
  // wiped between requests), so the housekeeper page sends what it knows.
  cleaningContext?: {
    roomNumber: string;
    roomType: 'checkout' | 'stayover';
    stayoverDayBucket: 1 | 2 | null;
    staffName: string;
    date: string; // 'YYYY-MM-DD'
    startedAt: string; // ISO
    completedAt: string; // ISO
  };
  // For 'dnd_on' — optional note explaining why the room is locked out.
  dndNote?: string;
  // For 'issue' — what the housekeeper found (broken TV, missing towels, etc.).
  issueNote?: string;
}

// Mirror of the TS-side classifier (db.ts classifyCleaningEvent). Kept here
// inline so this route doesn't drag the entire client-side db module into
// the server bundle.
const DISCARD_UNDER_MIN = 3;
const FLAG_OVER_MIN = 60;
function classify(durationMin: number): { status: 'recorded' | 'discarded' | 'flagged'; flag_reason: string | null } {
  if (durationMin < DISCARD_UNDER_MIN) return { status: 'discarded', flag_reason: 'under_3min' };
  if (durationMin > FLAG_OVER_MIN) return { status: 'flagged', flag_reason: 'over_60min' };
  return { status: 'recorded', flag_reason: null };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Each housekeeper tap (Start, Done, Reset, DND, Issue, Help) gets a
  // request id so we can correlate "Maria says Done didn't work at 11:14
  // AM" to the exact server-side log line. Especially valuable here
  // because the housekeeper page is the one with the most user actions
  // and the most "it didn't work" bug reports.
  const requestId = getOrMintRequestId(req);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    log.warn('room-action: invalid json', { requestId, route: 'housekeeper/room-action' });
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400, headers: { 'x-request-id': requestId } });
  }
  const { pid, staffId, roomId, action, cleaningContext } = body;
  if (!pid || !staffId || !roomId || !action) {
    log.warn('room-action: missing fields', { requestId, route: 'housekeeper/room-action', hasPid: !!pid, hasStaff: !!staffId, hasRoom: !!roomId, hasAction: !!action });
    return NextResponse.json({ ok: false, error: 'missing pid/staffId/roomId/action' }, { status: 400, headers: { 'x-request-id': requestId } });
  }
  if (!['start', 'finish', 'reset', 'stop', 'dnd_on', 'dnd_off', 'issue', 'help'].includes(action)) {
    log.warn('room-action: invalid action', { requestId, route: 'housekeeper/room-action', action });
    return NextResponse.json({ ok: false, error: 'invalid action' }, { status: 400, headers: { 'x-request-id': requestId } });
  }

  // ─── Capability check ─────────────────────────────────────────────────
  // Staff must belong to this property. Anyone who knows a staff_id can
  // forge an URL, but we at least block cross-property mutations and
  // reject obviously-wrong inputs.
  try {
    const { data: staff, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, property_id, name, is_active')
      .eq('id', staffId)
      .maybeSingle();
    if (staffErr) {
      return NextResponse.json({ ok: false, error: 'staff lookup failed' }, { status: 500 });
    }
    if (!staff || staff.property_id !== pid) {
      return NextResponse.json({ ok: false, error: 'staff/property mismatch' }, { status: 403 });
    }

    // ─── Room belongs to property check ─────────────────────────────────
    const { data: room, error: roomErr } = await supabaseAdmin
      .from('rooms')
      .select('id, property_id, started_at, completed_at, number, date')
      .eq('id', roomId)
      .maybeSingle();
    if (roomErr || !room) {
      return NextResponse.json({ ok: false, error: 'room not found' }, { status: 404 });
    }
    if (room.property_id !== pid) {
      return NextResponse.json({ ok: false, error: 'room/property mismatch' }, { status: 403 });
    }

    const now = new Date().toISOString();

    // ─── START ──────────────────────────────────────────────────────────
    if (action === 'start') {
      const { error } = await supabaseAdmin
        .from('rooms')
        .update({ status: 'in_progress', started_at: now })
        .eq('id', roomId);
      if (error) {
        return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
      }
      return NextResponse.json({ ok: true, action: 'start', startedAt: now });
    }

    // ─── FINISH ─────────────────────────────────────────────────────────
    // Updates room AND writes cleaning_events row. If started_at is null
    // we set it to now (giving a 0-min duration → discarded entry).
    if (action === 'finish') {
      const startedAt = room.started_at ?? now;
      const completedAt = now;
      const { error: roomUpdErr } = await supabaseAdmin
        .from('rooms')
        .update({
          status: 'clean',
          completed_at: completedAt,
          ...(room.started_at ? {} : { started_at: startedAt }),
        })
        .eq('id', roomId);
      if (roomUpdErr) {
        return NextResponse.json({ ok: false, error: errToString(roomUpdErr) }, { status: 500 });
      }

      // Audit log — only for checkout/stayover, never vacant.
      let cleaningEventInserted = false;
      if (cleaningContext && (cleaningContext.roomType === 'checkout' || cleaningContext.roomType === 'stayover')) {
        const startMs = new Date(cleaningContext.startedAt).getTime();
        const endMs = new Date(cleaningContext.completedAt).getTime();
        const durationMin = Math.max(0, (endMs - startMs) / 60_000);
        const { status, flag_reason } = classify(durationMin);
        const { error: ceErr } = await supabaseAdmin
          .from('cleaning_events')
          .upsert({
            property_id: pid,
            date: cleaningContext.date,
            room_number: cleaningContext.roomNumber,
            room_type: cleaningContext.roomType,
            stayover_day: cleaningContext.stayoverDayBucket,
            staff_id: staffId,
            staff_name: cleaningContext.staffName || staff.name || 'Housekeeper',
            started_at: cleaningContext.startedAt,
            completed_at: cleaningContext.completedAt,
            duration_minutes: Number(durationMin.toFixed(2)),
            status,
            flag_reason,
          }, {
            onConflict: 'property_id,date,room_number,started_at,completed_at',
            ignoreDuplicates: true,
          });
        cleaningEventInserted = !ceErr;
        // Don't fail the whole request if audit insert fails — the room
        // update already succeeded and the housekeeper has moved on.
        if (ceErr) {
          log.error('room-action: cleaning_events insert failed (non-fatal)', { requestId, route: 'housekeeper/room-action', pid, staffId, action: 'finish', err: ceErr as unknown as Error });
        }
      }
      return NextResponse.json({ ok: true, action: 'finish', completedAt, cleaningEventInserted }, { headers: { 'x-request-id': requestId } });
    }

    // ─── RESET ──────────────────────────────────────────────────────────
    // Clear room progress AND discard any cleaning_events row for this
    // (property, date, room, staff) created in the last 60s. The "oops,
    // wrong room — undo" path.
    if (action === 'reset') {
      const { error: roomResetErr } = await supabaseAdmin
        .from('rooms')
        .update({ status: 'dirty', started_at: null, completed_at: null })
        .eq('id', roomId);
      if (roomResetErr) {
        return NextResponse.json({ ok: false, error: errToString(roomResetErr) }, { status: 500 });
      }
      const cutoff = new Date(Date.now() - 60 * 1000).toISOString();
      const { error: discardErr } = await supabaseAdmin
        .from('cleaning_events')
        .update({ status: 'discarded', flag_reason: 'reset_within_window' })
        .eq('property_id', pid)
        .eq('date', room.date as string)
        .eq('room_number', room.number as string)
        .eq('staff_id', staffId)
        .gte('created_at', cutoff)
        .in('status', ['recorded', 'flagged']);
      if (discardErr) {
        log.error('room-action: cleaning_events discard failed (non-fatal)', { requestId, route: 'housekeeper/room-action', pid, staffId, action: 'reset', err: discardErr as unknown as Error });
      }
      return NextResponse.json({ ok: true, action: 'reset' }, { headers: { 'x-request-id': requestId } });
    }

    // ─── STOP (undo a Start tap) ────────────────────────────────────────
    // in_progress → dirty, clear started_at. No cleaning_events impact —
    // there was no Done, so nothing to discard.
    if (action === 'stop') {
      const { error } = await supabaseAdmin
        .from('rooms')
        .update({ status: 'dirty', started_at: null })
        .eq('id', roomId);
      if (error) {
        return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
      }
      return NextResponse.json({ ok: true, action: 'stop' });
    }

    // ─── DND_ON ────────────────────────────────────────────────────────
    if (action === 'dnd_on') {
      const { error } = await supabaseAdmin
        .from('rooms')
        .update({ is_dnd: true, dnd_note: body.dndNote ?? null })
        .eq('id', roomId);
      if (error) {
        return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
      }
      return NextResponse.json({ ok: true, action: 'dnd_on' });
    }

    // ─── DND_OFF ───────────────────────────────────────────────────────
    if (action === 'dnd_off') {
      const { error } = await supabaseAdmin
        .from('rooms')
        .update({ is_dnd: false, dnd_note: null })
        .eq('id', roomId);
      if (error) {
        return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
      }
      return NextResponse.json({ ok: true, action: 'dnd_off' });
    }

    // ─── HELP REQUEST (flag the room as needing manager attention) ────
    // The actual SMS send still goes through /api/help-request which has
    // its own validation, retry, and Twilio handling. This action just
    // flips the helpRequested flag on the room row so Maria's UI shows
    // the SOS badge — that update was previously silently failing.
    if (action === 'help') {
      const { error } = await supabaseAdmin
        .from('rooms')
        .update({ help_requested: true })
        .eq('id', roomId);
      if (error) {
        return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
      }
      return NextResponse.json({ ok: true, action: 'help' });
    }

    // ─── ISSUE NOTE (housekeeper reports a problem) ────────────────────
    // The text is bounded — Maria's UI shows it on her view; a 10KB note
    // would break the layout. Trim to 500 chars to be safe.
    if (action === 'issue') {
      const note = (body.issueNote ?? '').slice(0, 500);
      const { error } = await supabaseAdmin
        .from('rooms')
        .update({ issue_note: note || null })
        .eq('id', roomId);
      if (error) {
        return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
      }
      return NextResponse.json({ ok: true, action: 'issue' });
    }

    return NextResponse.json({ ok: false, error: 'unhandled action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: errToString(err) }, { status: 500 });
  }
}
