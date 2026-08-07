import type { AppRole } from '@/lib/roles';

export type OrganizationKind =
  | 'management_company'
  | 'ownership_group'
  | 'single_hotel'
  | 'brand'
  | 'vendor'
  | 'other';

export type OrganizationStatus = 'active' | 'pending' | 'suspended' | 'inactive';
export type CompanyItemStatus = 'active' | 'pending' | 'expiring' | 'expired' | 'revoked' | 'inactive' | 'suspended';
export type AccessScopeType = 'organization' | 'portfolio' | 'property';
export type CompanyAccessSource = 'direct' | 'company';
export type CompanyAccessRecordStatus = CompanyItemStatus | 'approved' | 'denied' | 'cancelled';

export interface CompanyOrganization {
  id: string;
  name: string;
  type: OrganizationKind;
  status: OrganizationStatus;
  relationshipType?: string | null;
  /** Legacy single-property organizations are rendered as hotel context, not a fake company. */
  legacyPropertyId?: string | null;
}

export interface CompanyPortfolio {
  id: string;
  organizationId: string;
  name: string;
  parentId?: string | null;
  propertyIds: string[];
}

export interface CompanyProperty {
  /** Unique relationship node; a hotel can appear once in each organization. */
  nodeId: string;
  id: string;
  name: string;
  organizationId?: string | null;
  portfolioIds: string[];
  relationshipType?: string | null;
  relationshipId?: string | null;
  status: CompanyItemStatus;
  /**
   * The real management company that operates this hotel, when the caller's own
   * view of it comes only through the hidden single-hotel compatibility anchor.
   *
   * It exists so the hub stops lying to a hotel employee. The Hub filed every
   * anchor-visible hotel under "Hotels not grouped under a management company" —
   * which for a front-desk person at a hotel run by a real operator is simply
   * false, and it is false in the most confusing possible direction: they were
   * told nobody runs their hotel. The company's NAME is all this carries. Its
   * other hotels, its people and its access are not here and are not reachable
   * from here — the caller has no membership at that company and gains none.
   */
  operatingCompanyName?: string | null;
}

/** One active grant the signed-in manager is allowed to inspect for a visible
 * member. `canRevoke` is computed by the server for this exact grant and must
 * never be inferred from a page-level permission. */
export interface CompanyManagedGrant {
  id: string;
  accessProfile: string;
  scopeType: AccessScopeType;
  scopeLabel: string;
  propertyIds: string[];
  expiresAt?: string | null;
  canRevoke: boolean;
  /** Presentation provenance for the one effective-access answer. */
  source?: CompanyAccessSource;
  status?: CompanyAccessRecordStatus;
  startsAt?: string | null;
  grantedBy?: string | null;
  reason?: string | null;
  /** True when the row is derived from the person's current company job. */
  isMembershipAccess?: boolean;
}

export interface CompanyMembership {
  id: string;
  organizationId: string;
  accountId: string;
  displayName: string;
  jobCategory?: string | null;
  jobTitle?: string | null;
  accessProfile?: string | null;
  accessSource?: CompanyAccessSource;
  accessScopeType?: AccessScopeType;
  status: CompanyItemStatus;
  propertyIds: string[];
  isCurrentUser?: boolean;
  grants: CompanyManagedGrant[];
  /** Exact server-authorized lifecycle actions for this membership. */
  canSuspend: boolean;
  canResume: boolean;
  canRemove: boolean;
}

export interface EffectiveAccessReceipt {
  id: string;
  organizationId?: string | null;
  accessProfile: string;
  scopeType: AccessScopeType;
  scopeId?: string | null;
  scopeLabel: string;
  propertyIds: string[];
  source: string;
  grantedBy?: string | null;
  expiresAt?: string | null;
  reason?: string | null;
  jobTitle?: string | null;
  status: CompanyItemStatus;
}

/** Historical effective-access provenance for the selected company scope. It
 * is additive display data only; authorization still comes from the existing
 * normalized rows and guarded mutation contracts. */
export interface CompanyAccessHistoryEntry {
  id: string;
  organizationId: string;
  membershipId: string;
  accountId: string;
  displayName: string;
  jobTitle?: string | null;
  record: CompanyManagedGrant;
}

