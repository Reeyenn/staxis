/**
 * POST /api/admin/mapper/takeover-action
 *
 * TOMBSTONE — single-click takeover shipped via /api/admin/mapper/assist
 * (feature/cua-assist-board): action=takeover + responseCoordinate {x, y}.
 * The Learning Board UI sends the founder's click there; the mapper
 * executes it through executeVisionAction (recorded as a recipe step) and
 * continues. Nothing calls THIS route.
 *
 * Kept as a 501 tombstone for the originally-planned FULL takeover session
 * (Plan v8 P0-4: live CDP WebSocket driving, scroll-lock, multi-click +
 * typing). If that ever lands, it lands here; until then, use assist.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) {
    return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });
  }
  return err(
    'Full takeover sessions are not implemented. Single-click takeover is live on /api/admin/mapper/assist (actionType=takeover + responseCoordinate).',
    { requestId, status: 501, code: 'not_implemented' },
  );
}
