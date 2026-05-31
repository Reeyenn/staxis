/**
 * /api/financials/capex/progress — move an approved project's progress.
 * Owner/GM/admin only.
 *
 *   POST { pid, id, status?: 'in_progress'|'completed', pctComplete?: 0..100 }
 *
 * Only approved / in-progress projects should be advanced (the UI surfaces the
 * control only there); the status set is constrained to the two forward states.
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import { validateString, validateInt } from '@/lib/api-validate';
import { updateCapexProgress, getCapexProject } from '@/lib/financials/db';
import type { CapexStatus } from '@/lib/financials/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const idCheck = validateString(body.id, { max: 40, label: 'id' });
  if (idCheck.error || !idCheck.value) return err('id is required', { requestId: gate.requestId, status: 400, code: 'invalid_id' });

  const patch: { status?: CapexStatus; pctComplete?: number } = {};
  if (body.status !== undefined) {
    if (body.status !== 'in_progress' && body.status !== 'completed') {
      return err('status must be in_progress or completed', { requestId: gate.requestId, status: 400, code: 'invalid_status' });
    }
    patch.status = body.status;
  }
  if (body.pctComplete !== undefined) {
    const r = validateInt(body.pctComplete, { min: 0, max: 100, label: 'pctComplete' });
    if (r.error) return err(r.error, { requestId: gate.requestId, status: 400, code: 'invalid_pct' });
    patch.pctComplete = r.value;
    // Completing implies 100%; 100% implies completed (keep them consistent).
    if (patch.status === 'completed') patch.pctComplete = 100;
    else if (r.value === 100 && patch.status === undefined) patch.status = 'completed';
  }
  if (patch.status === 'completed' && patch.pctComplete === undefined) patch.pctComplete = 100;

  if (patch.status === undefined && patch.pctComplete === undefined) {
    return err('nothing to update', { requestId: gate.requestId, status: 400, code: 'no_change' });
  }

  try {
    // State-machine guard (Codex review): a project can only be progressed once
    // it's APPROVED. This stops anyone bypassing the approval step by POSTing a
    // 'requested' project straight to in_progress/completed — keeping the
    // approval audit (approved_by / approved_at via decideCapex) un-bypassable.
    const current = await getCapexProject(gate.pid, idCheck.value);
    if (!current) return err('project not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    if (current.status !== 'approved' && current.status !== 'in_progress') {
      return err('project must be approved before work can be started or completed', {
        requestId: gate.requestId,
        status: 409,
        code: 'invalid_transition',
      });
    }

    const project = await updateCapexProgress(gate.pid, idCheck.value, patch);
    if (!project) return err('project not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    return ok({ project }, { requestId: gate.requestId });
  } catch {
    return err('failed to update progress', { requestId: gate.requestId, status: 500, code: 'progress_failed' });
  }
}
