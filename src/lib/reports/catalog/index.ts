/**
 * Report catalog — public registry.
 *
 * SERVER-ONLY: importing this pulls in the report definitions, which import
 * supabaseAdmin. The client page never imports this; it fetches the catalog
 * list (titles/descriptions) from /api/settings/reports/catalog.
 */

import { REPORT_DEFINITIONS } from './definitions';
import { toCatalogEntry, type ReportCatalogEntry, type ReportDefinition } from './types';

export { REPORT_DEFINITIONS } from './definitions';
export * from './types';

const BY_KEY = new Map<string, ReportDefinition>(REPORT_DEFINITIONS.map((d) => [d.key, d]));

/** Look up a definition by key, or undefined if unknown. */
export function getReportDefinition(key: string): ReportDefinition | undefined {
  return BY_KEY.get(key);
}

/** The catalog as client-facing entries (no run()). */
export function listCatalog(): ReportCatalogEntry[] {
  return REPORT_DEFINITIONS.map(toCatalogEntry);
}

/** Every valid report key (for validation). */
export function reportKeys(): string[] {
  return REPORT_DEFINITIONS.map((d) => d.key);
}
