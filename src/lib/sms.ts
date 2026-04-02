/**
 * Shared SMS utility — Textbelt REST API
 *
 * Reads credentials from env:
 *   TEXTBELT_API_KEY   (get from textbelt.com — top up at textbelt.com/purchase)
 *   NEXT_PUBLIC_APP_URL  (optional, defaults to https://hotelops-ai.vercel.app)
 *
 * NOTE: Twilio is configured but blocked by A2P 10DLC carrier filtering (Error 30034).
 * Twilio will be re-enabled once A2P Brand + Campaign registration is approved.
 * To complete Twilio A2P registration:
 *   1. Go to console.twilio.com → Messaging → Regulatory Compliance → Onboarding
 *   2. Fill in real EIN and select Business Type (Sole Proprietor if no EIN)
 *   3. Submit Brand (~1-3 days approval), then register Campaign (~5-7 days)
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://hotelops-ai.vercel.app';

export async function sendSms(to: string, message: string): Promise<void> {
  const apiKey = process.env.TEXTBELT_API_KEY;

  if (!apiKey) {
    throw new Error('TEXTBELT_API_KEY env var missing');
  }

  const body = new URLSearchParams({
    phone: to,
    message,
    key: apiKey,
    replyWebhookUrl: `${APP_URL}/api/sms-reply`,
  });

  const res = await fetch('https://textbelt.com/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Textbelt HTTP error ${res.status}`);
  }

  const data = await res.json() as { success: boolean; error?: string; quotaRemaining?: number };

  if (!data.success) {
    throw new Error(`Textbelt error: ${data.error ?? 'unknown'}`);
  }
}

// ── Twilio implementation (re-enable once A2P 10DLC is approved) ────────────
// export async function sendSms(to: string, message: string): Promise<void> {
//   const accountSid = process.env.TWILIO_ACCOUNT_SID;
//   const authToken  = process.env.TWILIO_AUTH_TOKEN;
//   const from       = process.env.TWILIO_PHONE_NUMBER;
//
//   if (!accountSid || !authToken || !from) {
//     throw new Error('Twilio env vars missing');
//   }
//
//   const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
//   const body = new URLSearchParams({ To: to, From: from, Body: message });
//
//   const res = await fetch(url, {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/x-www-form-urlencoded',
//       'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
//     },
//     body: body.toString(),
//   });
//
//   if (!res.ok) {
//     const err = await res.json() as { message?: string };
//     throw new Error(err.message ?? `Twilio error ${res.status}`);
//   }
// }
