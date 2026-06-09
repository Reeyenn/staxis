// @audit: tenant-scope-not-applicable — Cloudflare Email Worker → shared-secret
// webhook (Bearer PMS_INBOX_WEBHOOK_SECRET, constant-time). Not a user/session
// route; it resolves the property itself from the verified recipient address.
/**
 * POST /api/pms-inbox/inbound — PMS Okta inbox reader (migrations 0274 + 0275).
 *
 * Cloudflare Email Routing (catch-all on the getstaxis.com apex) hands each
 * inbound message to an Email Worker, which parses it and POSTs the relevant
 * fields here with `Authorization: Bearer <PMS_INBOX_WEBHOOK_SECRET>`. We:
 *   - store the FULL message (subject/from/body/links) in pms_inbox_messages so
 *     an admin can click the Okta account-setup link in /admin/pms-inbox, and
 *   - extract any 6-digit code into pms_auth_codes for the CUA robot's login.
 *
 * Security (this is the boundary of record — the Worker is just a courier):
 *   1. Constant-time shared-secret check; fail-closed (503) if unset.
 *   2. Timestamp tolerance — drop stale forwards (replay defense-in-depth).
 *   3. Sender authenticity — DMARC/DKIM aligned to an allowlisted domain
 *      (okta.com), from Cloudflare's verified verdict. Never the spoofable
 *      From string, never a bare "dkim=pass" substring.
 *   4. Resolve the recipient → property via scraper_credentials.pms_login_email.
 *   5. Per-property rate-limit on the RAW property id.
 *   6. Store the full message (NON-FATAL — a hiccup here never blocks the code).
 *   7. Extract the code (anchored, ambiguity-refusing) and store it. A UNIQUE
 *      message-id dedups replayed/duplicate deliveries on both tables.
 *
 * NOTHING is stored until steps 1–4 pass (authenticated sender + known
 * recipient), so junk/forged mail to the apex catch-all is dropped, never
 * persisted. Every accepted-but-dropped path returns a uniform 2xx (no
 * enumeration / no SMTP backscatter). 401 is reserved for a bad secret, 5xx for
 * genuine server errors (which legitimately invite a Worker retry). Codes and
 * message bodies are never logged.
 */

import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok } from '@/lib/api-response';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import {
  constantTimeBearerMatch,
  verifyInboundAuthenticity,
  normalizeRecipient,
  extractOtpCode,
} from '@/lib/pms-inbox/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

// The single domain we receive PMS Okta mail on (apex). Recipients on any other
// domain are rejected. Defaults to getstaxis.com; override only via env for tests.
const DEFAULT_INBOX_DOMAIN = 'getstaxis.com';
// Production sender allowlist. Okta sends the OTP / setup mail from okta.com / the
// tenant subdomain (e.g. choicehotels.okta.com — matched by the subdomain rule),
// which publishes DMARC p=reject. We deliberately do NOT include choicehotels.com
// (the corporate domain): it isn't the sender and its DMARC is p=none, so
// Cloudflare would deliver spoofed mail From: it — an injection vector. Override
// via env only to add a *verified* Okta sub-processor domain, or a controlled
// test sender during verification.
const DEFAULT_ALLOWED_SENDERS = ['okta.com'];
// Drop forwards whose Worker timestamp is more than this far from now.
const TIMESTAMP_TOLERANCE_MS = 10 * 60 * 1000;
// Secondary guard; the Worker is the primary size gate.
const MAX_BODY_BYTES = 512 * 1024;
// Per-column caps for the stored full message (defense-in-depth; the Worker
// already caps html ~20 KB and the body is bounded at MAX_BODY_BYTES above).
const MAX_STORED_TEXT = 100_000;
const MAX_STORED_HTML = 100_000;

function allowedSenderDomains(): string[] {
  const raw = (env.PMS_INBOX_ALLOWED_SENDER_DOMAINS ?? '').trim();
  if (!raw) return DEFAULT_ALLOWED_SENDERS;
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_SENDERS;
}

