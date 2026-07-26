import 'server-only';

// ─── Role resolution for the company spine ─────────────────────────────────
//
// THE ONE INTERFACE later company work plugs into:
//
//   effectiveRole(accountId, propertyId)  -> what job does this person hold AT
//                                            THIS HOTEL, and where did that
//                                            answer come from
//   accessibleProperties(accountId)       -> every hotel this person may reach
//   loadHats(accountId)                   -> the raw hats, for showing a
//                                            person's card ("GM — Beaumont ·
//                                            Oversees — Lufkin, Tyler, Waco")
//
// ZERO REGRESSION CONTRACT. An account with no hats resolves EXACTLY as it does
// today: `effectiveRole` returns `accounts.role` with `source: 'legacy'`, and
// `accessibleProperties` returns `accounts.property_access` verbatim. Every one
// of the ~5,100 existing tests describes that account, and none of them may
// move. A hat is only ever additive: it can grant a hotel the legacy array
// never mentioned, and it can name a different job at a hotel the legacy array
// did mention — it can never take a hotel away.
//
// WALL A (inside one company) is the coverage computation below: a
// property-scope hat sees exactly the hotels on its own row, so a front-desk
// person at hotel #7 never learns hotel #12 exists.
//
// WALL B (across companies) is structural: coverage for a hat is only ever
// drawn from `organization_property_relationships` rows belonging to THAT hat's
// own organization. There is no query in this file that can reach a second
// company's hotels, whatever the caller passes.

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import {
  hatSeesFinancials,
  isHatRole,
  isMembershipScope,
  legacyRoleForHat,
  type HatRole,
  type MembershipScope,
} from '@/lib/company/roles';

/** One job, worn over one scope. A row of `organization_memberships`. */
export interface MembershipHat {
  membershipId: string;
  organizationId: string;
  accountId: string;
  scope: MembershipScope;
  role: HatRole;
  jobTitle: string | null;
  /**
   * The hotels this hat actually reaches, resolved. For a company hat this is
   * every hotel the company operates RIGHT NOW — a hotel added to the company
   * after the hat was created is already in here, with nothing re-stamped.
   */
  coveredPropertyIds: string[];
}

export type RoleSource = 'membership' | 'legacy' | 'none';

export interface EffectiveRole {
  /**
   * Always a legacy `accounts.role` word, so this drops straight into
   * `can()`, `canManageTeam()`, `canForProperty()` and every other existing
   * check with no translation. Company-only jobs degrade least-privilege
   * (see `legacyRoleForHat`).
   */
  role: AppRole | null;
  /** The true job when a hat answered. `null` when the legacy role answered. */
  hatRole: HatRole | null;
  scope: MembershipScope | null;
  organizationId: string | null;
  source: RoleSource;
  /** Does any hat covering this hotel open the money? */
  seesFinancials: boolean;
}

export interface AccessibleProperties {
  /** True for Staxis administrators and legacy `'*'` holders — everything. */
  all: boolean;
  /** Sorted, de-duplicated. Empty when `all` is true. */
  propertyIds: string[];
  /** The subset that came from `accounts.property_access`. */
  legacyPropertyIds: string[];
  /** The subset that came from a hat. */
  membershipPropertyIds: string[];
}

interface AccountRow {
  id: string;
  role: string | null;
  property_access: unknown;
  active: boolean | null;
}

interface HatRow {
  id: string;
  organization_id: string;
  account_id: string;
  membership_scope: string | null;
  staxis_role: string | null;
  job_title: string | null;
  covered_property_ids: unknown;
  status: string | null;
  starts_at: string | null;
  ended_at: string | null;
}

const NO_ACCESS: AccessibleProperties = {
  all: false,
  propertyIds: [],
  legacyPropertyIds: [],
  membershipPropertyIds: [],
};

/**
 * Two hats can cover one hotel and only one of them can name the job.
 *
 * Note `general_manager` sits ABOVE `vp` on purpose. Maria is the GM of
 * Beaumont AND oversees Lufkin and Tyler; at Beaumont she is the GM — the
 * person who runs it — and oversight is what she does at the OTHER hotels.
 * Ranking VP higher would rename her at her own hotel.
 *
 * `seesFinancials` is computed across ALL covering hats rather than from the
 * winner, so a narrower winner can never close a door a wider hat opened.
 */
