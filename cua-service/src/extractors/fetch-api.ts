/**
 * Fetch-API extractor.
 *
 * Used for endpoints that the PMS exposes as JSON (the structured data the
 * page itself fetches under the hood). We use page.evaluate so the request
 * carries the page's cookies — no need to extract cookies and recreate a
 * separate authenticated session.
 *
 * The feed spec drives method, headers, body, and the response JSON path:
 *   - extra.method:   'GET' | 'POST' (default GET)
 *   - extra.body:     string bodyTemplate (form or JSON) or object (legacy)
 *   - extra.headers:  static captured headers
 *   - extra.jsonPath: dot-path to the row array inside the response
 *                     (e.g. 'data.reservations'); absent → caller unwraps
 *   - extra.dateRender / extra.timezone: learned date format + hotel TZ for
 *                     placeholder rendering (recipe-adapter supplies these)
 *
 * STALE-DATE GUARD: `{today}` / `{date}` placeholders in the URL and body
 * are rendered HERE, immediately before the fetch, on every call. A frozen
 * concrete date would silently return yesterday's data forever; rendering
 * at template-build time would be just as wrong the moment a template is
 * cached. See extractors/date-template.ts.
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import type { FeedSpec } from '../knowledge-file.js';
import type { LearnedDateFormat } from '../types.js';
import { renderDatePlaceholders, renderBodyDatePlaceholders } from './date-template.js';

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

/**
 * Resolve a dot-path ('data.reservations', 'result.0.rows') against a parsed
 * JSON value. Numeric segments index arrays. Returns a discriminated result
 * instead of throwing so the caller can produce a precise failure reason —
 * a missing path must FAIL the feed loudly, never silently yield 0 rows.
 */
export function resolveJsonPath(
  root: unknown,
  path: string,
): { found: true; value: unknown } | { found: false; stoppedAt: string } {
  const segments = path.split('.').map((s) => s.trim()).filter((s) => s !== '');
  let current: unknown = root;
  const walked: string[] = [];
  for (const seg of segments) {
    walked.push(seg);
    if (current === null || current === undefined || typeof current !== 'object') {
      return { found: false, stoppedAt: walked.join('.') };
    }
    current = (current as Record<string, unknown>)[seg];
    if (current === undefined) {
      return { found: false, stoppedAt: walked.join('.') };
    }
  }
  return { found: true, value: current };
}

export async function extractFetchApi(opts: FetchApiOptions): Promise<FetchApiResult> {
  const { page, feedSpec, signal } = opts;
  const rawUrl = feedSpec.url;
  if (!rawUrl) {
    return { ok: false, data: null, reason: 'feedSpec missing url' };
  }

  const method = (feedSpec.extra?.method as string | undefined) ?? 'GET';
  const rawBody = feedSpec.extra?.body as string | Record<string, unknown> | undefined;
  const headers = (feedSpec.extra?.headers as Record<string, string> | undefined) ?? {};
  const expectJson = (feedSpec.extra?.expectJson as boolean | undefined) ?? true;
  const jsonPath = feedSpec.extra?.jsonPath as string | undefined;
  const dateRender = feedSpec.extra?.dateRender as LearnedDateFormat | undefined;
  const timezone = feedSpec.extra?.timezone as string | undefined;

  // Stale-date guard: render {today}/{date} NOW, per call.
  const url = renderDatePlaceholders(rawUrl, {
    context: 'url',
    learnedFormat: dateRender,
    timezone,
  });
  const body = renderBodyDatePlaceholders(rawBody, {
    learnedFormat: dateRender,
    timezone,
  });

  if (signal?.aborted) return { ok: false, data: null, reason: 'aborted' };

  let data: unknown;
  try {
    data = await page.evaluate(
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
              // A string bodyTemplate may be a form-encoded pair list OR a
              // JSON literal — declare the matching content type so picky
              // endpoints don't reject the replayed call.
              const t = args.body.trim();
              contentType = (t.startsWith('{') || t.startsWith('['))
                ? 'application/json'
                : 'application/x-www-form-urlencoded';
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
            // A login wall or error page served with 200 is usually HTML —
            // resp.json() would throw a cryptic SyntaxError. Catch and
            // surface a structured reason instead.
            try {
              return await resp.json();
            } catch {
              return { __fetchError: 'response was not valid JSON (login wall or error page?)' };
            }
          }
          return await resp.text();
        } finally {
          clearTimeout(timer);
        }
      },
      { url, method, body, headers, expectJson, timeoutMs: FETCH_TIMEOUT_MS },
    );
  } catch (err) {
    return { ok: false, data: null, reason: `evaluate failed: ${(err as Error).message}` };
  }

  if (data && typeof data === 'object' && '__fetchError' in (data as Record<string, unknown>)) {
    const err = (data as { __fetchError: string }).__fetchError;
    log.warn('extractor:fetch_api: HTTP error', { url, err });
    return { ok: false, data: null, reason: err };
  }

  // Learned dot-path to the row array. A path that no longer resolves means
  // the endpoint's response shape drifted — fail LOUDLY (feed error → admin
  // visibility + self-repair signal), never return a silent empty success.
  if (jsonPath) {
    const resolved = resolveJsonPath(data, jsonPath);
    if (!resolved.found) {
      log.warn('extractor:fetch_api: jsonPath did not resolve', { url, jsonPath, stoppedAt: resolved.stoppedAt });
      return {
        ok: false,
        data: null,
        reason: `jsonPath "${jsonPath}" did not resolve (stopped at "${resolved.stoppedAt}") — response shape may have drifted`,
      };
    }
    const value = resolved.value;
    if (Array.isArray(value)) {
      return { ok: true, data: value };
    }
    if (value !== null && typeof value === 'object') {
      // Single-object feeds (e.g. a counts blob) are legitimate one-row data.
      return { ok: true, data: [value] };
    }
    return {
      ok: false,
      data: null,
      reason: `jsonPath "${jsonPath}" resolved to ${value === null ? 'null' : typeof value} — expected an array of rows or a row object`,
    };
  }

  return { ok: true, data };
}
