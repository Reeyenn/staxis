/**
 * Passive network-response capture for the LEARN run — the foundation of the
 * "read the clean data behind the page" path.
 *
 * SHARED CONTRACT (pinned by the orchestrator so the parallel build chats can't
 * drift). Chat 3 (Mapper) calls attachNetworkCapture() during the per-target
 * agent loop and reads handle.recent() to find the feed's underlying data call.
 *
 * MUST be passive (page.on('response') / requestfinished only) — NEVER
 * page.route() interception, which can alter SPA behavior and break the vision
 * agent mid-map. Bodies are PII-redacted (see response-redaction.ts) before they
 * are ever buffered, returned, logged, or sent to Claude.
 *
 * Implementation invariants (enforced by tests in network-capture.test.ts):
 *   - PASSIVE: listeners only, attached at the BrowserContext level (Playwright
 *     dispatches page-level 'response' events from the context event with the
 *     same Response instance, so one context listener covers the page, all its
 *     frames, its popups and service workers — without double-firing).
 *   - Scoped: only responses belonging to the attached page or popups opened
 *     from it are considered (one context per hotel session, but be explicit).
 *   - NOTHING is stored, returned or logged that didn't pass through
 *     response-redaction.ts — including the URL, query params, request headers
 *     and request body. Error paths never construct messages from response
 *     data (a rejecting listener would flow to Sentry via log.error).
 *   - Memory-capped: MAX_ENTRIES unique endpoints, MAX_BODY_BYTES per body,
 *     MAX_TOTAL_BYTES overall, a read-concurrency semaphore (response.text()
 *     transfers the full body over the driver pipe and cannot be size-limited
 *     in flight), and a poll-loop dedupe (one buffer slot per endpoint,
 *     updated in place). Worst case ≈ MAX_TOTAL_BYTES, far under the 80%-RSS
 *     restart threshold in memory-monitor.ts.
 *   - log.info with counters only; log.error is forbidden in this module.
 */

import type { BrowserContext, Page, Response } from 'playwright';
import { log } from './log.js';
import { hostsAreSameSite } from './browser-utils/navigate.js';
import {
  redactCsvText,
  redactHeaders,
  redactRequestBody,
  redactResponseBody,
  redactUrl,
  stripJsonGuards,
} from './response-redaction.js';

/** One data-bearing network call the page made during the learn run.
 *  `responseBody` is ALREADY PII-redacted (redactResponseBody). */
export interface CapturedCall {
  url: string;
  method: string;
  /** Request body (POST), if any — used to learn date/param templating. */
  requestBody: string | null;
  requestHeaders: Record<string, string>;
  status: number;
  contentType: string;
  /** Parsed + redacted JSON response value, or null if non-JSON / unparseable. */
  responseBody: unknown;
}

export interface NetworkCaptureHandle {
  /** Plausible data calls captured so far (JSON/CSV, non-trivial size,
   *  same-site; analytics/tracking/heartbeat noise filtered out), most-recent
   *  first. Already redacted. */
  recent(): CapturedCall[];
  /** Stop capturing and release listeners. Idempotent. */
  detach(): void;
}

// ─── Tuning ──────────────────────────────────────────────────────────────

const MAX_ENTRIES = 50;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_READS = 4;
const MAX_PENDING_READS = 32;
/** Buffer cost charged to entries kept without a body (endpoint signal). */
const NULL_BODY_COST = 256;

const KEPT_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'document', 'other']);

/**
 * Third-party hosts that can never be a PMS data feed, matched as exact
 * label suffixes (host === d || host.endsWith('.' + d)). Three tiers:
 * analytics/session-replay/tag/consent/chat vendors; payment gateways and
 * tokenization iframes (the most PII-dense cross-site traffic on a PMS
 * page); identity providers. Deliberately NO bare CDN domains — PMS APIs
 * ride cloudfront/akamai/fastly.
 */
