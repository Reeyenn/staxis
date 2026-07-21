/**
 * /api/knowledge/documents — uploaded files in the Knowledge hub.
 *
 *   GET    ?pid=&folderId?=                                → list w/ signed download URLs (ALL STAFF, dept-gated)
 *   POST   { pid, title, path, mimeType, sizeBytes?, visibility?, visibleDept?, folderId? } → register (MANAGERS)
 *   PATCH  { pid, id, action:'access'|'move', ... }        → re-scope or move a document (MANAGERS)
 *   DELETE ?pid=&id=                                       → delete row + storage object (MANAGERS)
 *
 * Upload flow: client calls POST /api/knowledge/documents/presign to get a
 * signed upload URL + the server-resolved Content-Type, PUTs the file, then
 * POSTs here to register the metadata row (which also extracts text for AI
 * search on plain-text/markdown). The register step re-validates that the
 * object path is scoped to the caller's property (tenant isolation).
 */
import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateInt, validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { type AppRole } from '@/lib/roles';
import { capabilityDecisionForUserId } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { commsContext } from '@/lib/comms/route-helpers';
import { listDocuments, registerDocument, deleteDocument, updateDocumentAccess, moveDocument } from '@/lib/knowledge/core';
import { indexDocument } from '@/lib/knowledge/indexing';
import { KNOWLEDGE_LIMITS, KNOWLEDGE_VISIBILITIES, KNOWLEDGE_DEPTS, type KnowledgeVisibility } from '@/lib/knowledge/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The POST hands extraction + embedding to after() (runs after the response,
// within this invocation). Give it room so a large PDF's read/embed finishes.
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  // Optional folder filter. Absent → all visible docs (the UI groups by folder).
  let folderId: string | undefined;
  const folderRaw = req.nextUrl.searchParams.get('folderId');
  if (folderRaw) {
    const fV = validateUuid(folderRaw, 'folderId');
    if (fV.error) return err(fV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    folderId = fV.value!;
  }
  const documents = await listDocuments(ctx.pid, { role: ctx.role as AppRole, dept: ctx.dept }, { folderId });
  return ok({ documents }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: { pid?: string; title?: unknown; path?: unknown; mimeType?: unknown; sizeBytes?: unknown; visibility?: unknown; visibleDept?: unknown; folderId?: unknown };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  const capabilityDecision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('Only managers can upload documents', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const rl = await checkAndIncrementRateLimit('knowledge-write', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const titleV = validateString(raw.title, { max: KNOWLEDGE_LIMITS.TITLE_MAX, label: 'title' });
  if (titleV.error) return err(titleV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const pathV = validateString(raw.path, { max: 300, label: 'path' });
  if (pathV.error) return err(pathV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const mimeV = validateString(raw.mimeType, { max: 120, label: 'mimeType' });
  if (mimeV.error) return err(mimeV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  let visibility: KnowledgeVisibility = 'all_staff';
  if (raw.visibility !== undefined && raw.visibility !== null) {
    const visV = validateEnum(raw.visibility, KNOWLEDGE_VISIBILITIES, 'visibility');
    if (visV.error) return err(visV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    visibility = visV.value!;
  }
  // A 'dept' document needs a real department; other tiers carry none.
  let visibleDept: string | null = null;
  if (visibility === 'dept') {
    const vdV = validateEnum(raw.visibleDept, KNOWLEDGE_DEPTS, 'visibleDept');
    if (vdV.error) return err(vdV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    visibleDept = vdV.value!;
  }

  let folderId: string | null = null;
  if (raw.folderId !== undefined && raw.folderId !== null && raw.folderId !== '') {
    const fV = validateUuid(raw.folderId, 'folderId');
    if (fV.error) return err(fV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    folderId = fV.value!;
  }

  let sizeBytes: number | null = null;
  if (raw.sizeBytes !== undefined && raw.sizeBytes !== null) {
    const sizeV = validateInt(raw.sizeBytes, { min: 0, max: 10_485_760, label: 'sizeBytes' });
    if (sizeV.error) return err(sizeV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    sizeBytes = sizeV.value!;
  }

  const result = await registerDocument(
    ctx.pid,
    { title: titleV.value!, path: pathV.value!, mimeType: mimeV.value!, sizeBytes, visibility, visibleDept, folderId },
    { accountId: ctx.accountId, name: ctx.displayName },
  );
  if ('error' in result) {
    return err(result.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  // Read + chunk + embed AFTER the response so a slow PDF/embedding doesn't
  // block the upload. The row is already `pending`; this drives it to its
  // terminal status (ready/partial/failed/unsupported).
  const pid = ctx.pid, docId = result.id, filePath = pathV.value!, mime = mimeV.value!, accountId = ctx.accountId;
  after(() => indexDocument({ propertyId: pid, docId, filePath, mime, accountId, visibility, visibleDept }));
  return ok({ id: result.id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}

/**
 * Re-scope (`action:'access'`) or move (`action:'move'`) an existing document.
 * Managers only. The access change re-flips the doc's chunk scope synchronously
 * inside updateDocumentAccess (no re-embed) so AI search can't leak via stale
 * chunks; a move is pure metadata.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  let raw: { pid?: string; id?: unknown; action?: unknown; visibility?: unknown; visibleDept?: unknown; folderId?: unknown };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  const capabilityDecision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('Only managers can change documents', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const rl = await checkAndIncrementRateLimit('knowledge-write', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const idV = validateUuid(raw.id, 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  if (raw.action === 'access') {
    const visV = validateEnum(raw.visibility, KNOWLEDGE_VISIBILITIES, 'visibility');
    if (visV.error) return err(visV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    let visibleDept: string | null = null;
    if (visV.value === 'dept') {
      const vdV = validateEnum(raw.visibleDept, KNOWLEDGE_DEPTS, 'visibleDept');
      if (vdV.error) return err(vdV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
      visibleDept = vdV.value!;
    }
    const res = await updateDocumentAccess(ctx.pid, idV.value!, { visibility: visV.value!, visibleDept });
    if ('error' in res) return err(res.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    if (!res.ok) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
    return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
  }

  if (raw.action === 'move') {
    let folderId: string | null = null;
    if (raw.folderId !== undefined && raw.folderId !== null && raw.folderId !== '') {
      const fV = validateUuid(raw.folderId, 'folderId');
      if (fV.error) return err(fV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
      folderId = fV.value!;
    }
    const res = await moveDocument(ctx.pid, idV.value!, folderId);
    if ('error' in res) return err(res.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    if (!res.ok) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
    return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
  }

  return err('Unknown action', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  const capabilityDecision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('Only managers can delete documents', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const idV = validateUuid(req.nextUrl.searchParams.get('id'), 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const deleted = await deleteDocument(ctx.pid, idV.value!);
  if (!deleted) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}