/** The apex domain we accept inbox mail on (env override for tests; defaults apex). */
function inboxDomain(): string {
  return (env.PMS_INBOX_DOMAIN ?? '').trim().toLowerCase() || DEFAULT_INBOX_DOMAIN;
}

interface InboundBody {
  to?: unknown;
  from?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  messageId?: unknown;
  ts?: unknown;
  dkim?: unknown;
  spf?: unknown;
  dmarc?: unknown;
  dkimDomain?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  // ── 1. Shared-secret gate (fail-closed if unset) ──────────────────────────
  const secrets = [env.PMS_INBOX_WEBHOOK_SECRET, env.PMS_INBOX_WEBHOOK_SECRET_NEXT];
  if (!secrets.some(Boolean)) {
    log.error('[pms-inbox] PMS_INBOX_WEBHOOK_SECRET unset — refusing all inbound', { requestId });
    return new NextResponse('inbox not configured', { status: 503 });
  }
  if (!constantTimeBearerMatch(req.headers.get('authorization'), secrets)) {
    log.warn('[pms-inbox] bad or absent bearer secret', { requestId });
    return new NextResponse('unauthorized', { status: 401 });
  }

  // ── 2. Read + size-bound the body ─────────────────────────────────────────
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return new NextResponse('bad_request', { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    log.warn('[pms-inbox] oversized body dropped', { requestId, bytes: raw.length });
    return ok({ stored: false, reason: 'too_large' }, { requestId });
  }
  let body: InboundBody;
  try {
    body = JSON.parse(raw) as InboundBody;
  } catch {
    return new NextResponse('bad_request', { status: 400 });
  }

  // ── 3. Timestamp tolerance (replay defense-in-depth) ──────────────────────
  const ts = typeof body.ts === 'number' ? body.ts : NaN;
  if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) {
    log.warn('[pms-inbox] stale forward dropped', { requestId, skewMs: Math.round(Date.now() - ts) });
    return ok({ stored: false, reason: 'stale' }, { requestId });
  }

  // ── 4. Sender authenticity (DMARC/DKIM aligned to an allowlisted domain) ──
  const fromRaw = str(body.from);
  const auth = verifyInboundAuthenticity(
    {
      from: fromRaw,
      dkim: str(body.dkim),
      spf: str(body.spf),
      dmarc: str(body.dmarc),
      dkimDomain: str(body.dkimDomain),
    },
    allowedSenderDomains(),
  );
  if (!auth.ok) {
    log.warn('[pms-inbox] sender rejected', {
      requestId,
      reason: auth.reason,
      fromDomain: (fromRaw.split('@').pop() ?? '').slice(0, 60),
    });
    return ok({ stored: false, reason: auth.reason }, { requestId }); // uniform 2xx
  }

  // ── 5. Resolve recipient → property ───────────────────────────────────────
  const recipient = normalizeRecipient(str(body.to), inboxDomain());
  if (!recipient) {
    log.warn('[pms-inbox] unresolvable recipient', { requestId });
    return ok({ stored: false, reason: 'bad_recipient' }, { requestId });
  }
  // `recipient` is normalized lowercase by normalizeRecipient; pms_login_email is
  // stored lowercase (migration 0275) and indexed (scraper_credentials_pms_login_email_idx),
  // so this raw equality both matches case-insensitively-in-practice and is index-backed.
  const { data: cred, error: credErr } = await supabaseAdmin
    .from('scraper_credentials')
    .select('property_id')
    .eq('pms_login_email', recipient)
    .maybeSingle();
  if (credErr) {
    log.error('[pms-inbox] recipient lookup failed', { requestId, err: credErr.message });
    return new NextResponse('server_error', { status: 500 });
  }
  if (!cred) {
    log.warn('[pms-inbox] unknown recipient', { requestId });
    return ok({ stored: false, reason: 'unknown_recipient' }, { requestId });
  }
  const propertyId = cred.property_id as string;

