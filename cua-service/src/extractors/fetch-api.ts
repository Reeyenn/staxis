/**
 * Fetch-API extractor.
 *
 * Used for endpoints that the PMS exposes as JSON (e.g., Choice
 * Advantage's WorkOrders.jx, Mews API calls made from inside their SPA).
 * We use page.evaluate so the request carries the page's cookies — no
 * need to extract cookies and recreate a separate authenticated session.
 *
 * The feed spec drives method, headers, body, response JSON path.
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import type { FeedSpec } from '../knowledge-file.js';

export interface FetchApiOptions {
  page: Page;
  feedSpec: FeedSpec;
  signal?: AbortSignal;
}

export interface FetchApiResult {
  ok: boolean;
  data: unknown;
  reason?: string;
}

const FETCH_TIMEOUT_MS = 20_000;

export async function extractFetchApi(opts: FetchApiOptions): Promise<FetchApiResult> {
  const { page, feedSpec, signal } = opts;
  const url = feedSpec.url;
  if (!url) {
    return { ok: false, data: null, reason: 'feedSpec missing url' };
  }

  const method = (feedSpec.extra?.method as string | undefined) ?? 'GET';
  const body = feedSpec.extra?.body as string | Record<string, unknown> | undefined;
  const headers = (feedSpec.extra?.headers as Record<string, string> | undefined) ?? {};
  const expectJson = (feedSpec.extra?.expectJson as boolean | undefined) ?? true;

  if (signal?.aborted) return { ok: false, data: null, reason: 'aborted' };

  try {
    const data = await page.evaluate(
      async (args: {
        url: string;
        method: string;
        body: string | Record<string, unknown> | undefined;
        headers: Record<string, string>;
        expectJson: boolean;
        timeoutMs: number;
      }) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), args.timeoutMs);
        try {
          let bodyStr: string | undefined;
          let contentType: string | undefined;
          if (args.body !== undefined) {
            if (typeof args.body === 'string') {
              bodyStr = args.body;
              contentType = 'application/x-www-form-urlencoded';
            } else {
              bodyStr = JSON.stringify(args.body);
              contentType = 'application/json';
            }
          }
          const resp = await fetch(args.url, {
            method: args.method,
            credentials: 'include',
            headers: {
              ...(contentType ? { 'content-type': contentType } : {}),
              ...args.headers,
            },
            body: bodyStr,
            signal: ctrl.signal,
          });
          if (!resp.ok) {
            return { __fetchError: `HTTP ${resp.status}` };
          }
          if (args.expectJson) {
            return await resp.json();
          }
          return await resp.text();
        } finally {
          clearTimeout(timer);
        }
      },
      { url, method, body, headers, expectJson, timeoutMs: FETCH_TIMEOUT_MS },
    );

    if (data && typeof data === 'object' && '__fetchError' in (data as Record<string, unknown>)) {
      const err = (data as { __fetchError: string }).__fetchError;
      log.warn('extractor:fetch_api: HTTP error', { url, err });
      return { ok: false, data: null, reason: err };
    }

    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: null, reason: `evaluate failed: ${(err as Error).message}` };
  }
}
