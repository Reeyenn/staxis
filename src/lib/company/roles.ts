// ─── The company role vocabulary ───────────────────────────────────────────
//
// A management company owns 5-50 hotels and the same person wears different
// hats at different ones. A job therefore belongs to a person AND a scope, not
// to a person. This module is the single source of truth for the two
// vocabularies that describes:
//
//   company-scope jobs   owner | regional_manager      (across the company)
//   property-scope jobs  general_manager | front_desk |
//                        housekeeping | maintenance    (named hotels only)
//
// DB-side this is enforced by `organization_memberships_hat_shape_check`
// (migrations 0364, 0464). Keep the two lists identical to that CHECK.
//
// The property words are deliberately the SAME strings as `accounts.role`
// (src/lib/roles.ts) so a resolved property hat drops into every existing
// capability check with no translation. The two company-only words are ours,
// and `legacyRoleForHat` below owns their degradation.
//
// ─── Coverage: which hotels a company hat reaches (0464) ───────────────────
//
// A company hat used to mean "every hotel this company operates, forever".
// That was wrong for the customers we actually have: a management company
// runs hotels for DIFFERENT ownership groups, so an Owner of 3 of 20 hotels
// must never see the other 17. A company hat therefore now carries one of two
// coverages, and `HatCoverage` is how that choice travels through this
// codebase:
//
//   null          every hotel the company operates, including ones added
//                 later. The old behaviour, still selectable, still the right
//                 answer for a single-ownership company.
//   [ids…]        exactly these hotels and no others. A hotel acquired
//                 tomorrow is NOT included.
//
// The same two shapes are what `covered_property_ids` stores: SQL NULL for
// all-including-future, an explicit array otherwise. Property hats always
// carry an explicit array, never null.

import type { AppRole } from '@/lib/roles';

export const COMPANY_SCOPE_ROLES = ['owner', 'regional_manager'] as const;
export const PROPERTY_SCOPE_ROLES = [
  'general_manager',
  'front_desk',
  'housekeeping',
  'maintenance',
] as const;

export type CompanyScopeRole = (typeof COMPANY_SCOPE_ROLES)[number];
export type PropertyScopeRole = (typeof PROPERTY_SCOPE_ROLES)[number];
/** Every word that can appear in `organization_memberships.staxis_role`. */
export type HatRole = CompanyScopeRole | PropertyScopeRole;
export type MembershipScope = 'company' | 'property';

/**
 * Which hotels a hat reaches. `null` means every hotel the company operates,
 * including ones acquired later; an array means exactly those hotels. Mirrors
 * `covered_property_ids` (NULL vs array) one for one.
 */
export type HatCoverage = readonly string[] | null;

/** Does `coverage` reach this hotel today? */
export function coverageIncludesProperty(
  coverage: HatCoverage,
  propertyId: string,
): boolean {
  return coverage === null || coverage.includes(propertyId);
}

/**
 * Can somebody whose own reach is `inviterCoverage` hand out a hat whose reach
 * is `targetCoverage`? This is the "never grant past your own edge" rule, and
 * it is the whole reason an Owner of 3 hotels cannot touch the other 17.
 *
 * The asymmetric case is the important one: an inviter with an explicit list
 * may NOT mint an all-including-future hat, because that hat would silently
 * reach hotels the inviter has no authority over the moment one is acquired.
 * Only somebody who already covers everything can promise everything.
 */
export function coverageContains(
  inviterCoverage: HatCoverage,
  targetCoverage: HatCoverage,
): boolean {
  if (inviterCoverage === null) return true;
  if (targetCoverage === null) return false;
  if (targetCoverage.length === 0) return false;
  const covered = new Set(inviterCoverage);
  return targetCoverage.every((propertyId) => covered.has(propertyId));
}

export function isCompanyScopeRole(value: unknown): value is CompanyScopeRole {
  return typeof value === 'string' && (COMPANY_SCOPE_ROLES as readonly string[]).includes(value);
}

