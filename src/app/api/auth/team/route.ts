// /api/auth/team — manage team members for a specific hotel.
//
//   GET     ?hotelId=…
//     List accounts with access to the hotel. Visible to admin/owner/GM
//     who can manage that hotel.
//
//   PUT
//     Body: { hotelId, accountId, displayName?, role?, password?,
//             expectedRole?, expectedDisplayName?, expectedUpdatedAt? }
//     Update a team member. Caller must manage the hotel. Targets cannot
//     be admins (admin accounts are managed via /api/auth/accounts).
//     Role changes are limited to assignable roles (no promotion to admin).
//
//   DELETE  ?hotelId=…&accountId=…
//     Remove a team member's access to that hotel (detach — the account
//     itself stays alive, just loses canonical access for this hotel).
//     Targets cannot be admins. Caller cannot remove themselves.
//
// Admins still have access via /api/auth/accounts (full system view); this
// endpoint is what owners/GMs use to manage their own hotel's team.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  verifyTeamManager,
  callerCapabilityDecision,
  callerCapabilityDecisionFresh,
  callerControlsEveryTargetHotel,
  teamCallerRoleAtHotel,
  type TeamCaller,
} from '@/lib/team-auth';
import type { CapabilityDecision } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { isAssignableRole, isValidRole, type AppRole } from '@/lib/roles';
import { writeAudit } from '@/lib/audit';
import { validateUuid } from '@/lib/api-validate';
import {
  loadHatsForAccounts,
  resolveCompanyForProperty,
  type MembershipHat,
} from '@/lib/company/access';
import { HAT_ROLE_LABELS } from '@/lib/company/roles';
import {
  loadAuthoritativeHotelRoster,
  type AuthoritativeHotelRoster,
} from '@/lib/authorization/hotel-account-roster';
import {
  hotelStaffLinkProjectionSignature,
  projectHotelStaffLinks,
  type HotelStaffLinkProjection,
} from '@/lib/authorization/hotel-staff-link-projection';
import {
  readCompleteCompanyIdChunks,
  type CompanyProjectionPage,
} from '@/lib/company-access/projection-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizedHotelAccess(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((hotelId): hotelId is string => typeof hotelId === 'string' && hotelId.length > 0))];
}

/**
 * Name, role, and password live on the account row / auth user, so changing
 * any of them affects every hotel the target can enter. A hotel manager may
 * make those global changes only when they can manage_team at every one of
 * those hotels. Admin is the only safe actor for wildcard-access targets.
 */
async function controlsEveryTargetHotel(
  caller: TeamCaller,
  targetAccess: string[],
  capability: 'manage_team' | 'manage_users' = 'manage_team',
  fresh = false,
): Promise<CapabilityDecision> {
  return callerControlsEveryTargetHotel(caller, capability, targetAccess, { fresh });
}

/** Mirrors the PUT/DELETE target hierarchy without making the client infer it. */
function canActOnTarget(
  callerRole: AppRole,
  targetRole: AppRole,
  isSelf: boolean,
): boolean {
  if (targetRole === 'admin') return false;
  if (targetRole === 'owner' && callerRole !== 'admin' && callerRole !== 'owner') return false;
  if (targetRole === 'general_manager' && callerRole === 'general_manager' && !isSelf) return false;
  return true;
}

function isPendingLifecycleFenceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === '55000'
    || (typeof record.message === 'string'
      && record.message.toLowerCase().includes('account lifecycle change pending'));
}

