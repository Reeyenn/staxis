/**
 * Shared SMS utility - Twilio REST API
 *
 * Reads credentials from env:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER  (use a Toll-Free number, e.g. +18445971608)
 *
 * NOTE: The original local 10DLC number (+12816669887) is blocked by A2P carrier
 * filtering (Error 30034) until A2P Brand + Campaign registration is approved (~2-3 weeks).
 * Using a Toll-Free number bypasses this - unverified toll-free works at low volume
 * (<100 msg/day) with no registration required upfront.
 *
 * Long-term: submit Toll-Free Verification in Twilio console for full throughput.
 */

function sanitizeSmsBody(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
}

export async function sendSms(to: string, message: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !from) {
    throw new Error('Twilio env vars missing (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const sanitizedBody = sanitizeSmsBody(message);
  const body = new URLSearchParams({ To: to, From: from, Body: sanitizedBody });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Twilio error ${res.status}`);
  }
}
