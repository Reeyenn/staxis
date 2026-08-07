/**
 * POST /api/admin/organizations/invitations
 *
 * Invite a real company's FIRST leader, without making the internal Staxis
 * administrator a member of that company.
 *
 * ─── WHY THIS LOOKS DIFFERENT THAN IT USED TO ──────────────────────────────
 * This route used to mint into `organization_invitations`, a second invitation
 * system with its own table, its own RPC, its own acceptance screen at
 * /company-invite/[token], its own preview endpoint and its own email. Two
 * invitation systems meant two of everything to secure and keep true, and the
 * company one was only ever reachable from here. It is gone; this route now
 * mints through the SAME `account_invites` machinery every other invitation in
 * the product uses, so a company leader accepts at /invite/[token] like anyone
 * else and every guard that protects that path protects this one too.
 *
 * ─── HOW AN ADMIN IS ALLOWED TO DO THIS ────────────────────────────────────
 * `staxis_create_account_invite_guarded` re-derives the caller's authority in
 * the database and refuses anything the caller could not grant. A platform
 * administrator holds no company hat, so it would normally refuse: the
 * admissible branch is in `_staxis_can_set_membership_hat`, which admits
 * `accounts.role = 'admin'` explicitly and re-reads that role on every call, so
 * removing the role invalidates an open session immediately. The admin's rights
 * are never asserted by this route; they are proven in the same transaction
 * that writes the invitation.
 *
 * ─── THE ANCHOR HOTEL ──────────────────────────────────────────────────────
 * The account-invite system anchors every invitation to a hotel, because that
 * is where authority is re-checked at revoke and acceptance. A company hat is
 * not about one hotel, so we anchor to one the company demonstrably governs
 * right now. That means a company with no hotels yet cannot be given a leader:
 * there is nothing to anchor to, and nothing for that leader to run. The
 * operator is told to attach a hotel first rather than handed an invitation
 * that would fail on acceptance.
 *
 * ─── WHAT THE LEADER GETS ──────────────────────────────────────────────────
 * A company-scope hat with NO hotel list, which means every hotel the company
 * operates including ones bought later. That is the correct shape for the
 * person who runs the company, and it is what the retired bootstrap always
 * meant by an organization-wide grant.
 *
 * `jobCategory` and `jobTitle` are accepted for wire compatibility and are NOT
 * carried: the main system derives job category from the hat itself, and a
 * title is set on the People screen once the person has joined.
 */

