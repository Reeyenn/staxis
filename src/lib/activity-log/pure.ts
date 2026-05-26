/**
 * Pure helpers for the activity-log query path.
 *
 * No side-effect imports — these are safe to use from tests, route
 * handlers, and the browser without loading supabase-admin.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Clamp page-size: defaults to 50, caps at 200, NaN/0/negative → default. */
export function clampPageSize(input: number | undefined): number {
  if (!input || !Number.isFinite(input) || input <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(input), MAX_PAGE_SIZE);
}

/** Clamp page index. Returns 1 for anything <= 0 or NaN. */
export function clampPage(input: number | undefined): number {
  if (!input || !Number.isFinite(input) || input <= 0) return 1;
  return Math.floor(input);
}

/**
 * Escape ILIKE metacharacters (% and _) in user input. PostgREST passes
 * the .ilike() string verbatim into Postgres, so the user could otherwise
 * inject wildcards. This isn't an injection vulnerability (Postgres
 * parameterises the value), just a usability + result-quality fix.
 */
export function escapeIlike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => '\\' + ch);
}
