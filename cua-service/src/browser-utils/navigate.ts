// ─── safeGoto — the only sanctioned page.goto wrapper in cua-service ──────
//
// Codex adversarial review 2026-05-16 (P1, Pattern B): `page.goto()` was
// called from at least 5 sites in cua-service. ONE of them (browser-tool's
// `navigate` action) had a same-site host guard; the other four (recipe
// replay, recipe login, mapper login, mapper post-login redirect) trusted
// whatever URL came in. A poisoned recipe step `{ kind: 'goto', url: 'https://attacker.example' }`
// would happily get navigated to from a worker holding the hotel's
// authenticated PMS cookies. SSRF + cross-domain session exfil.
//
// Root-cause fix (Pattern B — dangerous operations have ONE entry point,
// not many): every navigation in cua-service goes through this helper.
// The CI grep test (tests/no-raw-page-goto.test.ts) fails the build if
// `page.goto(` reappears anywhere outside this file.
//
// The helper rejects:
//   - non-http(s) schemes (javascript:, file:, about:, data:, etc.)
//   - private + link-local + loopback IPs (SSRF blocker)
//   - hosts outside the recipe's `allowedHost` (when one is provided)
// And forwards { waitUntil, timeout } to Playwright with our defaults.

import type { Page } from 'playwright';
import * as dns from 'node:dns';
import { promisify } from 'node:util';
import { env } from '../env.js';

const dnsLookup = promisify(dns.lookup);

/** Marker thrown by dnsLookupWithTimeout when the lookup races past its
 *  budget. Plain Error with a sentinel name so safeGoto's catch can
 *  distinguish "DNS hung" from "DNS resolved to junk" and log the right
 *  event name without coupling to the message string. */
class DnsPreflightTimeoutError extends Error {
  constructor(hostname: string, budgetMs: number) {
    super(`DNS preflight for "${hostname}" exceeded ${budgetMs}ms`);
    this.name = 'DnsPreflightTimeoutError';
  }
}

export function isDnsTimeout(err: unknown): boolean {
  return err instanceof DnsPreflightTimeoutError;
}

/** Wrap dns.lookup in a Promise.race against a setTimeout. Without this,
 *  a flaky resolver can hang the worker for the full default DNS retry
 *  window (often 30+ seconds, OS-dependent) before any other code runs.
 *  Playwright's own 30s navigation timeout is downstream of this await
 *  and only starts once safeGoto resumes. */
async function dnsLookupWithTimeout(
  hostname: string,
  budgetMs: number,
  rawUrl: string,
): Promise<{ address: string; family: number }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DnsPreflightTimeoutError(hostname, budgetMs)), budgetMs);
    // unref so the timer doesn't keep the process alive on shutdown.
    timer.unref?.();
  });
  try {
    return await Promise.race([dnsLookup(hostname, { all: false }), timeout]);
  } catch (err) {
    // Annotate non-timeout errors with the URL for logs without leaking
    // the credentials any URL might (URLs are query-string-redacted by
    // sentry beforeSend, and we only log first 120 chars in safeGoto's
    // catch). No-op for the timeout marker (message is fine as-is).
    if (!(err instanceof DnsPreflightTimeoutError)) {
      (err as Error).message = `dns.lookup("${hostname}") for ${rawUrl.slice(0, 80)}: ${(err as Error).message}`;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Multi-part public suffixes — if the registrable domain check has to
 *  trim back further than 2 labels to avoid lumping different sites in
 *  the same ccTLD bucket. Ported from browser-tool.ts (single source of
 *  truth now). Add new suffixes here as we onboard hotels in new regions. */
const MULTI_PART_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'com.au', 'org.au', 'net.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.za', 'org.za', 'gov.za',
  'com.br', 'net.br', 'org.br',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'co.kr', 'or.kr', 'ne.kr',
  'com.mx', 'org.mx',
  'co.in', 'net.in',
  'com.sg', 'edu.sg',
  'com.hk', 'org.hk',
]);

export type NavigationRefusalReason =
  | 'malformed'
  | 'scheme'
  | 'private_or_local_ip'
  | 'off_site';

export class UnsafeNavigationError extends Error {
  constructor(
    message: string,
    public readonly reason: NavigationRefusalReason,
    public readonly target: string,
  ) {
    super(message);
    this.name = 'UnsafeNavigationError';
  }
}

export interface SafeGotoOptions {
  /** The allowed host this navigation must match (same-site, not exact-equal —
   *  registrable-domain check). Pass `null` ONLY for the very first
   *  navigation that establishes the PMS session (login startUrl); every
   *  subsequent goto in the same session should pass the recipe's host. */
  allowedHost: string | null;
  /** Caller name for log + error attribution. */
  context: string;
  /** Playwright passthrough. */
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';
  timeoutMs?: number;
  /** Test-only: allow navigation to loopback (127.0.0.1/localhost/::1) for
   *  the Phase-3 mock-PMS harness. NEVER set in production code — set only
   *  by write-runner tests. ALL other private/link-local/metadata IPs stay
   *  blocked even when this is true. Caller-supplied, never recipe-supplied. */
  allowLoopback?: boolean;
}

