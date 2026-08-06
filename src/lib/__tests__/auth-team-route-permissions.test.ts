/**
 * Direct contract tests for /api/auth/team.
 *
 * These exercise the real route boundary (session + trusted-device check,
 * manager-floor capability, selected-hotel scope, hierarchy, mutation, and API
 * envelope) over an in-memory Supabase stub. The load-bearing scenario is a
 * Hotel A manager looking at an employee who also works at Hotel B: Hotel A
 * access may be detached, but account-wide name/role/password changes must be
 * refused unless the caller manages both hotels.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { DELETE, GET, PUT } from '@/app/api/auth/team/route';
import {
  AUTHORITATIVE_HOTEL_ROSTER_SCHEMA_VERSION,
  parseAuthoritativeHotelRoster,
} from '@/lib/authorization/hotel-account-roster';
import { supabaseAdmin } from '@/lib/supabase-admin';

const HOTEL_A = '11111111-1111-1111-1111-111111111111';
const HOTEL_B = '22222222-2222-2222-2222-222222222222';
const HOTEL_C = '33333333-3333-3333-3333-333333333333';
const CALLER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MULTI_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LOCAL_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OWNER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const PEER_GM_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const CALLER_USER_ID = '10000000-0000-0000-0000-000000000001';
const ORGANIZATION_ID = '66666666-6666-4666-8666-666666666666';
const RELATIONSHIP_A = '44444444-4444-4444-8444-444444444441';
const RELATIONSHIP_B = '44444444-4444-4444-8444-444444444442';

type TestRole = 'admin' | 'owner' | 'general_manager' | 'front_desk' | 'housekeeping' | 'maintenance' | 'staff';

interface AccountFixture {
  id: string;
  username: string;
  display_name: string;
  role: TestRole;
  property_access: string[];
  created_at: string;
  data_user_id: string;
  staff_id: string | null;
  active: boolean;
  updated_at: string;
  lifecycle_intent_version: number;
  skip_2fa: boolean;
  authority_mode: 'legacy' | 'shadow' | 'normalized';
  authority_version: number;
}

interface TestState {
  accounts: AccountFixture[];
  canonicalPropertyAccess: Map<string, string[]>;
  accountUpdates: Array<{ accountId: string; values: Record<string, unknown> }>;
  passwordUpdates: Array<{ userId: string; password: string }>;
  authBanUpdates: Array<{ userId: string; banDuration: string }>;
  authBannedUntil: Map<string, string | null>;
  authLookupError: { message: string } | null;
  authUpdateResults: Array<{ message: string } | null>;
  authUpdateHooks: Array<(() => void) | null>;
  authListError: { message: string } | null;
  authListOmittedUserIds: Set<string>;
  auditRows: Array<Record<string, unknown>>;
  roleChangeRows: Array<Record<string, unknown>>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  capabilityOverrides: Array<{ property_id: string; capability: string; role: string; allowed: boolean }>;
  capabilityOverrideError: { message: string } | null;
  staffLinks: Array<{ account_id: string; property_id: string; staff_id: string; is_active: boolean }>;
  staffRows: Array<{ id: string; property_id: string; is_active: boolean }>;
  pendingLifecycleAccountIds: Set<string>;
  lifecycleIntentQueryError: { message: string } | null;
  ownerProtectedAccountIds: Set<string>;
  ownerProtectionError: { message: string } | null;
  roleRpcError: { message: string } | null;
  profileRpcError: { message: string; code?: string } | null;
  profileAuditError: { message: string } | null;
  beforeProfileCommit: (() => void) | null;
  accountUpdateConflicts: Set<string>;
  accountUpdateErrors: Map<string, { message: string; code?: string }>;
  accountVersion: number;
  revokeCallerOnConflict: boolean;
  denyManageUsersOnConflict: boolean;
  removalConflicts: Set<string>;
  removalErrors: Map<string, { message: string; code?: string }>;
  removalRpcResults: Map<string, Record<string, unknown>>;
  callerAuthorityReads: number;
  beforeFinalCallerAuthorityRead: (() => void) | null;
  organizationId: string | null;
  effectiveStandingEntitlements: Map<string, Array<Record<string, unknown>>>;
  /**
   * Accounts the roster RPC projects back onto the hotel surface. 0424's
   * `_staxis_stage_b_is_independent_single_hotel_scope` does this for a
   * normalized account whose only claim is one hotel with no management
   * company, which is every person at an independent hotel after the Stage C
   * cutover. They are normalized AND `legacy_hotel` at the same time.
   */
  independentHotelAccountIds: Set<string>;
  suppressLegacyAccessProjection: Set<string>;
  authorizationStateOmittedAccountIds: Set<string>;
  unavailableAccessAccountIds: Set<string>;
  onboardingState: unknown;
  onboardingCompletedAt: string | null;
  membershipHats: Array<{
    id: string;
    organization_id: string;
    account_id: string;
    membership_scope: 'company' | 'property';
    staxis_role: 'owner' | 'vp' | 'finance' | 'general_manager' | 'front_desk' | 'housekeeping' | 'maintenance';
    job_title: string | null;
    covered_property_ids: string[] | null;
    status: 'active' | 'revoked' | 'suspended';
    starts_at: string | null;
    ended_at: string | null;
  }>;
  structuralGrants: Array<{
    organization_id: string;
    membership_id: string;
    scope_type: 'property' | 'organization' | 'portfolio';
    property_id: string | null;
    property_relationship_id: string | null;
    source: string;
    status: 'active' | 'revoked';
    starts_at: string;
    expires_at: string | null;
  }>;
  structuralBridges: Array<{
    account_id: string;
    property_id: string;
    cutover_organization_id: string | null;
    cutover_relationship_id: string | null;
    status: 'active' | 'revoked';
  }>;
}

let state: TestState;

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
type GetUserFn = typeof supabaseAdmin.auth.getUser;
type ListUsersFn = typeof supabaseAdmin.auth.admin.listUsers;
type GetUserByIdFn = typeof supabaseAdmin.auth.admin.getUserById;
type UpdateUserFn = typeof supabaseAdmin.auth.admin.updateUserById;

const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalListUsers: ListUsersFn = supabaseAdmin.auth.admin.listUsers.bind(supabaseAdmin.auth.admin);
const originalGetUserById: GetUserByIdFn = supabaseAdmin.auth.admin.getUserById.bind(supabaseAdmin.auth.admin);
const originalUpdateUser: UpdateUserFn = supabaseAdmin.auth.admin.updateUserById.bind(supabaseAdmin.auth.admin);

function fixture(
  id: string,
  role: TestRole,
  propertyAccess: string[],
  displayName: string,
  dataUserId = `90000000-0000-0000-0000-${id.replaceAll('-', '').slice(0, 12)}`,
): AccountFixture {
  return {
    id,
    username: displayName.toLowerCase().replaceAll(' ', '.'),
    display_name: displayName,
    role,
    property_access: propertyAccess,
    created_at: '2026-07-01T12:00:00.000Z',
    data_user_id: dataUserId,
    staff_id: null,
    active: true,
    updated_at: '2026-07-01T12:00:00.000Z',
    lifecycle_intent_version: 0,
    skip_2fa: false,
    authority_mode: 'legacy',
    authority_version: 1,
  };
}

function resetState(): void {
  const accounts = [
    fixture(CALLER_ID, 'general_manager', [HOTEL_A], 'Alex Manager', CALLER_USER_ID),
    fixture(MULTI_ID, 'housekeeping', [HOTEL_A, HOTEL_B], 'Morgan Multi'),
    fixture(LOCAL_ID, 'housekeeping', [HOTEL_A], 'Leslie Local'),
    fixture(OWNER_ID, 'owner', [HOTEL_A], 'Olivia Owner'),
    fixture(PEER_GM_ID, 'general_manager', [HOTEL_A], 'Gina Manager'),
  ];
  state = {
    accounts,
    canonicalPropertyAccess: new Map(
      accounts.map((accountRow) => [accountRow.id, [...accountRow.property_access]]),
    ),
    accountUpdates: [],
    passwordUpdates: [],
    authBanUpdates: [],
    authBannedUntil: new Map(),
    authLookupError: null,
    authUpdateResults: [],
    authUpdateHooks: [],
    authListError: null,
    authListOmittedUserIds: new Set(),
    auditRows: [],
    roleChangeRows: [],
    rpcCalls: [],
    capabilityOverrides: [],
    capabilityOverrideError: null,
    staffLinks: [],
    staffRows: [],
    pendingLifecycleAccountIds: new Set(),
    lifecycleIntentQueryError: null,
    ownerProtectedAccountIds: new Set(),
    ownerProtectionError: null,
    roleRpcError: null,
    profileRpcError: null,
    profileAuditError: null,
    beforeProfileCommit: null,
    accountUpdateConflicts: new Set(),
    accountUpdateErrors: new Map(),
    accountVersion: 0,
    revokeCallerOnConflict: false,
    denyManageUsersOnConflict: false,
    removalConflicts: new Set(),
    removalErrors: new Map(),
    removalRpcResults: new Map(),
    callerAuthorityReads: 0,
    beforeFinalCallerAuthorityRead: null,
    organizationId: null,
    effectiveStandingEntitlements: new Map(),
    independentHotelAccountIds: new Set(),
    suppressLegacyAccessProjection: new Set(),
    authorizationStateOmittedAccountIds: new Set(),
    unavailableAccessAccountIds: new Set(),
    onboardingState: null,
    onboardingCompletedAt: null,
    membershipHats: [],
    structuralGrants: [],
    structuralBridges: [],
  };
}

