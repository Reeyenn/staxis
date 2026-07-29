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

import { NextRequest, type NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid } from '@/lib/api-validate';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  isHatRole,
  isMembershipScope,
  scopeAllowsRole,
  HAT_ROLE_LABELS,
} from '@/lib/company/roles';
import { loadHats } from '@/lib/company/access';
import { requireSession } from '@/lib/api-auth';
import { loadOrganizationActor } from '@/lib/organization-access/server';
import {
  companyInviteAuthorityUnchanged,
  loadFreshCompanyInviteAuthorityContext,
  resolveAuthoritativeInviteScope,
  resolveLocalHotelInviteAuthority,
  type ResolvedAuthoritativeInviteScope,
} from '@/lib/company/account-invite-authority';
import {
  readCompleteCompanyIdChunks,
  type CompanyProjectionPage,
} from '@/lib/company-access/projection-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HatRouteActor {
  accountId: string;
  authUserId: string;
}

type HatRouteAuthentication =
  | { ok: true; actor: HatRouteActor }
  | { ok: false; response: NextResponse };

async function authenticateHatRoute(
  req: NextRequest,
  requestId: string,
): Promise<HatRouteAuthentication> {
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session;
  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) {
      return {
        ok: false,
        response: err('Unauthorized', {
          requestId, status: 403, code: ApiErrorCode.Unauthorized,
        }),
      };
    }
    return {
      ok: true,
      actor: {
        accountId: actor.accountId,
        authUserId: actor.authUserId,
      },
    };
  } catch (error) {
    log.error('[team/hats] authoritative actor lookup failed', {
      requestId, msg: errToString(error),
    });
    return { ok: false, response: capabilityUnavailableResponse(requestId) };
  }
}

function forbidden(requestId: string) {
  return err('Forbidden', {
    requestId, status: 403, code: ApiErrorCode.Forbidden,
  });
}

function sameResolvedScope(
  left: ResolvedAuthoritativeInviteScope,
  right: ResolvedAuthoritativeInviteScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.scope === right.scope
    && left.role === right.role
    && left.propertyIds.length === right.propertyIds.length
    && left.propertyIds.every((propertyId, index) => propertyId === right.propertyIds[index]);
}

/** organization_access_events stores a UUID request id. Preserve correlation
 * with the route's short/string request id without trusting a caller-supplied
 * value as SQL input. */