/** Normalize a user-typed URL by prepending https:// when scheme is missing.
 *  We DO NOT auto-add a scheme to anything that already looks scheme-ish
 *  (so `javascript:alert(1)` doesn't become `https://javascript:alert(1)`). */
export function normalizeUrl(u: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // any other scheme — let validation reject it
  return `https://${u}`;
}

/** Same-site check via registrable-domain comparison. Ported from
 *  browser-tool.ts so navigate.ts becomes the single source of truth. */
export function hostsAreSameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}

function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/** Unwrap an IPv4-mapped IPv6 literal (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) to
 *  its dotted IPv4 string, so isPrivateOrLocalHost's IPv4 rules catch a mapped
 *  loopback / RFC1918 address. Returns null if `h` isn't such a literal. */
function unwrapMappedIpv4(h: string): string | null {
  if (!h.startsWith('::ffff:')) return null;
  const suffix = h.slice(7);
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(suffix)) return suffix;
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(suffix);
  if (m) {
    const a = parseInt(m[1], 16);
    const b = parseInt(m[2], 16);
    return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
  }
  return null;
}

/** RFC1918 + loopback + link-local + cloud metadata + 0.0.0.0 + IPv6
 *  loopback + IPv6 link-local. Hostname-string check; if it doesn't
 *  match an IP literal we let it through (DNS would need a separate
 *  resolver-side check to truly block DNS-rebinding — out of scope for
 *  v0; the registrable-domain allowlist is the primary defense). */
export function isPrivateOrLocalHost(rawHostname: string): boolean {
  // URL parsing strips outer brackets from IPv6 but the raw hostname
  // can still arrive with them in some code paths — normalize. Also strip a
  // trailing dot (FQDN root) so "localhost." / "127.0.0.1." can't slip past
  // (Codex P0).
  let h = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 / ::ffff:7f00:1) — unwrap to the
  // embedded IPv4 so the dotted-quad rules below catch a mapped loopback
  // or RFC1918 address (Codex P0).
  const mapped = unwrapMappedIpv4(h);
  if (mapped) h = mapped;
  // IPv4 dotted-quad
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const o = ipv4.slice(1).map(Number);
    if (o.some(n => n < 0 || n > 255)) return false; // malformed; not our problem
    if (o[0] === 0) return true;                       // 0.0.0.0/8
    if (o[0] === 10) return true;                      // 10.0.0.0/8
    if (o[0] === 127) return true;                     // loopback
    if (o[0] === 169 && o[1] === 254) return true;     // link-local + cloud metadata (169.254.169.254)
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true;     // 192.168.0.0/16
    return false;
  }
  // IPv6 prefixes we care about. Conservative — only the obvious cases.
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local + unique-local
  if (h === '::') return true;
  return false;
}

/** Validate without navigating. Exposed for tests + for any caller that
 *  needs to pre-flight a URL without running Playwright. */
export function validateNavigationUrl(
  rawUrl: string,
  allowedHost: string | null,
  opts?: { allowLoopback?: boolean },
): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeNavigationError(
      `Malformed URL: ${rawUrl.slice(0, 120)}`,
      'malformed',
      rawUrl,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeNavigationError(
      `Refused scheme "${url.protocol}" (only http(s) allowed): ${rawUrl.slice(0, 120)}`,
      'scheme',
      rawUrl,
    );
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    // Phase 3: the write-runner mock-PMS harness runs on 127.0.0.1. A
    // narrow, caller-supplied (NEVER recipe-supplied) opt-in allows ONLY
    // loopback, ONLY when test code explicitly requests it. Every other
    // private/link-local/metadata IP stays blocked. Prod handlers never
    // pass allowLoopback, so the SSRF guard is unchanged in production.
    const isLoopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]';
    if (!(opts?.allowLoopback && isLoopback)) {
      throw new UnsafeNavigationError(
        `Refused private/local host "${url.hostname}": ${rawUrl.slice(0, 120)}`,
        'private_or_local_ip',
        rawUrl,
      );
    }
  }
  // Reject empty hostname OR single-label hostnames (no dot). The URL
  // spec collapses `http:///path` to `http://path/` with hostname "path",
  // and `http://foo/` with hostname "foo" — both single-label. Real PMS
  // hosts are always FQDNs with at least one dot. Refusing single-label
  // hosts catches typo'd URLs AND any /etc/hosts-redirect SSRF that
  // tries to hide behind a one-word name. (Runs AFTER the private/local
  // check so `localhost` still reports as private_or_local_ip — that's
  // the more specific diagnostic.)
  if (!url.hostname || (!url.hostname.includes('.') && !url.hostname.includes(':'))) {
    throw new UnsafeNavigationError(
      `URL has no hostname or single-label host: ${rawUrl.slice(0, 120)}`,
      'malformed',
      rawUrl,
    );
  }
  if (allowedHost && !hostsAreSameSite(url.hostname, allowedHost)) {
    throw new UnsafeNavigationError(
      `Off-site navigation refused (target=${url.hostname}, allowed=${allowedHost}): ${rawUrl.slice(0, 120)}`,
      'off_site',
      rawUrl,
    );
  }
}

