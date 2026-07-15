import { NextRequest } from 'next/server';
// @audit: tenant-scope-not-applicable — public QR-capability exchange; the service-role RPC atomically validates and consumes a hashed 60-second token bound to one account.
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { env } from '@/lib/env';
import { clientIpRateLimitKey, trustedClientIp } from '@/lib/api-ratelimit';
import {
  derivePhonePairingChallengeToken,
  hashPhonePairingToken,
  isPhonePairingToken,
  PHONE_PAIRING_NO_STORE_HEADERS,
} from '@/lib/phone-pairing';
import {
  enforcePhonePairingRateLimit,
  phonePairingPublicFailure,
} from '@/lib/phone-pairing-route';
import {
  issuePhonePairingBypassCode,
  issuePhonePairingCode,
  parsePhonePairingReservation,
  recoverPhonePairingBypassCode,
} from '@/lib/phone-pairing-server';
import { isTwoFactorEnabled } from '@/lib/two-factor';
import type { ClaimPhonePairingResponse } from '@/lib/phone-pairing-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const rateResponse = await enforcePhonePairingRateLimit(
    'auth-phone-pairing-claim',
    clientIpRateLimitKey(req),
    requestId,
  );
  if (rateResponse) return rateResponse;

  const body = await req.json().catch(() => null) as { token?: unknown } | null;
  if (!body || !isPhonePairingToken(body.token)) {
    return phonePairingPublicFailure(requestId);
  }

  const challengeToken = derivePhonePairingChallengeToken(
    body.token,
    env.SUPABASE_SERVICE_ROLE_KEY,
  );
  const { data, error } = await supabaseAdmin.rpc('staxis_claim_phone_pairing', {
    p_pairing_token_hash: hashPhonePairingToken(body.token),
    p_challenge_token_hash: hashPhonePairingToken(challengeToken),
    p_phone_user_agent: req.headers.get('user-agent')?.slice(0, 1000) ?? null,
    p_phone_ip: trustedClientIp(req).slice(0, 128) || null,
  });
  if (error) return phonePairingPublicFailure(requestId, 503);

  const reservation = parsePhonePairingReservation(data);
  if (!reservation) return phonePairingPublicFailure(requestId);

  // Global human-2FA switch (migration 0310). OFF → issue the deterministic
  // bypass code through the same store/finalize state machine WITHOUT
  // emailing, and hand it to the phone so the code screen never appears.
  // Fail-safe: isTwoFactorEnabled() returns true on any error, so the
  // bypass only runs when the flag is provably off; and if the bypass
  // itself fails, we fall back to the normal challenge response (the code
  // screen's explicit "Send a new code" still emails a real code).
  const twoFactorEnabled = await isTwoFactorEnabled();

  let expiresAt = reservation.challengeExpiresAt;
  let bypassCode: string | null = null;
  if (reservation.newlyClaimed) {
    if (!twoFactorEnabled) {
      const issued = await issuePhonePairingBypassCode(reservation, challengeToken);
      if (issued.ok) {
        expiresAt = issued.expiresAt;
        bypassCode = issued.bypassCode;
      }
    } else {
      // Only the compare-and-swap winner sends. An exact QR retry recovers the
      // same challenge after a lost response without producing a second email.
      // If setup/delivery fails, still return the challenge so explicit resend
      // can recover without making the already-consumed QR a dead end.
      const issued = await issuePhonePairingCode(reservation, challengeToken);
      if (issued.ok) expiresAt = issued.expiresAt;
    }
  } else if (!twoFactorEnabled) {
    // Exact QR retry after a lost claim response: recover the same bypass
    // code if (and only if) the finalized digest on the row matches it.
    bypassCode = await recoverPhonePairingBypassCode(reservation, challengeToken);
  }

  // Even if the provider did not accept the first email, the valid challenge
  // lets the phone use the explicit resend route instead of losing the QR.
  const payload: ClaimPhonePairingResponse = {
    challengeToken,
    expiresAt,
    ...(bypassCode ? { bypassCode } : {}),
  };
  return ok(
    payload,
    { requestId, headers: PHONE_PAIRING_NO_STORE_HEADERS },
  );
}