async function pendingLifecycleIntentCheck(
  accountId: string,
  requestId: string,
  operation: 'update' | 'detach',
): Promise<'clear' | 'pending' | 'unavailable'> {
  const { data, error } = await supabaseAdmin
    .from('account_lifecycle_intents')
    .select('account_id')
    .eq('account_id', accountId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle();

  if (error) {
    log.error(`[team:${operation === 'update' ? 'PUT' : 'DELETE'}] lifecycle intent check failed`, {
      requestId,
      msg: errToString(error),
    });
    return 'unavailable';
  }
  return data ? 'pending' : 'clear';
}

function lifecycleUnavailableResponse(requestId: string) {
  return err('Account status changes are temporarily unavailable. Try again shortly.', {
    requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { 'Retry-After': '5' },
  });
}

function lifecyclePendingResponse(requestId: string) {
  return err('Finish the pending account status change before editing this team member.', {
    requestId,
    status: 409,
    code: ApiErrorCode.IdempotencyConflict,
  });
}

function roleChangeUnavailableResponse(requestId: string) {
  return err('Role changes are temporarily unavailable. Try again shortly.', {
    requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { 'Retry-After': '5' },
  });
}

function teamProtectionUnavailableResponse(requestId: string) {
  return err('Team permissions are temporarily unavailable. Try again shortly.', {
    requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { 'Retry-After': '5' },
  });
}

function isObservedTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function teamCallerAuthorityUnchanged(first: TeamCaller, current: TeamCaller): boolean {
  return first.accountId === current.accountId
    && first.authUserId === current.authUserId
    && first.role === current.role
    && first.isAdmin === current.isAdmin
    && first.authorityMode === current.authorityMode
    && first.authorityVersion === current.authorityVersion
    && first.effectiveAccessHash === current.effectiveAccessHash
    && sameStrings(first.propertyAccess, current.propertyAccess)
    && sameStrings(
      first.accessiblePropertyIds ?? [],
      current.accessiblePropertyIds ?? [],
    );
}

function rosterSignature(roster: AuthoritativeHotelRoster): string {
  return JSON.stringify([...roster.accounts]
    .sort((left, right) => left.accountId.localeCompare(right.accountId))
    .map((account) => ({
      accountId: account.accountId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      active: account.active,
      dataUserId: account.dataUserId,
      staffId: account.staffId,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      authorityMode: account.authorityMode,
      authorityVersion: account.authorityVersion,
      propertyIds: account.propertyIds,
      managementSurface: account.managementSurface,
    })));
}

interface ProjectedTeamHat {
  membershipId: string;
  scope: MembershipHat['scope'];
  role: MembershipHat['role'];
  propertyIds: string[];
}

function projectTeamHats(
  loaded: Map<string, MembershipHat[]>,
  organizationId: string,
  callerReach: Set<string> | null,
): Map<string, ProjectedTeamHat[]> {
  const projected = new Map<string, ProjectedTeamHat[]>();
  for (const [accountId, hats] of loaded) {
    const visible = hats.flatMap((hat): ProjectedTeamHat[] => {
      if (hat.organizationId !== organizationId) return [];
      const propertyIds = hat.coveredPropertyIds
        .filter((propertyId) => callerReach === null || callerReach.has(propertyId))
        .sort();
      return propertyIds.length > 0 ? [{
        membershipId: hat.membershipId,
        scope: hat.scope,
        role: hat.role,
        propertyIds,
      }] : [];
    }).sort((left, right) => left.membershipId.localeCompare(right.membershipId));
    if (visible.length > 0) projected.set(accountId, visible);
  }
  return projected;
}

function projectedHatsSignature(projected: Map<string, ProjectedTeamHat[]>): string {
  return JSON.stringify([...projected.entries()]
    .sort(([left], [right]) => left.localeCompare(right)));
}

async function exactTeamPropertyNames(propertyIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(propertyIds)].sort();
  if (ids.length === 0) return new Map();
  if (ids.length > 5_000) throw new Error('team property-name scope exceeded safety bound');
  const rows = await readCompleteCompanyIdChunks<{ id: string; name: string }>(
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
  if (rows.some((row) => typeof row.id !== 'string'
      || typeof row.name !== 'string'
      || row.name.trim().length === 0)) {
    throw new Error('team property-name projection was malformed');
  }
  const returnedIds = rows.map((row) => row.id).sort();
  if (!sameStrings(ids, returnedIds)) {
    throw new Error('team property-name projection was incomplete');
  }
  return new Map(rows.map((row) => [row.id, row.name]));
}

function topologyUnchanged(
  first: Awaited<ReturnType<typeof resolveCompanyForProperty>>,
  current: Awaited<ReturnType<typeof resolveCompanyForProperty>>,
): boolean {
  return first.status === current.status
    && (first.status !== 'company'
      || (current.status === 'company'
        && first.organizationId === current.organizationId));
}

/**
 * Read the selected property's staff-link history as identity data only.
 * Active links remain the authority-bearing `staffId`; inactive links are
 * retained solely so People can merge an archived staff row with its login.
 * Any malformed or conflicting row fails closed before it reaches the client.
 */
async function loadHotelStaffLinkProjection(
  hotelId: string,
  accountIds: ReadonlySet<string>,
): Promise<HotelStaffLinkProjection> {
  const { data, error } = await supabaseAdmin
    .from('account_property_staff_links')
    .select('account_id, staff_id, is_active')
    .eq('property_id', hotelId);
  if (error) throw new Error(`property staff-link query failed: ${errToString(error)}`);
  if (!Array.isArray(data)) throw new Error('property staff-link projection was malformed');

  const projection = projectHotelStaffLinks(
    data.map((row) => {
      const value = row as Record<string, unknown>;
      return {
        accountId: value.account_id,
        staffId: value.staff_id,
        isActive: value.is_active,
      };
    }),
    accountIds,
  );
  if (!projection) throw new Error('property staff-link projection was ambiguous');
  return projection;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdRaw = searchParams.get('hotelId');
  if (!hotelIdRaw) return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelIdCheck = validateUuid(hotelIdRaw, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  const callerReach = caller.isAdmin
    ? null
    : new Set(caller.accessiblePropertyIds ?? []);
  if (callerReach !== null && !callerReach.has(hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  let roster;
  try {
    roster = await loadAuthoritativeHotelRoster(hotelId, caller.isAdmin);
  } catch (rosterError) {
    log.error('[team:GET] authoritative roster unavailable', {
      requestId,
      msg: errToString(rosterError),
    });
    return teamProtectionUnavailableResponse(requestId);
  }
  const teamRows = roster.accounts.map((account) => ({
    id: account.accountId,
    username: account.username,
    display_name: account.displayName,
    role: account.role,
    active: account.active,
    propertyIds: account.propertyIds,
    created_at: account.createdAt,
    updated_at: account.updatedAt,
    data_user_id: account.dataUserId,
    staff_id: account.staffId,
    authority_mode: account.authorityMode,
    authority_version: account.authorityVersion,
    management_surface: account.managementSurface,
  }));

  // accounts.staff_id is a legacy account-wide field. The organization
  // foundation keeps an exact (account, hotel) identity map, which prevents a
  // staff link from Hotel A being presented as linked while viewing Hotel B.
  const teamAccountIds = new Set(teamRows.map((row) => row.id));
  const ownerProtectedAccountIds = new Set<string>();
  if (teamAccountIds.size > 0) {
    const { data: protectedAccountIds, error: protectionError } = await supabaseAdmin.rpc(
      'staxis_list_normalized_organization_owner_account_ids',
      { p_account_ids: [...teamAccountIds] },
    );
    if (protectionError || !Array.isArray(protectedAccountIds)) {
      log.error('[team:GET] organization-owner projection failed', {
        requestId,
        msg: protectionError ? errToString(protectionError) : 'invalid projection response',
      });
      return teamProtectionUnavailableResponse(requestId);
    }
    for (const accountId of protectedAccountIds) {
      if (typeof accountId === 'string' && teamAccountIds.has(accountId)) {
        ownerProtectedAccountIds.add(accountId);
      }
    }
  }
  const lifecycleByAccountId = new Map<string, boolean>();
  if (teamAccountIds.size > 0) {
    const { data: lifecycleRows, error: lifecycleError } = await supabaseAdmin
      .from('account_lifecycle_intents')
      .select('account_id, desired_active')
      .in('account_id', [...teamAccountIds])
      .eq('status', 'pending');
    if (lifecycleError) {
      log.error('[team:GET] lifecycle projection failed', {
        requestId, msg: errToString(lifecycleError),
      });
      return lifecycleUnavailableResponse(requestId);
    }
    for (const lifecycle of lifecycleRows ?? []) {
      lifecycleByAccountId.set(lifecycle.account_id, lifecycle.desired_active === true);
    }
  }
  let initialStaffLinkProjection: HotelStaffLinkProjection;
  try {
    initialStaffLinkProjection = await loadHotelStaffLinkProjection(hotelId, teamAccountIds);
  } catch (staffLinksError) {
    log.error('[team:GET] property staff-link query failed', {
      requestId,
      msg: errToString(staffLinksError),
    });
    return teamProtectionUnavailableResponse(requestId);
  }

  const emailByUserId = new Map<string, string>();
  const lastSignInByUserId = new Map<string, string | null>();
  const observedAuthUserIds = new Set<string>();
  const { data: authPage, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    log.error('[team:GET] auth listUsers failed', { requestId, msg: errToString(listErr) });
  } else {
    for (const u of authPage?.users ?? []) {
      if (!u.id) continue;
      observedAuthUserIds.add(u.id);
      if (u.email) emailByUserId.set(u.id, u.email);
      lastSignInByUserId.set(u.id, u.last_sign_in_at ?? null);
    }
  }

  const teamWithDecisions = await Promise.all(teamRows.map(async (r) => {
    const targetRole = r.role as AppRole;
    const isSelf = r.id === caller.accountId;
    const targetAccess = targetRole === 'admin' ? ['*'] : normalizedHotelAccess(r.propertyIds);
    const disclosedTargetAccess = callerReach === null
      ? targetAccess
      : targetAccess.filter((propertyId) => propertyId !== '*' && callerReach.has(propertyId));
    const normalizedTarget = r.authority_mode === 'normalized';
    const hasOtherHotelAccess = disclosedTargetAccess.includes('*')
      || disclosedTargetAccess.some((id) => id !== hotelId);
    const hotelAccessCount = disclosedTargetAccess.includes('*')
      ? null
      : disclosedTargetAccess.length;
    const callerHotelRole = teamCallerRoleAtHotel(caller, hotelId) ?? caller.role;
    const hierarchyAllowsMutation = canActOnTarget(callerHotelRole, targetRole, isSelf);
    const active = r.active;
    const lifecyclePending = lifecycleByAccountId.has(r.id);
    const lifecycleDesiredActive = lifecycleByAccountId.get(r.id) ?? null;
    const ownerProtected = ownerProtectedAccountIds.has(r.id);
    const staffId = initialStaffLinkProjection.activeStaffIds.get(r.id) ?? null;
    const historicalStaffId = initialStaffLinkProjection.historicalStaffIds.get(r.id) ?? null;
    const staffLinkAllowed = active
      && !lifecyclePending
      && historicalStaffId === null
      && targetRole !== 'admin'
      && r.management_surface === 'legacy_hotel'
      && targetAccess.length === 1
      && targetAccess[0] === hotelId;

    // Self name/password edits remain self-service even if the caller has a
    // per-hotel manage_team restriction elsewhere. Other-person account-wide
    // edits require control of every hotel represented by this account.
    const controlsAllHotelsDecision: CapabilityDecision = isSelf
      ? 'allowed'
      : await controlsEveryTargetHotel(caller, targetAccess);
    const managesUsersAtHotelDecision: CapabilityDecision = isSelf
      ? 'denied'
      : await callerCapabilityDecision(caller, 'manage_users', hotelId);
    const managesUsersEverywhereDecision: CapabilityDecision = isSelf
      ? 'denied'
      : await controlsEveryTargetHotel(caller, targetAccess, 'manage_users');
    const controlsAllHotels = controlsAllHotelsDecision === 'allowed';
    const managesUsersAtHotel = managesUsersAtHotelDecision === 'allowed';
    const managesUsersEverywhere = managesUsersEverywhereDecision === 'allowed';
    const canEditProfile = !lifecyclePending
      && hierarchyAllowsMutation && (isSelf || (!normalizedTarget && controlsAllHotels));
    const sensitiveTargetAllowed = hierarchyAllowsMutation && !isSelf
      && targetRole !== 'owner' && targetRole !== 'admin';
    const canChangeRole = !normalizedTarget && !lifecyclePending
      && !ownerProtected && sensitiveTargetAllowed && active && managesUsersEverywhere;
    // Direct manager-set passwords cross the Postgres account boundary into
    // Supabase Auth and cannot be made atomic with a concurrent promotion.
    // Team members use the standard emailed recovery flow; only the signed-in
    // person can change their own password here.
    const canResetPassword = !lifecyclePending && hierarchyAllowsMutation && isSelf;
    // Detach is intentionally hotel-scoped: a manager may remove Hotel A
    // access without controlling Hotel B. The atomic RPC preserves Hotel B.
    const canRemove = !normalizedTarget && !lifecyclePending
      && !ownerProtected && sensitiveTargetAllowed && managesUsersAtHotel;
    const canDeactivate = !lifecyclePending
      && !ownerProtected && sensitiveTargetAllowed && active && managesUsersEverywhere;
    const canReactivate = !lifecyclePending
      && !ownerProtected && sensitiveTargetAllowed && !active && managesUsersEverywhere;
    const actions = {
      canEditProfile,
      canChangeRole,
      canResetPassword,
      canRemove,
      canDeactivate,
      canReactivate,
    };

    return {
      controlsAllHotelsDecision,
      managesUsersAtHotelDecision,
      managesUsersEverywhereDecision,
      targetAccess,
      isSelf,
      row: {
        accountId: r.id,
        username: r.username,
        displayName: r.display_name,
        email: emailByUserId.get(r.data_user_id) ?? '',
        active,
        ownerProtected,
        lifecyclePending,
        lifecycleDesiredActive,
        lastSignInAt: lastSignInByUserId.get(r.data_user_id) ?? null,
        lastSignInKnown: observedAuthUserIds.has(r.data_user_id),
        role: targetRole,
        propertyAccess: disclosedTargetAccess,
        staffId,
        historicalStaffId,
        staffLinkAllowed,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        isSelf,
        isPlatformAdmin: targetRole === 'admin',
        hotelAccessCount,
        hasOtherHotelAccess,
        globalImpact: {
          displayNameAffectsAllHotels: true,
          roleAffectsAllHotels: true,
          passwordAffectsAllHotels: true,
          hotelAccessCount,
          hasOtherHotelAccess,
        },
        authorityMode: r.authority_mode,
        authorityVersion: r.authority_version,
        managementSurface: r.management_surface,
        accessManagementHref: normalizedTarget ? '/company?tab=access' : null,
        actions,
        // Flat aliases keep the contract convenient for existing/simple clients;
        // `actions` is the canonical grouped shape for the My Hotel UI.
        ...actions,
      },
    };
  }));

  if (teamWithDecisions.some(({
    controlsAllHotelsDecision,
    managesUsersAtHotelDecision,
    managesUsersEverywhereDecision,
  }) => controlsAllHotelsDecision === 'unavailable'
    || managesUsersAtHotelDecision === 'unavailable'
    || managesUsersEverywhereDecision === 'unavailable')) {
    return capabilityUnavailableResponse(requestId);
  }
  const team = teamWithDecisions.map(({ row }) => row);

  // COMPANY SPINE (0364). Project company jobs only through the caller's exact
  // current reach. A Hotel A manager may learn that a hat affects Hotel A, but
  // never receives sister-property ids, names, counts, or omission markers.
  let hatsByAccountId: Record<string, Array<{
    membershipId: string;
    scope: string;
    role: string;
    label: { en: string; es: string };
    propertyIds: string[];
    propertyNames: string[];
  }>> = {};
  const initialTopology = await resolveCompanyForProperty(hotelId);
  if (initialTopology.status === 'unavailable' || initialTopology.status === 'ambiguous') {
    return teamProtectionUnavailableResponse(requestId);
  }
  let initialProjectedHats = new Map<string, ProjectedTeamHat[]>();
  try {
    if (initialTopology.status === 'company') {
      const organizationId = initialTopology.organizationId;
      const loaded = await loadHatsForAccounts(team.map((row) => row.accountId as string));
      initialProjectedHats = projectTeamHats(loaded, organizationId, callerReach);
      const namedIds = [...new Set(
        [...initialProjectedHats.values()].flat().flatMap((hat) => hat.propertyIds),
      )];
      const names = await exactTeamPropertyNames(namedIds);
      hatsByAccountId = Object.fromEntries(
        [...initialProjectedHats.entries()].map(([accountId, hats]) => [
          accountId,
          hats.map((hat) => ({
              membershipId: hat.membershipId,
              scope: hat.scope,
              role: hat.role,
              label: HAT_ROLE_LABELS[hat.role],
              propertyIds: hat.propertyIds,
              propertyNames: hat.propertyIds.map((id) => names.get(id)!),
            })),
        ]),
      );
    }
  } catch (hatsErr) {
    log.error('[team:GET] exact company-job projection unavailable', {
      requestId, msg: errToString(hatsErr),
    });
    return teamProtectionUnavailableResponse(requestId);
  }

  // Re-resolve every load-bearing authority input immediately before egress.
  // This closes stale open tabs after revocation, hotel transfer, target scope
  // changes, or capability changes without trusting client-side invalidation.
  const finalCaller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!finalCaller || !teamCallerAuthorityUnchanged(caller, finalCaller)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  const finalManageTeam = await callerCapabilityDecisionFresh(
    finalCaller,
    'manage_team',
    hotelId,
  );
  if (finalManageTeam === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (finalManageTeam !== 'allowed') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const finalDecisions = await Promise.all(teamWithDecisions.map(async (initial) => ({
    controlsAllHotelsDecision: initial.isSelf
      ? 'allowed' as const
      : await controlsEveryTargetHotel(finalCaller, initial.targetAccess, 'manage_team', true),
    managesUsersAtHotelDecision: initial.isSelf
      ? 'denied' as const
      : await callerCapabilityDecisionFresh(finalCaller, 'manage_users', hotelId),
    managesUsersEverywhereDecision: initial.isSelf
      ? 'denied' as const
      : await controlsEveryTargetHotel(finalCaller, initial.targetAccess, 'manage_users', true),
  })));
  if (finalDecisions.some((decision) => decision.controlsAllHotelsDecision === 'unavailable'
      || decision.managesUsersAtHotelDecision === 'unavailable'
      || decision.managesUsersEverywhereDecision === 'unavailable')) {
    return capabilityUnavailableResponse(requestId);
  }
  if (finalDecisions.some((decision, index) => {
    const initial = teamWithDecisions[index]!;
    return decision.controlsAllHotelsDecision !== initial.controlsAllHotelsDecision
      || decision.managesUsersAtHotelDecision !== initial.managesUsersAtHotelDecision
      || decision.managesUsersEverywhereDecision !== initial.managesUsersEverywhereDecision;
  })) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  let finalRoster: AuthoritativeHotelRoster;
  try {
    finalRoster = await loadAuthoritativeHotelRoster(hotelId, finalCaller.isAdmin);
  } catch (rosterError) {
    log.error('[team:GET] final authoritative roster unavailable', {
      requestId, msg: errToString(rosterError),
    });
    return teamProtectionUnavailableResponse(requestId);
  }
  if (rosterSignature(roster) !== rosterSignature(finalRoster)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  let finalStaffLinkProjection: HotelStaffLinkProjection;
  try {
    finalStaffLinkProjection = await loadHotelStaffLinkProjection(hotelId, teamAccountIds);
  } catch (staffLinksError) {
    log.error('[team:GET] final property staff-link query failed', {
      requestId,
      msg: errToString(staffLinksError),
    });
    return teamProtectionUnavailableResponse(requestId);
  }
  if (hotelStaffLinkProjectionSignature(initialStaffLinkProjection)
      !== hotelStaffLinkProjectionSignature(finalStaffLinkProjection)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const finalTopology = await resolveCompanyForProperty(hotelId);
  if (finalTopology.status === 'unavailable' || finalTopology.status === 'ambiguous') {
    return teamProtectionUnavailableResponse(requestId);
  }
  if (!topologyUnchanged(initialTopology, finalTopology)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  if (finalTopology.status === 'company') {
    const finalLoaded = await loadHatsForAccounts(team.map((row) => row.accountId as string));
    const finalProjectedHats = projectTeamHats(
      finalLoaded,
      finalTopology.organizationId,
      callerReach,
    );
    if (projectedHatsSignature(initialProjectedHats)
        !== projectedHatsSignature(finalProjectedHats)) {
      return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
    }
  }

  return ok({ team, hatsByAccountId }, { requestId });
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as {
    hotelId?: string;
    accountId?: string;
    displayName?: string;
    role?: string;
    password?: string;
    expectedRole?: string;
    expectedDisplayName?: string;
    expectedUpdatedAt?: string;
    // staffId: links accounts.staff_id to the staff roster row this login
    // represents. `null` unlinks. `undefined` (omitted) leaves it alone.
    staffId?: string | null;
  };
  const { displayName, role, password } = body;

  // Passwords live in Supabase Auth while names, roles, and staff links live
  // in Postgres. A combined request cannot be atomic across those stores: the
  // password could succeed and the profile update fail (or vice versa). Force
  // callers to use two truthful operations so each response describes exactly
  // one committed mutation and the UI can report a partial outcome honestly.
  const includesPassword = Object.prototype.hasOwnProperty.call(body, 'password');
  const includesProfileMutation = Object.prototype.hasOwnProperty.call(body, 'displayName')
    || Object.prototype.hasOwnProperty.call(body, 'role')
    || Object.prototype.hasOwnProperty.call(body, 'staffId');
  const requestsRoleMutation = Object.prototype.hasOwnProperty.call(body, 'role');
  if (includesPassword && includesProfileMutation) {
    return err('Password changes must be saved separately from profile, role, or staff-link changes', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;

  const accountIdCheck = validateUuid(body.accountId, 'accountId');
  if (accountIdCheck.error) return err(accountIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const accountId = accountIdCheck.value!;

  if (requestsRoleMutation) {
    if (!isValidRole(body.expectedRole)
      || typeof body.expectedDisplayName !== 'string'
      || !isObservedTimestamp(body.expectedUpdatedAt)) {
      return err('Role changes require the account version shown when the editor was opened. Refresh and try again.', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
  }

  const capabilityDecision = await callerCapabilityDecision(
    caller,
    requestsRoleMutation ? 'manage_users' : 'manage_team',
    hotelId,
  );
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  const callerHotelRole = teamCallerRoleAtHotel(caller, hotelId) ?? caller.role;

  let authoritativeTarget;
  try {
    const roster = await loadAuthoritativeHotelRoster(hotelId, caller.isAdmin);
    authoritativeTarget = roster.accounts.find((account) => account.accountId === accountId);
  } catch (rosterError) {
    log.error('[team:PUT] authoritative roster unavailable', {
      requestId,
      msg: errToString(rosterError),
    });
    return teamProtectionUnavailableResponse(requestId);
  }
  if (!authoritativeTarget) {
    return err('Account does not have current access to this hotel', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  const isSelf = accountId === caller.accountId;
  if (authoritativeTarget.managementSurface === 'company_access'
      && (requestsRoleMutation
        || body.staffId !== undefined
        || (!isSelf && Object.prototype.hasOwnProperty.call(body, 'displayName')))) {
    return err('Manage this person’s normalized role and hotel scope from My Hotel > Access.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
      details: { href: '/company?tab=access' },
    });
  }

  // Load target.
  const { data: target, error: tErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, active, data_user_id, display_name, staff_id, updated_at, lifecycle_intent_version')
    .eq('id', accountId)
    .maybeSingle();
  if (tErr || !target) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Guardrails:
  // - never let a non-admin manager touch an admin row.
  // - target must actually have access to this hotel (otherwise this isn't
  //   "the manager's team member" — could be cross-hotel snooping).
  if (target.role === 'admin') {
    return err('Cannot modify admin accounts from this view', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }
  const targetAccess = authoritativeTarget.propertyIds;

  // accounts.staff_id remains a legacy account-wide pointer. Until all staff
  // workflows write the per-property link table directly, changing it for a
  // multi-hotel account would silently disconnect that person at another
  // hotel. Fail closed instead of corrupting the other hotel's identity link.
  if (body.staffId !== undefined && (targetAccess.includes('*') || targetAccess.length !== 1)) {
    return err('Staff links for people who work at multiple hotels must be changed by Staxis support', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }

  // Privilege-escalation matrix (mirrors the shared denyRoleChange policy).
  // Applies to EVERY mutation here — password reset, role change, staff link.
  // Without it a General Manager could reset the OWNER's password (account
  // takeover) since owner is not an admin. A manager may only act on accounts
  // at or below their own tier.
  if (target.role === 'owner' && callerHotelRole !== 'admin' && callerHotelRole !== 'owner') {
    return err('Only an admin or another owner can modify an owner account', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }
  if (target.role === 'general_manager' && callerHotelRole === 'general_manager' && !isSelf) {
    return err('Only an owner or admin can modify another General Manager', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }

  if (password && !isSelf) {
    return err('For security, team members must reset their own password from Forgot password', {
      requestId,
      status: 403,
      code: ApiErrorCode.Unauthorized,
    });
  }

  // Build the intended mutation. Role changes must stay in the assignable set (no
  // self-promotion to admin via this route).
  const nextDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
  const changesDisplayName = !!nextDisplayName && nextDisplayName !== target.display_name;
  let nextRole: AppRole | undefined;
  if (requestsRoleMutation) {
    if (!isAssignableRole(role)) {
      return err('Invalid role (admin not allowed here)', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    // Ownership is changed only by the dedicated, atomic transfer flow. An
    // ordinary role edit must never create another owner or demote the current
    // one without transferring their responsibility.
    if (role === 'owner') {
      return err('Use Transfer Ownership to make someone an owner', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    if (target.role === 'owner') {
      return err('Use Transfer Ownership to change an owner account', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    if (target.active === false) {
      return err('Reactivate this account before changing its role', {
        requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      });
    }
    if (role === 'general_manager' && callerHotelRole !== 'admin' && callerHotelRole !== 'owner') {
      return err('Only an owner or admin can promote someone to General Manager', {
        requestId, status: 403, code: ApiErrorCode.Unauthorized,
      });
    }
    // Block self-demotion through this path — owners shouldn't accidentally
    // strip their own management privileges. Admin route can still do it.
    if (accountId === caller.accountId) {
      return err('Cannot change your own role here', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    nextRole = role;
  }

  // Account name and role are GLOBAL fields, just like the auth password.
  // Requiring manage_team at only the selected hotel let a Hotel A manager
  // rename or rerole someone who also worked at Hotel B. Enforce the complete
  // hotel set before any other-person global mutation. Self name/password edits
  // deliberately remain available; self role changes are already blocked.
  if (!isSelf && (changesDisplayName || nextRole || !!password)) {
    const controlsAllHotelsDecision = await controlsEveryTargetHotel(
      caller,
      targetAccess,
      nextRole ? 'manage_users' : 'manage_team',
    );
    if (controlsAllHotelsDecision === 'unavailable') {
      return capabilityUnavailableResponse(requestId);
    }
    if (controlsAllHotelsDecision === 'denied') {
      const mutation = nextRole
        ? 'change this person\'s role'
        : changesDisplayName
          ? 'change this person\'s name'
          : 'reset this person\'s password';
      return err(
        `This person also works at a hotel where you do not have permission for this change. Only an admin or a manager authorized at every hotel they can access can ${mutation}.`,
        { requestId, status: 403, code: ApiErrorCode.Unauthorized },
      );
    }
  }

  if (nextRole) {
    if (body.staffId !== undefined) {
      return err('Role changes must be saved separately from staff-link changes', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    if (typeof target.lifecycle_intent_version !== 'number') {
      return roleChangeUnavailableResponse(requestId);
    }
    const { data: roleResult, error: roleError } = await supabaseAdmin.rpc(
      'staxis_change_hotel_team_role_guarded',
      {
        p_actor_account_id: caller.accountId,
        p_actor_auth_user_id: caller.authUserId,
        p_actor_email: caller.authEmail ?? null,
        p_hotel_id: hotelId,
        p_target_account_id: accountId,
        p_new_role: nextRole,
        p_new_display_name: changesDisplayName ? nextDisplayName : null,
        p_expected_active: target.active !== false,
        p_expected_role: body.expectedRole,
        p_expected_auth_user_id: target.data_user_id,
        p_expected_property_access: targetAccess,
        p_expected_display_name: body.expectedDisplayName,
        p_expected_updated_at: body.expectedUpdatedAt,
        p_expected_intent_version: target.lifecycle_intent_version,
        p_request_id: requestId,
      },
    );
    if (roleError) {
      log.error('[team:PUT] guarded role update failed', {
        requestId, msg: errToString(roleError),
      });
      if (isPendingLifecycleFenceError(roleError)) {
        return lifecyclePendingResponse(requestId);
      }
      return roleChangeUnavailableResponse(requestId);
    }
    const guardedRole = roleResult && typeof roleResult === 'object'
      ? roleResult as { status?: string; reason?: string }
      : null;
    if (guardedRole?.status === 'ok' || guardedRole?.status === 'noop') {
      return ok({ success: true }, { requestId });
    }
    if (guardedRole?.status === 'pending_conflict') {
      return lifecyclePendingResponse(requestId);
    }
    if (guardedRole?.status === 'retry') {
      return roleChangeUnavailableResponse(requestId);
    }
    if (guardedRole?.status === 'conflict') {
      return err('This account changed while you were editing it. Refresh and try again.', {
        requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      });
    }
    if (guardedRole?.status === 'not_found') {
      return err('Account not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    if (guardedRole?.status === 'forbidden') {
      if (guardedRole.reason === 'organization_owner') {
        return err('Organization-owner access is protected. Transfer ownership before changing this hotel role.', {
          requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
        });
      }
      return err('You are no longer authorized to change this role', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }
    if (guardedRole?.status === 'invalid') {
      return err('Invalid role change', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    return roleChangeUnavailableResponse(requestId);
  }

  // ── staffId link/unlink ─────────────────────────────────────────────────
  // The /staff page's My Shifts view scopes to accounts.staff_id. Manager
  // sets this from a person's card in My Hotel → People. We allow null
  // (unlink) or any staff.id that belongs to this hotel. The legacy
  // accounts.staff_id pointer has no per-hotel FK; the guarded RPC below also
  // maintains the composite-FK normalized link and validates uniqueness in the
  // same transaction as the account/link/audit writes. Direct-ID probes and
  // revoke/transfer races therefore fail closed.
  const changesStaffLink = body.staffId !== undefined;
  let nextStaffId: string | null = null;
  if (body.staffId !== undefined) {
    if (body.staffId !== null) {
      const staffIdCheck = validateUuid(body.staffId, 'staffId');
      if (staffIdCheck.error) return err(staffIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      nextStaffId = staffIdCheck.value!;
    }
  }

  // Lifecycle changes span Supabase Auth and Postgres. While one is pending,
  // freeze identity, role, hotel access, and profile edits so the already-
  // authorized operation cannot later act on a newly promoted or relinked
  // account. Migration 0335 also fences the database update to close the race
  // between this friendly pre-check and the write below.
  if (changesDisplayName || changesStaffLink || !!password) {
    const pendingState = await pendingLifecycleIntentCheck(accountId, requestId, 'update');
    if (pendingState === 'unavailable') return lifecycleUnavailableResponse(requestId);
    if (pendingState === 'pending') return lifecyclePendingResponse(requestId);
  }

  // Password reset: requires Supabase 6-char minimum.
  if (password) {
    if (password.length < 6) {
      return err('Password must be at least 6 characters', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(target.data_user_id, { password });
    if (pwErr) {
      log.error('[team:PUT] password update failed', { requestId, msg: errToString(pwErr) });
      return err(pwErr.message || 'Failed to update password', {
        requestId, status: 500, code: ApiErrorCode.InternalError,
      });
    }
  }

  if (changesDisplayName || changesStaffLink) {
    const { data: profileResult, error: profileError } = await supabaseAdmin.rpc(
      'staxis_update_hotel_team_profile_guarded',
      {
        p_actor_account_id: caller.accountId,
        p_actor_auth_user_id: caller.authUserId,
        p_actor_email: caller.authEmail ?? null,
        p_hotel_id: hotelId,
        p_target_account_id: accountId,
        p_change_display_name: changesDisplayName,
        p_new_display_name: changesDisplayName ? nextDisplayName : null,
        p_change_staff_link: changesStaffLink,
        p_new_staff_id: nextStaffId,
        p_expected_active: target.active !== false,
        p_expected_role: target.role,
        p_expected_auth_user_id: target.data_user_id,
        p_expected_property_access: targetAccess,
        p_expected_target_property_ids: targetAccess,
        p_expected_display_name: target.display_name,
        p_expected_staff_id: (target as { staff_id?: string | null }).staff_id ?? null,
        p_expected_updated_at: target.updated_at,
        p_expected_intent_version: target.lifecycle_intent_version,
        p_request_id: requestId,
      },
    );
    if (profileError) {
      log.error('[team:PUT] guarded profile update failed', {
        requestId, msg: errToString(profileError),
      });
      if (isPendingLifecycleFenceError(profileError)) {
        return lifecyclePendingResponse(requestId);
      }
      return teamProtectionUnavailableResponse(requestId);
    }
    const guardedProfile = profileResult && typeof profileResult === 'object'
      ? profileResult as { status?: string; reason?: string; audit_written?: boolean }
      : null;
    if (guardedProfile?.status === 'ok' && guardedProfile.audit_written === true) {
      return ok({ success: true }, { requestId });
    }
    if (guardedProfile?.status === 'noop') {
      return ok({ success: true }, { requestId });
    }
    if (guardedProfile?.status === 'pending_conflict') {
      return lifecyclePendingResponse(requestId);
    }
    if (guardedProfile?.status === 'retry') {
      return teamProtectionUnavailableResponse(requestId);
    }
    if (guardedProfile?.status === 'conflict') {
      return err('This account changed while you were editing it. Refresh and try again.', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
      });
    }
    if (guardedProfile?.status === 'not_found') {
      return err('Account or staff link is unavailable', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    if (guardedProfile?.status === 'forbidden') {
      return err('You are no longer authorized to update this team member', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }
    if (guardedProfile?.status === 'invalid') {
      return err('Invalid profile or staff-link change', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    return teamProtectionUnavailableResponse(requestId);
  }

  // Password changes live outside Postgres and are intentionally isolated from
  // profile/staff mutations above. Their audit therefore remains a separate
  // best-effort route operation.
  await writeAudit({
    action: 'account.team_update',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail,
    targetType: 'account',
    targetId: accountId,
    hotelId,
    metadata: {
      display_name_changed: false,
      role_changed: nextRole ?? null,
      password_reset: !!password,
      staff_link_changed: false,
    },
  });

  return ok({ success: true }, { requestId });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_users' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;

  const accountIdCheck = validateUuid(searchParams.get('accountId'), 'accountId');
  if (accountIdCheck.error) return err(accountIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const accountId = accountIdCheck.value!;

  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_users', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  const callerHotelRole = teamCallerRoleAtHotel(caller, hotelId) ?? caller.role;
  if (accountId === caller.accountId) {
    return err('Cannot remove yourself from a hotel', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  let targetAuthorityVersion: number | null = null;
  try {
    const roster = await loadAuthoritativeHotelRoster(hotelId, caller.isAdmin);
    const authoritativeTarget = roster.accounts.find((account) => account.accountId === accountId);
    if (!authoritativeTarget) {
      return err('Account does not have current access to this hotel', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    if (authoritativeTarget.managementSurface === 'company_access') {
      return err('Manage this person’s normalized role and hotel scope from My Hotel > Access.', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
        details: { href: '/company?tab=access' },
      });
    }
    targetAuthorityVersion = authoritativeTarget.authorityVersion;
  } catch (rosterError) {
    log.error('[team:DELETE] authoritative roster unavailable', {
      requestId,
      msg: errToString(rosterError),
    });
    return teamProtectionUnavailableResponse(requestId);
  }

  // Role guard — admins can only be modified through the admin route.
  // Cheap pre-check before invoking the atomic RPC.
  const { data: target, error: tErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, updated_at')
    .eq('id', accountId)
    .maybeSingle();
  if (tErr || !target) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (target.role === 'admin') {
    return err('Cannot remove admin accounts from this view', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }
  // Same owner/GM privilege matrix as PUT — a GM must not be able to detach an
  // owner (or another GM) from a hotel. (Audit review fix 2026-06-18.)
  if (target.role === 'owner') {
    return err('Transfer ownership before removing an owner from a hotel', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
    });
  }
  if (target.role === 'general_manager' && caller.role === 'general_manager') {
    return err('Only an owner or admin can remove another General Manager', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }

  const { data: ownerProtectedIds, error: ownerProtectionError } = await supabaseAdmin.rpc(
    'staxis_list_normalized_organization_owner_account_ids',
    { p_account_ids: [accountId] },
  );
  if (ownerProtectionError || !Array.isArray(ownerProtectedIds)) {
    log.error('[team:DELETE] organization-owner projection failed', {
      requestId,
      msg: ownerProtectionError ? errToString(ownerProtectionError) : 'invalid projection response',
    });
    return teamProtectionUnavailableResponse(requestId);
  }
  if (ownerProtectedIds.includes(accountId)) {
    return err('Organization-owner access is protected. Transfer ownership before removing hotel access.', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
    });
  }

  const pendingState = await pendingLifecycleIntentCheck(accountId, requestId, 'detach');
  if (pendingState === 'unavailable') return lifecycleUnavailableResponse(requestId);
  if (pendingState === 'pending') return lifecyclePendingResponse(requestId);

  // Concurrency audit #1: use the atomic RPC instead of read-filter-update.
  // Two concurrent removals on the same account from different hotels could
  // each compute a stale `next` array and clobber each other, silently re-
  // granting a hotel one of them had just removed.
  const { data: removalResult, error: rpcErr } = await supabaseAdmin.rpc(
    'staxis_remove_property_access_authoritative',
    {
      p_actor_account_id: caller.accountId,
      p_actor_auth_user_id: caller.authUserId,
      p_actor_email: caller.authEmail ?? null,
      p_account_id: accountId,
      p_hotel_id: hotelId,
      p_expected_role: target.role,
      p_expected_authority_version: targetAuthorityVersion,
      p_expected_updated_at: target.updated_at,
      p_request_id: requestId,
    },
  );
  if (rpcErr) {
    log.error('[team:DELETE] guarded property removal failed', { requestId, msg: errToString(rpcErr) });
    if (isPendingLifecycleFenceError(rpcErr)) {
      return lifecyclePendingResponse(requestId);
    }
    return err('Failed to remove access', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const guardedResult = removalResult && typeof removalResult === 'object'
    ? removalResult as {
      status?: string;
      reason?: string;
      remaining_hotels?: number;
      audit_written?: boolean;
    }
    : null;
  if (guardedResult?.status === 'not_found') {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (guardedResult?.status === 'not_attached') {
    return err('Account does not have access to this hotel', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
    });
  }
  if (guardedResult?.status === 'conflict') {
    return err('This account changed while you were removing access. Refresh and try again.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }
  if (guardedResult?.status === 'pending_conflict') {
    return lifecyclePendingResponse(requestId);
  }
  if (guardedResult?.status === 'retry') {
    return teamProtectionUnavailableResponse(requestId);
  }
  if (guardedResult?.status === 'forbidden' && guardedResult.reason === 'organization_owner') {
    return err('Organization-owner access is protected. Transfer ownership before removing hotel access.', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
    });
  }
  if (guardedResult?.status !== 'ok'
      || typeof guardedResult.remaining_hotels !== 'number'
      || guardedResult.audit_written !== true) {
    log.error('[team:DELETE] guarded property removal returned an invalid result', { requestId });
    return err('Failed to remove access', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }

  return ok({ success: true }, { requestId });
}
