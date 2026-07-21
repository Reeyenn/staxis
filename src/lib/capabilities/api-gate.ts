import type { NextResponse } from 'next/server';
import { ApiErrorCode, err } from '@/lib/api-response';

/** Standard fail-closed response for a capability-override read outage. */
export function capabilityUnavailableResponse(requestId: string): NextResponse {
  return err('Permissions are temporarily unavailable. Please retry.', {
    requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { 'Retry-After': '5' },
  });
}
