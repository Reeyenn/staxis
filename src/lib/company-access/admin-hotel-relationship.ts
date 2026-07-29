import { isUuid } from '@/lib/api-validate';

export const ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION = 'admin-hotel-relationship-v1' as const;
export const ADMIN_HOTEL_RELATIONSHIP_DIRECTORY_LIMIT = 100 as const;

export type AdminHotelRelationshipType = 'operator' | 'owner';

export interface AdminHotelRelationshipOrganization {
  id: string;
  name: string;
  type: 'management_company' | 'ownership_group';
  status: 'active';
}

export interface AdminHotelRelationshipCurrent {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationType: 'management_company' | 'ownership_group';
  relationshipType: AdminHotelRelationshipType;
  status: 'active';
  startsAt: string;
}

export interface AdminHotelRelationshipProjection {
  schemaVersion: typeof ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION;
  generatedAt: string;
  property: {
    id: string;
    name: string;
    status: string;
  };
  lifecycleStatus: 'company_managed' | 'independent';
  currentRelationship: AdminHotelRelationshipCurrent | null;
  relationshipRevision: string;
  organizationQuery: string;
  organizations: AdminHotelRelationshipOrganization[];
  organizationResultLimit: typeof ADMIN_HOTEL_RELATIONSHIP_DIRECTORY_LIMIT;
  organizationResultsTruncated: boolean;
}

export interface AdminHotelRelationshipChangeInput {
  propertyId: string;
  targetOrganizationId: string | null;
  relationshipType: AdminHotelRelationshipType | null;
  expectedRelationshipRevision: string;
}

export interface AdminHotelRelationshipImpact {
  revokedPropertyGrantCount: number;
  revokedInvitationCount: number;
  cancelledRequestCount: number;
  removedPortfolioAssignmentCount: number;
}

export interface AdminHotelRelationshipPreview extends AdminHotelRelationshipChangeInput {
  schemaVersion: typeof ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION;
  propertyName: string;
  currentRelationship: AdminHotelRelationshipCurrent | null;
  targetOrganization: AdminHotelRelationshipOrganization | null;
  lifecycleAfter: 'company_managed' | 'independent';
  changed: boolean;
  accessChangesImmediately: true;
  impact: AdminHotelRelationshipImpact;
  previewFingerprint: string;
}

export interface AdminHotelRelationshipCommitInput extends AdminHotelRelationshipChangeInput {
  previewFingerprint: string;
  confirmed: true;
}

export interface AdminHotelRelationshipCommitResult {
  schemaVersion: typeof ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION;
  propertyId: string;
  relationshipId: string | null;
  organizationId: string | null;
  relationshipType: AdminHotelRelationshipType | null;
  lifecycleStatus: 'company_managed' | 'independent';
  relationshipRevision: string;
  changed: boolean;
  idempotentReplay: boolean;
  auditRequestId: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseOrganization(value: unknown): AdminHotelRelationshipOrganization | null {
  const row = record(value);
  if (!row
      || !isUuid(row.id)
      || typeof row.name !== 'string'
      || (row.type !== 'management_company' && row.type !== 'ownership_group')
      || row.status !== 'active') return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: 'active',
  };
}

function parseCurrent(value: unknown): AdminHotelRelationshipCurrent | null | undefined {
  if (value === null) return null;
  const row = record(value);
  if (!row
      || !isUuid(row.id)
      || !isUuid(row.organizationId)
      || typeof row.organizationName !== 'string'
      || (row.organizationType !== 'management_company' && row.organizationType !== 'ownership_group')
      || (row.relationshipType !== 'operator' && row.relationshipType !== 'owner')
      || row.status !== 'active'
      || typeof row.startsAt !== 'string') return undefined;
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationType: row.organizationType,
    relationshipType: row.relationshipType,
    status: 'active',
    startsAt: row.startsAt,
  };
}

export function validateAdminHotelRelationshipQuery(
  propertyId: string | null,
  organizationQuery: string | null,
): ValidationResult<{ propertyId: string; organizationQuery: string }> {
  if (!isUuid(propertyId)) return { ok: false, error: 'pid must be a valid hotel id' };
  const query = organizationQuery?.trim() ?? '';
  if (query.length > 120) return { ok: false, error: 'Company search is too long' };
  return { ok: true, value: { propertyId, organizationQuery: query } };
}

export function validateAdminHotelRelationshipChange(
  value: unknown,
): ValidationResult<AdminHotelRelationshipChangeInput> {
  const body = record(value);
  if (!body || !exactKeys(body, [
    'propertyId',
    'targetOrganizationId',
    'relationshipType',
    'expectedRelationshipRevision',
  ])) {
    return { ok: false, error: 'Request body must contain only the documented relationship fields' };
  }
  if (!isUuid(body.propertyId)) return { ok: false, error: 'propertyId must be a valid UUID' };
  if (body.targetOrganizationId !== null && !isUuid(body.targetOrganizationId)) {
    return { ok: false, error: 'targetOrganizationId must be a valid UUID or null' };
  }
  const targetOrganizationId = body.targetOrganizationId as string | null;
  if (targetOrganizationId === null) {
    if (body.relationshipType !== null) {
      return { ok: false, error: 'relationshipType must be null when making a hotel independent' };
    }
  } else if (body.relationshipType !== 'operator' && body.relationshipType !== 'owner') {
    return { ok: false, error: 'relationshipType must be operator or owner' };
  }
  if (!isHash(body.expectedRelationshipRevision)) {
    return { ok: false, error: 'expectedRelationshipRevision is invalid' };
  }
  return {
    ok: true,
    value: {
      propertyId: body.propertyId,
      targetOrganizationId,
      relationshipType: body.relationshipType as AdminHotelRelationshipType | null,
      expectedRelationshipRevision: body.expectedRelationshipRevision,
    },
  };
}

