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
import { extractFetchApi, resolveJsonPath } from './fetch-api.js';
import { renderDatePlaceholders } from './date-template.js';
import { extractDetailFields } from './dom-rows.js';
import { safeGoto } from '../browser-utils/navigate.js';
import { substituteTemplate, templatePlaceholders } from '../url-template.js';
import type { LearnedDateFormat } from '../types.js';
import { applyParser } from '../parsers/registry.js';
import { requiredLearnedFor } from '../target-contract.js';
import { DETAIL_PER_POLL_MAX } from '../column-recovery.js';
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
  // Stale-date guard: render {today}/{date} placeholders in the source URL
  // at RUN time (runSource is called per poll). fetch_api is EXEMPT here —
  // its extractor renders url + body together with a single clock, so a
  // poll straddling local midnight can't split dates between the two.
  const url = source.mode === 'fetch_api'
    ? source.url
    : renderDatePlaceholders(source.url, {
        context: 'url',
        learnedFormat: source.extra?.dateRender as LearnedDateFormat | undefined,
        timezone: source.extra?.timezone as string | undefined,
      });
  return {
    mode: source.mode,
    url,
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
      const r = await extractFetchApi({ page, feedSpec, allowedHost, signal });
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
    // Lookup chain — extractors key their output rows differently:
    //   1. row[selectorOrColumn]  — csv header, fetch_api JSON key, legacy
    //      multi-source field key ('roomCount').
    //   2. dot-path               — fetch_api rows often NEST the value
    //      (column key 'guest.name'); a literal flat key always wins first.
    //   3. row[col]               — dom_table/dom_inline emit rows keyed by
    //      the CANONICAL field name (out[field] in their $$eval), while the
    //      template's selectorOrColumn holds the CSS selector. Without this
    //      fallback every adapter-built dom template parsed to all-null rows
    //      at runtime (latent split-brain the simulated-row tests masked).
    let raw = row[field.selectorOrColumn];
    if (raw === undefined && field.selectorOrColumn.includes('.')) {
      const resolved = resolveJsonPath(row, field.selectorOrColumn);
      if (resolved.found) raw = resolved.value;
    }
    if (raw === undefined) {
      raw = row[col];
    }
    if (raw === undefined) {
      out[col] = null;
      continue;
    }
    out[col] = field.parser ? applyParser(field.parser, raw, field.parserConfig) : raw;
  }
  return out;
}

/**
 * Contract-level feed-integrity guard. The writer has a descriptor-keyed
 * twin (findAllBlankRequiredColumns in generic-table-writer.ts) that
 * protects the DATA; this one keyed off target-contract's required-learned
 * columns protects the SIGNAL. session-driver counts EXTRACTION rows for
 * read-health + the zero-row self-repair streak BEFORE the write
 * (session-driver.ts runAllFeeds: `runResult.rows.length`), so a feed whose
 * rows exist but whose required columns are uniformly blank must fail HERE
 * — at the runner — or every such poll would stamp last_successful_read_at
 * green and RESET the drift streak, and single-target self-repair could
 * never fire for exactly the drift class this guard exists to catch.
 *
 * Cannot fire on legitimate feeds: zero rows → [] (an empty cancellations
 * list is a healthy no-op); non-core actions have no contract-required
 * columns → []; one good value in any row clears the column (per-row
 * validation in the writer handles partial blanks).
 */
export function findBlankContractColumns(
  template: TableTemplate,
  rows: Array<Record<string, unknown>>,
): string[] {
  if (rows.length === 0 || !template.sourceActionKey) return [];
  const required = requiredLearnedFor(template.sourceActionKey);
  if (required.length === 0) return [];
  const isBlank = (v: unknown) =>
    v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  return required.filter((col) => rows.every((r) => isBlank(r[col])));
}

