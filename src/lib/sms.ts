/**
 * Shared SMS utility - Twilio REST API
 *
 * Credentials come from `env` (src/lib/env.ts), which collapses the legacy
 * TWILIO_PHONE_NUMBER alias into TWILIO_FROM_NUMBER during the migration sweep.
 *
 * NOTE: The original local 10DLC number (+12816669887) is blocked by A2P carrier
 * filtering (Error 30034) until A2P Brand + Campaign registration is approved (~2-3 weeks).
 * Using a Toll-Free number bypasses this - unverified toll-free works at low volume
 * (<100 msg/day) with no registration required upfront.
 *
 * Long-term: submit Toll-Free Verification in Twilio console for full throughput.
 *
 * Phase E2E (2026-05-22): Sentry observability on send failures. Throw
 * behavior is unchanged — callers still receive `throw new Error(...)`
 * exactly as before. We only ADD a captureMessage with a deduping
 * fingerprint so the System Status / Sentry surface shows Twilio outages
 * instead of relying on each caller's own catch path to log.
 */

import * as Sentry from '@sentry/nextjs';
import { env, isSmsConfigured } from '@/lib/env';
import { externalFetch, EXTERNAL_FETCH_TIMEOUT_MS } from '@/lib/external-service-config';

function sanitizeSmsBody(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
}

function reportTwilioFailure(args: {
  step: 'fetch' | 'http';
  status: number | null;
  errorCode: string | number | null;
  message: string;
}): void {
  try {
    Sentry.withScope((scope) => {
      // Fingerprint groups by error code if Twilio gave us one (30034,
      // 21610, etc.) so transient blips on one code don't drown out a
      // structural problem on another. Falls back to step name otherwise.
      const fp = args.errorCode != null ? String(args.errorCode) : args.step;
      scope.setFingerprint(['twilio_send_failed', fp]);
      scope.setLevel('error');
      scope.setTag('twilio.step', args.step);
      if (args.status != null) scope.setTag('twilio.http_status', String(args.status));
      if (args.errorCode != null) scope.setTag('twilio.error_code', String(args.errorCode));
      scope.setExtras({ message: args.message.slice(0, 500) });
      Sentry.captureMessage(`twilio_send_failed: ${args.errorCode ?? args.step}`);
    });
  } catch {
    // Telemetry must never break the SMS path.
  }
}

export async function sendSms(to: string, message: string): Promise<void> {
  if (!isSmsConfigured()) {
    throw new Error('Twilio env vars missing (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)');
  }
  const accountSid = env.TWILIO_ACCOUNT_SID!;
  const authToken  = env.TWILIO_AUTH_TOKEN!;
  const from       = env.TWILIO_FROM_NUMBER!;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const sanitizedBody = sanitizeSmsBody(message);
  const body = new URLSearchParams({ To: to, From: from, Body: sanitizedBody });

  // Audit finding #2: pre-2026-05-17 this `fetch` had no signal at all,
  // so a hung Twilio API call could block the sentry-webhook handler (or
  // any inline sendSms caller) indefinitely. externalFetch enforces a
  // 15s ceiling; sms-jobs queue retries handle transient failures for
  // the cron path.
  let res: Response;
  try {
    res = await externalFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      },
      body: body.toString(),
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
    });
  } catch (e) {
    // Network failure or timeout. Capture for observability, then re-throw
    // so the caller's existing error path (which may log + queue for retry)
    // continues to fire exactly as before.
    const msg = e instanceof Error ? e.message : String(e);
    reportTwilioFailure({ step: 'fetch', status: null, errorCode: null, message: msg });
    throw e;
  }

  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({})) as { message?: string; code?: string | number };
    const msg = errPayload.message ?? `Twilio error ${res.status}`;
    reportTwilioFailure({
      step: 'http',
      status: res.status,
      errorCode: errPayload.code ?? null,
      message: msg,
    });
    throw new Error(msg);
  }
}
