/**
 * Pure helpers for the PMS auth-code inbox webhook (/api/pms-inbox/inbound).
 *
 * Kept dependency-free (only node:crypto) and free of env/server-only imports
 * so they can be unit-tested directly under the repo test runner. The webhook
 * route reads the allowlist / secrets / inbox-domain from env and passes them
 * in — these functions make no I/O and no policy decisions of their own beyond
 * what they're handed.
 *
 * Security posture (see src/app/api/pms-inbox/inbound/route.ts and 0274):
 *   - Authenticity rests on DMARC/DKIM alignment to an allowlisted sender
 *     domain, parsed from Cloudflare's verified verdict — never the spoofable
 *     From string alone, never a bare "dkim=pass" substring.
 *   - Code extraction is anchored to Okta-style phrasing, prefers text/plain,
 *     NFKC-normalizes, only matches ASCII digits (homoglyph digits fall
 *     through to null rather than yielding a wrong code), and refuses to guess
 *     when the message is ambiguous (0 or >1 distinct candidates → null).
 *   - Recipient is normalized (lowercased, plus-addressing stripped) and the
 *     domain is asserted, so mail to other domains can't resolve.
 */

import { timingSafeEqual } from 'node:crypto';

// ─── Bearer auth (shared secret, constant-time, rotation-aware) ────────────

/**
 * Constant-time match of an `Authorization: Bearer <secret>` header against a
 * set of accepted secrets (current + next, for zero-downtime rotation). Mirror
 * of requireCronSecret's compare in api-auth.ts. Iterates the whole set (no
 * early return) to keep timing uniform regardless of which secret matched.
 */
export function constantTimeBearerMatch(
  authHeader: string | null | undefined,
  secrets: Array<string | undefined | null>,
): boolean {
  const authBuf = Buffer.from(authHeader ?? '');
  let matched = false;
  for (const s of secrets) {
    if (!s) continue;
    const expected = Buffer.from(`Bearer ${s}`);
    if (authBuf.length === expected.length) {
      try {
        if (timingSafeEqual(authBuf, expected)) matched = true;
      } catch {
        /* length guarded above; defensive catch */
      }
    }
  }
  return matched;
}

// ─── Sender authenticity ───────────────────────────────────────────────────

export interface InboundVerdict {
  /** Header From (display name or bare address). Cosmetic — never trusted alone. */
  from?: string | null;
  /** Cloudflare's verified verdicts (lowercased: 'pass' | 'fail' | 'none' | ...). */
  dkim?: string | null;
  spf?: string | null;
  dmarc?: string | null;
  /** The verified DKIM signing domain (header.d). Load-bearing for the DKIM path. */
  dkimDomain?: string | null;
}

export type AuthenticityResult =
  | { ok: true; fromDomain: string }
  | { ok: false; reason: 'unparseable_from' | 'sender_not_allowlisted' | 'unauthenticated' };

/** Parse the registrable domain out of a From value ("Name <a@b.com>" or "a@b.com"). */
export function parseEmailDomain(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const angle = /<([^>]+)>/.exec(addr);
  const email = (angle ? angle[1] : addr).trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .replace(/[>\s]+$/, '')
    .trim();
  return domain || null;
}

/** A domain is allowed if it equals an allowlist entry or is a subdomain of one. */
export function domainAllowed(domain: string, allowlist: string[]): boolean {
  const d = domain.toLowerCase();
  return allowlist.some((entry) => {
    const a = entry.toLowerCase().replace(/^\./, '').trim();
    return !!a && (d === a || d.endsWith('.' + a));
  });
}

/**
 * Decide whether an inbound message is genuinely from an allowlisted sender.
 *
 * Pass if DMARC passed (which by definition requires an aligned, passing
 * DKIM or SPF for the From domain) OR a DKIM signature passed whose verified
 * signing domain is itself allowlisted. A `dkim=pass` for a non-allowlisted
 * domain (e.g. an attacker's own DKIM-signed mail forging From: x@okta.com)
 * is rejected — the From string is never sufficient on its own.
 */
export function verifyInboundAuthenticity(
  v: InboundVerdict,
  allowlist: string[],
): AuthenticityResult {
  const fromDomain = parseEmailDomain(v.from);
  if (!fromDomain) return { ok: false, reason: 'unparseable_from' };
  if (!domainAllowed(fromDomain, allowlist)) return { ok: false, reason: 'sender_not_allowlisted' };

  const dmarc = (v.dmarc ?? '').toLowerCase().trim();
  const dkim = (v.dkim ?? '').toLowerCase().trim();
  const dkimDomain = (v.dkimDomain ?? '').toLowerCase().trim();

  // DMARC pass ⇒ From domain is authenticated and aligned. Strongest signal.
  if (dmarc === 'pass') return { ok: true, fromDomain };

  // DKIM-only path: the VERIFIED signing domain must itself be allowlisted.
  if (dkim === 'pass' && dkimDomain && domainAllowed(dkimDomain, allowlist)) {
    return { ok: true, fromDomain };
  }

  return { ok: false, reason: 'unauthenticated' };
}

// ─── Recipient normalization ───────────────────────────────────────────────

