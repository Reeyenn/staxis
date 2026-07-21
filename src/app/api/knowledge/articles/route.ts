/**
 * /api/knowledge/articles — SOPs in the Knowledge hub.
 *
 *   GET    ?pid=        → list (ALL STAFF with property access)
 *   POST   { pid, title, body, category? }          → create (MANAGERS only)
 *   PATCH  { pid, id, title, body, category? }       → edit   (MANAGERS only)
 *   DELETE ?pid=&id=                                  → delete (MANAGERS only)
 *
 * Auth: commsContext (session + property access). Writes additionally require
 * the manage_knowledge capability (default: every role; restricted per hotel
 * from the Access tab). All access is service-role via supabaseAdmin (the
 * knowledge_* tables are deny-all to the browser) — see migration 0250.
 */
import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { type AppRole } from '@/lib/roles';
import { capabilityDecisionForUserId } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { commsContext } from '@/lib/comms/route-helpers';
import { listArticles, createArticle, updateArticle, deleteArticle } from '@/lib/knowledge/core';
import { indexArticle } from '@/lib/knowledge/indexing';
import { KNOWLEDGE_LIMITS, KNOWLEDGE_VISIBILITIES, type KnowledgeVisibility } from '@/lib/knowledge/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function validateArticleFields(raw: { title?: unknown; body?: unknown; category?: unknown; visibility?: unknown }) {
  const titleV = validateString(raw.title, { max: KNOWLEDGE_LIMITS.TITLE_MAX, label: 'title' });
  if (titleV.error) return { error: titleV.error };
  const bodyV = validateString(raw.body, { max: KNOWLEDGE_LIMITS.BODY_MAX, label: 'body', allowEmpty: true });
  if (bodyV.error) return { error: bodyV.error };
  let category: string | null = null;
  if (raw.category !== undefined && raw.category !== null && raw.category !== '') {
    const catV = validateString(raw.category, { max: KNOWLEDGE_LIMITS.CATEGORY_MAX, label: 'category' });
    if (catV.error) return { error: catV.error };
    category = catV.value!;
  }
  // visibility defaults to all_staff when omitted (backwards-compatible).
  let visibility: KnowledgeVisibility = 'all_staff';
  if (raw.visibility !== undefined && raw.visibility !== null) {
    const visV = validateEnum(raw.visibility, KNOWLEDGE_VISIBILITIES, 'visibility');
    if (visV.error) return { error: visV.error };
    visibility = visV.value!;
  }
  return { value: { title: titleV.value!, body: bodyV.value ?? '', category, visibility } };
}

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  const articles = await listArticles(ctx.pid, ctx.role as AppRole);
  return ok({ articles }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: { pid?: string; title?: unknown; body?: unknown; category?: unknown; visibility?: unknown };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  const capabilityDecision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('Only managers can publish knowledge articles', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const v = validateArticleFields(raw);
  if (v.error) return err(v.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const { id } = await createArticle(ctx.pid, v.value!, { accountId: ctx.accountId, name: ctx.displayName });
  // Embed the SOP for semantic search after the response (non-blocking).
  const pid = ctx.pid, accountId = ctx.accountId, val = v.value!;
  after(() => indexArticle({ propertyId: pid, articleId: id, title: val.title, body: val.body, category: val.category, accountId, visibility: val.visibility }));
  return ok({ id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  let raw: { pid?: string; id?: unknown; title?: unknown; body?: unknown; category?: unknown; visibility?: unknown };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  const capabilityDecision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('Only managers can edit knowledge articles', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const idV = validateUuid(raw.id, 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const v = validateArticleFields(raw);
  if (v.error) return err(v.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const updated = await updateArticle(ctx.pid, idV.value!, v.value!, { accountId: ctx.accountId, name: ctx.displayName });
  if (!updated) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  // Re-embed on change (title/body/category/visibility may have changed).
  const pid = ctx.pid, accountId = ctx.accountId, articleId = idV.value!, val = v.value!;
  after(() => indexArticle({ propertyId: pid, articleId, title: val.title, body: val.body, category: val.category, accountId, visibility: val.visibility }));
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  const capabilityDecision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
  if (capabilityDecision === 'denied') {
    return err('Only managers can delete knowledge articles', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const idV = validateUuid(req.nextUrl.searchParams.get('id'), 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const deleted = await deleteArticle(ctx.pid, idV.value!);
  if (!deleted) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}
