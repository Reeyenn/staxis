import type { AppRole } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { CapabilityKey } from '@/lib/capabilities/registry';
import type { EnabledSections } from '@/lib/sections/registry';

/**
 * Test-only authoritative store adapter for executeTool suites.
 *
 * The production dispatcher always re-loads the active account and calls the
 * authoritative property resolver. Older unit suites already replace the
 * Supabase singleton for their handler data; this wrapper intercepts only the
 * account/authority reads, then delegates every other table and RPC to the
 * suite's existing fake. There is intentionally no production bypass.
 */
export interface AgentToolAuthorityTestProfile {
  accountId: string;
  authUserId: string;
  role: AppRole;
  propertyIds: string[];
  hotelMutationAllowed?: boolean;
  seesFinancials?: boolean;
  portfolioIntelligenceRead?: boolean;
  active?: boolean;
  displayName?: string;
  enabledSections?: EnabledSections;
  sectionOutage?: boolean;
  capabilityOverrides?: Array<{
    capability: CapabilityKey;
    role: AppRole;
    allowed: boolean;
  }>;
  capabilityOutage?: boolean;
}

const ROLE_NUMBER: Record<AppRole, number> = {
  admin: 1,
  owner: 2,
  general_manager: 3,
  front_desk: 4,
  housekeeping: 5,
  maintenance: 6,
  staff: 7,
};

/** Stable valid UUID pair for synthetic role-specific contexts. */
export function agentToolAuthorityIdentity(role: AppRole): {
  accountId: string;
  authUserId: string;
} {
  const suffix = String(ROLE_NUMBER[role]).padStart(12, '0');
  return {
    accountId: `f0000000-0000-4000-8000-${suffix}`,
    authUserId: `f1000000-0000-4000-8000-${suffix}`,
  };
}

function emptyListChain() {
  const api: Record<string, unknown> = {
    select: () => api,
    eq: () => api,
    is: () => api,
    in: () => api,
    then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => (
      Promise.resolve({ data: [], error: null }).then(resolve, reject)
    ),
  };
  return api;
}

function accessDto(profile: AgentToolAuthorityTestProfile) {
  if (profile.role === 'admin') {
    return {
      ok: true,
      all: true,
      authorityMode: 'legacy',
      authorityVersion: 1,
      effectiveAccessHash: 'a'.repeat(64),
      propertyIds: [],
      legacyPropertyIds: [],
      membershipPropertyIds: [],
      propertyStandings: [],
    };
  }
  const propertyIds = [...new Set(profile.propertyIds)].sort();
  return {
    ok: true,
    all: false,
    authorityMode: 'legacy',
    authorityVersion: 1,
    effectiveAccessHash: 'a'.repeat(64),
    propertyIds,
    legacyPropertyIds: propertyIds,
    membershipPropertyIds: [],
    propertyStandings: propertyIds.map((propertyId) => ({
      propertyId,
      operationalRole: profile.role,
      seesFinancials: profile.seesFinancials
        ?? (profile.role === 'owner' || profile.role === 'general_manager'),
      hotelMutationAllowed: profile.hotelMutationAllowed ?? true,
      portfolioIntelligenceRead: profile.portfolioIntelligenceRead ?? false,
      entitlements: [{
        kind: 'legacy',
        entitlementId: profile.accountId,
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

export function installAgentToolAuthorityTestStore(
  getProfiles: () => readonly AgentToolAuthorityTestProfile[],
): () => void {
  const delegateFrom = supabaseAdmin.from.bind(supabaseAdmin);
  const delegateRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

  // @ts-expect-error deliberately wrapping the singleton for a test
  supabaseAdmin.from = (table: string) => {
    if (table === 'accounts') {
      const rows = getProfiles().map((profile) => ({
        id: profile.accountId,
        data_user_id: profile.authUserId,
        role: profile.role,
        display_name: profile.displayName ?? 'Tool Test User',
        staff_id: null,
        active: profile.active ?? true,
      }));
      const filters = new Map<string, unknown>();
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (column: string, value: unknown) => {
          filters.set(column, value);
          return api;
        },
        maybeSingle: async () => {
          const matches = rows.filter((row) => [...filters].every(([column, value]) => (
            row[column as keyof typeof row] === value
          )));
          return matches.length === 1
            ? { data: matches[0], error: null }
            : { data: null, error: matches.length > 1 ? { message: 'multiple accounts' } : null };
        },
      };
      return api;
    }
    if (table === 'properties') {
      const filters = new Map<string, unknown>();
      const api: Record<string, unknown> = {
        select: (columns: string) => {
          if (columns === 'enabled_sections') return api;
          const delegate = delegateFrom(table) as unknown as {
            select: (value: string) => unknown;
          };
          return delegate.select(columns);
        },
        eq: (column: string, value: unknown) => {
          filters.set(column, value);
          return api;
        },
        maybeSingle: async () => {
          const propertyId = filters.get('id');
          const profile = getProfiles().find((candidate) => (
            typeof propertyId === 'string' && candidate.propertyIds.includes(propertyId)
          ));
          if (profile?.sectionOutage) {
            return { data: null, error: { message: 'section store unavailable' } };
          }
          return profile
            ? { data: { enabled_sections: profile.enabledSections ?? null }, error: null }
            : { data: null, error: null };
        },
      };
      return api;
    }
    // loadSessionAccount's presentation-hat lookup is not part of tool
    // authorization. Keep it deterministic and invisible to handler DB audits.
    if (table === 'organization_memberships') {
      return emptyListChain();
    }
    if (table === 'capability_overrides') {
      const profiles = getProfiles();
      const rows = profiles.flatMap((profile) => profile.capabilityOverrides ?? []);
      const outage = profiles.some((profile) => profile.capabilityOutage);
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => (
          Promise.resolve({
            data: outage ? null : rows,
            error: outage ? { message: 'capability store unavailable' } : null,
          }).then(resolve, reject)
        ),
      };
      return api;
    }
    return delegateFrom(table);
  };

  // @ts-expect-error deliberately wrapping the singleton for a test
  supabaseAdmin.rpc = async (name: string, args?: Record<string, unknown>) => {
    if (name === 'staxis_list_account_authorized_properties') {
      const profile = getProfiles().find((candidate) => (
        candidate.accountId === args?.p_account_id
      ));
      return profile && (profile.active ?? true)
        ? { data: accessDto(profile), error: null }
        : { data: { ok: false, reason: 'no_active_account' }, error: null };
    }
    return delegateRpc(name, args);
  };

  return () => {
    supabaseAdmin.from = delegateFrom;
    supabaseAdmin.rpc = delegateRpc;
  };
}