export function validateAdminHotelRelationshipCommit(
  value: unknown,
): ValidationResult<AdminHotelRelationshipCommitInput> {
  const body = record(value);
  if (!body || !exactKeys(body, [
    'propertyId',
    'targetOrganizationId',
    'relationshipType',
    'expectedRelationshipRevision',
    'previewFingerprint',
    'confirmed',
  ])) {
    return { ok: false, error: 'Request body must contain only the documented confirmation fields' };
  }
  const base = validateAdminHotelRelationshipChange({
    propertyId: body.propertyId,
    targetOrganizationId: body.targetOrganizationId,
    relationshipType: body.relationshipType,
    expectedRelationshipRevision: body.expectedRelationshipRevision,
  });
  if (!base.ok) return base;
  if (body.confirmed !== true) return { ok: false, error: 'Explicit confirmation is required' };
  if (!isHash(body.previewFingerprint)) return { ok: false, error: 'previewFingerprint is invalid' };
  return {
    ok: true,
    value: {
      ...base.value,
      previewFingerprint: body.previewFingerprint,
      confirmed: true,
    },
  };
}

export function validateAdminHotelRelationshipIdempotencyKey(
  value: string | null,
): ValidationResult<string> {
  return isUuid(value)
    ? { ok: true, value }
    : { ok: false, error: 'Idempotency-Key must be a UUID' };
}

export function parseAdminHotelRelationshipProjection(
  value: unknown,
): AdminHotelRelationshipProjection | null {
  const root = record(value);
  const property = record(root?.property);
  const current = parseCurrent(root?.currentRelationship);
  if (!root
      || root.schemaVersion !== ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION
      || typeof root.generatedAt !== 'string'
      || !property
      || !isUuid(property.id)
      || typeof property.name !== 'string'
      || typeof property.status !== 'string'
      || (root.lifecycleStatus !== 'company_managed' && root.lifecycleStatus !== 'independent')
      || current === undefined
      || !isHash(root.relationshipRevision)
      || typeof root.organizationQuery !== 'string'
      || !Array.isArray(root.organizations)
      || root.organizationResultLimit !== ADMIN_HOTEL_RELATIONSHIP_DIRECTORY_LIMIT
      || typeof root.organizationResultsTruncated !== 'boolean') return null;
  const organizations = root.organizations.map(parseOrganization);
  if (organizations.some((organization) => organization === null)) return null;
  if ((current === null) !== (root.lifecycleStatus === 'independent')) return null;
  return {
    schemaVersion: ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION,
    generatedAt: root.generatedAt,
    property: { id: property.id, name: property.name, status: property.status },
    lifecycleStatus: root.lifecycleStatus,
    currentRelationship: current,
    relationshipRevision: root.relationshipRevision,
    organizationQuery: root.organizationQuery,
    organizations: organizations as AdminHotelRelationshipOrganization[],
    organizationResultLimit: ADMIN_HOTEL_RELATIONSHIP_DIRECTORY_LIMIT,
    organizationResultsTruncated: root.organizationResultsTruncated,
  };
}

export function parseAdminHotelRelationshipPreview(
  value: unknown,
): AdminHotelRelationshipPreview | null {
  const root = record(value);
  const current = parseCurrent(root?.currentRelationship);
  const target = root?.targetOrganization === null ? null : parseOrganization(root?.targetOrganization);
  const impact = record(root?.impact);
  if (!root
      || root.schemaVersion !== ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION
      || !isUuid(root.propertyId)
      || typeof root.propertyName !== 'string'
      || (root.targetOrganizationId !== null && !isUuid(root.targetOrganizationId))
      || (root.relationshipType !== null && root.relationshipType !== 'operator' && root.relationshipType !== 'owner')
      || !isHash(root.expectedRelationshipRevision)
      || current === undefined
      || target === null && root.targetOrganization !== null
      || (root.lifecycleAfter !== 'company_managed' && root.lifecycleAfter !== 'independent')
      || typeof root.changed !== 'boolean'
      || root.accessChangesImmediately !== true
      || !impact
      || !Number.isSafeInteger(impact.revokedPropertyGrantCount)
      || !Number.isSafeInteger(impact.revokedInvitationCount)
      || !Number.isSafeInteger(impact.cancelledRequestCount)
      || !Number.isSafeInteger(impact.removedPortfolioAssignmentCount)
      || !isHash(root.previewFingerprint)) return null;
  if ((root.targetOrganizationId === null) !== (target === null)) return null;
  if ((root.targetOrganizationId === null) !== (root.lifecycleAfter === 'independent')) return null;
  return root as unknown as AdminHotelRelationshipPreview;
}

export function parseAdminHotelRelationshipCommitResult(
  value: unknown,
): AdminHotelRelationshipCommitResult | null {
  const root = record(value);
  if (!root
      || root.schemaVersion !== ADMIN_HOTEL_RELATIONSHIP_SCHEMA_VERSION
      || !isUuid(root.propertyId)
      || (root.relationshipId !== null && !isUuid(root.relationshipId))
      || (root.organizationId !== null && !isUuid(root.organizationId))
      || (root.relationshipType !== null && root.relationshipType !== 'operator' && root.relationshipType !== 'owner')
      || (root.lifecycleStatus !== 'company_managed' && root.lifecycleStatus !== 'independent')
      || !isHash(root.relationshipRevision)
      || typeof root.changed !== 'boolean'
      || typeof root.idempotentReplay !== 'boolean'
      || !isUuid(root.auditRequestId)) return null;
  if ((root.organizationId === null) !== (root.lifecycleStatus === 'independent')) return null;
  return root as unknown as AdminHotelRelationshipCommitResult;
}
