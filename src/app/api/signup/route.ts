/**
 * POST /api/signup — DISABLED
 *
 * Public self-signup was removed in the Phase 1 auth revamp. Account creation
 * now flows exclusively through:
 *   - Admin creates accounts at /settings/accounts (admin-only)
 *   - Phase 3 will add owner-issued email invites and hotel join codes
 *
 * This stub stays in place so the route still exists and returns a clean 410
 * instead of triggering Next's default 404 handler (which is less informative
 * for any old client that still POSTs here).
 */

import { NextRequest } from 'next/server';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  return err(
    'Public signup is disabled. Contact an admin for an invite or join code.',
    { requestId, status: 410, code: ApiErrorCode.Unauthorized },
  );
}