function authoritativeAccess(accountRow: AccountFixture): Record<string, unknown> {
  if (accountRow.role === 'admin') {
    return {
      ok: true,
      all: true,
      authorityMode: accountRow.authority_mode,
      authorityVersion: accountRow.authority_version,
      effectiveAccessHash: 'a'.repeat(64),
      propertyIds: [],
      legacyPropertyIds: [],
      membershipPropertyIds: [],
      propertyStandings: [],
    };
  }
  const propertyIds = [...new Set(
    state.canonicalPropertyAccess.get(accountRow.id) ?? accountRow.property_access,
  )].sort();
  const projectedPropertyIds = accountRow.authority_mode !== 'normalized'
    && state.suppressLegacyAccessProjection.has(accountRow.id)
    ? []
    : propertyIds;
  const normalized = accountRow.authority_mode === 'normalized';
  return {
    ok: true,
    all: false,
    authorityMode: accountRow.authority_mode,
    authorityVersion: accountRow.authority_version,
    effectiveAccessHash: 'a'.repeat(64),
    propertyIds: projectedPropertyIds,
    legacyPropertyIds: normalized ? [] : projectedPropertyIds,
    membershipPropertyIds: normalized ? projectedPropertyIds : [],
    propertyStandings: projectedPropertyIds.map((propertyId) => ({
      propertyId,
      operationalRole: accountRow.role,
      seesFinancials: accountRow.role === 'owner' || accountRow.role === 'general_manager',
      hotelMutationAllowed: true,
      portfolioIntelligenceRead: normalized,
      entitlements: state.effectiveStandingEntitlements.get(accountRow.id) ?? [normalized ? {
        kind: 'access_grant',
        entitlementId: accountRow.id,
        organizationId: null,
        membershipId: accountRow.id,
        accessProfile: accountRow.role === 'owner' ? 'organization_owner'
          : accountRow.role === 'general_manager' ? 'property_manager' : 'viewer',
        staxisRole: null,
        scopeType: 'property',
        portfolioId: null,
      } : {
        kind: 'legacy',
        entitlementId: accountRow.id,
        organizationId: null,
        membershipId: null,
        accessProfile: null,
        staxisRole: null,
        scopeType: 'property',
        portfolioId: null,
      }],
    })),
  };
}

function authoritativeRoster(
  propertyId: string,
  includePlatformAdmins: boolean,
): Record<string, unknown> {
  const accounts = state.accounts
    .filter((accountRow) => (
      (accountRow.role === 'admin' && accountRow.active && includePlatformAdmins)
      || (accountRow.role !== 'admin'
        && (state.canonicalPropertyAccess.get(accountRow.id) ?? accountRow.property_access)
          .includes(propertyId))
    ))
    .map((accountRow) => ({
      accountId: accountRow.id,
      username: accountRow.username,
      displayName: accountRow.display_name,
      role: accountRow.role,
      active: accountRow.active,
      dataUserId: accountRow.data_user_id,
      staffId: accountRow.staff_id,
      createdAt: accountRow.created_at,
      updatedAt: accountRow.updated_at,
      authorityMode: accountRow.authority_mode,
      authorityVersion: accountRow.authority_version,
      propertyIds: accountRow.role === 'admin'
        ? []
        : [...new Set(
          state.canonicalPropertyAccess.get(accountRow.id) ?? accountRow.property_access,
        )].sort(),
      managementSurface: accountRow.authority_mode === 'normalized'
        && !state.independentHotelAccountIds.has(accountRow.id)
        ? 'company_access'
        : 'legacy_hotel',
    }));
  return {
    ok: true,
    schemaVersion: 'authoritative-hotel-roster-v1',
    propertyId,
    generatedAt: '2026-07-27T12:00:00.000Z',
    accounts,
  };
}

