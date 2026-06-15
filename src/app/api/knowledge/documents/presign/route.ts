/**
 * POST /api/knowledge/documents/presign — Body: { pid, filename }
 *
 * Returns a short-lived signed upload URL for a new Knowledge document plus the
 * server-resolved Content-Type (derived from the file extension). The client
 * PUTs the file to signedUrl with that Content-Type, then registers it via
 * POST /api/knowledge/documents. MANAGERS only; private 'knowledge-docs' bucket.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { canForUserId } from '@/lib/capabilities/server';
import { commsContext } from '@/lib/comms/route-helpers';
import { presignDocument } from '@/lib/knowledge/core';
import { KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  let raw: { pid?: string; filename?: unknown };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  if (!(await canForUserId(ctx.userId, 'manage_knowledge', ctx.pid))) {
    return err('Only managers can upload documents', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const rl = await checkAndIncrementRateLimit('knowledge-presign', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const fnameV = validateString(raw.filename, { max: KNOWLEDGE_LIMITS.DOC_FILENAME_MAX, label: 'filename' });
  if (fnameV.error) return err(fnameV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const res = await presignDocument(ctx.pid, fnameV.value!);
  if (!res) {
    return err('Unsupported file type. Allowed: PDF, TXT, Markdown, CSV, DOC, DOCX.', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }
  return ok(res, { requestId: ctx.requestId, headers: ctx.headers });
}
