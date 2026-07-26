import 'server-only';

// ─── "Who, what job, and — if you run a company — which hotels" ─────────────
//
// The existing team-invite button asks two questions: who, and what job. The
// hotel is implied, because whoever is asking runs exactly one. A management
// company breaks that assumption: an owner or VP running twenty hotels has to
// say WHICH, and the honest answer is often "all of them, including the one we
// buy in March".
//
// This module turns the invite body into the hat the invitation will hand out,
// or into `null` when the invitation is the plain hotel invite the product has
// always sent. It is also the invitation-time half of WALL B: a company person
// may name hotels inside their own company and nowhere else, and the check is
// made against the database rather than against anything the browser said.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid } from '@/lib/api-validate';
import type { AppRole } from '@/lib/roles';
import {
  canGrantHat,
  isHatRole,
  isMembershipScope,
  legacyRoleForHat,
  scopeAllowsRole,
  type HatRole,
  type MembershipScope,
} from '@/lib/company/roles';
import {
  companyForProperty,
  managingHats,
  propertiesOfOrganization,
  type MembershipHat,
} from '@/lib/company/access';

export interface ResolvedInviteScope {
  organizationId: string;
  scope: MembershipScope;
  role: HatRole;
  /**
   * For a property-scope hat, the exact hotels. For a company-scope hat, the
   * hotels the company operates at this instant — informational only; the hat
   * itself stores nothing, so hotels bought later are covered automatically.
   */
  propertyIds: string[];
  /** The `accounts.role` word the invited person's login will carry. */
  legacyRole: AppRole;
}

export interface InviteScopeCaller {
  accountId: string;
  role: AppRole;
  isAdmin?: boolean;
  hats?: MembershipHat[];
}

class InviteScopeError extends Error {}

function refuse(message: string): never {
  throw new InviteScopeError(message);
}

function readPropertyIds(value: unknown): string[] {
  if (!Array.isArray(value)) refuse('Choose at least one hotel for this invitation');
  const ids = value.filter((entry): entry is string => typeof entry === 'string');
  if (ids.length !== value.length) refuse('Choose at least one hotel for this invitation');
  for (const id of ids) {
    if (validateUuid(id, 'hotel').error) refuse('One of the chosen hotels is not a real hotel');
  }
  const unique = [...new Set(ids)];
  if (unique.length === 0) refuse('Choose at least one hotel for this invitation');
  return unique.sort();
}

/**
 * Resolve the invitation into a hat, or `null` for the legacy hotel invite.
 *
 * `null` is returned when — and only when — nobody in this transaction has a
 * company job to hand out from. That keeps every independent hotel on exactly
 * the path it has always used.
 *
 * Throws (message is safe to show a manager) when the request names a job,
 * scope, or hotel the caller may not hand out.
 */
export async function resolveInviteScope(
  caller: InviteScopeCaller,
  hotelId: string,
  requestedRole: string,
  requestedScope: unknown,
  requestedPropertyIds: unknown,
): Promise<ResolvedInviteScope | null> {
  const askedForCompanyShape = requestedScope !== undefined && requestedScope !== null;

  // Which company are we inviting into? The hotel on the invitation is the
  // hotel the invited person lands on, and it decides the company.
  const organizationId = await companyForProperty(hotelId);

  if (!organizationId) {
    if (askedForCompanyShape) {
      refuse('That hotel does not belong to a management company');
    }
    return null;
  }

  const managing = managingHats(caller.hats ?? [])
    .filter((hat) => hat.organizationId === organizationId);

  // A Staxis administrator can staff any company; a customer needs a job in
  // THIS company. Someone with a job in a different company has none here,
  // which is Wall B: their hats simply do not appear in `managing`.
  if (!caller.isAdmin && managing.length === 0) {
    if (askedForCompanyShape) {
      refuse('You do not have a job at this company that can invite people');
    }
    // A legacy manager (property_access, no hat) at a hotel that happens to
    // belong to a company keeps the old behaviour rather than silently gaining
    // company powers.
    return null;
  }

  const scope: MembershipScope = isMembershipScope(requestedScope)
    ? requestedScope
    // No third question was asked, so the hotel is implied — which is exactly
    // what a property-scoped inviter means.
    : 'property';

  if (askedForCompanyShape && !isMembershipScope(requestedScope)) {
    refuse('That is not a valid invitation scope');
  }
  if (!isHatRole(requestedRole) || !scopeAllowsRole(scope, requestedRole)) {
    refuse('That job cannot be given at that level');
  }
  const role = requestedRole;

  const propertyIds = scope === 'company'
    ? await propertiesOfOrganization(organizationId)
    : (askedForCompanyShape ? readPropertyIds(requestedPropertyIds) : [hotelId]);

  if (scope === 'property') {
    // WALL B, at the invitation boundary: every named hotel must be one this
    // company actually operates. A hotel id pasted from another company is
    // refused here even if the caller is that company's owner.
    const operated = new Set(await propertiesOfOrganization(organizationId));
    const stranger = propertyIds.find((id) => !operated.has(id));
    if (stranger) refuse('One of the chosen hotels is not part of this company');
  }

  if (!caller.isAdmin) {
    // WALL A, at the invitation boundary: a GM may staff the hotels they
    // already cover and may not mint a peer GM; a VP may not create a peer VP
    // or an owner. Mirrored in `_staxis_can_set_membership_hat`, so a forged
    // request that got past here would still be refused by Postgres.
    const allowed = managing.some((hat) => canGrantHat(
      { scope: hat.scope, role: hat.role, coveredPropertyIds: hat.coveredPropertyIds },
      { scope, role, propertyIds },
    ));
    if (!allowed) refuse('You cannot give that job at those hotels');
  }

  return { organizationId, scope, role, propertyIds, legacyRole: legacyRoleForHat(role) };
}

/**
 * Turn an accepted invitation into the hat it promised.
 *
 * Called from the acceptance route AFTER the account exists. Failure is
 * deliberately non-fatal to acceptance: the person already has a login and the
 * hotel their invitation named, so a hat that could not be written is a missing
 * capability to repair, not a reason to strand a new employee at the door.
 * Returns the membership id, or null.
 */
export async function grantInvitedHat(params: {
  actorAccountId: string;
  organizationId: string;
  accountId: string;
  scope: MembershipScope;
  role: HatRole;
  propertyIds: string[] | null;
  jobTitle?: string | null;
}): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc('staxis_set_membership_hat', {
    p_actor_account_id: params.actorAccountId,
    p_organization_id: params.organizationId,
    p_account_id: params.accountId,
    p_membership_scope: params.scope,
    p_staxis_role: params.role,
    p_property_ids: params.scope === 'property' ? params.propertyIds : null,
    p_job_title: params.jobTitle ?? null,
  });
  if (error) return null;
  // PostgREST hands back a scalar-returning function's value directly; some
  // clients wrap it in a one-column row. Accept either rather than losing the
  // membership id to a transport detail.
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const first = Object.values(data as Record<string, unknown>).find((v) => typeof v === 'string');
    return typeof first === 'string' ? first : null;
  }
  return null;
}

export { InviteScopeError };
