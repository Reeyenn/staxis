// ─── GET /api/agent/portfolio/conversations ───────────────────────────────
// Dedicated portfolio history list. It never shares the property conversation
// endpoint because a portfolio row's property_id is only a relational anchor.

import type { NextRequest } from 'next/server';

import { listPortfolioConversationsForAuthorization } from '@/lib/agent/memory';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';

import {
  authorizePortfolioConversationRequest,
  samePortfolioConversationAuthorization,
} from './_authorization';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie, Authorization',
} as const;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const organizationId = new URL(req.url).searchParams.get('organizationId') ?? '';
  if (!UUID_RX.test(organizationId)) {
    return err('portfolio conversations not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }

  const initial = await authorizePortfolioConversationRequest(req, organizationId);
  if (!initial.ok) {
    if (initial.reason === 'session_response') return initial.response;
    return err(
      initial.reason === 'unavailable'
        ? 'portfolio authorization is temporarily unavailable'
        : 'portfolio conversations not found',
      {
        requestId,
        status: initial.reason === 'unavailable' ? 503 : 404,
        code: initial.reason === 'unavailable'
          ? ApiErrorCode.UpstreamFailure
          : ApiErrorCode.NotFound,
        headers: PRIVATE_NO_STORE_HEADERS,
      },
    );
  }

  try {
    const conversations = await listPortfolioConversationsForAuthorization({
      userAccountId: initial.accountId,
      organizationId,
      authorizationHash: initial.receipt.authorizationHash,
      policyFingerprint: initial.policyFingerprint,
      limit: 30,
    });

    // Authorization is the final awaited data dependency before browser
    // egress. Revocation, transfer, or role removal during the list query makes
    // the entire response unusable instead of returning a stale partial list.
    const current = await authorizePortfolioConversationRequest(req, organizationId);
    if (!current.ok || !samePortfolioConversationAuthorization(initial, current)) {
      return err('portfolio scope changed while conversations were loading', {
        requestId,
        status: current.ok || current.reason !== 'unavailable' ? 409 : 503,
        code: current.ok || current.reason !== 'unavailable'
          ? 'scope_changed'
          : ApiErrorCode.UpstreamFailure,
        headers: PRIVATE_NO_STORE_HEADERS,
      });
    }
    return ok({ conversations }, { requestId, headers: PRIVATE_NO_STORE_HEADERS });
  } catch (error) {
    log.error('[agent/portfolio/conversations] failed to list', { requestId, error });
    return err('failed to load portfolio conversations', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }
}
