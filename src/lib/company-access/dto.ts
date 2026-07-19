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
}

export interface CompanyMembership {
  id: string;
  organizationId: string;
  accountId: string;
  displayName: string;
  jobCategory?: string | null;
  jobTitle?: string | null;
  accessProfile?: string | null;
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
  viewAccess: boolean;
  manageAccess: boolean;
  viewActivity: boolean;
  requestAccess: boolean;
  /** Server-filtered profile keys the caller is allowed to grant. */
  availableProfiles: string[];
  /** Server-filtered profiles and contained targets, kept separate per org. */
  delegationPolicies: CompanyDelegationPolicy[];
}

export interface CompanyAccessData {
  organizations: CompanyOrganization[];
  portfolios: CompanyPortfolio[];
  properties: CompanyProperty[];
  memberships: CompanyMembership[];
  effectiveAccess: EffectiveAccessReceipt[];
  invitations: CompanyInvitation[];
  requests: CompanyAccessRequest[];
  activity: CompanyActivityEvent[];
  permissions: CompanyAccessPermissions;
  /** True when the normalized organization schema was unavailable and legacy access was projected. */
  legacyFallback: boolean;
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
