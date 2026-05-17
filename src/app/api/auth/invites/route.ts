// /api/auth/invites — manage email-based account invites.
//   GET     ?hotelId=…  — list pending invites for that hotel
//   POST                — create + email an invite (body: hotelId, email, role)
//   DELETE  ?id=…       — revoke an invite (deletes the row)
//
// Caller must be admin / owner / general_manager. Owner/GM are scoped to
// hotels in their property_access; admin can manage any hotel.

import { NextRequest } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { verifyTeamManager, canManageHotel } from '@/lib/team-auth';
import { isAssignableRole } from '@/lib/roles';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(t: string) { return createHash('sha256').update(t).digest('hex'); }
function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

function inviteUrlBase(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'getstaxis.com';
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelId = searchParams.get('hotelId');
  if (!hotelId) return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { data, error: qErr } = await supabaseAdmin
    .from('account_invites')
    .select('id, email, role, expires_at, created_at, accepted_at')
    .eq('hotel_id', hotelId)
    .is('accepted_at', null)
    .order('created_at', { ascending: false });
  if (qErr) {
    log.error('[invites:GET] failed', { err: qErr, requestId });
    return err('Failed to load invites', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({ invites: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json() as { hotelId?: string; email?: string; role?: string };
  const { hotelId, email, role } = body;
  if (!hotelId || !email || !role) {
    return err('hotelId, email, and role are required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  if (!isAssignableRole(role)) {
    return err('Invalid role', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!isEmail(normalizedEmail)) {
    return err('Invalid email', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const rawToken = randomBytes(24).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { data: inserted, error: insErr } = await supabaseAdmin.from('account_invites').insert({
    hotel_id: hotelId,
    email: normalizedEmail,
    role,
    token_hash: tokenHash,
    expires_at: expiresAt,
    invited_by: caller.accountId,
  }).select('id').single();
  if (insErr || !inserted) {
    log.error('[invites:POST] insert failed', { err: insErr, requestId });
    return err('Failed to create invite', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  await writeAudit({
    action: 'invite.create',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail,
    targetType: 'invite',
    targetId: inserted.id,
    hotelId,
    metadata: { email: normalizedEmail, role },
  });

  // Send the email via Supabase's built-in mailer using the invite link as
  // the redirect target. We use generateLink type='magiclink' as a transport
  // — the actual auth happens on /invite/[token], not via the magic link's
  // verify endpoint. The user just needs to click the link in their inbox.
  const inviteLink = `${inviteUrlBase(req)}/invite/${rawToken}`;
  try {
    await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: normalizedEmail,
      options: { redirectTo: inviteLink },
    });
  } catch (mailErr) {
    log.warn('[invites:POST] email send failed', { err: mailErr, requestId });
    // Non-fatal — admin can copy the link from the response.
  }

  return ok({ inviteLink }, { requestId });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  // Fetch first to enforce hotel-level scope.
  const { data: row } = await supabaseAdmin
    .from('account_invites')
    .select('hotel_id')
    .eq('id', id)
    .maybeSingle();
  if (!row) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canManageHotel(caller, row.hotel_id)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { error: delErr } = await supabaseAdmin.from('account_invites').delete().eq('id', id);
  if (delErr) {
    log.error('[invites:DELETE] failed', { err: delErr, requestId });
    return err('Failed to revoke invite', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  await writeAudit({
    action: 'invite.revoke',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail,
    targetType: 'invite',
    targetId: id,
    hotelId: row.hotel_id,
  });
  return ok({ success: true }, { requestId });
}