const DENY_HOST_SUFFIXES = [
  // Analytics / tags / ads
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com',
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
  'maps.googleapis.com', 'recaptcha.net', 'gstatic.com',
  'connect.facebook.net', 'facebook.com', 'facebook.net', 'fbcdn.net',
  'linkedin.com', 'licdn.com', 'tiktok.com', 'bing.com', 'yandex.ru',
  'demdex.net', 'omtrdc.net', 'adobedtm.com', 'quantserve.com',
  'scorecardresearch.com', 'chartbeat.com', 'parsely.com',
  // Session replay / RUM / error reporting
  'clarity.ms', 'hotjar.com', 'hotjar.io', 'fullstory.com', 'logrocket.com',
  'logrocket.io', 'lr-ingest.io', 'smartlook.com', 'smartlook.cloud',
  'mouseflow.com', 'inspectlet.com', 'quantummetric.com',
  'glassboxdigital.com', 'sessioncam.com', 'datadoghq.com',
  'browser-intake-datadoghq.com', 'sentry.io', 'bugsnag.com', 'rollbar.com',
  'newrelic.com', 'nr-data.net', 'go-mpulse.net', 'akstat.io',
  'cloudflareinsights.com', 'pingdom.net', 'speedcurve.com',
  // Product analytics / CDP / marketing
  'segment.io', 'segment.com', 'amplitude.com', 'mixpanel.com',
  'heapanalytics.com', 'heap.io', 'pendo.io', 'posthog.com',
  'rudderstack.com', 'snowplowanalytics.com', 'branch.io', 'braze.com',
  'appsflyer.com', 'iterable.com', 'hubspot.com', 'hs-analytics.net',
  'hsforms.com', 'marketo.com', 'mktoresp.com', 'pardot.com',
  // Feature flags / A-B testing
  'launchdarkly.com', 'split.io', 'statsig.com', 'configcat.com',
  'flagsmith.com', 'optimizely.com', 'vwo.com', 'visualwebsiteoptimizer.com',
  'crazyegg.com', 'luckyorange.com',
  // Chat / support widgets
  'intercom.io', 'intercomcdn.com', 'drift.com', 'driftt.com', 'zendesk.com',
  'zdassets.com', 'liveperson.net', 'lpsnmedia.net',
  // Consent managers
  'onetrust.com', 'cookielaw.org', 'trustarc.com', 'usercentrics.eu',
  'osano.com',
  // Payment gateways / tokenization
  'stripe.com', 'stripe.network', 'adyen.com', 'braintreegateway.com',
  'braintree-api.com', 'paypal.com', 'paypalobjects.com', 'authorize.net',
  'spreedly.com', 'cybersource.com', 'freedompay.com', 'shift4.com',
  'i4go.com', 'worldpay.com', 'elavon.com', 'heartlandportico.com',
  'globalpaymentsinc.com', 'squareup.com', 'plaid.com',
  // Identity providers
  'okta.com', 'oktacdn.com', 'auth0.com', 'login.microsoftonline.com',
  'login.windows.net', 'accounts.google.com', 'duosecurity.com',
  'onelogin.com', 'pingidentity.com', 'pingone.com',
];

/**
 * Path-level noise. Deliberately conservative: NOT matching
 * analytics|track|collect|log|metrics — a PMS's own "analytics" or
 * "housekeeping tracking" endpoint is a real feed; wrongly dropping a real
 * feed (mapper degrades to DOM scraping) costs more than keeping redacted
 * noise in a capped buffer. 'beacon' is deliberately absent too: it's a
 * real hospitality property name (/hotels/beacon-hill/rooms) and sendBeacon
 * traffic arrives as resourceType 'ping', which is already dropped.
 */
const NOISE_PATH_RE = /(heartbeat|keep-?alive|web-?vitals|telemetry|sockjs|hot-update|__webpack)/i;
const NOISE_PATH_EXACT = new Set(['/ping', '/health', '/healthz', '/favicon.ico']);

/** Query params (and top-level POST-body keys) ignored for endpoint
 *  identity, so a 2s poll loop with a cache-buster occupies ONE slot. */
const CACHE_BUSTER_PARAMS = new Set([
  '_', 't', 'ts', '_t', 'timestamp', 'nocache', 'cb', 'cachebuster',
  'rand', 'random', 'r', 'v',
]);

