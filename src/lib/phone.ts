/**
 * Single source of truth for phone-number normalization.
 *
 * Canonical format throughout the app is E.164 (`+1XXXXXXXXXX`). The
 * `staff.phone_lookup` column stores E.164 too, so SMS reply matching can
 * compare directly to the normalized inbound `From` number from Twilio.
 *
 * US-centric: 10-digit and 11-digit-leading-1 inputs are assumed US.
 * Already-prefixed inputs (`+...`) are validated for plausible E.164 length
 * (7-15 digits after the `+`) and accepted as-is. Anything else returns null
 * so callers must explicitly handle bad input rather than silently coercing
 * a Mexican mobile to a US number.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return null;
    return `+${digits}`;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/**
 * Last 10 digits of a phone — used as a fallback variant when matching
 * inbound SMS against legacy `phone_lookup` rows that pre-date the E.164
 * migration. New writes should always use `toE164`.
 */
export function lastTenDigits(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}