const HAT_STRENGTH: Record<HatRole, number> = {
  owner: 6,
  general_manager: 5,
  vp: 4,
  finance: 3,
  front_desk: 2,
  maintenance: 1,
  housekeeping: 0,
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

async function loadAccount(accountId: string): Promise<AccountRow | null> {
  try {
    return await readAccount(accountId);
  } catch {
    return null;
  }
}

async function readAccount(accountId: string): Promise<AccountRow | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access, active')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as AccountRow;
  return row.active === false ? null : row;
}

/**
 * Every hat this person is currently wearing, with coverage resolved.
 *
 * Deliberately three small reads rather than one PostgREST embed: the
 * organization filter has to be applied to the RELATIONSHIP read, and an embed
 * would make the "which company does this hotel belong to" join implicit and
 * therefore easy to get wrong later. Wall B is worth the extra round trip.
 */
export async function loadHats(accountId: string): Promise<MembershipHat[]> {
  if (!accountId) return [];
  try {
    return await readHats(accountId);
  } catch {
    // A store that cannot answer "does this person have a company job" answers
    // NO. Every gate that calls this has already given the legacy array its
    // chance, so this can only ever withhold access, never grant it.
    return [];
  }
}

async function readHats(accountId: string): Promise<MembershipHat[]> {
  const { data: hatData, error: hatError } = await supabaseAdmin
    .from('organization_memberships')
    .select(
      'id, organization_id, account_id, membership_scope, staxis_role, job_title, covered_property_ids, status, starts_at, ended_at',
    )
    .eq('account_id', accountId)
    .is('ended_at', null);
  if (hatError || !Array.isArray(hatData)) return [];

  const nowMs = Date.now();
  const rows = (hatData as HatRow[]).filter((row) => (
    isHatRole(row.staxis_role)
      && isMembershipScope(row.membership_scope)
      && row.status === 'active'
      && (!row.starts_at || new Date(row.starts_at).getTime() <= nowMs)
  ));
  if (rows.length === 0) return [];

  const organizationIds = [...new Set(rows.map((row) => row.organization_id))];

  const { data: orgData, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id, status, organization_type')
    .in('id', organizationIds);
  if (orgError || !Array.isArray(orgData)) return [];
  const liveOrganizationIds = new Set(
    (orgData as Array<{ id: string; status: string | null; organization_type: string | null }>)
      .filter((row) => row.status === 'active' && row.organization_type !== 'single_hotel')
      .map((row) => row.id),
  );
  if (liveOrganizationIds.size === 0) return [];

  const { data: relData, error: relError } = await supabaseAdmin
    .from('organization_property_relationships')
    .select('organization_id, property_id, starts_at, ends_at')
    .in('organization_id', [...liveOrganizationIds]);
  if (relError || !Array.isArray(relData)) return [];

  // organization -> the hotels it operates right now. THE ONLY source of
  // coverage in this file, and it is always keyed by the hat's own company.
  const operatedByOrganization = new Map<string, Set<string>>();
  for (const row of relData as Array<{
    organization_id: string; property_id: string; starts_at: string | null; ends_at: string | null;
  }>) {
    const startsMs = row.starts_at ? new Date(row.starts_at).getTime() : 0;
    const endsMs = row.ends_at ? new Date(row.ends_at).getTime() : null;
    if (startsMs > nowMs) continue;
    if (endsMs !== null && endsMs <= nowMs) continue;
    const bucket = operatedByOrganization.get(row.organization_id) ?? new Set<string>();
    bucket.add(row.property_id);
    operatedByOrganization.set(row.organization_id, bucket);
  }

  const hats: MembershipHat[] = [];
  for (const row of rows) {
    if (!liveOrganizationIds.has(row.organization_id)) continue;
    const operated = operatedByOrganization.get(row.organization_id) ?? new Set<string>();
    const scope = row.membership_scope as MembershipScope;
    const role = row.staxis_role as HatRole;

    // A company hat reaches the whole company, including hotels bought after
    // the hat was written. A property hat reaches only its listed hotels — and
    // only while the company still operates them.
    const covered = scope === 'company'
      ? [...operated]
      : toStringArray(row.covered_property_ids).filter((id) => operated.has(id));

    hats.push({
      membershipId: row.id,
      organizationId: row.organization_id,
      accountId: row.account_id,
      scope,
      role,
      jobTitle: row.job_title ?? null,
      coveredPropertyIds: [...new Set(covered)].sort(),
    });
  }
  return hats;
}

/**
 * What job does this person hold at this hotel?
 *
 * A hat covering the hotel wins. Otherwise the answer is the person's legacy
 * `accounts.role` — which is what every single-hotel account in the product
 * today has, and why nothing about them changes.
 */
export async function effectiveRole(
  accountId: string,
  propertyId: string,
): Promise<EffectiveRole> {
  const empty: EffectiveRole = {
    role: null,
    hatRole: null,
    scope: null,
    organizationId: null,
    source: 'none',
    seesFinancials: false,
  };
  if (!accountId || !propertyId) return empty;

  const account = await loadAccount(accountId);
  if (!account) return empty;

  const legacyRole = (account.role as AppRole | null) ?? null;

  // Staxis administrators are a separate realm and never wear a hat
  // (migration 0325's `_staxis_guard_customer_membership_account` refuses it).
  if (legacyRole === 'admin') {
    return {
      role: 'admin',
      hatRole: null,
      scope: null,
      organizationId: null,
      source: 'legacy',
      seesFinancials: true,
    };
  }

  const covering = (await loadHats(accountId))
    .filter((hat) => hat.coveredPropertyIds.includes(propertyId));

  if (covering.length > 0) {
    const winner = covering.reduce((best, hat) => (
      HAT_STRENGTH[hat.role] > HAT_STRENGTH[best.role] ? hat : best
    ));
    return {
      role: legacyRoleForHat(winner.role),
      hatRole: winner.role,
      scope: winner.scope,
      organizationId: winner.organizationId,
      source: 'membership',
      seesFinancials: covering.some((hat) => hatSeesFinancials(hat.role)),
    };
  }

  // The legacy answer, for every account that has no hat at this hotel — which
  // is every account in the product today. It is gated on the legacy array
  // actually naming the hotel, because `accounts.role` is a GLOBAL word and
  // reading it as "her job at hotel #12" is how a company VP would silently
  // become a general manager of a hotel she has never heard of.
  const legacyAccess = toStringArray(account.property_access);
  const standsAtHotel = legacyAccess.includes(propertyId) || legacyAccess.includes('*');
  if (!legacyRole || !standsAtHotel) return empty;
  return {
    role: legacyRole,
    hatRole: null,
    scope: null,
    organizationId: null,
    source: 'legacy',
    seesFinancials: false,
  };
}

/**
 * Every hotel this person may reach: the legacy array UNION every hat's
 * coverage. Never a subtraction — an account that could reach a hotel
 * yesterday can still reach it.
 */
export async function accessibleProperties(accountId: string): Promise<AccessibleProperties> {
  if (!accountId) return NO_ACCESS;
  const account = await loadAccount(accountId);
  if (!account) return NO_ACCESS;

  const legacy = toStringArray(account.property_access);
  if (account.role === 'admin' || legacy.includes('*')) {
    return { all: true, propertyIds: [], legacyPropertyIds: legacy, membershipPropertyIds: [] };
  }

  const hats = await loadHats(accountId);
  const membership = [...new Set(hats.flatMap((hat) => hat.coveredPropertyIds))].sort();
  const union = [...new Set([...legacy, ...membership])].sort();

  return {
    all: false,
    propertyIds: union,
    legacyPropertyIds: [...new Set(legacy)].sort(),
    membershipPropertyIds: membership,
  };
}

/**
 * The same answer as `loadHats`, for a whole team list at once — the people
 * panel draws a line per job and must not issue one query per person.
 */
export async function loadHatsForAccounts(
  accountIds: readonly string[],
): Promise<Map<string, MembershipHat[]>> {
  const byAccount = new Map<string, MembershipHat[]>();
  const unique = [...new Set(accountIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return byAccount;
  const results = await Promise.all(unique.map(async (id) => [id, await loadHats(id)] as const));
  for (const [id, hats] of results) {
    if (hats.length > 0) byAccount.set(id, hats);
  }
  return byAccount;
}

/**
 * Does a COMPANY JOB cover this hotel? Deliberately ignores the legacy array,
 * including its `'*'` wildcard — callers that must stay exact (invitation
 * acceptance re-validates a non-admin inviter's scope, where `'*'` has never
 * counted) ask this instead of `accountReachesProperty`.
 */
export async function hatCoversProperty(
  accountId: string,
  propertyId: string,
): Promise<boolean> {
  if (!accountId || !propertyId) return false;
  const hats = await loadHats(accountId);
  return hats.some((hat) => hat.coveredPropertyIds.includes(propertyId));
}

/** Convenience wall check — "may this account touch this hotel at all?" */
export async function accountReachesProperty(
  accountId: string,
  propertyId: string,
): Promise<boolean> {
  if (!accountId || !propertyId) return false;
  const access = await accessibleProperties(accountId);
  return access.all || access.propertyIds.includes(propertyId);
}

/**
 * The hotels a company operates right now. The ONE query that turns a company
 * into a hotel list, so Wall B has exactly one place to be right.
 */
export async function propertiesOfOrganization(organizationId: string): Promise<string[]> {
  if (!organizationId) return [];
  try {
    return await readPropertiesOfOrganization(organizationId);
  } catch {
    return [];
  }
}

async function readPropertiesOfOrganization(organizationId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('organization_property_relationships')
    .select('property_id, starts_at, ends_at')
    .eq('organization_id', organizationId);
  if (error || !Array.isArray(data)) return [];
  const nowMs = Date.now();
  const ids = (data as Array<{ property_id: string; starts_at: string | null; ends_at: string | null }>)
    .filter((row) => {
      const startsMs = row.starts_at ? new Date(row.starts_at).getTime() : 0;
      const endsMs = row.ends_at ? new Date(row.ends_at).getTime() : null;
      return startsMs <= nowMs && (endsMs === null || endsMs > nowMs);
    })
    .map((row) => row.property_id);
  return [...new Set(ids)].sort();
}

/**
 * Which real company operates this hotel? `null` for an independent hotel —
 * the hidden single-hotel compatibility anchors from 0325 are never an answer,
 * because they are bookkeeping, not a company.
 */
export async function companyForProperty(propertyId: string): Promise<string | null> {
  if (!propertyId) return null;
  try {
    return await readCompanyForProperty(propertyId);
  } catch {
    // No company is the safe answer: the caller falls back to the plain hotel
    // behaviour the product has always had.
    return null;
  }
}

async function readCompanyForProperty(propertyId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('organization_property_relationships')
    .select('organization_id, starts_at, ends_at')
    .eq('property_id', propertyId);
  if (error || !Array.isArray(data)) return null;

  const nowMs = Date.now();
  const openOrganizationIds = [...new Set(
    (data as Array<{ organization_id: string; starts_at: string | null; ends_at: string | null }>)
      .filter((row) => {
        const startsMs = row.starts_at ? new Date(row.starts_at).getTime() : 0;
        const endsMs = row.ends_at ? new Date(row.ends_at).getTime() : null;
        return startsMs <= nowMs && (endsMs === null || endsMs > nowMs);
      })
      .map((row) => row.organization_id),
  )];
  if (openOrganizationIds.length === 0) return null;

  const { data: orgData, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id, status, organization_type')
    .in('id', openOrganizationIds);
  if (orgError || !Array.isArray(orgData)) return null;
  const real = (orgData as Array<{ id: string; status: string | null; organization_type: string | null }>)
    .filter((row) => row.status === 'active' && row.organization_type !== 'single_hotel')
    .map((row) => row.id)
    .sort();
  return real[0] ?? null;
}

/**
 * The hats a person may hand out from, at a given hotel or company-wide.
 * Used by the invite flow to decide whether to ask the third question.
 */
export function managingHats(hats: readonly MembershipHat[]): MembershipHat[] {
  return hats.filter((hat) => (
    (hat.scope === 'company' && (hat.role === 'owner' || hat.role === 'vp'))
      || (hat.scope === 'property' && hat.role === 'general_manager')
  ));
}
