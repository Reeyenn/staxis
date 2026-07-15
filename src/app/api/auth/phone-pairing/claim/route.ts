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
  issuePhonePairingCode,
  parsePhonePairingReservation,
} from '@/lib/phone-pairing-server';
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

  let expiresAt = reservation.challengeExpiresAt;
  if (reservation.newlyClaimed) {
    // Only the compare-and-swap winner sends. An exact QR retry recovers the
    // same challenge after a lost response without producing a second email.
    // If setup/delivery fails, still return the challenge so explicit resend
    // can recover without making the already-consumed QR a dead end.
    const issued = await issuePhonePairingCode(reservation, challengeToken);
    if (issued.ok) expiresAt = issued.expiresAt;
  }

  // Even if the provider did not accept the first email, the valid challenge
  // lets the phone use the explicit resend route instead of losing the QR.
  const payload: ClaimPhonePairingResponse = {
    challengeToken,
    expiresAt,
  };
  return ok(
    payload,
    { requestId, headers: PHONE_PAIRING_NO_STORE_HEADERS },
  );
}