export interface CompanyInvitation {
  id: string;
  organizationId?: string | null;
  email: string;
  accessProfile: string;
  scopeLabel: string;
  propertyIds: string[];
  status: CompanyItemStatus;
  expiresAt?: string | null;
  invitedBy?: string | null;
  /** True only when this caller may cancel this exact pending invitation. */
  canCancel: boolean;
}

export interface CompanyAccessRequest {
  id: string;
  organizationId?: string | null;
  requesterAccountId?: string | null;
  scopeType?: AccessScopeType;
  requesterName: string;
  requestedProfile: string;
  scopeLabel: string;
  propertyIds: string[];
  reason?: string | null;
  status: CompanyItemStatus | 'approved' | 'denied' | 'cancelled';
  createdAt: string;
  /** True only when this caller may review this exact profile + scope now. */
  canReview?: boolean;
}

export interface CompanyActivityEvent {
  id: string;
  organizationId?: string | null;
  actorName: string;
  action: string;
  summary: string;
  createdAt: string;
  propertyId?: string | null;
}

/** Exact, server-authorized delegation surface for one profile in one
 * organization. The client must not infer this by combining grants from
 * different organizations. */
export interface CompanyDelegationProfilePolicy {
  accessProfile: string;
  organizationScope: boolean;
  portfolioIds: string[];
  propertyIds: string[];
}

export interface CompanyDelegationPolicy {
  organizationId: string;
  profiles: CompanyDelegationProfilePolicy[];
}

export interface CompanyAccessPermissions {
  viewHotels: boolean;
  viewPeople: boolean;
  managePeople: boolean;
  manageInvitations: boolean;
  /** Exact hotel anchors at which the guarded account-invitation workflow may
   * be offered. This is presentation only; every request re-resolves authority. */
  accountInvitePropertyIds?: string[];
  viewAccess: boolean;
  manageAccess: boolean;
  viewActivity: boolean;
  requestAccess: boolean;
  /** Server-filtered profile keys the caller is allowed to grant. */
  availableProfiles: string[];
  /** Server-filtered profiles and contained targets, kept separate per org. */
  delegationPolicies: CompanyDelegationPolicy[];
}

/** Server-authenticated context for Staxis administrators viewing the
 * customer-facing Company Hub for one hotel. It is an identity label, never a
 * customer membership or access receipt: an admin holds full power at every
 * hotel, so `readOnly` is false and the hotel actions are all offered. */
export interface CompanyAccessViewerContext {
  kind: 'staxis_admin_preview';
  readOnly: boolean;
  requestedPropertyId: string;
  scope: 'organization' | 'property';
  targetId: string;
  targetName: string;
}

export interface CompanyAccessData {
  organizations: CompanyOrganization[];
  portfolios: CompanyPortfolio[];
  properties: CompanyProperty[];
  memberships: CompanyMembership[];
  effectiveAccess: EffectiveAccessReceipt[];
  /** Current-scope history from the same authoritative access rows/feed. */
  accessHistory?: CompanyAccessHistoryEntry[];
  invitations: CompanyInvitation[];
  requests: CompanyAccessRequest[];
  activity: CompanyActivityEvent[];
  permissions: CompanyAccessPermissions;
  /** True when the normalized organization schema was unavailable and legacy access was projected. */
  legacyFallback: boolean;
  /** Present only for the separately authorized Staxis admin preview route. */
  viewerContext?: CompanyAccessViewerContext;
}

export const EMPTY_COMPANY_ACCESS: CompanyAccessData = {
  organizations: [],
  portfolios: [],
  properties: [],
  memberships: [],
  effectiveAccess: [],
  invitations: [],
  requests: [],
  activity: [],
  permissions: {
    viewHotels: true,
    viewPeople: false,
    managePeople: false,
    manageInvitations: false,
    accountInvitePropertyIds: [],
    viewAccess: true,
    manageAccess: false,
    viewActivity: false,
    requestAccess: false,
    availableProfiles: [],
    delegationPolicies: [],
  },
  legacyFallback: false,
};

export function legacyAccessProfile(role: AppRole): string {
  switch (role) {
    case 'admin': return 'Staxis Administrator';
    case 'owner': return 'Property Owner';
    case 'general_manager': return 'Property Manager';
    case 'front_desk': return 'Front Desk';
    case 'housekeeping': return 'Housekeeping';
    case 'maintenance': return 'Maintenance';
    case 'staff': return 'Team Member';
  }
}

export function titleCaseAccessValue(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
