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
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { deriveCleaningEventFeatures } from '@/lib/feature-derivation';
import { incrementMLFailureCounter } from '@/lib/ml-failure-counters';
import { deriveStartedAtPure } from '@/lib/cleaning-event-derivation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

type RoomAction = 'finish' | 'reset' | 'dnd_on' | 'dnd_off' | 'issue' | 'help';

interface RequestBody {
  pid: string;
  staffId: string;
  roomId: string;
  action: RoomAction;
  // For 'finish' — context to embed in the cleaning_events row. The room
  // table itself doesn't tell us the cycle reliably (stayover_day might be
  // wiped between requests), so the housekeeper page sends what it knows.
  //
  // 2026-05-07: `startedAt` is now ADVISORY ONLY. The server derives the
  // canonical started_at itself (see deriveStartedAt below). Reason: the
  // housekeeper page used to require a per-room Start tap before Done, and
  // housekeepers chronically skipped it — Done with no prior Start meant
  // started_at = completed_at, duration = 0, status='discarded'. That's
  // exactly Maria's "cleaning events show day 1, blank day 2" complaint.
  // We now collapse the per-room flow to a single Done tap, and the server
  // reconstructs a sensible started_at from prior cleaning events and the
  // housekeeper's shift-start anchor.
  cleaningContext?: {
    roomNumber: string;
    roomType: 'checkout' | 'stayover';
    stayoverDayBucket: 1 | 2 | null;
    staffName: string;
    date: string; // 'YYYY-MM-DD'
    startedAt: string; // ISO — advisory only; server derives canonical value
    completedAt: string; // ISO
    shiftStartedAt?: string; // ISO — when the housekeeper tapped "Start Shift"
                             // on their phone (kept in localStorage on their
                             // device). Used as the started_at anchor for the
                             // first room of the day if no prior clean exists.
  };
  // For 'dnd_on' — optional note explaining why the room is locked out.
  dndNote?: string;
  // For 'issue' — what the housekeeper found (broken TV, missing towels, etc.).
  issueNote?: string;
}

// Mirror of the TS-side classifier (db.ts classifyCleaningEvent). Kept here
// inline so this route doesn't drag the entire client-side db module into
// the server bundle.
//
// Threshold tiers (Reeyen, 2026-05-01):
//   • duration < 3 min                 → 'discarded' (under_3min)
//   • duration in [3, 60] min          → 'recorded'  (counts toward averages)
//   • duration > 60 min and ≤ 90 min   → 'flagged'   (Maria reviews)
//   • duration > 90 min                → 'discarded' (over_90min)
//                                        almost certainly a forgot-to-tap-Done
//                                        event. Auto-remove rather than burying
//                                        Maria in pointless review work.
const DISCARD_UNDER_MIN = 3;
const FLAG_OVER_MIN = 60;
const DISCARD_OVER_MIN = 90;
/**
 * Derive a sensible started_at for a "finish" tap, server-side.
 *
 * Thin wrapper: looks up the most recent prior cleaning_event for this
 * (pid, staffId, date) in Postgres, then hands all four candidate
 * anchors to `deriveStartedAtPure` for the actual decision logic.
 *
 * The pure function is unit-tested in
 * src/lib/__tests__/cleaning-event-derivation.test.ts — that's where
 * the hard cases live (rapid Done batches, stale shift anchors, etc.).
 */
async function deriveStartedAt(args: {
  pid: string;
  staffId: string;
  date: string;
  completedAt: string;
  roomType: 'checkout' | 'stayover';
  shiftStartedAt: string | null;
}): Promise<string> {
  // Server source-of-truth for the shift_start anchor (audit/concurrency
  // #2). Pre-fix the anchor lived in the housekeeper's device-local
  // localStorage, so switching phones mid-shift produced inconsistent
  // anchors and skewed cleaning_events.duration_minutes for the new
  // device's rows. Now: the first cleanable Done locks in
  // schedule_assignments.shift_starts[staffId] via a get-or-set RPC;
  // every subsequent Done on any device for the same shift reads the
  // same canonical anchor. The client-passed shiftStartedAt is the
  // first-write candidate; if the server already has one, it wins.
  let canonicalShiftStart: string | null = args.shiftStartedAt;
  try {
    const candidate = args.shiftStartedAt ?? args.completedAt;
    const { data: serverAt, error: rpcErr } = await supabaseAdmin.rpc(
      'staxis_get_or_set_shift_start',
      {
        p_property: args.pid,
        p_date: args.date,
        p_staff: args.staffId,
        p_default_at: candidate,
      },
    );
    if (!rpcErr && typeof serverAt === 'string' && serverAt) {
      canonicalShiftStart = serverAt;
    }
  } catch {
    // Best-effort — fall back to the client's shiftStartedAt (legacy
    // behavior). The deriveStartedAtPure helper has its own synthetic
    // fallback when both are null.
  }

  let priorCompletedAt: string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('cleaning_events')
      .select('completed_at')
      .eq('property_id', args.pid)
      .eq('staff_id', args.staffId)
      .eq('date', args.date)
      .neq('status', 'discarded')
      .lt('completed_at', args.completedAt)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.completed_at) {
      priorCompletedAt = data.completed_at as string;
    }
  } catch {
    // Lookup failure → behave as if no prior cleaning. The pure function
    // will fall through to the shift anchor or the synthetic fallback.
  }

  return deriveStartedAtPure({
    completedAt: args.completedAt,
    priorCompletedAt,
    shiftStartedAt: canonicalShiftStart,
    roomType: args.roomType,
  });
}

