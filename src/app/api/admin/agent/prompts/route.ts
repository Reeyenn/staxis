// ─── Admin API: agent prompts (list + create) ────────────────────────────
// Powers the /admin/agent/prompts UI for editing system prompts without
// a code deploy. Longevity L2, 2026-05-13.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { invalidatePromptsCache } from '@/lib/agent/prompts-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PromptRole = 'base' | 'housekeeping' | 'general_manager' | 'owner' | 'admin' | 'summarizer';
const VALID_ROLES: PromptRole[] = ['base', 'housekeeping', 'general_manager', 'owner', 'admin', 'summarizer'];

// GET — list all prompt versions, newest first per role
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await supabaseAdmin
    .from('agent_prompts')
    .select('id, role, version, content, is_active, parent_version, notes, created_at, created_by')
    .order('role')
    .order('created_at', { ascending: false });

  if (error) {
    log.error('agent-prompts load failed', { err: error, requestId });
    return err('failed to load prompts', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  return ok({ prompts: data ?? [] }, { requestId });
}

interface CreateBody {
  role: PromptRole;
  version: string;
  content: string;
  parent_version?: string;
  notes?: string;
}

// POST — create a new DRAFT version (is_active=false). Operator must
// hit Activate separately to promote it.
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: CreateBody;
  try { body = await req.json(); }
  catch { return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed }); }

  if (!VALID_ROLES.includes(body.role)) {
    return err(`role must be one of: ${VALID_ROLES.join(', ')}`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!body.version?.trim()) {
    return err('version is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!body.content?.trim()) {
    return err('content is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (body.content.length > 50_000) {
    return err('content exceeds 50000 chars', { requestId, status: 413, code: ApiErrorCode.ValidationFailed });
  }

  const { data, error } = await supabaseAdmin
    .from('agent_prompts')
    .insert({
      role: body.role,
      version: body.version.trim(),
      content: body.content,
      parent_version: body.parent_version ?? null,
      notes: body.notes ?? null,
      is_active: false,
      created_by: auth.accountId,
    })
    .select('id')
    .single();

  if (error) {
    log.error('agent-prompts create failed', { err: error, requestId });
    return err('failed to create prompt', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Cache doesn't need invalidation here (creation is is_active=false;
  // no traffic affected until Activate runs).
  void invalidatePromptsCache;

  return ok({ id: (data as { id: string }).id }, { requestId });
}
