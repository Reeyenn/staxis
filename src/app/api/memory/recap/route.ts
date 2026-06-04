/**
 * Dashboard "What Staxis learned" recap — MANAGEMENT ONLY, service-role.
 *
 * GET  ?propertyId=<uuid>
 *   → { ok, data: { recap, ranAt, learnedCount, updatedCount, items: [{id,topic,content}] } }
 *   The latest nightly consolidation run + the active auto-learned facts.
 *
 * POST { propertyId, id }
 *   → soft-deletes (removes) one auto-learned fact. The dashboard "Remove" button.
 *
 * Auth: requireSession + canManageTeam (admin/owner/general_manager) + the caller
 * must manage the named property. All reads/writes via supabaseAdmin behind the
 * gate (agent_memory* are deny-all to the browser).
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { canManageTeam, type AppRole } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getLatestConsolidation, listLearnedMemory, deactivateMemoryById } from '@/lib/db/agent-memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Caller {
  role: AppRole;
  propertyAccess: string[];
}

async function loadCaller(authUserId: string): Promise<Caller | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    role: (data as { role: string }).role as AppRole,
    propertyAccess: Array.isArray((data as { property_access?: unknown }).property_access)
      ? (data as { property_access: string[] }).property_access
      : [],
  };
}

function callerManagesProperty(caller: Caller, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (caller.propertyAccess.includes('*')) return true;
  return caller.propertyAccess.includes(propertyId);
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const caller = await loadCaller(session.userId);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canManageTeam(caller.role)) return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });

  const pidV = validateUuid(new URL(req.url).searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerManagesProperty(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const [recap, items] = await Promise.all([
    getLatestConsolidation(pidV.value!),
    listLearnedMemory(pidV.value!, 20),
  ]);

  return ok(
    {
      recap: recap?.recap ?? null,
      ranAt: recap?.ranAt ?? null,
      learnedCount: recap?.learnedCount ?? 0,
      updatedCount: recap?.updatedCount ?? 0,
      items: items.map((i) => ({ id: i.id, topic: i.topic, content: i.content })),
    },
    { requestId },
  );
}

interface PostBody {
  propertyId?: unknown;
  id?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const caller = await loadCaller(session.userId);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canManageTeam(caller.role)) return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerManagesProperty(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const idV = validateUuid(body.id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const res = await deactivateMemoryById(pidV.value!, idV.value!);
  if (!res.ok) {
    log.error('[memory/recap:POST] remove failed', { requestId, err: res.error });
    return err('Failed to remove', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({ removed: res.removed > 0, id: idV.value }, { requestId });
}