/**
 * Normalize an inbound recipient to `<local>@<inboxDomain>`:
 *   - extract the address from a "Name <addr>" form
 *   - lowercase + trim
 *   - strip plus-addressing (`txa32+anything@…` → `txa32@…`)
 *   - assert the domain is exactly inboxDomain (reject mail to anything else)
 * Returns null if malformed or the domain doesn't match.
 */
export function normalizeRecipient(
  addr: string | null | undefined,
  inboxDomain: string,
): string | null {
  if (!addr) return null;
  const angle = /<([^>]+)>/.exec(addr);
  const email = (angle ? angle[1] : addr).trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  let local = email.slice(0, at).replace(/^"+|"+$/g, '');
  const domain = email.slice(at + 1).replace(/[>\s]+$/, '');
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (!local) return null;
  if (domain !== inboxDomain.toLowerCase()) return null;
  return `${local}@${domain}`;
}

// ─── OTP code extraction ───────────────────────────────────────────────────

// Zero-width / BOM chars that could be used to split a code past a naive match.
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** NFKC (folds fullwidth digits to ASCII) + drop zero-width chars. */
function norm(s: string): string {
  return (s ?? '').normalize('NFKC').replace(ZERO_WIDTH, '');
}

function stripHtml(html: string): string {
  return norm(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "123 456" / "123-456" → "123456". */
function cleanCandidate(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

// Okta-style phrasing. Liberal on wording, strict on the digits.
const KEYWORD =
  '(?:verification code|one[- ]?time (?:passcode|password|code|pin)|security code|access code|sign[- ]?in code|login code|passcode|your code(?: is)?|code is|otp|one[- ]?time pin)';
// A full 4–8 digit run, OR a separated 3+3 ("123 456"). Digit boundaries on
// BOTH sides so a 7/8-digit code is never truncated to its first 6, and a
// longer/phone-style number isn't partially captured. The plain run is tried
// first so "1234567" matches whole; the 3+3 form requires a real separator.
const DIGITS = '(?<!\\d)(\\d{4,8}|\\d{3}[\\s-]\\d{3})(?!\\d)';

function collectAnchored(text: string): Set<string> {
  const out = new Set<string>();
  const patterns = [
    // keyword … 123456   ("your verification code is 123456", "OTP: 123 456")
    new RegExp(`${KEYWORD}\\b[^0-9\\n]{0,24}${DIGITS}`, 'gi'),
    // 123456 is your … code   ("123456 is your verification code")
    new RegExp(`${DIGITS}\\s+is\\s+your\\b[^\\n]{0,40}?\\bcode\\b`, 'gi'),
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const c = cleanCandidate(m[1]);
      if (/^\d{4,8}$/.test(c)) out.add(c);
    }
  }
  return out;
}

export interface OtpExtractionInput {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}

/**
 * Extract the one-time code from an authenticated message, or null.
 *
 * 1. Anchored search (subject + text + stripped html). Exactly one distinct
 *    candidate → use it. More than one distinct → refuse (ambiguous).
 * 2. Fallback: a single standalone 6-digit run in subject or text (not html —
 *    too noisy). Boundaries exclude digits embedded in longer numbers, dates,
 *    or phone numbers.
 *
 * Refusing on ambiguity (rather than guessing) is deliberate: a wrong code
 * submitted to Okta burns a login attempt and risks account lockout.
 */
export function extractOtpCode(input: OtpExtractionInput): string | null {
  const subject = norm(input.subject ?? '');
  const text = norm(input.text ?? '');
  const htmlText = stripHtml(input.html ?? '');

  const anchored = new Set<string>();
  for (const src of [subject, text, htmlText]) {
    for (const c of collectAnchored(src)) anchored.add(c);
  }
  if (anchored.size === 1) return [...anchored][0];
  if (anchored.size > 1) return null;

  const six = new Set<string>();
  for (const src of [subject, text]) {
    for (const m of src.matchAll(/(?<![\d.,/\-])\d{6}(?![\d.,/\-])/g)) six.add(m[0]);
  }
  if (six.size === 1) return [...six][0];

  return null;
}

/** Mask a code for display/audit: reveal only the last 2 digits. */
export function maskCode(code: string): string {
  const c = code ?? '';
  if (c.length <= 2) return '••';
  return '•'.repeat(Math.max(2, c.length - 2)) + c.slice(-2);
}

// ─── Link extraction (for the admin full-message viewer) ───────────────────
// SECURITY: the admin viewer renders these as clickable <a href>. The XSS gate
// is `new URL(href).protocol` ∈ {http,https} — javascript:/data:/vbscript:/
// file:/mailto:/tel: and relative URLs (which throw on parse) are all dropped.
// The email's raw HTML is NEVER rendered; only these validated links + the
// React-escaped plain text reach the browser.

export interface ExtractedLink {
  href: string;
  label: string;
}

const MAX_LINKS = 50;
const MAX_HREF_LEN = 2048;
const MAX_LABEL_LEN = 200;
// Bound the markup we scan so a pathological body can't cost unbounded regex time.
// 32 KiB comfortably covers a real Okta email (the Worker caps forwarded html at
// ~20 KiB); combined with the bounded anchor-regex quantifiers below this keeps
// extractLinks linear in input size (no ReDoS on a hostile body).
const MAX_SCAN_LEN = 32_768;
// Control chars (incl. CR/LF) are stripped from an href before validation so a
// split/obfuscated URL can't reach the viewer. Built via RegExp() to keep this
// source file ASCII (no literal control bytes).
const STRIP_CONTROL = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

/** Decode the handful of HTML entities that appear in real href/label text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*2f;/gi, '/');
}

/**
 * True ONLY for absolute http(s) URLs. Everything else — javascript:, data:,
 * vbscript:, file:, mailto:, tel:, protocol-relative, relative, malformed —
 * is rejected. This is the XSS boundary for the admin viewer's links.
 */
function isSafeHttpUrl(href: string): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

/**
 * Extract clickable http(s) links from an email's html (preferred — with anchor
 * text as the label) and plain text (bare URLs). Validates the scheme, dedups by
 * lowercased href, and caps count/length. Returns [] when there's nothing safe.
 */
export function extractLinks(html?: string | null, text?: string | null): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();

  const push = (rawHref: string, rawLabel: string): void => {
    if (out.length >= MAX_LINKS) return;
    const href = decodeEntities(norm(rawHref).trim())
      .replace(STRIP_CONTROL, '')
      .slice(0, MAX_HREF_LEN);
    if (!isSafeHttpUrl(href)) return;
    const key = href.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const label =
      (decodeEntities(norm(rawLabel)).replace(/\s+/g, ' ').trim() || href).slice(0, MAX_LABEL_LEN);
    out.push({ href, label });
  };

  // 1. Anchors in html — href + inner text (nested tags stripped) as label.
  // Quantifiers are BOUNDED (no open-ended `[^>]*?`) so a hostile `<a `-spam body
  // can't drive O(n^2) backtracking — extractLinks stays linear. 2 KiB of attrs /
  // href and an 8 KiB label window are far beyond any real anchor.
  const h = norm((html ?? '').slice(0, MAX_SCAN_LEN));
  const anchorRe =
    /<a\b[^>]{0,2048}?\bhref\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})'|([^\s">]{0,2048}))[^>]{0,2048}>([\s\S]{0,8192}?)<\/a>/gi;
  for (const m of h.matchAll(anchorRe)) {
    const href = m[1] ?? m[2] ?? m[3] ?? '';
    const label = (m[4] ?? '').replace(/<[^>]+>/g, ' ');
    push(href, label);
  }

  // 2. Bare URLs in plain text (no label → falls back to the href).
  const t = norm((text ?? '').slice(0, MAX_SCAN_LEN));
  for (const m of t.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi)) {
    // Trim trailing sentence punctuation that isn't part of the URL.
    push(m[0].replace(/[.,;:!?)\]]+$/, ''), '');
  }

  return out;
}

