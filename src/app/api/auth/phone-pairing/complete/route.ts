import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { env } from '@/lib/env';
import {
  clientIpRateLimitKey,
  hashToRateLimitKey,
  trustedClientIp,
} from '@/lib/api-ratelimit';
import {
  decodeVerifiedJwtSessionId,
  derivePhonePairingDeviceToken,
  hashPhonePairingToken,
  isPhonePairingToken,
  PHONE_PAIRING_NO_STORE_HEADERS,
} from '@/lib/phone-pairing';
import {
  enforcePhonePairingRateLimit,
  phonePairingPublicFailure,
  phonePairingUnauthorized,
} from '@/lib/phone-pairing-route';
import {
  hashDeviceToken,
  trustCookieOptions,
  TRUST_DURATION_DB_MS,
} from '@/lib/trusted-device';
import type { CompletePhonePairingResponse } from '@/lib/phone-pairing-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const ipRateResponse = await enforcePhonePairingRateLimit(
    'auth-phone-pairing-complete',
    clientIpRateLimitKey(req),
    requestId,
  );
  if (ipRateResponse) return ipRateResponse;

  const body = await req.json().catch(() => null) as { completionToken?: unknown } | null;
  if (!body || !isPhonePairingToken(body.completionToken)) {
    return phonePairingPublicFailure(requestId);
  }

  // This fresh OTP session cannot yet pass the normal trusted-device gate.
  // The completion RPC below is the replacement proof and binds the grant to
  // the exact auth.sessions row in this already-verified bearer token.
  const session = await requireSession(req, { enforce2FA: false, requestId });
  if (!session.ok) return phonePairingUnauthorized(requestId);

  const accountRateResponse = await enforcePhonePairingRateLimit(
    'auth-phone-pairing-complete',
    hashToRateLimitKey(`phone-pairing-account:${session.userId}`),
    requestId,
  );
  if (accountRateResponse) return accountRateResponse;

  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(authHeader.trim())?.[1] ?? null;
  const sessionId = bearer ? decodeVerifiedJwtSessionId(bearer) : null;
  if (!sessionId) return phonePairingUnauthorized(requestId);

  // Repeating the exact completion request after a lost response must set the
  // same cookie and match the already-committed trusted_devices row.
  const deviceToken = derivePhonePairingDeviceToken(
    body.completionToken,
    env.SUPABASE_SERVICE_ROLE_KEY,
  );
  const deviceExpiresAt = new Date(Date.now() + TRUST_DURATION_DB_MS).toISOString();
  const { data: completedId, error } = await supabaseAdmin.rpc(
    'staxis_complete_phone_pairing',
    {
      p_completion_token_hash: hashPhonePairingToken(body.completionToken),
      p_user_id: session.userId,
      p_session_id: sessionId,
      p_device_token_hash: hashDeviceToken(deviceToken),
      p_device_expires_at: deviceExpiresAt,
      p_user_agent: req.headers.get('user-agent')?.slice(0, 1000) ?? null,
      p_ip: trustedClientIp(req).slice(0, 128) || null,
    },
  );
  if (error) return phonePairingPublicFailure(requestId, 503);
  if (typeof completedId !== 'string') return phonePairingPublicFailure(requestId);

  const payload: CompletePhonePairingResponse = { success: true };
  const response = ok(
    payload,
    { requestId, headers: PHONE_PAIRING_NO_STORE_HEADERS },
  );
  const cookie = trustCookieOptions(
    req.headers.get('x-forwarded-host') ?? req.headers.get('host'),
  );
  response.cookies.set({
    name: cookie.name,
    value: deviceToken,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: cookie.maxAge,
    ...(cookie.domain ? { domain: cookie.domain } : {}),
  });
  return response;
}