// ─── Small helpers ───────────────────────────────────────────────────────

function normalizeContentType(raw: string | undefined): string {
  return (raw ?? '').split(';')[0].trim().toLowerCase();
}

function isIpLiteral(h: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

function isSameSiteAs(host: string, refUrl: string | null): boolean {
  if (!refUrl) return false;
  try {
    const refHost = new URL(refUrl).hostname.toLowerCase();
    if (refHost === '') return false;
    if (refHost === host) return true;
    // registrableDomain mangles IP literals — exact match only for those.
    if (isIpLiteral(host) || isIpLiteral(refHost)) return false;
    return hostsAreSameSite(host, refHost);
  } catch {
    return false;
  }
}

function isDeniedHost(host: string): boolean {
  return DENY_HOST_SUFFIXES.some((d) => host === d || host.endsWith('.' + d));
}

/** Tiny JSON / status-poll acks aren't learnable feeds and would churn the
 *  buffer: scalars, empty containers, and ≤2-key objects with no nested
 *  container (so the 3-key dashboard-counts feed survives). */
function isAckShaped(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return true;
  if (Array.isArray(v)) return v.length === 0;
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length === 0) return true;
  if (keys.length > 2) return false;
  return !keys.some((k) => {
    const x = (v as Record<string, unknown>)[k];
    return x !== null && typeof x === 'object';
  });
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function deepFreeze(v: unknown): void {
  if (v === null || typeof v !== 'object') return;
  Object.freeze(v);
  if (Array.isArray(v)) {
    for (const item of v) deepFreeze(item);
    return;
  }
  for (const k of Object.keys(v as Record<string, unknown>)) {
    deepFreeze((v as Record<string, unknown>)[k]);
  }
}

/** Drop volatile (cache-buster) parts from an already-REDACTED request body
 *  so POST-polling collapses to one endpoint key. */
function stableBodyKeyPart(redactedBody: string | null): string {
  if (!redactedBody) return '';
  try {
    const t = redactedBody.trimStart();
    if (t.startsWith('{')) {
      const parsed = JSON.parse(t) as Record<string, unknown>;
      const keys = Object.keys(parsed).filter((k) => !CACHE_BUSTER_PARAMS.has(k.toLowerCase())).sort();
      return fnv1a(JSON.stringify(keys.map((k) => [k, parsed[k]])));
    }
    if (t.includes('=') && !t.includes('{')) {
      const pairs = t.split('&').filter((p) => !CACHE_BUSTER_PARAMS.has(p.split('=')[0].toLowerCase())).sort();
      return fnv1a(pairs.join('&'));
    }
  } catch {
    // fall through — hash the redacted body as-is
  }
  return fnv1a(redactedBody);
}

type BodyKind = 'json' | 'json-sniff' | 'csv' | 'csv-sniff' | 'null-body' | 'drop';

function decideKind(ct: string, contentDisposition: string | undefined, sameSite: boolean): BodyKind {
  if (ct === 'text/event-stream') return 'drop'; // streaming — text() would hang
  if (
    ct.startsWith('image/') || ct.startsWith('font/') || ct.startsWith('video/') ||
    ct.startsWith('audio/') || ct === 'text/html' || ct === 'application/xhtml+xml' ||
    ct === 'text/css' || ct.includes('javascript')
  ) {
    return 'drop';
  }
  if (ct.includes('json')) return 'json';
  if (ct.includes('csv')) return 'csv';
  // Deliberately not same-site-gated: an explicit attachment filename is a
  // strong data-export signal, and report servers often live on a second
  // apex. The body still passes through redactCsvText like everything else.
  if (contentDisposition && /filename[^;]*\.csv/i.test(contentDisposition)) return 'csv';
  // XML data feeds (JSF partial-response, SOAP) — keep the endpoint as a
  // signal with a null body; the contract pins responseBody to JSON/CSV.
  if (ct.includes('xml')) return 'null-body';
  // Sniff paths (missing/lying content-types on legacy stacks) are a
  // same-site-only privilege; cross-site needs an explicit data type.
  if (!sameSite) return 'drop';
  if (ct === '' || ct === 'text/plain') return 'json-sniff';
  if (ct === 'application/vnd.ms-excel' || ct === 'application/octet-stream') return 'csv-sniff';
  return 'drop';
}

interface Entry {
  call: CapturedCall;
  byteCost: number;
}

/**
 * Attach passive response capture to a page for the duration of a learn run.
 * Returns a handle to read captured candidate data calls.
 *
 * recent() returns shallow copies whose responseBody is deep-frozen — the
 * buffer survives detach() and caller mutation cannot corrupt it.
 */
export function attachNetworkCapture(page: Page): NetworkCaptureHandle {
  // Map iteration order doubles as the LRU order: entries are delete+set on
  // update, so the first key is always the least-recently-updated.
  const entries = new Map<string, Entry>();
  const seen = new WeakSet<Response>();
  const allowedPages = new Set<Page>([page]);
  const popupListeners: Array<{ target: Page; handler: (p: Page) => void }> = [];
  const dropped: Record<string, number> = {};
  let detached = false;
  let totalBytes = 0;
  let inFlightReads = 0;
  let pendingReads = 0;
  const readWaiters: Array<() => void> = [];

  const bump = (reason: string): void => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };

  function watchPopups(p: Page): void {
    const handler = (popup: Page): void => {
      allowedPages.add(popup);
      watchPopups(popup);
    };
    p.on('popup', handler);
    popupListeners.push({ target: p, handler });
  }

  async function acquireRead(): Promise<boolean> {
    if (inFlightReads < MAX_CONCURRENT_READS) {
      inFlightReads++;
      return true;
    }
    if (pendingReads >= MAX_PENDING_READS) return false;
    pendingReads++;
    // The releasing read hands its permit straight to us (inFlightReads is
    // NOT decremented in that case), so a concurrent fast-path acquire can
    // never steal it and push concurrency past the cap.
    await new Promise<void>((resolve) => readWaiters.push(resolve));
    pendingReads--;
    return true;
  }

  function releaseRead(): void {
    const next = readWaiters.shift();
    if (next) {
      next(); // permit transferred to the waiter
      return;
    }
    inFlightReads--;
  }

  const BODY_TIMEOUT = Symbol('timeout');
  /** A never-settling transfer (comet/long-poll) may hold its read slot
   *  this long before the backstop frees it — bounds capture starvation
   *  while still bounding real concurrent transfers. */
  const SLOT_BACKSTOP_MS = 60_000;

  /**
   * Read the body while holding the read slot for the TRANSFER's lifetime,
   * not just the 10s race: on timeout the driver keeps streaming the body
   * in the background, so releasing at the race would let actual concurrent
   * transfers exceed MAX_CONCURRENT_READS and spike RSS.
   */
  async function readBodyHoldingSlot(r: Response): Promise<string | null | typeof BODY_TIMEOUT> {
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      releaseRead();
    };
    const backstop = setTimeout(releaseOnce, SLOT_BACKSTOP_MS);
    backstop.unref?.();
    let raceTimer: NodeJS.Timeout | undefined;
    try {
      // Rejections mapped at creation — a late rejection after losing the
      // race can never become an unhandledRejection.
      const body = r.text().then((t) => t as string | null, () => null);
      void body.finally(() => {
        clearTimeout(backstop);
        releaseOnce();
      });
      const timeout = new Promise<typeof BODY_TIMEOUT>((resolve) => {
        raceTimer = setTimeout(() => resolve(BODY_TIMEOUT), BODY_READ_TIMEOUT_MS);
        raceTimer.unref?.();
      });
      return await Promise.race([body, timeout]);
    } catch {
      // r.text() threw synchronously — free the slot now, not at backstop.
      clearTimeout(backstop);
      releaseOnce();
      return null;
    } finally {
      if (raceTimer) clearTimeout(raceTimer);
    }
  }

  function upsert(key: string, call: CapturedCall, byteCost: number): void {
    if (detached) return;
    const existing = entries.get(key);
    if (existing) {
      totalBytes -= existing.byteCost;
      entries.delete(key);
    }
    entries.set(key, { call, byteCost });
    totalBytes += byteCost;
    while (entries.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined || (oldestKey === key && entries.size === 1)) break;
      const evicted = entries.get(oldestKey);
      if (evicted) totalBytes -= evicted.byteCost;
      entries.delete(oldestKey);
      bump('evicted');
    }
  }

  function bufferKeyFor(method: string, rawUrl: string, redactedBody: string | null): string {
    let keyUrl: string;
    try {
      const u = new URL(rawUrl);
      for (const p of [...u.searchParams.keys()]) {
        if (CACHE_BUSTER_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
      }
      u.searchParams.sort();
      keyUrl = redactUrl(u.toString());
    } catch {
      keyUrl = redactUrl(rawUrl);
    }
    return `${method} ${keyUrl} ${stableBodyKeyPart(redactedBody)}`;
  }

  function buildAndBuffer(r: Response, rawUrl: string, method: string, status: number, contentType: string, responseBody: unknown, byteCost: number): void {
    const req = r.request();
    let rawHeaders: Record<string, string> = {};
    try {
      rawHeaders = req.headers();
    } catch {
      rawHeaders = {};
    }
    let postData: string | null = null;
    try {
      postData = req.postData();
    } catch {
      postData = null;
    }
    const requestBody = redactRequestBody(postData, rawHeaders['content-type'] ?? null);
    const call: CapturedCall = {
      url: redactUrl(rawUrl),
      method,
      requestBody,
      requestHeaders: redactHeaders(rawHeaders),
      status,
      contentType,
      responseBody,
    };
    deepFreeze(call.responseBody);
    Object.freeze(call.requestHeaders);
    Object.freeze(call);
    upsert(bufferKeyFor(method, rawUrl, requestBody), call, byteCost);
  }

  async function handleResponse(r: Response): Promise<void> {
    try {
      if (detached || seen.has(r)) return;
      seen.add(r);

      const rawUrl = r.url();
      if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) return bump('scheme');

      const req = r.request();
      if (!KEPT_RESOURCE_TYPES.has(req.resourceType())) return bump('resource_type');

      const method = req.method().toUpperCase();
      if (method === 'OPTIONS' || method === 'HEAD') return bump('method');

      const status = r.status();
      const cachedNotModified = status === 304;
      if (!cachedNotModified && (status < 200 || status >= 300)) return bump('status');

      // Scoping + reference URL for the same-site check. Service-worker
      // responses have no frame — response.frame() THROWS for them (and for
      // early navigations), so classify locally instead of letting the
      // master catch silently eat every SW-served feed.
      let isServiceWorker = false;
      try {
        isServiceWorker = req.serviceWorker() !== null;
      } catch {
        isServiceWorker = false;
      }
      let refUrl: string | null = null;
      if (!isServiceWorker) {
        try {
          const framePage = r.frame().page();
          if (!allowedPages.has(framePage)) return bump('other_page');
          refUrl = framePage.url();
        } catch {
          refUrl = null;
        }
      }
      if (refUrl === null) {
        try {
          refUrl = page.url();
        } catch {
          refUrl = null;
        }
      }

      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return bump('bad_url');
      }
      const host = parsed.hostname.toLowerCase();
      if (isDeniedHost(host)) return bump('denied_host');
      if (NOISE_PATH_EXACT.has(parsed.pathname) || NOISE_PATH_RE.test(parsed.pathname)) {
        return bump('noise_path');
      }

      const sameSite = isSameSiteAs(host, refUrl);
      if (isServiceWorker && !sameSite) return bump('sw_cross_site');

      let respHeaders: Record<string, string> = {};
      try {
        respHeaders = r.headers();
      } catch {
        respHeaders = {};
      }
      const contentType = normalizeContentType(respHeaders['content-type']);

      const kind: BodyKind = cachedNotModified
        ? 'null-body'
        : decideKind(contentType, respHeaders['content-disposition'], sameSite);
      if (kind === 'drop') return bump('content_type');

      if (kind === 'null-body') {
        buildAndBuffer(r, rawUrl, method, status, contentType, null, NULL_BODY_COST);
        return;
      }

      // Oversize pre-check (content-length is absent on chunked responses —
      // the post-read check below still applies).
      const declaredLength = Number(respHeaders['content-length'] ?? NaN);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        bump('oversize_declared');
        buildAndBuffer(r, rawUrl, method, status, contentType, null, NULL_BODY_COST);
        return;
      }

      // Read the body in the handler (Playwright evicts bodies on
      // navigation), behind a semaphore: text() ships the whole body over
      // the driver pipe, so unbounded concurrent reads would both spike RSS
      // and contend with the vision agent's own driver commands.
      if (!(await acquireRead())) {
        bump('read_backpressure');
        buildAndBuffer(r, rawUrl, method, status, contentType, null, NULL_BODY_COST);
        return;
      }
      const text = await readBodyHoldingSlot(r);
      if (detached) return;
      if (text === BODY_TIMEOUT) return bump('body_timeout');
      if (text === null) return bump('body_unavailable');

      const byteCost = Buffer.byteLength(text, 'utf8');
      if (byteCost > MAX_BODY_BYTES) {
        bump('oversize_read');
        buildAndBuffer(r, rawUrl, method, status, contentType, null, NULL_BODY_COST);
        return;
      }

      let responseBody: unknown;
      if (kind === 'json' || kind === 'json-sniff') {
        const guarded = stripJsonGuards(text);
        if (kind === 'json-sniff' && !guarded.startsWith('{') && !guarded.startsWith('[')) {
          return bump('sniff_not_json');
        }
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(guarded);
        } catch {
          if (kind === 'json-sniff') return bump('sniff_not_json');
          // Declared JSON that doesn't parse: keep the endpoint, never the
          // raw text.
          buildAndBuffer(r, rawUrl, method, status, contentType, null, NULL_BODY_COST);
          return;
        }
        if (isAckShaped(parsedBody)) return bump('ack_shape');
        responseBody = redactResponseBody(parsedBody);
      } else {
        // csv | csv-sniff
        if (!text.includes('\n')) return bump('ack_csv');
        if (kind === 'csv-sniff') {
          if (text.includes('\0')) return bump('sniff_binary');
          const firstLine = text.slice(0, text.indexOf('\n'));
          if (!/[,;\t|]/.test(firstLine)) return bump('sniff_not_csv');
        }
        responseBody = redactCsvText(text);
      }

      buildAndBuffer(r, rawUrl, method, status, contentType, responseBody, byteCost);
    } catch {
      // Never throw out of the handler: a rejecting listener becomes an
      // unhandledRejection → log.error → Sentry, and Playwright error
      // messages embed full request URLs. Count it, nothing else.
      bump('handler_error');
    }
  }

  const onResponse = (r: Response): void => {
    // Second fence: handleResponse never rejects by construction, but a
    // rejection here must still be impossible to surface.
    void handleResponse(r).catch(() => bump('handler_error'));
  };
  const onClose = (): void => detach();

  const context: BrowserContext = page.context();
  context.on('response', onResponse);
  watchPopups(page);
  page.once('close', onClose);

  function detach(): void {
    if (detached) return;
    detached = true;
    try {
      context.off('response', onResponse);
    } catch {
      // context may already be closed
    }
    for (const { target, handler } of popupListeners) {
      try {
        target.off('popup', handler);
      } catch {
        // page may already be closed
      }
    }
    popupListeners.length = 0;
    try {
      page.off('close', onClose);
    } catch {
      // page may already be closed
    }
    // Counters only — never response-derived strings.
    log.info('network capture detached', { captured: entries.size, dropped: { ...dropped } });
  }

  function recent(): CapturedCall[] {
    const out: CapturedCall[] = [];
    for (const e of entries.values()) out.push({ ...e.call });
    return out.reverse();
  }

  return { recent, detach };
}
