/**
 * Direct route-boundary tests for hotel account invitations.
 *
 * These use the real POST handlers and an in-memory Supabase adapter. They pin
 * both halves of the authorization decision: who may create a privileged
 * invite, and whether that authority still exists when the recipient accepts.
 */

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';

import { POST as acceptInvite } from '@/app/api/auth/accept-invite/route';
import {
  DELETE as revokeInvite,
  GET as listInvites,
  POST as createInvite,
} from '@/app/api/auth/invites/route';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { invalidateTwoFactorCache } from '@/lib/two-factor';
import type { AppRole } from '@/lib/roles';

const HOTEL_A = '11111111-1111-1111-1111-111111111111';
const HOTEL_B = '22222222-2222-2222-2222-222222222222';
const CALLER_ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CALLER_AUTH_ID = '10000000-0000-0000-0000-000000000001';
const CREATED_AUTH_ID = '10000000-0000-0000-0000-000000000099';
const EXISTING_ACCOUNT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXISTING_AUTH_ID = '10000000-0000-4000-8000-000000000002';
const STAFF_ID = '77777777-7777-4777-8777-777777777777';
const ORGANIZATION_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SCOPE_RECEIPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01';

interface AccountRow {
  id: string;
  role: AppRole;
  property_access: string[];
  active: boolean;
  data_user_id: string;
  display_name: string;
  username: string;
}

interface InviteRow {
  id: string;
  hotel_id: string;
  email: string;
  role: string;
  token_hash: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by?: string | null;
  invited_by: string;
  created_at: string;
  organization_id?: string | null;
  membership_scope?: 'company' | 'property' | null;
  covered_property_ids?: string[] | null;
  target_staff_id?: string | null;
  acceptance_claim_token?: string | null;
}

interface StaffRow {
  id: string;
  property_id: string;
  department: string | null;
  is_active: boolean | null;
}

interface TestState {
  accounts: AccountRow[];
  invites: InviteRow[];
  authorityMode: 'legacy' | 'normalized';
  normalizedStandings: Array<{
    propertyId: string;
    operationalRole: AppRole;
    hotelMutationAllowed: boolean;
    accessProfile?: 'organization_owner' | 'organization_admin' | 'portfolio_manager' | 'property_manager';
    scopeType?: 'organization' | 'company' | 'property';
  }>;
  companyPropertyIds: string[];
  capabilityOverrides: Array<{
    property_id: string;
    capability: string;
    role: string;
    allowed: boolean;
  }>;
  authUsers: Array<{ id: string; email: string; createdAt: string }>;
  authLookupError: boolean;
  accountLookupError: boolean;
  propertyOwnerAuthUserIds: string[];
  staffRows: StaffRow[];
  grantCalls: Array<Record<string, unknown>>;
  createdAuthUsers: Array<{ id: string; email: string }>;
  auditRows: Array<Record<string, unknown>>;
  finalizeErrorCode: string | null;
  finalizeLostResponse: boolean;
  beforeFinalize: (() => void) | null;
  beforeGuardedCreate: (() => void) | null;
  beforeGuardedRevoke: (() => void) | null;
  beforeInviteListPage: (() => void) | null;
}

let state: TestState;

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
type GetUserFn = typeof supabaseAdmin.auth.getUser;
type CreateUserFn = typeof supabaseAdmin.auth.admin.createUser;
type DeleteUserFn = typeof supabaseAdmin.auth.admin.deleteUser;
type ListUsersFn = typeof supabaseAdmin.auth.admin.listUsers;