// ─── Per-row detail enrichment (feature/cua-column-recovery) ─────────────────
//
// Recovered REQUIRED columns live on each record's detail page (see
// TableTemplate.rowDetail). After the list rows are extracted, the runner
// builds each row's detail URL from the verified key-anchored template,
// navigates (host-pinned, Playwright only — no Claude at poll time), reads the
// detail selectors with the SAME shared dom-rows reader the mapper verified
// with, and merges the raw values into the row before parsing.
//
// Bounds (plan ADDENDUM #6-#8): the whole sweep shares a 120s single-flight
// window across ALL feeds, so one feed's enrichment gets a 20s slice with 5s
// per-navigation timeouts and AbortSignal checks between rows. A TTL cache
// keyed by (cacheScope | template fingerprint | URL) makes the steady state
// ~free; cacheScope comes from the session-driver (propertyId + knowledge-file
// version) and MUST scope the cache — hotels on the same PMS family share URL
// shapes, and an unscoped cache would serve hotel A's values to hotel B. No
// cacheScope (tests, ad-hoc callers) → caching disabled, the safe default.

const DETAIL_FEED_BUDGET_MS = 20_000;
const DETAIL_NAV_TIMEOUT_MS = 5_000;
const DETAIL_CACHE_TTL_MS = 300_000; // 5 min — recovered detail fields lag the 30s list cadence by ≤5 min
const DETAIL_CACHE_MAX = 500;

const detailCache = new Map<string, { values: Record<string, string>; at: number }>();

/** Test hook — the cache is module state. */
export function __clearDetailCacheForTests(): void {
  detailCache.clear();
}

export type DetailFetcher = (
  url: string,
  columns: Record<string, string>,
) => Promise<Record<string, string>>;

export interface EnrichResult {
  ok: boolean;
  enrichedCount: number;
  failedCount: number;
  reason?: string;
}

/**
 * Enrich rows in place. "Failed" counts SYSTEMATIC misses only — blank URL
 * param, substitution/navigation/extraction failure, row cap, time budget,
 * abort. A successfully-fetched detail page whose cell is blank is data, not
 * failure (the writer's per-row validation owns that, as it does for list
 * cells). Dependency-injected fetcher so the decision logic is unit-testable
 * without Playwright.
 */
