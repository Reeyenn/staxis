// ─── The company role vocabulary ───────────────────────────────────────────
//
// A management company owns 5-50 hotels and the same person wears different
// hats at different ones. A job therefore belongs to a person AND a scope, not
// to a person. This module is the single source of truth for the two
// vocabularies that describes:
//
//   company-scope jobs   owner | vp | finance          (the whole company)
//   property-scope jobs  general_manager | front_desk |
//                        housekeeping | maintenance    (named hotels only)
//
// DB-side this is enforced by `organization_memberships_hat_shape_check`
// (migration 0364). Keep the two lists identical to that CHECK.
//
// The property words are deliberately the SAME strings as `accounts.role`
// (src/lib/roles.ts) so a resolved property hat drops into every existing
// capability check with no translation. The two company-only words are new,
// and `legacyRoleForHat` below owns their degradation.

import type { AppRole } from '@/lib/roles';

export const COMPANY_SCOPE_ROLES = ['owner', 'vp', 'finance'] as const;
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
 * The two company-only words map DOWN, never up:
 *   vp      -> general_manager  a VP runs the hotels they oversee, so they need
 *                               exactly a GM's hotel authority — no more. They
 *                               are NOT an owner: they cannot mint a peer VP.
 *   finance -> front_desk       the operational floor. A finance person is not
 *                               running the hotel; their reason to exist is the
 *                               money, which `hatSeesFinancials` grants
 *                               separately. Mapping them to GM would hand them
 *                               the whole hotel to get at one tab.
 */
export function legacyRoleForHat(role: HatRole): AppRole {
  switch (role) {
    case 'owner': return 'owner';
    case 'vp': return 'general_manager';
    case 'finance': return 'front_desk';
    case 'general_manager': return 'general_manager';
    case 'front_desk': return 'front_desk';
    case 'housekeeping': return 'housekeeping';
    case 'maintenance': return 'maintenance';
  }
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
 *   owner   -> organization_owner   their company, entirely. Same as an
 *                                   accepted owner invitation would mint.
 *   vp      -> portfolio_manager    view + manage people, access and
 *                                   portfolios. NOT organization_admin:
 *                                   `canGrantHat` already refuses a VP a peer
 *                                   VP or an owner, and organization_admin
 *                                   could hand out both.
 *   finance -> contributor          the company's name and its hotels, and
 *                                   nothing about its people or its access.
 *                                   Money is a different surface; this is the
 *                                   structure page.
 *   gm      -> property_manager     their hotels, fully — the job they already
 *                                   do, which is what the profile describes.
 *   line    -> viewer               front desk / housekeeping / maintenance.
 *                                   Enough to be told the truth about who runs
 *                                   the building they work in, and no more:
 *                                   no people list, no access list.
 */
export function accessProfileForHat(scope: MembershipScope, role: HatRole):
  'organization_owner' | 'portfolio_manager' | 'property_manager' | 'contributor' | 'viewer' {
  if (scope === 'company') {
    if (role === 'owner') return 'organization_owner';
    if (role === 'vp') return 'portfolio_manager';
    return 'contributor';
  }
  return role === 'general_manager' ? 'property_manager' : 'viewer';
}

/**
 * The money question, asked of the hat rather than the degraded role.
 * `canViewFinancials(legacyRoleForHat('finance'))` is false — deliberately, so
 * the degradation stays least-privilege — and this is the one place that adds
 * the finance person back in.
 */
export function hatSeesFinancials(role: HatRole): boolean {
  return role === 'owner' || role === 'vp' || role === 'finance' || role === 'general_manager';
}

/**
 * Can someone wearing `inviterRole` at `inviterScope` hand out `role` at
 * `scope`? Mirrors `_staxis_can_set_membership_hat` (migration 0364) so a
 * stale browser cannot widen authority past what Postgres will accept, and
 * mirrors the spirit of `canGrantHotelRole` for the hotel words.
 *
 *   owner    everything inside their own company
 *   vp       any hotel job, plus hiring finance — but never a peer VP or owner
 *   gm       line staff only, and only at hotels they already cover
 *   others   nothing
 */
export function canGrantHat(
  inviter: { scope: MembershipScope; role: HatRole; coveredPropertyIds: readonly string[] },
  target: { scope: MembershipScope; role: HatRole; propertyIds: readonly string[] },
): boolean {
  if (!scopeAllowsRole(target.scope, target.role)) return false;

  if (inviter.scope === 'company' && inviter.role === 'owner') return true;

  if (inviter.scope === 'company' && inviter.role === 'vp') {
    if (target.scope === 'property') return true;
    return target.role === 'finance';
  }

  if (inviter.scope === 'property' && inviter.role === 'general_manager') {
    if (target.scope !== 'property') return false;
    if (target.role === 'general_manager') return false;
    if (target.propertyIds.length === 0) return false;
    const covered = new Set(inviter.coveredPropertyIds);
    return target.propertyIds.every((id) => covered.has(id));
  }

  return false;
}

/** Does this hat get to invite anybody at all? */
export function hatCanManageTeam(scope: MembershipScope, role: HatRole): boolean {
  if (scope === 'company') return role === 'owner' || role === 'vp';
  return role === 'general_manager';
}

/**
 * A company-scope inviter is the one who gets asked the third question ("which
 * hotels?"). A property-scope inviter never is — their hotel is implied.
 */
export function hatChoosesHotels(scope: MembershipScope, role: HatRole): boolean {
  return hatCanManageTeam(scope, role) && scope === 'company';
}

export const HAT_ROLE_LABELS: Record<HatRole, { en: string; es: string }> = {
  owner: { en: 'Owner', es: 'Propietario' },
  vp: { en: 'Oversees', es: 'Supervisa' },
  finance: { en: 'Finance', es: 'Finanzas' },
  general_manager: { en: 'GM', es: 'Gerente' },
  front_desk: { en: 'Front Desk', es: 'Recepción' },
  housekeeping: { en: 'Housekeeping', es: 'Limpieza' },
  maintenance: { en: 'Maintenance', es: 'Mantenimiento' },
};