const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalCreateUser: CreateUserFn = supabaseAdmin.auth.admin.createUser.bind(supabaseAdmin.auth.admin);
const originalDeleteUser: DeleteUserFn = supabaseAdmin.auth.admin.deleteUser.bind(supabaseAdmin.auth.admin);
const originalListUsers: ListUsersFn = supabaseAdmin.auth.admin.listUsers.bind(supabaseAdmin.auth.admin);
const originalResendKey = process.env.RESEND_API_KEY;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function testInviteId(index: number): string {
  return `f1111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
}

function resetState(): void {
  state = {
    accounts: [{
      id: CALLER_ACCOUNT_ID,
      role: 'general_manager',
      property_access: [HOTEL_A],
      active: true,
      data_user_id: CALLER_AUTH_ID,
      display_name: 'Alex Manager',
      username: 'alex.manager',
    }],
    invites: [],
    authorityMode: 'legacy',
    normalizedStandings: [],
    companyPropertyIds: [],
    capabilityOverrides: [],
    authUsers: [],
    authLookupError: false,
    accountLookupError: false,
    propertyOwnerAuthUserIds: [],
    staffRows: [],
    grantCalls: [],
    createdAuthUsers: [],
    auditRows: [],
    finalizeErrorCode: null,
    finalizeLostResponse: false,
    beforeFinalize: null,
    beforeGuardedCreate: null,
    beforeGuardedRevoke: null,
    beforeInviteListPage: null,
  };
}

function caller(): AccountRow {
  return state.accounts[0]!;
}

function normalizeAuthorityAtHotel(
  operationalRole: AppRole,
  hotelMutationAllowed = true,
): void {
  state.authorityMode = 'normalized';
  state.normalizedStandings = [{ propertyId: HOTEL_A, operationalRole, hotelMutationAllowed }];
  state.companyPropertyIds = [HOTEL_A];
}

function seedExistingAccount(
  email: string,
  overrides: Partial<AccountRow> = {},
): AccountRow {
  state.authUsers.push({
    id: EXISTING_AUTH_ID,
    email,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  const account: AccountRow = {
    id: EXISTING_ACCOUNT_ID,
    role: 'front_desk',
    property_access: [],
    active: true,
    data_user_id: EXISTING_AUTH_ID,
    display_name: 'Existing Teammate',
    username: 'existing.teammate',
    ...overrides,
  };
  state.accounts.push(account);
  return account;
}

function seedStaff(overrides: Partial<StaffRow> = {}): StaffRow {
  const staff: StaffRow = {
    id: STAFF_ID,
    property_id: HOTEL_A,
    department: 'front_desk',
    is_active: true,
    ...overrides,
  };
  state.staffRows.push(staff);
  return staff;
}

function seedInvite(role: string, token = `invite-token-${role}`): string {
  state.invites.push({
    id: testInviteId(state.invites.length + 1),
    hotel_id: HOTEL_A,
    email: `${role}@example.test`,
    role,
    token_hash: tokenHash(token),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    accepted_at: null,
    accepted_by: null,
    invited_by: CALLER_ACCOUNT_ID,
    created_at: new Date().toISOString(),
    organization_id: null,
    membership_scope: null,
    covered_property_ids: null,
  });
  return token;
}

function installSupabaseStub(): void {
  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: CALLER_AUTH_ID, email: 'alex@example.test' } },
    error: null,
  })) as unknown as GetUserFn;

  supabaseAdmin.auth.admin.createUser = (async (input: { email: string }) => {
    const user = {
      id: CREATED_AUTH_ID,
      email: input.email,
      created_at: new Date().toISOString(),
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
    };
    state.createdAuthUsers.push({ id: user.id, email: input.email });
    return { data: { user }, error: null };
  }) as unknown as CreateUserFn;

  supabaseAdmin.auth.admin.deleteUser = (async (id: string) => {
    state.createdAuthUsers = state.createdAuthUsers.filter((user) => user.id !== id);
    return { data: {}, error: null };
  }) as unknown as DeleteUserFn;
  supabaseAdmin.auth.admin.listUsers = (async () => {
    if (state.authLookupError) {
      return { data: { users: [] }, error: { message: 'forced Auth lookup failure' } };
    }
    const users = state.authUsers.map((identity) => ({
      id: identity.id,
      email: identity.email,
      created_at: identity.createdAt,
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
    }));
    return {
      data: { users, aud: 'authenticated', nextPage: null, lastPage: 1, total: users.length },
      error: null,
    };
  }) as unknown as ListUsersFn;

  supabaseAdmin.rpc = (async (fn: string, args?: Record<string, unknown>) => {
    if (fn === 'staxis_api_limit_hit') return { data: 1, error: null };
    if (fn === 'staxis_resolve_organization_property_topology') {
      const effectiveAt = typeof args?.p_effective_at === 'string'
        ? args.p_effective_at
        : new Date().toISOString();
      const propertyIds = [...new Set(state.companyPropertyIds)].sort();
      return {
        data: {
          ok: true,
          schemaVersion: 'organization-property-topology-v1',
          organizationId: args?.p_organization_id,
          effectiveAt,
          propertyIds,
        },
        error: null,
      };
    }
    if (fn === 'staxis_grant_existing_account_invite_guarded') {
      state.grantCalls.push({ ...args });
      const actor = state.accounts.find((row) => row.id === args?.p_actor_account_id);
      const target = state.accounts.find((row) => row.id === args?.p_target_account_id);
      const normalized = args?.p_organization_id !== null;
      const propertyIds = Array.isArray(args?.p_covered_property_ids)
        ? args.p_covered_property_ids as string[]
        : [];
      const standing = actor?.role === 'admin'
        ? { operationalRole: 'admin' as AppRole, hotelMutationAllowed: true }
        : state.authorityMode === 'normalized'
          ? state.normalizedStandings.find((row) => row.propertyId === args?.p_hotel_id)
          : actor?.property_access.includes(args?.p_hotel_id as string)
            ? { operationalRole: actor.role, hotelMutationAllowed: true }
            : null;
      const role = args?.p_role as string;
      const mayGrant = !!actor?.active
        && actor.data_user_id === args?.p_actor_auth_user_id
        && !!standing?.hotelMutationAllowed
        && ['admin', 'owner', 'general_manager'].includes(standing.operationalRole)
        && (!['owner', 'general_manager'].includes(role)
          || ['admin', 'owner'].includes(standing.operationalRole))
        && (!normalized
          || (state.authorityMode === 'normalized'
            && args?.p_organization_id === ORGANIZATION_A
            && args?.p_membership_scope === 'property'
            && propertyIds.length > 0
            && propertyIds.every((id) => state.normalizedStandings.some(
              (candidate) => candidate.propertyId === id,
            ))));
      if (!mayGrant) return { data: { ok: false, reason: 'denied' }, error: null };
      if (!target?.active) return { data: { ok: false, reason: 'not_found' }, error: null };
      if (target.role !== role && target.property_access.length > 0) {
        return { data: { ok: false, reason: 'role_conflict' }, error: null };
      }
      const staffId = typeof args?.p_target_staff_id === 'string'
        ? args.p_target_staff_id
        : null;
      if (staffId) {
        const staff = state.staffRows.find((row) => row.id === staffId);
        const allowedStaffPropertyIds = normalized
          ? propertyIds
          : [args?.p_hotel_id as string];
        if (!staff
            || !allowedStaffPropertyIds.includes(staff.property_id)
            || staff.is_active !== true
            || (staff.department ?? 'housekeeping') !== role) {
          return { data: { ok: false, reason: 'not_found' }, error: null };
        }
      }
      const alreadyGranted = !normalized
        && target.property_access.includes(args?.p_hotel_id as string);
      if (!normalized && !alreadyGranted) {
        target.property_access = [...target.property_access, args?.p_hotel_id as string];
      }
      state.auditRows.push({
        action: 'invite.existing_account_grant',
        target_id: target.id,
        request_id: args?.p_request_id,
      });
      return {
        data: {
          ok: true,
          status: alreadyGranted ? 'noop' : 'granted',
          accountId: target.id,
          hotelId: args?.p_hotel_id,
          role,
          normalized,
          membershipId: normalized ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee98' : null,
          staffId,
        },
        error: null,
      };
    }
    if (fn === 'staxis_create_account_invite_guarded') {
      state.beforeGuardedCreate?.();
      const actor = state.accounts.find((row) => row.id === args?.p_actor_account_id);
      const normalized = args?.p_organization_id !== null;
      const propertyIds = Array.isArray(args?.p_covered_property_ids)
        ? args.p_covered_property_ids as string[]
        : [];
      const standing = actor?.role === 'admin'
        ? { operationalRole: 'admin' as AppRole, hotelMutationAllowed: true }
        : state.authorityMode === 'normalized'
          ? state.normalizedStandings.find((row) => row.propertyId === args?.p_hotel_id)
          : actor?.property_access.includes(args?.p_hotel_id as string)
            ? { operationalRole: actor.role, hotelMutationAllowed: true }
            : null;
      const role = args?.p_role as string;
      const mayGrant = !!actor?.active
        && actor.data_user_id === args?.p_actor_auth_user_id
        && !!standing?.hotelMutationAllowed
        && ['admin', 'owner', 'general_manager'].includes(standing.operationalRole)
        && (!['owner', 'general_manager'].includes(role)
          || ['admin', 'owner'].includes(standing.operationalRole))
        && (!normalized
          || (state.authorityMode === 'normalized'
            && args?.p_organization_id === ORGANIZATION_A
            && args?.p_membership_scope === 'property'
            && propertyIds.length > 0
            && new Set(propertyIds).size === propertyIds.length
            && propertyIds.every((id) => state.normalizedStandings.some(
              (candidate) => candidate.propertyId === id,
            ))));
      if (!mayGrant) return { data: { ok: false, reason: 'denied' }, error: null };
      const invite: InviteRow = {
        id: testInviteId(state.invites.length + 1),
        hotel_id: args?.p_hotel_id as string,
        email: args?.p_email as string,
        role,
        token_hash: args?.p_token_hash as string,
        expires_at: args?.p_expires_at as string,
        accepted_at: null,
        accepted_by: null,
        invited_by: actor.id,
        created_at: new Date().toISOString(),
        organization_id: normalized ? args?.p_organization_id as string : null,
        membership_scope: normalized
          ? args?.p_membership_scope as 'company' | 'property'
          : null,
        covered_property_ids: normalized && args?.p_membership_scope === 'property'
          ? propertyIds
          : null,
        target_staff_id: typeof args?.p_target_staff_id === 'string'
          ? args.p_target_staff_id
          : null,
        acceptance_claim_token: null,
      };
      state.invites.push(invite);
      state.auditRows.push({
        action: 'invite.create',
        target_id: invite.id,
        request_id: args?.p_request_id,
      });
      return {
        data: {
          ok: true,
          inviteId: invite.id,
          hotelId: invite.hotel_id,
          hotelName: 'Hotel A',
          targetStaffId: invite.target_staff_id ?? null,
        },
        error: null,
      };
    }
    if (fn === 'staxis_revoke_account_invite_guarded') {
      state.beforeGuardedRevoke?.();
      const invite = state.invites.find((row) => row.id === args?.p_invite_id);
      if (!invite) return { data: { ok: false, reason: 'not_found' }, error: null };
      const actor = state.accounts.find((row) => row.id === args?.p_actor_account_id);
      const normalizedInvite = invite.organization_id !== null
        || invite.membership_scope !== null
        || invite.covered_property_ids !== null;
      const standing = actor?.role === 'admin'
        ? { operationalRole: 'admin' as AppRole, hotelMutationAllowed: true }
        : state.authorityMode === 'normalized'
          ? state.normalizedStandings.find((row) => row.propertyId === invite.hotel_id)
          : actor?.property_access.includes(invite.hotel_id)
            ? { operationalRole: actor.role, hotelMutationAllowed: true }
            : null;
      if (!actor?.active
          || actor.data_user_id !== args?.p_actor_auth_user_id
          || (actor.role !== 'admin'
            && normalizedInvite !== (state.authorityMode === 'normalized'))
          || !standing?.hotelMutationAllowed
          || !['admin', 'owner', 'general_manager'].includes(standing.operationalRole)) {
        return { data: { ok: false, reason: 'denied' }, error: null };
      }
      if (invite.accepted_at) {
        return { data: { ok: false, reason: 'not_pending' }, error: null };
      }
      state.invites = state.invites.filter((row) => row.id !== invite.id);
      state.auditRows.push({ action: 'invite.revoke', target_id: invite.id });
      return {
        data: { ok: true, inviteId: invite.id, hotelId: invite.hotel_id },
        error: null,
      };
    }
    if (fn === 'staxis_claim_account_invite_acceptance') {
      const invite = state.invites.find((row) => row.token_hash === args?.p_token_hash);
      if (!invite) return { data: { ok: false, reason: 'not_found' }, error: null };
      if (invite.accepted_at) return { data: { ok: false, reason: 'already_used' }, error: null };
      if (invite.acceptance_claim_token && invite.acceptance_claim_token !== args?.p_claim_token) {
        return { data: { ok: false, reason: 'busy' }, error: null };
      }
      invite.acceptance_claim_token = args?.p_claim_token as string;
      return { data: { ok: true, inviteId: invite.id }, error: null };
    }
    if (fn === 'staxis_release_account_invite_acceptance') {
      const invite = state.invites.find((row) => row.id === args?.p_invite_id);
      if (invite && invite.acceptance_claim_token === args?.p_claim_token && !invite.accepted_at) {
        invite.acceptance_claim_token = null;
        return { data: true, error: null };
      }
      return { data: false, error: null };
    }
    if (fn === 'staxis_accept_account_invite') {
      state.beforeFinalize?.();
      if (state.finalizeErrorCode) {
        return { data: null, error: { code: state.finalizeErrorCode, message: 'forced finalization failure' } };
      }
      const invite = state.invites.find((row) => row.token_hash === args?.p_token_hash);
      const actor = state.accounts.find((row) => row.id === invite?.invited_by);
      const normalizedInvite = !!invite && (invite.organization_id !== null
        || invite.membership_scope !== null
        || invite.covered_property_ids !== null);
      const standing = actor?.role === 'admin'
        ? { operationalRole: 'admin' as AppRole, hotelMutationAllowed: true }
        : state.authorityMode === 'normalized'
        ? state.normalizedStandings.find((row) => row.propertyId === invite?.hotel_id)
        : actor?.property_access.includes(invite?.hotel_id ?? '')
          ? { operationalRole: actor.role, hotelMutationAllowed: true }
          : null;
      if (!invite
        || invite.acceptance_claim_token !== args?.p_claim_token
        || !actor?.active
        || (actor.role !== 'admin'
          && normalizedInvite !== (state.authorityMode === 'normalized'))
        || !standing?.hotelMutationAllowed
        || !['admin', 'owner', 'general_manager'].includes(standing.operationalRole)) {
        return { data: null, error: { code: '42501', message: 'inviter revoked' } };
      }
      const normalized = !!invite.membership_scope;
      // `legacyRoleForHat` in the real RPC: a company job degrades DOWN to
      // front desk, never up. 0464 left one company word to degrade.
      const role = invite.role === 'regional_manager'
        ? 'front_desk'
        : invite.role as AppRole;
      const accountId = `created-account-${state.accounts.length}`;
      state.accounts.push({
        id: accountId,
        role,
        property_access: normalized ? [] : [invite.hotel_id],
        active: true,
        data_user_id: args?.p_auth_user_id as string,
        display_name: args?.p_display_name as string,
        username: args?.p_username as string,
      });
      invite.accepted_at = new Date().toISOString();
      invite.accepted_by = accountId;
      invite.acceptance_claim_token = null;
      if (state.finalizeLostResponse) {
        return {
          data: null,
          error: { code: 'PGRST000', message: 'response lost after commit' },
        };
      }
      return {
        data: {
          ok: true,
          accountId,
          normalized,
          membershipId: normalized ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee99' : null,
        },
        error: null,
      };
    }
    if (fn === 'staxis_list_account_authorized_properties') {
      const account = state.accounts.find((row) => row.id === args?.p_account_id);
      if (!account) return { data: { ok: false }, error: null };
      if (account.role === 'admin') {
        return {
          data: {
            ok: true,
            all: true,
            authorityMode: state.authorityMode,
            authorityVersion: 1,
            effectiveAccessHash: 'a'.repeat(64),
            propertyIds: [],
            legacyPropertyIds: [],
            membershipPropertyIds: [],
            propertyStandings: [],
          },
          error: null,
        };
      }
      const specs = state.authorityMode === 'normalized'
        ? state.normalizedStandings
        : account.property_access
          .filter((propertyId) => /^[0-9a-f-]{36}$/i.test(propertyId))
          .map((propertyId) => ({
            propertyId,
            operationalRole: account.role,
            hotelMutationAllowed: true,
          }));
      const propertyIds = specs.map((standing) => standing.propertyId).sort();
      return {
        data: {
          ok: true,
          all: false,
          authorityMode: state.authorityMode,
          authorityVersion: 1,
          effectiveAccessHash: 'b'.repeat(64),
          propertyIds,
          legacyPropertyIds: state.authorityMode === 'legacy' ? propertyIds : [],
          membershipPropertyIds: state.authorityMode === 'normalized' ? propertyIds : [],
          propertyStandings: [...specs]
            .sort((left, right) => left.propertyId.localeCompare(right.propertyId))
            .map((standing) => ({
              ...standing,
              seesFinancials: ['owner', 'general_manager'].includes(standing.operationalRole),
              portfolioIntelligenceRead: state.authorityMode === 'normalized',
              entitlements: state.authorityMode === 'normalized'
                ? [{
                    kind: 'access_grant',
                    entitlementId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    organizationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                    membershipId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                    accessProfile: 'accessProfile' in standing
                      ? standing.accessProfile ?? 'property_manager'
                      : 'property_manager',
                    staxisRole: null,
                    scopeType: 'scopeType' in standing
                      ? standing.scopeType ?? 'property'
                      : 'property',
                    portfolioId: null,
                  }]
                : [{
                    kind: 'legacy',
                    entitlementId: account.id,
                    organizationId: null,
                    membershipId: null,
                    accessProfile: null,
                    staxisRole: null,
                    scopeType: 'property',
                    portfolioId: null,
                  }],
            })),
        },
        error: null,
      };
    }
    if (fn === 'staxis_resolve_authorization_scope') {
      const account = state.accounts.find((row) => row.id === args?.p_account_id);
      const propertyIds = state.normalizedStandings
        .map((standing) => standing.propertyId)
        .sort();
      if (!account || state.authorityMode !== 'normalized' || propertyIds.length === 0) {
        return { data: { ok: false, reason: 'no_hotels' }, error: null };
      }
      const resolvedAt = new Date().toISOString();
      return {
        data: {
          ok: true,
          receipt: {
            id: SCOPE_RECEIPT_ID,
            accountId: account.id,
            organizationId: ORGANIZATION_A,
            organizationName: 'Test Management Company',
            authorityMode: 'normalized',
            selectorType: 'all_authorized',
            requestedPortfolioId: null,
            requestedPropertyIds: [],
            authorizedPropertyIds: propertyIds,
            propertyIds,
            authorizedPropertyCount: propertyIds.length,
            selectedPropertyCount: propertyIds.length,
            portfolioCatalog: [],
            accountAuthorizationVersion: 1,
            organizationAccessEpoch: 1,
            resolverVersion: 'authorization-scope-resolver.v1',
            authorizationHash: 'c'.repeat(64),
            scopeHash: 'd'.repeat(64),
            provenance: {
              entitlements: state.normalizedStandings.map((standing) => ({
                propertyId: standing.propertyId,
                entitlementKind: 'access_grant',
                entitlementId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                membershipId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                accessProfile: standing.accessProfile ?? 'property_manager',
                staxisRole: null,
                scopeType: standing.scopeType ?? 'property',
                portfolioId: null,
              })),
              governingRelationshipTypes: ['operator', 'owner'],
              selectionWasTruncated: false,
            },
            resolvedAt,
            expiresAt: new Date(Date.parse(resolvedAt) + 120_000).toISOString(),
          },
        },
        error: null,
      };
    }
    return { data: null, error: null };
  }) as unknown as RpcFn;

  supabaseAdmin.from = ((table: string) => {
    if (table === 'accounts') return accountsBuilder();
    if (table === 'account_invites') return invitesBuilder();
    if (table === 'staff') return staffBuilder();
    if (table === 'capability_overrides') return capabilityOverridesBuilder();
    if (table === 'organization_property_relationships') {
      const equals = new Map<string, unknown>();
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          equals.set(column, value);
          return builder;
        },
        order: () => builder,
        range: () => builder,
        then: (resolve: (value: unknown) => unknown) => {
          const rows = state.authorityMode === 'normalized'
            && (equals.get('organization_id') === undefined
              || equals.get('organization_id') === ORGANIZATION_A)
            ? state.companyPropertyIds
              .filter((propertyId) => equals.get('property_id') === undefined
                || equals.get('property_id') === propertyId)
              .map((propertyId) => ({
                organization_id: ORGANIZATION_A,
                property_id: propertyId,
                relationship_type: 'operator',
                is_primary_grouping: true,
                starts_at: new Date(Date.now() - 86_400_000).toISOString(),
                ends_at: null,
              }))
            : [];
          return resolve({ data: rows, error: null, count: rows.length });
        },
      };
      return builder;
    }
    if (table === 'organizations') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.authorityMode === 'normalized'
            ? [{ id: ORGANIZATION_A, status: 'active', organization_type: 'management_company' }]
            : [],
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'properties') {
      let hotelId: unknown;
      let hotelIds: unknown[] | null = null;
      let ownerAuthUserId: unknown;
      const hotelName = (id: unknown) => id === HOTEL_A
        ? 'Hotel A'
        : id === HOTEL_B ? 'Hotel B' : null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          if (column === 'id') hotelId = value;
          if (column === 'owner_id') ownerAuthUserId = value;
          return builder;
        },
        limit: () => builder,
        in: (_column: string, values: unknown[]) => {
          hotelIds = values;
          return builder;
        },
        order: () => builder,
        range: () => builder,
        maybeSingle: async () => {
          if (typeof ownerAuthUserId === 'string') {
            return {
              data: state.propertyOwnerAuthUserIds.includes(ownerAuthUserId)
                ? { id: HOTEL_A }
                : null,
              error: null,
            };
          }
          return {
            data: hotelName(hotelId) ? { id: hotelId, name: hotelName(hotelId) } : null,
            error: null,
          };
        },
        then: (resolve: (value: unknown) => unknown) => {
          const rows = (hotelIds ?? []).flatMap((id) => {
            const name = hotelName(id);
            return name ? [{ id, name }] : [];
          });
          return resolve({ data: rows, error: null, count: rows.length });
        },
      };
      return builder;
    }

    if (table === 'trusted_devices') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
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

    if (table === 'admin_audit_log') {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.auditRows.push(row);
          return { error: null };
        },
      };
    }

    // 0464 asks one more question before it will let anybody hand out a company
    // hat that follows the company into hotels it has not bought yet: does the
    // ACTOR'S own standing do that? Every fixture in this file was written when
    // a company hat always covered every hotel forever, so answering "yes" here
    // is the faithful translation of what these tests already assume.
    //
    // It is also safe for the property-scope actors in this file: the
    // all-including-future branch is the only thing that reads this, and a
    // property hat never satisfies the broad-entitlement check that guards it.
    if (table === 'organization_memberships') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        not: () => builder,
        limit: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: [{ id: 'membership-covers-future' }],
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'organization_access_grants') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        limit: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return builder;
    }

    throw new Error(`Unexpected table in invitation authorization test: ${table}`);
  }) as unknown as FromFn;
}

function accountsBuilder(): Record<string, unknown> {
  const equals = new Map<string, unknown>();
  let insertValues: Record<string, unknown> | null = null;
  const matches = () => state.accounts.filter((row) => {
    for (const [column, value] of equals) {
      if ((row as unknown as Record<string, unknown>)[column] !== value) return false;
    }
    return true;
  });
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      equals.set(column, value);
      return builder;
    },
    maybeSingle: async () => {
      if (state.accountLookupError && equals.get('data_user_id') === EXISTING_AUTH_ID) {
        return { data: null, error: { message: 'forced account lookup failure' } };
      }
      return { data: matches()[0] ?? null, error: null };
    },
    insert: (values: Record<string, unknown>) => {
      insertValues = values;
      return builder;
    },
    then: (resolve: (value: unknown) => unknown) => {
      if (insertValues) {
        state.accounts.push({
          id: `created-account-${state.accounts.length}`,
          role: insertValues.role as AppRole,
          property_access: insertValues.property_access as string[],
          active: true,
          data_user_id: insertValues.data_user_id as string,
          display_name: insertValues.display_name as string,
          username: insertValues.username as string,
        });
      }
      return resolve({ data: null, error: null });
    },
  };
  return builder;
}

function invitesBuilder(): Record<string, unknown> {
  const equals = new Map<string, unknown>();
  const nullColumns = new Set<string>();
  let insertValues: Record<string, unknown> | null = null;
  let updateValues: Record<string, unknown> | null = null;
  let rangeFrom = 0;
  let rangeTo = Number.MAX_SAFE_INTEGER;

  const matches = () => state.invites.filter((row) => {
    for (const [column, value] of equals) {
      if ((row as unknown as Record<string, unknown>)[column] !== value) return false;
    }
    for (const column of nullColumns) {
      if ((row as unknown as Record<string, unknown>)[column] !== null) return false;
    }
    return true;
  });

  const applyInsert = (): InviteRow | null => {
    if (!insertValues) return null;
    const inserted: InviteRow = {
      id: testInviteId(state.invites.length + 1),
      hotel_id: insertValues.hotel_id as string,
      email: insertValues.email as string,
      role: insertValues.role as string,
      token_hash: insertValues.token_hash as string,
      expires_at: insertValues.expires_at as string,
      accepted_at: null,
      accepted_by: null,
      invited_by: insertValues.invited_by as string,
      created_at: new Date().toISOString(),
      organization_id: (insertValues.organization_id as string | null | undefined) ?? null,
      membership_scope: (insertValues.membership_scope as 'company' | 'property' | null | undefined) ?? null,
      covered_property_ids: (insertValues.covered_property_ids as string[] | null | undefined) ?? null,
      acceptance_claim_token: null,
    };
    state.invites.push(inserted);
    insertValues = null;
    return inserted;
  };

  const applyUpdate = (): InviteRow | null => {
    const row = matches()[0] ?? null;
    if (row && updateValues) Object.assign(row, updateValues);
    return row;
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      equals.set(column, value);
      return builder;
    },
    is: (column: string, value: unknown) => {
      if (value === null) nullColumns.add(column);
      return builder;
    },
    order: () => builder,
    range: (from: number, to: number) => {
      rangeFrom = from;
      rangeTo = to;
      return builder;
    },
    insert: (values: Record<string, unknown>) => {
      insertValues = values;
      return builder;
    },
    update: (values: Record<string, unknown>) => {
      updateValues = values;
      return builder;
    },
    single: async () => {
      const inserted = applyInsert();
      return { data: inserted ? { id: inserted.id } : null, error: null };
    },
    maybeSingle: async () => ({
      data: updateValues ? applyUpdate() : matches()[0] ?? null,
      error: null,
    }),
    then: (resolve: (value: unknown) => unknown) => {
      state.beforeInviteListPage?.();
      state.beforeInviteListPage = null;
      const rows = matches();
      return resolve({
        data: rows.slice(rangeFrom, rangeTo + 1),
        error: null,
        count: rows.length,
      });
    },
  };
  return builder;
}

function staffBuilder(): Record<string, unknown> {
  const equals = new Map<string, unknown>();
  const matches = () => state.staffRows.filter((row) => {
    for (const [column, value] of equals) {
      if ((row as unknown as Record<string, unknown>)[column] !== value) return false;
    }
    return true;
  });
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      equals.set(column, value);
      return builder;
    },
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
  };
  return builder;
}

function capabilityOverridesBuilder(): Record<string, unknown> {
  let propertyId: string | null = null;
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      if (column === 'property_id') propertyId = value as string;
      return builder;
    },
    then: (resolve: (value: unknown) => unknown) => resolve({
      data: state.capabilityOverrides.filter((row) => row.property_id === propertyId),
      error: null,
    }),
  };
  return builder;
}

function managerRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://staxis.test/api/auth/invites', {
    method: 'POST',
    headers: {
      authorization: 'Bearer route-contract-token',
      cookie: `staxis_device=${'a'.repeat(64)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function acceptanceRequest(token: string): NextRequest {
  return new NextRequest('https://staxis.test/api/auth/accept-invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.5',
    },
    body: JSON.stringify({ token, displayName: 'New Teammate', password: 'safe-password-123' }),
  });
}