export function isPropertyScopeRole(value: unknown): value is PropertyScopeRole {
  return typeof value === 'string' && (PROPERTY_SCOPE_ROLES as readonly string[]).includes(value);
}

export function isHatRole(value: unknown): value is HatRole {
  return isCompanyScopeRole(value) || isPropertyScopeRole(value);
}

export function isMembershipScope(value: unknown): value is MembershipScope {
  return value === 'company' || value === 'property';
}

/** Does this job belong at this scope? Mirrors the DB CHECK exactly. */
export function scopeAllowsRole(scope: MembershipScope, role: HatRole): boolean {
  return scope === 'company' ? isCompanyScopeRole(role) : isPropertyScopeRole(role);
}

/**
 * Degrade a hat to the legacy `accounts.role` vocabulary so it can be handed to
 * every capability check that already exists (`can()`, `canManageTeam`,
 * `canViewFinancials`, the per-hotel override resolver…).
 *
 * The company-only word maps DOWN, never up. This conversion is legacy
 * account vocabulary only; it must never be used as hotel authorization:
 *   regional_manager -> front_desk   company oversight is read-only at a
 *                                    hotel unless a separate property-scope
 *                                    operational entitlement exists.
 */
export function legacyRoleForHat(role: HatRole): AppRole {
  switch (role) {
    case 'owner': return 'owner';
    case 'regional_manager': return 'front_desk';
    case 'general_manager': return 'general_manager';
    case 'front_desk': return 'front_desk';
    case 'housekeeping': return 'housekeeping';
    case 'maintenance': return 'maintenance';
  }
}

/**
 * Legacy-compatible presentation role at one hotel. A company-scope job is
 * deliberately read-only and therefore never projects owner/GM authority.
 * Hotel mutation is a separate authoritative standing bit.
 */
export function operationalRoleForHatAtHotel(
  scope: MembershipScope,
  role: HatRole,
): AppRole {
  return scope === 'company' ? 'front_desk' : legacyRoleForHat(role);
}

/**
 * Degrade a hat to the 0325 ACCESS-PROFILE vocabulary — the second and last
 * older vocabulary a hat has to speak.
 *
 * The Company Hub (`/api/company-access`, `/company`) was built on
 * `organization_access_grants`, a row minted only by invitation acceptance and
 * by the legacy reconciler. `staxis_set_membership_hat` mints no grant, so a
 * company person had NO access profile at all: the hub read zero capabilities,
 * showed "Hotels in scope 0", "Active people 0", "No active access grant", and
 * told a front-desk person their hotel was not grouped under a management
 * company when it plainly was. The hub now asks the hats too, and this is the
 * translation it asks through.
 *
 * LEAST PRIVILEGE, and the walls stay where they are: a profile decides only
 * WHAT KIND of thing you may see. WHICH hotels is always the hat's own
 * resolved coverage, so a property-scope hat still sees exactly its own
 * buildings and a front-desk person at hotel #7 still cannot learn hotel #12
 * exists.
 *
 *   owner            -> organization_owner   their company, entirely. Same as
 *                                            an accepted owner invitation
 *                                            would mint.
 *   regional_manager -> portfolio_manager    view + manage people, access and
 *                                            portfolios. NOT
 *                                            organization_admin: `canGrantHat`
 *                                            refuses them a peer regional
 *                                            manager or an owner, and
 *                                            organization_admin could hand out
 *                                            both.
 *   gm               -> property_manager     their hotels, fully — the job they
 *                                            already do, which is what the
 *                                            profile describes.
 *   line             -> viewer               front desk / housekeeping /
 *                                            maintenance. Enough to be told the
 *                                            truth about who runs the building
 *                                            they work in, and no more: no
 *                                            people list, no access list.
 *
 * WHICH hotels the profile applies to is never decided here. That is always
 * the hat's own resolved coverage, so a company hat with an explicit hotel
 * list gets these capabilities at those hotels only.
 */
