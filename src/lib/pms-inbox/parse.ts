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
// 6 digits, optionally split as 3+3 ("123 456"); or a plain 4–8 digit run.
const DIGITS = '(\\d{3}[\\s-]?\\d{3}|\\d{4,8})';

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
