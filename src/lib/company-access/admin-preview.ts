import type {
  CompanyAccessData,
  CompanyAccessPermissions,
  CompanyAccessViewerContext,
  OrganizationKind,
  OrganizationStatus,
} from '@/lib/company-access/dto';
import { IncompleteCompanyProjectionError } from '@/lib/company-access/projection-query';

export interface AdminPreviewPropertyTarget {
  id: string;
  name: string;
}

export interface AdminPreviewOrganizationTarget {
  id: string;
  name: string;
  organizationType: OrganizationKind;
  status: OrganizationStatus;
  legacyPropertyId: string | null;
}

export interface AdminPreviewPrimaryRelationship {
  id: string;
  organizationId: string;
  propertyId: string;
  isPrimaryGrouping: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export type AdminCompanyPreviewTarget =
  | {
      scope: 'organization';
      property: AdminPreviewPropertyTarget;
      organization: AdminPreviewOrganizationTarget;
    }
  | {
      scope: 'property';
      property: AdminPreviewPropertyTarget;
      organization: AdminPreviewOrganizationTarget | null;
    };

export interface AdminCompanyPreviewViewerContext extends CompanyAccessViewerContext {
  hub: 'company' | 'hotel';
  organizationId: string | null;
}

export type AdminCompanyAccessPreviewData = CompanyAccessData & {
  viewerContext: AdminCompanyPreviewViewerContext;
};

export class AmbiguousAdminCompanyPreviewTargetError extends Error {
  constructor(message = 'The hotel has more than one current primary company relationship') {
    super(message);
    this.name = 'AmbiguousAdminCompanyPreviewTargetError';
  }
}

export class UnavailableAdminCompanyPreviewTargetError extends Error {
  constructor(message = 'The selected hotel does not have an active customer management context') {
    super(message);
    this.name = 'UnavailableAdminCompanyPreviewTargetError';
  }
}

export class StaleAdminCompanyPreviewError extends Error {
  constructor() {
    super('The hotel management context changed while its preview was loading');
    this.name = 'StaleAdminCompanyPreviewError';
  }
}

/** Retry once when an exact read could not stay consistent. Ordinary failures
 * are surfaced immediately. */
export async function runAdminPreviewReadWithRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await read();
    } catch (caught) {
      const retryable = caught instanceof StaleAdminCompanyPreviewError
        || caught instanceof IncompleteCompanyProjectionError;
      if (!retryable || attempt === 1) throw caught;
    }
  }
  throw new StaleAdminCompanyPreviewError();
}

/** A hidden single-hotel organization is safe to preview only when every
 * relationship it has ever held belongs to the selected hotel and at least one
 * such relationship is active now. This prevents organization-wide people and
 * access feeds from crossing hotel boundaries when legacy topology is corrupt. */
export function assertExactSingleHotelRelationshipScope(input: {
  selectedPropertyId: string;
  relationships: readonly AdminPreviewPrimaryRelationship[];
  now?: Date;
}): void {
  if (input.relationships.some((relationship) => (
    relationship.propertyId !== input.selectedPropertyId
  ))) {
    throw new UnavailableAdminCompanyPreviewTargetError(
      'The independent hotel access anchor contains another hotel relationship',
    );
  }
  const now = input.now ?? new Date();
  const hasActiveSelectedRelationship = input.relationships.some((relationship) => (
    relationship.propertyId === input.selectedPropertyId
    && adminPreviewWindowIsActive(relationship.startsAt, relationship.endsAt, now)
  ));
  if (!hasActiveSelectedRelationship) {
    throw new UnavailableAdminCompanyPreviewTargetError(
      'The independent hotel access anchor is missing its active hotel relationship',
    );
  }
}

