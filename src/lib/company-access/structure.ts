import { isUuid } from '@/lib/api-validate';

export const COMPANY_STRUCTURE_SCHEMA_VERSION = 'company-structure-v1' as const;

export type CompanyStructureProblemSeverity = 'info' | 'warning' | 'critical';

export interface CompanyStructureProblem {
  code:
    | 'hotel_without_portfolio'
    | 'empty_portfolio'
    | 'relationship_change_restricted'
    | 'legacy_projection'
    | 'structure_unavailable';
  severity: CompanyStructureProblemSeverity;
  organizationId: string | null;
  propertyId: string | null;
  portfolioId: string | null;
  title: string;
  detail: string;
}

export interface CompanyStructurePortfolio {
  id: string;
  organizationId: string;
  parentId: string | null;
  name: string;
  type: 'portfolio' | 'region' | 'division' | 'other';
  propertyIds: string[];
  manageable: boolean;
}

export interface CompanyStructureHotel {
  propertyId: string;
  name: string;
  relationshipId: string;
  relationshipType: 'operator' | 'owner';
  relationshipStatus: 'active';
  portfolioIds: string[];
  manageable: boolean;
}

export interface CompanyStructureOrganization {
  id: string;
  name: string;
  type: 'management_company' | 'ownership_group';
  status: 'active';
  accessEpoch: number;
  canManagePortfolios: boolean;
  hotelRelationshipChangesRequirePlatformAdmin: true;
  hotels: CompanyStructureHotel[];
  portfolios: CompanyStructurePortfolio[];
  problems: CompanyStructureProblem[];
}

export interface CompanyStructureProjection {
  schemaVersion: typeof COMPANY_STRUCTURE_SCHEMA_VERSION;
  generatedAt: string;
  organizations: CompanyStructureOrganization[];
}

export interface PortfolioAssignmentInput {
  organizationId: string;
  propertyId: string;
  desiredPortfolioIds: string[];
  expectedAccessEpoch: number;
}

export interface PortfolioAssignmentPreview extends PortfolioAssignmentInput {
  propertyName: string;
  organizationName: string;
  currentPortfolioIds: string[];
  addedPortfolioIds: string[];
  removedPortfolioIds: string[];
  gainingAccessCount: number;
  losingAccessCount: number;
  affectedGrantCount: number;
  accessChangesImmediately: true;
  previewFingerprint: string;
}

export interface PortfolioAssignmentCommitResult {
  schemaVersion: typeof COMPANY_STRUCTURE_SCHEMA_VERSION;
  organizationId: string;
  propertyId: string;
  desiredPortfolioIds: string[];
  accessEpoch: number;
  changed: boolean;
  idempotentReplay: boolean;
  auditRequestId: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const allowed = new Set(expected);
  return Object.keys(record).every((key) => allowed.has(key));
}

