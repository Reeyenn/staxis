// /api/auth/invites — invite new accounts or add hotel access by email.
//   GET     ?hotelId=…          — pending invites for that hotel, hotel jobs
//   GET     ?organizationId=…   — pending invites across the company, company
//                                 jobs. The company view has no selected hotel.
//   POST                        — invite a new email or grant an existing account
//   DELETE  ?id=…               — revoke an invite (deletes the row)
//
// Caller must be admin / owner / general_manager. Owner/GM are scoped to
// hotels in their property_access; admin can manage any hotel.
//
// COMPANY SPINE (0364, rescoped 0464). The POST body has three shapes:
//
//   { hotelId, email, role, staffId? }               the hotel request. A GM is
//                                                    never asked which hotel —
//                                                    theirs is implied.
//   { hotelId, email, role, scope:'property',        an exact list of hotels.
//     propertyIds:[…], staffId? }
//   { hotelId, email, role, scope:'company',         a company job. `propertyIds`
//     propertyIds?:[…] }                             names the hotels it reaches;
//                                                    ABSENT or EMPTY means every
//                                                    hotel the company operates,
//                                                    including ones added later.
//
// `propertyIds` may name only hotels inside the caller's OWN company, and only
// hotels the caller themselves reaches — that is Wall B at the invitation
// boundary. Before 0464 a company job was always all-hotels-forever, which is
// why absent still means that: the old callers meant it.
//
// A new email gets a pending invitation. An active existing account receives
// the authorized access directly, without another email round trip.

import { NextRequest, type NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { requireSession } from '@/lib/api-auth';
import { accountInviteDelivery, accountInviteStatus } from '@/lib/account-invites';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { sendHotelAccountInvite } from '@/lib/email/hotel-account-invite';
import type { SendEmailResult } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { findStaxisAccountByEmail } from '@/lib/auth-create-user';
import {
  companyInviteAuthorityUnchanged,
  loadCompanyInviteAuthorityContextForOrganization,
  loadFreshCompanyInviteAuthorityContext,
  projectStoredInviteForCompanyContext,
  projectStoredInviteForCompanyView,
  resolveAuthoritativeInviteScope,
  resolveLocalHotelInviteAuthority,
  type CompanyInviteAuthorityContext,
  type ProjectedStoredInviteScope,
  type ResolvedAuthoritativeInviteScope,
} from '@/lib/company/account-invite-authority';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  ASSIGNABLE_ROLES,
  canGrantHotelRole,
  isAssignableRole,
  type AppRole,
  type AssignableRole,
} from '@/lib/roles';
import { HAT_ROLE_LABELS, type HatRole } from '@/lib/company/roles';
import {
  ensureManagerStaffIdentityBestEffort,
  managerRosterPropertyIds,
} from '@/lib/schedule/staff-identity';
import { resolveCompanyForProperty } from '@/lib/company/access';
import { loadOrganizationActor } from '@/lib/organization-access/server';
import {
  readCompleteCompanyIdChunks,
  readCompleteCompanyPages,
  type CompanyProjectionPage,
} from '@/lib/company-access/projection-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STAFF_LINKABLE_ROLES = new Set(['front_desk', 'housekeeping', 'maintenance']);

function hashToken(t: string) { return createHash('sha256').update(t).digest('hex'); }
function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

interface InviteRouteActor {
  accountId: string;
  authUserId: string;
  authEmail: string | null;
}

type InviteRouteAuthentication =
  | { ok: true; actor: InviteRouteActor }
  | { ok: false; response: NextResponse };

async function authenticateInviteRoute(
  req: NextRequest,
  requestId: string,
): Promise<InviteRouteAuthentication> {
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session;
  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) {
      return {
        ok: false,
        response: err('Unauthorized', {
          requestId,
          status: 403,
          code: ApiErrorCode.Unauthorized,
        }),
      };
    }
    return {
      ok: true,
      actor: {
        accountId: actor.accountId,
        authUserId: actor.authUserId,
        authEmail: actor.email,
      },
    };
  } catch (authError) {
    log.error('[invites] authoritative actor lookup failed', {
      requestId,
      msg: errToString(authError),
    });
    return { ok: false, response: capabilityUnavailableResponse(requestId) };
  }
}

function authorityDenied(requestId: string) {
  return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
}

/**
 * Put an already-existing Staxis login on this hotel's staff list.
 *
 * The brand-new-login path does this inside /api/auth/accept-invite. This is
 * the same bridge for the other half of the same button: an email that already
 * belongs to a Staxis account receives the access immediately, with no
 * acceptance step, so "accepted" for that person is this grant.
 */
async function joinHotelStaffListForExistingAccount(input: {
  accountId: string | undefined;
  propertyIds: readonly string[];
  actorAccountId: string;
  requestId: string;
}): Promise<void> {
  if (!input.accountId || input.propertyIds.length === 0) return;
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('display_name, data_user_id')
    .eq('id', input.accountId)
    .maybeSingle();
  if (error || typeof data?.data_user_id !== 'string') {
    log.error('[invites:POST] roster bridge could not read the granted account', {
      requestId: input.requestId,
      msg: error ? errToString(error) : 'account identity unavailable',
    });
    return;
  }
  for (const propertyId of input.propertyIds) {
    await ensureManagerStaffIdentityBestEffort({
      accountId: input.accountId,
      propertyId,
      authUserId: data.data_user_id,
      displayName: typeof data.display_name === 'string' ? data.display_name : 'Manager',
      actorAccountId: input.actorAccountId,
      source: 'invitation',
    }, { requestId: input.requestId });
  }
}

function normalizedInviteRow(row: StoredInviteRow): boolean {
  return row.organization_id !== null
    || row.membership_scope !== null
    || row.covered_property_ids !== null;
}

