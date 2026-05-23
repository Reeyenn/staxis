/**
 * DOM table extractor.
 *
 * Generic: navigate to the feed's URL (if specified), wait for the row
 * selector to materialize, scrape each row using the column map. Returns
 * an array of objects keyed by canonical field name.
 *
 * Used for Choice Advantage's Housekeeping Center page (room conditions,
 * HK assignments). Future PMSes' tabular views (Mews reservation list,
 * etc.) plug in here without any extractor changes — they just need a
 * matching FeedSpec in the knowledge file.
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import { safeGoto } from '../browser-utils/navigate.js';
import type { FeedSpec } from '../knowledge-file.js';

export interface DomTableExtractOptions {
  page: Page;
  feedSpec: FeedSpec;
  allowedHost: string;
  signal?: AbortSignal;
  /** Hard cap on rows to prevent runaway DOM scrape on a too-broad selector. */
  maxRows?: number;
}

export interface DomTableExtractResult {
  ok: boolean;
  rows: Array<Record<string, string>>;
  reason?: string;
}

const DEFAULT_MAX_ROWS = 5000;
const ROW_SELECTOR_KEY = 'rowSelector';
const WAIT_TIMEOUT_MS = 15_000;

export async function extractDomTable(opts: DomTableExtractOptions): Promise<DomTableExtractResult> {
  const { page, feedSpec, allowedHost, signal } = opts;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

  const rowSelector = feedSpec.selectors?.[ROW_SELECTOR_KEY];
  const columns = feedSpec.columns;

  if (!rowSelector || !columns || Object.keys(columns).length === 0) {
    return {
      ok: false,
      rows: [],
      reason: 'feedSpec missing selectors.rowSelector or columns map',
    };
  }

  if (feedSpec.url) {
    try {
      await safeGoto(page, feedSpec.url, {
        allowedHost,
        context: 'extractor:dom_table:goto',
      });
    } catch (err) {
      return { ok: false, rows: [], reason: `navigate failed: ${(err as Error).message}` };
    }
  }

  if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

  try {
    await page.waitForSelector(rowSelector, { timeout: WAIT_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, rows: [], reason: `row selector did not appear: ${(err as Error).message}` };
  }

  if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

  try {
    const rows = await page.$$eval(
      rowSelector,
      (els: Element[], columnMap: Record<string, string>) => {
        return els.map((el: Element) => {
          const out: Record<string, string> = {};
          for (const [field, sel] of Object.entries(columnMap)) {
            if (!sel) continue;
            const target = sel === '.' ? el : el.querySelector(sel);
            out[field] = target ? (target.textContent ?? '').trim() : '';
          }
          return out;
        });
      },
      columns,
    );

    if (rows.length > maxRows) {
      log.warn('extractor:dom_table: row count over cap, truncating', {
        rowSelector,
        rowCount: rows.length,
        cap: maxRows,
      });
      return {
        ok: false,
        rows: rows.slice(0, maxRows),
        reason: `too_many_rows: ${rows.length} > ${maxRows} — refine rowSelector`,
      };
    }

    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows: [], reason: `scrape failed: ${(err as Error).message}` };
  }
}
