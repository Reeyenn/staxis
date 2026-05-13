// ─── Admin API: edit a single prompt version ─────────────────────────────
// PATCH /api/admin/agent/prompts/[id]
// Edits content / notes / canary_pct on an existing row. Active rows
// can still be edited but with safeguards: changing the content of an
// active row IS allowed (it's the whole point — tune prompts without
// deploy), and the cache is invalidated so changes take effect within
// 30s on every Vercel function instance.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { invalidatePromptsCache } from '@/lib/agent/prompts-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PatchBody {
  content?: string;
  canary_pct?: number;
  notes?: string;
  version?: string;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!id) return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  let body: PatchBody;
  try { body = await req.json(); }
  catch { return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed }); }

  const update: Record<string, unknown> = {};
  if (body.content !== undefined) {
    if (!body.content.trim()) return err('content cannot be empty', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    if (body.content.length > 50_000) return err('content exceeds 50000 chars', { requestId, status: 413, code: ApiErrorCode.ValidationFailed });
    update.content = body.content;
  }
  if (body.canary_pct !== undefined) {
    if (body.canary_pct < 0 || body.canary_pct > 100) {
      return err('canary_pct must be 0-100', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    update.canary_pct = body.canary_pct;
  }
  if (body.notes !== undefined) update.notes = body.notes;
  if (body.version !== undefined) {
    if (!body.version.trim()) return err('version cannot be empty', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    update.version = body.version.trim();
  }

  if (Object.keys(update).length === 0) {
    return err('no fields to update', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { error } = await supabaseAdmin
    .from('agent_prompts')
    .update(update)
    .eq('id', id);

  if (error) {
    return err(`failed to update prompt: ${error.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Invalidate in-process cache so changes show up within 30s.
  // (Each Vercel function instance has its own cache; this only
  // clears the one that handled the PATCH request. Other instances
  // pick up the new row on their next TTL expiry.)
  invalidatePromptsCache();

  return ok({ id }, { requestId });
}