function sameInviteScope(
  left: ResolvedAuthoritativeInviteScope,
  right: ResolvedAuthoritativeInviteScope,
): boolean {
  const sameCoverage = left.coveredPropertyIds === null || right.coveredPropertyIds === null
    ? left.coveredPropertyIds === right.coveredPropertyIds
    : left.coveredPropertyIds.length === right.coveredPropertyIds.length
      && left.coveredPropertyIds.every(
        (propertyId, index) => propertyId === right.coveredPropertyIds![index],
      );
  return left.organizationId === right.organizationId
    && left.scope === right.scope
    && left.role === right.role
    // An explicit list and all-including-future can expand to the same hotels
    // today and still be different promises. Compare both.
    && sameCoverage
    && left.propertyIds.length === right.propertyIds.length
    && left.propertyIds.every((propertyId, index) => propertyId === right.propertyIds[index]);
}

interface StoredInviteRow {
  id: string;
  hotel_id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  organization_id: string | null;
  membership_scope: string | null;
  covered_property_ids: unknown;
}

interface VisibleInviteProjection {
  row: StoredInviteRow;
  organizationId: string | null;
  scope: 'hotel' | 'company' | 'property';
  propertyIds: string[];
  canRevoke: boolean;
}

const MAX_VISIBLE_PENDING_INVITES = 5_000;

function storedInviteScope(row: StoredInviteRow) {
  return {
    hotelId: row.hotel_id,
    organizationId: row.organization_id,
    membershipScope: row.membership_scope,
    role: row.role,
    coveredPropertyIds: row.covered_property_ids,
  };
}

function sameProjectedScope(
  left: ProjectedStoredInviteScope,
  right: ProjectedStoredInviteScope,
): boolean {
  return left.scope === right.scope
    && left.role === right.role
    && left.canRevoke === right.canRevoke
    && left.propertyIds.length === right.propertyIds.length
    && left.propertyIds.every((propertyId, index) => propertyId === right.propertyIds[index]);
}

async function exactPropertyNames(propertyIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(propertyIds)].sort();
  if (ids.length === 0) return new Map();
  const data = await readCompleteCompanyIdChunks<{ id: string; name: string }>(
    ids,
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
  if (data.some((row) => typeof row.id !== 'string'
      || typeof row.name !== 'string'
      || row.name.trim().length === 0)) {
    throw new Error('property names contained malformed rows');
  }
  const returnedIds = data.map((row) => row.id).sort();
  if (returnedIds.length !== ids.length
      || returnedIds.some((propertyId, index) => propertyId !== ids[index])) {
    throw new Error('property names were incomplete');
  }
  return new Map(data.map((row) => [row.id, row.name]));
}

/**
 * WHAT THE INVITATION EMAIL SAYS YOU ARE BEING INVITED TO.
 *
 * This used to be whichever hotel happened to be the authority anchor, which
 * made "You're invited to Port Arthur Inn on Staxis" the subject line for a
 * company job covering twelve hotels, and for a three-hotel grant that did not
 * especially involve Port Arthur. It named a real place, so it did not look
 * wrong, it just was.
 *
 *   company scope    the company. That is the thing being joined.
 *   several hotels   "Port Arthur Inn and 2 more".
 *   one hotel        the hotel, exactly as before.
 *
 * Falls back to the anchor hotel name if a lookup comes back empty, because a
 * slightly imprecise subject line is better than no invitation at all.
 */
async function inviteDestinationName(
  hat: ResolvedAuthoritativeInviteScope | null,
  anchorHotelName: string,
): Promise<string> {
  if (!hat) return anchorHotelName;
  try {
    if (hat.scope === 'company') {
      const { data, error } = await supabaseAdmin
        .from('organizations')
        .select('name')
        .eq('id', hat.organizationId)
        .maybeSingle();
      if (error) throw error;
      const name = typeof data?.name === 'string' ? data.name.trim() : '';
      return name.length > 0 ? name : anchorHotelName;
    }
    if (hat.propertyIds.length <= 1) return anchorHotelName;
    const names = await exactPropertyNames(hat.propertyIds);
    const ordered = hat.propertyIds
      .map((propertyId) => names.get(propertyId) ?? '')
      .filter((name) => name.trim().length > 0)
      .sort((left, right) => left.localeCompare(right));
    if (ordered.length === 0) return anchorHotelName;
    if (ordered.length === 1) return ordered[0]!;
    if (ordered.length === 2) return `${ordered[0]} and ${ordered[1]}`;
    return `${ordered[0]} and ${ordered.length - 1} more`;
  } catch {
    return anchorHotelName;
  }
}

/**
 * Pending invitations and invite options for a whole COMPANY.
 *
 * Same authority rules as the per-hotel listing, asked without a selected
 * hotel. The authority generation is re-read after the paged database work and
 * compared, so a revocation landing mid-read produces a refusal rather than a
 * stale list — the same discipline the per-hotel path uses.
 */
