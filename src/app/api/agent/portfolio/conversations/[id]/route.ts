// ─── GET /api/agent/portfolio/conversations/[id] ──────────────────────────
// Receipt-backed portfolio replay. Every message pair is released only with a
// matching immutable query receipt and a still-current exact company scope.

import type { NextRequest } from 'next/server';

import { loadPortfolioConversationForAuthorization } from '@/lib/agent/memory';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId, log } from '@/lib/log';

import {
  authorizePortfolioConversationRequest,
  samePortfolioConversationAuthorization,
} from '../_authorization';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie, Authorization',
} as const;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const organizationId = new URL(req.url).searchParams.get('organizationId') ?? '';
  // Keep malformed and foreign company selectors on the same anti-enumeration
  // response as a guessed conversation id.
  if (!UUID_RX.test(organizationId)) {
    return err('portfolio conversation not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }
  const idResult = validateUuid((await params).id, 'id');
  if (idResult.error) {
    return err('portfolio conversation not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }
  const conversationId = idResult.value!;

  const initial = await authorizePortfolioConversationRequest(req, organizationId);
  if (!initial.ok) {
    if (initial.reason === 'session_response') return initial.response;
    return err(
      initial.reason === 'unavailable'
        ? 'portfolio authorization is temporarily unavailable'
        : 'portfolio conversation not found',
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
    const loaded = await loadPortfolioConversationForAuthorization({
      conversationId,
      userAccountId: initial.accountId,
      organizationId,
      authorizationHash: initial.receipt.authorizationHash,
      currentAuthorizedPropertyIds: initial.receipt.authorizedPropertyIds,
    });
    if (!loaded.ok) {
      return err(
        loaded.reason === 'scope_changed'
          ? 'portfolio scope changed; start a new conversation'
          : 'portfolio conversation not found',
        {
          requestId,
          status: loaded.reason === 'scope_changed' ? 409 : 404,
          code: loaded.reason === 'scope_changed' ? 'scope_changed' : ApiErrorCode.NotFound,
          headers: PRIVATE_NO_STORE_HEADERS,
        },
      );
    }

    // Last awaited boundary: the response is discarded if the account,
    // company feature, hotel topology, or entitlement universe changed while
    // history/receipt rows were being read.
    const current = await authorizePortfolioConversationRequest(req, organizationId);
    if (!current.ok || !samePortfolioConversationAuthorization(initial, current)) {
      return err('portfolio scope changed while the conversation was loading', {
        requestId,
        status: current.ok || current.reason !== 'unavailable' ? 409 : 503,
        code: current.ok || current.reason !== 'unavailable'
          ? 'scope_changed'
          : ApiErrorCode.UpstreamFailure,
        headers: PRIVATE_NO_STORE_HEADERS,
      });
    }
    return ok(
      { conversation: loaded.conversation, pendingActions: [] },
      { requestId, headers: PRIVATE_NO_STORE_HEADERS },
    );
  } catch (error) {
    log.error('[agent/portfolio/conversations/get] failed to load', {
      requestId,
      conversationId,
      error,
    });
    return err('failed to load portfolio conversation', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }
}
