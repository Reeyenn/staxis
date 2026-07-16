import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { PhonePairingStatus } from '@/lib/phone-pairing-contract';

export const PHONE_PAIRING_TTL_MS = 60_000;
export const PHONE_PAIRING_RESEND_COOLDOWN_SECONDS = 10;
export const PHONE_PAIRING_MAX_SENDS = 3;
export const PHONE_PAIRING_MAX_ATTEMPTS = 5;

export const PHONE_PAIRING_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
} as const;

const RAW_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Random 256-bit browser capability, encoded for fragment/JSON transport. */
export function generatePhonePairingToken(): string {
  return randomBytes(32).toString('hex');
}

/** Persist only this digest; raw pairing capabilities never enter the DB. */
export function hashPhonePairingToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * A six-digit code has too little entropy for an unkeyed database hash.
 * Keying the digest with the 256-bit raw challenge token means a DB read alone
 * cannot enumerate the code, while requiring no long-lived server secret.
 */
export function digestPhonePairingOtp(challengeToken: string, code: string): string {
  return createHmac('sha256', challengeToken).update(code).digest('hex');
}

/**
 * Stable server-only exchange target for one QR capability. This makes a lost
 * claim response recoverable without allowing browser JS to derive or rotate
 * the challenge on its own.
 */
export function derivePhonePairingChallengeToken(
  pairingToken: string,
  serverSecret: string,
): string {
  return createHmac('sha256', serverSecret)
    .update('staxis-phone-pairing-challenge-v1\0')
    .update(pairingToken)
    .digest('hex');
}

/**
 * Stable retry grant for one verified challenge/code pair. Determinism lets a
 * lost verify response recover the same grant; the 256-bit challenge keeps it
 * unguessable, and the database still stores only its SHA-256 digest.
 */
export function derivePhonePairingCompletionToken(
  challengeToken: string,
  code: string,
): string {
  return createHmac('sha256', challengeToken)
    .update('staxis-phone-pairing-completion-v1\0')
    .update(code)
    .digest('hex');
}

/**
 * Deterministic six-digit stand-in for the emailed code, used ONLY while the
 * global human-2FA switch (migration 0310) is OFF. The claim route stores its
 * digest through the normal store/finalize state machine (no email is sent)
 * and returns the code in the claim response, so the phone client can drive
 * the unchanged verify → session → complete sequence without human input.
 *
 * Determinism (HMAC over the challenge token, keyed by the service-role key)
 * lets an exact claim replay after a lost HTTP response recover the same
 * code. This code is NOT a proof-of-email-ownership factor in bypass mode —
 * it rides the same TLS response as the challenge token — which is precisely
 * the semantic of the switch being off. The verify endpoint still requires
 * the 256-bit challenge token alongside it and still enforces the TTL and
 * five-attempt caps.
 */
export function derivePhonePairingBypassCode(
  challengeToken: string,
  serverSecret: string,
): string {
  const digest = createHmac('sha256', serverSecret)
    .update('staxis-phone-pairing-bypass-code-v1\0')
    .update(challengeToken)
    .digest('hex');
  // 48 bits → mod 10^6: uniform enough for a non-secret bypass code.
  const n = parseInt(digest.slice(0, 12), 16) % 1_000_000;
  return String(n).padStart(6, '0');
}

/**
 * Stable cookie material for an idempotent completion retry. The existing
 * service-role key keeps this long-lived HttpOnly credential impossible to
 * derive from the short-lived completion token exposed to browser JS. It is
 * domain-separated and persisted only as the normal trusted-device digest.
 */
export function derivePhonePairingDeviceToken(
  completionToken: string,
  serverSecret: string,
): string {
  return createHmac('sha256', serverSecret)
    .update('staxis-phone-pairing-device-v1\0')
    .update(completionToken)
    .digest('hex');
}

export function isPhonePairingToken(value: unknown): value is string {
  return typeof value === 'string' && RAW_TOKEN_PATTERN.test(value);
}

export function isPhonePairingCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Read session_id only after api-auth has verified the bearer JWT. This helper
 * does not itself establish a security boundary.
 */
export function decodeVerifiedJwtSessionId(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as {
      session_id?: unknown;
    };
    return isUuid(parsed.session_id) ? parsed.session_id : null;
  } catch {
    return null;
  }
}

export interface PhonePairingStatusRow {
  pair_expires_at: string;
  challenge_expires_at: string | null;
  completion_expires_at: string | null;
  claimed_at: string | null;
  otp_verified_at: string | null;
  completed_at: string | null;
  revoked_at: string | null;
}

export function resolvePhonePairingStatus(
  row: PhonePairingStatusRow,
  nowMs = Date.now(),
): { status: PhonePairingStatus; expiresAt: string } {
  if (row.completed_at) {
    return {
      status: 'completed',
      expiresAt: row.completion_expires_at ?? row.completed_at,
    };
  }

  const activeExpiry = row.otp_verified_at
    ? row.completion_expires_at
    : row.claimed_at
      ? row.challenge_expires_at
      : row.pair_expires_at;
  const expiresAt = activeExpiry ?? row.pair_expires_at;

  if (row.revoked_at || new Date(expiresAt).getTime() <= nowMs) {
    return { status: 'expired', expiresAt };
  }
  if (row.otp_verified_at) return { status: 'verified', expiresAt };
  if (row.claimed_at) return { status: 'code_sent', expiresAt };
  return { status: 'pending', expiresAt };
}
