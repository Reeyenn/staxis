import { validPropertyTimezone } from '@/lib/property-timezone';

export type PropertyUpdateValidation =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

const NULLABLE_TEXT_FIELDS = new Set([
  'brand',
  'region',
  'climate_zone',
  'size_tier',
]);

/** Validate and normalize one non-enabled_sections onboarding property field. */
export function validatePropertyUpdateField(
  key: string,
  value: unknown,
): PropertyUpdateValidation {
  switch (key) {
    case 'total_rooms': {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2000) {
        return { ok: false, error: 'total_rooms must be an integer between 1 and 2000' };
      }
      return { ok: true, value };
    }
    case 'timezone': {
      const tz = validPropertyTimezone(typeof value === 'string' ? value : null);
      if (!tz) return { ok: false, error: 'timezone must be a valid IANA name' };
      return { ok: true, value: tz };
    }
    case 'services_enabled': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, error: 'services_enabled must be an object of booleans' };
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > 50 || entries.some(([, entryValue]) => typeof entryValue !== 'boolean')) {
        return { ok: false, error: 'services_enabled must be an object of booleans' };
      }
      return { ok: true, value };
    }
    case 'name':
    case 'property_kind': {
      if (typeof value !== 'string' || value.length > 120 || value.trim().length === 0) {
        return { ok: false, error: `${key} must be a non-empty string up to 120 characters` };
      }
      return { ok: true, value: value.trim() };
    }
    default: {
      if (!NULLABLE_TEXT_FIELDS.has(key)) {
        // enabled_sections is validated separately; callers allow-list keys.
        return { ok: true, value };
      }
      if (value === null) return { ok: true, value: null };
      if (typeof value !== 'string' || value.length > 120) {
        return { ok: false, error: `${key} must be null or a string up to 120 characters` };
      }
      const trimmed = value.trim();
      return { ok: true, value: trimmed || null };
    }
  }
}