function uniqueUuidArray(value: unknown, field: string): ValidationResult<string[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be an array` };
  if (value.length > 500) return { ok: false, error: `${field} is too large` };
  if (!value.every(isUuid)) return { ok: false, error: `${field} contains an invalid id` };
  const unique = [...new Set(value as string[])].sort();
  if (unique.length !== value.length) return { ok: false, error: `${field} contains duplicate ids` };
  return { ok: true, value: unique };
}

export function validatePortfolioAssignmentInput(
  value: unknown,
): ValidationResult<PortfolioAssignmentInput> {
  const body = objectRecord(value);
  if (!body || !exactKeys(body, [
    'organizationId',
    'propertyId',
    'desiredPortfolioIds',
    'expectedAccessEpoch',
  ])) {
    return { ok: false, error: 'Request body must contain only the documented structure fields' };
  }
  if (!isUuid(body.organizationId)) {
    return { ok: false, error: 'organizationId must be a valid UUID' };
  }
  if (!isUuid(body.propertyId)) {
    return { ok: false, error: 'propertyId must be a valid UUID' };
  }
  const desiredPortfolioIds = uniqueUuidArray(body.desiredPortfolioIds, 'desiredPortfolioIds');
  if (!desiredPortfolioIds.ok) return desiredPortfolioIds;
  if (!Number.isSafeInteger(body.expectedAccessEpoch) || Number(body.expectedAccessEpoch) <= 0) {
    return { ok: false, error: 'expectedAccessEpoch must be a positive integer' };
  }
  return {
    ok: true,
    value: {
      organizationId: body.organizationId,
      propertyId: body.propertyId,
      desiredPortfolioIds: desiredPortfolioIds.value,
      expectedAccessEpoch: Number(body.expectedAccessEpoch),
    },
  };
}

export interface PortfolioAssignmentCommitInput extends PortfolioAssignmentInput {
  previewFingerprint: string;
  confirmed: true;
}

export function validatePortfolioAssignmentCommitInput(
  value: unknown,
): ValidationResult<PortfolioAssignmentCommitInput> {
  const body = objectRecord(value);
  if (!body || !exactKeys(body, [
    'organizationId',
    'propertyId',
    'desiredPortfolioIds',
    'expectedAccessEpoch',
    'previewFingerprint',
    'confirmed',
  ])) {
    return { ok: false, error: 'Request body must contain only the documented confirmation fields' };
  }
  const base = validatePortfolioAssignmentInput({
    organizationId: body.organizationId,
    propertyId: body.propertyId,
    desiredPortfolioIds: body.desiredPortfolioIds,
    expectedAccessEpoch: body.expectedAccessEpoch,
  });
  if (!base.ok) return base;
  if (body.confirmed !== true) {
    return { ok: false, error: 'Explicit confirmation is required' };
  }
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

export function validateStructureIdempotencyKey(value: string | null): ValidationResult<string> {
  if (!isUuid(value)) {
    return { ok: false, error: 'Idempotency-Key must be a UUID' };
  }
  return { ok: true, value };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  return [...new Set(value)].sort();
}

/**
 * Fail-closed boundary for SECURITY DEFINER JSON. A malformed projection is an
 * upstream failure, never a reason for the browser to infer structure.
 */
export function parseCompanyStructureProjection(value: unknown): CompanyStructureProjection | null {
  const root = objectRecord(value);
  if (root?.schemaVersion !== COMPANY_STRUCTURE_SCHEMA_VERSION
      || typeof root.generatedAt !== 'string'
      || !Array.isArray(root.organizations)) return null;

  const organizations: CompanyStructureOrganization[] = [];
  for (const rawOrganization of root.organizations) {
    const organization = objectRecord(rawOrganization);
    if (!organization
        || !isUuid(organization.id)
        || typeof organization.name !== 'string'
        || (organization.type !== 'management_company' && organization.type !== 'ownership_group')
        || organization.status !== 'active'
        || !Number.isSafeInteger(organization.accessEpoch)
        || Number(organization.accessEpoch) <= 0
        || typeof organization.canManagePortfolios !== 'boolean'
        || organization.hotelRelationshipChangesRequirePlatformAdmin !== true
        || !Array.isArray(organization.hotels)
        || !Array.isArray(organization.portfolios)
        || !Array.isArray(organization.problems)) return null;

    const portfolios: CompanyStructurePortfolio[] = [];
    for (const rawPortfolio of organization.portfolios) {
      const portfolio = objectRecord(rawPortfolio);
      const propertyIds = stringArray(portfolio?.propertyIds);
      if (!portfolio
          || !isUuid(portfolio.id)
          || portfolio.organizationId !== organization.id
          || (portfolio.parentId !== null && !isUuid(portfolio.parentId))
          || typeof portfolio.name !== 'string'
          || !['portfolio', 'region', 'division', 'other'].includes(String(portfolio.type))
          || !propertyIds?.every(isUuid)
          || typeof portfolio.manageable !== 'boolean') return null;
      portfolios.push({
        id: portfolio.id,
        organizationId: organization.id,
        parentId: portfolio.parentId as string | null,
        name: portfolio.name,
        type: portfolio.type as CompanyStructurePortfolio['type'],
        propertyIds,
        manageable: portfolio.manageable,
      });
    }

    const hotels: CompanyStructureHotel[] = [];
    for (const rawHotel of organization.hotels) {
      const hotel = objectRecord(rawHotel);
      const portfolioIds = stringArray(hotel?.portfolioIds);
      if (!hotel
          || !isUuid(hotel.propertyId)
          || typeof hotel.name !== 'string'
          || !isUuid(hotel.relationshipId)
          || (hotel.relationshipType !== 'operator' && hotel.relationshipType !== 'owner')
          || hotel.relationshipStatus !== 'active'
          || !portfolioIds?.every(isUuid)
          || typeof hotel.manageable !== 'boolean') return null;
      hotels.push({
        propertyId: hotel.propertyId,
        name: hotel.name,
        relationshipId: hotel.relationshipId,
        relationshipType: hotel.relationshipType,
        relationshipStatus: 'active',
        portfolioIds,
        manageable: hotel.manageable,
      });
    }

    const problems: CompanyStructureProblem[] = [];
    for (const rawProblem of organization.problems) {
      const problem = objectRecord(rawProblem);
      if (!problem
          || !['hotel_without_portfolio', 'empty_portfolio', 'relationship_change_restricted'].includes(String(problem.code))
          || !['info', 'warning', 'critical'].includes(String(problem.severity))
          || problem.organizationId !== organization.id
          || (problem.propertyId !== null && !isUuid(problem.propertyId))
          || (problem.portfolioId !== null && !isUuid(problem.portfolioId))
          || typeof problem.title !== 'string'
          || typeof problem.detail !== 'string') return null;
      problems.push(problem as unknown as CompanyStructureProblem);
    }

    organizations.push({
      id: organization.id,
      name: organization.name,
      type: organization.type,
      status: 'active',
      accessEpoch: Number(organization.accessEpoch),
      canManagePortfolios: organization.canManagePortfolios,
      hotelRelationshipChangesRequirePlatformAdmin: true,
      hotels,
      portfolios,
      problems,
    });
  }

  return {
    schemaVersion: COMPANY_STRUCTURE_SCHEMA_VERSION,
    generatedAt: root.generatedAt,
    organizations,
  };
}

export function parsePortfolioAssignmentPreview(value: unknown): PortfolioAssignmentPreview | null {
  const row = objectRecord(value);
  const base = validatePortfolioAssignmentInput(row ? {
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    desiredPortfolioIds: row.desiredPortfolioIds,
    expectedAccessEpoch: row.expectedAccessEpoch,
  } : null);
  if (!row || !base.ok
      || typeof row.propertyName !== 'string'
      || typeof row.organizationName !== 'string'
      || row.accessChangesImmediately !== true
      || typeof row.previewFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(row.previewFingerprint)) return null;
  const currentPortfolioIds = stringArray(row.currentPortfolioIds);
  const addedPortfolioIds = stringArray(row.addedPortfolioIds);
  const removedPortfolioIds = stringArray(row.removedPortfolioIds);
  if (!currentPortfolioIds?.every(isUuid)
      || !addedPortfolioIds?.every(isUuid)
      || !removedPortfolioIds?.every(isUuid)
      || !Number.isSafeInteger(row.gainingAccessCount)
      || !Number.isSafeInteger(row.losingAccessCount)
      || !Number.isSafeInteger(row.affectedGrantCount)) return null;
  return {
    ...base.value,
    propertyName: row.propertyName,
    organizationName: row.organizationName,
    currentPortfolioIds,
    addedPortfolioIds,
    removedPortfolioIds,
    gainingAccessCount: Number(row.gainingAccessCount),
    losingAccessCount: Number(row.losingAccessCount),
    affectedGrantCount: Number(row.affectedGrantCount),
    accessChangesImmediately: true,
    previewFingerprint: row.previewFingerprint,
  };
}

export function parsePortfolioAssignmentCommitResult(
  value: unknown,
): PortfolioAssignmentCommitResult | null {
  const row = objectRecord(value);
  const desiredPortfolioIds = stringArray(row?.desiredPortfolioIds);
  if (!row
      || row.schemaVersion !== COMPANY_STRUCTURE_SCHEMA_VERSION
      || !isUuid(row.organizationId)
      || !isUuid(row.propertyId)
      || !desiredPortfolioIds?.every(isUuid)
      || !Number.isSafeInteger(row.accessEpoch)
      || Number(row.accessEpoch) <= 0
      || typeof row.changed !== 'boolean'
      || typeof row.idempotentReplay !== 'boolean'
      || !isUuid(row.auditRequestId)) return null;
  return {
    schemaVersion: COMPANY_STRUCTURE_SCHEMA_VERSION,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    desiredPortfolioIds,
    accessEpoch: Number(row.accessEpoch),
    changed: row.changed,
    idempotentReplay: row.idempotentReplay,
    auditRequestId: row.auditRequestId,
  };
}
