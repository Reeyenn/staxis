// @audit: tenant-scope-not-applicable — Cloudflare Email Worker → shared-secret
// webhook (Bearer PMS_INBOX_WEBHOOK_SECRET, constant-time). Not a user/session
// route; it resolves the property itself from the verified recipient address.
/**
 * POST /api/pms-inbox/inbound — the single inbound-mail boundary.
 *
 * Cloudflare Email Routing hands each inbound message to an Email Worker,
 * which parses it and POSTs the relevant fields here with
 * `Authorization: Bearer <PMS_INBOX_WEBHOOK_SECRET>`. Two message CLASSES now
 * arrive on this one route, and which one a message is depends ONLY on the
 * recipient address — never on its content:
 *
 *   kind='auth_code' (migrations 0274 + 0275) — Okta 2FA mail for the robot's
 *     PMS login. Unchanged: okta.com sender allowlist, recipient resolved via
 *     scraper_credentials.pms_login_email, code extracted into pms_auth_codes.
 *
 *   kind='report' (migrations 0340-0342) — scheduled PMS report emails, the
 *     new data intake path. Resolved by sha256 of an unguessable capability
 *     token in the local part; sender pinned trust-on-first-use to a VERIFIED
 *     DKIM domain; attachments accepted via a hash-first handshake so the
 *     bytes go Worker → Supabase Storage directly and never touch Vercel.
 *
 * WHY EXTEND THIS ROUTE INSTEAD OF ADDING A PARALLEL ONE
 *   This file is already the security boundary of record — constant-time
 *   bearer, trusted-verdict DMARC/DKIM, timestamp tolerance, recipient →
 *   property resolution, per-property rate limit. A second inbound route would
 *   be a second boundary to keep in sync, and the first one to drift.
 *
 * WHY THE HASH-FIRST HANDSHAKE INSTEAD OF BASE64-THROUGH-WEBHOOK
 *   Vercel serverless request bodies cap around 4.5 MB and base64 inflates
 *   33%, so an inlined attachment tops out near 3.3 MB — a night-audit PDF
 *   pack blows through that and the failure is a 413 the hotel never sees.
 *   Sending only {filename, mimeType, size, sha256} keeps this request ~2 KB
 *   regardless of attachment size, keeps report bytes (guest names, possible
 *   card fragments) out of Vercel function memory and request logs entirely,
 *   and means a duplicate file's bytes are never transferred at all.
 *
 * Every accepted-but-dropped path returns a uniform 2xx (no enumeration, no
 * SMTP backscatter). 401 is reserved for a bad secret, 5xx for genuine server
 * errors (which legitimately invite a Worker retry). Codes, message bodies and
 * inbox tokens are never logged.
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
  classifyRecipient,
  domainAllowed,
  reportInboxHash,
  extractOtpCode,
} from '@/lib/pms-inbox/parse';
import {
  PMS_RAW_BUCKET,
  MAX_ATTACHMENTS_PER_MESSAGE,
  buildRawObjectPath,
  validateAttachmentClaim,
  type AttachmentDecision,
} from '@/lib/pms-inbox/report-files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// The domain the Okta 2FA inbox receives on (apex). Defaults to getstaxis.com;
// override only via env for tests.
const DEFAULT_INBOX_DOMAIN = 'getstaxis.com';
// The domain scheduled report mail receives on. If Cloudflare Email Routing
// can't be bound to a subdomain on this zone, set PMS_REPORT_INBOX_DOMAIN to
// the apex — the local-part prefix below keeps the two classes disjoint either
// way, and neither shape is baked into a DB constraint.
const DEFAULT_REPORT_INBOX_DOMAIN = 'in.getstaxis.com';
const DEFAULT_REPORT_LOCAL_PREFIX = 'r-';
// Production sender allowlist for AUTH-CODE mail only. Okta sends the OTP /
// setup mail from okta.com / the tenant subdomain (e.g. choicehotels.okta.com —
// matched by the subdomain rule), which publishes DMARC p=reject. We
// deliberately do NOT include choicehotels.com (the corporate domain): it isn't
// the sender and its DMARC is p=none, so Cloudflare would deliver spoofed mail
// From: it — an injection vector. Override via env only to add a *verified*
// Okta sub-processor domain, or a controlled test sender during verification.
// Report mail does NOT use this list: no static allowlist can cover an unknown
// PMS's mailer, so reports are pinned per-hotel trust-on-first-use instead.
const DEFAULT_ALLOWED_SENDERS = ['okta.com'];
// Drop forwards whose Worker timestamp is more than this far from now.
const TIMESTAMP_TOLERANCE_MS = 10 * 60 * 1000;
// Secondary guard; the Worker is the primary size gate. Attachment BYTES never
// come through here (only their hashes), so this stays small on purpose.
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

/** The apex domain we accept 2FA inbox mail on (env override for tests). */
function inboxDomain(): string {
  return (env.PMS_INBOX_DOMAIN ?? '').trim().toLowerCase() || DEFAULT_INBOX_DOMAIN;
}
function reportInboxDomain(): string {
  return (env.PMS_REPORT_INBOX_DOMAIN ?? '').trim().toLowerCase() || DEFAULT_REPORT_INBOX_DOMAIN;
}
function reportLocalPrefix(): string {
  return (env.PMS_REPORT_LOCAL_PREFIX ?? '').trim().toLowerCase() || DEFAULT_REPORT_LOCAL_PREFIX;
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
  /** Report path only: metadata for each attachment. Never the bytes. */
  attachments?: unknown;
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

  // ── 4. Classify by RECIPIENT ONLY (never by content) ──────────────────────
  const recipient = classifyRecipient(str(body.to), {
    authDomain: inboxDomain(),
    reportDomain: reportInboxDomain(),
    reportLocalPrefix: reportLocalPrefix(),
  });
  if (!recipient) {
    log.warn('[pms-inbox] unresolvable recipient', { requestId });
    return ok({ stored: false, reason: 'bad_recipient' }, { requestId });
  }

  return recipient.kind === 'report'
    ? handleReport(body, recipient.local, recipient.domain, requestId)
    : handleAuthCode(body, recipient.normalized, requestId);
}