function installSupabaseStub(): void {
  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: CALLER_USER_ID, email: 'alex@hotel-a.test' } },
    error: null,
  })) as unknown as GetUserFn;

  supabaseAdmin.auth.admin.listUsers = (async () => ({
    data: {
      users: state.accounts
        .filter((account) => !state.authListOmittedUserIds.has(account.data_user_id))
        .map((account) => ({
          id: account.data_user_id,
          email: `${account.username}@example.test`,
          last_sign_in_at: '2026-07-20T10:30:00.000Z',
        })),
      aud: 'authenticated',
      nextPage: null,
      lastPage: 1,
      total: state.accounts.length,
    },
    error: state.authListError,
  })) as unknown as ListUsersFn;

  supabaseAdmin.auth.admin.getUserById = (async (userId: string) => {
    if (state.authLookupError) {
      return { data: { user: null }, error: state.authLookupError };
    }
    const accountRow = state.accounts.find((row) => row.data_user_id === userId);
    return {
      data: {
        user: accountRow ? {
          id: userId,
          email: `${accountRow.username}@example.test`,
          banned_until: state.authBannedUntil.get(userId) ?? undefined,
        } : null,
      },
      error: null,
    };
  }) as unknown as GetUserByIdFn;

  supabaseAdmin.auth.admin.updateUserById = (async (
    userId: string,
    attrs: { password?: string; ban_duration?: string },
  ) => {
    if (attrs.password) state.passwordUpdates.push({ userId, password: attrs.password });
    if (attrs.ban_duration) {
      state.authBanUpdates.push({ userId, banDuration: attrs.ban_duration });
      const nextResult = state.authUpdateResults.shift();
      if (nextResult) return { data: { user: null }, error: nextResult };
      state.authBannedUntil.set(
        userId,
        attrs.ban_duration === 'none' ? null : '2126-07-01T12:00:00.000Z',
      );
      state.authUpdateHooks.shift()?.();
    }
    return { data: { user: null }, error: null };
  }) as unknown as UpdateUserFn;

  supabaseAdmin.rpc = (async (fn: string, args?: Record<string, unknown>) => {
    const safeArgs = args ?? {};
    state.rpcCalls.push({ fn, args: safeArgs });
    if (fn === 'staxis_resolve_organization_property_topology') {
      const effectiveAt = safeArgs.p_effective_at;
      if (safeArgs.p_organization_id !== state.organizationId
          || typeof effectiveAt !== 'string') {
        return { data: { ok: false, reason: 'invalid_input' }, error: null };
      }
      return {
        data: {
          ok: true,
          schemaVersion: 'organization-property-topology-v1',
          organizationId: state.organizationId,
          effectiveAt,
          propertyIds: [HOTEL_A, HOTEL_B],
        },
        error: null,
      };
    }
    if (fn === 'staxis_list_account_authorized_properties') {
      if (typeof safeArgs.p_account_id === 'string'
          && state.unavailableAccessAccountIds.has(safeArgs.p_account_id)) {
        return { data: null, error: { message: 'simulated standing projection outage' } };
      }
      const accountRow = state.accounts.find((row) => row.id === safeArgs.p_account_id);
      if (safeArgs.p_account_id === CALLER_ID) {
        state.callerAuthorityReads += 1;
        if (state.callerAuthorityReads === 2) {
          const hook = state.beforeFinalCallerAuthorityRead;
          state.beforeFinalCallerAuthorityRead = null;
          hook?.();
        }
      }
      return {
        data: accountRow?.active ? authoritativeAccess(accountRow) : {
          ok: false, reason: 'no_active_account',
        },
        error: null,
      };
    }
    if (fn === 'staxis_list_authoritative_hotel_accounts') {
      return {
        data: authoritativeRoster(
          String(safeArgs.p_property_id),
          safeArgs.p_include_platform_admins === true,
        ),
        error: null,
      };
    }
    if (fn === 'staxis_list_normalized_organization_owner_account_ids') {
      return {
        data: state.ownerProtectionError ? null : [...state.ownerProtectedAccountIds],
        error: state.ownerProtectionError,
      };
    }
    if (fn === 'staxis_change_hotel_team_role_guarded') {
      if (state.roleRpcError) return { data: null, error: state.roleRpcError };
      const actor = state.accounts.find((row) => row.id === safeArgs.p_actor_account_id);
      const target = state.accounts.find((row) => row.id === safeArgs.p_target_account_id);
      if (!actor || !target) return { data: { status: 'not_found' }, error: null };
      if (state.pendingLifecycleAccountIds.has(actor.id)
          || state.pendingLifecycleAccountIds.has(target.id)) {
        return { data: { status: 'pending_conflict' }, error: null };
      }
      if (state.ownerProtectedAccountIds.has(target.id)) {
        return { data: { status: 'forbidden', reason: 'organization_owner' }, error: null };
      }
      const expectedAccess = safeArgs.p_expected_property_access;
      const snapshotMatches = target.active === safeArgs.p_expected_active
        && target.role === safeArgs.p_expected_role
        && target.data_user_id === safeArgs.p_expected_auth_user_id
        && JSON.stringify(target.property_access) === JSON.stringify(expectedAccess)
        && target.display_name === safeArgs.p_expected_display_name
        && target.updated_at === safeArgs.p_expected_updated_at
        && target.lifecycle_intent_version === safeArgs.p_expected_intent_version;
      if (!snapshotMatches) return { data: { status: 'conflict' }, error: null };

      const nextRole = safeArgs.p_new_role;
      if (typeof nextRole !== 'string') return { data: { status: 'invalid' }, error: null };
      const previousRole = target.role;
      target.role = nextRole as TestRole;
      if (typeof safeArgs.p_new_display_name === 'string') {
        target.display_name = safeArgs.p_new_display_name;
      }
      target.updated_at = nextAccountVersion();
      for (const propertyId of target.property_access) {
        state.roleChangeRows.push({
          account_id: target.id,
          property_id: propertyId,
          old_role: previousRole,
          new_role: target.role,
          change_kind: 'role_change',
        });
      }
      state.auditRows.push({
        action: 'account.team_update',
        target_id: target.id,
        hotel_id: safeArgs.p_hotel_id,
      });
      return { data: { status: 'ok' }, error: null };
    }
    if (fn === 'staxis_update_hotel_team_profile_guarded') {
      const hook = state.beforeProfileCommit;
      state.beforeProfileCommit = null;
      hook?.();
      if (state.profileRpcError) return { data: null, error: state.profileRpcError };

      const actor = state.accounts.find((row) => row.id === safeArgs.p_actor_account_id);
      const target = state.accounts.find((row) => row.id === safeArgs.p_target_account_id);
      if (!actor || !target) return { data: { status: 'not_found' }, error: null };
      if (!actor.active || actor.data_user_id !== safeArgs.p_actor_auth_user_id) {
        return { data: { status: 'forbidden', reason: 'actor' }, error: null };
      }
      if (state.pendingLifecycleAccountIds.has(actor.id)
          || state.pendingLifecycleAccountIds.has(target.id)) {
        return { data: { status: 'pending_conflict' }, error: null };
      }
      const configuredError = state.accountUpdateErrors.get(target.id);
      if (configuredError) return { data: null, error: configuredError };
      if (state.accountUpdateConflicts.has(target.id)) {
        target.updated_at = nextAccountVersion();
        return { data: { status: 'conflict' }, error: null };
      }

      const expectedTargetPropertyIds = Array.isArray(safeArgs.p_expected_target_property_ids)
        ? safeArgs.p_expected_target_property_ids
        : [];
      const targetPropertyIds = [...new Set(target.property_access)].sort();
      const snapshotMatches = target.active === safeArgs.p_expected_active
        && target.role === safeArgs.p_expected_role
        && target.data_user_id === safeArgs.p_expected_auth_user_id
        && JSON.stringify(target.property_access) === JSON.stringify(safeArgs.p_expected_property_access)
        && JSON.stringify(targetPropertyIds) === JSON.stringify(expectedTargetPropertyIds)
        && target.display_name === safeArgs.p_expected_display_name
        && target.staff_id === safeArgs.p_expected_staff_id
        && target.updated_at === safeArgs.p_expected_updated_at
        && target.lifecycle_intent_version === safeArgs.p_expected_intent_version;
      if (!snapshotMatches) return { data: { status: 'conflict' }, error: null };
      if (!targetPropertyIds.includes(String(safeArgs.p_hotel_id))) {
        return { data: { status: 'not_found' }, error: null };
      }
      const changeDisplay = safeArgs.p_change_display_name === true;
      const changeStaff = safeArgs.p_change_staff_link === true;
      if (target.authority_mode === 'normalized'
          && (changeStaff || actor.id !== target.id)) {
        return { data: { status: 'forbidden', reason: 'normalized_authority' }, error: null };
      }
      if (changeStaff && (target.authority_mode === 'normalized' || targetPropertyIds.length !== 1)) {
        return { data: { status: 'forbidden', reason: 'staff_scope' }, error: null };
      }

      const requiredProperties = changeDisplay && actor.id !== target.id
        ? targetPropertyIds
        : [String(safeArgs.p_hotel_id)];
      for (const propertyId of requiredProperties) {
        const roleCanManage = actor.role === 'admin'
          || ((actor.role === 'owner' || actor.role === 'general_manager')
            && actor.property_access.includes(propertyId));
        const denied = state.capabilityOverrides.some((override) => (
          override.property_id === propertyId
          && override.capability === 'manage_team'
          && override.role === actor.role
          && override.allowed === false
        ));
        if (!roleCanManage || denied) {
          return { data: { status: 'forbidden', reason: 'manage_team' }, error: null };
        }
        if (actor.id !== target.id
            && (target.role === 'owner' || target.role === 'general_manager')
            && actor.role !== 'admin' && actor.role !== 'owner') {
          return { data: { status: 'forbidden', reason: 'hierarchy' }, error: null };
        }
      }

      const newStaffId = safeArgs.p_new_staff_id;
      if (changeStaff && newStaffId !== null) {
        const staff = state.staffRows.find((row) => row.id === newStaffId
          && row.property_id === safeArgs.p_hotel_id && row.is_active);
        if (!staff) return { data: { status: 'not_found' }, error: null };
        const staffInUse = state.accounts.some((row) => row.id !== target.id
          && row.staff_id === newStaffId)
          || state.staffLinks.some((row) => row.account_id !== target.id
            && row.staff_id === newStaffId && row.is_active);
        if (staffInUse) {
          return { data: { status: 'conflict', reason: 'staff_in_use' }, error: null };
        }
      }

      const priorTarget = { ...target, property_access: [...target.property_access] };
      const priorLinks = state.staffLinks.map((row) => ({ ...row }));
      const priorAuditLength = state.auditRows.length;
      const nextDisplay = changeDisplay ? String(safeArgs.p_new_display_name) : target.display_name;
      const displayChanged = nextDisplay !== target.display_name;
      const staffChanged = changeStaff && target.staff_id !== newStaffId;
      const currentLink = state.staffLinks.find((row) => row.account_id === target.id
        && row.property_id === safeArgs.p_hotel_id);
      const linkChanged = changeStaff && (newStaffId !== null
        ? !currentLink || !currentLink.is_active || currentLink.staff_id !== newStaffId
        : !!currentLink?.is_active);
      if (!displayChanged && !staffChanged && !linkChanged) {
        return { data: { status: 'noop' }, error: null };
      }

      target.display_name = nextDisplay;
      if (changeStaff) target.staff_id = newStaffId as string | null;
      target.updated_at = nextAccountVersion();
      if (changeStaff) {
        if (newStaffId === null) {
          if (currentLink) currentLink.is_active = false;
        } else if (currentLink) {
          currentLink.staff_id = String(newStaffId);
          currentLink.is_active = true;
        } else {
          state.staffLinks.push({
            account_id: target.id,
            property_id: String(safeArgs.p_hotel_id),
            staff_id: String(newStaffId),
            is_active: true,
          });
        }
      }
      state.auditRows.push({
        action: 'account.team_update',
        target_id: target.id,
        hotel_id: safeArgs.p_hotel_id,
        request_id: safeArgs.p_request_id,
      });
      if (state.profileAuditError) {
        Object.assign(target, priorTarget);
        state.staffLinks.splice(0, state.staffLinks.length, ...priorLinks);
        state.auditRows.splice(priorAuditLength);
        return { data: null, error: state.profileAuditError };
      }
      return {
        data: {
          status: 'ok',
          audit_written: true,
          display_name_changed: displayChanged,
          staff_link_changed: staffChanged || linkChanged,
        },
        error: null,
      };
    }
    if (fn === 'staxis_remove_property_access_authoritative') {
      const target = state.accounts.find((account) => account.id === safeArgs.p_account_id);
      if (!target) return { data: { status: 'not_found' }, error: null };
      const configuredError = state.removalErrors.get(target.id);
      if (configuredError) return { data: null, error: configuredError };
      const configuredResult = state.removalRpcResults.get(target.id);
      if (configuredResult) return { data: configuredResult, error: null };
      if (state.removalConflicts.has(target.id)) {
        return { data: { status: 'conflict' }, error: null };
      }
      const canonical = state.canonicalPropertyAccess.get(target.id) ?? [];
      if (target.role !== safeArgs.p_expected_role
          || target.authority_version !== safeArgs.p_expected_authority_version
          || target.updated_at !== safeArgs.p_expected_updated_at
          || !canonical.includes(String(safeArgs.p_hotel_id))) {
        return { data: { status: 'conflict' }, error: null };
      }
      state.canonicalPropertyAccess.set(
        target.id,
        canonical.filter((hotelId) => hotelId !== safeArgs.p_hotel_id),
      );
      target.authority_version += 1;
      state.auditRows.push({
        action: 'account.team_detach',
        target_id: target.id,
        hotel_id: safeArgs.p_hotel_id,
        request_id: safeArgs.p_request_id,
      });
      return {
        data: {
          status: 'ok',
          remaining_hotels: (state.canonicalPropertyAccess.get(target.id) ?? []).length,
          audit_written: true,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  }) as unknown as RpcFn;

  supabaseAdmin.from = ((table: string) => {
    if (table === 'accounts') return accountBuilder();

    if (table === 'account_authorization_state') {
      let accountIds: string[] | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: (column: string, values: unknown[]) => {
          if (column === 'account_id') {
            accountIds = values.filter((value): value is string => typeof value === 'string');
          }
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.accounts
            .filter((accountRow) => (
              (accountIds === null || accountIds.includes(accountRow.id))
              && !state.authorizationStateOmittedAccountIds.has(accountRow.id)
            ))
            .map((accountRow) => ({
              account_id: accountRow.id,
              authority_mode: accountRow.authority_mode,
            })),
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'account_property_staff_links') {
      const equals = new Map<string, unknown>();
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          equals.set(column, value);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.staffLinks.filter((row) => [...equals].every(
            ([column, value]) => (row as unknown as Record<string, unknown>)[column] === value,
          )),
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'trusted_devices') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: {
            id: 'trusted-device',
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            absolute_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          },
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'app_settings') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: { two_factor_enabled: true }, error: null }),
      };
      return builder;
    }

    if (table === 'capability_overrides') {
      let propertyId: string | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          if (column === 'property_id') propertyId = value as string;
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.capabilityOverrideError
            ? null
            : state.capabilityOverrides.filter((row) => row.property_id === propertyId),
          error: state.capabilityOverrideError,
        }),
      };
      return builder;
    }

    if (table === 'account_lifecycle_intents') {
      let accountId: string | null = null;
      let accountIds: string[] | null = null;
      let status: string | null = null;
      const rows = () => {
        const candidates = accountIds ?? (accountId ? [accountId] : []);
        return status === 'pending'
          ? candidates
            .filter((candidate) => state.pendingLifecycleAccountIds.has(candidate))
            .map((candidate) => ({ account_id: candidate, desired_active: false }))
          : [];
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: (column: string, values: unknown[]) => {
          if (column === 'account_id') {
            accountIds = values.filter((value): value is string => typeof value === 'string');
          }
          return builder;
        },
        eq: (column: string, value: unknown) => {
          if (column === 'account_id') accountId = value as string;
          if (column === 'status') status = value as string;
          return builder;
        },
        limit: () => builder,
        maybeSingle: async () => ({
          data: !state.lifecycleIntentQueryError ? rows()[0] ?? null : null,
          error: state.lifecycleIntentQueryError,
        }),
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.lifecycleIntentQueryError ? null : rows(),
          error: state.lifecycleIntentQueryError,
        }),
      };
      return builder;
    }

    if (table === 'organization_property_relationships') {
      const equals = new Map<string, unknown>();
      let organizationIds: unknown[] | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          equals.set(column, value);
          return builder;
        },
        in: (_column: string, values: unknown[]) => {
          organizationIds = values;
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          const rows = state.organizationId ? [HOTEL_A, HOTEL_B]
            .map((propertyId) => ({
              id: propertyId === HOTEL_A ? RELATIONSHIP_A : RELATIONSHIP_B,
              organization_id: state.organizationId!,
              property_id: propertyId,
              relationship_type: 'operator',
              is_primary_grouping: true,
              starts_at: '2026-01-01T00:00:00.000Z',
              ends_at: null,
            }))
            .filter((row) => (equals.get('property_id') === undefined
              || equals.get('property_id') === row.property_id)
              && (equals.get('organization_id') === undefined
                || equals.get('organization_id') === row.organization_id)
              && (organizationIds === null || organizationIds.includes(row.organization_id)))
            : [];
          return resolve({ data: rows, error: null });
        },
      };
      return builder;
    }

    if (table === 'organizations') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.organizationId ? [{
            id: state.organizationId,
            status: 'active',
            organization_type: 'management_company',
          }] : [],
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'organization_memberships') {
      const equals = new Map<string, unknown>();
      let accountIds: string[] | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          equals.set(column, value);
          return builder;
        },
        is: (column: string, value: unknown) => {
          equals.set(column, value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          if (column === 'account_id') {
            accountIds = values.filter((value): value is string => typeof value === 'string');
          }
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.membershipHats.filter((hat) => (
            (accountIds === null || accountIds.includes(hat.account_id))
            && [...equals].every(([column, value]) => (
              (hat as unknown as Record<string, unknown>)[column] === value
            ))
          )),
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'account_property_authorization_bridges') {
      const accountIds: string[] = [];
      const equals = new Map<string, unknown>();
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: (column: string, values: unknown[]) => {
          if (column === 'account_id') {
            accountIds.push(...values.filter((value): value is string => typeof value === 'string'));
          }
          return builder;
        },
        eq: (column: string, value: unknown) => {
          equals.set(column, value);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.structuralBridges.filter((row) => (
            (accountIds.length === 0 || accountIds.includes(row.account_id))
            && [...equals].every(([column, value]) => (
              (row as unknown as Record<string, unknown>)[column] === value
            ))
          )),
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'organization_access_grants') {
      let membershipIds: string[] | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: (column: string, values: unknown[]) => {
          if (column === 'membership_id') {
            membershipIds = values.filter((value): value is string => typeof value === 'string');
          }
          return builder;
        },
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.structuralGrants.filter((row) => (
            membershipIds === null || membershipIds.includes(row.membership_id)
          )),
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'properties') {
      let propertyIds: unknown[] = [];
      let selectedPropertyId: string | null = null;
      let from = 0;
      let to = Number.MAX_SAFE_INTEGER;
      const names = new Map([[HOTEL_A, 'Hotel A'], [HOTEL_B, 'Hotel B'], [HOTEL_C, 'Hotel C']]);
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          if (column === 'id' && typeof value === 'string') selectedPropertyId = value;
          return builder;
        },
        in: (_column: string, values: unknown[]) => {
          propertyIds = values;
          return builder;
        },
        order: () => builder,
        range: (nextFrom: number, nextTo: number) => {
          from = nextFrom;
          to = nextTo;
          return builder;
        },
        maybeSingle: async () => ({
          data: selectedPropertyId
            ? {
              id: selectedPropertyId,
              onboarding_state: state.onboardingState,
              onboarding_completed_at: state.onboardingCompletedAt,
            }
            : null,
          error: null,
        }),
        then: (resolve: (value: unknown) => unknown) => {
          const all = propertyIds.flatMap((id) => {
            const name = typeof id === 'string' ? names.get(id) : null;
            return name ? [{ id, name }] : [];
          });
          return resolve({ data: all.slice(from, to + 1), error: null, count: all.length });
        },
      };
      return builder;
    }

    if (table === 'admin_audit_log') {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.auditRows.push(row);
          return { error: null };
        },
      };
    }

    if (table === 'role_changes') {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.roleChangeRows.push(row);
          return { error: null };
        },
      };
    }

    if (table === 'staff') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return builder;
    }

    throw new Error(`Unexpected table in auth-team route test: ${table}`);
  }) as unknown as FromFn;
}

