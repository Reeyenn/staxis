// /api/auth/team/hats — the lines on a person's card.
//
//   GET    ?hotelId=…&accountId=…   the jobs this person holds at the company
//                                   that operates that hotel
//   POST                            add a job ("Maria also oversees Lufkin")
//   DELETE ?hotelId=…&membershipId= remove exactly one job, leaving the rest
//
// A person's card reads as lines — "GM — Beaumont · Oversees — Lufkin, Tyler" —
// and each line is one row of `organization_memberships`. Adding a second line
// for the same person is what multi-hat IS: the invitation flow answers "what
// job, and where" once, and this endpoint answers it again for somebody who
// already has a login.
//
// Authority is checked TWICE on purpose: once here against the caller's own
// hats (so the UI gets a clean 403 with a sentence a manager can read), and
// again inside `staxis_set_membership_hat`, which is the only writer Postgres
// will accept. A forged request that somehow got past this route still cannot
// widen anybody's access.

import { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid } from '@/lib/api-validate';
import { verifyTeamManager, callerCapabilityDecision } from '@/lib/team-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { writeAudit } from '@/lib/audit';
import {
  canGrantHat,
  isHatRole,
  isMembershipScope,
  scopeAllowsRole,
  HAT_ROLE_LABELS,
} from '@/lib/company/roles';
import {
  companyForProperty,
  loadHats,
  managingHats,
  propertiesOfOrganization,
} from '@/lib/company/access';
import { grantInvitedHat } from '@/lib/company/invite-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate {
  organizationId: string;
  isAdmin: boolean;
  managing: Awaited<ReturnType<typeof loadHats>>;
}

/**
 * Resolve "which company are we talking about, and does the caller run any of
 * it". Returns a string on refusal so each verb can shape its own response.
 */
async function gateFor(
  caller: Awaited<ReturnType<typeof verifyTeamManager>>,
  hotelId: string,
): Promise<Gate | string> {
  if (!caller) return 'Unauthorized';
  const organizationId = await companyForProperty(hotelId);
  if (!organizationId) return 'That hotel does not belong to a management company';
  const managing = managingHats(caller.hats ?? [])
    .filter((hat) => hat.organizationId === organizationId);
  if (!caller.isAdmin && managing.length === 0) {
    return 'You do not have a job at this company that can change what people do';
  }
  return { organizationId, isAdmin: caller.isAdmin, managing };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelId = searchParams.get('hotelId') ?? '';
  const accountId = searchParams.get('accountId') ?? '';
  for (const [value, label] of [[hotelId, 'hotelId'], [accountId, 'accountId']] as const) {
    const invalid = validateUuid(value, label).error;
    if (invalid) return err(invalid, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const capability = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capability === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capability === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const gate = await gateFor(caller, hotelId);
  // No company here is not an error — an independent hotel simply has no lines
  // to draw, and the card falls back to the single role it has always shown.
  if (typeof gate === 'string') return ok({ hats: [], organizationId: null }, { requestId });

  const hats = (await loadHats(accountId))
    .filter((hat) => hat.organizationId === gate.organizationId);

  const propertyIds = [...new Set(hats.flatMap((hat) => hat.coveredPropertyIds))];
  const names = new Map<string, string>();
  if (propertyIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .in('id', propertyIds);
    for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
      names.set(row.id, row.name);
    }
  }

  return ok({
    organizationId: gate.organizationId,
    hats: hats.map((hat) => ({
      membershipId: hat.membershipId,
      scope: hat.scope,
      role: hat.role,
      label: HAT_ROLE_LABELS[hat.role],
      jobTitle: hat.jobTitle,
      propertyIds: hat.coveredPropertyIds,
      propertyNames: hat.coveredPropertyIds.map((id) => names.get(id) ?? id),
    })),
  }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  let body: {
    hotelId?: string;
    accountId?: string;
    scope?: string;
    role?: string;
    propertyIds?: unknown;
    jobTitle?: string;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return err('A valid JSON body is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const hotelId = body.hotelId ?? '';
  const accountId = body.accountId ?? '';
  for (const [value, label] of [[hotelId, 'hotelId'], [accountId, 'accountId']] as const) {
    const invalid = validateUuid(value, label).error;
    if (invalid) return err(invalid, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const capability = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capability === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capability === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const gate = await gateFor(caller, hotelId);
  if (typeof gate === 'string') {
    return err(gate, { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const scope = body.scope;
  const role = body.role;
  if (!isMembershipScope(scope) || !isHatRole(role) || !scopeAllowsRole(scope, role)) {
    return err('That job cannot be given at that level', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const operated = new Set(await propertiesOfOrganization(gate.organizationId));
  let propertyIds: string[] = [];
  if (scope === 'property') {
    const raw = Array.isArray(body.propertyIds) ? body.propertyIds : [];
    propertyIds = [...new Set(raw.filter((id): id is string => typeof id === 'string'))].sort();
    if (propertyIds.length === 0) {
      return err('Choose at least one hotel for this job', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    // WALL B at this boundary: a hotel id from another company is refused here
    // and again by the trigger behind `staxis_set_membership_hat`.
    if (propertyIds.some((id) => !operated.has(id))) {
      return err('One of the chosen hotels is not part of this company', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }
  }

  if (!gate.isAdmin) {
    const allowed = gate.managing.some((hat) => canGrantHat(
      { scope: hat.scope, role: hat.role, coveredPropertyIds: hat.coveredPropertyIds },
      { scope, role, propertyIds },
    ));
    if (!allowed) {
      return err('You cannot give that job at those hotels', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }
  }

  const membershipId = await grantInvitedHat({
    actorAccountId: caller.accountId,
    organizationId: gate.organizationId,
    accountId,
    scope,
    role,
    propertyIds: scope === 'property' ? propertyIds : null,
    jobTitle: typeof body.jobTitle === 'string' && body.jobTitle.trim().length > 0
      ? body.jobTitle.trim().slice(0, 120)
      : null,
  });
  if (!membershipId) {
    log.error('[team/hats:POST] the job was refused by the database', {
      requestId, organizationId: gate.organizationId,
    });
    return err('That job could not be saved', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  await writeAudit({
    action: 'company.hat.add',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail,
    targetType: 'account',
    targetId: accountId,
    hotelId,
    metadata: { scope, role, propertyIds, organizationId: gate.organizationId, membershipId },
  });

  return ok({ membershipId }, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelId = searchParams.get('hotelId') ?? '';
  const membershipId = searchParams.get('membershipId') ?? '';
  for (const [value, label] of [[hotelId, 'hotelId'], [membershipId, 'membershipId']] as const) {
    const invalid = validateUuid(value, label).error;
    if (invalid) return err(invalid, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const capability = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capability === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capability === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const gate = await gateFor(caller, hotelId);
  if (typeof gate === 'string') {
    return err(gate, { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { data, error: rpcErr } = await supabaseAdmin.rpc('staxis_end_membership_hat', {
    p_actor_account_id: caller.accountId,
    p_membership_id: membershipId,
  });
  if (rpcErr) {
    log.warn('[team/hats:DELETE] refused', { requestId, msg: errToString(rpcErr) });
    return err('You cannot remove that job', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const removed = data === true
    || (data !== null && typeof data === 'object' && Object.values(data).includes(true));
  if (!removed) {
    return err('That job is already gone', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
    });
  }

  await writeAudit({
    action: 'company.hat.remove',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail,
    targetType: 'membership',
    targetId: membershipId,
    hotelId,
    metadata: { organizationId: gate.organizationId },
  });

  return ok({ success: true }, { requestId });
}
