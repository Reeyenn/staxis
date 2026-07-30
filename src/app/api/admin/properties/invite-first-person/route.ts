/**
 * POST /api/admin/properties/invite-first-person
 *
 * Creates the one first-person onboarding invitation for an existing hotel
 * shell. Hotel creation intentionally lives elsewhere: this route can only
 * bind an Owner/General Manager invitation to a hotel that still has no
 * customer accounts and has not begun onboarding.
 */

import { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/admin-auth';
import { ApiErrorCode, err, ok } from '@/lib/api-response';
import { isUuid, isValidEmail } from '@/lib/api-validate';
import { writeAudit } from '@/lib/audit';
import { sendOnboardingInvite } from '@/lib/email/onboarding-invite';
import { env } from '@/lib/env';
import { generateJoinCode } from '@/lib/join-codes';
import { getOrMintRequestId, log } from '@/lib/log';
import { PLACEHOLDER_HOTEL_NAME } from '@/lib/onboarding/state';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FirstPersonRole = 'owner' | 'general_manager';

interface InviteBody {
  hotelId?: unknown;
  email?: unknown;
  role?: unknown;
}

interface MintReceipt {
  ok: true;
  schemaVersion: 'first-person-onboarding-invite-v1';
  status: 'created' | 'existing';
  created: boolean;
  codeId: string;
  hotelId: string;
  code: string;
  expiresAt: string;
  role: FirstPersonRole;
  invitedEmail: string;
}

const SUCCESS_KEYS = [
  'ok', 'schemaVersion', 'status', 'created', 'codeId', 'hotelId', 'code',
  'expiresAt', 'role', 'invitedEmail',
].sort();
const FAILURE_REASONS = new Set([
  'invalid', 'not_found', 'denied', 'hotel_not_unclaimed', 'role_conflict',
  'email_conflict', 'code_collision',
]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseMintReceipt(
  value: unknown,
  expected: { hotelId: string; email: string; role: FirstPersonRole },
): MintReceipt | { ok: false; reason: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false
      && typeof record.reason === 'string'
      && FAILURE_REASONS.has(record.reason)
      && exactKeys(record, ['ok', 'reason'])) {
    return { ok: false, reason: record.reason };
  }
  if (record.ok !== true
      || record.schemaVersion !== 'first-person-onboarding-invite-v1'
      || (record.status !== 'created' && record.status !== 'existing')
      || record.created !== (record.status === 'created')
      || !exactKeys(record, SUCCESS_KEYS)
      || !isUuid(record.codeId)
      || record.hotelId !== expected.hotelId
      || typeof record.code !== 'string'
      || !/^[A-Z0-9][A-Z0-9-]{4,126}[A-Z0-9]$/.test(record.code)
      || typeof record.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(record.expiresAt))
      || Date.parse(record.expiresAt) <= Date.now()
      || record.role !== expected.role
      || record.invitedEmail !== expected.email) {
    return null;
  }
  return record as unknown as MintReceipt;
}

function invitationConflict(reason: string, requestId: string) {
  if (reason === 'not_found') {
    return err('Hotel not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
    });
  }
  if (reason === 'denied') {
    return err('This hotel is not available for a first-person invitation', {
      requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
    });
  }
  if (reason === 'invalid') {
    return err('Invalid first-person invitation', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  return err(
    reason === 'role_conflict'
      ? 'A first-person invitation already exists with a different assigned role'
      : reason === 'email_conflict'
        ? 'A first-person invitation already exists for a different email address'
        : 'This hotel already has a person or has begun onboarding',
    {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    },
  );
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: InviteBody;
  try {
    body = await req.json() as InviteBody;
  } catch {
    return err('A valid JSON body is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const hotelId = typeof body.hotelId === 'string' ? body.hotelId : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body.role === 'owner' || body.role === 'general_manager'
    ? body.role
    : null;
  if (!isUuid(hotelId)) {
    return err('A valid hotelId is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!isValidEmail(email)) {
    return err('A valid email address is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!role) {
    return err('Choose Owner or General Manager', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const { data: hotel, error: hotelError } = await supabaseAdmin
    .from('properties')
    .select('id, name')
    .eq('id', hotelId)
    .maybeSingle();
  if (hotelError) {
    log.error('[admin/properties/invite-first-person] hotel lookup failed', {
      requestId,
      hotelId,
      databaseCode: hotelError.code ?? null,
    });
    return err('Could not verify the hotel', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
  if (!hotel) {
    return err('Hotel not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
    });
  }

  let receipt: MintReceipt | null = null;
  let closedFailure: string | null = null;
  let databaseCode: string | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateJoinCode(hotel.name);
    const { data, error: mintError } = await supabaseAdmin.rpc(
      'staxis_mint_first_person_onboarding_invite',
      {
        p_actor_account_id: auth.accountId,
        p_actor_auth_user_id: auth.userId,
        p_hotel_id: hotelId,
        p_code: candidate,
        p_role: role,
        p_invited_email: email,
        p_request_id: requestId,
      },
    );
    if (mintError) {
      databaseCode = mintError.code ?? null;
      break;
    }
    const parsed = parseMintReceipt(data, { hotelId, email, role });
    if (!parsed) {
      databaseCode = 'PGRST_CONTRACT';
      break;
    }
    if (parsed.ok === false) {
      if (parsed.reason === 'code_collision') continue;
      closedFailure = parsed.reason;
      break;
    }
    receipt = parsed;
    break;
  }

  if (closedFailure) return invitationConflict(closedFailure, requestId);
  if (!receipt) {
    log.error('[admin/properties/invite-first-person] guarded mint unavailable', {
      requestId,
      hotelId,
      databaseCode,
    });
    return err('First-person invitations are temporarily unavailable', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
    });
  }

  const signupUrl = `${env.NEXT_PUBLIC_APP_URL}/onboard?code=${encodeURIComponent(receipt.code)}`;
  const delivery = await sendOnboardingInvite({
    to: receipt.invitedEmail,
    hotelName: hotel.name === PLACEHOLDER_HOTEL_NAME ? 'your hotel' : hotel.name,
    signupUrl,
    inviteRole: receipt.role,
    expiresAt: receipt.expiresAt,
    auditContext: {
      actorUserId: auth.userId,
      actorEmail: auth.email ?? undefined,
      targetType: 'property',
      targetId: hotelId,
      hotelId,
    },
  });

  await writeAudit({
    action: 'property.first_person_invite',
    actorUserId: auth.userId,
    actorEmail: auth.email ?? undefined,
    targetType: 'property',
    targetId: hotelId,
    hotelId,
    metadata: {
      invite_role: receipt.role,
      invite_created: receipt.created,
      email_sent: delivery.ok,
    },
  });

  return ok({
    hotelId,
    invitedEmail: receipt.invitedEmail,
    assignedRole: receipt.role,
    signupUrl,
    expiresAt: receipt.expiresAt,
    emailSent: delivery.ok,
    emailError: delivery.ok ? null : delivery.error,
  }, { requestId, status: receipt.created ? 201 : 200 });
}
