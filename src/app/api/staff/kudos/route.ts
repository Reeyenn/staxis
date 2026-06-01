// /api/staff/kudos — recognition / kudos (manager-only Staff page + staff self-read).
//
//   GET  ?hotelId=&scope=feed   [manager]  recent kudos across the property
//   GET  ?hotelId=&scope=mine   [any linked staff]  the caller's OWN kudos
//   POST body: { hotelId, staffId, message, category? }   [manager]  give a kudos
//
// staff_kudos is service-role-only (migration 0251) — anon + authenticated are
// deny-all, so every read/write goes through this route via supabaseAdmin. The
// "feed" + "give" paths require a management role (verifyTeamManager); the
// "mine" path only needs a valid session and returns nothing but the caller's
// own recognitions. In-app only — NO SMS.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { requireSession } from '@/lib/api-auth';
import { verifyTeamManager, canManageHotel } from '@/lib/team-auth';
import { validateUuid, validateString, validateEnum, sanitizeForSms } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const KUDOS_CATEGORIES = ['guest-praise', 'teamwork', 'above-and-beyond', 'attendance'] as const;
export type KudosCategory = typeof KUDOS_CATEGORIES[number];

const FEED_LIMIT = 60;

interface KudosRow {
  id: unknown;
  staff_id: unknown;
  given_by: unknown;
  given_by_name: unknown;
  message: unknown;
  category: unknown;
  created_at: unknown;
}

function mapKudos(r: KudosRow) {
  return {
    id: String(r.id),
    staffId: String(r.staff_id ?? ''),
    givenBy: r.given_by == null ? null : String(r.given_by),
    givenByName: r.given_by_name == null ? null : String(r.given_by_name),
    message: String(r.message ?? ''),
    category: r.category == null ? null : String(r.category),
    createdAt: r.created_at == null ? null : String(r.created_at),
  };
}

// ─── GET — feed (manager) | mine (self) ─────────────────────────────────────
export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);

  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  const scope = searchParams.get('scope') === 'mine' ? 'mine' : 'feed';

  if (scope === 'mine') {
    // Any logged-in staff member can read THEIR OWN recognitions.
    const session = await requireSession(req);
    if (!session.ok) return session.response;
    const { data: acct } = await supabaseAdmin
      .from('accounts').select('staff_id, property_access')
      .eq('data_user_id', session.userId).maybeSingle();
    const access = (acct?.property_access ?? []) as string[];
    if (!access.includes(hotelId)) {
      return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
    }
    if (!acct?.staff_id) {
      // Not linked to a staff row → no recognitions to show. Not an error.
      return ok({ kudos: [] }, { requestId });
    }
    const { data, error } = await supabaseAdmin
      .from('staff_kudos')
      .select('id, staff_id, given_by, given_by_name, message, category, created_at')
      .eq('property_id', hotelId)
      .eq('staff_id', acct.staff_id)
      .order('created_at', { ascending: false })
      .limit(FEED_LIMIT);
    if (error) {
      log.error('[kudos:GET:mine] query failed', { requestId, msg: errToString(error) });
      return err('Failed to load recognition', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    return ok({ kudos: (data ?? []).map(mapKudos) }, { requestId });
  }

  // scope === 'feed' — management only.
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  const { data, error } = await supabaseAdmin
    .from('staff_kudos')
    .select('id, staff_id, given_by, given_by_name, message, category, created_at')
    .eq('property_id', hotelId)
    .order('created_at', { ascending: false })
    .limit(FEED_LIMIT);
  if (error) {
    log.error('[kudos:GET:feed] query failed', { requestId, msg: errToString(error) });
    return err('Failed to load recognition', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({ kudos: (data ?? []).map(mapKudos) }, { requestId });
}

// ─── POST — give a kudos (manager) ──────────────────────────────────────────
export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as {
    hotelId?: string; staffId?: string; message?: string; category?: string;
  };

  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const staffIdCheck = validateUuid(body.staffId, 'staffId');
  if (staffIdCheck.error) return err(staffIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffId = staffIdCheck.value!;

  // sanitizeForSms strips control chars + collapses whitespace (display hygiene;
  // React escapes on render). Validate the cleaned text against the 500-char cap.
  const cleaned = sanitizeForSms(typeof body.message === 'string' ? body.message : '');
  const messageCheck = validateString(cleaned, { max: 500, label: 'message' });
  if (messageCheck.error) return err(messageCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const message = messageCheck.value!;

  let category: KudosCategory | null = null;
  if (body.category != null && body.category !== '') {
    const catCheck = validateEnum(body.category, KUDOS_CATEGORIES, 'category');
    if (catCheck.error) return err(catCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    category = catCheck.value!;
  }

  // Recipient must be a real staff row at THIS property.
  const { data: recipient, error: recErr } = await supabaseAdmin
    .from('staff').select('id, property_id').eq('id', staffId).maybeSingle();
  if (recErr) {
    log.error('[kudos:POST] recipient lookup failed', { requestId, msg: errToString(recErr) });
    return err('Failed to verify recipient', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!recipient || recipient.property_id !== hotelId) {
    return err('Recipient is not a staff member at this property', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Snapshot the giver's display name (survives later account deletion).
  const { data: giver } = await supabaseAdmin
    .from('accounts').select('display_name').eq('id', caller.accountId).maybeSingle();
  const givenByName = (giver?.display_name as string | undefined)?.trim() || null;

  const { data, error } = await supabaseAdmin
    .from('staff_kudos').insert({
      property_id:   hotelId,
      staff_id:      staffId,
      given_by:      caller.accountId,
      given_by_name: givenByName,
      message,
      category,
    }).select('id, staff_id, given_by, given_by_name, message, category, created_at').single();
  if (error) {
    log.error('[kudos:POST] insert failed', { requestId, msg: errToString(error) });
    return err('Failed to save recognition', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ kudos: mapKudos(data) }, { requestId, status: 201 });
}
