import { NextRequest } from 'next/server';
// @audit: tenant-scope-not-applicable — public OTP endpoint; the service-role RPC atomically validates the hashed account-bound challenge and enforces TTL/attempt/single-use constraints.
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { clientIpRateLimitKey } from '@/lib/api-ratelimit';
import {
  derivePhonePairingCompletionToken,
  digestPhonePairingOtp,
  hashPhonePairingToken,
  isPhonePairingCode,
  isPhonePairingToken,
  PHONE_PAIRING_NO_STORE_HEADERS,
} from '@/lib/phone-pairing';
import {
  enforcePhonePairingRateLimit,
  phonePairingPublicFailure,
} from '@/lib/phone-pairing-route';
import type { VerifyPhonePairingResponse } from '@/lib/phone-pairing-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface VerifyRpcRow {
  verified?: unknown;
  supabase_hashed_token?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const rateResponse = await enforcePhonePairingRateLimit(
    'auth-phone-pairing-verify',
    clientIpRateLimitKey(req),
    requestId,
  );
  if (rateResponse) return rateResponse;

  const body = await req.json().catch(() => null) as {
    challengeToken?: unknown;
    code?: unknown;
  } | null;
  if (
    !body ||
    !isPhonePairingToken(body.challengeToken) ||
    !isPhonePairingCode(body.code)
  ) {
    return phonePairingPublicFailure(requestId);
  }

  // Stable for this exact challenge/code so a lost HTTP response can recover
  // the same short-lived grant without rotating or extending it.
  const completionToken = derivePhonePairingCompletionToken(
    body.challengeToken,
    body.code,
  );
  const { data, error } = await supabaseAdmin.rpc('staxis_verify_phone_pairing', {
    p_challenge_token_hash: hashPhonePairingToken(body.challengeToken),
    p_otp_digest: digestPhonePairingOtp(body.challengeToken, body.code),
    p_completion_token_hash: hashPhonePairingToken(completionToken),
  });
  if (error) return phonePairingPublicFailure(requestId, 503);

  const first = Array.isArray(data) ? data[0] : data;
  const result = first && typeof first === 'object' ? first as VerifyRpcRow : null;
  if (result?.verified !== true || typeof result.supabase_hashed_token !== 'string') {
    return phonePairingPublicFailure(requestId);
  }

  const payload: VerifyPhonePairingResponse = {
    hashedToken: result.supabase_hashed_token,
    completionToken,
  };
  return ok(
    payload,
    { requestId, headers: PHONE_PAIRING_NO_STORE_HEADERS },
  );
}
