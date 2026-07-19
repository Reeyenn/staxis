const COMPANY_ACCESS_UNAVAILABLE_CODES = new Set(['PGRST202', 'PGRST205', '42P01']);

/** Rolling-deploy/schema-cache failures are availability problems, not invalid
 * user input. Keep this mapping shared so every Company Hub mutation reports a
 * retryable 503 consistently. */
export function isCompanyAccessUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (typeof candidate.code === 'string' && COMPANY_ACCESS_UNAVAILABLE_CODES.has(candidate.code)) return true;
  return typeof candidate.message === 'string'
    && /relation .* does not exist|schema cache|could not find the function/i.test(candidate.message);
}
