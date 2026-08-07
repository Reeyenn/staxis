import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { logSecurityEvent } from '@/lib/audit';

/**
 * Revoke every second factor an account is holding.
 *
 * WHY THIS EXISTS (auth sweep 2026-08-07).
 *
 * `/api/auth/revoke-trust` already does this for the person themselves: it is
 * fired by sign-out and by the self-service password reset at
 * `/signin/reset`, precisely because F-02 in the original auth plan found that
 * rotating a password was a no-op against a stolen `staxis_device` cookie (the
 * DB row is good for ten years, the cookie rolls forward for 400 days).
 *
 * The two paths where somebody ELSE resets the password never got the same
 * treatment:
 *
 *   - `PUT /api/auth/team`     — a manager resetting a staff member's password
 *                                from My Hotel -> People.
 *   - `PUT /api/auth/accounts` — a platform admin resetting any password.
 *
 * Both are the lever a hotel reaches for when a phone is lost or somebody is
 * let go, and both left the target's trusted devices and per-session MFA
 * verifications intact. Whoever holds that browser keeps the second factor
 * they already earned, so the reset only takes away one of the two things
 * standing between them and the hotel's data.
 *
 * Deliberately best-effort at the call site: the password has ALREADY been
 * rotated in Supabase Auth by the time this runs, and failing the whole
 * request afterwards would tell the manager the reset did not happen when it
 * did. A failure is logged loudly and recorded as a security event so it is
 * visible rather than silent, and the caller decides whether to surface it.
 */
export interface DeviceTrustRevocation {
  ok: boolean;
  trustedDevicesDeleted: number;
  mfaSessionsDeleted: number;
}

export async function revokeAllDeviceTrustForAccount(input: {
  accountId: string;
  /** auth.users id. `mfa_verified_sessions` is keyed by user, not account. */
  authUserId: string;
  /** What caused the revocation, for the security event. */
  reason: 'manager_password_reset' | 'admin_password_reset' | 'admin_email_change';
  actorUserId?: string | null;
  requestId?: string | null;
}): Promise<DeviceTrustRevocation> {
  const { accountId, authUserId, reason, actorUserId, requestId } = input;
  let ok = true;

  const { error: deviceError, count: trustedDevicesDeleted } = await supabaseAdmin
    .from('trusted_devices')
    .delete({ count: 'exact' })
    .eq('account_id', accountId);
  if (deviceError) {
    ok = false;
    log.error('[revoke-device-trust] trusted_devices delete failed', {
      requestId: requestId ?? undefined, accountId, reason, err: deviceError.message,
    });
  }

  const { error: mfaError, count: mfaSessionsDeleted } = await supabaseAdmin
    .from('mfa_verified_sessions')
    .delete({ count: 'exact' })
    .eq('user_id', authUserId);
  if (mfaError) {
    ok = false;
    log.error('[revoke-device-trust] mfa_verified_sessions delete failed', {
      requestId: requestId ?? undefined, authUserId, reason, err: mfaError.message,
    });
  }

  await logSecurityEvent({
    action: ok ? 'auth.trust_revoked' : 'auth.trust_revoke_failed',
    userId: actorUserId ?? undefined,
    requestId: requestId ?? undefined,
    metadata: {
      accountId,
      targetAuthUserId: authUserId,
      source: reason,
      deletedCount: trustedDevicesDeleted ?? 0,
      mfaSessionsDeletedCount: mfaSessionsDeleted ?? 0,
    },
  });

  return {
    ok,
    trustedDevicesDeleted: trustedDevicesDeleted ?? 0,
    mfaSessionsDeleted: mfaSessionsDeleted ?? 0,
  };
}
