// @audit: tenant-scope-not-applicable — Cloudflare Email Worker → shared-secret
// webhook (Bearer PMS_INBOX_WEBHOOK_SECRET, constant-time). Not a user/session
// route; it resolves the property itself from the verified recipient address.
/**
 * POST /api/pms-inbox/inbound — Okta 2FA email reader (migration 0274).
 *
 * Cloudflare Email Routing (catch-all on pms.getstaxis.com) hands each inbound
 * message to an Email Worker, which parses it and POSTs the relevant fields
 * here with `Authorization: Bearer <PMS_INBOX_WEBHOOK_SECRET>`. We store the
 * one-time code so the CUA robot can read it for an unattended PMS login.
 *
 * Security (this is the boundary of record — the Worker is just a courier):
 *   1. Constant-time shared-secret check; fail-closed (503) if unset.
 *   2. Timestamp tolerance — drop stale forwards (replay defense-in-depth).
 *   3. Sender authenticity — DMARC/DKIM aligned to an allowlisted domain
 *      (okta.com / choicehotels.com), from Cloudflare's verified verdict.
 *      Never the spoofable From string, never a bare "dkim=pass" substring.
 *   4. Resolve the recipient → property via scraper_credentials.pms_login_email.
 *   5. Per-property rate-limit on the RAW property id.
 *   6. Extract the code (anchored, ambiguity-refusing) and store it. A UNIQUE
 *      raw_ref (messageId) dedups replayed/duplicate deliveries.
 *
 * Every accepted-but-dropped path returns a uniform 2xx (no enumeration / no
 * SMTP backscatter). 401 is reserved for a bad secret, 5xx for genuine server
 * errors (which legitimately invite a Worker retry). Codes are never logged.
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

// The catch-all subdomain we receive 2FA mail on. Recipients on any other
// domain are rejected.
const INBOX_DOMAIN = 'pms.getstaxis.com';
// Production sender allowlist. Overridable via env (e.g. to add a verified Okta
// sub-processor domain, or a controlled test sender during verification).
const DEFAULT_ALLOWED_SENDERS = ['okta.com', 'choicehotels.com'];
// Drop forwards whose Worker timestamp is more than this far from now.
const TIMESTAMP_TOLERANCE_MS = 10 * 60 * 1000;
// Secondary guard; the Worker is the primary size gate.
const MAX_BODY_BYTES = 512 * 1024;

function allowedSenderDomains(): string[] {
  const raw = (env.PMS_INBOX_ALLOWED_SENDER_DOMAINS ?? '').trim();
  if (!raw) return DEFAULT_ALLOWED_SENDERS;
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_SENDERS;
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
  const recipient = normalizeRecipient(str(body.to), INBOX_DOMAIN);
  if (!recipient) {
    log.warn('[pms-inbox] unresolvable recipient', { requestId });
    return ok({ stored: false, reason: 'bad_recipient' }, { requestId });
  }
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

  // ── 8. Store (UNIQUE raw_ref dedups a replayed/duplicate delivery) ────────
  const messageId = str(body.messageId) || null;
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
