// /api/auth/invites — manage email-based account invites.
//   GET     ?hotelId=…  — list pending invites for that hotel
//   POST                — create + email an invite (body: hotelId, email, role)
//   DELETE  ?id=…       — revoke an invite (deletes the row)
//
// Caller must be admin / owner / general_manager. Owner/GM are scoped to
// hotels in their property_access; admin can manage any hotel.

import { NextRequest } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { accountInviteDelivery, accountInviteStatus } from '@/lib/account-invites';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { sendHotelAccountInvite } from '@/lib/email/hotel-account-invite';
import type { SendEmailResult } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, callerCan } from '@/lib/team-auth';
import { canGrantHotelRole, isAssignableRole } from '@/lib/roles';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(t: string) { return createHash('sha256').update(t).digest('hex'); }
function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelId = searchParams.get('hotelId');
  if (!hotelId) return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!(await callerCan(caller, 'manage_team', hotelId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { data, error: qErr } = await supabaseAdmin
    .from('account_invites')
    .select('id, email, role, expires_at, created_at, accepted_at')
    .eq('hotel_id', hotelId)
    .is('accepted_at', null)
    .order('created_at', { ascending: false });
  if (qErr) {
    log.error('[invites:GET] failed', { requestId, msg: errToString(qErr) });
    return err('Failed to load invites', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  const nowMs = Date.now();
  const invites = (data ?? []).map((invite) => {
    const status = accountInviteStatus(invite.expires_at, nowMs);
    return { ...invite, status, isExpired: status === 'expired' };
  });
  return ok({ invites }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  let body: { hotelId?: string; email?: string; role?: string };
  try {
    body = await req.json() as { hotelId?: string; email?: string; role?: string };
  } catch {
    return err('A valid JSON body is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const { hotelId, email, role } = body;
  if (!hotelId || !email || !role) {
    return err('hotelId, email, and role are required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!(await callerCan(caller, 'manage_team', hotelId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  if (!isAssignableRole(role)) {
    return err('Invalid role', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!canGrantHotelRole(caller.role, role)) {
    return err('Only an owner or admin can invite an owner or General Manager', {
      requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
    });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!isEmail(normalizedEmail) || normalizedEmail.length > 320) {
    return err('Invalid email', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { data: property, error: propertyErr } = await supabaseAdmin
    .from('properties')
    .select('name')
    .eq('id', hotelId)
    .maybeSingle();
  if (propertyErr) {
    log.error('[invites:POST] property lookup failed', { requestId, msg: errToString(propertyErr) });
    return err('Failed to verify hotel', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!property) {
    return err('Hotel not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
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
    log.error('[invites:POST] insert failed', { requestId, msg: errToString(insErr) });
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

  // Account-invite acceptance remains /invite/[token]; only the delivery
  // transport changes. Use the canonical application origin rather than a
  // caller-controlled Host header so the emailed link cannot be poisoned.
  const inviteLink = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/invite/${rawToken}`;
  let emailResult: SendEmailResult;
  try {
    emailResult = await sendHotelAccountInvite({
      to: normalizedEmail,
      hotelName: property.name,
      role,
      inviteUrl: inviteLink,
      expiresAt,
      auditContext: {
        actorUserId: caller.authUserId,
        actorEmail: caller.authEmail,
        targetType: 'invite',
        targetId: inserted.id,
        hotelId,
      },
    });
  } catch (mailErr) {
    log.error('[invites:POST] email send failed', { requestId, msg: errToString(mailErr) });
    emailResult = { ok: false as const, error: 'email_delivery_failed' };
  }
  if (!emailResult.ok) {
    log.warn('[invites:POST] invitation created but email was not delivered', {
      requestId,
      inviteId: inserted.id,
    });
  }

  return ok(accountInviteDelivery(inviteLink, emailResult), { requestId, status: 201 });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  // Fetch first to enforce hotel-level scope.
  const { data: row, error: rowErr } = await supabaseAdmin
    .from('account_invites')
    .select('hotel_id, accepted_at')
    .eq('id', id)
    .maybeSingle();
  if (rowErr) {
    log.error('[invites:DELETE] lookup failed', { requestId, msg: errToString(rowErr) });
    return err('Failed to verify invite', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!row) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!(await callerCan(caller, 'manage_team', row.hotel_id))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  if (row.accepted_at) {
    return err('Only pending invites can be revoked', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }

  const { data: deleted, error: delErr } = await supabaseAdmin
    .from('account_invites')
    .delete()
    .eq('id', id)
    .is('accepted_at', null)
    .select('id')
    .maybeSingle();
  if (delErr) {
    log.error('[invites:DELETE] failed', { requestId, msg: errToString(delErr) });
    return err('Failed to revoke invite', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!deleted) {
    return err('Invite is no longer pending', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
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
