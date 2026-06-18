/**
 * DOM inline extractor.
 *
 * Reads specific elements from a page and returns a single object
 * mapping field name -> trimmed text content. Used for Choice
 * Advantage's three Dashboard pages (ViewInHouseList, ViewArrivalsList,
 * ViewDeparturesList) where each page has a single "Room Count: N" cell
 * and we just want that one number.
 *
 * For multi-page extraction (3 dashboard pages → 1 snapshot row),
 * caller invokes this once per page and aggregates the results.
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import { safeGoto, detectReauthBounce } from '../browser-utils/navigate.js';
import type { FeedSpec } from '../knowledge-file.js';

export interface DomInlineOptions {
  page: Page;
  feedSpec: FeedSpec;
  allowedHost: string;
  signal?: AbortSignal;
}

export interface DomInlineResult {
  ok: boolean;
  data: Record<string, string | null>;
  reason?: string;
}

const WAIT_TIMEOUT_MS = 15_000;

export async function extractDomInline(opts: DomInlineOptions): Promise<DomInlineResult> {
  const { page, feedSpec, allowedHost, signal } = opts;
  const fields = feedSpec.columns;
  if (!fields || Object.keys(fields).length === 0) {
    return { ok: false, data: {}, reason: 'feedSpec missing columns (field -> selector map)' };
  }

  if (feedSpec.url) {
    try {
      await safeGoto(page, feedSpec.url, {
        allowedHost,
        context: 'extractor:dom_inline:goto',
      });
    } catch (err) {
      return { ok: false, data: {}, reason: `navigate failed: ${(err as Error).message}` };
    }
    // Bounded settle for frameset / redirect-chain pages before reading.
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  }

  if (signal?.aborted) return { ok: false, data: {}, reason: 'aborted' };

  // feature/cua-feed-replay — re-auth guard: a goto that bounced to a login
  // screen must not be scraped as data (and never drive a reconcile feed).
  if (await detectReauthBounce(page)) {
    return { ok: false, data: {}, reason: 'bounced_to_reauth' };
  }

  // Wait for at least one of the requested selectors to materialize. attached
  // (not visible): document.querySelector below reads textContent off attached
  // nodes — demanding visibility would time out on present-but-hidden values.
  const firstSelector = Object.values(fields)[0];
  if (firstSelector) {
    try {
      await page.waitForSelector(firstSelector, { state: 'attached', timeout: WAIT_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, data: {}, reason: `selector did not appear: ${(err as Error).message}` };
    }
  }

  if (signal?.aborted) return { ok: false, data: {}, reason: 'aborted' };

  try {
    const data = await page.evaluate((fieldsMap: Record<string, string>) => {
      const out: Record<string, string | null> = {};
      for (const [field, sel] of Object.entries(fieldsMap)) {
        const el = document.querySelector(sel);
        out[field] = el ? (el.textContent ?? '').trim() : null;
      }
      return out;
    }, fields);

    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: {}, reason: `evaluate failed: ${(err as Error).message}` };
  }
}