async function companyInviteListing(
  actor: InviteRouteActor,
  organizationIdRaw: string,
  requestId: string,
) {
  const organizationIdCheck = validateUuid(organizationIdRaw, 'organizationId');
  if (organizationIdCheck.error || !organizationIdCheck.value) {
    return err(organizationIdCheck.error ?? 'organizationId is invalid', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const organizationId = organizationIdCheck.value;

  const context = await loadCompanyInviteAuthorityContextForOrganization({
    accountId: actor.accountId,
    organizationId,
  });
  if (context.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (context.kind !== 'allowed') return authorityDenied(requestId);

  let rows: StoredInviteRow[] = [];
  try {
    rows = await readCompleteCompanyPages<StoredInviteRow>((from, to) => (
      supabaseAdmin
        .from('account_invites')
        .select(
          'id, hotel_id, email, role, expires_at, created_at, accepted_at, organization_id, membership_scope, covered_property_ids',
          { count: 'exact' },
        )
        .eq('organization_id', organizationId)
        .is('accepted_at', null)
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<StoredInviteRow>>
    ), { maxRows: MAX_VISIBLE_PENDING_INVITES });
  } catch (queryError) {
    log.error('[invites:GET] complete company pending-invite read failed', {
      requestId, msg: errToString(queryError),
    });
    return capabilityUnavailableResponse(requestId);
  }
  if (rows.some((row) => !normalizedInviteRow(row))) {
    log.error('[invites:GET] company pending-invite query returned an invalid partition', {
      requestId,
    });
    return capabilityUnavailableResponse(requestId);
  }

  const projections = new Map<string, ProjectedStoredInviteScope>();
  for (const row of rows) {
    const projection = projectStoredInviteForCompanyView(context.value, storedInviteScope(row));
    if (projection) projections.set(row.id, projection);
  }

  let options: InviteOptions;
  try {
    options = await inviteOptionsFor(context.value, 'company');
  } catch (optionsErr) {
    log.warn('[invites:GET] company options unavailable', {
      requestId, msg: errToString(optionsErr),
    });
    // A failed options projection is not an authorized empty result. Returning
    // empty jobs here would make the People panel treat an upstream outage as
    // a truthful, action-free company while the pending list remains stale.
    // Fail closed so the client can show its retryable load state instead.
    return capabilityUnavailableResponse(requestId);
  }

  let propertyNames: Map<string, string>;
  try {
    propertyNames = await exactPropertyNames(
      [...projections.values()].flatMap((projection) => projection.propertyIds),
    );
  } catch (nameError) {
    log.error('[invites:GET] company property-name projection failed', {
      requestId, msg: errToString(nameError),
    });
    return capabilityUnavailableResponse(requestId);
  }

  // Re-assert the exact authority generation before anything leaves.
  const finalContext = await loadCompanyInviteAuthorityContextForOrganization({
    accountId: actor.accountId,
    organizationId,
  });
  if (finalContext.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (finalContext.kind !== 'allowed'
      || !companyInviteAuthorityUnchanged(context.value, finalContext.value)) {
    return authorityDenied(requestId);
  }
  for (const row of rows) {
    const initial = projections.get(row.id);
    const final = projectStoredInviteForCompanyView(finalContext.value, storedInviteScope(row));
    if (!!initial !== !!final
        || (initial && final && !sameProjectedScope(initial, final))) {
      return authorityDenied(requestId);
    }
  }

  const nowMs = Date.now();
  const invites = rows.flatMap((row) => {
    const projection = projections.get(row.id);
    if (!projection) return [];
    const status = accountInviteStatus(row.expires_at, nowMs);
    return [{
      id: row.id,
      email: row.email,
      role: row.role,
      expires_at: row.expires_at,
      created_at: row.created_at,
      accepted_at: row.accepted_at,
      status,
      isExpired: status === 'expired',
      organizationId,
      scope: projection.scope,
      propertyIds: projection.propertyIds,
      propertyNames: projection.propertyIds.map((propertyId) => propertyNames.get(propertyId)!),
      canRevoke: projection.canRevoke,
      /** null means the promise follows the company into hotels it buys later. */
      coversAllIncludingFuture: projection.scope === 'company'
        && row.covered_property_ids === null,
    }];
  });
  return ok({ invites, options }, { requestId });
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const authentication = await authenticateInviteRoute(req, requestId);
  if (!authentication.ok) return authentication.response;
  const { actor } = authentication;

  const { searchParams } = new URL(req.url);
  const organizationIdRaw = searchParams.get('organizationId');
  const hotelIdRaw = searchParams.get('hotelId');

  // The company view asks by COMPANY, because it has no hotel selected. It is
  // a different question from "who is pending at this hotel" and gets a
  // different answer: company jobs to offer, and every pending invitation the
  // caller can see anywhere in the company.
  if (organizationIdRaw && !hotelIdRaw) {
    return companyInviteListing(actor, organizationIdRaw, requestId);
  }

  if (!hotelIdRaw) return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelIdCheck = validateUuid(hotelIdRaw, 'hotelId');
  if (hotelIdCheck.error || !hotelIdCheck.value) {
    return err(hotelIdCheck.error ?? 'hotelId is invalid', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const hotelId = hotelIdCheck.value;
  const initialTopology = await resolveCompanyForProperty(hotelId);
  if (initialTopology.status === 'unavailable' || initialTopology.status === 'ambiguous') {
    return capabilityUnavailableResponse(requestId);
  }

  const companyContext = await loadFreshCompanyInviteAuthorityContext({
    accountId: actor.accountId,
    anchorPropertyId: hotelId,
  });
  const companyRead = companyContext.kind === 'allowed'
    ? resolveAuthoritativeInviteScope(
        companyContext.value,
        'front_desk',
        'property',
        [hotelId],
      )
    : companyContext;
  const localAuthority = await resolveLocalHotelInviteAuthority(actor.accountId, hotelId, {
    requireIndependentTopology: true,
  });
  if (companyContext.kind === 'unavailable'
      || (companyRead.kind !== 'allowed' && localAuthority.kind === 'unavailable')) {
    return capabilityUnavailableResponse(requestId);
  }
  if (companyRead.kind !== 'allowed' && localAuthority.kind !== 'allowed') {
    return authorityDenied(requestId);
  }
  if (companyContext.kind === 'allowed'
      && (initialTopology.status !== 'company'
        || initialTopology.organizationId !== companyContext.value.organizationId)) {
    return capabilityUnavailableResponse(requestId);
  }

  const canReadNormalized = companyContext.kind === 'allowed'
    && companyRead.kind === 'allowed';
  // A pre-acquisition null-org invite is no longer actionable once this hotel
  // joins a real company: both guarded revoke and acceptance reject that old
  // shape. Do not advertise a dead control or stale promise.
  const canReadLegacy = localAuthority.kind === 'allowed'
    && initialTopology.status === 'independent';
  let normalizedRows: StoredInviteRow[] = [];
  let legacyRows: StoredInviteRow[] = [];
  try {
    if (canReadNormalized) {
      normalizedRows = await readCompleteCompanyPages<StoredInviteRow>((from, to) => (
        supabaseAdmin
          .from('account_invites')
          .select(
            'id, hotel_id, email, role, expires_at, created_at, accepted_at, organization_id, membership_scope, covered_property_ids',
            { count: 'exact' },
          )
          .eq('organization_id', companyContext.value.organizationId)
          .is('accepted_at', null)
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<StoredInviteRow>>
      ), { maxRows: MAX_VISIBLE_PENDING_INVITES });
    }
    if (canReadLegacy) {
      legacyRows = await readCompleteCompanyPages<StoredInviteRow>((from, to) => (
        supabaseAdmin
          .from('account_invites')
          .select(
            'id, hotel_id, email, role, expires_at, created_at, accepted_at, organization_id, membership_scope, covered_property_ids',
            { count: 'exact' },
          )
          .eq('hotel_id', hotelId)
          .is('organization_id', null)
          .is('membership_scope', null)
          .is('covered_property_ids', null)
          .is('accepted_at', null)
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<StoredInviteRow>>
      ), { maxRows: MAX_VISIBLE_PENDING_INVITES - normalizedRows.length });
    }
  } catch (queryError) {
    log.error('[invites:GET] complete pending-invite read failed', {
      requestId, msg: errToString(queryError),
    });
    return capabilityUnavailableResponse(requestId);
  }

  if (normalizedRows.some((row) => !normalizedInviteRow(row))
      || legacyRows.some(normalizedInviteRow)
      || new Set([...normalizedRows, ...legacyRows].map((row) => row.id)).size
        !== normalizedRows.length + legacyRows.length) {
    log.error('[invites:GET] pending-invite query returned an invalid scope partition', {
      requestId,
    });
    return capabilityUnavailableResponse(requestId);
  }

  const normalizedProjections = new Map<string, ProjectedStoredInviteScope>();
  if (canReadNormalized) {
    for (const row of normalizedRows) {
      const projection = projectStoredInviteForCompanyContext(
        companyContext.value,
        storedInviteScope(row),
        hotelId,
      );
      if (projection) normalizedProjections.set(row.id, projection);
    }
  }
  const visible: VisibleInviteProjection[] = [
    ...normalizedRows.flatMap((row): VisibleInviteProjection[] => {
      const projection = normalizedProjections.get(row.id);
      return projection ? [{
        row,
        organizationId: companyContext.kind === 'allowed'
          ? companyContext.value.organizationId
          : null,
        scope: projection.scope,
        propertyIds: projection.propertyIds,
        canRevoke: projection.canRevoke,
      }] : [];
    }),
    ...legacyRows.flatMap((row): VisibleInviteProjection[] => (
      isAssignableRole(row.role) && localAuthority.kind === 'allowed'
        ? [{
            row,
            organizationId: null,
            scope: 'hotel',
            propertyIds: [hotelId],
            canRevoke: canGrantHotelRole(localAuthority.value.roleAtHotel, row.role),
          }]
        : []
    )),
  ].sort((left, right) => (
    right.row.created_at.localeCompare(left.row.created_at)
      || left.row.id.localeCompare(right.row.id)
  ));

  let propertyNames: Map<string, string>;
  try {
    propertyNames = await exactPropertyNames(visible.flatMap((invite) => invite.propertyIds));
  } catch (nameError) {
    log.error('[invites:GET] exact property-name projection failed', {
      requestId, msg: errToString(nameError),
    });
    return capabilityUnavailableResponse(requestId);
  }

  // What the invite form should ask. For an independent hotel this is the two
  // questions it has always asked; for someone who runs a company it also
  // carries the list their third question is chosen from. Attached to the read
  // the dialog already makes rather than a second endpoint.
  let options: InviteOptions = {
    choosesHotels: false, organizationId: null, jobs: [], hotels: [],
    allowsAllIncludingFuture: false,
  };
  try {
    if (canReadNormalized) options = await inviteOptionsFor(companyContext.value, 'hotel');
    else if (canReadLegacy && localAuthority.kind === 'allowed') {
      options = await localInviteOptionsFor(hotelId, localAuthority.value.roleAtHotel);
    }
  } catch (optionsErr) {
    // The pending list remains useful, but an incomplete options projection
    // must disable creation rather than fall back to a privileged client role.
    log.warn('[invites:GET] company options unavailable', { requestId, msg: errToString(optionsErr) });
  }

  // Reassert the exact authority generation immediately before any invitation
  // email/scope leaves the process. A revocation or hotel transfer that lands
  // while the complete paged read is running turns this response into a
  // refusal, never a stale People payload.
  if (companyContext.kind === 'allowed') {
    const finalContext = await loadFreshCompanyInviteAuthorityContext({
      accountId: actor.accountId,
      anchorPropertyId: hotelId,
      expectedOrganizationId: companyContext.value.organizationId,
    });
    if (finalContext.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (finalContext.kind !== 'allowed'
        || !companyInviteAuthorityUnchanged(companyContext.value, finalContext.value)) {
      return authorityDenied(requestId);
    }
    const finalRead = resolveAuthoritativeInviteScope(
      finalContext.value,
      'front_desk',
      'property',
      [hotelId],
    );
    if ((canReadNormalized && finalRead.kind !== 'allowed')
        || (!canReadNormalized && finalRead.kind === 'allowed')) {
      return authorityDenied(requestId);
    }
    for (const row of normalizedRows) {
      const initialProjection = normalizedProjections.get(row.id);
      const finalProjection = projectStoredInviteForCompanyContext(
        finalContext.value,
        storedInviteScope(row),
        hotelId,
      );
      if (!!initialProjection !== !!finalProjection
          || (initialProjection && finalProjection
            && !sameProjectedScope(initialProjection, finalProjection))) {
        return authorityDenied(requestId);
      }
    }
  } else {
    const finalCompany = await loadFreshCompanyInviteAuthorityContext({
      accountId: actor.accountId,
      anchorPropertyId: hotelId,
    });
    if (finalCompany.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (finalCompany.kind !== 'denied') return authorityDenied(requestId);
  }

  if (localAuthority.kind === 'allowed') {
    const finalLocal = await resolveLocalHotelInviteAuthority(actor.accountId, hotelId, {
      freshCapability: true,
      requireIndependentTopology: true,
    });
    if (finalLocal.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (finalLocal.kind !== 'allowed'
        || finalLocal.value.roleAtHotel !== localAuthority.value.roleAtHotel) {
      return authorityDenied(requestId);
    }
  }

  const finalTopology = await resolveCompanyForProperty(hotelId);
  if (finalTopology.status === 'unavailable' || finalTopology.status === 'ambiguous') {
    return capabilityUnavailableResponse(requestId);
  }
  if (finalTopology.status !== initialTopology.status
      || (initialTopology.status === 'company'
        && (finalTopology.status !== 'company'
          || finalTopology.organizationId !== initialTopology.organizationId))) {
    return authorityDenied(requestId);
  }

  const nowMs = Date.now();
  const invites = visible.map(({ row, organizationId, scope, propertyIds, canRevoke }) => {
    const status = accountInviteStatus(row.expires_at, nowMs);
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      expires_at: row.expires_at,
      created_at: row.created_at,
      accepted_at: row.accepted_at,
      status,
      isExpired: status === 'expired',
      organizationId,
      scope,
      propertyIds,
      propertyNames: propertyIds.map((propertyId) => propertyNames.get(propertyId)!),
      canRevoke,
    };
  });
  return ok({ invites, options }, { requestId });
}

interface InviteOptions {
  /** Ask the third question — "which hotels?" — only when this is true. */
  choosesHotels: boolean;
  organizationId: string | null;
  jobs: Array<{
    value: string;
    scope: 'company' | 'property';
    label: { en: string; es: string };
    allowedPropertyIds: string[];
  }>;
  hotels: Array<{ id: string; name: string }>;
  /**
   * May this caller choose "all hotels, including ones added later"? Only
   * somebody whose own authority already follows the company forward. An owner
   * standing on an explicit list gets the checkboxes and not this.
   */
  allowsAllIncludingFuture: boolean;
}

/**
 * WHICH SCREEN IS ASKING.
 *
 * `hotel`   the People list of one hotel. Hotel jobs only. Owner and Regional
 *           Manager are company jobs and have no business in a dropdown headed
 *           "what job at this hotel" — offering them there was how somebody
 *           handed out company-wide authority while thinking about one
 *           building.
 * `company` the company view. Company jobs only, each with the which-hotels
 *           question attached.
 */
type InviteSurface = 'hotel' | 'company';

async function inviteOptionsFor(
  context: CompanyInviteAuthorityContext,
  surface: InviteSurface,
): Promise<InviteOptions> {
  const jobs: InviteOptions['jobs'] = [];
  const offer = (
    value: HatRole,
    scope: 'company' | 'property',
    allowedPropertyIds: string[],
  ) => {
    if (jobs.some((job) => job.value === value)) return;
    jobs.push({ value, scope, label: HAT_ROLE_LABELS[value], allowedPropertyIds });
  };
  if (surface === 'hotel') {
    for (const role of ['general_manager', 'front_desk', 'housekeeping', 'maintenance'] as const) {
      const allowedPropertyIds = context.operatedPropertyIds.filter((propertyId) => (
        resolveAuthoritativeInviteScope(
          context,
          role,
          'property',
          [propertyId],
        ).kind === 'allowed'
      ));
      if (allowedPropertyIds.length > 0) offer(role, 'property', allowedPropertyIds);
    }
  } else {
    for (const role of ['owner', 'regional_manager'] as const) {
      // A company job is offered when the caller could grant it over AT LEAST
      // one hotel. Which hotels they may actually tick is `allowedPropertyIds`.
      const allowedPropertyIds = context.operatedPropertyIds.filter((propertyId) => (
        resolveAuthoritativeInviteScope(
          context,
          role,
          'company',
          [propertyId],
        ).kind === 'allowed'
      ));
      if (allowedPropertyIds.length > 0) offer(role, 'company', allowedPropertyIds);
    }
  }

  const propertyIds = [...new Set(jobs.flatMap((job) => job.allowedPropertyIds))].sort();
  let hotels: InviteOptions['hotels'] = [];
  if (propertyIds.length > 0) {
    const names = await exactPropertyNames(propertyIds);
    hotels = propertyIds
      .map((id) => ({ id, name: names.get(id)! }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const allowsAllIncludingFuture = surface === 'company'
    && jobs.length > 0
    && jobs.some((job) => resolveAuthoritativeInviteScope(
      context,
      job.value,
      'company',
      null,
    ).kind === 'allowed');

  return {
    choosesHotels: surface === 'company' || hotels.length > 1,
    organizationId: context.organizationId,
    jobs,
    hotels,
    allowsAllIncludingFuture,
  };
}

async function localInviteOptionsFor(
  hotelId: string,
  roleAtHotel: AppRole,
): Promise<InviteOptions> {
  const names = await exactPropertyNames([hotelId]);
  const jobs = ASSIGNABLE_ROLES
    .filter((role) => canGrantHotelRole(roleAtHotel, role))
    .map((role) => ({
      value: role,
      scope: 'property' as const,
      label: HAT_ROLE_LABELS[role],
      allowedPropertyIds: [hotelId],
    }));
  return {
    choosesHotels: false,
    organizationId: null,
    jobs,
    hotels: [{ id: hotelId, name: names.get(hotelId)! }],
    allowsAllIncludingFuture: false,
  };
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const authentication = await authenticateInviteRoute(req, requestId);
  if (!authentication.ok) return authentication.response;
  const { actor } = authentication;

  let body: {
    hotelId?: string;
    email?: string;
    role?: string;
    scope?: string;
    propertyIds?: unknown;
    staffId?: unknown;
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
  const hotelIdValidation = validateUuid(hotelId, 'hotelId');
  if (hotelIdValidation.error) {
    return err(hotelIdValidation.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const companyContext = await loadFreshCompanyInviteAuthorityContext({
    accountId: actor.accountId,
    anchorPropertyId: hotelId,
  });
  if (companyContext.kind === 'unavailable') return capabilityUnavailableResponse(requestId);

  const explicitCompanyShape = Object.prototype.hasOwnProperty.call(body, 'scope')
    || Object.prototype.hasOwnProperty.call(body, 'propertyIds');
  let hat: ResolvedAuthoritativeInviteScope | null = null;
  let localAuthority: Awaited<ReturnType<typeof resolveLocalHotelInviteAuthority>> | null = null;
  if (companyContext.kind === 'allowed') {
    const resolved = resolveAuthoritativeInviteScope(
      companyContext.value,
      role,
      explicitCompanyShape ? body.scope : 'property',
      explicitCompanyShape ? body.propertyIds : [hotelId],
    );
    if (resolved.kind !== 'allowed') return authorityDenied(requestId);
    hat = resolved.value;
  } else {
    if (explicitCompanyShape) return authorityDenied(requestId);
    localAuthority = await resolveLocalHotelInviteAuthority(actor.accountId, hotelId, {
      requireIndependentTopology: true,
    });
    if (localAuthority.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (localAuthority.kind === 'denied') return authorityDenied(requestId);
  }

  // An explicit company list is a finite promise. Keep the authority anchor
  // inside that promise before touching a target staff row or either guarded
  // writer. NULL coverage is the legacy all-hotels (including future) shape,
  // so it intentionally keeps the existing anchor behavior.
  const explicitCompanyAnchorMismatch = hat?.scope === 'company'
    && hat.coveredPropertyIds !== null
    && !hat.coveredPropertyIds.includes(hotelId);
  if (explicitCompanyAnchorMismatch) {
    return err('The selected access scope must include the invitation anchor hotel', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
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
    if (localAuthority?.kind !== 'allowed'
        || !canGrantHotelRole(localAuthority.value.roleAtHotel, role)) {
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

  let targetStaffId: string | null = null;
  if (Object.prototype.hasOwnProperty.call(body, 'staffId')) {
    const staffIdValidation = validateUuid(body.staffId, 'staffId');
    if (staffIdValidation.error || !staffIdValidation.value) {
      return err(staffIdValidation.error ?? 'Invalid staffId', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    targetStaffId = staffIdValidation.value;
  }
  if (targetStaffId) {
    if (!STAFF_LINKABLE_ROLES.has(role)) {
      return err('A staff profile can only be linked to an operational hotel role', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    if (hat !== null
      && hat.scope !== 'company'
      && !hat.propertyIds.includes(hotelId)) {
      return err('The selected access scope must include the staff profile\'s hotel', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    const { data: staff, error: staffError } = await supabaseAdmin
      .from('staff')
      .select('id, property_id, department, is_active')
      .eq('id', targetStaffId)
      .eq('property_id', hotelId)
      .maybeSingle();
    if (staffError) {
      log.error('[invites:POST] staff lookup failed', {
        requestId,
        staffId: targetStaffId,
        msg: errToString(staffError),
      });
      return capabilityUnavailableResponse(requestId);
    }
    if (!staff
        || staff.property_id !== hotelId
        || staff.is_active !== true
        || (staff.department ?? 'housekeeping') !== role) {
      return err('The selected staff profile is not available for this hotel and role', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
  }

  // Re-resolve from current primary authority immediately before the write.
  // Revocation, transfer, or target-hotel removal between form load and submit
  // therefore fails closed instead of preserving a stale invitation promise.
  if (hat) {
    const freshContext = await loadFreshCompanyInviteAuthorityContext({
      accountId: actor.accountId,
      anchorPropertyId: hotelId,
      expectedOrganizationId: hat.organizationId,
    });
    if (freshContext.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (freshContext.kind !== 'allowed') return authorityDenied(requestId);
    const freshScope = resolveAuthoritativeInviteScope(
      freshContext.value,
      hat.role,
      hat.scope,
      hat.coveredPropertyIds ?? [],
    );
    if (freshScope.kind !== 'allowed' || !sameInviteScope(hat, freshScope.value)) {
      return authorityDenied(requestId);
    }
  } else {
    const freshLocal = await resolveLocalHotelInviteAuthority(actor.accountId, hotelId, {
      freshCapability: true,
      requireIndependentTopology: true,
    });
    if (freshLocal.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (freshLocal.kind !== 'allowed'
        || !isAssignableRole(role)
        || !canGrantHotelRole(freshLocal.value.roleAtHotel, role)) {
      return authorityDenied(requestId);
    }
  }

  // `hotel_id` is the authority anchor used again at revoke and acceptance.
  // For an exact property promise it must be one of the promised hotels, not
  // merely whichever company hotel happened to have the People screen open.
  // A linked staff profile makes its own hotel the anchor; otherwise the
  // resolver's sorted, non-empty set gives us a stable anchor.
  const inviteAnchorHotelId = targetStaffId
    ? hotelId
    : hat?.scope === 'property'
      ? hat.propertyIds[0]!
      : hotelId;

  const accountLookup = await findStaxisAccountByEmail(normalizedEmail);
  if (accountLookup.kind === 'unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  if (accountLookup.kind === 'protected_identity') {
    const protectedIdentityMessage = accountLookup.reason === 'property_owner'
      ? 'This login is already tied to a hotel owner. Restore its account before adding access.'
      : 'This login was just created. Finish or recover that signup before adding access.';
    return err(protectedIdentityMessage, {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }
  if (accountLookup.kind === 'found') {
    if (!accountLookup.active) {
      return err('This Staxis account is inactive. Reactivate it before adding hotel access.', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
      });
    }
    const accountIdValidation = validateUuid(accountLookup.accountId, 'accountId');
    if (accountIdValidation.error || !accountIdValidation.value) {
      log.error('[invites:POST] account lookup returned a malformed account id', { requestId });
      return err('Failed to add hotel access', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    const { data: guardedGrantData, error: guardedGrantError } = await supabaseAdmin.rpc(
      'staxis_grant_existing_account_invite_guarded',
      {
        p_actor_account_id: actor.accountId,
        p_actor_auth_user_id: actor.authUserId,
        p_hotel_id: inviteAnchorHotelId,
        p_target_account_id: accountIdValidation.value,
        p_email: normalizedEmail,
        p_role: role,
        p_organization_id: hat?.organizationId ?? null,
        p_membership_scope: hat?.scope ?? null,
        p_covered_property_ids: hat?.coveredPropertyIds ?? null,
        p_target_staff_id: targetStaffId,
        p_request_id: requestId,
      },
    );
    if (guardedGrantError) {
      log.error('[invites:POST] guarded existing-account grant failed', {
        requestId,
        code: guardedGrantError.code,
        msg: errToString(guardedGrantError),
      });
      if (guardedGrantError.code === '55P03' || guardedGrantError.code === '40001') {
        return capabilityUnavailableResponse(requestId);
      }
      return err('Failed to add hotel access', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    const guardedGrant = guardedGrantData !== null
        && typeof guardedGrantData === 'object'
        && !Array.isArray(guardedGrantData)
      ? guardedGrantData as Record<string, unknown>
      : null;
    if (!guardedGrant || guardedGrant.ok !== true) {
      if (guardedGrant?.reason === 'invalid') {
        return err('Invalid access grant', {
          requestId,
          status: 400,
          code: ApiErrorCode.ValidationFailed,
        });
      }
      if (guardedGrant?.reason === 'denied') return authorityDenied(requestId);
      if (guardedGrant?.reason === 'not_found') {
        return err('The account or staff profile is no longer available', {
          requestId,
          status: 404,
          code: ApiErrorCode.NotFound,
        });
      }
      if (guardedGrant?.reason === 'role_conflict') {
        return err('This account already has a different access role', {
          requestId,
          status: 409,
          code: ApiErrorCode.IdempotencyConflict,
        });
      }
      if (guardedGrant?.reason === 'staff_in_use') {
        return err('This staff profile is already linked to another account', {
          requestId,
          status: 409,
          code: ApiErrorCode.IdempotencyConflict,
        });
      }
      log.error('[invites:POST] guarded existing-account grant returned an unknown refusal', {
        requestId,
        reason: guardedGrant?.reason,
      });
      return err('Failed to add hotel access', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }

    const grantedAccountId = validateUuid(guardedGrant.accountId, 'accountId');
    const grantedHotelId = validateUuid(guardedGrant.hotelId, 'hotelId');
    const grantedMembershipId = guardedGrant.membershipId === null
      ? null
      : validateUuid(guardedGrant.membershipId, 'membershipId');
    const grantedStaffId = guardedGrant.staffId === null
      ? null
      : validateUuid(guardedGrant.staffId, 'staffId');
    const expectedNormalized = hat !== null;
    const malformedGrantReceipt = grantedAccountId.error
      || grantedAccountId.value !== accountIdValidation.value
      || grantedHotelId.error
      || grantedHotelId.value !== inviteAnchorHotelId
      || guardedGrant.role !== role
      || (guardedGrant.status !== 'granted' && guardedGrant.status !== 'noop')
      || guardedGrant.normalized !== expectedNormalized
      || (expectedNormalized
        ? grantedMembershipId === null || !!grantedMembershipId.error || !grantedMembershipId.value
        : grantedMembershipId !== null)
      || (grantedStaffId === null
        ? targetStaffId !== null
        : !!grantedStaffId.error || grantedStaffId.value !== targetStaffId);
    if (malformedGrantReceipt) {
      log.error('[invites:POST] guarded existing-account grant returned a malformed receipt', {
        requestId,
      });
      return err('Failed to add hotel access', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }

    // Same bridge as brand-new-login acceptance: an existing Staxis login that
    // is handed the job of running this hotel joins its staff list, so the
    // to-do Who list and the schedule can actually see them. The grant above is
    // already committed, so a roster failure is reported and left to the
    // backfill rather than failing an access change that really happened.
    await joinHotelStaffListForExistingAccount({
      accountId: accountIdValidation.value,
      propertyIds: targetStaffId === null
        ? managerRosterPropertyIds({
          role,
          membershipScope: hat?.scope ?? null,
          organizationId: hat?.organizationId ?? null,
          hotelId: inviteAnchorHotelId,
          coveredPropertyIds: hat?.coveredPropertyIds ?? null,
        })
        : [],
      actorAccountId: actor.accountId,
      requestId,
    });

    // `profileLinked` keeps its original meaning on purpose: it is the answer to
    // "did this invitation adopt the exact roster profile you picked", which the
    // dialog turns into a sentence naming that profile. The roster bridge above
    // picks nobody, so it has nothing to name.
    return ok({
      accessGranted: true,
      profileLinked: targetStaffId !== null,
      emailSent: false,
    }, { requestId });
  }

  const rawToken = randomBytes(24).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { data: guardedCreateData, error: guardedCreateError } = await supabaseAdmin.rpc(
    'staxis_create_account_invite_guarded',
    {
      p_actor_account_id: actor.accountId,
      p_actor_auth_user_id: actor.authUserId,
      p_hotel_id: inviteAnchorHotelId,
      p_email: normalizedEmail,
      p_role: role,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
      p_organization_id: hat?.organizationId ?? null,
      p_membership_scope: hat?.scope ?? null,
      p_covered_property_ids: hat?.coveredPropertyIds ?? null,
      p_request_id: requestId,
      p_target_staff_id: targetStaffId,
    },
  );
  if (guardedCreateError) {
    log.error('[invites:POST] guarded create failed', {
      requestId,
      code: guardedCreateError.code,
      msg: errToString(guardedCreateError),
    });
    if (guardedCreateError.code === '55P03' || guardedCreateError.code === '40001') {
      return capabilityUnavailableResponse(requestId);
    }
    return err('Failed to create invite', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const guardedCreate = guardedCreateData !== null
      && typeof guardedCreateData === 'object'
      && !Array.isArray(guardedCreateData)
    ? guardedCreateData as Record<string, unknown>
    : null;
  if (!guardedCreate || guardedCreate.ok !== true) {
    if (guardedCreate?.reason === 'invalid') {
      return err('Invalid invitation', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    if (guardedCreate?.reason === 'denied') return authorityDenied(requestId);
    if (guardedCreate?.reason === 'not_found') {
      return err('The selected staff profile is no longer available', {
        requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
      });
    }
    if (guardedCreate?.reason === 'role_conflict') {
      return err('The selected staff profile no longer matches this role', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
      });
    }
    if (guardedCreate?.reason === 'staff_in_use') {
      return err('This staff profile is already linked to another account', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
      });
    }
    log.error('[invites:POST] guarded create returned an unknown refusal', {
      requestId,
      reason: guardedCreate?.reason,
    });
    return err('Failed to create invite', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
  const inviteIdReceipt = validateUuid(guardedCreate.inviteId, 'inviteId');
  const hotelIdReceipt = validateUuid(guardedCreate.hotelId, 'hotelId');
  const inviteId = inviteIdReceipt.error ? null : inviteIdReceipt.value;
  const committedHotelId = hotelIdReceipt.error ? null : hotelIdReceipt.value;
  const hotelName = typeof guardedCreate.hotelName === 'string'
    && guardedCreate.hotelName.trim().length > 0
    ? guardedCreate.hotelName
    : null;
  const targetStaffIdReceipt = guardedCreate.targetStaffId === null
    ? null
    : validateUuid(guardedCreate.targetStaffId, 'targetStaffId');
  const committedTargetStaffId = targetStaffIdReceipt === null
    ? null
    : targetStaffIdReceipt.error ? null : targetStaffIdReceipt.value ?? null;
  if (!inviteId
      || committedHotelId !== inviteAnchorHotelId
      || !hotelName
      || committedTargetStaffId !== targetStaffId
      || (guardedCreate.targetStaffId !== null && targetStaffIdReceipt?.error)) {
    log.error('[invites:POST] guarded create returned a malformed receipt', { requestId });
    return err('Failed to create invite', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Account-invite acceptance remains /invite/[token]; only the delivery
  // transport changes. Use the canonical application origin rather than a
  // caller-controlled Host header so the emailed link cannot be poisoned.
  const inviteLink = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/invite/${rawToken}`;
  const destinationName = await inviteDestinationName(hat, hotelName);
  let emailResult: SendEmailResult;
  try {
    emailResult = await sendHotelAccountInvite({
      to: normalizedEmail,
      hotelName: destinationName,
      role: legacyRole,
      roleLabelOverride: hat ? HAT_ROLE_LABELS[hat.role].en : undefined,
      inviteUrl: inviteLink,
      expiresAt,
      auditContext: {
        actorUserId: actor.authUserId,
        actorEmail: actor.authEmail ?? undefined,
        targetType: 'invite',
        targetId: inviteId,
        hotelId: inviteAnchorHotelId,
      },
    });
  } catch (mailErr) {
    log.error('[invites:POST] email send failed', { requestId, msg: errToString(mailErr) });
    emailResult = { ok: false as const, error: 'email_delivery_failed' };
  }
  if (!emailResult.ok) {
    log.warn('[invites:POST] invitation created but email was not delivered', {
      requestId,
      inviteId,
    });
  }

  return ok(accountInviteDelivery(inviteLink, emailResult), { requestId, status: 201 });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const authentication = await authenticateInviteRoute(req, requestId);
  if (!authentication.ok) return authentication.response;
  const { actor } = authentication;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const idValidation = validateUuid(id, 'id');
  if (idValidation.error) {
    return err(idValidation.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const { data, error: revokeError } = await supabaseAdmin.rpc(
    'staxis_revoke_account_invite_guarded',
    {
      p_actor_account_id: actor.accountId,
      p_actor_auth_user_id: actor.authUserId,
      p_invite_id: id,
      p_request_id: requestId,
    },
  );
  if (revokeError) {
    log.error('[invites:DELETE] guarded revoke failed', {
      requestId,
      code: revokeError.code,
      msg: errToString(revokeError),
    });
    if (revokeError.code === '55P03' || revokeError.code === '40001') {
      return capabilityUnavailableResponse(requestId);
    }
    return err('Failed to revoke invite', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const result = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
  if (!result || result.ok !== true) {
    if (result?.reason === 'invalid') {
      return err('Invalid invitation', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    if (result?.reason === 'not_pending') {
      return err('Invite is no longer pending', {
        requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      });
    }
    // Existing-but-unauthorized and absent ids deliberately share one public
    // response so a direct-id probe cannot enumerate another tenant's invites.
    return err('Not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  const inviteIdReceipt = validateUuid(result.inviteId, 'inviteId');
  const hotelIdReceipt = validateUuid(result.hotelId, 'hotelId');
  if (inviteIdReceipt.error || inviteIdReceipt.value !== id
      || hotelIdReceipt.error || !hotelIdReceipt.value) {
    log.error('[invites:DELETE] guarded revoke returned a malformed receipt', { requestId });
    return err('Failed to revoke invite', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
  return ok({ success: true }, { requestId });
}
