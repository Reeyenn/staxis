import type { NextResponse } from 'next/server';

import { err, ApiErrorCode } from '@/lib/api-response';
import type { HotelAuthorizationRefusal } from '@/lib/authorization/request';

/**
 * Preserve the AI-status route's refusal contract while its hotel decision is
 * supplied by the shared request authorization facade.
 */
export function inventoryAiAuthorizationRefusalResponse(
  refusal: HotelAuthorizationRefusal,
  requestId: string,
): NextResponse {
  // Section failures carry the existing section-disabled/unavailable response
  // and must reach the caller unchanged.
  if (refusal.reason === 'section_denied') return refusal.response;

  // The former property-access gate collapsed account, authority, and property
  // failures into this exact generic 403 envelope. Keep that wire contract
  // while the facade supplies the authoritative decision.
  return err('forbidden', {
    requestId,
    status: 403,
    code: ApiErrorCode.Forbidden,
  });
}
