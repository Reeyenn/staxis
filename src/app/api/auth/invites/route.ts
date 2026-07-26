// /api/auth/invites — manage email-based account invites.
//   GET     ?hotelId=…  — list pending invites for that hotel
//   POST                — create + email an invite (body: hotelId, email, role)
//   DELETE  ?id=…       — revoke an invite (deletes the row)
//
// Caller must be admin / owner / general_manager. Owner/GM are scoped to
// hotels in their property_access; admin can manage any hotel.
//
// COMPANY SPINE (0364). The same button now sends two shapes:
//
//   { hotelId, email, role }                         the hotel invite, exactly
//                                                    as it has always worked.
//                                                    A GM is never asked which
//                                                    hotel — theirs is implied.
//   { hotelId, email, role, scope, propertyIds }     the company invite. Only a
//                                                    company-scoped inviter
//                                                    (owner / VP) may send it,
//                                                    and `propertyIds` may name
//                                                    only hotels inside THEIR
//                                                    OWN company — that is Wall
//                                                    B at the invitation
//                                                    boundary. `scope:'company'`
//                                                    means every hotel the
//                                                    company operates, now and
//                                                    in future.
//
// Inviting the same person twice with different answers is how multi-hat
// happens: two invitations, two hats, one person.

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
import { verifyTeamManager, callerCapabilityDecision } from '@/lib/team-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { canGrantHotelRole, isAssignableRole, type AssignableRole } from '@/lib/roles';
import { writeAudit } from '@/lib/audit';
import { resolveInviteScope, type ResolvedInviteScope } from '@/lib/company/invite-scope';
import { canGrantHat, HAT_ROLE_LABELS, type HatRole } from '@/lib/company/roles';
import {
  companyForProperty,
  managingHats,
  propertiesOfOrganization,
  type MembershipHat,
} from '@/lib/company/access';

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
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
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

  // What the invite form should ask. For an independent hotel this is the two
  // questions it has always asked; for someone who runs a company it also
  // carries the list their third question is chosen from. Attached to the read
  // the dialog already makes rather than a second endpoint.
  let options: InviteOptions = { choosesHotels: false, organizationId: null, jobs: [], hotels: [] };
  try {
    options = await inviteOptionsFor(caller, hotelId);
  } catch (optionsErr) {
    // The list of pending invitations is the point of this read; a company
    // lookup that cannot answer just means the form asks its usual two
    // questions.
    log.warn('[invites:GET] company options unavailable', { requestId, msg: errToString(optionsErr) });
  }
  return ok({ invites, options }, { requestId });
}

interface InviteOptions {
  /** Ask the third question — "which hotels?" — only when this is true. */
  choosesHotels: boolean;
  organizationId: string | null;
  jobs: Array<{ value: string; scope: 'company' | 'property'; label: { en: string; es: string } }>;
  hotels: Array<{ id: string; name: string }>;
}

async function inviteOptionsFor(
  caller: NonNullable<Awaited<ReturnType<typeof verifyTeamManager>>>,
  hotelId: string,
): Promise<InviteOptions> {
  const empty: InviteOptions = {
    choosesHotels: false, organizationId: null, jobs: [], hotels: [],
  };
  const organizationId = await companyForProperty(hotelId);
  if (!organizationId) return empty;

  const managing: MembershipHat[] = managingHats(caller.hats ?? [])
    .filter((hat) => hat.organizationId === organizationId);
  if (!caller.isAdmin && managing.length === 0) return empty;

  const choosesHotels = caller.isAdmin || managing.some((hat) => hat.scope === 'company');
  const jobs: InviteOptions['jobs'] = [];
  const offer = (value: HatRole, scope: 'company' | 'property') => {
    if (jobs.some((job) => job.value === value)) return;
    jobs.push({ value, scope, label: HAT_ROLE_LABELS[value] });
  };
  for (const role of ['general_manager', 'front_desk', 'housekeeping', 'maintenance'] as const) {
    if (caller.isAdmin || managing.some((hat) => canGrantHat(
      { scope: hat.scope, role: hat.role, coveredPropertyIds: hat.coveredPropertyIds },
      { scope: 'property', role, propertyIds: [hotelId] },
    ))) offer(role, 'property');
  }
  for (const role of ['owner', 'vp', 'finance'] as const) {
    if (caller.isAdmin || managing.some((hat) => canGrantHat(
      { scope: hat.scope, role: hat.role, coveredPropertyIds: hat.coveredPropertyIds },
      { scope: 'company', role, propertyIds: [] },
    ))) offer(role, 'company');
  }

  const hotelIds = choosesHotels
    ? await propertiesOfOrganization(organizationId)
    : [...new Set(managing.flatMap((hat) => hat.coveredPropertyIds))];
  let hotels: InviteOptions['hotels'] = [];
  if (hotelIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .in('id', hotelIds);
    hotels = ((data ?? []) as Array<{ id: string; name: string }>)
      .map((row) => ({ id: row.id, name: row.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }


  return { choosesHotels, organizationId, jobs, hotels };
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  let body: {
    hotelId?: string;
    email?: string;
    role?: string;
    scope?: string;
    propertyIds?: unknown;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return err('A valid JSON body is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const { hotelId, email, role } = body;
  if (!hotelId || !email || !role) {
    return err('hotelId, email, and role are required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  // ── The company shape, when one was asked for ──────────────────────────
  // `resolveInviteScope` returns null for the legacy shape, so everything
  // below this point runs unchanged for every hotel invite ever sent.
  let hat: ResolvedInviteScope | null;
  try {
    hat = await resolveInviteScope(caller, hotelId, role, body.scope, body.propertyIds);
  } catch (scopeErr) {
    const message = scopeErr instanceof Error ? scopeErr.message : 'Invalid invitation scope';
    return err(message, { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // The word the invited person's LOGIN will carry. For a company invitation
  // that is the hat degraded to the hotel vocabulary (see legacyRoleForHat);
  // for the plain hotel invitation it is the role that was asked for.
  let legacyRole: AssignableRole;
  if (hat) {
    legacyRole = hat.legacyRole as AssignableRole;
  } else {
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
    legacyRole = role;
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
    // NULL for every legacy hotel invite — the CHECK in 0364 requires all
    // three to be absent together, which is what keeps the old shape intact.
    organization_id: hat?.organizationId ?? null,
    membership_scope: hat?.scope ?? null,
    covered_property_ids: hat?.scope === 'property' ? hat.propertyIds : null,
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
    metadata: {
      email: normalizedEmail,
      role,
      ...(hat
        ? { scope: hat.scope, organizationId: hat.organizationId, propertyIds: hat.propertyIds }
        : {}),
    },
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
      role: legacyRole,
      roleLabelOverride: hat ? HAT_ROLE_LABELS[hat.role].en : undefined,
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
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', row.hotel_id);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
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