  // ── 6. Per-property rate-limit (raw property id) ──────────────────────────
  const rl = await checkAndIncrementRateLimit('pms-inbox-inbound', propertyId);
  if (!rl.allowed) {
    log.warn('[pms-inbox] rate limited', {
      requestId,
      propertyId,
      current: rl.current,
      cap: rl.cap,
    });
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // The provider Message-Id dedups replayed/duplicate deliveries on BOTH tables.
  const messageId = str(body.messageId) || null;

  // ── 6.5 Store the FULL message (NON-FATAL: never block the 2FA code path) ──
  // Captures setup-LINK mail (which carries no code) so an admin can click the
  // Okta "set password" / MFA-enroll link in /admin/pms-inbox. Runs only after
  // the sender is authenticated (step 4) and the property resolved (step 5), so
  // nothing unauthenticated is ever persisted. A messages-table error is logged
  // and swallowed — the operationally-critical code path (steps 7–8) still runs.
  try {
    const { error: msgErr } = await supabaseAdmin.from('pms_inbox_messages').insert({
      property_id: propertyId,
      email_to: recipient,
      from_addr: fromRaw.slice(0, 320) || null,
      subject: str(body.subject).slice(0, 500) || null,
      body_text: str(body.text).slice(0, MAX_STORED_TEXT) || null,
      body_html: str(body.html).slice(0, MAX_STORED_HTML) || null,
      message_id: messageId,
    });
    if (msgErr) {
      if ((msgErr as { code?: string }).code === '23505') {
        log.info('[pms-inbox] duplicate full-message ignored', { requestId, propertyId });
      } else {
        // NON-FATAL — log and fall through to the code path.
        log.error('[pms-inbox] full-message store failed (continuing)', {
          requestId,
          propertyId,
          err: msgErr.message,
        });
      }
    } else {
      // Sizes only — NEVER body/subject content (log.ts does not scrub).
      log.info('[pms-inbox] stored full message', {
        requestId,
        propertyId,
        textLen: str(body.text).length,
        htmlLen: str(body.html).length,
        messageId: messageId ? messageId.slice(0, 80) : null,
      });
    }
  } catch (e) {
    log.error('[pms-inbox] full-message store threw (continuing)', {
      requestId,
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 7. Extract the code (authenticated content only) ──────────────────────
  const code = extractOtpCode({
    subject: str(body.subject),
    text: str(body.text),
    html: str(body.html),
  });
  if (!code) {
    log.warn('[pms-inbox] no code extracted', { requestId, propertyId });
    return ok({ stored: false, reason: 'no_code' }, { requestId });
  }

  // ── 8. Store the code (UNIQUE raw_ref dedups a replayed/duplicate delivery) ─
  const { error: insErr } = await supabaseAdmin.from('pms_auth_codes').insert({
    property_id: propertyId,
    email_to: recipient,
    source: 'email',
    code,
    sender: fromRaw.slice(0, 320) || null,
    subject: str(body.subject).slice(0, 500) || null,
    raw_ref: messageId,
  });
  if (insErr) {
    if ((insErr as { code?: string }).code === '23505') {
      log.info('[pms-inbox] duplicate message ignored', { requestId, propertyId });
      return ok({ stored: false, reason: 'duplicate' }, { requestId });
    }
    log.error('[pms-inbox] insert failed', { requestId, propertyId, err: insErr.message });
    return new NextResponse('server_error', { status: 500 });
  }

  // Masked log only — NEVER the code digits.
  log.info('[pms-inbox] stored code', {
    requestId,
    propertyId,
    senderDomain: auth.fromDomain,
    codeLen: code.length,
    messageId: messageId ? messageId.slice(0, 80) : null,
  });
  return ok({ stored: true }, { requestId });
}
