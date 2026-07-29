import { isUuid } from '@/lib/api-validate';
import {
  isAccessProfile,
  type AccessProfile,
  type AccessScopeType,
} from '@/lib/organization-access/domain';
import {
  isHatRole,
  isMembershipScope,
  scopeAllowsRole,
} from '@/lib/company/roles';

export const COMPANY_ACCESS_EDITOR_SCHEMA_VERSION = 'company-access-editor-v2' as const;

export type CompanyAccessEditOperation = 'replace' | 'add';
export type CompanyAccessEditScopeKind = 'organization' | 'portfolio' | 'selected_properties';

export interface CompanyAccessEditorProfilePolicy {
  accessProfile: AccessProfile;
  organizationScope: boolean;
  portfolioIds: string[];
  propertyIds: string[];
}

export interface CompanyAccessEditorProperty {
  id: string;
  name: string;
}

export interface CompanyAccessEditorPortfolio {
  id: string;
  name: string;
  type: 'portfolio' | 'region' | 'division' | 'other';
  propertyIds: string[];
}

export interface CompanyAccessEditorGrant {
  id: string;
  accessProfile: AccessProfile;
  scopeType: AccessScopeType;
  portfolioId: string | null;
  propertyId: string | null;
  startsAt: string;
  expiresAt: string | null;
}

export interface CompanyAccessEditorMembership {
  id: string;
  accessRevision: string;
  /** The old hat is converted atomically on replacement; grant_set is edited in place. */
  sourceKind: 'grant_set' | 'membership_hat';
  sourceRole: string | null;
  sourceScope: 'company' | 'property' | null;
  canAdd: boolean;
  canReplace: boolean;
  blockedReason: string | null;
  currentGrants: CompanyAccessEditorGrant[];
}

export interface CompanyAccessEditorOrganization {
  id: string;
  name: string;
  accessEpoch: number;
  profilePolicies: CompanyAccessEditorProfilePolicy[];
  portfolios: CompanyAccessEditorPortfolio[];
  properties: CompanyAccessEditorProperty[];
  memberships: CompanyAccessEditorMembership[];
}

export interface CompanyAccessEditorProjection {
  schemaVersion: typeof COMPANY_ACCESS_EDITOR_SCHEMA_VERSION;
  generatedAt: string;
  organizations: CompanyAccessEditorOrganization[];
}

export interface CompanyAccessEditInput {
  organizationId: string;
  membershipId: string;
  operation: CompanyAccessEditOperation;
  accessProfile: AccessProfile;
  scopeKind: CompanyAccessEditScopeKind;
  portfolioId: string | null;
  propertyIds: string[];
  expiresAt: string | null;
  expectedAccessEpoch: number;
  expectedAccessRevision: string;
}

export interface CompanyAccessEditPreview extends CompanyAccessEditInput {
  organizationName: string;
  memberName: string;
  currentGrantCount: number;
  retainedGrantCount: number;
  revokedGrantCount: number;
  upsertedGrantCount: number;
  beforePropertyIds: string[];
  afterPropertyIds: string[];
  gainingPropertyIds: string[];
  losingPropertyIds: string[];
  accessChangesImmediately: true;
  previewFingerprint: string;
}

export interface CompanyAccessEditCommitInput extends CompanyAccessEditInput {
  previewFingerprint: string;
  confirmed: true;
}

export interface CompanyAccessEditCommitResult {
  schemaVersion: typeof COMPANY_ACCESS_EDITOR_SCHEMA_VERSION;
  organizationId: string;
  membershipId: string;
  accessEpoch: number;
  accessRevision: string;
  changed: boolean;
  idempotentReplay: boolean;
  auditRequestId: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = new Set(expected);
  return Object.keys(record).every((key) => keys.has(key));
}

