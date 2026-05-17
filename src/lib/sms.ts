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
 */

import { env, isSmsConfigured } from '@/lib/env';
import { externalFetch, EXTERNAL_FETCH_TIMEOUT_MS } from '@/lib/external-service-config';

function sanitizeSmsBody(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
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
  const res = await externalFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    },
    body: body.toString(),
    timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Twilio error ${res.status}`);
  }
}
