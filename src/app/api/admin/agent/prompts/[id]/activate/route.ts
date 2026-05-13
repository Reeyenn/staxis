// ─── Admin API: activate a prompt version ────────────────────────────────
// POST /api/admin/agent/prompts/[id]/activate
//
// Round-10 F5 (2026-05-13): swapped two-update flow for a single-RPC
// flow. The old path ran deactivate-others + activate-this as two
// separate supabase-js calls; for the ~50-200ms between them, ZERO
// rows were active for that role. A concurrent chat request landing
// on a cache-cold instance read empty + fell through to fallback
// constants — so an operator-triggered activate temporarily made
// users see the OLD code-baked prompt. staxis_activate_prompt runs
// both UPDATEs inside one transaction; READ COMMITTED readers see
// only BEFORE or only AFTER, never the in-between zero-active state.
//
// Cache invalidated immediately on this instance; other Vercel
// instances pick up within 30s TTL (acceptable per L2 design).

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { invalidatePromptsCache } from '@/lib/agent/prompts-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!id) return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  // Look up the row we're activating so we know its role.
  const { data: target, error: targetErr } = await supabaseAdmin
    .from('agent_prompts')
    .select('id, role')
    .eq('id', id)
    .maybeSingle();

  if (targetErr || !target) {
    return err('prompt not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Atomic activate — see header for rationale.
  const { error: rpcErr } = await supabaseAdmin.rpc('staxis_activate_prompt', {
    p_id: id,
    p_role: (target as { role: string }).role,
  });

  if (rpcErr) {
    return err(`failed to activate: ${rpcErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  invalidatePromptsCache();

  return ok({ id, role: (target as { role: string }).role }, { requestId });
}
