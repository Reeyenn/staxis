/**
 * Report catalog — shared types.
 *
 * A "report definition" is a titled query + columns that powers BOTH the
 * on-demand display/export at /settings/reports AND the scheduled auto-email
 * cron. Each definition runs server-side with supabaseAdmin and is strictly
 * scoped to a single property via ReportContext.propertyId.
 *
 * This is the reusable abstraction the orchestrator asked for: the daily/
 * weekly report engine (src/lib/reports/*) stays as-is for the fixed emails;
 * the catalog is the new menu of self-serve reports built on data we already
 * have.
 */

export type ReportCategory =
  | 'housekeeping'
  | 'inspections'
  | 'maintenance'
  | 'inventory'
  | 'occupancy'
  | 'activity'
  | 'compliance'
  | 'lost_found';

/** Bilingual label. EN + ES per CLAUDE.md. */
export interface Bilingual {
  en: string;
  es: string;
}

/** How a cell renders / aligns. */
export type ColumnKind =
  | 'text'
  | 'number'
  | 'minutes'   // integer minutes → "42m"
  | 'percent'   // 0–100 → "92%"
  | 'currency'  // cents → "$12.34"
  | 'date'      // YYYY-MM-DD
  | 'datetime'; // ISO → locale string

export interface ReportColumn {
  key: string;
  label: Bilingual;
  kind?: ColumnKind;        // default 'text'
  align?: 'left' | 'right'; // default left for text, right for numeric
}

/** One data row. Values are primitives keyed by ReportColumn.key. */
export type ReportRow = Record<string, string | number | null>;

/** A headline stat shown above the table + fed to the AI summary. */
export interface ReportStat {
  label: Bilingual;
  value: string;
}

/** What a definition's run() returns. */
export interface ReportRunResult {
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Optional headline numbers (e.g. "Pass rate 92%", "Total spend $1,240"). */
  stats?: ReportStat[];
  /** Optional caveat shown under the table (e.g. "Revenue not tracked yet"). */
  notes?: Bilingual;
}

/** Inputs every report run gets. Property-scoped + a date window. */
export interface ReportContext {
  propertyId: string;
  /** Inclusive start, YYYY-MM-DD (property-local). */
  from: string;
  /** Inclusive end, YYYY-MM-DD (property-local). */
  to: string;
  /** IANA timezone of the property, for UTC-boundary math. */
  timezone: string;
}

/** Default date window a report opens with. */
export type DefaultRange = 'last7' | 'last30' | 'mtd';

export interface ReportDefinition {
  /** Stable key used in URLs, favorites, schedules (e.g. 'hk-leaderboard'). */
  key: string;
  title: Bilingual;
  description: Bilingual;
  category: ReportCategory;
  defaultRange: DefaultRange;
  /**
   * Run the report for a property + date window. MUST scope every query by
   * ctx.propertyId. Throws on hard failure; the route maps that to a 500.
   */
  run: (ctx: ReportContext) => Promise<ReportRunResult>;
}

/** Catalog entry as exposed to the client (no run()). */
export interface ReportCatalogEntry {
  key: string;
  title: Bilingual;
  description: Bilingual;
  category: ReportCategory;
  defaultRange: DefaultRange;
}

export function toCatalogEntry(def: ReportDefinition): ReportCatalogEntry {
  return {
    key: def.key,
    title: def.title,
    description: def.description,
    category: def.category,
    defaultRange: def.defaultRange,
  };
}
