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
 *
 * feature/cua-feed-replay — three replay-fidelity fixes so a feed the vision
 * mapper learned actually extracts on deterministic replay:
 *   1. Row pre-wait uses state:'attached' (NOT 'visible'). The reader
 *      (dom-rows scrapeCssRows) reads textContent off attached nodes with no
 *      visibility filter, so 'visible' was strictly stronger than the reader
 *      and timed out on present-but-hidden rows (e.g. CA's collapsed HK table).
 *   2. A re-auth bounce after navigation fails the feed with bounced_to_reauth
 *      (→ the poll re-logs-in) instead of scraping login chrome — and never lets
 *      a reconcile feed auto-resolve live rows from an empty-because-bounced read.
 *   3. Menu-replay fallback: when the cold deep-link source url yields no rows
 *      / bounces, replay the FULL learned menu chain (by roleName) from a base.
 *      Some PMS report pages only render when reached via the in-app menu
 *      (frameset/session context a cold goto can't rebuild).
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import { safeGoto, detectReauthBounce } from '../browser-utils/navigate.js';
import { extractDomRows } from './dom-rows.js';
import { parsePreSteps, replayPreSteps } from './pre-steps.js';
import type { FeedSpec } from '../knowledge-file.js';
import type { LearnedDateFormat, TieredSelector } from '../types.js';

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
/** Bounded settle after a goto so frameset / redirect-chain pages finish before
 *  the row wait races a half-loaded document. Swallows timeout (chatty pages). */
const SETTLE_TIMEOUT_MS = 8_000;

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

  // feature/cua-semantic-columns — durable per-column header anchors (+ optional
  // rowSelector xpath fallback) ride feedSpec.extra (the runtime bridge forwards
  // only `extra`). Absent ⟹ the reader takes its byte-identical legacy path.
  const columnsTiered = feedSpec.extra?.columnsTiered as Record<string, TieredSelector> | undefined;
  const rowSelectorTiered = feedSpec.extra?.rowSelectorTiered as TieredSelector | undefined;
  // feature/cua-feed-replay — the full learned menu chain, used only as a
  // fallback when the cold deep-link yields no rows / bounces.
  const navChain = feedSpec.extra?.navChain as { baseUrl?: string; steps?: unknown } | undefined;

  // Shared "wait for rows + scrape" on the current page. state:'attached' aligns
  // the gate with the presence-reader (see header #1).
  const waitAndScrape = async (): Promise<DomTableExtractResult> => {
    try {
      await page.waitForSelector(rowSelector, { state: 'attached', timeout: WAIT_TIMEOUT_MS });
    } catch (err) {
      if (rowSelectorTiered?.xpath) {
        try {
          await page.waitForSelector(`xpath=${rowSelectorTiered.xpath}`, { state: 'attached', timeout: WAIT_TIMEOUT_MS });
        } catch {
          return { ok: false, rows: [], reason: `row selector did not appear (css + xpath): ${(err as Error).message}` };
        }
      } else {
        return { ok: false, rows: [], reason: `row selector did not appear: ${(err as Error).message}` };
      }
    }

    if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

    try {
      // Shared reader (extractors/dom-rows.ts) — the SAME implementation the
      // mapper verifies selectors with, including the '@attr' convention. Any
      // fork here re-opens the "verified at mapping, blank at poll" bug class.
      const extraction = await extractDomRows(page, rowSelector, columns, {
        cap: maxRows,
        ...(columnsTiered ? { columnsTiered } : {}),
        ...(rowSelectorTiered ? { rowSelectorTiered } : {}),
      });
      const { rows, totalMatched } = extraction;

      // Tier telemetry — CSS-drift / self-heal observability over weeks.
      if (extraction.resolution && extraction.resolution.length > 0) {
        const tiers = { roleName: 0, css: 0, xpath: 0, legacy: 0 };
        for (const r of extraction.resolution) tiers[r.tier]++;
        const selfHealed = extraction.resolution
          .filter((r) => r.drift)
          .map((r) => `${r.field}:${r.fromIndex}->${r.toIndex}`);
        log.info('extractor:dom_table tier resolution', {
          rowSelector,
          rowSelectorTier: extraction.rowSelectorTier,
          tiers,
          ...(selfHealed.length > 0 ? { selfHealed } : {}),
        });
      }

      if (totalMatched > maxRows) {
        log.warn('extractor:dom_table: row count over cap, truncating', {
          rowSelector,
          rowCount: totalMatched,
          cap: maxRows,
        });
        return {
          ok: false,
          rows,
          reason: `too_many_rows: ${totalMatched} > ${maxRows} — refine rowSelector`,
        };
      }

      return { ok: true, rows };
    } catch (err) {
      return { ok: false, rows: [], reason: `scrape failed: ${(err as Error).message}` };
    }
  };

  // One navigation+scrape attempt. `via` selects the directly-navigable source
  // url + trailing preSteps (primary) or the full learned menu chain (fallback).
  const attempt = async (
    via: 'primary' | 'menu',
  ): Promise<DomTableExtractResult & { bounced?: boolean }> => {
    if (via === 'primary') {
      if (feedSpec.url) {
        try {
          await safeGoto(page, feedSpec.url, { allowedHost, context: 'extractor:dom_table:goto' });
        } catch (err) {
          return { ok: false, rows: [], reason: `navigate failed: ${(err as Error).message}` };
        }
        await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
      }
    } else {
      try {
        await safeGoto(page, navChain!.baseUrl as string, { allowedHost, context: 'extractor:dom_table:menu-base' });
      } catch (err) {
        return { ok: false, rows: [], reason: `menu-nav base goto failed: ${(err as Error).message}` };
      }
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    }

    if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

    // Replay the recorded in-page interaction: primary = the trailing preSteps
    // (after the last goto); menu = the FULL learned click chain (by roleName).
    // recipe-adapter carries these on extra.preSteps / extra.navChain. A
    // malformed list or a failed replay fails the feed loudly.
    const rawSteps = via === 'primary' ? feedSpec.extra?.preSteps : navChain?.steps;
    const parsedPre = parsePreSteps(rawSteps);
    if (!parsedPre.ok) {
      return { ok: false, rows: [], reason: `invalid ${via} preSteps: ${parsedPre.reason}` };
    }
    if (parsedPre.steps.length > 0) {
      const replay = await replayPreSteps(page, parsedPre.steps, {
        signal,
        learnedFormat: feedSpec.extra?.dateRender as LearnedDateFormat | undefined,
        timezone: feedSpec.extra?.timezone as string | undefined,
      });
      if (!replay.ok) {
        return { ok: false, rows: [], reason: replay.reason };
      }
    }

    if (signal?.aborted) return { ok: false, rows: [], reason: 'aborted' };

    // Re-auth guard (see header #2): a navigation/interaction that bounced to a
    // login screen must NOT be scraped as data and must NOT drive reconcile.
    if (await detectReauthBounce(page)) {
      return { ok: false, rows: [], reason: 'bounced_to_reauth', bounced: true };
    }

    return waitAndScrape();
  };

  const primary = await attempt('primary');
  // ok=true means the page loaded and the row selector resolved — trust it even
  // at 0 rows (a legitimately empty feed); only a failed/bounced primary falls
  // back, so a quiet feed doesn't trigger a needless menu nav every poll.
  if (primary.ok) return primary;
  if (signal?.aborted) return primary;

  // Menu-replay fallback (see header #3).
  if (navChain?.baseUrl && Array.isArray(navChain.steps)) {
    log.info('extractor:dom_table: primary nav failed — retrying via learned menu chain', {
      rowSelector,
      primaryReason: primary.reason,
    });
    const fallback = await attempt('menu');
    if (fallback.ok) return fallback;
    // Both paths bounced → genuine session expiry; surface bounced_to_reauth so
    // the poll re-logs-in rather than mis-reading it as drift / empty data.
    if (fallback.bounced || primary.bounced) {
      return { ok: false, rows: [], reason: 'bounced_to_reauth' };
    }
    return fallback;
  }

  return primary;
}
