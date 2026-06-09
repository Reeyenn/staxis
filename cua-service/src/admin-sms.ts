/**
 * Best-effort SMS nudge to the Staxis admin (Reeyen) when a learning run
 * needs a human — today that's exactly one event: the robot is parked on
 * a 2FA screen waiting for a one-time code that gets texted to the
 * admin's personal phone. The nudge tells him to open Launch Bay and
 * type the code into the hotel's panel.
 *
 * Deliberately tiny: raw Twilio REST (no SDK dependency), fire-and-forget,
 * and a hard no-op unless ALL FOUR env vars are present
 * (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
 * ADMIN_ALERT_PHONE). A missing secret must never break a mapping run —
 * the Okta/PMS code text already lands on the admin's phone, so this
 * nudge is a convenience, not the only signal.
 *
 * Callers must rate-limit themselves (the mapper sends at most one nudge
 * per MFA pause, and MFA pauses are capped per login).
 */

import { env } from './env.js';
import { log } from './log.js';

const TWILIO_TIMEOUT_MS = 10_000;

export function adminSmsConfigured(): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_FROM_NUMBER &&
    env.ADMIN_ALERT_PHONE,
  );
}

/**
 * Send `body` to the admin's phone. Never throws; resolves false on any
 * failure (unconfigured, network, Twilio 4xx/5xx).
 */
export async function sendAdminSms(body: string): Promise<boolean> {
  if (!adminSmsConfigured()) {
    log.info('admin-sms: not configured — skipping nudge');
    return false;
  }
  const sid = env.TWILIO_ACCOUNT_SID as string;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: env.ADMIN_ALERT_PHONE as string,
        From: env.TWILIO_FROM_NUMBER as string,
        Body: body,
      }).toString(),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('admin-sms: twilio rejected the nudge', { status: res.status, body: text.slice(0, 200) });
      return false;
    }
    log.info('admin-sms: nudge sent');
    return true;
  } catch (err) {
    log.warn('admin-sms: nudge failed', { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