function revokeRequest(inviteId: string): NextRequest {
  return new NextRequest(`https://staxis.test/api/auth/invites?id=${inviteId}`, {
    method: 'DELETE',
    headers: {
      authorization: 'Bearer route-contract-token',
      cookie: `staxis_device=${'a'.repeat(64)}`,
    },
  });
}

function listRequest(hotelId = HOTEL_A): NextRequest {
  return new NextRequest(
    `https://staxis.test/api/auth/invites?hotelId=${hotelId}`,
    {
      headers: {
        authorization: 'Bearer route-contract-token',
        cookie: `staxis_device=${'a'.repeat(64)}`,
      },
    },
  );
}

async function inviteTokenFrom(response: Response): Promise<string> {
  const wire = await response.json() as { data?: { inviteLink?: string } };
  const link = wire.data?.inviteLink;
  assert.equal(typeof link, 'string');
  return new URL(link!).pathname.split('/').filter(Boolean).at(-1)!;
}

beforeEach(() => {
  process.env.RESEND_API_KEY = '';
  resetState();
  invalidateTwoFactorCache();
  installSupabaseStub();
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.auth.admin.createUser = originalCreateUser;
  supabaseAdmin.auth.admin.deleteUser = originalDeleteUser;
  supabaseAdmin.auth.admin.listUsers = originalListUsers;
  if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResendKey;
  invalidateTwoFactorCache();
});

