/**
 * /api/knowledge/folders — document folders in the Knowledge hub.
 *
 *   GET    ?pid=                              → list folders (ALL STAFF)
 *   POST   { pid, name, parentId? }           → create a folder (MANAGERS)
 *   PATCH  { pid, id, name }                  → rename a folder (MANAGERS)
 *   DELETE ?pid=&id=                          → delete a folder (MANAGERS)
 *
 * Folders carry no per-row visibility — the documents inside them do. Deleting a
 * folder un-files its documents (knowledge_documents.folder_id ON DELETE SET
 * NULL); the files + embeddings are never deleted. Auth + manager gate mirror
 * /api/knowledge/documents (commsContext + canForUserId('manage_knowledge')).
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { canForUserId } from '@/lib/capabilities/server';
import { commsContext } from '@/lib/comms/route-helpers';
import { listFolders, createFolder, renameFolder, deleteFolder } from '@/lib/knowledge/core';
import { KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  const folders = await listFolders(ctx.pid);
  return ok({ folders }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: { pid?: string; name?: unknown; parentId?: unknown };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  if (!(await canForUserId(ctx.userId, 'manage_knowledge', ctx.pid))) {
    return err('Only managers can create folders', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const rl = await checkAndIncrementRateLimit('knowledge-write', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const nameV = validateString(raw.name, { max: KNOWLEDGE_LIMITS.FOLDER_NAME_MAX, label: 'name' });
  if (nameV.error) return err(nameV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  let parentId: string | null = null;
  if (raw.parentId !== undefined && raw.parentId !== null && raw.parentId !== '') {
    const pV = validateUuid(raw.parentId, 'parentId');
    if (pV.error) return err(pV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    parentId = pV.value!;
  }

  const result = await createFolder(ctx.pid, { name: nameV.value!, parentId }, { accountId: ctx.accountId, name: ctx.displayName });
  if ('error' in result) {
    return err(result.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  return ok({ id: result.id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  let raw: { pid?: string; id?: unknown; name?: unknown };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  if (!(await canForUserId(ctx.userId, 'manage_knowledge', ctx.pid))) {
    return err('Only managers can rename folders', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const rl = await checkAndIncrementRateLimit('knowledge-write', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const idV = validateUuid(raw.id, 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const nameV = validateString(raw.name, { max: KNOWLEDGE_LIMITS.FOLDER_NAME_MAX, label: 'name' });
  if (nameV.error) return err(nameV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const renamed = await renameFolder(ctx.pid, idV.value!, nameV.value!);
  if (!renamed) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  if (!(await canForUserId(ctx.userId, 'manage_knowledge', ctx.pid))) {
    return err('Only managers can delete folders', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const idV = validateUuid(req.nextUrl.searchParams.get('id'), 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const deleted = await deleteFolder(ctx.pid, idV.value!);
  if (!deleted) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}
