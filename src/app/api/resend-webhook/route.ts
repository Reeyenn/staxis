/**
 * POST /api/resend-webhook
 *
 * Comms-voice audit follow-up (2026-05-22). Resend can tell us when an
 * email we sent bounces, gets marked as spam, or is delayed. Before this
 * route existed we relied entirely on the synchronous Resend API response
 * (which only confirms the message was accepted for delivery, not that it
 * landed). A typo'd hotel-owner email or a full inbox was invisible.
 *
 * What this route does:
 *   - Receives Resend webhook POSTs.
 *   - Verifies the Svix-style signature using RESEND_WEBHOOK_SECRET.
 *   - Persists each event to admin_audit_log via writeAudit so the
 *     /admin/properties/[id] audit feed can show "this invite bounced".
 *   - Fires Sentry on permanent bounce / complaint so on-call sees it.
 *
 * What it does NOT do:
 *   - No retry SMS to ops on bounce. Manual remediation only (admin can
 *     edit the email and re-send).
 *   - No DB schema change. Uses existing admin_audit_log.
 *
 * ## Resend-side configuration (manual, one-time per environment)
 *
 *   1. Resend dashboard → Webhooks → Add Endpoint
 *   2. URL: https://getstaxis.com/api/resend-webhook
 *   3. Subscribe to events: email.bounced, email.complained,
 *      email.delivered, email.delivery_delayed
 *   4. Copy the signing secret (format: whsec_<base64>) into
 *      Vercel env as RESEND_WEBHOOK_SECRET.
 *
 * If RESEND_WEBHOOK_SECRET is unset, this route fail-closes every
 * request — preventing a misconfigured deploy from accepting unsigned
 * bounce/complaint POSTs from anyone with the URL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import { captureException } from '@/lib/sentry';
import { verifySvixSignature } from '@/lib/resend-webhook-signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

// Resend wraps Svix; format documented at https://docs.svix.com/.
const VALID_EVENT_TYPES = new Set([
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.complained',
  'email.bounced',
  'email.opened',
  'email.clicked',
  'email.failed',
]);

// Subset of types we treat as audit-worthy. The others (opened/clicked)
// are noisy and we don't have a use case for them yet — we acknowledge
// the webhook with 2xx so Resend stops retrying, but don't persist.
const PERSIST_EVENT_TYPES = new Set([
  'email.delivered',
  'email.delivery_delayed',
  'email.complained',
  'email.bounced',
  'email.failed',
]);

// Sentry-worthy: a delivery problem the operator should see.
const ALERT_EVENT_TYPES = new Set([
  'email.bounced',
  'email.complained',
  'email.failed',
]);

interface ResendEventPayload {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    bounce?: { type?: string; subType?: string; message?: string };
    complaint?: { feedback_type?: string };
    failure?: { reason?: string };
    tags?: Record<string, string> | Array<{ name: string; value: string }>;
  };
}

function recipientOf(data: ResendEventPayload['data'] | undefined): string | null {
  if (!data) return null;
  if (Array.isArray(data.to)) return data.to[0] ?? null;
  if (typeof data.to === 'string') return data.to;
  return null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  // ── Fail closed on missing secret ──────────────────────────────────────
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    log.error('[resend-webhook] RESEND_WEBHOOK_SECRET not configured — refusing all webhooks', { requestId });
    return new NextResponse('Webhook not configured', { status: 503 });
  }

  // ── Read raw body for signature verification ───────────────────────────
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (e) {
    log.warn('[resend-webhook] failed to read body', { requestId, err: e });
    return new NextResponse('bad_request', { status: 400 });
  }

  // ── Verify signature ──────────────────────────────────────────────────
  const svixId = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');
  const sigCheck = verifySvixSignature(rawBody, svixId, svixTimestamp, svixSignature, secret);
  if (!sigCheck.ok) {
    log.warn('[resend-webhook] signature rejected', {
      requestId,
      reason: sigCheck.reason,
      svixId,
    });
    // 401 — same shape as sentry-webhook so Resend surfaces this in their
    // delivery-failure UI (and stops retrying after their backoff cap).
    return new NextResponse('unauthorized', { status: 401 });
  }

  // ── Parse ──────────────────────────────────────────────────────────────
  let payload: ResendEventPayload;
  try {
    payload = JSON.parse(rawBody) as ResendEventPayload;
  } catch (e) {
    log.warn('[resend-webhook] invalid JSON', { requestId, err: e });
    return new NextResponse('bad_request', { status: 400 });
  }

  const eventType = typeof payload.type === 'string' ? payload.type : '';
  if (!VALID_EVENT_TYPES.has(eventType)) {
    // Unknown event types — 2xx so Resend doesn't keep retrying, but we
    // don't persist or alert. New event types added by Resend over time
    // shouldn't break the webhook handler.
    log.info('[resend-webhook] unknown event type, acking without persist', {
      requestId,
      eventType,
    });
    return NextResponse.json({ ok: true, persisted: false });
  }

  const recipient = recipientOf(payload.data);
  const resendId = typeof payload.data?.email_id === 'string' ? payload.data.email_id : null;
  const subject = typeof payload.data?.subject === 'string' ? payload.data.subject : null;

  // ── Persist if it's an audit-worthy event ──────────────────────────────
  if (PERSIST_EVENT_TYPES.has(eventType)) {
    await writeAudit({
      action: eventType,  // already verb-style (e.g. 'email.bounced')
      targetType: 'email',
      targetId: recipient ?? resendId ?? 'unknown',
      metadata: {
        resendId,
        recipient,
        subject,
        bounce: payload.data?.bounce ?? undefined,
        complaint: payload.data?.complaint ?? undefined,
        failure: payload.data?.failure ?? undefined,
        tags: payload.data?.tags ?? undefined,
        created_at: payload.created_at ?? undefined,
        source: 'resend-webhook',
      },
    });
  }

  // ── Sentry alert for genuinely-bad events ──────────────────────────────
  if (ALERT_EVENT_TYPES.has(eventType)) {
    captureException(
      new Error(`Resend reported ${eventType} for ${recipient ?? 'unknown recipient'}`),
      {
        subsystem: 'email',
        failure_mode: eventType,
        recipient: recipient ?? 'unknown',
        resendId: resendId ?? 'unknown',
        bounceType: payload.data?.bounce?.type ?? 'n/a',
      },
    );
  }

  return NextResponse.json({ ok: true, persisted: PERSIST_EVENT_TYPES.has(eventType) });
}