function accountBuilder(): Record<string, unknown> {
  const equals = new Map<string, unknown>();
  const notEquals = new Map<string, unknown>();
  const inValues = new Map<string, Set<unknown>>();
  let updateValues: Record<string, unknown> | null = null;

  const matching = () => state.accounts.filter((account) => {
    for (const [column, value] of equals) {
      if ((account as unknown as Record<string, unknown>)[column] !== value) return false;
    }
    for (const [column, value] of notEquals) {
      if ((account as unknown as Record<string, unknown>)[column] === value) return false;
    }
    for (const [column, values] of inValues) {
      if (!values.has((account as unknown as Record<string, unknown>)[column])) return false;
    }
    return true;
  });

  const result = () => {
    if (updateValues) {
      const accountId = equals.get('id');
      if (typeof accountId === 'string') {
        const configuredError = state.accountUpdateErrors.get(accountId);
        if (configuredError) return { data: [], error: configuredError };
      }
      if (typeof accountId === 'string' && state.accountUpdateConflicts.has(accountId)) {
        state.accountUpdateConflicts.delete(accountId);
        const target = state.accounts.find((account) => account.id === accountId);
        if (target) target.updated_at = nextAccountVersion();
        if (state.revokeCallerOnConflict) account(CALLER_ID).active = false;
        if (state.denyManageUsersOnConflict) {
          state.capabilityOverrides.push({
            property_id: HOTEL_A,
            capability: 'manage_users',
            role: account(CALLER_ID).role,
            allowed: false,
          });
        }
      }
    }
    const rows = matching();
    if (updateValues) {
      for (const account of rows) {
        Object.assign(account, updateValues);
        account.updated_at = nextAccountVersion();
        state.accountUpdates.push({ accountId: account.id, values: { ...updateValues } });
      }
    }
    return { data: rows, error: null };
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      equals.set(column, value);
      return builder;
    },
    neq: (column: string, value: unknown) => {
      notEquals.set(column, value);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      inValues.set(column, new Set(values));
      return builder;
    },
    order: () => builder,
    update: (values: Record<string, unknown>) => {
      updateValues = values;
      return builder;
    },
    maybeSingle: async () => {
      const { data, error } = result();
      const row = data[0];
      return {
        data: row ? { ...row, property_access: [...row.property_access] } : null,
        error,
      };
    },
    then: (resolve: (value: unknown) => unknown) => resolve(result()),
  };
  return builder;
}