function classify(durationMin: number): { status: 'recorded' | 'discarded' | 'flagged'; flag_reason: string | null } {
  if (durationMin < DISCARD_UNDER_MIN) return { status: 'discarded', flag_reason: 'under_3min' };
  if (durationMin > DISCARD_OVER_MIN) return { status: 'discarded', flag_reason: 'over_90min' };
  if (durationMin > FLAG_OVER_MIN)    return { status: 'flagged',   flag_reason: 'over_60min' };
  return { status: 'recorded', flag_reason: null };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Each housekeeper tap (Start, Done, Reset, DND, Issue, Help) gets a
  // request id so we can correlate "Maria says Done didn't work at 11:14
  // AM" to the exact server-side log line. Especially valuable here
  // because the housekeeper page is the one with the most user actions
  // and the most "it didn't work" bug reports.
  const requestId = getOrMintRequestId(req);

  // Echo requestId via header — keeps the server-side correlation chain
  // intact even when callers don't read the body (legacy `.catch()` paths).
  const headers = { 'x-request-id': requestId };

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    log.warn('room-action: invalid json', { requestId, route: 'housekeeper/room-action' });
    return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  }
  const { pid, staffId, roomId, action, cleaningContext } = body;
  if (!pid || !staffId || !roomId || !action) {
    log.warn('room-action: missing fields', { requestId, route: 'housekeeper/room-action', hasPid: !!pid, hasStaff: !!staffId, hasRoom: !!roomId, hasAction: !!action });
    return err('missing pid/staffId/roomId/action', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  if (!['finish', 'reset', 'dnd_on', 'dnd_off', 'issue', 'help'].includes(action)) {
    log.warn('room-action: invalid action', { requestId, route: 'housekeeper/room-action', action });
    return err('invalid action', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
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
      return err('staff lookup failed', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
    }
    if (!staff || staff.property_id !== pid) {
      return err('staff/property mismatch', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });
    }

    // ─── Room belongs to property AND assigned to this staff ───────────
    // 2026-05-12: previously this only checked room.property_id === pid.
    // That meant any valid (pid, staffId) tuple could mutate ANY room in
    // that property — including rooms assigned to other housekeepers.
    // Staff UUIDs are listable via the public /api/staff-list endpoint,
    // so the property + staffId pair isn't a strong capability on its
    // own. The housekeeper's link only ever shows them their assigned
    // rooms (via /api/housekeeper/rooms, which filters by
    // assigned_to=staffId), so applying the same scoping on the write
    // path closes the gap without breaking legitimate UI flows.
    const { data: room, error: roomErr } = await supabaseAdmin
      .from('rooms')
      .select('id, property_id, started_at, completed_at, number, date, assigned_to')
      .eq('id', roomId)
      .maybeSingle();
    if (roomErr || !room) {
      return err('room not found', { requestId, status: 404, code: ApiErrorCode.NotFound, headers });
    }
    if (room.property_id !== pid) {
      return err('room/property mismatch', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });
    }
    // 2026-05-12 (pre-merge review fix): allow null assigned_to. The
    // schema has `assigned_to uuid references staff(id) on delete set
    // null` (migration 0001), so when a housekeeper is deleted mid-day
    // their rooms cascade to NULL. A strict `!==` here would reject any
    // other housekeeper picking up that work — a real recovery flow.
    // Only reject when the room is ACTIVELY assigned to a DIFFERENT
    // staff member.
    if (room.assigned_to && room.assigned_to !== staffId) {
      // Same response shape as room/property mismatch so we don't reveal
      // which side of the pair was wrong to an enumerator.
      return err('room not assigned to this staff', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });
    }

    const now = new Date().toISOString();

    // ─── START ── REMOVED 2026-05-07 ────────────────────────────────────
    // Per-room Start was removed when we collapsed the housekeeper flow
    // to a single Done tap (Maria's request). The 'start' action and the
    // matching 'stop' below used to set rooms.status='in_progress' and
    // capture lastStartedOccupancy from scraper_status. Both are gone.
    //
    // Backward compat: any older client bundle (cached on a HK's phone)
    // that still sends action='start' will hit the validation list above
    // and get a 400 — same as any unknown action. The HK sees an error
    // toast and refreshes, picking up the new bundle without per-room
    // Start. Brief transitional pain is preferable to keeping dead
    // server branches alive forever.
    //
    // The 'occupancy_at_start' ML feature is now derived at Done time
    // by deriveCleaningEventFeatures (which reads scraper_status itself
    // — same source, just queried later in the flow).

    // ─── FINISH ─────────────────────────────────────────────────────────
    // Updates room AND writes cleaning_events row with ML feature snapshot.
    //
    // 2026-05-07: With per-room Start gone, room.started_at is null at this
    // point on the new flow. We derive a canonical started_at server-side
    // (see deriveStartedAt below) and write it to BOTH the rooms table and
    // the cleaning_events row, so any UI reading "Cleaned in X min" off
    // the rooms table sees the same number as the Performance tab.
    if (action === 'finish') {
      // Single canonical "Done time" for both rooms.completed_at AND
      // cleaning_events.completed_at. Previously the rooms row used
      // server-now while cleaning_events used cleaningContext.completedAt
      // (client tap time) — they could differ by hundreds of ms due to
      // network latency, breaking any UI cross-referencing the two.
      // Prefer the client tap time when supplied (more accurate "moment
      // the housekeeper hit Done"); fall back to server-now for vacant
      // rooms or any flow without a cleaningContext.
      const completedAt = cleaningContext?.completedAt ?? now;
      const isCleanable = !!cleaningContext && (cleaningContext.roomType === 'checkout' || cleaningContext.roomType === 'stayover');

      // ─── Idempotency guard for retries ────────────────────────────
      // Network-retry scenario: HK taps Done, request times out at 30s,
      // server actually completed in 100ms. HK manually retaps. Without
      // this guard the second tap inserts a SECOND cleaning_event row
      // with slightly different started_at and completedAt — the unique
      // constraint doesn't catch it because both timestamps moved.
      // Performance tab then shows the room cleaned twice.
      //
      // 90s window: long enough to absorb retries; shorter than the
      // 'reset' undo window above (60s) so legitimate "I cleaned it,
      // realized I marked the wrong room, reset, re-cleaned" still
      // works (the reset would have marked the prior row 'discarded'
      // which our query filters out).
      let isDuplicate = false;
      if (isCleanable && cleaningContext) {
        const dedupeWindow = new Date(Date.now() - 90_000).toISOString();
        const { data: recent } = await supabaseAdmin
          .from('cleaning_events')
          .select('id, completed_at')
          .eq('property_id', pid)
          .eq('staff_id', staffId)
          .eq('room_number', cleaningContext.roomNumber)
          .eq('date', cleaningContext.date)
          .neq('status', 'discarded')
          .gte('completed_at', dedupeWindow)
          .order('completed_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (recent) isDuplicate = true;
      }

      // Derive canonical started_at for cleanable rooms. Vacant rooms
      // don't get a cleaning_events row, so they get no derivation.
      // Skip the deriveStartedAt query entirely on duplicates — saves a
      // round-trip on retries.
      let derivedStartedAt: string | null = null;
      if (isCleanable && cleaningContext && !isDuplicate) {
        derivedStartedAt = await deriveStartedAt({
          pid,
          staffId,
          date: cleaningContext.date,
          completedAt,
          roomType: cleaningContext.roomType,
          shiftStartedAt: cleaningContext.shiftStartedAt ?? null,
        });
      }

      // The rooms.started_at value: derived for cleanable rooms (so UI
      // shows the same duration as Performance tab); preserve any legacy
      // value otherwise; fall back to completedAt for vacant.
      const roomStartedAt = derivedStartedAt ?? room.started_at ?? completedAt;
      const { error: roomUpdErr } = await supabaseAdmin
        .from('rooms')
        .update({
          status: 'clean',
          completed_at: completedAt,
          started_at: roomStartedAt,
        })
        .eq('id', roomId);
      if (roomUpdErr) {
        // Don't leak raw DB error text (column names, constraint names, schema
        // hints) to a public-link caller. Log internally; respond generically.
        log.error('room-action: room update failed (finish)', { requestId, pid, staffId, err: errToString(roomUpdErr) });
        return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
      }

      // Audit log + ML feature snapshot — only for checkout/stayover, never
      // vacant, and never on a deduped retry (derivedStartedAt would be null
      // for those, but be explicit).
      let cleaningEventInserted = false;
      if (!isDuplicate && cleaningContext && derivedStartedAt && (cleaningContext.roomType === 'checkout' || cleaningContext.roomType === 'stayover')) {
        // Both rooms.completed_at and cleaning_events.completed_at use the
        // same `completedAt` (the canonical Done time computed above).
        const startMs = new Date(derivedStartedAt).getTime();
        const endMs = new Date(completedAt).getTime();
        const durationMin = Math.max(0, (endMs - startMs) / 60_000);
        const { status, flag_reason } = classify(durationMin);

        // Derive ML features. All failures are non-fatal and logged separately.
        let features = {
          dayOfWeek: null as number | null,
          dayOfStayRaw: null as number | null,
          roomFloor: null as number | null,
          occupancyAtStart: null as number | null,
          totalCheckoutsToday: null as number | null,
          totalRoomsAssignedToHk: null as number | null,
          routePosition: null as number | null,
          minutesSinceShiftStart: null as number | null,
          wasDndDuringClean: null as boolean | null,
          weatherClass: null as string | null,
        };
        try {
          features = await deriveCleaningEventFeatures({
            propertyId: pid,
            date: cleaningContext.date,
            roomNumber: cleaningContext.roomNumber,
            staffId,
            startedAt: new Date(derivedStartedAt),
            completedAt: new Date(completedAt),
          });
        } catch (featureErr) {
          log.error('room-action: feature derivation threw (unexpected)', {
            requestId, pid, staffId, action: 'finish', err: featureErr as unknown as Error
          });
          // Smoke-detector: deriveCleaningEventFeatures already swallows its
          // own internal failures and returns null fields, so reaching this
          // outer catch means an upstream contract broke (schema drift,
          // helper signature change, etc.). Bump the counter so the doctor
          // surfaces it before the supply model retrains on null-padded data.
          await incrementMLFailureCounter(pid, 'feature_derivation', featureErr);
          // Continue with null features — the insert must proceed.
        }

        const cePayload: Record<string, unknown> = {
          property_id: pid,
          date: cleaningContext.date,
          room_number: cleaningContext.roomNumber,
          room_type: cleaningContext.roomType,
          stayover_day: cleaningContext.stayoverDayBucket,
          staff_id: staffId,
          staff_name: cleaningContext.staffName || staff.name || 'Housekeeper',
          started_at: derivedStartedAt,
          completed_at: completedAt,
          duration_minutes: Number(durationMin.toFixed(2)),
          status,
          flag_reason,
          // ML features
          day_of_week: features.dayOfWeek,
          day_of_stay_raw: features.dayOfStayRaw,
          room_floor: features.roomFloor,
          occupancy_at_start: features.occupancyAtStart,
          total_checkouts_today: features.totalCheckoutsToday,
          total_rooms_assigned_to_hk: features.totalRoomsAssignedToHk,
          route_position: features.routePosition,
          minutes_since_shift_start: features.minutesSinceShiftStart,
          was_dnd_during_clean: features.wasDndDuringClean,
          weather_class: features.weatherClass,
        };

        const { error: ceErr } = await supabaseAdmin
          .from('cleaning_events')
          .upsert(cePayload, {
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
      return ok({ action: 'finish', completedAt, cleaningEventInserted, deduped: isDuplicate }, { requestId, headers });
    }

    // ─── RESET ──────────────────────────────────────────────────────────
    // Clear room progress AND discard the most recent non-discarded
    // cleaning_event for this (property, date, room, staff). The "oops,
    // wrong room — undo" path.
    //
    // 2026-05-07: Was previously gated on "created in last 60s" — if a
    // housekeeper realized 90 seconds later that they'd marked the wrong
    // room, the cleaning_event stayed in the audit log and the
    // Performance tab showed a phantom clean. The Reset link is only
    // visible while the room is in 'clean' state on the housekeeper
    // page, so the user is consciously undoing their own action; there's
    // no benefit to a wall-clock cutoff. Discard the latest event
    // regardless of age. Vacant rooms have no cleaning_events row to
    // discard, so the lookup just returns null and we're done.
    if (action === 'reset') {
      const { error: roomResetErr } = await supabaseAdmin
        .from('rooms')
        .update({ status: 'dirty', started_at: null, completed_at: null })
        .eq('id', roomId);
      if (roomResetErr) {
        log.error('room-action: room update failed (reset)', { requestId, pid, staffId, err: errToString(roomResetErr) });
        return err('Internal server error', {
          requestId, status: 500, code: ApiErrorCode.InternalError, headers,
        });
      }
      // Defensive: room.date may be null on legacy rows. Bail early on the
      // discard side — room update already succeeded so the user sees the
      // tile flip back to dirty either way.
      if (!room.date) {
        return ok({ action: 'reset', cleaningEventDiscarded: false }, { requestId, headers });
      }
      const { data: latest } = await supabaseAdmin
        .from('cleaning_events')
        .select('id')
        .eq('property_id', pid)
        .eq('date', room.date as string)
        .eq('room_number', room.number as string)
        .eq('staff_id', staffId)
        .in('status', ['recorded', 'flagged'])
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      let cleaningEventDiscarded = false;
      if (latest?.id) {
        const { error: discardErr } = await supabaseAdmin
          .from('cleaning_events')
          .update({ status: 'discarded', flag_reason: 'reset_by_user' })
          .eq('id', latest.id as string);
        if (discardErr) {
          log.error('room-action: cleaning_events discard failed (non-fatal)', {
            requestId, route: 'housekeeper/room-action', pid, staffId,
            action: 'reset', err: discardErr as unknown as Error,
          });
        } else {
          cleaningEventDiscarded = true;
        }
      }
      return ok({ action: 'reset', cleaningEventDiscarded }, { requestId, headers });
    }

    // ─── STOP ── REMOVED 2026-05-07 ──────────────────────────────────────
    // The companion to 'start' above. Removed in the same flow collapse.

    // ─── DND_ON ────────────────────────────────────────────────────────
    if (action === 'dnd_on') {
      const { error: dndOnErr } = await supabaseAdmin
        .from('rooms')
        .update({ is_dnd: true, dnd_note: body.dndNote ?? null })
        .eq('id', roomId);
      if (dndOnErr) {
        log.error('room-action: room update failed (dnd_on)', { requestId, pid, staffId, err: errToString(dndOnErr) });
        return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
      }
      return ok({ action: 'dnd_on' }, { requestId, headers });
    }

    // ─── DND_OFF ───────────────────────────────────────────────────────
    if (action === 'dnd_off') {
      const { error: dndOffErr } = await supabaseAdmin
        .from('rooms')
        .update({ is_dnd: false, dnd_note: null })
        .eq('id', roomId);
      if (dndOffErr) {
        log.error('room-action: room update failed (dnd_off)', { requestId, pid, staffId, err: errToString(dndOffErr) });
        return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
      }
      return ok({ action: 'dnd_off' }, { requestId, headers });
    }

    // ─── HELP REQUEST (flag the room as needing manager attention) ────
    // The actual SMS send still goes through /api/help-request which has
    // its own validation, retry, and Twilio handling. This action just
    // flips the helpRequested flag on the room row so Maria's UI shows
    // the SOS badge — that update was previously silently failing.
    if (action === 'help') {
      const { error: helpErr } = await supabaseAdmin
        .from('rooms')
        .update({ help_requested: true })
        .eq('id', roomId);
      if (helpErr) {
        log.error('room-action: room update failed (help)', { requestId, pid, staffId, err: errToString(helpErr) });
        return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
      }
      return ok({ action: 'help' }, { requestId, headers });
    }

    // ─── ISSUE NOTE (housekeeper reports a problem) ────────────────────
    // The text is bounded — Maria's UI shows it on her view; a 10KB note
    // would break the layout. Trim to 500 chars to be safe.
    if (action === 'issue') {
      const note = (body.issueNote ?? '').slice(0, 500);
      const { error: issueErr } = await supabaseAdmin
        .from('rooms')
        .update({ issue_note: note || null })
        .eq('id', roomId);
      if (issueErr) {
        log.error('room-action: room update failed (issue)', { requestId, pid, staffId, err: errToString(issueErr) });
        return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
      }
      return ok({ action: 'issue' }, { requestId, headers });
    }

    return err('unhandled action', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  } catch (caughtErr) {
    log.error('room-action: unexpected error', { requestId, err: errToString(caughtErr) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
}
