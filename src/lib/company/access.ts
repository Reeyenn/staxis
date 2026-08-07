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
// Authority mode is resolved in PostgreSQL. Legacy/shadow accounts use only
// `accounts.property_access`; normalized accounts use only hats/grants plus
// explicit cutover bridges. There is never a runtime union of two authorities.
//
// WALL A (inside one company) is the coverage computation below: a
// property-scope hat sees exactly the hotels on its own row, so a front-desk
// person at hotel #7 never learns hotel #12 exists.
//
// WALL B (across companies) is structural: the database projects only the
// selected organization's hotels, but counts every current-primary claim for
// each candidate hotel before returning anything. A damaged dual-company claim
// therefore denies both companies instead of making either isolated read look
// authoritative.

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
} from '@/lib/authorization/server';
import { log } from '@/lib/log';
import type { AppRole } from '@/lib/roles';
import {
  hatSeesFinancials,
  isHatRole,
  isMembershipScope,
  operationalRoleForHatAtHotel,
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

export type RoleSource = 'membership' | 'grant' | 'legacy' | 'none';

export interface EffectiveRole {
  /**
   * Always a legacy `accounts.role` word, so this drops straight into
   * `can()`, `canManageTeam()`, `canForProperty()` and every other existing
   * check with no translation. Company-only jobs degrade least-privilege
   * through `operationalRoleForHatAtHotel`.
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

// ─── Which relationship rows actually GOVERN a hotel ────────────────────────
//
// `organization_property_relationships` holds seven kinds of link — operator,
// owner, brand, franchisor, vendor, consultant, other — and a hotel routinely
// has several at once. Only two of them mean "this company runs this building",
// and the database says which rows are primary through `is_primary_grouping`
// plus CHECK `..._primary_kind_check`, restricting a primary to operator/owner.
// A historical partial UNIQUE index only covers NULL-ended rows, so it cannot
// by itself exclude overlap with a future-ended row. The strict topology RPC
// counts every row whose time window is current and rejects on any overlap.
//
// Every read in this file used to ignore both columns, which meant a brand or
// franchisor row counted as coverage and, worse, that a hotel appearing under
// two live organizations was resolved by `real[0]` — the lowest UUID. Filtering
// on governing relationships and rejecting multi-current topology removes the
// unsafe tie-break entirely.

interface RelationshipRow {
  organization_id: string;
  relationship_type?: string | null;
  is_primary_grouping?: boolean | null;
  starts_at: string | null;
  ends_at: string | null;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORGANIZATION_PROPERTY_TOPOLOGY_SCHEMA_VERSION = 'organization-property-topology-v1' as const;
const MAX_ORGANIZATION_PROPERTIES = 5000;

const GOVERNING_RELATIONSHIP_TYPES = new Set(['operator', 'owner']);

function relationshipIsGoverning(row: RelationshipRow): boolean {
  return row.is_primary_grouping === true
    && GOVERNING_RELATIONSHIP_TYPES.has(row.relationship_type ?? '');
}

function relationshipIsOpen(row: RelationshipRow, nowMs: number): boolean {
  const startsMs = row.starts_at ? new Date(row.starts_at).getTime() : 0;
  const endsMs = row.ends_at ? new Date(row.ends_at).getTime() : null;
  return startsMs <= nowMs && (endsMs === null || endsMs > nowMs);
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
 * Note `general_manager` sits ABOVE `regional_manager` on purpose. Maria is the
 * GM of Beaumont AND oversees Lufkin and Tyler; at Beaumont she is the GM — the
 * person who runs it — and oversight is what she does at the OTHER hotels.
 * Ranking the regional job higher would rename her at her own hotel.
 *
 * `seesFinancials` is computed across ALL covering hats rather than from the
 * winner, so a narrower winner can never close a door a wider hat opened.
 */
const HAT_STRENGTH: Record<HatRole, number> = {
  owner: 6,
  general_manager: 5,
  regional_manager: 4,
  front_desk: 2,
  maintenance: 1,
  housekeeping: 0,
};

/**
 * WHICH HOTELS DOES ONE HAT REACH — the coverage rule, in one function.
 *
 * A company hat reaches every hotel its company operates right now, including
 * one bought after the hat was written. A property hat reaches only the hotels
 * listed on its own row, and only while the company still operates them (Wall A
 * for a property hat, and the reason `operatedPropertyIds` is an intersection
 * rather than a fallback).
 *
 * Pure, and exported, because a second reader now needs it: the Company Hub's
 * projection resolves coverage for every membership in a company from rows it
 * has already read, so calling `loadHats` per person would be dozens of extra
 * round trips on a page load. Two implementations of this rule is exactly how
 * one of them ends up wrong, so there is one and this is it.
 */
export function resolveHatCoverage(
  scope: MembershipScope,
  coveredPropertyIds: readonly string[],
  operatedPropertyIds: Iterable<string>,
): string[] {
  const operated = operatedPropertyIds instanceof Set
    ? operatedPropertyIds as Set<string>
    : new Set(operatedPropertyIds);
  // A COMPANY hat has two shapes since 0464, and the difference is the whole
  // point of that migration:
  //
  //   no list   every hotel the company operates, including ones bought later.
  //             `covered_property_ids` is NULL in the database and arrives here
  //             as an empty array, because that is what `toStringArray(null)`
  //             produces.
  //   a list    exactly those hotels, and nothing else.
  //
  // This branch used to return every operated hotel for ANY company hat, which
  // meant an Owner given 3 of 20 hotels was PRESENTED as covering all 20
  // wherever this function feeds the screen. The database walls held, so it was
  // a lie told by the UI rather than access granted — but the Company Hub is
  // how somebody checks what they just handed out, and it was answering the
  // question wrong.
  //
  // An explicit list is intersected with what the company currently operates,
  // exactly as the property branch is and exactly as the canonical SQL resolver
  // does, so a hotel that leaves the company drops out of both at once. The
  // CHECK constraint makes an empty explicit list impossible; if one is ever
  // seen anyway it intersects to nothing, which fails closed.
  const covered = scope === 'company' && coveredPropertyIds.length === 0
    ? [...operated]
    : coveredPropertyIds.filter((id) => operated.has(id));
  return [...new Set(covered)].sort();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
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

  // organization -> the hotels it operates right now. THE ONLY source of
  // coverage in this file, and it is always keyed by the hat's own company.
  //
  // GOVERNING rows only. A company that holds a `brand` or `franchisor` link to
  // a hotel does not run it, and an operator row that is no longer the primary
  // grouping is a company that USED to — whoever took over stood it down
  // (`staxis_attach_property_to_organization`, 0325). Counting either as
  // coverage hands a whole hotel's data to the wrong company's staff.
  const effectiveAt = new Date(nowMs);
  const topologyRows = await Promise.all([...liveOrganizationIds]
    .sort()
    .map(async (organizationId) => [
      organizationId,
      await resolveOrganizationPropertyTopology(organizationId, effectiveAt),
    ] as const));
  const operatedByOrganization = new Map<string, Set<string>>();
  for (const [organizationId, resolved] of topologyRows) {
    // Omit this organization's hats entirely when its topology cannot be
    // proven. A successfully proven empty company keeps its hats with empty
    // coverage; an outage or dual-current hotel is not the same answer.
    if (!resolved.ok) continue;
    operatedByOrganization.set(
      organizationId,
      new Set(resolved.topology.propertyIds),
    );
  }

  const hats: MembershipHat[] = [];
  for (const row of rows) {
    if (!liveOrganizationIds.has(row.organization_id)) continue;
    const operated = operatedByOrganization.get(row.organization_id);
    if (!operated) continue;
    const scope = row.membership_scope as MembershipScope;
    const role = row.staxis_role as HatRole;

    hats.push({
      membershipId: row.id,
      organizationId: row.organization_id,
      accountId: row.account_id,
      scope,
      role,
      jobTitle: row.job_title ?? null,
      coveredPropertyIds: resolveHatCoverage(
        scope,
        toStringArray(row.covered_property_ids),
        operated,
      ),
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
  if (!accountId || !propertyId) return NO_EFFECTIVE_ROLE;
  const authority = await listAuthoritativePropertyAccess(accountId);
  if (!authority) return NO_EFFECTIVE_ROLE;
  const standing = authoritativeStandingForProperty(authority, propertyId);
  if (!standing) return NO_EFFECTIVE_ROLE;

  const source = standing.entitlements[0];
  if (!source) {
    // The only standing without provenance is the synthetic platform-admin
    // standing returned by authoritativeStandingForProperty.
    return standing.operationalRole === 'admin'
      ? {
        role: 'admin',
        hatRole: null,
        scope: null,
        organizationId: null,
        source: 'legacy',
        seesFinancials: true,
      }
      : NO_EFFECTIVE_ROLE;
  }

  return {
    role: standing.operationalRole,
    hatRole: source.kind === 'membership_hat' ? source.staxisRole : null,
    scope: source.kind === 'membership_hat'
      && (source.scopeType === 'company' || source.scopeType === 'property')
      ? source.scopeType
      : null,
    organizationId: source.organizationId,
    source: source.kind === 'membership_hat'
      ? 'membership'
      : source.kind === 'access_grant'
        ? 'grant'
        : 'legacy',
    seesFinancials: standing.seesFinancials,
  };
}

/** The answer for "this person holds no job at this hotel at all". */
export const NO_EFFECTIVE_ROLE: EffectiveRole = {
  role: null,
  hatRole: null,
  scope: null,
  organizationId: null,
  source: 'none',
  seesFinancials: false,
};

/** What `resolveEffectiveRole` needs, in whatever order a caller already has it. */
export interface EffectiveRoleInputs {
  /** `accounts.role` — a GLOBAL word. Never a per-hotel answer on its own. */
  legacyRole: AppRole | null;
  /** `accounts.property_access`, verbatim. */
  legacyPropertyAccess: readonly string[];
  /** Every hat this person wears, coverage already resolved (`loadHats`). */
  hats: readonly MembershipHat[];
}

/**
 * THE ROLE RULE, as a pure function — no database, no round trip.
 *
 * `effectiveRole` above is this function plus two reads. It is exported
 * separately because `src/lib/team-auth.ts` resolves a caller's capacity at a
 * hotel from a `ManagerCaller` it has ALREADY loaded (role, legacy array and
 * hats are all on it), and asking the database again for facts in hand would
 * put two round trips on every findings route. Two implementations of a rule
 * this load-bearing is how one of them ends up wrong; there is one, and it is
 * here.
 */
export function resolveEffectiveRole(
  inputs: EffectiveRoleInputs,
  propertyId: string,
): EffectiveRole {
  if (!propertyId) return NO_EFFECTIVE_ROLE;

  if (inputs.legacyRole === 'admin') {
    return {
      role: 'admin',
      hatRole: null,
      scope: null,
      organizationId: null,
      source: 'legacy',
      seesFinancials: true,
    };
  }

  const covering = inputs.hats.filter((hat) => hat.coveredPropertyIds.includes(propertyId));

  if (covering.length > 0) {
    const winner = covering.reduce((best, hat) => (
      HAT_STRENGTH[hat.role] > HAT_STRENGTH[best.role] ? hat : best
    ));
    return {
      role: operationalRoleForHatAtHotel(winner.scope, winner.role),
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
  const standsAtHotel = inputs.legacyPropertyAccess.includes(propertyId)
    || inputs.legacyPropertyAccess.includes('*');
  if (!inputs.legacyRole || !standsAtHotel) return NO_EFFECTIVE_ROLE;
  return {
    role: inputs.legacyRole,
    hatRole: null,
    scope: null,
    organizationId: null,
    source: 'legacy',
    seesFinancials: false,
  };
}

/**
 * Every hotel this person may reach, from the database's single authoritative
 * mode. This DTO is mirrored by `staxis_account_reaches_property` for RLS.
 */
export async function accessibleProperties(accountId: string): Promise<AccessibleProperties> {
  if (!accountId) return NO_ACCESS;
  const authority = await listAuthoritativePropertyAccess(accountId);
  return authority ?? NO_ACCESS;
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
  const resolved = await resolveOrganizationPropertyTopology(organizationId);
  return resolved.ok ? [...resolved.topology.propertyIds] : [];
}

/**
 * An immutable, point-in-time answer for the hotels one organization governs.
 * An empty `propertyIds` array is a successfully proven empty organization;
 * it is deliberately different from an unavailable relationship read.
 */
export interface OrganizationPropertyTopology {
  readonly organizationId: string;
  readonly effectiveAt: string;
  readonly propertyIds: readonly string[];
}

export type OrganizationPropertyTopologyResult =
  | { readonly ok: true; readonly topology: OrganizationPropertyTopology }
  | { readonly ok: false; readonly reason: 'invalid_input' | 'store_unavailable' };

function exactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

/**
 * Strict company topology for authorization, clocks, comparisons and other
 * service callers where "we could not read the company" must never be treated
 * as "the company has no hotels". PostgreSQL evaluates every current-primary
 * row for the candidate hotels in one statement, so two companies cannot each
 * see an isolated apparently-valid claim to the same hotel.
 *
 * The effective instant is supplied by deterministic runners so relationship
 * windows and the data window are evaluated against the same clock. Legacy
 * callers keep using the lenient wrapper above and retain their exact `[]` on
 * failure behaviour.
 */
export async function resolveOrganizationPropertyTopology(
  organizationId: string,
  effectiveAt: Date = new Date(),
): Promise<OrganizationPropertyTopologyResult> {
  const effectiveAtMs = effectiveAt.getTime();
  if (!UUID_RX.test(organizationId ?? '') || !Number.isFinite(effectiveAtMs)) {
    return { ok: false, reason: 'invalid_input' };
  }
  const effectiveAtIso = new Date(effectiveAtMs).toISOString();
  try {
    const { data, error } = await supabaseAdmin.rpc(
      'staxis_resolve_organization_property_topology',
      {
        p_organization_id: organizationId,
        p_effective_at: effectiveAtIso,
      },
    );
    if (error || data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'store_unavailable' };
    }
    const raw = data as Record<string, unknown>;
    if (raw.ok === false) {
      if (!exactObjectKeys(raw, ['ok', 'reason'])
          || (raw.reason !== 'invalid_input' && raw.reason !== 'store_unavailable')) {
        return { ok: false, reason: 'store_unavailable' };
      }
      return { ok: false, reason: raw.reason };
    }
    if (raw.ok !== true
        || !exactObjectKeys(raw, [
          'ok', 'schemaVersion', 'organizationId', 'effectiveAt', 'propertyIds',
        ])
        || raw.schemaVersion !== ORGANIZATION_PROPERTY_TOPOLOGY_SCHEMA_VERSION
        || raw.organizationId !== organizationId
        || typeof raw.effectiveAt !== 'string'
        || Date.parse(raw.effectiveAt) !== effectiveAtMs
        || !Array.isArray(raw.propertyIds)
        || raw.propertyIds.length > MAX_ORGANIZATION_PROPERTIES
        || !raw.propertyIds.every((propertyId) => (
          typeof propertyId === 'string' && UUID_RX.test(propertyId)
        ))) {
      return { ok: false, reason: 'store_unavailable' };
    }
    const propertyIds = raw.propertyIds as string[];
    const canonical = [...new Set(propertyIds)].sort();
    if (canonical.length !== propertyIds.length
        || !propertyIds.every((propertyId, index) => propertyId === canonical[index])) {
      return { ok: false, reason: 'store_unavailable' };
    }
    return {
      ok: true,
      topology: Object.freeze({
        organizationId,
        effectiveAt: effectiveAtIso,
        propertyIds: Object.freeze([...propertyIds]),
      }),
    };
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  }
}

/**
 * "Which company runs this hotel", with the FOUR answers actually distinguished.
 *
 * `companyForProperty` below collapses all of them to `string | null`, which is
 * right for every reader that only wants to render something — an unreadable
 * rulebook and an independent hotel both mean "show no company section".
 *
 * It is WRONG for a gate. A strict caller — the sign-off gate that asks "does a
 * company rule govern this action?" — reads `null` as "no rule governs, go
 * ahead", so a transient read error becomes a silent approval. That is the
 * fail-open class the execute-gate fix closed on the money side, and it comes
 * in through here. Such callers ask this function and refuse on anything that
 * is not a definite answer.
 *
 *   company      one live company operates this hotel.
 *   independent  no company does, and we know that. Safe to proceed.
 *   unavailable  a read failed. We do not know, and must not guess.
 *   ambiguous    two live companies both claim to run it — a data problem a
 *                human has to settle. Also not a safe proceed.
 */
export type CompanyResolution =
  | { status: 'company'; organizationId: string }
  | { status: 'independent' }
  | { status: 'unavailable' }
  | { status: 'ambiguous'; organizationIds: string[] };

export async function resolveCompanyForProperty(propertyId: string): Promise<CompanyResolution> {
  if (!propertyId) return { status: 'unavailable' };
  try {
    return await readCompanyResolution(propertyId);
  } catch {
    // A thrown read is the same not-knowing as an errored one. It is the LENIENT
    // wrapper's job to decide that not-knowing renders as nothing; it is not
    // this function's job to pretend it knew.
    return { status: 'unavailable' };
  }
}

/**
 * Which real company operates this hotel? `null` for an independent hotel —
 * the hidden single-hotel compatibility anchors from 0325 are never an answer,
 * because they are bookkeeping, not a company.
 *
 * LENIENT on purpose, and byte-identical to what it has always returned: a read
 * we could not complete answers `null`, so the caller falls back to the plain
 * hotel behaviour the product has always had. Anything that GATES on the answer
 * must call `resolveCompanyForProperty` instead — see its header for why.
 */
export async function companyForProperty(propertyId: string): Promise<string | null> {
  const resolution = await resolveCompanyForProperty(propertyId);
  return resolution.status === 'company' ? resolution.organizationId : null;
}

async function readCompanyResolution(propertyId: string): Promise<CompanyResolution> {
  const { data, error } = await supabaseAdmin
    .from('organization_property_relationships')
    .select('organization_id, relationship_type, is_primary_grouping, starts_at, ends_at')
    .eq('property_id', propertyId);
  if (error || !Array.isArray(data)) return { status: 'unavailable' };

  const nowMs = Date.now();
  const openOrganizationIds = [...new Set(
    (data as RelationshipRow[])
      .filter(relationshipIsGoverning)
      .filter((row) => relationshipIsOpen(row, nowMs))
      .map((row) => row.organization_id),
  )];
  // A definite answer: nobody governs this hotel. This is the ONE zero-result
  // path that means "independent" rather than "we could not tell".
  if (openOrganizationIds.length === 0) return { status: 'independent' };

  const { data: orgData, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id, status, organization_type')
    .in('id', openOrganizationIds);
  if (orgError || !Array.isArray(orgData)) return { status: 'unavailable' };
  const real = (orgData as Array<{ id: string; status: string | null; organization_type: string | null }>)
    .filter((row) => row.status === 'active' && row.organization_type !== 'single_hotel')
    .map((row) => row.id)
    .sort();

  // Every governing claim came from a single-hotel compatibility anchor or a
  // wound-up organization. That is bookkeeping, not a company: independent.
  if (real.length === 0) return { status: 'independent' };
  if (real.length > 1) {
    // NO WINNER, LOUDLY.
    //
    // This answer decides whose rulebook goes into the hotel's prompt, whose
    // money thresholds apply to it, and which company's people appear on its
    // team list. It used to be `real[0]` — the lowest UUID — which is not a
    // decision, it is alphabetical order wearing a decision's clothes. A hotel
    // that ends up in two live organizations would silently be governed by
    // whichever company happened to sort first, and nothing anywhere would say
    // so.
    //
    // The governing-relationship filter above (operator/owner + primary
    // grouping) is what makes this genuinely rare — production's three
    // multi-org properties are all secondary `brand`/anchor rows and resolve
    // cleanly. Reaching here means two companies both claim to RUN this hotel,
    // which is a data problem a human has to settle. Lenient readers render
    // nothing; a gate refuses.
    log.error('[companyForProperty] a hotel is claimed by two live companies', {
      propertyId,
      organizationIds: real,
    });
    return { status: 'ambiguous', organizationIds: real };
  }
  return { status: 'company', organizationId: real[0] };
}

/**
 * Everybody whose COMPANY JOB reaches this hotel.
 *
 * The gap this closes: a hotel's team list is built from
 * `accounts.property_access`, and every company person seeded by the spine has
 * an EMPTY legacy array — their access comes entirely from a hat. So the VP who
 * oversees Lufkin, and the GM whose hat names it, were both invisible on
 * Lufkin's own team list. Not a permissions bug (they could reach the hotel
 * fine); a "who works here" bug, which is worse in its own way — the list
 * quietly under-reported who has access.
 *
 * ADDITIVE by construction: it returns account ids to ADD to a list, and the
 * caller unions them in. Nobody who appeared before disappears.
 *
 * Wall B: coverage is read through `loadHats`, which only ever draws from the
 * hat's own organization. A hotel in company B cannot surface company A's
 * people, whatever this is called with.
 */
export async function accountsCoveringProperty(propertyId: string): Promise<string[]> {
  if (!propertyId) return [];
  try {
    return await readAccountsCoveringProperty(propertyId);
  } catch {
    // A store that cannot answer "who else works here" answers NOBODY. The
    // caller's own list is unaffected, which is exactly the pre-spine behaviour.
    return [];
  }
}

async function readAccountsCoveringProperty(propertyId: string): Promise<string[]> {
  const organizationId = await companyForProperty(propertyId);
  if (!organizationId) return [];

  const { data, error } = await supabaseAdmin
    .from('organization_memberships')
    .select('account_id')
    .eq('organization_id', organizationId)
    .not('staxis_role', 'is', null)
    .is('ended_at', null)
    .eq('status', 'active');
  if (error || !Array.isArray(data)) return [];

  const candidates = [...new Set(
    (data as Array<{ account_id: string }>).map((row) => row.account_id),
  )];
  if (candidates.length === 0) return [];

  // Coverage is resolved per person through the SAME reader every other gate
  // uses, rather than by reading `covered_property_ids` here. A property hat
  // lists its hotels; a company hat lists none and covers all of them; both
  // answers, and the org/relationship filtering behind them, live in exactly
  // one place and this is not it.
  const resolved = await Promise.all(candidates.map(async (accountId) => {
    const hats = await loadHats(accountId);
    return hats.some((hat) => (
      hat.organizationId === organizationId && hat.coveredPropertyIds.includes(propertyId)
    )) ? accountId : null;
  }));
  return resolved.filter((id): id is string => id !== null).sort();
}

/**
 * The hats a person may hand out from, at a given hotel or company-wide.
 * Used by the invite flow to decide whether to ask the third question.
 */
export function managingHats(hats: readonly MembershipHat[]): MembershipHat[] {
  return hats.filter((hat) => (
    (hat.scope === 'company' && (hat.role === 'owner' || hat.role === 'regional_manager'))
      || (hat.scope === 'property' && hat.role === 'general_manager')
  ));
}