import { createHash, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/admin-auth';
import { ApiErrorCode, err, ok } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { findStaxisAccountByEmail } from '@/lib/auth-create-user';
import { resolveCompanyForProperty, resolveOrganizationPropertyTopology } from '@/lib/company/access';
import { HAT_ROLE_LABELS, type HatRole } from '@/lib/company/roles';
import { sendHotelAccountInvite } from '@/lib/email/hotel-account-invite';
import { env } from '@/lib/env';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** The two jobs a company's first leader may hold, in the 0464 vocabulary. */
const BOOTSTRAP_ROLE_BY_PROFILE: Readonly<Record<string, HatRole>> = {
  organization_owner: 'owner',
  organization_admin: 'regional_manager',
};

interface BootstrapInviteBody {
  organizationId?: unknown;
  email?: unknown;
  accessProfile?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: BootstrapInviteBody;
  try {
    body = await req.json() as BootstrapInviteBody;
  } catch {
    return err('A valid JSON body is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const organizationIdCheck = validateUuid(body.organizationId, 'organizationId');
  if (organizationIdCheck.error || !organizationIdCheck.value) {
    return err('A valid organizationId is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const organizationId = organizationIdCheck.value;

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 320) {
    return err('A valid email address is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const accessProfile = typeof body.accessProfile === 'string' ? body.accessProfile : '';
  const role = BOOTSTRAP_ROLE_BY_PROFILE[accessProfile];
  if (!role) {
    return err('The first company leader must be an organization owner or administrator', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const { data: organization, error: organizationError } = await supabaseAdmin
    .from('organizations')
    .select('id, name, organization_type, status')
    .eq('id', organizationId)
    .maybeSingle();
  if (organizationError) {
    log.error('[admin/organizations/invitations:POST] organization read failed', {
      requestId,
      msg: errToString(organizationError),
    });
    return err('Could not verify organization', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
    });
  }
  if (!organization
      || organization.status !== 'active'
      || organization.organization_type === 'single_hotel') {
    return err('Active customer organization not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
    });
  }

  // An unreadable topology and a genuinely empty company are different answers
  // and get different responses. Never treat "we could not read it" as "it has
  // no hotels" and tell the operator to go attach one.
  const topology = await resolveOrganizationPropertyTopology(organizationId);
  if (!topology.ok) {
    return err('Company hotels are temporarily unavailable. Try again shortly.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
    });
  }
  if (topology.topology.propertyIds.length === 0) {
    return err('Add a hotel to this company before inviting its first leader', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }

  // The guarded write requires the anchor to have exactly one live governing
  // company, and that it be this one. Ask the same resolver the write will,
  // rather than assuming the first hotel in the list qualifies.
  let anchorHotelId: string | null = null;
  for (const propertyId of [...topology.topology.propertyIds].sort()) {
    const resolution = await resolveCompanyForProperty(propertyId);
    if (resolution.status === 'unavailable') {
      return err('Company hotels are temporarily unavailable. Try again shortly.', {
        requestId,
        status: 503,
        code: ApiErrorCode.UpstreamFailure,
      });
    }
    if (resolution.status === 'company' && resolution.organizationId === organizationId) {
      anchorHotelId = propertyId;
      break;
    }
  }
  if (!anchorHotelId) {
    log.error('[admin/organizations/invitations:POST] no hotel resolved back to this company', {
      requestId,
      organizationId,
    });
    return err('This company has no hotel that can carry the invitation yet', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }

  const accountLookup = await findStaxisAccountByEmail(email);
  if (accountLookup.kind === 'unavailable') {
    return err('Could not check that email address. Try again shortly.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
    });
  }
  if (accountLookup.kind === 'protected_identity') {
    return err('This login cannot be given company access. Recover that account first.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }

  // An email that already has an active Staxis login receives the hat directly,
  // exactly as it does on the People screen. Sending that person an invitation
  // to create an account they already have is the failure mode this avoids.
  if (accountLookup.kind === 'found') {
    if (!accountLookup.active) {
      return err('This Staxis account is inactive. Reactivate it before adding company access.', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
      });
    }
    const targetAccountId = validateUuid(accountLookup.accountId, 'accountId');
    if (targetAccountId.error || !targetAccountId.value) {
      log.error('[admin/organizations/invitations:POST] malformed account id', { requestId });
      return err('Could not add company access', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    const { data: grantData, error: grantError } = await supabaseAdmin.rpc(
      'staxis_grant_existing_account_invite_guarded',
      {
        p_actor_account_id: auth.accountId,
        p_actor_auth_user_id: auth.userId,
        p_hotel_id: anchorHotelId,
        p_target_account_id: targetAccountId.value,
        p_email: email,
        p_role: role,
        p_organization_id: organizationId,
        p_membership_scope: 'company',
        p_covered_property_ids: null,
        p_target_staff_id: null,
        p_request_id: requestId,
      },
    );
    if (grantError) {
      log.error('[admin/organizations/invitations:POST] guarded grant failed', {
        requestId,
        code: grantError.code,
        msg: errToString(grantError),
      });
      return err('Could not add company access', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    const grant = grantData !== null && typeof grantData === 'object' && !Array.isArray(grantData)
      ? grantData as Record<string, unknown>
      : null;
    if (!grant || grant.ok !== true) {
      if (grant?.reason === 'denied') {
        return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
      }
      if (grant?.reason === 'role_conflict') {
        return err('This account already has a different access role', {
          requestId,
          status: 409,
          code: ApiErrorCode.IdempotencyConflict,
        });
      }
      return err('Could not add company access', {
        requestId,
        status: grant?.reason === 'invalid' ? 400 : 500,
        code: grant?.reason === 'invalid'
          ? ApiErrorCode.ValidationFailed
          : ApiErrorCode.InternalError,
      });
    }
    return ok({
      invitation: {
        organizationId,
        email,
        accessProfile,
        role,
        status: 'granted',
      },
      inviteLink: null,
      emailSent: false,
      emailError: null,
    }, { requestId, status: 200 });
  }

  const rawToken = randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { data: createData, error: createError } = await supabaseAdmin.rpc(
    'staxis_create_account_invite_guarded',
    {
      p_actor_account_id: auth.accountId,
      p_actor_auth_user_id: auth.userId,
      p_hotel_id: anchorHotelId,
      p_email: email,
      p_role: role,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
      p_organization_id: organizationId,
      p_membership_scope: 'company',
      // NULL is "every hotel this company operates, including ones added
      // later" — the right promise for the person who runs the company.
      p_covered_property_ids: null,
      p_request_id: requestId,
      p_target_staff_id: null,
    },
  );
  if (createError) {
    log.error('[admin/organizations/invitations:POST] guarded create failed', {
      requestId,
      code: createError.code,
      msg: errToString(createError),
    });
    return err('Could not create the company invitation', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
  const created = createData !== null && typeof createData === 'object' && !Array.isArray(createData)
    ? createData as Record<string, unknown>
    : null;
  if (!created || created.ok !== true) {
    if (created?.reason === 'denied') {
      return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
    }
    if (created?.reason === 'invalid') {
      return err('Invalid company invitation', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    log.error('[admin/organizations/invitations:POST] guarded create refused', {
      requestId,
      reason: created?.reason,
    });
    return err('Could not create the company invitation', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }

  const inviteIdReceipt = validateUuid(created.inviteId, 'inviteId');
  const hotelIdReceipt = validateUuid(created.hotelId, 'hotelId');
  if (inviteIdReceipt.error
      || !inviteIdReceipt.value
      || hotelIdReceipt.error
      || hotelIdReceipt.value !== anchorHotelId) {
    log.error('[admin/organizations/invitations:POST] guarded create returned a malformed receipt', {
      requestId,
    });
    return err('Could not create the company invitation', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
  const invitationId = inviteIdReceipt.value;

  // Acceptance is the ordinary one. Use the canonical application origin rather
  // than a caller-controlled Host header so the emailed link cannot be poisoned.
  const inviteUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/invite/${rawToken}`;
  let emailSent = false;
  let emailError: string | null = null;
  try {
    const delivery = await sendHotelAccountInvite({
      to: email,
      // The company is the thing being joined, so the company is what the
      // invitation names.
      hotelName: organization.name as string,
      role: 'owner',
      roleLabelOverride: HAT_ROLE_LABELS[role].en,
      inviteUrl,
      expiresAt,
      auditContext: {
        actorUserId: auth.userId,
        actorEmail: auth.email ?? undefined,
        targetType: 'invite',
        targetId: invitationId,
        hotelId: anchorHotelId,
      },
    });
    emailSent = delivery.ok;
    emailError = delivery.ok ? null : String(delivery.error ?? 'email_delivery_failed');
  } catch (mailError) {
    emailError = 'email_delivery_failed';
    log.error('[admin/organizations/invitations:POST] email send failed', {
      requestId,
      msg: errToString(mailError),
    });
  }
  if (!emailSent) {
    log.warn('[admin/organizations/invitations:POST] invitation created but email was not delivered', {
      requestId,
      invitationId,
    });
  }

  return ok({
    invitation: {
      id: invitationId,
      organizationId,
      email,
      accessProfile,
      role,
      expiresAt,
      status: 'pending',
    },
    inviteLink: inviteUrl,
    emailSent,
    emailError,
  }, { requestId, status: 201 });
}
