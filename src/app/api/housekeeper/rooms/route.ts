/**
 * Housekeeper rooms read — service-role bypass for RLS-blocked reads.
 *
 * THE PROBLEM (discovered 2026-04-30 from Maria's text — housekeepers open
 * the SMS link, page renders, "no rooms show up"):
 *   /housekeeper/[id] is a publicly-linkable page (we send it via SMS to
 *   housekeepers' phones — they open it with no Staxis login). The page
 *   used to fetch rooms via supabase.from('rooms').select(...) directly
 *   from the browser. With no auth.uid(), RLS's user_owns_property check
 *   filters the SELECT to zero rows. Postgres returns 200 OK with [].
 *   The supabase JS client treats that as a successful empty result. So
 *   every housekeeper saw "No rooms assigned" no matter what was actually
 *   in the table. It worked for Maria/owner only because they're signed in.
 *
 *   Symptom in production: Maria texts "all housekeeping can open the links
 *   but not show the rooms." The bug was silent for ~8 days because Maria
 *   was always signed in when she tested.
 *
 * THE FIX:
 *   Server-side route using supabaseAdmin (service-role, RLS-bypass). Same
 *   pattern as /api/staff-list and /api/housekeeper/room-action. Capability
 *   check: pid + staffId must be a real (active) pair, otherwise 404.
 *
 *   Returns the SAME camel-cased Room shape that fromRoomRow() produced on
 *   the browser side, so the page's render code doesn't change.
 *
 * SECURITY NOTE:
 *   Anyone with a valid (pid, staffId) pair can list that staff member's
 *   assigned rooms. That's the same trust model as the SMS link itself —
 *   the URL IS the capability token. We do NOT leak rooms across staff
 *   members or properties: the SELECT is scoped to (property_id=pid AND
 *   assigned_to=staffId) only. PII fields not relevant to housekeepers
 *   (e.g., guest names) live on different tables and are not returned.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { fromRoomRow } from '@/lib/db-mappers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);

  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;
  const staffId = staffV.value!;

  // Capability check: this staff member must actually exist on this property.
  // Without this, an attacker who knows ANY staff UUID could enumerate rooms
  // across all properties by spraying property_ids. The check is one round-
  // trip — cheap.
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffErr) {
    log.error('[housekeeper/rooms] staff lookup failed', { err: staffErr, requestId });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!staffRow) {
    // Don't echo back which side of the pair was wrong — that helps an
    // enumerator. Same response for "no such staff" and "staff not on this
    // property."
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Pull every room currently assigned to this housekeeper. We don't filter
  // by date here — the page picks the right date bucket client-side so that
  // a HK who left the page open overnight rolls into tomorrow's shift
  // automatically. See housekeeper/[id]/page.tsx:158 for the rationale.
  const { data, error: queryError } = await supabaseAdmin
    .from('rooms')
    .select('*')
    .eq('property_id', pid)
    .eq('assigned_to', staffId);

  if (queryError) {
    log.error('[housekeeper/rooms] query failed', { err: queryError, requestId });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const rooms = (data ?? []).map(fromRoomRow);
  return ok(rooms, { requestId });
}