describe('POST /api/auth/invites hierarchy', () => {
  test('a General Manager cannot invite a peer GM or owner', async () => {
    for (const role of ['general_manager', 'owner']) {
      const response = await createInvite(managerRequest({
        hotelId: HOTEL_A,
        email: `${role}@example.test`,
        role,
      }));
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /only an owner or admin/i);
    }
    assert.equal(state.invites.length, 0);
  });

  test('a General Manager can still invite operational staff', async () => {
    const response = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'frontdesk@example.test',
      role: 'front_desk',
    }));
    assert.equal(response.status, 201);
    assert.equal(state.invites.at(-1)?.role, 'front_desk');
  });

  test('a selected active staff profile is validated and carried by the pending invite', async () => {
    seedStaff({ department: null });
    const response = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'housekeeper@example.test',
      role: 'housekeeping',
      staffId: STAFF_ID,
    }));
    assert.equal(response.status, 201);
    assert.equal(state.invites.at(-1)?.target_staff_id, STAFF_ID);
  });

  test('staff selection rejects malformed, non-operational, and mismatched profiles', async () => {
    const malformed = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'malformed@example.test',
      role: 'front_desk',
      staffId: 'not-a-uuid',
    }));
    assert.equal(malformed.status, 400);

    caller().role = 'owner';
    seedStaff({ department: 'housekeeping' });
    const privilegedRole = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'gm-profile@example.test',
      role: 'general_manager',
      staffId: STAFF_ID,
    }));
    assert.equal(privilegedRole.status, 400);

    const wrongDepartment = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'wrong-department@example.test',
      role: 'front_desk',
      staffId: STAFF_ID,
    }));
    assert.equal(wrongDepartment.status, 400);
    assert.equal(state.invites.length, 0);
  });

  test('an existing active account receives idempotent access without a pending invite', async () => {
    seedStaff();
    seedExistingAccount('Existing.Person@Example.Test');
    const requestBody = {
      hotelId: HOTEL_A,
      email: ' existing.person@example.test ',
      role: 'front_desk',
      staffId: STAFF_ID,
    };
    const response = await createInvite(managerRequest(requestBody));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data?: { accessGranted?: boolean; profileLinked?: boolean; emailSent?: boolean };
    };
    assert.deepEqual(body.data, {
      accessGranted: true,
      profileLinked: true,
      emailSent: false,
    });
    assert.equal(state.invites.length, 0);
    assert.equal(state.grantCalls.length, 1);
    assert.equal(state.grantCalls[0]?.p_target_account_id, EXISTING_ACCOUNT_ID);
    assert.equal(state.grantCalls[0]?.p_email, 'existing.person@example.test');
    assert.equal(state.grantCalls[0]?.p_target_staff_id, STAFF_ID);

    const retry = await createInvite(managerRequest(requestBody));
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json()).data, body.data);
    assert.equal(state.invites.length, 0);
    assert.equal(state.grantCalls.length, 2);
  });

  test('an inactive existing account fails clearly instead of creating an invite', async () => {
    seedExistingAccount('inactive@example.test', { active: false });
    const response = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'inactive@example.test',
      role: 'front_desk',
    }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /inactive.*reactivate/i);
    assert.equal(state.invites.length, 0);
    assert.equal(state.grantCalls.length, 0);
  });

  test('a confirmed orphan Auth identity remains on the pending-invite path', async () => {
    state.authUsers.push({
      id: EXISTING_AUTH_ID,
      email: 'orphan@example.test',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const response = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'orphan@example.test',
      role: 'front_desk',
    }));
    assert.equal(response.status, 201);
    assert.equal(state.invites.at(-1)?.email, 'orphan@example.test');
    assert.equal(state.grantCalls.length, 0);
  });

  test('a recent Auth-only identity stays protected as an in-flight signup', async () => {
    state.authUsers.push({
      id: EXISTING_AUTH_ID,
      email: 'recent-signup@example.test',
      createdAt: new Date().toISOString(),
    });
    const response = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'recent-signup@example.test',
      role: 'front_desk',
    }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /just created.*finish or recover/i);
    assert.equal(state.invites.length, 0);
    assert.equal(state.grantCalls.length, 0);
  });

  test('a property-owner Auth identity without an account stays protected', async () => {
    state.authUsers.push({
      id: EXISTING_AUTH_ID,
      email: 'owner-identity@example.test',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    state.propertyOwnerAuthUserIds.push(EXISTING_AUTH_ID);
    const response = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'owner-identity@example.test',
      role: 'front_desk',
    }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /owner.*restore/i);
    assert.equal(state.invites.length, 0);
    assert.equal(state.grantCalls.length, 0);
  });

  test('Auth and account lookup failures fail closed without creating or granting access', async () => {
    state.authLookupError = true;
    const authFailure = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'lookup-failure@example.test',
      role: 'front_desk',
    }));
    assert.equal(authFailure.status, 503);

    state.authLookupError = false;
    state.accountLookupError = true;
    state.authUsers.push({
      id: EXISTING_AUTH_ID,
      email: 'account-lookup-failure@example.test',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const accountFailure = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'account-lookup-failure@example.test',
      role: 'front_desk',
    }));
    assert.equal(accountFailure.status, 503);
    assert.equal(state.invites.length, 0);
    assert.equal(state.grantCalls.length, 0);
  });

  test('a staff-linked multi-property invite covers and anchors on the current hotel', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    state.authorityMode = 'normalized';
    state.companyPropertyIds = [HOTEL_A, HOTEL_B];
    state.normalizedStandings = [HOTEL_A, HOTEL_B].map((propertyId) => ({
      propertyId,
      operationalRole: 'owner' as AppRole,
      hotelMutationAllowed: true,
      accessProfile: 'organization_owner' as const,
      scopeType: 'organization' as const,
    }));
    seedStaff({
      property_id: HOTEL_B,
      department: 'housekeeping',
    });

    const excluded = await createInvite(managerRequest({
      hotelId: HOTEL_B,
      email: 'excluded-hotel@example.test',
      role: 'housekeeping',
      scope: 'property',
      propertyIds: [HOTEL_A],
      staffId: STAFF_ID,
    }));
    assert.equal(excluded.status, 400);

    const included = await createInvite(managerRequest({
      hotelId: HOTEL_B,
      email: 'included-hotel@example.test',
      role: 'housekeeping',
      scope: 'property',
      propertyIds: [HOTEL_A, HOTEL_B],
      staffId: STAFF_ID,
    }));
    assert.equal(included.status, 201);
    assert.equal(state.invites.at(-1)?.hotel_id, HOTEL_B);
    assert.deepEqual(state.invites.at(-1)?.covered_property_ids, [HOTEL_A, HOTEL_B]);
    assert.equal(state.invites.at(-1)?.target_staff_id, STAFF_ID);
  });

  test('an owner and admin can create privileged invitations', async () => {
    caller().role = 'owner';
    const ownerResponse = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'gm-by-owner@example.test',
      role: 'general_manager',
    }));
    assert.equal(ownerResponse.status, 201);

    caller().role = 'admin';
    caller().property_access = ['*'];
    const adminResponse = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'owner-by-admin@example.test',
      role: 'owner',
    }));
    assert.equal(adminResponse.status, 201);
    assert.deepEqual(state.invites.map((invite) => invite.role), ['general_manager', 'owner']);
  });

  test('final guarded create refuses revocation in the application-check gap', async () => {
    caller().role = 'owner';
    state.beforeGuardedCreate = () => { caller().active = false; };
    const response = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'raced@example.test',
      role: 'front_desk',
    }));
    assert.equal(response.status, 403);
    assert.equal(state.invites.length, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('property invites anchor inside the exact promise and survive an unrelated hotel transfer', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    state.authorityMode = 'normalized';
    state.companyPropertyIds = [HOTEL_A, HOTEL_B];
    state.normalizedStandings = [{
      propertyId: HOTEL_A,
      operationalRole: 'owner',
      hotelMutationAllowed: true,
      accessProfile: 'organization_owner',
      scopeType: 'organization',
    }, {
      propertyId: HOTEL_B,
      operationalRole: 'general_manager',
      hotelMutationAllowed: true,
      accessProfile: 'property_manager',
      scopeType: 'property',
    }];

    const createExactInvite = (email: string) => createInvite(managerRequest({
      hotelId: HOTEL_B,
      email,
      role: 'front_desk',
      scope: 'property',
      propertyIds: [HOTEL_A],
    }));
    const acceptedCandidate = await createExactInvite('anchor-accept@example.test');
    const revokedCandidate = await createExactInvite('anchor-revoke@example.test');
    assert.equal(acceptedCandidate.status, 201);
    assert.equal(revokedCandidate.status, 201);
    assert.deepEqual(state.invites.map((invite) => ({
      hotelId: invite.hotel_id,
      coveredPropertyIds: invite.covered_property_ids,
    })), [{
      hotelId: HOTEL_A,
      coveredPropertyIds: [HOTEL_A],
    }, {
      hotelId: HOTEL_A,
      coveredPropertyIds: [HOTEL_A],
    }]);

    // The People screen happened to be open at Hotel B, but Hotel B was never
    // part of either invitation promise. Its later transfer must not strand or
    // invalidate Hotel A's exact invitation lifecycle.
    state.companyPropertyIds = [HOTEL_A];
    state.normalizedStandings = state.normalizedStandings.filter(
      (standing) => standing.propertyId === HOTEL_A,
    );

    const token = await inviteTokenFrom(acceptedCandidate);
    const accepted = await acceptInvite(acceptanceRequest(token));
    assert.equal(accepted.status, 200);
    assert.ok(state.invites[0]?.accepted_at);

    const revokedInviteId = state.invites[1]!.id;
    const revoked = await revokeInvite(revokeRequest(revokedInviteId));
    assert.equal(revoked.status, 200);
    assert.equal(state.invites.some((invite) => invite.id === revokedInviteId), false);
  });
});