/** The ONE entry point for `page.goto` in cua-service. Validates the URL
 *  against scheme/private-IP/allowed-host rules and then performs the
 *  navigation with our standard Playwright options.
 *
 *  If validation fails, `UnsafeNavigationError` is thrown BEFORE any
 *  network request — so a poisoned recipe step can never reach the
 *  network in an authenticated browser context. */
export async function safeGoto(
  page: Page,
  url: string,
  opts: SafeGotoOptions,
): Promise<void> {
  validateNavigationUrl(url, opts.allowedHost, { allowLoopback: opts.allowLoopback });

  // Plan v2 F-AI-5 — DNS preflight. Resolve the hostname via Node DNS
  // and refuse if the resolved IP is private. This closes the trivial
  // DNS-rebinding case where a same-site domain `internal.pms.com`
  // resolves to 127.0.0.1: the validateNavigationUrl hostname-string
  // check passes (it's a public-looking FQDN), but the resolved IP is
  // private. We still can't catch MID-RESOLUTION rebinding — Chromium
  // does its own resolve on the actual fetch — so the residual gap
  // exists, documented in F-AI-5.
  //
  // Gated by env CUA_DNS_PREFLIGHT so we can roll out slowly. Default
  // is off; flip to 'true' once latency impact has been measured.
  if (env.CUA_DNS_PREFLIGHT === 'true') {
    try {
      const parsed = new URL(url);
      const lookup = await dnsLookupWithTimeout(parsed.hostname, env.CUA_DNS_PREFLIGHT_TIMEOUT_MS, url);
      if (isPrivateOrLocalHost(lookup.address)) {
        throw new UnsafeNavigationError(
          `Refused: ${parsed.hostname} resolves to private IP ${lookup.address}: ${url.slice(0, 120)}`,
          'private_or_local_ip',
          url,
        );
      }
    } catch (err) {
      if (err instanceof UnsafeNavigationError) throw err;
      // dns.lookup can throw ENOTFOUND / ECONNREFUSED OR the wrapper
      // can throw a timeout marker — we don't want DNS noise to brick
      // a legitimate navigation. Log via stderr and proceed;
      // safeGoto's existing string-check + Playwright's own resolve
      // still apply.
      const evt = isDnsTimeout(err) ? 'cua_dns_preflight_timeout' : 'cua_dns_preflight_lookup_failed';
      process.stderr.write(JSON.stringify({
        level: 'warn',
        evt,
        url: url.slice(0, 120),
        error: (err as Error).message,
      }) + '\n');
    }
  }

  await page.goto(url, {
    waitUntil: opts.waitUntil ?? 'domcontentloaded',
    timeout: opts.timeoutMs ?? 30_000,
  });
}

/**
 * feature/cua-feed-replay — detect whether the current page has bounced to a
 * re-auth / login screen (session expired, an interstitial, a re-auth popup).
 * PMS-agnostic: a visible login form (a password field, or a
 * j_username/username field) is the reliable signal — feed/report pages don't
 * show one. The DOM extractors call this right after navigating so a bounce
 * fails the feed loudly with `bounced_to_reauth` (→ the poll re-logs-in) instead
 * of scraping login chrome as data, and — critically — so a reconcile feed never
 * auto-resolves live rows from a 0-row read that was really a bounce.
 */
export async function detectReauthBounce(page: Page): Promise<boolean> {
  // A VISIBLE password field is the strong, PMS-agnostic re-auth signal — feed
  // and report pages don't show one. `j_username` is Choice Advantage's login
  // field. We count ANY visible match (not `.first().isVisible()`, which a
  // hidden duplicate input could mask → false negative), and deliberately do
  // NOT key on a bare `username` field: a filter/profile/search page can have
  // one, which would false-positive a healthy feed as `bounced_to_reauth`.
  try {
    const visibleLoginFields = await page
      .locator('input[type="password"]:visible, input[name="j_username"]:visible')
      .count();
    return visibleLoginFields > 0;
  } catch {
    return false;
  }
}
