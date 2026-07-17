/**
 * Notice Board endpoints — manager posts (POST) + housekeeper reads (GET).
 *
 * POST is session-gated (the manager dashboard fires it). The body
 * carries the EN body plus any subset of the four other locales the
 * manager has translations for; we fall back to EN at render time when
 * a locale is missing. The `staxis_post_notice` RPC enforces the
 * one-pinned-notice-per-property invariant atomically.
 *
 * GET is publicly callable (the housekeeper page polls it from the
 * SMS-linked surface, before the user has any Supabase session). It
 * uses the same (pid, staffId) capability check shape as the rest of
 * the /api/housekeeping/* and /api/housekeeper/* public surface.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { ApiErrorCode } from '@/lib/api-response';
import { defineRoute, sessionGate, publicGate } from '@/lib/api-route';
import { verifyStaffLinkToken } from '@/lib/staff-link-auth';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { userHasPropertyAccess } from '@/lib/api-auth';
import { translateNoticeToSpanish } from '@/lib/notice-translate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 20s: the POST handler now makes a one-shot Haiku call to translate the
// notice into Spanish (8s client timeout) on top of the auth + rate-limit +
// RPC work. Translation falls back to English on timeout, so this ceiling is
// headroom, not a hard dependency.
export const maxDuration = 20;

// ── GET /api/housekeeping/notices?pid=...&staffId=... ───────────────────
// Returns active (non-expired) notices for the property, with the caller's
// dismissed-set so the client can render only the still-visible ones.
export const GET = defineRoute({
  resolve: (req) => publicGate(req),
  handler: async (ctx) => {
    const { searchParams } = new URL(ctx.req.url);

    const pidV = validateUuid(searchParams.get('pid'), 'pid');
    if (pidV.error) {
      return ctx.err(pidV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
    if (staffV.error) {
      return ctx.err(staffV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const pid = pidV.value!;
    const staffId = staffV.value!;

    const rl = await checkAndIncrementRateLimit(
      'housekeeping-notices-read',
      hashToRateLimitKey(`${pid}:${staffId}`),
    );
    if (!rl.allowed) {
      return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
    }

    // Security audit 2026-06-26 #1: verify the per-staff link token (?tok=).
    const gate = await verifyStaffLinkToken(ctx.req, { pid, staffId, requestId: ctx.requestId });
    if (!gate.ok) return gate.response;

    try {
      const nowIso = new Date().toISOString();
      const [noticesRes, dismissedRes] = await Promise.all([
        supabaseAdmin
          .from('housekeeping_notices')
          .select('id, body_en, body_es, body_ht, body_tl, body_vi, pinned, expires_at, posted_at')
          .eq('property_id', pid)
          .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
          .order('pinned', { ascending: false })
          .order('posted_at', { ascending: false })
          .limit(50),
        supabaseAdmin
          .from('housekeeper_dismissed_notices')
          .select('notice_id')
          .eq('property_id', pid)
          .eq('staff_id', staffId),
      ]);
      if (noticesRes.error) throw noticesRes.error;
      if (dismissedRes.error) throw dismissedRes.error;

      type DismissedRow = { notice_id: string };
      const dismissedSet = new Set(
        ((dismissedRes.data ?? []) as DismissedRow[]).map((d) => d.notice_id),
      );
      return ctx.ok({
        notices: noticesRes.data ?? [],
        dismissedNoticeIds: Array.from(dismissedSet),
      });
    } catch (caughtErr) {
      log.error('housekeeping/notices: GET failed', { requestId: ctx.requestId, err: errToString(caughtErr) });
      return ctx.err('Internal server error', {
        status: 500, code: ApiErrorCode.InternalError,
      });
    }
  },
});

// ── POST /api/housekeeping/notices ──────────────────────────────────────
// Manager posts a notice. Body: { pid, body_en, pinned?, expires_at? }.
// The manager only types English; we auto-translate to Spanish server-side
// (translateNoticeToSpanish) so the cleaning staff see their language without
// the manager hand-typing it. The other locale columns (ht/tl/vi) are left
// null and fall back to English at render time.
interface PostBody {
  pid?: string;
  body_en?: string;
  pinned?: boolean;
  expires_at?: string | null;
}

export const POST = defineRoute({
  resolve: (req) => sessionGate(req, { attachHeaders: true }),
  handler: async (ctx) => {
    const deadlineAt = Date.now() + 12_000;
    let body: PostBody;
    try {
      body = (await ctx.req.json()) as PostBody;
    } catch {
      return ctx.err('invalid json', { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const pidV = validateUuid(body.pid, 'pid');
    if (pidV.error) {
      return ctx.err(pidV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const pid = pidV.value!;
    const bodyEn = (body.body_en ?? '').trim();
    if (!bodyEn) {
      return ctx.err('body_en is required', { status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (bodyEn.length > 1000) {
      return ctx.err('body_en too long (max 1000 chars)', { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const hasAccess = await userHasPropertyAccess(ctx.userId, pid);
    if (!hasAccess) {
      return ctx.err('property access denied', { status: 403, code: ApiErrorCode.Forbidden });
    }

    const rl = await checkAndIncrementRateLimit(
      'housekeeping-notices-post',
      hashToRateLimitKey(`${pid}:${ctx.userId}`),
    );
    if (!rl.allowed) {
      return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
    }

    let expiresAt: string | null = null;
    if (typeof body.expires_at === 'string' && body.expires_at) {
      const ms = Date.parse(body.expires_at);
      if (!Number.isFinite(ms)) {
        return ctx.err('invalid expires_at', { status: 400, code: ApiErrorCode.ValidationFailed });
      }
      if (ms <= Date.now()) {
        return ctx.err('expires_at must be in the future', { status: 400, code: ApiErrorCode.ValidationFailed });
      }
      expiresAt = new Date(ms).toISOString();
    }

    // Auto-translate the English body into Spanish before storing. Best-effort:
    // returns null on timeout / API failure / missing key, in which case the
    // notice posts English-only and the housekeeper banner falls back to EN.
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('id')
      .eq('data_user_id', ctx.userId)
      .maybeSingle();
    const accountId = typeof account?.id === 'string' ? account.id : null;
    const bodyEs = await translateNoticeToSpanish(bodyEn, 'housekeeping.notice_translation', {
      deadlineAt,
      abortSignal: ctx.req.signal,
      // The AI runtime records the spend itself (agent_costs, kind=background).
      ledger: accountId
        ? { userId: accountId, propertyId: pid, requestId: ctx.requestId }
        : undefined,
    });

    try {
      const { data, error: rpcErr } = await supabaseAdmin.rpc('staxis_post_notice', {
        p_property_id: pid,
        p_body_en: bodyEn,
        p_body_es: bodyEs,
        // ht/tl/vi are no longer hand-entered; they fall back to EN at render.
        p_body_ht: null,
        p_body_tl: null,
        p_body_vi: null,
        p_pinned: body.pinned === true,
        p_expires_at: expiresAt,
        p_posted_by_account_id: ctx.userId,
      });
      if (rpcErr) {
        log.error('housekeeping/notices: post rpc failed', {
          requestId: ctx.requestId, err: errToString(rpcErr),
        });
        return ctx.err('Internal server error', { status: 500, code: ApiErrorCode.InternalError });
      }
      return ctx.ok({ noticeId: data });
    } catch (caughtErr) {
      log.error('housekeeping/notices: post threw', {
        requestId: ctx.requestId, err: errToString(caughtErr),
      });
      return ctx.err('Internal server error', { status: 500, code: ApiErrorCode.InternalError });
    }
  },
});

// ── DELETE /api/housekeeping/notices?id=... ─────────────────────────────
// Manager deletes a notice (or removes pin / expiry). Simpler than PATCH
// since the UI just re-posts a fresh notice when editing.
export const DELETE = defineRoute({
  resolve: (req) => sessionGate(req, { attachHeaders: true }),
  handler: async (ctx) => {
    const { searchParams } = new URL(ctx.req.url);
    const noticeIdV = validateUuid(searchParams.get('id'), 'id');
    const pidV = validateUuid(searchParams.get('pid'), 'pid');
    if (noticeIdV.error || pidV.error) {
      return ctx.err(noticeIdV.error || pidV.error || 'missing id/pid', {
        status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    const pid = pidV.value!;
    const noticeId = noticeIdV.value!;

    const hasAccess = await userHasPropertyAccess(ctx.userId, pid);
    if (!hasAccess) {
      return ctx.err('property access denied', { status: 403, code: ApiErrorCode.Forbidden });
    }

    const rl = await checkAndIncrementRateLimit(
      'housekeeping-notices-post',
      hashToRateLimitKey(`${pid}:${ctx.userId}`),
    );
    if (!rl.allowed) {
      return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
    }

    // Scope the DELETE by property_id too — defense in depth so a manager
    // can't accidentally (or intentionally) delete another property's notice
    // by spoofing the id.
    const { error: delErr } = await supabaseAdmin
      .from('housekeeping_notices')
      .delete()
      .eq('id', noticeId)
      .eq('property_id', pid);
    if (delErr) {
      log.error('housekeeping/notices: delete failed', {
        requestId: ctx.requestId, err: errToString(delErr),
      });
      return ctx.err('Internal server error', { status: 500, code: ApiErrorCode.InternalError });
    }
    return ctx.ok({ deleted: true, noticeId });
  },
});