// ═══════════════════════════════════════════════════════════════════════════
// Okta 2FA path — behavior unchanged from 0274/0275.
// ═══════════════════════════════════════════════════════════════════════════

async function handleAuthCode(
  body: InboundBody,
  recipient: string,
  requestId: string,
): Promise<Response> {
  // ── Sender authenticity (DMARC/DKIM aligned to an allowlisted domain) ────
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

  // ── Resolve recipient → property ─────────────────────────────────────────
  // `recipient` is normalized lowercase; pms_login_email is stored lowercase
  // (migration 0275) and indexed, so this raw equality is index-backed.
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

  // ── Per-property rate-limit (raw property id) ────────────────────────────
  const rl = await checkAndIncrementRateLimit('pms-inbox-inbound', propertyId);
  if (!rl.allowed) {
    log.warn('[pms-inbox] rate limited', { requestId, propertyId, current: rl.current, cap: rl.cap });
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // The provider Message-Id dedups replayed/duplicate deliveries on BOTH tables.
  const messageId = str(body.messageId) || null;

  // ── Store the FULL message (NON-FATAL: never block the 2FA code path) ────
  try {
    const { error: msgErr } = await supabaseAdmin.from('pms_inbox_messages').insert({
      property_id: propertyId,
      email_to: recipient,
      kind: 'auth_code',
      inbox_domain: recipient.split('@').pop() ?? null,
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

  // ── Extract the code (authenticated content only) ────────────────────────
  const code = extractOtpCode({
    subject: str(body.subject),
    text: str(body.text),
    html: str(body.html),
  });
  if (!code) {
    log.warn('[pms-inbox] no code extracted', { requestId, propertyId });
    return ok({ stored: false, reason: 'no_code' }, { requestId });
  }

  // ── Store the code (UNIQUE raw_ref dedups a replayed delivery) ───────────
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

// ═══════════════════════════════════════════════════════════════════════════
// Report path (migrations 0340-0342).
// ═══════════════════════════════════════════════════════════════════════════

interface ReportCredential {
  property_id: string;
  report_sender_domains: string[] | null;
}

async function handleReport(
  body: InboundBody,
  local: string,
  domain: string,
  requestId: string,
): Promise<Response> {
  // ── Authenticity. No static allowlist can cover an unknown PMS's mailer, so
  // the bar here is "the verified receiver verdict says this mail is genuinely
  // from the domain it claims" — DKIM pass AND DMARC pass, from the trusted
  // Authentication-Results header the Worker selected. WHICH domain is allowed
  // is a per-hotel decision, made below.
  const dkim = str(body.dkim).toLowerCase().trim();
  const dmarc = str(body.dmarc).toLowerCase().trim();
  const dkimDomain = str(body.dkimDomain).toLowerCase().trim();
  if (dkim !== 'pass' || dmarc !== 'pass' || !dkimDomain) {
    log.warn('[pms-inbox] report sender unauthenticated', { requestId, dkim, dmarc });
    return ok({ stored: false, reason: 'unauthenticated' }, { requestId });
  }

  // ── A report with no Message-Id cannot be deduped, so it is refused BEFORE
  // anything is written or any upload URL is minted.
  const messageId = str(body.messageId).trim();
  if (!messageId) {
    log.warn('[pms-inbox] report without message-id dropped', { requestId });
    return ok({ stored: false, reason: 'no_message_id' }, { requestId });
  }

  // ── Resolve the capability token → property. The token is the ENTIRE local
  // part (plus-addressing is NOT stripped — see parse.ts); we only ever hold
  // its sha256, so a DB read never hands over a working address.
  const hash = reportInboxHash(local);
  const { data: credRow, error: credErr } = await supabaseAdmin
    .from('scraper_credentials')
    .select('property_id, report_sender_domains')
    .eq('report_inbox_hash', hash)
    .maybeSingle();
  if (credErr) {
    log.error('[pms-inbox] report recipient lookup failed', { requestId, err: credErr.message });
    return new NextResponse('server_error', { status: 500 });
  }
  if (!credRow) {
    log.warn('[pms-inbox] unknown report recipient', { requestId });
    return ok({ stored: false, reason: 'unknown_recipient' }, { requestId });
  }
  const cred = credRow as ReportCredential;
  const propertyId = cred.property_id;

  // ── Per-property rate-limit ──────────────────────────────────────────────
  const rl = await checkAndIncrementRateLimit('pms-report-inbound', propertyId);
  if (!rl.allowed) {
    log.warn('[pms-inbox] report rate limited', {
      requestId, propertyId, current: rl.current, cap: rl.cap,
    });
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // ── Trust-on-first-use sender pinning. An unseen signing domain does NOT
  // reject the mail: the file is still stored (an operator needs to see it to
  // approve it), but sender_approved stays false and the DB CHECK
  // `status <> 'parsed' or sender_approved` makes parsing impossible.
  const approvedDomains = (cred.report_sender_domains ?? []).filter(Boolean);
  const senderApproved = approvedDomains.length > 0 && domainAllowed(dkimDomain, approvedDomains);

  const receivedAt = new Date();
  const fromRaw = str(body.from);

  // ── Store the message row (kind='report'). The email_to column deliberately
  // does NOT hold the capability token: writing it here in the clear would
  // undo the whole point of storing only a hash. property_id + inbox_domain
  // identify the delivery just as well.
  const { data: msgRow, error: msgErr } = await supabaseAdmin
    .from('pms_inbox_messages')
    .insert({
      property_id: propertyId,
      email_to: `report-inbox@${domain}`,
      kind: 'report',
      inbox_domain: domain,
      from_addr: fromRaw.slice(0, 320) || null,
      subject: str(body.subject).slice(0, 500) || null,
      body_text: str(body.text).slice(0, MAX_STORED_TEXT) || null,
      body_html: str(body.html).slice(0, MAX_STORED_HTML) || null,
      message_id: messageId,
    })
    .select('id')
    .maybeSingle();
  const duplicateMessage = (msgErr as { code?: string } | null)?.code === '23505';
  if (msgErr && !duplicateMessage) {
    log.error('[pms-inbox] report message store failed', {
      requestId, propertyId, err: msgErr.message,
    });
    return new NextResponse('server_error', { status: 500 });
  }
  // A duplicate Message-Id is NOT a reason to stop: the first delivery may have
  // died mid-upload, and the attachment handling below is content-addressed and
  // idempotent. Re-running it is how an interrupted delivery completes.

  // ── Attachments: hash-first handshake ────────────────────────────────────
  const claims = Array.isArray(body.attachments) ? body.attachments : [];
  const decisions: AttachmentDecision[] = [];
  let accepted = 0;

  for (const rawClaim of claims.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    const validated = validateAttachmentClaim(rawClaim);
    if (!validated.ok) {
      if (validated.sha256) decisions.push({ sha256: validated.sha256, action: 'skip', reason: validated.reason });
      log.warn('[pms-inbox] attachment claim rejected', { requestId, propertyId, reason: validated.reason });
      continue;
    }
    const { claim } = validated;

    const path = buildRawObjectPath({
      propertyId,
      sha256: claim.sha256,
      mime: claim.mimeType,
      receivedAt,
    });
    if (!path) {
      decisions.push({ sha256: claim.sha256, action: 'skip', reason: 'unsupported_type' });
      continue;
    }

    // Already have a receipt for these exact bytes at this hotel?
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('pms_report_files')
      .select('id, status, storage_path')
      .eq('property_id', propertyId)
      .eq('content_sha256', claim.sha256)
      .maybeSingle();
    if (existingErr) {
      log.error('[pms-inbox] report file lookup failed', { requestId, propertyId, err: existingErr.message });
      decisions.push({ sha256: claim.sha256, action: 'skip', reason: 'lookup_failed' });
      continue;
    }

    if (existing && existing.status !== 'pending_upload') {
      // Bytes already landed (or were quarantined/purged). Nothing to transfer
      // — this is the whole point of the hash-first exchange.
      decisions.push({ sha256: claim.sha256, action: 'skip', reason: 'duplicate' });
      continue;
    }

    if (!existing) {
      const { error: insErr } = await supabaseAdmin.from('pms_report_files').insert({
        property_id: propertyId,
        content_sha256: claim.sha256,
        byte_size: claim.size,
        mime_type: claim.mimeType,
        original_filename: claim.filename,
        storage_path: path,
        message_id: messageId,
        from_addr: fromRaw.slice(0, 320) || null,
        subject: str(body.subject).slice(0, 500) || null,
        sender_domain: dkimDomain,
        sender_approved: senderApproved,
        // Until a real report format is in hand, the mail Date header (the
        // Worker's ts) is the only as-of time available. The sender is already
        // DKIM-pinned, so a forged Date is not a new attack surface.
        source_captured_at: receivedAt.toISOString(),
        status: 'pending_upload',
      });
      if (insErr) {
        // 23505 here means a concurrent delivery of the same bytes won the
        // race — treat it exactly like a duplicate.
        if ((insErr as { code?: string }).code === '23505') {
          decisions.push({ sha256: claim.sha256, action: 'skip', reason: 'duplicate' });
          continue;
        }
        log.error('[pms-inbox] report file insert failed', {
          requestId, propertyId, err: insErr.message,
        });
        decisions.push({ sha256: claim.sha256, action: 'skip', reason: 'ledger_insert_failed' });
        continue;
      }
    }

    // A ledger row in 'pending_upload' means the bytes never landed — re-issue
    // the URL rather than skipping, or a re-forwarded copy of an interrupted
    // delivery would be silently dropped and swept to 'failed' an hour later.
    const objectPath = (existing?.storage_path as string | null) ?? path;
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from(PMS_RAW_BUCKET)
      .createSignedUploadUrl(objectPath, { upsert: false });
    if (signErr || !signed?.signedUrl) {
      log.error('[pms-inbox] signed upload url mint failed', {
        requestId, propertyId, err: signErr?.message ?? 'no url',
      });
      decisions.push({ sha256: claim.sha256, action: 'skip', reason: 'presign_failed' });
      continue;
    }

    accepted++;
    decisions.push({ sha256: claim.sha256, action: 'upload', uploadUrl: signed.signedUrl });
  }

  // Counts and hashes only — NEVER the token, the subject, or a filename.
  log.info('[pms-inbox] report accepted', {
    requestId,
    propertyId,
    senderDomain: dkimDomain,
    senderApproved,
    duplicateMessage,
    attachmentsClaimed: claims.length,
    attachmentsAccepted: accepted,
    messageRowId: (msgRow as { id?: string } | null)?.id ?? null,
  });

  return ok(
    { stored: true, kind: 'report', senderApproved, attachments: decisions },
    { requestId },
  );
}
