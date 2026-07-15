import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { env } from '@/lib/env';
import { trustedClientIp, hashToRateLimitKey } from '@/lib/api-ratelimit';
import {
  generatePhonePairingToken,
  hashPhonePairingToken,
  PHONE_PAIRING_NO_STORE_HEADERS,
  PHONE_PAIRING_TTL_MS,
} from '@/lib/phone-pairing';
import {
  enforcePhonePairingRateLimit,
  phonePairingUnauthorized,
} from '@/lib/phone-pairing-route';
import type { CreatePhonePairingResponse } from '@/lib/phone-pairing-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return phonePairingUnauthorized(requestId);

  const accountScope = hashToRateLimitKey(`phone-pairing-account:${session.userId}`);
  const rateResponse = await enforcePhonePairingRateLimit(
    'auth-phone-pairing-create',
    accountScope,
    requestId,
  );
  if (rateResponse) return rateResponse;

  const { data: account, error: accountError } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (accountError || !account) {
    return err('Account not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
      headers: PHONE_PAIRING_NO_STORE_HEADERS,
    });
  }

  // Best-effort, bounded retention sweep. The RPC is service-role-only,
  // account-scoped, and removes at most 100 rows whose latest expiry or
  // terminal timestamp is more than 24 hours old.
  const { error: cleanupError } = await supabaseAdmin.rpc(
    'staxis_cleanup_phone_pairings',
    { p_account_id: account.id },
  );
  if (cleanupError) {
    log.warn('[phone-pairing] bounded cleanup failed', {
      requestId,
      code: cleanupError.code,
    });
  }

  const rawToken = generatePhonePairingToken();
  const expiresAt = new Date(Date.now() + PHONE_PAIRING_TTL_MS).toISOString();
  const { data: pairing, error: insertError } = await supabaseAdmin
    .from('phone_pairings')
    .insert({
      account_id: account.id,
      auth_user_id: session.userId,
      pairing_token_hash: hashPhonePairingToken(rawToken),
      pair_expires_at: expiresAt,
      desktop_user_agent: req.headers.get('user-agent')?.slice(0, 1000) ?? null,
      desktop_ip: trustedClientIp(req).slice(0, 128) || null,
    })
    .select('id')
    .single();
  if (insertError || !pairing) {
    log.error('[phone-pairing] create failed', {
      requestId,
      code: insertError?.code ?? null,
    });
    return err('Could not create phone sign-in', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: PHONE_PAIRING_NO_STORE_HEADERS,
    });
  }

  const origin = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  const pairUrl = `${origin}/phone-signin-entry.html#pair=${encodeURIComponent(rawToken)}`;
  const payload: CreatePhonePairingResponse = {
    pairingId: pairing.id,
    pairUrl,
    expiresAt,
  };
  return ok(
    payload,
    { requestId, headers: PHONE_PAIRING_NO_STORE_HEADERS },
  );
}
