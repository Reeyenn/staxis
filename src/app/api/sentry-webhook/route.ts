/**
 * POST /api/sentry-webhook
 *
 * Receives Sentry "issue.created" or "issue.alert" webhooks and
 * forwards a short SMS to MANAGER_PHONE via Twilio. The intent is
 * "critical alerts buzz Reeyen's phone instead of sitting in his
 * email inbox where he might miss them."
 *
 * Reeyen is a non-technical solo founder. Email alerts from Sentry
 * already arrive, but he might not check them for hours. This
 * endpoint surfaces only the genuinely-important events as SMS so
 * his phone vibrates.
 *
 * ## Sentry-side configuration
 *
 * 1. Go to Sentry → Settings → Integrations → Internal Integrations
 *    (or Sentry → Alerts → New Alert Rule)
 * 2. Add a webhook destination pointed at:
 *    https://getstaxis.com/api/sentry-webhook
 * 3. Set SENTRY_WEBHOOK_SECRET in Vercel env. Use the "client secret"
 *    from the internal integration. We HMAC-SHA256 the body with
 *    this secret and compare against the `sentry-hook-signature`
 *    header — if it doesn't match, we 401. This prevents random
 *    attackers from sending fake "critical" SMS to Reeyen.
 * 4. In the alert rule, scope to "level:error or above" so we don't
 *    SMS for every warning. Reeyen can refine later.
 *
 * ## Failure modes (intentional)
 *
 * - If MANAGER_PHONE isn't set, we 200 + log + skip the SMS. We
 *   don't want Sentry to keep retrying the webhook just because
 *   alerting is mis-configured at the receiver.
 * - If Twilio fails, we 500 so Sentry retries. Twilio outages are
 *   rare; better to retry than to silently miss a critical alert.
 * - If the signature is wrong, 401. Sentry will surface this in
 *   their UI as a delivery failure, which itself is a useful signal.
 */

import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { sendSms } from '@/lib/sms';
import { captureException } from '@/lib/sentry';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;  // SMS round-trip is sub-second; 15s is plenty

const E164 = /^\+[1-9]\d{10,14}$/;

/** Sentry's webhook payload shape (subset we care about). */
interface SentryWebhookPayload {
  action?: string;
  data?: {
    issue?: {
      id?: string;
      title?: string;
      culprit?: string;
      level?: string;
      project?: { name?: string };
      web_url?: string;
      shortId?: string;
      count?: string | number;
    };
    event?: {
      message?: string;
      environment?: string;
    };
  };
}

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // timingSafeEqual on Buffers of identical length. Pad signatures if
  // they happen to be different lengths to avoid a Buffer.alloc throw.
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function formatSmsForIssue(payload: SentryWebhookPayload): string {
  const issue = payload.data?.issue;
  const ev = payload.data?.event;
  const sentryEnv = ev?.environment ?? 'unknown';
  const project = issue?.project?.name ?? 'staxis';
  const title = issue?.title ?? ev?.message ?? '(no title)';
  const url = issue?.web_url ?? '';
  const level = issue?.level ?? 'error';
  const count = issue?.count ?? '?';

  // Twilio SMS soft cap is 1600 chars but most carriers chunk after
  // 160. Aim for one segment.
  const head = `[Staxis ${sentryEnv}] ${level.toUpperCase()} in ${project}`;
  const body = truncate(title, 80);
  const tail = url ? `\n${url}` : '';
  return `${head}\n${body}\nseen ${count}×${tail}`;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const secret = env.SENTRY_WEBHOOK_SECRET;
  if (!secret) {
    log.warn('[sentry-webhook] SENTRY_WEBHOOK_SECRET not set; rejecting');
    return err('webhook not configured', { requestId, status: 503, code: ApiErrorCode.InternalError });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('sentry-hook-signature');
  if (!verifySignature(rawBody, signature, secret)) {
    log.warn('[sentry-webhook] signature mismatch; rejecting', { requestId });
    return err('signature mismatch', { requestId, status: 401, code: ApiErrorCode.Unauthorized });
  }

  let payload: SentryWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Only fire on issue.created or issue.alert. Resolved/assigned/etc
  // aren't worth a phone buzz.
  const action = payload.action ?? '';
  const isAlertable = action === 'created' || action === 'triggered' || action === 'alert.triggered';
  if (!isAlertable) {
    log.info('[sentry-webhook] non-alertable action; skipping SMS', { requestId, action });
    return ok({ skipped: true, reason: 'non-alertable action' }, { requestId });
  }

  const phone = (env.OPS_ALERT_PHONE || '').trim();
  if (!phone || !E164.test(phone)) {
    log.warn('[sentry-webhook] MANAGER_PHONE missing or invalid; skipping SMS', { requestId, hasPhone: !!phone });
    // 200 so Sentry doesn't retry. The doctor already surfaces this
    // misconfiguration as a fail check, and the email path still
    // works.
    return ok({ skipped: true, reason: 'phone not configured' }, { requestId });
  }

  const body = formatSmsForIssue(payload);

  try {
    await sendSms(phone, body);
    log.info('[sentry-webhook] SMS sent', { requestId, action, issueId: payload.data?.issue?.id });
    return ok({ sent: true }, { requestId });
  } catch (e) {
    log.error('[sentry-webhook] Twilio send failed', { requestId, err: e });
    captureException(e, { subsystem: 'sentry-webhook', failure_mode: 'twilio_send_failed' });
    return err('twilio send failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

// GET for quick health-check from a browser without spamming SMS.
export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const phone = (env.OPS_ALERT_PHONE || '').trim();
  return ok({
    configured: !!env.SENTRY_WEBHOOK_SECRET,
    phoneValid: !!phone && E164.test(phone),
  }, { requestId });
}
