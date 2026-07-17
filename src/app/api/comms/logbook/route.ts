/**
 * /api/comms/logbook — the Shift Log Book (recaps).
 *   GET   ?pid=...                                  → list recaps (newest first)
 *   POST  { pid, title, body?, category? }           → post a recap
 * Authenticated (requireSession + 2FA + property access) via commsContext.
 * Any authenticated staffer with property access can post — NOT manager-gated.
 * NO SMS.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateString, validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';
import { requireSectionEnabled } from '@/lib/sections/server';
import { listLogEntries, createLogEntry } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CATEGORIES = ['front_desk', 'housekeeping', 'maintenance', 'general'] as const;

export const GET = defineRoute({
  resolve: (req) => commsContext(req, new URL(req.url).searchParams.get('pid')),
  handler: async (ctx) => {
    // Section gate (add-on, on top of the tenant guard above): if Communications is off for this hotel, block this route.
    const sectionGate = await requireSectionEnabled(ctx.req, ctx.pid, 'communications');
    if (!sectionGate.ok) return sectionGate.response;
    // Polled read (~8s) → shared 'comms-read' bucket (3600/hr), like tasks GET.
    const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
    const entries = await listLogEntries(ctx.pid);
    return ctx.ok({ entries });
  },
});

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: { pid?: string; title?: string; body?: string; category?: string }) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const body = ctx.body;
    // Section gate (add-on, on top of the tenant guard above): if Communications is off for this hotel, block this route.
    const sectionGate = await requireSectionEnabled(ctx.req, ctx.pid, 'communications');
    if (!sectionGate.ok) return sectionGate.response;

    // Trim before validating so a whitespace-only title is rejected (the reply
    // route does the same) — otherwise a direct API call could log a blank recap.
    const titleRaw = typeof body.title === 'string' ? body.title.trim() : body.title;
    const titleV = validateString(titleRaw, { max: 200, label: 'title' });
    if (titleV.error) {
      return ctx.err(titleV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    // Body is optional; validate (reject non-strings / over-length) rather than
    // silently coercing+truncating. Empty body is allowed (recaps can be title-only).
    let bodyText = '';
    if (body.body !== undefined && body.body !== null) {
      const bodyV = validateString(typeof body.body === 'string' ? body.body.trim() : body.body, { max: 5000, label: 'body', allowEmpty: true });
      if (bodyV.error) return ctx.err(bodyV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
      bodyText = bodyV.value!;
    }

    let category: string | null = null;
    if (body.category) {
      const cv = validateEnum(body.category, CATEGORIES, 'category');
      if (cv.error) return ctx.err(cv.error, { status: 400, code: ApiErrorCode.ValidationFailed });
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
    return ctx.ok({ id: res.id }, { status: 201 });
  },
});
