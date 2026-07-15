import 'server-only';

import type { NextResponse } from 'next/server';
import { err, ApiErrorCode } from '@/lib/api-response';
import {
  checkAndIncrementRateLimit,
  type RateLimitEndpoint,
} from '@/lib/api-ratelimit';
import { PHONE_PAIRING_NO_STORE_HEADERS } from '@/lib/phone-pairing';

export function phonePairingPublicFailure(
  requestId: string,
  status = 400,
): NextResponse {
  return err('This phone sign-in request is invalid or expired.', {
    requestId,
    status,
    code: status >= 500 ? ApiErrorCode.InternalError : ApiErrorCode.Unauthorized,
    headers: PHONE_PAIRING_NO_STORE_HEADERS,
  });
}
export function phonePairingUnauthorized(requestId: string): NextResponse {
  return err('Unauthorized', {
    requestId,
    status: 401,
    code: ApiErrorCode.Unauthorized,
    headers: PHONE_PAIRING_NO_STORE_HEADERS,
  });
}

export async function enforcePhonePairingRateLimit(
  endpoint: RateLimitEndpoint,
  scope: string,
  requestId: string,
): Promise<NextResponse | null> {
  const limited = await checkAndIncrementRateLimit(endpoint, scope);
  if (limited.allowed) return null;
  return err('Too many requests. Please wait and try again.', {
    requestId,
    status: 429,
    code: ApiErrorCode.RateLimited,
    headers: {
      ...PHONE_PAIRING_NO_STORE_HEADERS,
      'Retry-After': String(limited.retryAfterSec),
    },
  });
}
