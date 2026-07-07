/**
 * /api/comms/logbook — the Shift Log Book (recaps).
 *   GET   ?pid=...                                  → list recaps (newest first)
 *   POST  { pid, title, body?, category? }           → post a recap
 * Authenticated (requireSession + 2FA + property access) via commsContext.
 * Any authenticated staffer with property access can post — NOT manager-gated.
 * NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateString, validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { requireSectionEnabled } from '@/lib/sections/server';
import { listLogEntries, createLogEntry } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CATEGORIES = ['front_desk', 'housekeeping', 'maintenance', 'general'] as const;

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  // Section gate (add-on, on top of the tenant guard above): if Communications is off for this hotel, block this route.
  const sectionGate = await requireSectionEnabled(req, ctx.pid, 'communications');
  if (!sectionGate.ok) return sectionGate.response;
  // Polled read (~8s) → shared 'comms-read' bucket (3600/hr), like tasks GET.
  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  const entries = await listLogEntries(ctx.pid);
  return ok({ entries }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; title?: string; body?: string; category?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  // Section gate (add-on, on top of the tenant guard above): if Communications is off for this hotel, block this route.
  const sectionGate = await requireSectionEnabled(req, ctx.pid, 'communications');
  if (!sectionGate.ok) return sectionGate.response;

  // Trim before validating so a whitespace-only title is rejected (the reply
  // route does the same) — otherwise a direct API call could log a blank recap.
  const titleRaw = typeof body.title === 'string' ? body.title.trim() : body.title;
  const titleV = validateString(titleRaw, { max: 200, label: 'title' });
  if (titleV.error) {
    return err(titleV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  // Body is optional; validate (reject non-strings / over-length) rather than
  // silently coercing+truncating. Empty body is allowed (recaps can be title-only).
  let bodyText = '';
  if (body.body !== undefined && body.body !== null) {
    const bodyV = validateString(typeof body.body === 'string' ? body.body.trim() : body.body, { max: 5000, label: 'body', allowEmpty: true });
    if (bodyV.error) return err(bodyV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    bodyText = bodyV.value!;
  }

  let category: string | null = null;
  if (body.category) {
    const cv = validateEnum(body.category, CATEGORIES, 'category');
    if (cv.error) return err(cv.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    category = cv.value!;
  }

  const rl = await checkAndIncrementRateLimit('comms-logbook', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const res = await createLogEntry(ctx.pid, {
    authorStaffId: ctx.staffId,
    title: titleV.value!,
    body: bodyText,
    category,
  });
  return ok({ id: res.id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}
