import crypto from 'crypto';
import { NextRequest } from 'next/server';

/**
 * Verify a Twilio request signature.
 *
 * Twilio computes HMAC-SHA1(authToken, url + sorted-params-concatenated) and
 * sends it in `X-Twilio-Signature`. Validating it is the only way to be sure
 * the inbound webhook is actually from Twilio rather than a forged request
 * from someone who guessed the public URL — without it, `From` can be
 * spoofed to trigger language flips and outbound SMS billed to the account.
 *
 * The URL must be the *external* URL Twilio targeted, not Next's internal
 * route — when behind Vercel's edge / a proxy, that means honoring
 * `x-forwarded-proto` and `x-forwarded-host`. We rebuild the URL from those
 * headers (with safe fallbacks) so signatures match in production.
 *
 * Returns true if the signature is missing AND no auth token is configured
 * (dev-mode bootstrap), false otherwise. In production a missing token
 * means we refuse the request — silently accepting forgeries is worse than
 * failing closed.
 */
export async function verifyTwilioSignature(req: NextRequest, rawBody: string): Promise<boolean> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers.get('x-twilio-signature');

  if (!authToken) {
    // No token configured — accept only outside production so local dev
    // can still POST to /api/sms-reply. Production must have it set.
    return process.env.NODE_ENV !== 'production';
  }
  if (!signature) return false;

  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  const url = new URL(req.url);
  const externalUrl = `${proto}://${host}${url.pathname}${url.search}`;

  // Twilio form-encodes inbound webhooks. Build the canonical string by
  // sorting param names alphabetically and concatenating key+value.
  const params = new URLSearchParams(rawBody);
  const sortedKeys = Array.from(params.keys()).sort();
  let canonical = externalUrl;
  for (const key of sortedKeys) {
    canonical += key + (params.get(key) ?? '');
  }

  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(canonical, 'utf-8'))
    .digest('base64');

  // Constant-time comparison to avoid timing-attack leaks of the signature.
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}
