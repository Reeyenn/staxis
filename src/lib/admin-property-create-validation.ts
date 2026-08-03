import { isUuid, validateRoomNumbers } from '@/lib/api-validate';

export interface CreateBody {
  name?: unknown;
  totalRooms?: unknown;
  timezone?: unknown;
  pmsType?: unknown;
  brand?: unknown;
  propertyKind?: unknown;
  isTest?: unknown;
  organizationId?: unknown;
  roomNumbers?: unknown;
}

interface ValidationResult {
  ok: true;
  values: {
    name: string;
    totalRooms: number;
    timezone: string;
    pmsType: string | null;
    brand: string | null;
    propertyKind: string;
    isTest: boolean;
    organizationId: string | null;
    roomNumbers: string[];
  };
}

export function usesAtomicTestRoster(values: { isTest: boolean; roomNumbers: string[] }): boolean {
  return values.isTest && values.roomNumbers.length > 0;
}

const DEFAULT_HOTEL_NAME = 'New hotel';
const KNOWN_PMS_TYPES = new Set(['choice_advantage', 'manual_csv']);
const KNOWN_PROPERTY_KINDS = new Set([
  'limited_service',
  'full_service',
  'extended_stay',
  'resort',
]);

function isValidIANATimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateBody(body: CreateBody): ValidationResult | { ok: false; reason: string } {
  let name = DEFAULT_HOTEL_NAME;
  if (body.name !== undefined && body.name !== null && body.name !== '') {
    if (typeof body.name !== 'string' || body.name.trim().length < 3 || body.name.length > 100) {
      return { ok: false, reason: 'name must be a string between 3 and 100 characters' };
    }
    name = body.name.trim();
  }

  let totalRooms = 1;
  if (body.totalRooms !== undefined && body.totalRooms !== null && body.totalRooms !== '') {
    if (
      typeof body.totalRooms !== 'number'
      || !Number.isInteger(body.totalRooms)
      || body.totalRooms < 1
      || body.totalRooms > 2000
    ) {
      return { ok: false, reason: 'totalRooms must be an integer between 1 and 2000' };
    }
    totalRooms = body.totalRooms;
  }

  let timezone = 'America/Chicago';
  if (body.timezone !== undefined && body.timezone !== null && body.timezone !== '') {
    if (typeof body.timezone !== 'string' || !isValidIANATimezone(body.timezone)) {
      return { ok: false, reason: `timezone must be a valid IANA name (got: ${String(body.timezone)})` };
    }
    timezone = body.timezone;
  }

  let pmsType: string | null = null;
  if (body.pmsType !== undefined && body.pmsType !== null && body.pmsType !== '') {
    if (typeof body.pmsType !== 'string' || !KNOWN_PMS_TYPES.has(body.pmsType)) {
      return {
        ok: false,
        reason: `pmsType must be one of: ${Array.from(KNOWN_PMS_TYPES).join(', ')} (got: ${String(body.pmsType)})`,
      };
    }
    pmsType = body.pmsType;
  }

  let brand: string | null = null;
  if (body.brand !== undefined && body.brand !== null && body.brand !== '') {
    if (typeof body.brand !== 'string' || body.brand.length > 100) {
      return { ok: false, reason: 'brand must be a string up to 100 chars' };
    }
    brand = body.brand;
  }

  let propertyKind = 'limited_service';
  if (body.propertyKind !== undefined && body.propertyKind !== null && body.propertyKind !== '') {
    if (typeof body.propertyKind !== 'string' || !KNOWN_PROPERTY_KINDS.has(body.propertyKind)) {
      return {
        ok: false,
        reason: `propertyKind must be one of: ${Array.from(KNOWN_PROPERTY_KINDS).join(', ')}`,
      };
    }
    propertyKind = body.propertyKind;
  }

  const isTest = body.isTest === true;

  let organizationId: string | null = null;
  if (body.organizationId !== undefined && body.organizationId !== null && body.organizationId !== '') {
    if (!isUuid(body.organizationId)) {
      return { ok: false, reason: 'organizationId must be a valid UUID' };
    }
    organizationId = body.organizationId;
  }

  let roomNumbers: string[] = [];
  if (body.roomNumbers !== undefined && body.roomNumbers !== null) {
    const result = validateRoomNumbers(body.roomNumbers, { label: 'roomNumbers' });
    if (result.error) return { ok: false, reason: result.error };
    roomNumbers = result.value!;
    if (roomNumbers.length > 0 && roomNumbers.length !== totalRooms) {
      return {
        ok: false,
        reason: `roomNumbers count (${roomNumbers.length}) must match totalRooms (${totalRooms}). `
          + 'Either fix the list or change totalRooms.',
      };
    }
  }

  return {
    ok: true,
    values: {
      name,
      totalRooms,
      timezone,
      pmsType,
      brand,
      propertyKind,
      isTest,
      organizationId,
      roomNumbers,
    },
  };
}