// ─── Authentication-Results selection + parsing ────────────────────────────
// SECURITY-CRITICAL. The Email Worker uses the same logic (kept in sync in
// email-worker/src/index.ts). An inbound message can carry sender-forged
// `Authentication-Results` headers; only the one added by our trusted receiver
// (Cloudflare, by authserv-id) may be believed. The attacker can inject a
// header spoofing that authserv-id, but cannot remove the receiver's real one,
// so MORE THAN ONE match = tampering and is treated as unauthenticated.

/** The authserv-id is the token before the first ';' in an Authentication-Results value. */
export function authservIdOf(headerValue: string): string {
  return (headerValue.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * From all Authentication-Results header VALUES on a message, return the single
 * one whose authserv-id belongs to a trusted receiver, or null if zero or more
 * than one match (the latter means an injected look-alike — refuse to trust).
 */
export function selectTrustedAuthResults(
  headerValues: string[],
  trustedAuthservIds: string[],
): string | null {
  const trusted = trustedAuthservIds.map((s) => s.toLowerCase().replace(/^\./, '').trim()).filter(Boolean);
  const matches = headerValues.filter((v) => {
    const id = authservIdOf(v);
    return trusted.some((t) => id === t || id.endsWith('.' + t));
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Parse a single Authentication-Results value into discrete verdicts. */
export function parseAuthResults(headerValue: string | null | undefined): InboundVerdict {
  const lower = (headerValue ?? '').toLowerCase();
  const get = (re: RegExp): string | null => re.exec(lower)?.[1] ?? null;
  const dkim = get(/\bdkim=(\w+)/);
  const spf = get(/\bspf=(\w+)/);
  const dmarc = get(/\bdmarc=(\w+)/);
  // Prefer the header.d from the dkim=pass segment; fall back to any header.d.
  let dkimDomain: string | null = null;
  for (const seg of lower.split(';')) {
    if (seg.includes('dkim=pass')) {
      const m = /header\.d=([a-z0-9.\-]+)/.exec(seg);
      if (m) {
        dkimDomain = m[1];
        break;
      }
    }
  }
  if (!dkimDomain) dkimDomain = get(/header\.d=([a-z0-9.\-]+)/);
  return { dkim, spf, dmarc, dkimDomain };
}
