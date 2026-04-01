/**
 * Shared SMS utility — Twilio REST API (no SDK dependency)
 *
 * Reads credentials from env:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER   (E.164, e.g. +12816669887)
 */

export async function sendSms(to: string, message: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !from) {
    throw new Error('Missing Twilio env vars (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER)');
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
      body: new URLSearchParams({ To: to, From: from, Body: message }).toString(),
    },
  );

  if (!res.ok) {
    const err = await res.json() as { message?: string; code?: number };
    throw new Error(`Twilio error ${err.code ?? res.status}: ${err.message ?? 'send failed'}`);
  }
}