function request(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: Record<string, unknown>): NextRequest {
  return new NextRequest(`https://staxis.test${path}`, {
    method,
    headers: {
      authorization: 'Bearer route-contract-token',
      cookie: `staxis_device=${'a'.repeat(64)}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function account(accountId: string): AccountFixture {
  const found = state.accounts.find((row) => row.id === accountId);
  assert.ok(found, `missing fixture ${accountId}`);
  return found;
}

function setAccess(accountId: string, propertyIds: string[]): void {
  const target = account(accountId);
  target.property_access = [...propertyIds];
  state.canonicalPropertyAccess.set(accountId, [...propertyIds]);
}

function expectedRoleSnapshot(accountId: string): Record<string, unknown> {
  const target = account(accountId);
  return {
    expectedRole: target.role,
    expectedDisplayName: target.display_name,
    expectedUpdatedAt: target.updated_at,
  };
}

function nextAccountVersion(): string {
  state.accountVersion += 1;
  return new Date(Date.parse('2026-07-01T12:00:00.000Z') + state.accountVersion * 1000).toISOString();
}

beforeEach(() => {
  resetState();
  installSupabaseStub();
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.auth.admin.listUsers = originalListUsers;
  supabaseAdmin.auth.admin.getUserById = originalGetUserById;
  supabaseAdmin.auth.admin.updateUserById = originalUpdateUser;
});

describe('authoritative hotel roster response contract', () => {
  const normalizedAccount = {
    accountId: LOCAL_ID,
    username: 'local',
    displayName: 'Local User',
    role: 'front_desk',
    active: false,
    dataUserId: '90000000-0000-4000-8000-000000000001',
    staffId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    authorityMode: 'normalized',
    authorityVersion: 4,
    propertyIds: [HOTEL_A],
    managementSurface: 'company_access',
  };
  const projection = {
    ok: true,
    schemaVersion: AUTHORITATIVE_HOTEL_ROSTER_SCHEMA_VERSION,
    propertyId: HOTEL_A,
    generatedAt: '2026-07-27T12:00:00.000Z',
    accounts: [normalizedAccount],
  };

  test('retains inactive normalized people at their exact resumable hotel scope', () => {
    const parsed = parseAuthoritativeHotelRoster(projection);
    assert.equal(parsed?.accounts[0]?.active, false);
    assert.deepEqual(parsed?.accounts[0]?.propertyIds, [HOTEL_A]);
    assert.equal(parsed?.accounts[0]?.managementSurface, 'company_access');
  });

  test('accepts the independent hotel shape production actually returns', () => {
    // Verified against production after the Stage C cutover: every account at
    // a hotel with no management company comes back normalized, at authority
    // version 2, and still managed on the hotel surface. Rejecting this shape
    // made loadAuthoritativeHotelRoster throw "malformed" for the paying
    // customer's Users page and for every other independent hotel.
    const independent = {
      ...normalizedAccount,
      active: true,
      authorityMode: 'normalized',
      authorityVersion: 2,
      managementSurface: 'legacy_hotel',
    };
    const parsed = parseAuthoritativeHotelRoster({
      ...projection,
      accounts: [independent],
    });
    assert.equal(parsed?.accounts.length, 1);
    assert.equal(parsed?.accounts[0]?.authorityMode, 'normalized');
    assert.equal(parsed?.accounts[0]?.authorityVersion, 2);
    assert.equal(parsed?.accounts[0]?.managementSurface, 'legacy_hotel');
    assert.deepEqual(parsed?.accounts[0]?.propertyIds, [HOTEL_A]);
  });

  test('rejects the impossible surface, duplicate hotels, and rows outside the selected hotel', () => {
    // The roster RPC's CASE falls through to legacy_hotel for anything that is
    // not normalized, so a non-normalized account on company_access can only
    // mean the response drifted from its contract.
    for (const authorityMode of ['legacy', 'shadow']) {
      assert.equal(parseAuthoritativeHotelRoster({
        ...projection,
        accounts: [{ ...normalizedAccount, authorityMode, managementSurface: 'company_access' }],
      }), null);
    }
    assert.equal(parseAuthoritativeHotelRoster({
      ...projection,
      accounts: [{ ...normalizedAccount, propertyIds: [HOTEL_A, HOTEL_A] }],
    }), null);
    assert.equal(parseAuthoritativeHotelRoster({
      ...projection,
      accounts: [{ ...normalizedAccount, propertyIds: [HOTEL_B] }],
    }), null);
  });
});

describe('GET /api/auth/team action contract', () => {
  test('returns the existing onboarding marker so People can show pending and created states', async () => {
    account(CALLER_ID).role = 'admin';
    state.onboardingState = { invitedEmail: 'Pending.Owner@Example.com' };

    const pendingResponse = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(pendingResponse.status, 200);
    const pendingBody = await pendingResponse.json();
    assert.deepEqual(pendingBody.data.firstPersonOnboarding, {
      status: 'pending',
      invitedEmail: 'pending.owner@example.com',
      accountId: null,
    });

    state.onboardingState = {
      invitedEmail: 'Pending.Owner@Example.com',
      accountCreatedAt: '2026-08-03T00:00:00.000Z',
    };
    const createdResponse = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(createdResponse.status, 200);
    const createdBody = await createdResponse.json();
    assert.deepEqual(createdBody.data.firstPersonOnboarding, {
      status: 'created',
      invitedEmail: 'pending.owner@example.com',
      accountId: null,
    });
  });

  test('projects active normalized hotel directness without changing managementSurface', async () => {
    account(CALLER_ID).role = 'admin';
    account(LOCAL_ID).authority_mode = 'normalized';
    state.organizationId = ORGANIZATION_ID;
    state.membershipHats.push({
      id: '77777777-7777-4777-8777-777777777701',
      organization_id: ORGANIZATION_ID,
      account_id: LOCAL_ID,
      membership_scope: 'property',
      staxis_role: 'front_desk',
      job_title: null,
      covered_property_ids: [HOTEL_A],
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    });

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.managementSurface, 'company_access');
    assert.equal(local.directHotelAccount, true);
  });

  test('ORs canonical property grants and valid bridges when company access wins the standing', async () => {
    account(CALLER_ID).role = 'admin';
    account(LOCAL_ID).authority_mode = 'normalized';
    account(OWNER_ID).authority_mode = 'normalized';
    account(PEER_GM_ID).authority_mode = 'legacy';
    state.organizationId = ORGANIZATION_ID;
    const companyMembershipId = '77777777-7777-4777-8777-777777777711';
    const bridgeMembershipId = '77777777-7777-4777-8777-777777777712';
    const companyStanding = (membershipId: string) => [{
      kind: 'membership_hat',
      entitlementId: membershipId,
      organizationId: ORGANIZATION_ID,
      membershipId,
      accessProfile: null,
      staxisRole: 'vp',
      scopeType: 'company',
      portfolioId: null,
    }];
    state.effectiveStandingEntitlements.set(
      LOCAL_ID,
      companyStanding(companyMembershipId),
    );
    state.effectiveStandingEntitlements.set(
      OWNER_ID,
      companyStanding(bridgeMembershipId),
    );
    state.suppressLegacyAccessProjection.add(PEER_GM_ID);
    state.membershipHats.push({
      id: companyMembershipId,
      organization_id: ORGANIZATION_ID,
      account_id: LOCAL_ID,
      membership_scope: 'company',
      staxis_role: 'vp',
      job_title: null,
      covered_property_ids: null,
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    }, {
      id: bridgeMembershipId,
      organization_id: ORGANIZATION_ID,
      account_id: OWNER_ID,
      membership_scope: 'company',
      staxis_role: 'owner',
      job_title: null,
      covered_property_ids: null,
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    });
    state.structuralGrants.push({
      organization_id: ORGANIZATION_ID,
      membership_id: companyMembershipId,
      scope_type: 'property',
      property_id: HOTEL_A,
      property_relationship_id: RELATIONSHIP_A,
      source: 'manual',
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      expires_at: null,
    });
    state.structuralBridges.push({
      account_id: OWNER_ID,
      property_id: HOTEL_A,
      cutover_organization_id: ORGANIZATION_ID,
      cutover_relationship_id: RELATIONSHIP_A,
      status: 'active',
    });

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const accountId of [LOCAL_ID, OWNER_ID]) {
      const row = body.data.team.find((candidate: { accountId: string }) => candidate.accountId === accountId);
      assert.ok(row);
      assert.equal(row.directHotelAccount, true, accountId);
    }
    const rawOnly = body.data.team.find((candidate: { accountId: string }) => candidate.accountId === PEER_GM_ID);
    assert.ok(rawOnly);
    assert.equal(rawOnly.directHotelAccount, false, 'raw legacy residue must not establish directness');
    assert.equal(
      body.data.team.find((candidate: { accountId: string }) => candidate.accountId === LOCAL_ID).managementSurface,
      'company_access',
    );
  });

  test('fails closed when only raw legacy residue remains without canonical topology', async () => {
    account(CALLER_ID).role = 'admin';
    state.suppressLegacyAccessProjection.add(LOCAL_ID);

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.directHotelAccount, false);
  });

  test('keeps the People roster available when one directness row is indeterminate', async () => {
    account(CALLER_ID).role = 'admin';
    state.authorizationStateOmittedAccountIds.add(LOCAL_ID);

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.directHotelAccount, null);
    assert.equal(local.hotelLeadershipRole, null);
    assert.equal(body.data.team.length, state.accounts.length);
  });

  test('keeps a direct roster row visible when its standing DTO is unavailable', async () => {
    account(CALLER_ID).role = 'admin';
    account(LOCAL_ID).authority_mode = 'normalized';
    state.organizationId = ORGANIZATION_ID;
    state.membershipHats.push({
      id: '77777777-7777-4777-8777-777777777721',
      organization_id: ORGANIZATION_ID,
      account_id: LOCAL_ID,
      membership_scope: 'property',
      staxis_role: 'front_desk',
      job_title: null,
      covered_property_ids: [HOTEL_A],
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    });
    state.unavailableAccessAccountIds.add(LOCAL_ID);

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.directHotelAccount, true);
    assert.equal(local.hotelLeadershipRole, null);
  });

  test('returns truthful actions while redacting target reach outside the caller scope', async () => {
    const hotelAStaff = '44444444-4444-4444-4444-444444444444';
    const hotelBStaff = '55555555-5555-5555-5555-555555555555';
    account(MULTI_ID).staff_id = hotelBStaff;
    state.staffLinks.push(
      { account_id: MULTI_ID, property_id: HOTEL_A, staff_id: hotelAStaff, is_active: true },
      { account_id: MULTI_ID, property_id: HOTEL_B, staff_id: hotelBStaff, is_active: true },
    );
    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.data.team));

    const byId = new Map<string, Record<string, unknown>>(
      body.data.team.map((row: Record<string, unknown>) => [row.accountId as string, row]),
    );

    const self = byId.get(CALLER_ID)!;
    assert.deepEqual(self.actions, {
      canEditProfile: true,
      canChangeRole: false,
      canResetPassword: true,
      canRemove: false,
      canDeactivate: false,
      canReactivate: false,
    });
    assert.equal(self.isSelf, true);
    assert.equal(self.active, true);
    assert.equal(self.lastSignInAt, '2026-07-20T10:30:00.000Z');
    assert.equal(self.lastSignInKnown, true);
    assert.equal('directHotelAccount' in self, false, 'ordinary customer responses keep the existing team contract');

    const local = byId.get(LOCAL_ID)!;
    assert.deepEqual(local.actions, {
      canEditProfile: true,
      canChangeRole: true,
      canResetPassword: false,
      canRemove: true,
      canDeactivate: true,
      canReactivate: false,
    });
    assert.equal(local.canChangeRole, true, 'flat alias matches grouped action');
    assert.equal(local.hasOtherHotelAccess, false);
    assert.equal(local.updatedAt, account(LOCAL_ID).updated_at);
    assert.equal(local.ownerProtected, false);

    const multi = byId.get(MULTI_ID)!;
    assert.deepEqual(multi.actions, {
      canEditProfile: false,
      canChangeRole: false,
      canResetPassword: false,
      canRemove: true,
      canDeactivate: false,
      canReactivate: false,
    });
    assert.deepEqual(multi.propertyAccess, [HOTEL_A]);
    assert.equal(multi.hotelAccessCount, 1);
    assert.equal(multi.hasOtherHotelAccess, false);
    assert.equal(multi.staffId, hotelAStaff, 'staff identity must be scoped to the selected hotel');
    assert.deepEqual(multi.globalImpact, {
      displayNameAffectsAllHotels: true,
      roleAffectsAllHotels: true,
      passwordAffectsAllHotels: true,
      hotelAccessCount: 1,
      hasOtherHotelAccess: false,
    });
    assert.doesNotMatch(JSON.stringify(body.data), new RegExp(HOTEL_B, 'i'));

    // A GM cannot mutate an owner or a peer GM through this route.
    for (const protectedId of [OWNER_ID, PEER_GM_ID]) {
      assert.deepEqual(byId.get(protectedId)!.actions, {
        canEditProfile: false,
        canChangeRole: false,
        canResetPassword: false,
        canRemove: false,
        canDeactivate: false,
        canReactivate: false,
      });
    }
  });

  test('projects an archived selected-hotel link as identity history without active authority', async () => {
    const archivedStaff = '44444444-4444-4444-8444-444444444444';
    state.staffLinks.push({
      account_id: LOCAL_ID,
      property_id: HOTEL_A,
      staff_id: archivedStaff,
      is_active: false,
    });

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.staffId, null);
    assert.equal(local.historicalStaffId, archivedStaff);
    assert.equal(local.staffLinkAllowed, false);
  });

  test('fails closed when archived and active links make one account identity ambiguous', async () => {
    state.staffLinks.push(
      {
        account_id: LOCAL_ID,
        property_id: HOTEL_A,
        staff_id: '44444444-4444-4444-8444-444444444444',
        is_active: true,
      },
      {
        account_id: LOCAL_ID,
        property_id: HOTEL_A,
        staff_id: '55555555-5555-5555-8555-555555555555',
        is_active: false,
      },
    );
    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
  });

  test('keeps roster access under manage_team while manage_users disables sensitive actions', async () => {
    state.capabilityOverrides.push({
      property_id: HOTEL_A,
      capability: 'manage_users',
      role: 'general_manager',
      allowed: false,
    });

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.actions.canEditProfile, true, 'manage_team still allows roster profile work');
    assert.equal(local.actions.canChangeRole, false);
    assert.equal(local.actions.canRemove, false);
    assert.equal(local.actions.canDeactivate, false);
    assert.equal(local.actions.canReactivate, false);
  });

  test('intersects arbitrary target hats and names with the caller exact hotel reach', async () => {
    state.organizationId = ORGANIZATION_ID;
    state.membershipHats.push({
      id: '77777777-7777-4777-8777-777777777771',
      organization_id: ORGANIZATION_ID,
      account_id: MULTI_ID,
      membership_scope: 'company',
      staxis_role: 'vp',
      job_title: null,
      covered_property_ids: null,
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    }, {
      id: '77777777-7777-4777-8777-777777777772',
      organization_id: ORGANIZATION_ID,
      account_id: MULTI_ID,
      membership_scope: 'property',
      staxis_role: 'housekeeping',
      job_title: null,
      covered_property_ids: [HOTEL_B],
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    });

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.hatsByAccountId[MULTI_ID], [{
      membershipId: '77777777-7777-4777-8777-777777777771',
      scope: 'company',
      role: 'vp',
      label: { en: 'Oversees', es: 'Supervisa' },
      propertyIds: [HOTEL_A],
      propertyNames: ['Hotel A'],
    }]);
    assert.doesNotMatch(JSON.stringify(body.data), new RegExp(HOTEL_B, 'i'));
    assert.doesNotMatch(JSON.stringify(body.data), /coverageRedacted|hiddenPropertyCount/i);
  });

  test('allows a freshly verified platform admin to retain full target reach', async () => {
    account(CALLER_ID).role = 'admin';
    setAccess(CALLER_ID, []);
    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const multi = body.data.team.find((row: { accountId: string }) => row.accountId === MULTI_ID);
    assert.deepEqual(multi.propertyAccess, [HOTEL_A, HOTEL_B]);
    assert.equal(multi.hotelAccessCount, 2);
    assert.equal(multi.hasOtherHotelAccess, true);
  });

  test('inactive accounts must be reactivated before role changes and expose only reactivate', async () => {
    account(LOCAL_ID).active = false;

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.active, false);
    assert.equal(local.actions.canChangeRole, false);
    assert.equal(local.actions.canDeactivate, false);
    assert.equal(local.actions.canReactivate, true);
  });

  test('inactive normalized accounts stay in People but move role and scope management to Access', async () => {
    account(LOCAL_ID).active = false;
    account(LOCAL_ID).authority_mode = 'normalized';

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.active, false);
    assert.equal(local.managementSurface, 'company_access');
    assert.equal(local.accessManagementHref, '/company?tab=access');
    assert.deepEqual(local.actions, {
      canEditProfile: false,
      canChangeRole: false,
      canResetPassword: false,
      canRemove: false,
      canDeactivate: false,
      canReactivate: true,
    });
  });

  test('an independent hotel keeps its own People screen after the cutover', async () => {
    // Post-cutover production shape: everybody at a hotel with no management
    // company is normalized at authority version 2, and the roster RPC hands
    // them back on the hotel surface because there is no company Access screen
    // to send them to. Two separate failures used to hit here. The roster
    // parser rejected the combination outright, so the whole page came back
    // unavailable; and the row projection read authority mode instead of the
    // surface, so even when it loaded, nobody could be given a different job
    // or taken off the hotel.
    for (const accountId of [CALLER_ID, MULTI_ID, LOCAL_ID, OWNER_ID, PEER_GM_ID]) {
      account(accountId).authority_mode = 'normalized';
      account(accountId).authority_version = 2;
      state.independentHotelAccountIds.add(accountId);
    }

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200, 'the roster must parse, not fail closed');
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.authorityMode, 'normalized');
    assert.equal(local.authorityVersion, 2);
    assert.equal(local.managementSurface, 'legacy_hotel');
    assert.equal(local.accessManagementHref, null, 'an independent hotel has no Access screen');
    assert.deepEqual(local.actions, {
      canEditProfile: true,
      canChangeRole: true,
      canResetPassword: false,
      canRemove: true,
      canDeactivate: true,
      canReactivate: false,
    });
  });

  test('projects inactive normalized direct membership, grant, and bridge claims separately from managementSurface', async () => {
    account(CALLER_ID).role = 'admin';
    for (const accountId of [LOCAL_ID, OWNER_ID, PEER_GM_ID]) {
      account(accountId).active = false;
      account(accountId).authority_mode = 'normalized';
    }
    state.organizationId = ORGANIZATION_ID;
    state.membershipHats.push({
      id: '77777777-7777-4777-8777-777777777781',
      organization_id: ORGANIZATION_ID,
      account_id: LOCAL_ID,
      membership_scope: 'property',
      staxis_role: 'general_manager',
      job_title: null,
      covered_property_ids: [HOTEL_A],
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    }, {
      id: '77777777-7777-4777-8777-777777777782',
      organization_id: ORGANIZATION_ID,
      account_id: OWNER_ID,
      membership_scope: 'company',
      staxis_role: 'finance',
      job_title: null,
      covered_property_ids: null,
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    });
    state.structuralGrants.push({
      organization_id: ORGANIZATION_ID,
      membership_id: '77777777-7777-4777-8777-777777777782',
      scope_type: 'property',
      property_id: HOTEL_A,
      property_relationship_id: RELATIONSHIP_A,
      source: 'manual',
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      expires_at: null,
    });
    state.structuralBridges.push({
      account_id: PEER_GM_ID,
      property_id: HOTEL_A,
      cutover_organization_id: ORGANIZATION_ID,
      cutover_relationship_id: RELATIONSHIP_A,
      status: 'active',
    });

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const accountId of [LOCAL_ID, OWNER_ID, PEER_GM_ID]) {
      const row = body.data.team.find((candidate: { accountId: string }) => candidate.accountId === accountId);
      assert.ok(row);
      assert.equal(row.managementSurface, 'company_access');
      assert.equal(row.directHotelAccount, true, accountId);
    }
  });

  test('does not treat revoked, ended, or future normalized structural reach as a direct claim', async () => {
    account(CALLER_ID).role = 'admin';
    for (const accountId of [LOCAL_ID, OWNER_ID, PEER_GM_ID]) {
      account(accountId).active = false;
      account(accountId).authority_mode = 'normalized';
    }
    state.organizationId = ORGANIZATION_ID;
    state.membershipHats.push({
      id: '77777777-7777-4777-8777-777777777791',
      organization_id: ORGANIZATION_ID,
      account_id: LOCAL_ID,
      membership_scope: 'property',
      staxis_role: 'general_manager',
      job_title: null,
      covered_property_ids: [HOTEL_A],
      status: 'revoked',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    }, {
      id: '77777777-7777-4777-8777-777777777792',
      organization_id: ORGANIZATION_ID,
      account_id: OWNER_ID,
      membership_scope: 'company',
      staxis_role: 'finance',
      job_title: null,
      covered_property_ids: null,
      status: 'active',
      starts_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
    }, {
      id: '77777777-7777-4777-8777-777777777793',
      organization_id: ORGANIZATION_ID,
      account_id: PEER_GM_ID,
      membership_scope: 'property',
      staxis_role: 'front_desk',
      job_title: null,
      covered_property_ids: [HOTEL_A],
      status: 'active',
      starts_at: '2099-01-01T00:00:00.000Z',
      ended_at: null,
    });
    state.membershipHats[1]!.ended_at = '2026-01-01T00:00:00.000Z';
    state.structuralGrants.push({
      organization_id: ORGANIZATION_ID,
      membership_id: '77777777-7777-4777-8777-777777777792',
      scope_type: 'property',
      property_id: HOTEL_A,
      property_relationship_id: RELATIONSHIP_A,
      source: 'manual',
      status: 'active',
      starts_at: '2099-01-01T00:00:00.000Z',
      expires_at: null,
    });
    state.structuralBridges.push({
      account_id: PEER_GM_ID,
      property_id: HOTEL_A,
      cutover_organization_id: ORGANIZATION_ID,
      cutover_relationship_id: RELATIONSHIP_A,
      status: 'revoked',
    });

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const accountId of [LOCAL_ID, OWNER_ID, PEER_GM_ID]) {
      const row = body.data.team.find((candidate: { accountId: string }) => candidate.accountId === accountId);
      assert.ok(row);
      assert.equal(row.directHotelAccount, false, accountId);
    }
  });

  test('projects a pending lifecycle change and disables every conflicting action', async () => {
    state.pendingLifecycleAccountIds.add(LOCAL_ID);

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.lifecyclePending, true);
    assert.equal(local.lifecycleDesiredActive, false);
    assert.deepEqual(local.actions, {
      canEditProfile: false,
      canChangeRole: false,
      canResetPassword: false,
      canRemove: false,
      canDeactivate: false,
      canReactivate: false,
    });
  });

  test('projects normalized organization-owner protection and disables role/status actions', async () => {
    state.ownerProtectedAccountIds.add(LOCAL_ID);

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.ok(local);
    assert.equal(local.ownerProtected, true);
    assert.equal(local.actions.canEditProfile, true, 'owner protection does not hide ordinary profile fields');
    assert.equal(local.actions.canChangeRole, false);
    assert.equal(local.actions.canDeactivate, false);
    assert.equal(local.actions.canReactivate, false);
    assert.equal(local.actions.canRemove, false);
  });

  test('fails closed when normalized owner protection cannot be projected', async () => {
    state.ownerProtectionError = { message: 'simulated organization graph outage' };

    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.match((await response.json()).error, /team permissions.*temporarily unavailable/i);
  });

  test('fails closed when pending lifecycle state cannot be projected', async () => {
    state.lifecycleIntentQueryError = { message: 'simulated lifecycle store outage' };
    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
  });

  test('a disabled caller is rejected even with an already-issued session token', async () => {
    account(CALLER_ID).active = false;
    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 403);
  });

  test('withholds the roster when selected-hotel authority is revoked before egress', async () => {
    state.beforeFinalCallerAuthorityRead = () => {
      setAccess(CALLER_ID, []);
      account(CALLER_ID).authority_version += 1;
    };
    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.data, undefined);
  });

  test('withholds the roster when historical staff-link identity changes before egress', async () => {
    state.beforeFinalCallerAuthorityRead = () => {
      state.staffLinks.push({
        account_id: LOCAL_ID,
        property_id: HOTEL_A,
        staff_id: '44444444-4444-4444-8444-444444444444',
        is_active: false,
      });
    };
    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.data, undefined);
  });

  test('marks last-sign-in data unknown when Auth listing fails or omits the user', async () => {
    state.authListOmittedUserIds.add(account(LOCAL_ID).data_user_id);
    let response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    let body = await response.json();
    let local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.equal(local.lastSignInAt, null);
    assert.equal(local.lastSignInKnown, false);

    state.authListError = { message: 'simulated Auth list failure' };
    response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    body = await response.json();
    local = body.data.team.find((row: { accountId: string }) => row.accountId === LOCAL_ID);
    assert.equal(local.lastSignInAt, null);
    assert.equal(local.lastSignInKnown, false);
  });
});

describe('PUT /api/auth/team cross-hotel account safety', () => {
  test('capability override read outages fail closed with a retryable 503', async () => {
    state.capabilityOverrideError = { message: 'simulated capability store outage' };

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      displayName: 'Must Not Save',
    }));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'upstream_failure');
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.equal(state.accountUpdates.length, 0);
  });

  test('Hotel A manager cannot rename a Hotel A + B employee', async () => {
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      displayName: 'Renamed Everywhere',
    }));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /authorized at every hotel.*change this person's name/i);
    assert.equal(account(MULTI_ID).display_name, 'Morgan Multi');
    assert.equal(state.accountUpdates.length, 0);
  });

  test('Hotel A manager cannot change the global role of a Hotel A + B employee', async () => {
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      ...expectedRoleSnapshot(MULTI_ID),
      role: 'maintenance',
    }));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /authorized at every hotel.*change this person's role/i);
    assert.equal(account(MULTI_ID).role, 'housekeeping');
    assert.equal(state.roleChangeRows.length, 0);
  });

  test('role edits use manage_users rather than manage_team', async () => {
    state.capabilityOverrides.push({
      property_id: HOTEL_A,
      capability: 'manage_users',
      role: 'general_manager',
      allowed: false,
    });
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      ...expectedRoleSnapshot(LOCAL_ID),
      role: 'maintenance',
    }));
    assert.equal(response.status, 403);
    assert.equal(account(LOCAL_ID).role, 'housekeeping');
    assert.equal(state.roleChangeRows.length, 0);
  });

  test('role edits require the exact dialog-open role, display name, and row version', async () => {
    const requiredSnapshots = [
      { expectedDisplayName: 'Leslie Local', expectedUpdatedAt: account(LOCAL_ID).updated_at },
      { expectedRole: 'housekeeping', expectedUpdatedAt: account(LOCAL_ID).updated_at },
      { expectedRole: 'housekeeping', expectedDisplayName: 'Leslie Local' },
    ];
    for (const partialSnapshot of requiredSnapshots) {
      const response = await PUT(request('PUT', '/api/auth/team', {
        hotelId: HOTEL_A,
        accountId: LOCAL_ID,
        role: 'maintenance',
        ...partialSnapshot,
      }));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /account version shown when the editor was opened/i);
    }
    assert.equal(state.rpcCalls.some((call) => call.fn === 'staxis_change_hotel_team_role_guarded'), false);
  });

  test('a stale role dialog cannot overwrite a concurrent role change', async () => {
    const openedSnapshot = expectedRoleSnapshot(LOCAL_ID);
    account(LOCAL_ID).role = 'front_desk';
    account(LOCAL_ID).updated_at = nextAccountVersion();

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      ...openedSnapshot,
      role: 'maintenance',
    }));

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /changed while you were editing/i);
    assert.equal(account(LOCAL_ID).role, 'front_desk');
    const call = state.rpcCalls.find((entry) => entry.fn === 'staxis_change_hotel_team_role_guarded');
    assert.equal(call?.args.p_expected_role, 'housekeeping');
    assert.equal(call?.args.p_expected_updated_at, '2026-07-01T12:00:00.000Z');
    assert.equal(state.roleChangeRows.length, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('a stale role dialog cannot overwrite a concurrent display-name edit', async () => {
    const openedSnapshot = expectedRoleSnapshot(LOCAL_ID);
    account(LOCAL_ID).display_name = 'Leslie Changed Elsewhere';
    account(LOCAL_ID).updated_at = nextAccountVersion();

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      ...openedSnapshot,
      role: 'maintenance',
    }));

    assert.equal(response.status, 409);
    assert.equal(account(LOCAL_ID).role, 'housekeeping');
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Changed Elsewhere');
    const call = state.rpcCalls.find((entry) => entry.fn === 'staxis_change_hotel_team_role_guarded');
    assert.equal(call?.args.p_expected_display_name, 'Leslie Local');
    assert.equal(state.roleChangeRows.length, 0);
  });

  test('role RPC outages use role-specific retryable copy', async () => {
    state.roleRpcError = { message: 'simulated role RPC outage' };

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      ...expectedRoleSnapshot(LOCAL_ID),
      role: 'maintenance',
    }));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    const body = await response.json();
    assert.match(body.error, /role changes are temporarily unavailable/i);
    assert.doesNotMatch(body.error, /account status/i);
    assert.equal(account(LOCAL_ID).role, 'housekeeping');
  });

  test('a newly protected organization owner is rejected by the guarded role RPC', async () => {
    const openedSnapshot = expectedRoleSnapshot(LOCAL_ID);
    state.ownerProtectedAccountIds.add(LOCAL_ID);

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      ...openedSnapshot,
      role: 'maintenance',
    }));

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /organization-owner access is protected/i);
    assert.equal(account(LOCAL_ID).role, 'housekeeping');
    assert.equal(state.roleChangeRows.length, 0);
  });

  test('ordinary role edits cannot assign owner, change an owner, or change an inactive account', async () => {
    const promoteResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      ...expectedRoleSnapshot(LOCAL_ID),
      role: 'owner',
    }));
    assert.equal(promoteResponse.status, 400);
    assert.match((await promoteResponse.json()).error, /transfer ownership/i);

    account(CALLER_ID).role = 'owner';
    const ownerResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: OWNER_ID,
      ...expectedRoleSnapshot(OWNER_ID),
      role: 'maintenance',
    }));
    assert.equal(ownerResponse.status, 400);
    assert.match((await ownerResponse.json()).error, /transfer ownership/i);

    account(LOCAL_ID).active = false;
    const inactiveResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      ...expectedRoleSnapshot(LOCAL_ID),
      role: 'maintenance',
    }));
    assert.equal(inactiveResponse.status, 409);
    assert.match((await inactiveResponse.json()).error, /reactivate/i);
    assert.equal(state.roleChangeRows.length, 0);
  });

  test('Hotel A manager cannot reset a Hotel A + B employee password', async () => {
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      password: 'new-password-123',
    }));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /reset their own password/i);
    assert.equal(state.passwordUpdates.length, 0);
  });

  test('cannot replace the legacy global staff link for a multi-hotel account', async () => {
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      staffId: '66666666-6666-6666-6666-666666666666',
    }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /multiple hotels/i);
    assert.equal(state.accountUpdates.length, 0);
  });

  test('a manager of every target hotel may change profile fields but not set another password', async () => {
    setAccess(CALLER_ID, [HOTEL_A, HOTEL_B]);
    const profileResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      ...expectedRoleSnapshot(MULTI_ID),
      displayName: 'Morgan Updated',
      role: 'maintenance',
    }));
    assert.equal(profileResponse.status, 200);
    assert.deepEqual((await profileResponse.json()).data, { success: true });

    const passwordResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      password: 'new-password-123',
    }));
    assert.equal(passwordResponse.status, 403);
    assert.match((await passwordResponse.json()).error, /reset their own password/i);
    assert.equal(account(MULTI_ID).display_name, 'Morgan Updated');
    assert.equal(account(MULTI_ID).role, 'maintenance');
    assert.equal(state.passwordUpdates.length, 0);
    assert.equal(state.auditRows.length, 1);
    assert.equal(state.roleChangeRows.length, 2, 'one role-change event per affected hotel');
    assert.equal(
      state.rpcCalls.some((call) => call.fn === 'staxis_change_hotel_team_role_guarded'),
      true,
      'role and optional name must commit through the guarded atomic RPC',
    );
    assert.equal(state.accountUpdates.length, 0, 'role RPC must not fall back to a direct account update');
  });

  test('rejects password combined with a name, role, or staff link before either store changes', async () => {
    setAccess(CALLER_ID, [HOTEL_A, HOTEL_B]);
    const profileMutations = [
      { displayName: 'Must Not Partially Save' },
      { role: 'maintenance' },
      { staffId: null },
    ];
    for (const mutation of profileMutations) {
      const response = await PUT(request('PUT', '/api/auth/team', {
        hotelId: HOTEL_A,
        accountId: MULTI_ID,
        ...mutation,
        password: 'new-password-123',
      }));
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /password changes must be saved separately/i);
    }

    assert.equal(account(MULTI_ID).display_name, 'Morgan Multi');
    assert.equal(account(MULTI_ID).role, 'housekeeping');
    assert.equal(state.passwordUpdates.length, 0);
    assert.equal(state.accountUpdates.length, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('hotel access alone is insufficient when manage_team is restricted at another hotel', async () => {
    setAccess(CALLER_ID, [HOTEL_A, HOTEL_C]);
    setAccess(MULTI_ID, [HOTEL_A, HOTEL_C]);
    state.capabilityOverrides.push({
      property_id: HOTEL_C,
      capability: 'manage_team',
      role: 'general_manager',
      allowed: false,
    });

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      displayName: 'Must Not Change',
    }));
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /do not have permission.*change this person's name/i);
    assert.equal(account(MULTI_ID).display_name, 'Morgan Multi');
  });

  test('self-service name and password edits remain allowed', async () => {
    setAccess(CALLER_ID, [HOTEL_A, HOTEL_B]);
    const profileResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: CALLER_ID,
      displayName: 'Alex Updated',
    }));
    assert.equal(profileResponse.status, 200);
    const passwordResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: CALLER_ID,
      password: 'self-password-123',
    }));
    assert.equal(passwordResponse.status, 200);
    assert.equal(account(CALLER_ID).display_name, 'Alex Updated');
    assert.deepEqual(state.passwordUpdates, [{
      userId: CALLER_USER_ID,
      password: 'self-password-123',
    }]);
  });

  test('platform admin may update a multi-hotel non-admin account', async () => {
    account(CALLER_ID).role = 'admin';
    setAccess(CALLER_ID, ['*']);
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      ...expectedRoleSnapshot(MULTI_ID),
      displayName: 'Admin Approved Name',
      role: 'front_desk',
    }));
    assert.equal(response.status, 200);
    assert.equal(account(MULTI_ID).display_name, 'Admin Approved Name');
    assert.equal(account(MULTI_ID).role, 'front_desk');
  });

  test('profile and role edits stop while a lifecycle intent is pending', async () => {
    state.pendingLifecycleAccountIds.add(LOCAL_ID);
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      ...expectedRoleSnapshot(LOCAL_ID),
      displayName: 'Must Wait',
      role: 'maintenance',
    }));

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /pending account status change/i);
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.equal(account(LOCAL_ID).role, 'housekeeping');
    assert.equal(state.accountUpdates.length, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('profile mutation fails closed when lifecycle intent state is unavailable', async () => {
    state.lifecycleIntentQueryError = { message: 'relation unavailable' };
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      displayName: 'Must Not Save',
    }));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.equal(state.accountUpdates.length, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('database lifecycle fence wins if an intent appears after the profile pre-check', async () => {
    state.accountUpdateErrors.set(LOCAL_ID, {
      code: '55000',
      message: 'account lifecycle change pending',
    });
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      displayName: 'Must Lose The Race',
    }));

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /pending account status change/i);
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.equal(state.accountUpdates.length, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('a concurrent account change makes the profile write return 409 without an audit', async () => {
    state.accountUpdateConflicts.add(LOCAL_ID);
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      displayName: 'Stale Edit',
    }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /changed while you were editing/i);
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.equal(state.accountUpdates.length, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('profile commit rechecks the actor after route authorization and rolls back on revocation', async () => {
    state.beforeProfileCommit = () => {
      account(CALLER_ID).active = false;
      account(CALLER_ID).authority_version += 1;
    };

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      displayName: 'Must Not Survive Revocation',
    }));

    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /no longer authorized/i);
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.equal(state.auditRows.length, 0);
    assert.equal(state.accountUpdates.length, 0);
    assert.equal(
      state.rpcCalls.at(-1)?.fn,
      'staxis_update_hotel_team_profile_guarded',
    );
  });

  test('hotel transfer in the authorization/write gap conflicts without a profile write or audit', async () => {
    state.beforeProfileCommit = () => {
      setAccess(LOCAL_ID, [HOTEL_B]);
      account(LOCAL_ID).authority_version += 1;
    };

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      displayName: 'Must Not Cross The Transfer',
    }));

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /changed while you were editing/i);
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.deepEqual(account(LOCAL_ID).property_access, [HOTEL_B]);
    assert.equal(state.auditRows.length, 0);
    assert.equal(state.accountUpdates.length, 0);
  });

  test('audit failure rolls back both account profile and normalized staff-link writes', async () => {
    const staffId = '44444444-4444-4444-8444-444444444444';
    state.staffRows.push({ id: staffId, property_id: HOTEL_A, is_active: true });
    state.profileAuditError = { message: 'simulated atomic audit failure' };

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      displayName: 'Must Roll Back',
      staffId,
    }));

    assert.equal(response.status, 503);
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.equal(account(LOCAL_ID).staff_id, null);
    assert.equal(state.staffLinks.length, 0);
    assert.equal(state.auditRows.length, 0);
    assert.equal(state.accountUpdates.length, 0);
  });

  test('missing and cross-hotel staff IDs have the same fail-closed response', async () => {
    const foreignStaffId = '55555555-5555-4555-8555-555555555555';
    state.staffRows.push({ id: foreignStaffId, property_id: HOTEL_B, is_active: true });

    const foreign = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      staffId: foreignStaffId,
    }));
    const missing = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      staffId: '77777777-7777-4777-8777-777777777777',
    }));

    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.equal((await foreign.json()).error, (await missing.json()).error);
    assert.equal(account(LOCAL_ID).staff_id, null);
    assert.equal(state.staffLinks.length, 0);
    assert.equal(state.auditRows.length, 0);
    assert.equal(state.accountUpdates.length, 0);
  });
});

describe('DELETE /api/auth/team remains selected-hotel scoped', () => {
  test('Hotel A manager may detach Hotel A from a multi-hotel employee without touching Hotel B', async () => {
    const response = await DELETE(request(
      'DELETE',
      `/api/auth/team?hotelId=${HOTEL_A}&accountId=${MULTI_ID}`,
    ));
    assert.equal(response.status, 200);
    assert.deepEqual(account(MULTI_ID).property_access, [HOTEL_A, HOTEL_B]);
    assert.deepEqual(state.canonicalPropertyAccess.get(MULTI_ID), [HOTEL_B]);
    assert.equal(state.rpcCalls.at(-1)?.fn, 'staxis_remove_property_access_authoritative');
    assert.equal(state.auditRows.length, 1);
  });

  test('a concurrent target change makes hotel removal return 409 without detaching', async () => {
    state.removalConflicts.add(MULTI_ID);
    const response = await DELETE(request(
      'DELETE',
      `/api/auth/team?hotelId=${HOTEL_A}&accountId=${MULTI_ID}`,
    ));
    assert.equal(response.status, 409);
    assert.deepEqual(account(MULTI_ID).property_access, [HOTEL_A, HOTEL_B]);
    assert.equal(state.auditRows.length, 0);
  });

  test('does not detach a hotel while the target has a pending lifecycle intent', async () => {
    state.pendingLifecycleAccountIds.add(MULTI_ID);
    const response = await DELETE(request(
      'DELETE',
      `/api/auth/team?hotelId=${HOTEL_A}&accountId=${MULTI_ID}`,
    ));

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /pending account status change/i);
    assert.deepEqual(account(MULTI_ID).property_access, [HOTEL_A, HOTEL_B]);
    assert.equal(state.rpcCalls.some((call) => call.fn === 'staxis_remove_property_access_authoritative'), false);
    assert.equal(state.auditRows.length, 0);
  });

  test('database lifecycle fence wins if an intent appears after the detach pre-check', async () => {
    state.removalErrors.set(MULTI_ID, {
      code: '55000',
      message: 'account lifecycle change pending',
    });
    const response = await DELETE(request(
      'DELETE',
      `/api/auth/team?hotelId=${HOTEL_A}&accountId=${MULTI_ID}`,
    ));

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /pending account status change/i);
    assert.deepEqual(account(MULTI_ID).property_access, [HOTEL_A, HOTEL_B]);
    assert.equal(state.auditRows.length, 0);
  });

  test('detach requires manage_users at the selected hotel', async () => {
    state.capabilityOverrides.push({
      property_id: HOTEL_A,
      capability: 'manage_users',
      role: 'general_manager',
      allowed: false,
    });
    const response = await DELETE(request(
      'DELETE',
      `/api/auth/team?hotelId=${HOTEL_A}&accountId=${LOCAL_ID}`,
    ));
    assert.equal(response.status, 403);
    assert.deepEqual(account(LOCAL_ID).property_access, [HOTEL_A]);
    assert.equal(
      state.rpcCalls.some((call) => call.fn === 'staxis_remove_property_access_authoritative'),
      false,
    );
  });

  test('an owner account must use ownership transfer before detach', async () => {
    account(CALLER_ID).role = 'owner';
    const response = await DELETE(request(
      'DELETE',
      `/api/auth/team?hotelId=${HOTEL_A}&accountId=${OWNER_ID}`,
    ));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /transfer ownership/i);
    assert.deepEqual(account(OWNER_ID).property_access, [HOTEL_A]);
  });

  test('a normalized organization owner cannot be detached through a legacy hotel role', async () => {
    state.ownerProtectedAccountIds.add(LOCAL_ID);

    const response = await DELETE(request(
      'DELETE',
      `/api/auth/team?hotelId=${HOTEL_A}&accountId=${LOCAL_ID}`,
    ));

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /organization-owner access is protected/i);
    assert.deepEqual(account(LOCAL_ID).property_access, [HOTEL_A]);
    assert.equal(
      state.rpcCalls.some((call) => call.fn === 'staxis_remove_property_access_authoritative'),
      false,
    );
  });

  test('maps guarded detach races to pending, retryable, and owner-protected responses', async () => {
    for (const scenario of [
      { result: { status: 'pending_conflict' }, expectedStatus: 409, message: /pending account status change/i },
      { result: { status: 'retry' }, expectedStatus: 503, message: /team permissions.*temporarily unavailable/i },
      { result: { status: 'forbidden', reason: 'organization_owner' }, expectedStatus: 409, message: /organization-owner access is protected/i },
    ]) {
      state.removalRpcResults.set(LOCAL_ID, scenario.result);
      const response = await DELETE(request(
        'DELETE',
        `/api/auth/team?hotelId=${HOTEL_A}&accountId=${LOCAL_ID}`,
      ));
      assert.equal(response.status, scenario.expectedStatus);
      assert.match((await response.json()).error, scenario.message);
      assert.deepEqual(account(LOCAL_ID).property_access, [HOTEL_A]);
      state.removalRpcResults.clear();
    }
  });
});
