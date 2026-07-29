import { stableFingerprint } from './canonical';
import {
  MANAGEMENT_PATTERN_PROFILE_VERSION,
  MANAGEMENT_PATTERN_SIZE_BAND_VERSION,
} from './versions';

export type RoomSizeBand = 'micro' | 'small' | 'medium' | 'large' | 'very_large';

export type CohortDimension =
  | 'sizeBand'
  | 'serviceLevel'
  | 'brandClass'
  | 'marketType'
  | 'regionId'
  | 'operatingModel'
  | 'amenityTags'
  | 'operatingCurrency';

export type ExplicitCurrencySource =
  | 'property_configuration'
  | 'pms'
  | 'accounting'
  | 'contract'
  | 'organization_override'
  | 'property_authoritative'
  | 'verified_import';

export type BusinessDateCutoffSource =
  | 'property_configuration'
  | 'pms'
  | 'contract'
  | 'organization_override'
  | 'property_authoritative'
  | 'verified_import';

export interface BusinessDateCutoffProvenance {
  readonly source: BusinessDateCutoffSource;
  readonly sourceRevision: string;
}

export interface ExplicitCurrencyInput {
  /** Explicit ISO-style alphabetic code. There is deliberately no default. */
  readonly code: string;
  readonly source: ExplicitCurrencySource;
  readonly sourceRevision: string;
  /** Decimal places encoded in persisted integer values; explicit even when code is known. */
  readonly storageScale: number;
}

export interface ExplicitCurrency extends ExplicitCurrencyInput {
  readonly code: string;
}

export interface PropertyProfileInput {
  readonly organizationId: string;
  readonly propertyId: string;
  /** Temporal organization/property relationship, when the caller has one. */
  readonly relationshipId?: string | null;
  readonly asOf: string;
  readonly sourceRevision: string;
  readonly totalRooms: number | null;
  /** Null is an explicit unknown, never an implied midnight. */
  readonly businessDateCutoffHour: number | null;
  readonly businessDateCutoffProvenance: BusinessDateCutoffProvenance | null;
  /** An explicit operator configuration; otherwise the versioned room policy is used. */
  readonly configuredSizeBand?: RoomSizeBand | null;
  readonly serviceLevel: string | null;
  readonly brandClass: string | null;
  readonly marketType: string | null;
  readonly regionId: string | null;
  readonly operatingModel: string | null;
  /** Null means unknown; [] explicitly means the property has no configured tags. */
  readonly amenityTags: readonly string[] | null;
  readonly operatingCurrency: ExplicitCurrencyInput | null;
}

export interface PropertyProfileSnapshot {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_PROFILE_VERSION;
  readonly sizeBandPolicyVersion: typeof MANAGEMENT_PATTERN_SIZE_BAND_VERSION;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly relationshipId: string | null;
  readonly asOf: string;
  readonly sourceRevision: string;
  readonly totalRooms: number | null;
  readonly businessDateCutoffHour: number | null;
  readonly businessDateCutoffProvenance: BusinessDateCutoffProvenance | null;
  readonly sizeBand: RoomSizeBand | null;
  readonly sizeBandSource: 'configured' | 'room_count_policy' | 'unknown';
  readonly serviceLevel: string | null;
  readonly brandClass: string | null;
  readonly marketType: string | null;
  readonly regionId: string | null;
  readonly operatingModel: string | null;
  readonly amenityTags: readonly string[] | null;
  readonly operatingCurrency: ExplicitCurrency | null;
  readonly fingerprint: string;
}