describe('DELETE /api/auth/invites uses the guarded anti-enumerating boundary', () => {
  test('revocation after the route starts leaves the invite and returns not found', async () => {
    caller().role = 'owner';
    seedInvite('front_desk');
    state.beforeGuardedRevoke = () => { caller().active = false; };
    const response = await revokeInvite(revokeRequest(state.invites[0]!.id));
    assert.equal(response.status, 404);
    assert.equal(state.invites.length, 1);
    assert.equal(state.auditRows.length, 0);
  });

  test('missing and unauthorized accepted invite ids have the same public status', async () => {
    caller().role = 'owner';
    seedInvite('front_desk');
    state.invites[0]!.accepted_at = new Date().toISOString();
    caller().property_access = [];
    const acceptedProbe = await revokeInvite(revokeRequest(state.invites[0]!.id));
    const missingProbe = await revokeInvite(revokeRequest(
      '99999999-9999-4999-8999-999999999999',
    ));
    assert.equal(acceptedProbe.status, 404);
    assert.equal(missingProbe.status, 404);
  });
});

describe('GET /api/auth/invites reasserts authority before egress', () => {
  test('projects exact local roles and never defaults a General Manager to a peer-GM invite', async () => {
    const response = await listInvites(listRequest());
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data?: {
        options?: {
          organizationId: string | null;
          jobs: Array<{ value: string; allowedPropertyIds: string[] }>;
        };
      };
    };
    assert.equal(body.data?.options?.organizationId, null);
    assert.deepEqual(body.data?.options?.jobs.map((job) => job.value), [
      'front_desk', 'housekeeping', 'maintenance',
    ]);
    assert.deepEqual(body.data?.options?.jobs[0]?.allowedPropertyIds, [HOTEL_A]);
  });

  test('withholds local invite data when manage_team is revoked during the paged read', async () => {
    caller().role = 'owner';
    seedInvite('front_desk');
    state.beforeInviteListPage = () => {
      state.capabilityOverrides.push({
        property_id: HOTEL_A,
        capability: 'manage_team',
        role: 'owner',
        allowed: false,
      });
    };

    const response = await listInvites(listRequest());
    assert.equal(response.status, 403);
    const body = await response.json() as { data?: unknown };
    assert.equal(body.data, undefined);
  });

  test('an acquired hotel hides and refuses its stale legacy invites', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    const acceptanceToken = seedInvite('front_desk', 'legacy-before-acquisition-accept');
    seedInvite('housekeeping', 'legacy-before-acquisition-revoke');
    const staleEmails = state.invites.map((invite) => invite.email);

    state.authorityMode = 'normalized';
    state.companyPropertyIds = [HOTEL_A];
    state.normalizedStandings = [{
      propertyId: HOTEL_A,
      operationalRole: 'owner',
      hotelMutationAllowed: true,
      accessProfile: 'organization_owner',
      scopeType: 'organization',
    }];

    const listed = await listInvites(listRequest());
    assert.equal(listed.status, 200);
    const listBody = await listed.json() as {
      data?: {
        invites?: unknown[];
        options?: { organizationId?: string | null };
      };
    };
    assert.deepEqual(listBody.data?.invites, []);
    assert.equal(listBody.data?.options?.organizationId, ORGANIZATION_A);
    for (const staleEmail of staleEmails) {
      assert.doesNotMatch(JSON.stringify(listBody), new RegExp(staleEmail, 'i'));
    }

    const accepted = await acceptInvite(acceptanceRequest(acceptanceToken));
    assert.equal(accepted.status, 410);
    assert.equal(state.createdAuthUsers.length, 0);
    assert.equal(state.invites[0]?.accepted_at, null);

    const staleRevokeId = state.invites[1]!.id;
    const revoked = await revokeInvite(revokeRequest(staleRevokeId));
    assert.equal(revoked.status, 404);
    assert.equal(state.invites.some((invite) => invite.id === staleRevokeId), true);
  });

  test('returns all 1,205 pending invites across exact bounded pages', async () => {
    caller().role = 'owner';
    for (let index = 0; index < 1_205; index += 1) {
      seedInvite('front_desk', `bulk-pending-${index}`);
      state.invites[index]!.email = `pending-${index}@example.test`;
    }
    const response = await listInvites(listRequest());
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data?: { invites?: Array<{ id: string; email: string }> };
    };
    assert.equal(body.data?.invites?.length, 1_205);
    assert.equal(new Set(body.data?.invites?.map((invite) => invite.id)).size, 1_205);
  });

  test('withholds invitation emails when normalized scope is revoked during paging', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    normalizeAuthorityAtHotel('general_manager');
    seedInvite('front_desk');
    Object.assign(state.invites[0]!, {
      organization_id: ORGANIZATION_A,
      membership_scope: 'property' as const,
      covered_property_ids: [HOTEL_A],
    });
    state.beforeInviteListPage = () => { state.normalizedStandings = []; };
    const response = await listInvites(listRequest());
    assert.equal(response.status, 403);
    const body = await response.json() as { data?: unknown; error?: string };
    assert.equal(body.data, undefined);
  });

  test('hides a poisoned normalized invite whose authority anchor is outside its promise', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    state.authorityMode = 'normalized';
    state.companyPropertyIds = [HOTEL_A, HOTEL_B];
    state.normalizedStandings = [HOTEL_A, HOTEL_B].map((propertyId) => ({
      propertyId,
      operationalRole: 'general_manager' as const,
      hotelMutationAllowed: true,
    }));
    seedInvite('front_desk');
    Object.assign(state.invites[0]!, {
      organization_id: ORGANIZATION_A,
      membership_scope: 'property' as const,
      covered_property_ids: [HOTEL_B],
    });

    for (const selectedHotelId of [HOTEL_A, HOTEL_B]) {
      const response = await listInvites(listRequest(selectedHotelId));
      assert.equal(response.status, 200);
      const body = await response.json() as { data?: { invites?: unknown[] } };
      assert.deepEqual(body.data?.invites, []);
      assert.doesNotMatch(JSON.stringify(body), /front_desk@example\.test/i);
    }
  });

  test('shows only the selected-hotel intersection and denies partial-promise revoke', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    state.authorityMode = 'normalized';
    state.companyPropertyIds = [HOTEL_A, HOTEL_B];
    state.normalizedStandings = [{
      propertyId: HOTEL_B,
      operationalRole: 'general_manager',
      hotelMutationAllowed: true,
    }];
    seedInvite('front_desk');
    Object.assign(state.invites[0]!, {
      organization_id: ORGANIZATION_A,
      membership_scope: 'property' as const,
      covered_property_ids: [HOTEL_A, HOTEL_B],
    });

    const response = await listInvites(listRequest(HOTEL_B));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data?: { invites?: Array<Record<string, unknown>> };
    };
    assert.equal(body.data?.invites?.length, 1);
    assert.deepEqual(body.data?.invites?.[0]?.propertyIds, [HOTEL_B]);
    assert.deepEqual(body.data?.invites?.[0]?.propertyNames, ['Hotel B']);
    assert.equal(body.data?.invites?.[0]?.canRevoke, false);
    assert.equal('hiddenPropertyCount' in (body.data?.invites?.[0] ?? {}), false);
    assert.equal('coverageRedacted' in (body.data?.invites?.[0] ?? {}), false);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(HOTEL_A, 'i'));
  });

  test('keeps same-email hats distinct and company invitations follow newly acquired hotels', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    state.authorityMode = 'normalized';
    state.companyPropertyIds = [HOTEL_A, HOTEL_B];
    state.normalizedStandings = [HOTEL_A, HOTEL_B].map((propertyId) => ({
      propertyId,
      operationalRole: 'owner' as const,
      hotelMutationAllowed: true,
      accessProfile: 'organization_owner' as const,
      scopeType: 'organization' as const,
    }));
    seedInvite('general_manager');
    Object.assign(state.invites[0]!, {
      email: 'multi-hat@example.test',
      hotel_id: HOTEL_B,
      organization_id: ORGANIZATION_A,
      membership_scope: 'property' as const,
      covered_property_ids: [HOTEL_B],
      created_at: '2026-07-28T00:00:00.000Z',
    });
    seedInvite('regional_manager');
    Object.assign(state.invites[1]!, {
      email: 'multi-hat@example.test',
      organization_id: ORGANIZATION_A,
      membership_scope: 'company' as const,
      covered_property_ids: null,
      created_at: '2026-07-28T00:01:00.000Z',
    });

    const response = await listInvites(listRequest(HOTEL_B));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data?: { invites?: Array<{
        id: string;
        email: string;
        role: string;
        scope: string;
        propertyIds: string[];
        canRevoke: boolean;
      }> };
    };
    assert.equal(body.data?.invites?.length, 2);
    assert.equal(new Set(body.data?.invites?.map((invite) => invite.id)).size, 2);
    assert.deepEqual(body.data?.invites?.map((invite) => ({
      email: invite.email,
      role: invite.role,
      scope: invite.scope,
      propertyIds: invite.propertyIds,
      canRevoke: invite.canRevoke,
    })), [
      {
        email: 'multi-hat@example.test',
        role: 'regional_manager',
        scope: 'company',
        propertyIds: [HOTEL_A, HOTEL_B],
        canRevoke: true,
      },
      {
        email: 'multi-hat@example.test',
        role: 'general_manager',
        scope: 'property',
        propertyIds: [HOTEL_B],
        canRevoke: true,
      },
    ]);
  });

  test('returns role-specific hotel choices instead of a cross-role union', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    state.authorityMode = 'normalized';
    state.companyPropertyIds = [HOTEL_A, HOTEL_B];
    state.normalizedStandings = [{
      propertyId: HOTEL_A,
      operationalRole: 'owner',
      hotelMutationAllowed: true,
      accessProfile: 'organization_owner',
      scopeType: 'organization',
    }, {
      propertyId: HOTEL_B,
      operationalRole: 'general_manager',
      hotelMutationAllowed: true,
      accessProfile: 'property_manager',
      scopeType: 'property',
    }];

    const response = await listInvites(listRequest(HOTEL_B));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data?: { options?: { jobs: Array<{ value: string; allowedPropertyIds: string[] }> } };
    };
    const jobs = new Map(body.data?.options?.jobs.map((job) => [job.value, job.allowedPropertyIds]));
    assert.deepEqual(jobs.get('general_manager'), [HOTEL_A]);
    assert.deepEqual(jobs.get('front_desk'), [HOTEL_A, HOTEL_B]);
  });
});

