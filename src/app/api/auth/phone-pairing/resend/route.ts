import { NextRequest } from 'next/server';
// @audit: tenant-scope-not-applicable — public challenge-capability endpoint; the service-role RPC validates the hashed account-bound grant, TTL, cooldown, and send cap.
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { clientIpRateLimitKey } from '@/lib/api-ratelimit';
import {
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
import type { ResendPhonePairingResponse } from '@/lib/phone-pairing-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const rateResponse = await enforcePhonePairingRateLimit(
    'auth-phone-pairing-resend',
    clientIpRateLimitKey(req),
    requestId,
  );
  if (rateResponse) return rateResponse;

  const body = await req.json().catch(() => null) as { challengeToken?: unknown } | null;
  if (!body || !isPhonePairingToken(body.challengeToken)) {
    return phonePairingPublicFailure(requestId);
  }

  const { data, error } = await supabaseAdmin.rpc(
    'staxis_reserve_phone_pairing_resend',
    { p_challenge_token_hash: hashPhonePairingToken(body.challengeToken) },
  );
  if (error) return phonePairingPublicFailure(requestId, 503);

  const reservation = parsePhonePairingReservation(data);
  if (!reservation) return phonePairingPublicFailure(requestId);

  const issued = await issuePhonePairingCode(reservation, body.challengeToken);
  if (!issued.ok || !issued.emailSent) {
    return phonePairingPublicFailure(requestId, 503);
  }

  const payload: ResendPhonePairingResponse = {
    expiresAt: issued.expiresAt,
  };
  return ok(
    payload,
    { requestId, headers: PHONE_PAIRING_NO_STORE_HEADERS },
  );
}
