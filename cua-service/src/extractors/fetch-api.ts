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
import { hostsAreSameSite } from '../browser-utils/navigate.js';
import type { FeedSpec } from '../knowledge-file.js';
import type { LearnedDateFormat } from '../types.js';
import { renderDatePlaceholders, renderBodyDatePlaceholders, looksLikeLiteralDateValue } from './date-template.js';

/** URLs already warned about a surviving literal date (once per process). */
const warnedFrozenDate = new Set<string>();

export interface FetchApiOptions {
  page: Page;
  feedSpec: FeedSpec;
  /** Recipe's pinned PMS host. When set, absolute URLs outside this site are
   *  REFUSED — the in-page fetch rides the authenticated session cookies
   *  (credentials:'include'), so a poisoned/drifted recipe must never be able
   *  to point it cross-origin (same Pattern B stance as safeGoto). */
  allowedHost?: string;
  signal?: AbortSignal;
}

export interface FetchApiResult {
  ok: boolean;
  data: unknown;
  reason?: string;
}

const FETCH_TIMEOUT_MS = 20_000;

/** IPv4 literal (optionally with port). hostsAreSameSite compares the last
 *  two DOT-LABELS, which is right for hostnames but wrong for IPs — it would
 *  call 5.6.3.4 "same site" as 1.2.3.4. IP-pinned PMSes get exact equality. */
const IPV4_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function stripPort(host: string): string {
  return host.replace(/:\d+$/, '');
}

