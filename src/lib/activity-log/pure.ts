/**
 * Pure helpers for the activity-log query path.
 *
 * No side-effect imports — these are safe to use from tests, route
 * handlers, and the browser without loading supabase-admin. The one
 * import below (`withoutEmDash`) is itself side-effect free: its module
 * pulls in only type-only imports plus a money formatter. Keep it that
 * way when adding to this file.
 */

import { withoutEmDash } from '@/lib/findings/template-phrasing';

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

/**
 * The read-side em-dash seam for the activity timeline.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * `activity_log.description` and `.target_label` are PERSISTED English
 * sentences, not derived ones. The trigger functions in migration 0228
 * compose them at write time and the page reads them back verbatim months
 * later, so fixing a template only cleans rows written from then on.
 *
 * The founder ruled em dashes out of user-facing copy on 2026-07-28; 0228
 * predates that by three months. Migration 0415 fixes both halves: the six
 * live templates AND the rows already stored. This function is the belt to
 * that migration's braces, at the single seam every row passes through on
 * its way to the timeline, the side panel, and the CSV / XLSX / PDF export.
 * If 0415 has not been applied to an environment yet, or a future trigger
 * edit reintroduces a dash in SQL, the browser still never shows one.
 *
 * Mirrors the findings-prose precedent (`cardPhrasing` in
 * src/lib/findings), and reuses its exact transform so the two surfaces
 * cannot drift.
 */
export function sanitizeActivityRowCopy<
  T extends { description?: unknown; target_label?: unknown },
>(row: T): T {
  const description = typeof row.description === 'string'
    ? withoutEmDash(row.description)
    : row.description;
  const targetLabel = typeof row.target_label === 'string'
    ? withoutEmDash(row.target_label)
    : row.target_label;

  // Identity-preserving when there is nothing to clean, which is the
  // common case once 0415 has run.
  if (description === row.description && targetLabel === row.target_label) {
    return row;
  }
  return { ...row, description, target_label: targetLabel };
}