export function accessProfileForHat(scope: MembershipScope, role: HatRole):
  'organization_owner' | 'portfolio_manager' | 'property_manager' | 'contributor' | 'viewer' {
  if (scope === 'company') {
    return role === 'owner' ? 'organization_owner' : 'portfolio_manager';
  }
  return role === 'general_manager' ? 'property_manager' : 'viewer';
}

/**
 * The money question, asked of the hat rather than the degraded role.
 * `canViewFinancials(legacyRoleForHat('regional_manager'))` is false —
 * deliberately, so the degradation stays least-privilege — and this is the one
 * place that adds company oversight back in.
 *
 * Only for the hotels the hat actually covers. Callers must still intersect
 * with resolved coverage; this answers "what kind of thing", never "where".
 */
export function hatSeesFinancials(role: HatRole): boolean {
  return role === 'owner' || role === 'regional_manager' || role === 'general_manager';
}

/**
 * Can someone wearing `inviterRole` at `inviterScope` hand out `role` at
 * `scope`? Mirrors `_staxis_can_set_membership_hat` (migrations 0364, 0464) so
 * a stale browser cannot widen authority past what Postgres will accept, and
 * mirrors the spirit of `canGrantHotelRole` for the hotel words.
 *
 * The delegation ladder, in one place:
 *
 *   owner              anyone, at any hotel they themselves cover
 *   regional_manager   hotel jobs only, at hotels they themselves cover.
 *                      Never a company hat, so never a peer or an owner
 *   gm                 line staff only, at hotels they already cover
 *   everyone else      nobody
 *
 * NOBODY GRANTS PAST THEIR OWN EDGE. That is `coverageContains`, and it is
 * what stops an Owner of 3 hotels from minting an Owner of all 20 — or an
 * all-including-future hat that would reach hotel 21 the day it is bought.
 */
export function canGrantHat(
  inviter: { scope: MembershipScope; role: HatRole; coveredPropertyIds: HatCoverage },
  target: { scope: MembershipScope; role: HatRole; propertyIds: HatCoverage },
): boolean {
  if (!scopeAllowsRole(target.scope, target.role)) return false;
  if (!coverageContains(inviter.coveredPropertyIds, target.propertyIds)) return false;

  if (inviter.scope === 'company') {
    if (inviter.role === 'owner') return true;
    return inviter.role === 'regional_manager' && target.scope === 'property';
  }

  if (inviter.scope === 'property' && inviter.role === 'general_manager') {
    if (target.scope !== 'property') return false;
    return target.role !== 'general_manager';
  }

  return false;
}

/** Does this hat get to invite anybody at all? */
export function hatCanManageTeam(scope: MembershipScope, role: HatRole): boolean {
  if (scope === 'company') return role === 'owner' || role === 'regional_manager';
  return role === 'general_manager';
}

/**
 * A company-scope inviter is the one who gets asked the third question ("which
 * hotels?"). A property-scope inviter never is — their hotel is implied.
 */
export function hatChoosesHotels(scope: MembershipScope, role: HatRole): boolean {
  return hatCanManageTeam(scope, role) && scope === 'company';
}

// The `{ en, es }` pair is legacy plumbing that stays where it already is. The
// product ships in English (founder ruling, 2026-07-29), so `regional_manager`
// carries the same English literal in both slots rather than a new Spanish
// string. The older words keep the pairs they already had.
export const HAT_ROLE_LABELS: Record<HatRole, { en: string; es: string }> = {
  owner: { en: 'Owner', es: 'Propietario' },
  regional_manager: { en: 'Regional Manager', es: 'Regional Manager' },
  general_manager: { en: 'GM', es: 'Gerente' },
  front_desk: { en: 'Front Desk', es: 'Recepción' },
  housekeeping: { en: 'Housekeeping', es: 'Limpieza' },
  maintenance: { en: 'Maintenance', es: 'Mantenimiento' },
};