/** Same-site check that treats IP literals as exact-match-only. */
function fetchHostAllowed(host: string, allowedHost: string): boolean {
  const a = stripPort(host).toLowerCase();
  const b = stripPort(allowedHost).toLowerCase();
  if (IPV4_HOST_RE.test(a) || IPV4_HOST_RE.test(b)) {
    return a === b;
  }
  return hostsAreSameSite(a, b);
}

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
  // Accept bracket spellings ('data.rows[0]', 'data[0].rows') by normalizing
  // to dot segments — the capture side may emit either form.
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  let current: unknown = root;
  const walked: string[] = [];
  for (const seg of segments) {
    walked.push(seg);
    if (current === null || current === undefined || typeof current !== 'object') {
      return { found: false, stoppedAt: walked.join('.') };
    }
    // OWN properties only: a malicious/odd response must not let a path like
    // '__proto__' or 'constructor' resolve through the prototype chain to a
    // non-data object and masquerade as a row. (JSON.parse'd "__proto__"
    // keys are own properties and still resolve — that's real data. Arrays
    // pass this check for index keys — arr['0'] is an own property.)
    if (!Object.prototype.hasOwnProperty.call(current, seg)) {
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
  const { page, feedSpec, allowedHost, signal } = opts;
  const rawUrl = feedSpec.url;
  if (!rawUrl) {
    return { ok: false, data: null, reason: 'feedSpec missing url' };
  }

  // Host pin: relative URLs resolve against the (already host-pinned) page;
  // absolute URLs must stay on the recipe's PMS site. Any non-http(s) scheme
  // is refused outright. Protocol-relative forms (//host/…, and \\host/… —
  // WHATWG URL treats backslashes as slashes) carry a HOST without a scheme,
  // so they're pinned like absolute URLs.
  const trimmedUrl = rawUrl.trim();
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmedUrl);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1]!)) {
    return { ok: false, data: null, reason: `refused non-http(s) scheme "${schemeMatch[1]}"` };
  }
  const isProtocolRelative = !schemeMatch && /^[/\\]{2}/.test(trimmedUrl);
  if ((schemeMatch || isProtocolRelative) && allowedHost) {
    let host: string;
    try {
      host = schemeMatch
        ? new URL(trimmedUrl).host
        : new URL(`https://${trimmedUrl.replace(/^[/\\]+/, '')}`).host;
    } catch {
      return { ok: false, data: null, reason: 'unparseable absolute url' };
    }
    if (!fetchHostAllowed(host, allowedHost)) {
      log.warn('extractor:fetch_api: refused cross-site fetch', { host, allowedHost });
      return {
        ok: false,
        data: null,
        reason: `refused cross-site fetch: "${host}" is outside the recipe's pinned site "${allowedHost}"`,
      };
    }
  }

  const method = (feedSpec.extra?.method as string | undefined) ?? 'GET';
  const rawBody = feedSpec.extra?.body as string | Record<string, unknown> | undefined;
  const headers = (feedSpec.extra?.headers as Record<string, string> | undefined) ?? {};
  const expectJson = (feedSpec.extra?.expectJson as boolean | undefined) ?? true;
  // Whitespace-only jsonPath is "absent", not "resolve the root" — a truthy
  // ' ' would otherwise wrap the whole response envelope as one garbage row.
  const jsonPath = ((feedSpec.extra?.jsonPath as string | undefined) ?? '').trim() || undefined;
  const dateRender = feedSpec.extra?.dateRender as LearnedDateFormat | undefined;
  const timezone = feedSpec.extra?.timezone as string | undefined;

  // Stale-date guard: render {today}/{date} NOW, per call. ONE clock for
  // url + body so a poll straddling local midnight can't send yesterday's
  // date in one and today's in the other.
  const now = new Date();
  const url = renderDatePlaceholders(rawUrl, {
    context: 'url',
    learnedFormat: dateRender,
    timezone,
    now,
  });
  let body = renderBodyDatePlaceholders(rawBody, {
    learnedFormat: dateRender,
    timezone,
    now,
  });
  // fetch() throws a TypeError on GET/HEAD with a body — that would surface
  // as a cryptic "evaluate failed" every poll. A captured GET never had a
  // real body; drop it and say so.
  if (body !== undefined && /^(GET|HEAD)$/i.test(method)) {
    log.warn('extractor:fetch_api: dropping body on GET/HEAD request', { url, method });
    body = undefined;
  }
  // Frozen-date tripwire: a concrete calendar date SURVIVING the render means
  // the mapper failed to turn the mapping-day date into a {today} placeholder
  // — this feed will silently re-fetch mapping day forever. Warn once per
  // URL per process (every-poll spam would drown the signal).
  if (!warnedFrozenDate.has(rawUrl)) {
    const bodyStr = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
    if (looksLikeLiteralDateValue(url) || looksLikeLiteralDateValue(bodyStr)) {
      warnedFrozenDate.add(rawUrl);
      log.warn('extractor:fetch_api: request still carries a LITERAL calendar date after placeholder rendering — mapper may have left a frozen mapping-day date (stale-date risk)', {
        url,
      });
    }
  }

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
            // The browser HTTP/ServiceWorker cache can serve a same-URL GET
            // stale across 30s polls — the one staleness path a freshly
            // re-templated date can't fix. Always hit the network.
            cache: 'no-store',
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
    // 401/403 is a SESSION problem (expired / logged out), not endpoint
    // drift — flag it so ops + self-repair triage don't chase a re-map.
    const authHint = /^HTTP (401|403)$/.test(err) ? ' (auth — session may have expired)' : '';
    return { ok: false, data: null, reason: `${err}${authHint}` };
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
      // Rows must be objects. An array of scalars (ids, labels) means the
      // learned path points at the wrong node — every column would parse to
      // null and the feed would "succeed" with garbage rows. Fail loudly.
      const badIdx = value.findIndex((el) => el === null || typeof el !== 'object' || Array.isArray(el));
      if (badIdx !== -1) {
        const bad = value[badIdx];
        const kind = bad === null ? 'null' : Array.isArray(bad) ? 'an array' : typeof bad;
        return {
          ok: false,
          data: null,
          reason: `jsonPath "${jsonPath}" resolved to an array but element ${badIdx} is ${kind} — expected row objects`,
        };
      }
      return { ok: true, data: value };
    }
    if (value !== null && typeof value === 'object') {
      // Single-object feeds (e.g. a counts blob) are legitimate one-row data.
      // But if the object itself holds a row array under a conventional key,
      // the learned path is probably HALF-specified — wrapping it as one row
      // would "succeed" with garbage. Say what the fuller path likely is.
      for (const k of ['rows', 'results', 'data']) {
        if (Array.isArray((value as Record<string, unknown>)[k])) {
          log.warn('extractor:fetch_api: jsonPath resolved to an object that contains a row array — path may be half-specified', {
            url, jsonPath, suspectedFullerPath: `${jsonPath}.${k}`,
          });
          break;
        }
      }
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
