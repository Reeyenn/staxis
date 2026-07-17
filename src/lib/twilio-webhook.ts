// ═══════════════════════════════════════════════════════════════════════════
// Shared Twilio inbound-webhook plumbing.
//
// Both inbound-SMS webhooks — /api/sms-reply (shift-reply) and /api/sms/callout
// (sick callout) — share the exact same request-security surface: TwiML empty-
// response acking, 403 rejection, X-Twilio-Signature verification, proxy-aware
// URL reconstruction, E.164 normalisation, and PII-redacted webhook_log writes.
// These lived duplicated in both routes; this module is the single source so
// the security posture can only ever drift in one place.
//
// Signature verification (verifyTwilioSignature) is call-for-call identical to
// the previous per-route copies — same twilio.validateRequest arguments, same
// fail-closed behavior when the auth token or signature is absent.
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { recordWebhookLog } from '@/lib/event-recorder';
import { redactPhone } from '@/lib/api-validate';
import { log } from '@/lib/log';
import { env } from '@/lib/env';
import twilio from 'twilio';

// Twilio expects TwiML (XML), not JSON. An empty <Response/> tells Twilio
// "handled, send no auto-reply" — the route has fired its own sendSms() already.
export function twimlOk(): NextResponse {
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } },
  );
}

// 403 forbidden — used when the X-Twilio-Signature check fails. Returning
// a non-2xx makes Twilio retry, which is what we want for a transient
// signing-key drift, but the body is irrelevant for the rejection.
export function forbidden(reason: string): NextResponse {
  return new NextResponse(reason, {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Verify the X-Twilio-Signature header so anyone outside Twilio can't post
 * to a webhook and trigger SMS sends through our account or spoof a
 * housekeeper's reply. Twilio computes the signature as
 *   HMAC-SHA1( authToken, fullUrl + sortedParamsConcatenated )
 * and base64-encodes it. We delegate to the official `twilio` SDK's
 * `validateRequest` helper which handles the form-encoded path.
 *
 * For JSON bodies we fall back to comparing against the URL with no params
 * (Twilio's recommended form for non-form-encoded webhooks). In practice
 * Twilio always posts form-encoded for SMS replies, but we keep the JSON
 * path so a future migration doesn't break.
 */
export function verifyTwilioSignature(
  url: string,
  signature: string | null,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  try {
    return twilio.validateRequest(authToken, signature, url, params);
  } catch {
    return false;
  }
}

/**
 * Reconstruct the public URL Twilio used when computing the signature.
 * Behind a Vercel proxy the request URL must be reconstructed from the
 * `X-Forwarded-*` headers so we match exactly what Twilio saw.
 */
export function reconstructWebhookUrl(req: NextRequest): string {
  // Prefer the X-Forwarded headers so we match exactly what Twilio saw.
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host  = req.headers.get('x-forwarded-host')  ?? req.headers.get('host') ?? new URL(req.url).host;
  const path  = new URL(req.url).pathname;
  const search = new URL(req.url).search;
  return `${proto}://${host}${path}${search}`;
}

export function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

// Keys whose values are phone numbers and must be redacted to "+1***1234"
// before being written to webhook_log. Superset of what either route emits —
// redacting a key a given route never logs is a harmless no-op.
const PHONE_KEYS = new Set([
  'fromNumber', 'fromHeader', 'phone', 'phone164', 'staffPhone', 'From',
]);

/**
 * Build a `logHit(payload)` writer bound to a webhook `source` tag.
 *
 * Writes every webhook hit (and its final lookup outcome) to the `webhook_log`
 * table for end-to-end diagnosis. Any field holding a phone number is redacted
 * before insertion — webhook_log is service-role only via RLS, but we still
 * don't want full E.164 phones in cleartext on disk, so if a future migration
 * mistakenly opens read access the blast radius stays small.
 */
export function makeWebhookLogger(
  source: string,
): (payload: Record<string, unknown>) => Promise<void> {
  return async (payload: Record<string, unknown>): Promise<void> => {
    try {
      const redacted: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (PHONE_KEYS.has(k) && typeof v === 'string') {
          redacted[k] = redactPhone(v);
        } else {
          redacted[k] = v;
        }
      }
      await recordWebhookLog({ source, payload: redacted });
    } catch (e) {
      log.warn(`[${source}] logHit failed`, { err: e });
    }
  };
}
