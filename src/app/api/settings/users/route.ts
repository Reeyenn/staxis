/**
 * Compatibility boundary for retired Settings user management.
 *
 * Customer people, access, and legacy ownership handoff now live exclusively
 * in My Hotel. Stale clients receive one deterministic non-mutating response
 * with the canonical destination; this route never reaches an account RPC.
 */

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DESTINATION = '/company?tab=access';

async function moved(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  return err('User and ownership management moved to My Hotel > Access.', {
    requestId,
    status: 409,
    code: ApiErrorCode.IdempotencyConflict,
    details: { href: DESTINATION },
    headers: {
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      Link: `<${DESTINATION}>; rel="alternate"`,
    },
  });
}

export const GET = moved;
export const PUT = moved;
export const POST = moved;
export const PATCH = moved;
export const DELETE = moved;