function uniqueUuidArray(
  value: unknown,
  field: string,
  options: { allowEmpty: boolean; max?: number } = { allowEmpty: true },
): ValidationResult<string[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be an array` };
  if (!options.allowEmpty && value.length === 0) {
    return { ok: false, error: `${field} must include at least one hotel` };
  }
  if (value.length > (options.max ?? 500)) return { ok: false, error: `${field} is too large` };
  if (!value.every(isUuid)) return { ok: false, error: `${field} contains an invalid id` };
  const normalized = [...new Set(value as string[])].sort();
  if (normalized.length !== value.length) {
    return { ok: false, error: `${field} contains duplicate ids` };
  }
  return { ok: true, value: normalized };
}

function profileMatchesScope(profile: AccessProfile, scope: CompanyAccessEditScopeKind): boolean {
  if (profile === 'organization_owner' || profile === 'organization_admin') {
    return scope === 'organization';
  }
  if (profile === 'portfolio_manager') return scope === 'portfolio';
  if (profile === 'property_manager') return scope === 'selected_properties';
  return true;
}

export function validateCompanyAccessEditInput(
  value: unknown,
  now = new Date(),
): ValidationResult<CompanyAccessEditInput> {
  const body = recordOf(value);
  if (!body || !hasOnlyKeys(body, [
    'organizationId',
    'membershipId',
    'operation',
    'accessProfile',
    'scopeKind',
    'portfolioId',
    'propertyIds',
    'expiresAt',
    'expectedAccessEpoch',
    'expectedAccessRevision',
  ])) {
    return { ok: false, error: 'Request body must contain only the documented access fields' };
  }
  if (!isUuid(body.organizationId)) {
    return { ok: false, error: 'organizationId must be a valid UUID' };
  }
  if (!isUuid(body.membershipId)) {
    return { ok: false, error: 'membershipId must be a valid UUID' };
  }
  if (body.operation !== 'replace' && body.operation !== 'add') {
    return { ok: false, error: 'operation must be replace or add' };
  }
  if (!isAccessProfile(body.accessProfile)) {
    return { ok: false, error: 'accessProfile is invalid' };
  }
  if (body.scopeKind !== 'organization'
      && body.scopeKind !== 'portfolio'
      && body.scopeKind !== 'selected_properties') {
    return { ok: false, error: 'scopeKind is invalid' };
  }
  if (!profileMatchesScope(body.accessProfile, body.scopeKind)) {
    return { ok: false, error: 'That access profile cannot use the selected scope' };
  }

  const propertyIds = uniqueUuidArray(body.propertyIds, 'propertyIds', {
    allowEmpty: body.scopeKind !== 'selected_properties',
    max: 500,
  });
  if (!propertyIds.ok) return propertyIds;

  let portfolioId: string | null = null;
  if (body.scopeKind === 'portfolio') {
    if (!isUuid(body.portfolioId)) {
      return { ok: false, error: 'portfolioId must be a valid UUID for portfolio scope' };
    }
    if (propertyIds.value.length !== 0) {
      return { ok: false, error: 'Portfolio scope cannot include selected hotels' };
    }
    portfolioId = body.portfolioId;
  } else if (body.portfolioId !== null) {
    return { ok: false, error: 'portfolioId must be null outside portfolio scope' };
  } else if (body.scopeKind === 'organization' && propertyIds.value.length !== 0) {
    return { ok: false, error: 'Whole-company scope cannot include selected hotels' };
  }

  let expiresAt: string | null = null;
  if (body.expiresAt !== null) {
    if (typeof body.expiresAt !== 'string') {
      return { ok: false, error: 'expiresAt must be an ISO timestamp or null' };
    }
    const parsed = new Date(body.expiresAt);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
      return { ok: false, error: 'expiresAt must be in the future' };
    }
    expiresAt = parsed.toISOString();
  }
  if (body.accessProfile === 'organization_owner' && expiresAt !== null) {
    return { ok: false, error: 'Organization owner access cannot expire' };
  }
  if (body.accessProfile === 'external_collaborator' && expiresAt === null) {
    return { ok: false, error: 'External collaborator access requires an expiration' };
  }
  if (!Number.isSafeInteger(body.expectedAccessEpoch) || Number(body.expectedAccessEpoch) <= 0) {
    return { ok: false, error: 'expectedAccessEpoch must be a positive integer' };
  }
  if (typeof body.expectedAccessRevision !== 'string'
      || !/^[0-9a-f]{64}$/.test(body.expectedAccessRevision)) {
    return { ok: false, error: 'expectedAccessRevision is invalid' };
  }

  return {
    ok: true,
    value: {
      organizationId: body.organizationId,
      membershipId: body.membershipId,
      operation: body.operation,
      accessProfile: body.accessProfile,
      scopeKind: body.scopeKind,
      portfolioId,
      propertyIds: propertyIds.value,
      expiresAt,
      expectedAccessEpoch: Number(body.expectedAccessEpoch),
      expectedAccessRevision: body.expectedAccessRevision,
    },
  };
}

export function validateCompanyAccessEditCommitInput(
  value: unknown,
  now = new Date(),
): ValidationResult<CompanyAccessEditCommitInput> {
  const body = recordOf(value);
  if (!body || !hasOnlyKeys(body, [
    'organizationId',
    'membershipId',
    'operation',
    'accessProfile',
    'scopeKind',
    'portfolioId',
    'propertyIds',
    'expiresAt',
    'expectedAccessEpoch',
    'expectedAccessRevision',
    'previewFingerprint',
    'confirmed',
  ])) {
    return { ok: false, error: 'Request body must contain only the documented confirmation fields' };
  }
  const base = validateCompanyAccessEditInput({
    organizationId: body.organizationId,
    membershipId: body.membershipId,
    operation: body.operation,
    accessProfile: body.accessProfile,
    scopeKind: body.scopeKind,
    portfolioId: body.portfolioId,
    propertyIds: body.propertyIds,
    expiresAt: body.expiresAt,
    expectedAccessEpoch: body.expectedAccessEpoch,
    expectedAccessRevision: body.expectedAccessRevision,
  }, now);
  if (!base.ok) return base;
  if (body.confirmed !== true) return { ok: false, error: 'Explicit confirmation is required' };
  if (typeof body.previewFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(body.previewFingerprint)) {
    return { ok: false, error: 'previewFingerprint is invalid' };
  }
  return {
    ok: true,
    value: {
      ...base.value,
      previewFingerprint: body.previewFingerprint,
      confirmed: true,
    },
  };
}

export function validateCompanyAccessEditorIdempotencyKey(
  value: string | null,
): ValidationResult<string> {
  return isUuid(value)
    ? { ok: true, value }
    : { ok: false, error: 'Idempotency-Key must be a UUID' };
}

function stringArray(value: unknown, max = 500): string[] | null {
  if (!Array.isArray(value) || value.length > max || !value.every(isUuid)) return null;
  const normalized = [...new Set(value as string[])].sort();
  return normalized.length === value.length ? normalized : null;
}

function parseGrant(value: unknown): CompanyAccessEditorGrant | null {
  const row = recordOf(value);
  if (!row
      || !isUuid(row.id)
      || !isAccessProfile(row.accessProfile)
      || !['organization', 'portfolio', 'property'].includes(String(row.scopeType))
      || (row.portfolioId !== null && !isUuid(row.portfolioId))
      || (row.propertyId !== null && !isUuid(row.propertyId))
      || typeof row.startsAt !== 'string'
      || (row.expiresAt !== null && typeof row.expiresAt !== 'string')) return null;
  return {
    id: row.id,
    accessProfile: row.accessProfile,
    scopeType: row.scopeType as AccessScopeType,
    portfolioId: row.portfolioId as string | null,
    propertyId: row.propertyId as string | null,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt as string | null,
  };
}

/** Fail closed when the database SECURITY DEFINER response drifts. */
export function parseCompanyAccessEditorProjection(
  value: unknown,
): CompanyAccessEditorProjection | null {
  const root = recordOf(value);
  if (!root
      || root.schemaVersion !== COMPANY_ACCESS_EDITOR_SCHEMA_VERSION
      || typeof root.generatedAt !== 'string'
      || !Array.isArray(root.organizations)) return null;

  const organizations: CompanyAccessEditorOrganization[] = [];
  for (const valueOrganization of root.organizations) {
    const organization = recordOf(valueOrganization);
    if (!organization
        || !isUuid(organization.id)
        || typeof organization.name !== 'string'
        || !Number.isSafeInteger(organization.accessEpoch)
        || Number(organization.accessEpoch) <= 0
        || !Array.isArray(organization.profilePolicies)
        || !Array.isArray(organization.portfolios)
        || !Array.isArray(organization.properties)
        || !Array.isArray(organization.memberships)) return null;

    const profilePolicies: CompanyAccessEditorProfilePolicy[] = [];
    for (const valuePolicy of organization.profilePolicies) {
      const policy = recordOf(valuePolicy);
      const portfolioIds = stringArray(policy?.portfolioIds);
      const propertyIds = stringArray(policy?.propertyIds);
      if (!policy
          || !isAccessProfile(policy.accessProfile)
          || typeof policy.organizationScope !== 'boolean'
          || !portfolioIds
          || !propertyIds) return null;
      profilePolicies.push({
        accessProfile: policy.accessProfile,
        organizationScope: policy.organizationScope,
        portfolioIds,
        propertyIds,
      });
    }

    const properties: CompanyAccessEditorProperty[] = [];
    for (const valueProperty of organization.properties) {
      const property = recordOf(valueProperty);
      if (!property || !isUuid(property.id) || typeof property.name !== 'string') return null;
      properties.push({ id: property.id, name: property.name });
    }

    const portfolios: CompanyAccessEditorPortfolio[] = [];
    for (const valuePortfolio of organization.portfolios) {
      const portfolio = recordOf(valuePortfolio);
      const propertyIds = stringArray(portfolio?.propertyIds);
      if (!portfolio
          || !isUuid(portfolio.id)
          || typeof portfolio.name !== 'string'
          || !['portfolio', 'region', 'division', 'other'].includes(String(portfolio.type))
          || !propertyIds) return null;
      portfolios.push({
        id: portfolio.id,
        name: portfolio.name,
        type: portfolio.type as CompanyAccessEditorPortfolio['type'],
        propertyIds,
      });
    }

    const memberships: CompanyAccessEditorMembership[] = [];
    for (const valueMembership of organization.memberships) {
      const membership = recordOf(valueMembership);
      if (!membership
          || !isUuid(membership.id)
          || typeof membership.accessRevision !== 'string'
          || !/^[0-9a-f]{64}$/.test(membership.accessRevision)
          || (membership.sourceKind !== 'grant_set'
            && membership.sourceKind !== 'membership_hat')
          || typeof membership.canAdd !== 'boolean'
          || typeof membership.canReplace !== 'boolean'
          || (membership.blockedReason !== null && typeof membership.blockedReason !== 'string')
          || !Array.isArray(membership.currentGrants)) return null;
      const grantSetSource = membership.sourceKind === 'grant_set'
        && membership.sourceRole === null
        && membership.sourceScope === null;
      const hatSource = membership.sourceKind === 'membership_hat'
        && isHatRole(membership.sourceRole)
        && isMembershipScope(membership.sourceScope)
        && scopeAllowsRole(membership.sourceScope, membership.sourceRole)
        && membership.canAdd === false;
      if (!grantSetSource && !hatSource) return null;
      const currentGrants = membership.currentGrants.map(parseGrant);
      if (currentGrants.some((grant) => grant === null)) return null;
      memberships.push({
        id: membership.id,
        accessRevision: membership.accessRevision,
        sourceKind: membership.sourceKind,
        sourceRole: membership.sourceRole as string | null,
        sourceScope: membership.sourceScope as 'company' | 'property' | null,
        canAdd: membership.canAdd,
        canReplace: membership.canReplace,
        blockedReason: membership.blockedReason as string | null,
        currentGrants: currentGrants as CompanyAccessEditorGrant[],
      });
    }

    organizations.push({
      id: organization.id,
      name: organization.name,
      accessEpoch: Number(organization.accessEpoch),
      profilePolicies,
      portfolios,
      properties,
      memberships,
    });
  }
  return {
    schemaVersion: COMPANY_ACCESS_EDITOR_SCHEMA_VERSION,
    generatedAt: root.generatedAt,
    organizations,
  };
}

export function parseCompanyAccessEditPreview(value: unknown): CompanyAccessEditPreview | null {
  const row = recordOf(value);
  const base = validateCompanyAccessEditInput(row ? {
    organizationId: row.organizationId,
    membershipId: row.membershipId,
    operation: row.operation,
    accessProfile: row.accessProfile,
    scopeKind: row.scopeKind,
    portfolioId: row.portfolioId,
    propertyIds: row.propertyIds,
    expiresAt: row.expiresAt,
    expectedAccessEpoch: row.expectedAccessEpoch,
    expectedAccessRevision: row.expectedAccessRevision,
  } : null, new Date(0));
  const beforePropertyIds = stringArray(row?.beforePropertyIds, 5000);
  const afterPropertyIds = stringArray(row?.afterPropertyIds, 5000);
  const gainingPropertyIds = stringArray(row?.gainingPropertyIds, 5000);
  const losingPropertyIds = stringArray(row?.losingPropertyIds, 5000);
  if (!row || !base.ok
      || typeof row.organizationName !== 'string'
      || typeof row.memberName !== 'string'
      || !Number.isSafeInteger(row.currentGrantCount)
      || !Number.isSafeInteger(row.retainedGrantCount)
      || !Number.isSafeInteger(row.revokedGrantCount)
      || !Number.isSafeInteger(row.upsertedGrantCount)
      || !beforePropertyIds
      || !afterPropertyIds
      || !gainingPropertyIds
      || !losingPropertyIds
      || row.accessChangesImmediately !== true
      || typeof row.previewFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(row.previewFingerprint)) return null;
  return {
    ...base.value,
    organizationName: row.organizationName,
    memberName: row.memberName,
    currentGrantCount: Number(row.currentGrantCount),
    retainedGrantCount: Number(row.retainedGrantCount),
    revokedGrantCount: Number(row.revokedGrantCount),
    upsertedGrantCount: Number(row.upsertedGrantCount),
    beforePropertyIds,
    afterPropertyIds,
    gainingPropertyIds,
    losingPropertyIds,
    accessChangesImmediately: true,
    previewFingerprint: row.previewFingerprint,
  };
}

export function parseCompanyAccessEditCommitResult(
  value: unknown,
): CompanyAccessEditCommitResult | null {
  const row = recordOf(value);
  if (!row
      || row.schemaVersion !== COMPANY_ACCESS_EDITOR_SCHEMA_VERSION
      || !isUuid(row.organizationId)
      || !isUuid(row.membershipId)
      || !Number.isSafeInteger(row.accessEpoch)
      || Number(row.accessEpoch) <= 0
      || typeof row.accessRevision !== 'string'
      || !/^[0-9a-f]{64}$/.test(row.accessRevision)
      || typeof row.changed !== 'boolean'
      || typeof row.idempotentReplay !== 'boolean'
      || !isUuid(row.auditRequestId)) return null;
  return {
    schemaVersion: COMPANY_ACCESS_EDITOR_SCHEMA_VERSION,
    organizationId: row.organizationId,
    membershipId: row.membershipId,
    accessEpoch: Number(row.accessEpoch),
    accessRevision: row.accessRevision,
    changed: row.changed,
    idempotentReplay: row.idempotentReplay,
    auditRequestId: row.auditRequestId,
  };
}
