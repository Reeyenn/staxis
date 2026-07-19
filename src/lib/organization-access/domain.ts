/**
 * Pure domain vocabulary for the normalized organization-access model.
 *
 * Job categories describe a person. Access profiles + scopes authorize them.
 * Keep this module I/O-free so API routes, migrations tests, and UI DTO mappers
 * can share the same closed vocabulary without importing server credentials.
 */

export const ORGANIZATION_TYPES = [
  'management_company',
  'ownership_group',
  'single_hotel',
  'brand',
  'vendor',
  'other',
] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export const JOB_CATEGORIES = [
  'owner_principal',
  'executive',
  'operations',
  'regional_manager',
  'asset_manager',
  'general_manager',
  'assistant_general_manager',
  'revenue',
  'finance',
  'human_resources',
  'information_technology',
  'department_head',
  'hotel_employee',
  'consultant',
  'other',
] as const;
export type JobCategory = (typeof JOB_CATEGORIES)[number];

export const ACCESS_PROFILES = [
  'organization_owner',
  'organization_admin',
  'portfolio_manager',
  'property_manager',
  'department_lead',
  'contributor',
  'viewer',
  'external_collaborator',
] as const;
export type AccessProfile = (typeof ACCESS_PROFILES)[number];

export const ACCESS_SCOPE_TYPES = ['organization', 'portfolio', 'property'] as const;
export type AccessScopeType = (typeof ACCESS_SCOPE_TYPES)[number];

export const ORGANIZATION_CAPABILITIES = [
  'view_company',
  'view_properties',
  'view_people',
  'view_access',
  'view_activity',
  'manage_people',
  'manage_access',
  'manage_portfolios',
  'manage_properties',
  'manage_company',
  'manage_billing',
  'transfer_ownership',
] as const;
export type OrganizationCapability = (typeof ORGANIZATION_CAPABILITIES)[number];

const ALL_CAPABILITIES: readonly OrganizationCapability[] = ORGANIZATION_CAPABILITIES;

/** Organization-level capabilities. Hotel feature capabilities remain in the
 * existing capability registry and are applied after this scope decision. */
export const ACCESS_PROFILE_CAPABILITIES: Readonly<
  Record<AccessProfile, readonly OrganizationCapability[]>
> = {
  organization_owner: ALL_CAPABILITIES,
  organization_admin: ALL_CAPABILITIES.filter(
    (capability) => capability !== 'manage_billing' && capability !== 'transfer_ownership',
  ),
  portfolio_manager: [
    'view_company',
    'view_properties',
    'view_people',
    'view_access',
    'view_activity',
    'manage_people',
    'manage_access',
    'manage_portfolios',
  ],
  property_manager: [
    'view_company',
    'view_properties',
    'view_people',
    'view_access',
    'view_activity',
    'manage_people',
    'manage_access',
  ],
  department_lead: ['view_company', 'view_properties', 'view_people'],
  contributor: ['view_company', 'view_properties'],
  viewer: ['view_company', 'view_properties'],
  external_collaborator: ['view_company', 'view_properties'],
};

/** Profiles a holder may delegate. Scope containment is checked separately. */
export const DELEGATABLE_PROFILES: Readonly<Record<AccessProfile, readonly AccessProfile[]>> = {
  organization_owner: ACCESS_PROFILES,
  organization_admin: [
    'portfolio_manager',
    'property_manager',
    'department_lead',
    'contributor',
    'viewer',
    'external_collaborator',
  ],
  portfolio_manager: [
    'property_manager',
    'department_lead',
    'contributor',
    'viewer',
    'external_collaborator',
  ],
  property_manager: ['department_lead', 'contributor', 'viewer', 'external_collaborator'],
  department_lead: [],
  contributor: [],
  viewer: [],
  external_collaborator: [],
};

export function isOrganizationType(value: unknown): value is OrganizationType {
  return typeof value === 'string' && (ORGANIZATION_TYPES as readonly string[]).includes(value);
}

export function isJobCategory(value: unknown): value is JobCategory {
  return typeof value === 'string' && (JOB_CATEGORIES as readonly string[]).includes(value);
}

export function isAccessProfile(value: unknown): value is AccessProfile {
  return typeof value === 'string' && (ACCESS_PROFILES as readonly string[]).includes(value);
}

export function isAccessScopeType(value: unknown): value is AccessScopeType {
  return typeof value === 'string' && (ACCESS_SCOPE_TYPES as readonly string[]).includes(value);
}

export function isOrganizationCapability(value: unknown): value is OrganizationCapability {
  return typeof value === 'string'
    && (ORGANIZATION_CAPABILITIES as readonly string[]).includes(value);
}