describe('POST /api/auth/accept-invite revalidates current authority', () => {
  test('rejects malformed public input before hashing or creating Auth state', async () => {
    const response = await acceptInvite(new NextRequest(
      'https://staxis.test/api/auth/accept-invite',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' },
        body: JSON.stringify({ token: { attacker: true }, displayName: 7, password: ['not-a-string'] }),
      },
    ));
    assert.equal(response.status, 400);
    assert.equal(state.createdAuthUsers.length, 0);
    assert.equal(state.accounts.length, 1);
  });

  test('a neutral normalized property manager can invite and the recipient can accept', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    normalizeAuthorityAtHotel('general_manager');

    const created = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'normalized-staff@example.test',
      role: 'front_desk',
    }));
    assert.equal(created.status, 201);
    const token = await inviteTokenFrom(created);

    const accepted = await acceptInvite(acceptanceRequest(token));
    assert.equal(accepted.status, 200);
    assert.equal(state.createdAuthUsers.length, 1);
    assert.equal(state.accounts.at(-1)?.role, 'front_desk');
    assert.ok(state.invites[0]?.accepted_at);
  });

  test('revoking normalized hotel authority after issue invalidates acceptance', async () => {
    caller().role = 'front_desk';
    caller().property_access = [];
    normalizeAuthorityAtHotel('general_manager');

    const created = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'revoked-before-accept@example.test',
      role: 'housekeeping',
    }));
    assert.equal(created.status, 201);
    const token = await inviteTokenFrom(created);

    state.normalizedStandings = [];
    const accepted = await acceptInvite(acceptanceRequest(token));
    assert.equal(accepted.status, 410);
    assert.equal(state.createdAuthUsers.length, 0);
    assert.equal(state.invites[0]?.accepted_at, null);
  });

  test('rejects an invite from a deactivated inviter before creating an auth user', async () => {
    caller().role = 'owner';
    caller().active = false;
    const response = await acceptInvite(acceptanceRequest(seedInvite('general_manager')));
    assert.equal(response.status, 410);
    assert.equal(state.createdAuthUsers.length, 0);
    assert.equal(state.invites[0]?.accepted_at, null);
  });

  test('rejects an invite after manage_team is revoked for the inviter at that hotel', async () => {
    caller().role = 'owner';
    state.capabilityOverrides.push({
      property_id: HOTEL_A,
      capability: 'manage_team',
      role: 'owner',
      allowed: false,
    });
    const response = await acceptInvite(acceptanceRequest(seedInvite('front_desk')));
    assert.equal(response.status, 410);
    assert.equal(state.createdAuthUsers.length, 0);
    assert.equal(state.invites[0]?.accepted_at, null);
  });

  test('requires the exact hotel in a non-admin inviter scope', async () => {
    caller().role = 'owner';
    caller().property_access = ['*', HOTEL_B];
    const response = await acceptInvite(acceptanceRequest(seedInvite('front_desk')));
    assert.equal(response.status, 410);
    assert.equal(state.createdAuthUsers.length, 0);
  });

  test('rejects stale GM invitations that grant GM or owner', async () => {
    caller().role = 'general_manager';
    for (const role of ['general_manager', 'owner']) {
      state.invites = [];
      state.createdAuthUsers = [];
      const response = await acceptInvite(acceptanceRequest(seedInvite(role, `stale-${role}`)));
      assert.equal(response.status, 410);
      assert.equal(state.createdAuthUsers.length, 0);
      assert.equal(state.invites[0]?.accepted_at, null);
    }
  });

  test('accepts a GM invitation from an active owner with current hotel authority', async () => {
    caller().role = 'owner';
    const response = await acceptInvite(acceptanceRequest(seedInvite('general_manager')));
    assert.equal(response.status, 200);
    assert.equal(state.createdAuthUsers.length, 1);
    assert.equal(state.accounts.at(-1)?.role, 'general_manager');
    assert.ok(state.invites[0]?.accepted_at);
  });

  test('accepts an owner invitation from an active platform admin', async () => {
    caller().role = 'admin';
    caller().property_access = [];
    const response = await acceptInvite(acceptanceRequest(seedInvite('owner')));
    assert.equal(response.status, 200);
    assert.equal(state.createdAuthUsers.length, 1);
    assert.equal(state.accounts.at(-1)?.role, 'owner');
    assert.ok(state.invites[0]?.accepted_at);
  });

  test('a company regional-manager invite never translates into a hotel General Manager role', async () => {
    caller().role = 'admin';
    caller().property_access = [];
    normalizeAuthorityAtHotel('general_manager');
    const token = seedInvite('regional_manager', 'company-regional-manager-role');
    Object.assign(state.invites[0]!, {
      organization_id: ORGANIZATION_A,
      membership_scope: 'company' as const,
      covered_property_ids: null,
    });
    const response = await acceptInvite(acceptanceRequest(token));
    assert.equal(response.status, 200);
    assert.equal(state.accounts.at(-1)?.role, 'front_desk');
    assert.deepEqual(state.accounts.at(-1)?.property_access, []);
    assert.notEqual(state.accounts.at(-1)?.role, 'general_manager');
  });

  test('rolls back Auth and releases the exact reservation when entitlement finalization fails', async () => {
    caller().role = 'owner';
    state.finalizeErrorCode = '23514';
    const response = await acceptInvite(acceptanceRequest(seedInvite('front_desk', 'hat-write-fails')));

    assert.equal(response.status, 410);
    assert.equal(state.createdAuthUsers.length, 0, 'the external Auth identity was deleted');
    assert.equal(state.accounts.length, 1, 'no database account escaped the failed transaction');
    assert.equal(state.invites[0]?.accepted_at, null);
    assert.equal(state.invites[0]?.acceptance_claim_token, null, 'a legitimate retry can reserve again');
  });

  test('maps final authority lock contention to retryable 503 after cleanup', async () => {
    caller().role = 'owner';
    state.finalizeErrorCode = '55P03';
    const response = await acceptInvite(acceptanceRequest(seedInvite(
      'front_desk', 'authority-lock-contention',
    )));
    assert.equal(response.status, 503);
    assert.equal(state.createdAuthUsers.length, 0);
    assert.equal(state.accounts.length, 1);
    assert.equal(state.invites[0]?.accepted_at, null);
    assert.equal(state.invites[0]?.acceptance_claim_token, null);
  });

  test('withholds success when the inviter is revoked at the final commit boundary', async () => {
    caller().role = 'owner';
    state.beforeFinalize = () => { caller().active = false; };
    const response = await acceptInvite(acceptanceRequest(seedInvite('housekeeping', 'commit-revoke')));

    assert.equal(response.status, 410);
    assert.equal(state.createdAuthUsers.length, 0);
    assert.equal(state.accounts.length, 1);
    assert.equal(state.invites[0]?.accepted_at, null);
    assert.equal(state.invites[0]?.acceptance_claim_token, null);
  });

  test('recovers a committed acceptance when the final RPC response is lost', async () => {
    caller().role = 'owner';
    state.finalizeLostResponse = true;
    const response = await acceptInvite(acceptanceRequest(seedInvite('maintenance', 'lost-final-response')));

    assert.equal(response.status, 200);
    assert.equal(state.createdAuthUsers.length, 1, 'a committed account login must not be deleted');
    assert.equal(state.accounts.length, 2);
    assert.ok(state.invites[0]?.accepted_at);
    assert.equal(state.invites[0]?.accepted_by, state.accounts[1]?.id);
    assert.equal(state.invites[0]?.acceptance_claim_token, null);
  });
});
