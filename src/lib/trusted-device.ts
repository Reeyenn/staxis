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

// Trust is intended to be effectively permanent: once a device is trusted,
// it stays trusted as long as the user keeps using it. We can't literally
// store "forever" anywhere — Chrome caps cookies at 400 days, and DBs need
// some bound — so we use:
//   - DB expires_at  =  10 years from issue (effectively never)
//   - Cookie maxAge  =  400 days (Chrome's maximum)
//   - check-trust re-issues the cookie on every successful sign-in, so an
//     active user's cookie window keeps rolling forward and they never get
//     re-prompted for OTP.
// A device only loses trust if the user doesn't sign in for 400+ days
// straight, OR they manually revoke it.
export const TRUST_DURATION_DB_DAYS = 365 * 10;          // 10 years
export const TRUST_DURATION_DB_MS = TRUST_DURATION_DB_DAYS * 24 * 60 * 60 * 1000;
export const TRUST_COOKIE_MAX_AGE_DAYS = 400;            // browser cap

// Legacy alias kept so any other importers don't break. New code should
// pick one of the two above based on whether it's writing the DB or the
// cookie.
export const TRUST_DURATION_DAYS = TRUST_COOKIE_MAX_AGE_DAYS;
export const TRUST_DURATION_MS = TRUST_DURATION_DB_MS;

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
    maxAge: TRUST_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60,
  };
}