function startsNowOrEarlier(value: string | null, nowMs: number): boolean {
  if (!value) return true;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

export function adminPreviewWindowIsActive(
  startsAt: string | null,
  endsAt: string | null,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  if (!startsNowOrEarlier(startsAt, nowMs)) return false;
  if (!endsAt) return true;
  const parsedEnd = Date.parse(endsAt);
  return Number.isFinite(parsedEnd) && parsedEnd > nowMs;
}

/**
 * Resolve the customer management realm for one admin-selected hotel without
 * treating the Staxis administrator as a customer organization member.
 *
 * A current primary relationship to a real organization produces Company Hub.
 * Otherwise the exact hidden single-hotel anchor (when present) produces My
 * Hotel. Multiple current real primaries are a topology error and fail closed.
 */
export function resolveAdminCompanyPreviewTarget(input: {
  property: AdminPreviewPropertyTarget;
  relationships: readonly AdminPreviewPrimaryRelationship[];
  organizations: readonly AdminPreviewOrganizationTarget[];
  now?: Date;
}): AdminCompanyPreviewTarget {
  const now = input.now ?? new Date();
  const organizationById = new Map(input.organizations.map((organization) => [
    organization.id,
    organization,
  ]));
  const currentPrimary = input.relationships.filter((relationship) => (
    relationship.propertyId === input.property.id
    && relationship.isPrimaryGrouping
    && adminPreviewWindowIsActive(relationship.startsAt, relationship.endsAt, now)
  ));

  for (const relationship of currentPrimary) {
    if (!organizationById.has(relationship.organizationId)) {
      throw new UnavailableAdminCompanyPreviewTargetError(
        'A current primary relationship points to an unavailable organization',
      );
    }
  }

  const realPrimaryRelationships = currentPrimary.filter((relationship) => (
    organizationById.get(relationship.organizationId)?.organizationType !== 'single_hotel'
  ));
  if (realPrimaryRelationships.length > 1) {
    throw new AmbiguousAdminCompanyPreviewTargetError();
  }
  if (realPrimaryRelationships.length === 1) {
    const organization = organizationById.get(realPrimaryRelationships[0].organizationId)!;
    if (organization.status !== 'active') {
      throw new UnavailableAdminCompanyPreviewTargetError(
        'The hotel\'s primary organization is not active',
      );
    }
    return { scope: 'organization', property: input.property, organization };
  }

  const inconsistentPrimaryAnchor = currentPrimary.some((relationship) => {
    const organization = organizationById.get(relationship.organizationId);
    return organization?.organizationType === 'single_hotel'
      && organization.legacyPropertyId !== input.property.id;
  });
  if (inconsistentPrimaryAnchor) {
    throw new UnavailableAdminCompanyPreviewTargetError(
      'The hotel\'s primary single-hotel anchor does not match the selected hotel',
    );
  }

  const anchors = input.organizations.filter((organization) => (
    organization.organizationType === 'single_hotel'
    && organization.legacyPropertyId === input.property.id
  ));
  if (anchors.length > 1) {
    throw new AmbiguousAdminCompanyPreviewTargetError(
      'The hotel has more than one single-hotel access anchor',
    );
  }
  const anchor = anchors[0] ?? null;
  if (anchor && anchor.status !== 'active') {
    throw new UnavailableAdminCompanyPreviewTargetError(
      'The hotel\'s single-hotel access anchor is not active',
    );
  }
  return { scope: 'property', property: input.property, organization: anchor };
}

/**
 * What a Staxis administrator may do in the hotel they opened from Admin.
 *
 * The product is in its build phase and there is no look-but-don't-touch admin
 * mode: an admin gets every HOTEL action the hotel's own owner would get. The
 * hotel-team routes behind these flags (GET/POST /api/auth/team,
 * /api/auth/invites, /api/auth/join-codes) already admit a platform admin at
 * any hotel, so what is offered here is exactly what the server will honour.
 *
 * The two company-scope flags stay false, and that is NOT a lockout:
 *   • `manageAccess` — customer company MEMBERSHIP administration. Its routes
 *     require an active organization membership, and a platform admin cannot
 *     hold one (migration 0325 raises 42501 on the attempt). Advertising these
 *     would show buttons the server refuses.
 *   • `requestAccess` — petitioning for access an admin already has.
 */
export function adminPreviewPermissions(propertyId: string): CompanyAccessPermissions {
  return {
    viewHotels: true,
    viewPeople: true,
    managePeople: true,
    manageInvitations: true,
    accountInvitePropertyIds: [propertyId],
    viewAccess: true,
    manageAccess: false,
    viewActivity: true,
    requestAccess: false,
    availableProfiles: [],
    delegationPolicies: [],
  };
}

/**
 * Final shaping applied immediately before an admin view leaves the API.
 *
 * Every HOTEL action is granted through `adminPreviewPermissions`. Two things
 * are still closed here, deliberately, and neither is a capability lockout:
 *
 *   1. The administrator's own row is dropped and no row is marked as them. A
 *      Staxis account is not one of the hotel's people.
 *   2. Customer company-MEMBERSHIP actions (suspend/resume/remove a membership,
 *      revoke a grant, cancel an invitation, review a request) and effective
 *      access receipts stay closed. Those routes require an active organization
 *      membership that migration 0325 forbids an admin to hold, so offering
 *      them would advertise actions the server refuses, and claiming a receipt
 *      would put a Staxis account into a customer's access history.
 *
 * The builder already leaves these false; asserting it here keeps the rule in
 * one readable place instead of spread across the projection.
 */
export function applyAdminCompanyAccessPowers(input: {
  projection: CompanyAccessData;
  viewerContext: AdminCompanyPreviewViewerContext;
  adminAccountId: string;
}): AdminCompanyAccessPreviewData {
  return {
    ...input.projection,
    memberships: input.projection.memberships
      .filter((membership) => membership.accountId !== input.adminAccountId)
      .map((membership) => ({
        ...membership,
        isCurrentUser: false,
        canSuspend: false,
        canResume: false,
        canRemove: false,
        grants: (membership.grants ?? []).map((grant) => ({
          ...grant,
          canRevoke: false,
        })),
      })),
    accessHistory: (input.projection.accessHistory ?? []).map((entry) => ({
      ...entry,
      record: { ...entry.record, canRevoke: false },
    })),
    effectiveAccess: [],
    invitations: input.projection.invitations.map((invitation) => ({
      ...invitation,
      canCancel: false,
    })),
    requests: input.projection.requests.map((request) => ({
      ...request,
      canReview: false,
    })),
    permissions: adminPreviewPermissions(input.viewerContext.requestedPropertyId),
    viewerContext: input.viewerContext,
  };
}
