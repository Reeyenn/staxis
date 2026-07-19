/** Validate a property IANA timezone without depending on the host clock. */
export function validPropertyTimezone(value: string | null | undefined): string | null {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Deterministic fallback for calendar presentation while property data is
 * unavailable. Financial code must never inherit the manager's browser zone.
 */
export function propertyTimezoneOrUTC(value: string | null | undefined): string {
  return validPropertyTimezone(value) ?? 'UTC';
}
