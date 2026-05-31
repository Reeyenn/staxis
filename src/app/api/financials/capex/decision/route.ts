/**
 * /api/financials/capex/decision — approve / reject / request-revisions on a
 * capital request. Owner/GM/admin only (requireFinanceAccess). Records the
 * decider (approved_by + name + approved_at) and decision notes.
 *
 *   POST { pid, id, action: 'approve'|'reject'|'revisions', notes? }
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import { validateString } from '@/lib/api-validate';
import { decideCapex } from '@/lib/financials/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['approve', 'reject', 'revisions'] as const;

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const idCheck = validateString(body.id, { max: 40, label: 'id' });
  if (idCheck.error || !idCheck.value) return err('id is required', { requestId: gate.requestId, status: 400, code: 'invalid_id' });

  const action = body.action;
  if (action !== 'approve' && action !== 'reject' && action !== 'revisions') {
    return err(`action must be one of: ${ACTIONS.join(', ')}`, { requestId: gate.requestId, status: 400, code: 'invalid_action' });
  }
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) || null : null;

  try {
    const project = await decideCapex(gate.pid, idCheck.value, action, gate.accountId, gate.name, notes);
    if (!project) return err('project not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    return ok({ project }, { requestId: gate.requestId });
  } catch {
    return err('failed to record decision', { requestId: gate.requestId, status: 500, code: 'decision_failed' });
  }
}
