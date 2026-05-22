/**
 * Svix-style webhook signature verification for /api/resend-webhook.
 *
 * Comms-voice audit follow-up (2026-05-22). Extracted from the route so the
 * signature math can be unit-tested without standing up a Next request.
 *
 * Resend (via Svix) signs every webhook with HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}` using the bytes obtained by
 * base64-decoding everything after the `whsec_` prefix of the configured
 * secret. The `svix-signature` header is one or more space-separated
 * `v1,<base64sig>` tokens — any one matching means the request is valid.
 *
 * We also require the `svix-timestamp` to be within ±5 minutes of the
 * server clock so a captured webhook body can't be replayed later.
 */

import crypto from 'node:crypto';

export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason:
      | 'missing_svix_headers'
      | 'invalid_timestamp'
      | 'timestamp_out_of_tolerance'
      | 'invalid_secret_format'
      | 'signature_mismatch';
    };

export function verifySvixSignature(
  rawBody: string,
  svixId: string | null,
  svixTimestamp: string | null,
  svixSignatureHeader: string | null,
  secret: string,
  nowMs: number = Date.now(),
): VerifyResult {
  if (!svixId || !svixTimestamp || !svixSignatureHeader) {
    return { ok: false, reason: 'missing_svix_headers' };
  }
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(rawSecret, 'base64');
    if (secretBytes.length === 0) {
      return { ok: false, reason: 'invalid_secret_format' };
    }
  } catch {
    return { ok: false, reason: 'invalid_secret_format' };
  }

  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', secretBytes)
    .update(signedPayload)
    .digest('base64');

  const tokens = svixSignatureHeader.split(' ');
  for (const tok of tokens) {
    const commaIdx = tok.indexOf(',');
    if (commaIdx < 0) continue;
    const version = tok.slice(0, commaIdx);
    const sig = tok.slice(commaIdx + 1);
    if (version !== 'v1') continue;
    if (sig.length !== expectedSignature.length) continue;
    if (
      crypto.timingSafeEqual(
        Buffer.from(sig, 'utf8'),
        Buffer.from(expectedSignature, 'utf8'),
      )
    ) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/**
 * Build a Svix-style signature header for the given payload + secret.
 * Used only by tests; mirrored on the verification side above.
 */
export function buildSvixSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  secret: string,
): string {
  const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(rawSecret, 'base64');
  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto
    .createHmac('sha256', secretBytes)
    .update(signedPayload)
    .digest('base64');
  return `v1,${sig}`;
}
