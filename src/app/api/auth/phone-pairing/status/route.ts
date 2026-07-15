import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import {
  isUuid,
  resolvePhonePairingStatus,
  PHONE_PAIRING_NO_STORE_HEADERS,
} from '@/lib/phone-pairing';
import { phonePairingUnauthorized } from '@/lib/phone-pairing-route';
import type { PhonePairingStatusResponse } from '@/lib/phone-pairing-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return phonePairingUnauthorized(requestId);

  const pairingId = new URL(req.url).searchParams.get('id');
  if (!isUuid(pairingId)) {
    return err('id must be a UUID', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: PHONE_PAIRING_NO_STORE_HEADERS,
    });
  }

  const { data: row, error } = await supabaseAdmin
    .from('phone_pairings')
    .select(
      'pair_expires_at, challenge_expires_at, completion_expires_at, claimed_at, otp_verified_at, completed_at, revoked_at',
    )
    .eq('id', pairingId)
    .eq('auth_user_id', session.userId)
    .maybeSingle();
  if (error) {
    return err('Could not load phone sign-in status', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: PHONE_PAIRING_NO_STORE_HEADERS,
    });
  }
  if (!row) {
    return err('Phone sign-in not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
      headers: PHONE_PAIRING_NO_STORE_HEADERS,
    });
  }

  const payload: PhonePairingStatusResponse = resolvePhonePairingStatus(row);
  return ok(payload, {
    requestId,
    headers: PHONE_PAIRING_NO_STORE_HEADERS,
  });
}
