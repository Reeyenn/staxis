/**
 * POST /api/admin/mapper/takeover-action
 *
 * Plan v8 Phase B chunk 2 — STUB for v1.
 *
 * Takeover mode lets the admin drive the PMS browser directly when the
 * agent gets stuck. Each admin click on the screenshot becomes a
 * `{kind: 'click_at', x, y}` step in the recipe; each keystroke becomes
 * a `{kind: 'type_text', value}` step.
 *
 * The FULL takeover flow (Plan v8 P0-4) requires:
 *  - direct CDP WebSocket from admin browser to Fly machine
 *  - scroll-lock during takeover
 *  - stale-region hash detection (refuse clicks if page state diverged)
 *  - 1:1 pixel render in the admin UI
 *  - iframe limitation banner
 *
 * v1 ships this endpoint as a STUB that returns 501 Not Implemented.
 * The mapper's `maybeAskAdminBeforeUnavailable` already handles the
 * `actionType: 'takeover'` response from the admin's `mapper/assist`
 * call by treating it as 'mark_unavailable' with a clear reason (see
 * cua-service/src/mapper.ts and human-assist.ts). So admin can SEND
 * action=takeover today and the run cleanly marks the target unavailable
 * — they can't yet step in and click.
 *
 * Real takeover implementation lands in a Phase B follow-up alongside
 * the CDP infrastructure.
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
    'Takeover mode not yet implemented. Use action=guidance or action=unavailable on /api/admin/mapper/assist instead.',
    { requestId, status: 501, code: 'not_implemented' },
  );
}
