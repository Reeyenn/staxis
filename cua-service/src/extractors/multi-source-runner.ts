/**
 * Multi-source template runner (Plan v7 Phase 2b).
 *
 * Some TableTemplates have multiple sources that must be fetched and
 * aggregated into a single row. The canonical example is
 * `pms_in_house_snapshot` (dashboard_counts feed), which fetches 3 URLs
 * in parallel — in-house, arrivals, departures — and merges them into
 * one snapshot row with three named fields.
 *
 * Before Plan v7 this was hard-coded as a special case in
 * `session-driver.runCaDashboardCounts`. The template's
 * `sources[]` + `aggregate` first-class shape makes it generic.
 *
 * Aggregate strategies:
 *   - `merge_named`: each named source contributes specific fields to
 *     ONE output row (dashboard_counts pattern).
 *   - `concat_rows`: each source returns rows; all are concatenated
 *     (would be used if, say, reservations had separate arrivals + departures
 *     pages we wanted to merge into one pms_reservations table).
 *   - `first_non_null`: try each source in order; use the first one that
 *     returned at least one row (failover pattern).
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import { runSource, applyTemplateParsers } from './template-runner.js';
import type { TableTemplate } from '../types.js';
import type { TemplateRunResult } from './template-runner.js';

export async function runMultiSourceTemplate(args: {
  page: Page;
  template: TableTemplate;
  allowedHost: string;
  signal: AbortSignal;
}): Promise<TemplateRunResult> {
  const { template, page, allowedHost, signal } = args;
  if (template.sources.length < 2) {
    return {
      ok: false,
      rows: [],
      sourceResults: [],
      reason: 'runMultiSourceTemplate requires ≥ 2 sources',
    };
  }
  if (!template.aggregate) {
    return {
      ok: false,
      rows: [],
      sourceResults: [],
      reason: 'multi-source template missing aggregate spec',
    };
  }

  // Fetch all sources in parallel.
  const fetchedResults = await Promise.all(
    template.sources.map(async (source) => {
      const r = await runSource(page, source, allowedHost, signal);
      return { source, ...r };
    }),
  );

  // Even if some sources fail, we try to aggregate from what we have —
  // matches the legacy choice-advantage normalizer's tolerance for
  // partial dashboard pulls (one stale page doesn't kill the snapshot).
  const sourceResults = fetchedResults.map((r) => ({
    name: r.source.name,
    ok: r.ok,
    rowCount: r.rows.length,
    reason: r.reason,
  }));

  // ── Apply aggregate strategy ────────────────────────────────────────
  let rows: Array<Record<string, unknown>> = [];
  const strategy = template.aggregate.strategy;

  if (strategy === 'merge_named') {
    // For each output column in template.fields, find its source
    // (field.source = source.name), grab the value from that source's
    // first row, apply the parser.
    const merged: Record<string, unknown> = {};
    for (const [col, field] of Object.entries(template.fields)) {
      const sourceFetch = fetchedResults.find((f) => f.source.name === field.source);
      if (!sourceFetch || sourceFetch.rows.length === 0) {
        merged[col] = null;
        continue;
      }
      // Use the first row from this source (multi-source aggregates
      // typically have 1-row-per-source).
      const sourceRow = sourceFetch.rows[0]!;
      const parsed = applyTemplateParsers(sourceRow, {
        ...template,
        fields: { [col]: field },  // narrow to just this field
      }, field.origin);
      merged[col] = parsed[col];
    }
    rows = [merged];
  } else if (strategy === 'concat_rows') {
    // Each source's rows go through its respective field parsers, then
    // we union into one big row list. Useful for "arrivals page + dep
    // page → one reservations table."
    for (const fetch of fetchedResults) {
      if (!fetch.ok) continue;
      for (const r of fetch.rows) {
        rows.push(applyTemplateParsers(r, template, 'list_row'));
      }
    }
  } else if (strategy === 'first_non_null') {
    // Take the first source that returned rows.
    const firstOk = fetchedResults.find((f) => f.ok && f.rows.length > 0);
    if (firstOk) {
      rows = firstOk.rows.map((r) => applyTemplateParsers(r, template, 'list_row'));
    }
  } else {
    return {
      ok: false,
      rows: [],
      sourceResults,
      reason: `unknown aggregate strategy: ${strategy}`,
    };
  }

  log.info('multi-source-runner: aggregation complete', {
    tableName: template.tableName,
    strategy,
    sourceCount: template.sources.length,
    rowsOut: rows.length,
  });

  return { ok: true, rows, sourceResults };
}
