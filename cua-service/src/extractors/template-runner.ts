/**
 * Template-runner (Plan v7 Phase 2b).
 *
 * Wraps the 4 existing extraction modes (dom_table, dom_inline,
 * csv_download, fetch_api) behind a TableTemplate interface. Single-
 * source templates are dispatched here directly; multi-source templates
 * delegate to multi-source-runner.ts.
 *
 * The output is per-source raw rows + per-field parsed values ready for
 * the generic-table-writer. The runner doesn't know about Postgres or
 * snapshot scopes — it just turns selectors into typed rows.
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import { extractDomTable } from './dom-table.js';
import { extractDomInline } from './dom-inline.js';
import { extractCsvDownload } from './csv-download.js';
import { extractFetchApi } from './fetch-api.js';
import { applyParser } from '../parsers/registry.js';
// Side-effect imports — register the value parsers at module load.
//   generic.js: the PMS-AGNOSTIC default parsers (generic_date/currency/enum…)
//   ca.js:      Choice-Advantage parsers, kept ONLY as a back-compat fallback
//               for the already-seeded CA knowledge file (recipe-adapter wires
//               them via ENUM_PARSER_OVERRIDES when no learned mapping exists).
import '../parsers/generic.js';
import '../parsers/ca.js';
import type {
  TableTemplate,
  TableTemplateSource,
  TableTemplateField,
  FieldOrigin,
} from '../types.js';

export interface TemplateRunResult {
  ok: boolean;
  rows: Array<Record<string, unknown>>;
  /** Per-source extraction outcomes for diagnostics. */
  sourceResults: Array<{ name: string; ok: boolean; rowCount: number; reason?: string }>;
  reason?: string;
}

/**
 * Convert TableTemplateSource → a FeedSpec-shaped object the existing
 * extractors understand. Mirrors the field names migration 0203 uses.
 *
 * Codex v2 flagged the translation gap — this is where it lives now.
 */
function sourceToFeedSpec(source: TableTemplateSource): {
  mode: TableTemplateSource['mode'];
  url: string;
  selectors?: Record<string, string>;
  columns?: Record<string, string>;
  extra?: Record<string, unknown>;
} {
  return {
    mode: source.mode,
    url: source.url,
    selectors: source.selectors,
    columns: source.columns,
    extra: source.extra,
  };
}

/**
 * Run a single source's extractor and return raw row dicts.
 * Caller is responsible for parser application (see applyTemplateParsers).
 */
async function runSource(
  page: Page,
  source: TableTemplateSource,
  allowedHost: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; rows: Array<Record<string, unknown>>; reason?: string }> {
  const feedSpec = sourceToFeedSpec(source);
  switch (source.mode) {
    case 'dom_table': {
      const r = await extractDomTable({ page, feedSpec, allowedHost, signal });
      if (!r.ok) return { ok: false, rows: [], reason: r.reason };
      // dom-table returns Record<string,string>[]; widen for parser apply.
      return { ok: true, rows: r.rows as Array<Record<string, unknown>> };
    }
    case 'dom_inline': {
      const r = await extractDomInline({ page, feedSpec, allowedHost, signal });
      if (!r.ok) return { ok: false, rows: [], reason: r.reason };
      // dom-inline returns a single row of field → string; wrap into array.
      return { ok: true, rows: [r.data as Record<string, unknown>] };
    }
    case 'csv_download': {
      const r = await extractCsvDownload({ page, feedSpec, allowedHost, signal });
      if (!r.ok) return { ok: false, rows: [], reason: r.reason };
      return { ok: true, rows: r.rows as Array<Record<string, unknown>> };
    }
    case 'fetch_api': {
      const r = await extractFetchApi({ page, feedSpec, signal });
      if (!r.ok) return { ok: false, rows: [], reason: r.reason };
      // fetch_api returns opaque JSON; if it's an array, treat as rows;
      // if it's a single object with .rows or .results, unwrap; else
      // wrap single object as a 1-row array.
      const data = r.data as unknown;
      if (Array.isArray(data)) return { ok: true, rows: data as Array<Record<string, unknown>> };
      if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        if (Array.isArray(obj.rows)) return { ok: true, rows: obj.rows as Array<Record<string, unknown>> };
        if (Array.isArray(obj.results)) return { ok: true, rows: obj.results as Array<Record<string, unknown>> };
        if (Array.isArray(obj.data)) return { ok: true, rows: obj.data as Array<Record<string, unknown>> };
        return { ok: true, rows: [obj] };
      }
      return { ok: false, rows: [], reason: 'fetch_api returned non-object data' };
    }
  }
}

/**
 * Apply per-field parsers to a row. Reads template.fields to determine
 * which parser (if any) each column needs. Fields tagged
 * origin='detail_page' are skipped here — they only get values when
 * a drill-down workflow explicitly fetches a detail page.
 */
function applyTemplateParsers(
  row: Record<string, unknown>,
  template: TableTemplate,
  origin: FieldOrigin,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [col, field] of Object.entries(template.fields)) {
    if (field.origin !== origin) continue;
    const raw = row[field.selectorOrColumn];
    if (raw === undefined) {
      out[col] = null;
      continue;
    }
    out[col] = field.parser ? applyParser(field.parser, raw, field.parserConfig) : raw;
  }
  return out;
}

/**
 * Run a single-source template. Returns rows ready for the generic
 * writer (with parsers applied + only list_row fields populated).
 *
 * Multi-source templates should call runMultiSourceTemplate instead;
 * caller is responsible for the dispatch.
 */
export async function runSingleSourceTemplate(args: {
  page: Page;
  template: TableTemplate;
  allowedHost: string;
  signal: AbortSignal;
}): Promise<TemplateRunResult> {
  const { template, page, allowedHost, signal } = args;
  if (template.sources.length !== 1) {
    return {
      ok: false,
      rows: [],
      sourceResults: [],
      reason: `runSingleSourceTemplate requires exactly 1 source; got ${template.sources.length}. Use runMultiSourceTemplate.`,
    };
  }
  const source = template.sources[0]!;
  const sourceResult = await runSource(page, source, allowedHost, signal);
  if (!sourceResult.ok) {
    return {
      ok: false,
      rows: [],
      sourceResults: [{ name: source.name, ok: false, rowCount: 0, reason: sourceResult.reason }],
      reason: sourceResult.reason,
    };
  }

  const parsedRows = sourceResult.rows.map((r) => applyTemplateParsers(r, template, 'list_row'));

  log.info('template-runner: single-source run complete', {
    tableName: template.tableName,
    sourceName: source.name,
    rowsIn: sourceResult.rows.length,
    rowsOut: parsedRows.length,
  });

  return {
    ok: true,
    rows: parsedRows,
    sourceResults: [{ name: source.name, ok: true, rowCount: parsedRows.length }],
  };
}

// Re-export the helpers multi-source-runner needs.
export { runSource, applyTemplateParsers };
