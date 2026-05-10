// ─── Trusted-device helpers (Phase 2 2FA) ─────────────────────────────────
// Used by:
//   /api/auth/check-trust    — validates an incoming cookie against the DB
//   /api/auth/trust-device   — issues a new cookie + DB row
// We keep the cookie httpOnly so JS can't read or forge it. The cookie value
// is a random opaque token; only sha256(token) is persisted in
// trusted_devices.token_hash. A leaked cookie alone doesn't grant trust
// without a matching, non-expired row in the DB.

import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';

export const TRUST_COOKIE_NAME = 'staxis_device';
export const TRUST_DURATION_DAYS = 30;
export const TRUST_DURATION_MS = TRUST_DURATION_DAYS * 24 * 60 * 60 * 1000;

export function generateDeviceToken(): string {
  // 32 bytes of entropy = 256 bits, hex-encoded for cookie compatibility.
  return randomBytes(32).toString('hex');
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function readDeviceCookie(req: NextRequest): string | null {
  const c = req.cookies.get(TRUST_COOKIE_NAME);
  return c?.value ?? null;
}

export function trustCookieOptions() {
  return {
    name: TRUST_COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: TRUST_DURATION_DAYS * 24 * 60 * 60,
  };
}