export async function enrichRowsWithDetail(args: {
  rows: Array<Record<string, unknown>>;
  rowDetail: NonNullable<TableTemplate['rowDetail']>;
  fetcher: DetailFetcher;
  cacheScope?: string;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<EnrichResult> {
  const { rows, rowDetail, fetcher, cacheScope, signal } = args;
  const now = args.now ?? Date.now;
  const placeholders = templatePlaceholders(rowDetail.urlTemplate);
  if (rows.length > DETAIL_PER_POLL_MAX) {
    return {
      ok: false,
      enrichedCount: 0,
      failedCount: rows.length,
      reason: `too_many_rows_for_detail: ${rows.length} > ${DETAIL_PER_POLL_MAX}`,
    };
  }
  const fingerprint = JSON.stringify({ t: rowDetail.urlTemplate, c: rowDetail.columns });
  const startedAt = now();
  let enrichedCount = 0;
  let failedCount = 0;
  let failReason: string | undefined;

  for (const row of rows) {
    if (signal?.aborted) {
      failedCount++;
      failReason ??= 'aborted mid-enrichment';
      continue;
    }
    if (now() - startedAt > DETAIL_FEED_BUDGET_MS) {
      failedCount++;
      failReason ??= `detail budget exhausted (${DETAIL_FEED_BUDGET_MS}ms)`;
      continue;
    }
    const values: Record<string, string> = {};
    let blankParam: string | null = null;
    for (const p of placeholders) {
      const v = typeof row[p] === 'string' ? (row[p] as string).trim() : String(row[p] ?? '').trim();
      if (v === '') {
        blankParam = p;
        break;
      }
      values[p] = v;
    }
    if (blankParam) {
      failedCount++;
      failReason ??= `row has blank URL param "${blankParam}"`;
      continue;
    }
    let url: string;
    try {
      url = substituteTemplate(rowDetail.urlTemplate, values);
    } catch (err) {
      failedCount++;
      failReason ??= `substitution failed: ${(err as Error).message}`;
      continue;
    }
    const cacheKey = cacheScope ? `${cacheScope}|${fingerprint}|${url}` : null;
    if (cacheKey) {
      const hit = detailCache.get(cacheKey);
      if (hit && now() - hit.at <= DETAIL_CACHE_TTL_MS) {
        for (const [col, v] of Object.entries(hit.values)) row[col] = v;
        enrichedCount++;
        continue;
      }
    }
    try {
      const fetched = await fetcher(url, rowDetail.columns);
      for (const [col, v] of Object.entries(fetched)) row[col] = v;
      enrichedCount++;
      if (cacheKey) {
        if (detailCache.size >= DETAIL_CACHE_MAX) {
          // Insertion-order eviction — good enough for a safety cache.
          const oldest = detailCache.keys().next().value;
          if (oldest !== undefined) detailCache.delete(oldest);
        }
        detailCache.set(cacheKey, { values: fetched, at: now() });
      }
    } catch (err) {
      failedCount++;
      failReason ??= `detail fetch failed: ${(err as Error).message}`;
    }
  }

  return failedCount === 0
    ? { ok: true, enrichedCount, failedCount }
    : { ok: false, enrichedCount, failedCount, reason: failReason ?? 'detail enrichment failed' };
}

function makePageDetailFetcher(page: Page, allowedHost: string): DetailFetcher {
  return async (url, columns) => {
    await safeGoto(page, url, {
      allowedHost,
      context: 'extractor:row_detail:goto',
      waitUntil: 'domcontentloaded',
      timeoutMs: DETAIL_NAV_TIMEOUT_MS,
    });
    return extractDetailFields(page, columns);
  };
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
  /** Scopes the per-row detail cache (feature/cua-column-recovery). The
   *  session-driver passes `${propertyId}:v${knowledgeFileVersion}` — tenant
   *  isolation + selector-change invalidation in one key. Absent → caching
   *  disabled. */
  detailCacheScope?: string;
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

  // feature/cua-column-recovery — per-row detail enrichment for recovered
  // REQUIRED columns. Strictness is write-strategy-aware: on a `reconcile`
  // feed a partially-enriched batch is DANGEROUS (rows whose required detail
  // value is missing get rejected per-row by the writer, and reconcile then
  // auto-resolves them as "disappeared" — closing live work orders), so any
  // systematic enrichment failure fails the whole run. On upsert feeds a
  // partial batch is safe (an un-enriched row rejects alone and fills on the
  // next poll via the cache) — enrich best-effort and log.
  if (template.rowDetail && sourceResult.rows.length > 0) {
    const enrich = await enrichRowsWithDetail({
      rows: sourceResult.rows,
      rowDetail: template.rowDetail,
      fetcher: makePageDetailFetcher(page, allowedHost),
      cacheScope: args.detailCacheScope,
      signal,
    });
    if (!enrich.ok) {
      log.warn('template-runner: row-detail enrichment incomplete', {
        tableName: template.tableName,
        sourceActionKey: template.sourceActionKey,
        writeStrategy: template.writeStrategy,
        enriched: enrich.enrichedCount,
        failed: enrich.failedCount,
        reason: enrich.reason,
      });
      if (template.writeStrategy === 'reconcile') {
        const reason = `detail_enrichment_failed: ${enrich.reason ?? 'unknown'} (${enrich.enrichedCount} ok, ${enrich.failedCount} failed) — refusing partial batch on a reconcile feed`;
        return {
          ok: false,
          rows: [],
          sourceResults: [{ name: source.name, ok: false, rowCount: sourceResult.rows.length, reason }],
          reason,
        };
      }
    }
  }

  const parsedRows = sourceResult.rows.map((r) => ({
    ...applyTemplateParsers(r, template, 'list_row'),
    ...applyTemplateParsers(r, template, 'detail_page'),
  }));

  const blankCols = findBlankContractColumns(template, parsedRows);
  if (blankCols.length > 0) {
    const reason =
      `blank_required_columns: [${blankCols.join(', ')}] — ${parsedRows.length} row(s) extracted ` +
      'but the column(s) are blank in every row (selector/jsonPath drift?)';
    log.warn('template-runner: feed failed contract integrity guard', {
      tableName: template.tableName,
      sourceActionKey: template.sourceActionKey,
      blankCols,
      rowCount: parsedRows.length,
    });
    return {
      ok: false,
      rows: [],
      sourceResults: [{ name: source.name, ok: false, rowCount: parsedRows.length, reason }],
      reason,
    };
  }

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