const SIZE_BANDS = new Set<RoomSizeBand>(['micro', 'small', 'medium', 'large', 'very_large']);
const CURRENCY_RX = /^[A-Z]{3}$/;

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${field} must not be empty`);
  return trimmed;
}

function isoInstant(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.includes('T')) {
    throw new TypeError(`${field} must be an ISO-8601 instant`);
  }
  return new Date(parsed).toISOString();
}

/** Normalize configured categorical values for exact, reproducible matching. */
export function canonicalProfileToken(value: string | null | undefined): string | null {
  if (value == null) return null;
  const token = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return token || null;
}

export function roomSizeBand(totalRooms: number): RoomSizeBand {
  if (!Number.isInteger(totalRooms) || totalRooms <= 0) {
    throw new TypeError('totalRooms must be a positive integer');
  }
  if (totalRooms <= 30) return 'micro';
  if (totalRooms <= 75) return 'small';
  if (totalRooms <= 150) return 'medium';
  if (totalRooms <= 300) return 'large';
  return 'very_large';
}

function canonicalAmenities(values: readonly string[] | null): readonly string[] | null {
  if (values === null) return null;
  const normalized = values
    .map((value) => canonicalProfileToken(value))
    .filter((value): value is string => value !== null);
  return Object.freeze([...new Set(normalized)].sort());
}

function explicitCurrency(input: ExplicitCurrencyInput | null): ExplicitCurrency | null {
  if (input === null) return null;
  const code = input.code.trim().toUpperCase();
  if (!CURRENCY_RX.test(code)) throw new TypeError('operatingCurrency.code must be three letters');
  if (!Number.isInteger(input.storageScale) || input.storageScale < 0 || input.storageScale > 4) {
    throw new TypeError('operatingCurrency.storageScale must be an integer from 0 through 4');
  }
  return Object.freeze({
    code,
    source: input.source,
    sourceRevision: nonEmpty(input.sourceRevision, 'operatingCurrency.sourceRevision'),
    storageScale: input.storageScale,
  });
}

/**
 * Capture only declared/observed property attributes. In particular, an absent
 * currency remains null and later makes monetary peer comparison abstain.
 */
export function createPropertyProfileSnapshot(input: PropertyProfileInput): PropertyProfileSnapshot {
  const organizationId = nonEmpty(input.organizationId, 'organizationId');
  const propertyId = nonEmpty(input.propertyId, 'propertyId');
  const relationshipId = input.relationshipId == null
    ? null
    : nonEmpty(input.relationshipId, 'relationshipId');
  const sourceRevision = nonEmpty(input.sourceRevision, 'sourceRevision');
  const asOf = isoInstant(input.asOf, 'asOf');

  if (input.totalRooms !== null && (!Number.isInteger(input.totalRooms) || input.totalRooms <= 0)) {
    throw new TypeError('totalRooms must be null or a positive integer');
  }
  if (input.configuredSizeBand != null && !SIZE_BANDS.has(input.configuredSizeBand)) {
    throw new TypeError('configuredSizeBand is not recognized');
  }
  if (
    input.businessDateCutoffHour !== null
    && (!Number.isInteger(input.businessDateCutoffHour)
      || input.businessDateCutoffHour < 0
      || input.businessDateCutoffHour > 23)
  ) {
    throw new TypeError('businessDateCutoffHour must be null or an integer from 0 through 23');
  }
  if ((input.businessDateCutoffHour === null) !== (input.businessDateCutoffProvenance === null)) {
    throw new TypeError('businessDateCutoffHour and its provenance must both be present or both be null');
  }
  const businessDateCutoffProvenance = input.businessDateCutoffProvenance === null
    ? null
    : Object.freeze({
      source: input.businessDateCutoffProvenance.source,
      sourceRevision: nonEmpty(
        input.businessDateCutoffProvenance.sourceRevision,
        'businessDateCutoffProvenance.sourceRevision',
      ),
    });

  const sizeBand = input.configuredSizeBand ?? (
    input.totalRooms === null ? null : roomSizeBand(input.totalRooms)
  );
  const sizeBandSource = input.configuredSizeBand != null
    ? 'configured' as const
    : input.totalRooms === null
      ? 'unknown' as const
      : 'room_count_policy' as const;

  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_PROFILE_VERSION,
    sizeBandPolicyVersion: MANAGEMENT_PATTERN_SIZE_BAND_VERSION,
    organizationId,
    propertyId,
    relationshipId,
    asOf,
    sourceRevision,
    totalRooms: input.totalRooms,
    businessDateCutoffHour: input.businessDateCutoffHour,
    businessDateCutoffProvenance,
    sizeBand,
    sizeBandSource,
    serviceLevel: canonicalProfileToken(input.serviceLevel),
    brandClass: canonicalProfileToken(input.brandClass),
    marketType: canonicalProfileToken(input.marketType),
    regionId: canonicalProfileToken(input.regionId),
    operatingModel: canonicalProfileToken(input.operatingModel),
    amenityTags: canonicalAmenities(input.amenityTags),
    operatingCurrency: explicitCurrency(input.operatingCurrency),
  };

  return Object.freeze({
    ...payload,
    fingerprint: stableFingerprint(payload, 'property-profile'),
  });
}

export type CohortDimensionValue = string | readonly string[] | null;

export function profileDimensionValue(
  profile: PropertyProfileSnapshot,
  dimension: CohortDimension,
): CohortDimensionValue {
  switch (dimension) {
    case 'sizeBand': return profile.sizeBand;
    case 'serviceLevel': return profile.serviceLevel;
    case 'brandClass': return profile.brandClass;
    case 'marketType': return profile.marketType;
    case 'regionId': return profile.regionId;
    case 'operatingModel': return profile.operatingModel;
    case 'amenityTags': return profile.amenityTags;
    case 'operatingCurrency': return profile.operatingCurrency === null
      ? null
      : `${profile.operatingCurrency.code}:scale-${profile.operatingCurrency.storageScale}`;
  }
}