function auditRequestUuid(requestId: string): string {
  const digest = createHash('sha256').update(requestId).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}`
    + `-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const authentication = await authenticateHatRoute(req, requestId);
  if (!authentication.ok) return authentication.response;
  const { actor } = authentication;

  const { searchParams } = new URL(req.url);
  const hotelId = searchParams.get('hotelId') ?? '';
  const accountId = searchParams.get('accountId') ?? '';
  for (const [value, label] of [[hotelId, 'hotelId'], [accountId, 'accountId']] as const) {
    const invalid = validateUuid(value, label).error;
    if (invalid) return err(invalid, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const companyContext = await loadFreshCompanyInviteAuthorityContext({
    accountId: actor.accountId,
    anchorPropertyId: hotelId,
  });
  if (companyContext.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
  // No company here is not an error for a genuine local manager: an
  // independent hotel has no normalized lines, so its card uses the legacy
  // role. A foreign company id never falls into this compatibility branch.
  if (companyContext.kind === 'denied') {
    const local = await resolveLocalHotelInviteAuthority(actor.accountId, hotelId);
    if (local.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    return local.kind === 'allowed'
      ? ok({ hats: [], organizationId: null }, { requestId })
      : forbidden(requestId);
  }
  const readAuthority = resolveAuthoritativeInviteScope(
    companyContext.value,
    'front_desk',
    'property',
    [hotelId],
  );
  if (readAuthority.kind !== 'allowed') return forbidden(requestId);

  const hats = (await loadHats(accountId))
    .filter((hat) => hat.organizationId === companyContext.value.organizationId);

  // WALL A ON THE NAMES. The card is drawn by whoever is looking, and a
  // property-scope GM can legitimately open the card of somebody whose job is
  // company-wide. Resolving every hotel on that person's hats would then print
  // the whole portfolio's names — "GM — Beaumont · Oversees — Lufkin, Tyler,
  // Waco" — to a GM who has never been told Lufkin exists. That is the exact
  // thing a property-scope hat is supposed to prevent, leaking through a
  // read-only label.
  //
  // So names are resolved ONLY for hotels the CALLER can reach. Everything else
  // is counted, not named: the card still tells the truth about how wide the
  // job is (and a GM must know that the person they are looking at outranks
  // their own building), without handing over a directory. An admin, and a
  // company-scope caller whose own hats cover the portfolio, see every name as
  // before.
  const callerReach = companyContext.value.isPlatformAdmin
    ? null
    : new Set(companyContext.value.authorizedPropertyIds);

  const visibleIds = [...new Set(
    hats.flatMap((hat) => hat.coveredPropertyIds)
      .filter((id) => callerReach === null || callerReach.has(id)),
  )].sort();
  const names = new Map<string, string>();
  if (visibleIds.length > 0) {
    let rows: Array<{ id: string; name: string }>;
    try {
      rows = await readCompleteCompanyIdChunks(
        visibleIds,
        (chunk, from, to) => supabaseAdmin
          .from('properties')
          .select('id, name', { count: 'exact' })
          .in('id', [...chunk])
          .order('id')
          .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<{
            id: string;
            name: string;
          }>>,
      );
    } catch (error) {
      log.error('[team/hats:GET] exact hotel-name projection failed', {
        requestId, msg: errToString(error),
      });
      return capabilityUnavailableResponse(requestId);
    }
    const returnedIds = rows.map((row) => row.id).sort();
    if (returnedIds.length !== visibleIds.length
        || returnedIds.some((id, index) => id !== visibleIds[index])) {
      log.error('[team/hats:GET] hotel-name projection was incomplete', { requestId });
      return capabilityUnavailableResponse(requestId);
    }
    for (const row of rows) {
      names.set(row.id, row.name);
    }
  }

  const disclosedHats = hats.flatMap((hat) => {
    const named = hat.coveredPropertyIds.filter((id) => names.has(id));
    // An arbitrary account id must not be an oracle for jobs held only at
    // sister hotels. No in-scope intersection is indistinguishable from no
    // company hat at all.
    if (callerReach !== null && named.length === 0) return [];
    return [{
      membershipId: hat.membershipId,
      scope: hat.scope,
      role: hat.role,
      label: HAT_ROLE_LABELS[hat.role],
      jobTitle: hat.jobTitle,
      propertyIds: named,
      propertyNames: named.map((id) => names.get(id)!),
      // Keep the DTO shape uniform without admitting whether undisclosed
      // coverage exists. A redaction flag is itself a one-bit sister-hotel
      // oracle; this count describes only additional disclosed names.
      otherHotelCount: 0,
    }];
  });

  // Re-run the complete receipt immediately before egress. Retaining access to
  // the anchor alone is insufficient: a portfolio/region reduction must also
  // suppress names and job lines assembled from the earlier, wider scope.
  const finalContext = await loadFreshCompanyInviteAuthorityContext({
    accountId: actor.accountId,
    anchorPropertyId: hotelId,
    expectedOrganizationId: companyContext.value.organizationId,
  });
  if (finalContext.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (finalContext.kind !== 'allowed'
      || !companyInviteAuthorityUnchanged(companyContext.value, finalContext.value)
      || resolveAuthoritativeInviteScope(
        finalContext.value,
        'front_desk',
        'property',
        [hotelId],
      ).kind !== 'allowed') {
    return forbidden(requestId);
  }

  return ok({
    organizationId: companyContext.value.organizationId,
    hats: disclosedHats,
  }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const authentication = await authenticateHatRoute(req, requestId);
  if (!authentication.ok) return authentication.response;
  const { actor } = authentication;

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

  const scope = body.scope;
  const role = body.role;
  if (!isMembershipScope(scope) || !isHatRole(role) || !scopeAllowsRole(scope, role)) {
    return err('That job cannot be given at that level', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const companyContext = await loadFreshCompanyInviteAuthorityContext({
    accountId: actor.accountId,
    anchorPropertyId: hotelId,
  });
  if (companyContext.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (companyContext.kind !== 'allowed') return forbidden(requestId);
  const resolved = resolveAuthoritativeInviteScope(
    companyContext.value,
    role,
    scope,
    scope === 'property' ? body.propertyIds : [],
  );
  if (resolved.kind !== 'allowed') return forbidden(requestId);

  // Re-run the complete authority projection immediately before the database
  // writer. The writer performs the same hierarchy check under the
  // organization lock; this comparison also catches transfer/revocation with
  // a clean HTTP refusal before attempting a write.
  const freshContext = await loadFreshCompanyInviteAuthorityContext({
    accountId: actor.accountId,
    anchorPropertyId: hotelId,
    expectedOrganizationId: resolved.value.organizationId,
  });
  if (freshContext.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (freshContext.kind !== 'allowed') return forbidden(requestId);
  const commitScope = resolveAuthoritativeInviteScope(
    freshContext.value,
    role,
    scope,
    scope === 'property' ? resolved.value.propertyIds : [],
  );
  if (commitScope.kind !== 'allowed'
      || !sameResolvedScope(resolved.value, commitScope.value)) {
    return forbidden(requestId);
  }

  const auditRequestId = auditRequestUuid(requestId);
  const { data: guardedData, error: guardedError } = await supabaseAdmin.rpc(
    'staxis_set_membership_hat_guarded',
    {
      p_actor_account_id: actor.accountId,
      p_actor_auth_user_id: actor.authUserId,
      p_organization_id: resolved.value.organizationId,
      p_account_id: accountId,
      p_membership_scope: scope,
      p_staxis_role: role,
      p_property_ids: scope === 'property' ? resolved.value.propertyIds : null,
      p_job_title: typeof body.jobTitle === 'string' && body.jobTitle.trim().length > 0
        ? body.jobTitle.trim().slice(0, 120)
        : null,
      p_audit_request_id: auditRequestId,
    },
  );
  if (guardedError) {
    log.error('[team/hats:POST] the job was refused by the database', {
      requestId, organizationId: resolved.value.organizationId,
      code: guardedError.code, msg: errToString(guardedError),
    });
    if (guardedError.code === '55P03' || guardedError.code === '40001') {
      return capabilityUnavailableResponse(requestId);
    }
    return err('That job could not be saved', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }
  const guarded = guardedData !== null
      && typeof guardedData === 'object'
      && !Array.isArray(guardedData)
    ? guardedData as Record<string, unknown>
    : null;
  if (!guarded || guarded.ok !== true) return forbidden(requestId);
  const membershipReceipt = validateUuid(guarded.membershipId, 'membershipId');
  const organizationReceipt = validateUuid(guarded.organizationId, 'organizationId');
  const accountReceipt = validateUuid(guarded.accountId, 'accountId');
  const auditReceipt = validateUuid(guarded.auditRequestId, 'auditRequestId');
  if (membershipReceipt.error
      || organizationReceipt.error
      || organizationReceipt.value !== resolved.value.organizationId
      || accountReceipt.error
      || accountReceipt.value !== accountId
      || auditReceipt.error
      || auditReceipt.value !== auditRequestId) {
    log.error('[team/hats:POST] guarded writer returned a malformed receipt', { requestId });
    return err('That job could not be saved', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const membershipId = membershipReceipt.value!;

  return ok({ membershipId }, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const authentication = await authenticateHatRoute(req, requestId);
  if (!authentication.ok) return authentication.response;
  const { actor } = authentication;

  const { searchParams } = new URL(req.url);
  const hotelId = searchParams.get('hotelId') ?? '';
  const membershipId = searchParams.get('membershipId') ?? '';
  for (const [value, label] of [[hotelId, 'hotelId'], [membershipId, 'membershipId']] as const) {
    const invalid = validateUuid(value, label).error;
    if (invalid) return err(invalid, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const companyContext = await loadFreshCompanyInviteAuthorityContext({
    accountId: actor.accountId,
    anchorPropertyId: hotelId,
  });
  if (companyContext.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (companyContext.kind !== 'allowed') return forbidden(requestId);

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('organization_memberships')
    .select(
      'id, organization_id, membership_scope, staxis_role, covered_property_ids, ended_at',
    )
    .eq('id', membershipId)
    .maybeSingle();
  if (membershipError) {
    log.error('[team/hats:DELETE] membership lookup failed', {
      requestId, msg: errToString(membershipError),
    });
    return capabilityUnavailableResponse(requestId);
  }
  if (!membership
      || membership.ended_at !== null
      || membership.organization_id !== companyContext.value.organizationId
      || !isMembershipScope(membership.membership_scope)
      || !isHatRole(membership.staxis_role)) {
    return err('Not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  const exactAuthority = resolveAuthoritativeInviteScope(
    companyContext.value,
    membership.staxis_role,
    membership.membership_scope,
    membership.membership_scope === 'property'
      ? membership.covered_property_ids
      : [],
  );
  if (exactAuthority.kind !== 'allowed') {
    return err('Not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }

  const auditRequestId = auditRequestUuid(requestId);
  const { data, error: rpcErr } = await supabaseAdmin.rpc(
    'staxis_end_membership_hat_guarded',
    {
      p_actor_account_id: actor.accountId,
      p_actor_auth_user_id: actor.authUserId,
      p_membership_id: membershipId,
      p_audit_request_id: auditRequestId,
    },
  );
  if (rpcErr) {
    log.warn('[team/hats:DELETE] refused', { requestId, msg: errToString(rpcErr) });
    if (rpcErr.code === '55P03' || rpcErr.code === '40001') {
      return capabilityUnavailableResponse(requestId);
    }
    return err('You cannot remove that job', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const result = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
  if (!result || result.ok !== true) {
    if (result?.reason === 'not_found' || result?.reason === 'denied') {
      return err('Not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    return err('That job is already gone', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
    });
  }
  const membershipReceipt = validateUuid(result.membershipId, 'membershipId');
  const organizationReceipt = validateUuid(result.organizationId, 'organizationId');
  const auditReceipt = validateUuid(result.auditRequestId, 'auditRequestId');
  if (membershipReceipt.error || membershipReceipt.value !== membershipId
      || organizationReceipt.error
      || organizationReceipt.value !== exactAuthority.value.organizationId
      || auditReceipt.error || auditReceipt.value !== auditRequestId) {
    log.error('[team/hats:DELETE] guarded writer returned a malformed receipt', { requestId });
    return err('You cannot remove that job', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  return ok({ success: true }, { requestId });
}
