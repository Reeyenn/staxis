/**
 * /api/knowledge/documents — uploaded files in the Knowledge hub.
 *
 *   GET    ?pid=                                          → list w/ signed download URLs (ALL STAFF)
 *   POST   { pid, title, path, mimeType, sizeBytes? }     → register an uploaded file (MANAGERS)
 *   DELETE ?pid=&id=                                       → delete row + storage object (MANAGERS)
 *
 * Upload flow: client calls POST /api/knowledge/documents/presign to get a
 * signed upload URL + the server-resolved Content-Type, PUTs the file, then
 * POSTs here to register the metadata row (which also extracts text for AI
 * search on plain-text/markdown). The register step re-validates that the
 * object path is scoped to the caller's property (tenant isolation).
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateInt } from '@/lib/api-validate';
import { canManageTeam, type AppRole } from '@/lib/roles';
import { commsContext } from '@/lib/comms/route-helpers';
import { listDocuments, registerDocument, deleteDocument } from '@/lib/knowledge/core';
import { KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  const documents = await listDocuments(ctx.pid);
  return ok({ documents }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: { pid?: string; title?: unknown; path?: unknown; mimeType?: unknown; sizeBytes?: unknown };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  if (!canManageTeam(ctx.role as AppRole)) {
    return err('Only managers can upload documents', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const titleV = validateString(raw.title, { max: KNOWLEDGE_LIMITS.TITLE_MAX, label: 'title' });
  if (titleV.error) return err(titleV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const pathV = validateString(raw.path, { max: 300, label: 'path' });
  if (pathV.error) return err(pathV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const mimeV = validateString(raw.mimeType, { max: 120, label: 'mimeType' });
  if (mimeV.error) return err(mimeV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  let sizeBytes: number | null = null;
  if (raw.sizeBytes !== undefined && raw.sizeBytes !== null) {
    const sizeV = validateInt(raw.sizeBytes, { min: 0, max: 10_485_760, label: 'sizeBytes' });
    if (sizeV.error) return err(sizeV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    sizeBytes = sizeV.value!;
  }

  const result = await registerDocument(
    ctx.pid,
    { title: titleV.value!, path: pathV.value!, mimeType: mimeV.value!, sizeBytes },
    { accountId: ctx.accountId, name: ctx.displayName },
  );
  if ('error' in result) {
    return err(result.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  return ok({ id: result.id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  if (!canManageTeam(ctx.role as AppRole)) {
    return err('Only managers can delete documents', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const idV = validateUuid(req.nextUrl.searchParams.get('id'), 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const deleted = await deleteDocument(ctx.pid, idV.value!);
  if (!deleted) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}
