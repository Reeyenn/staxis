/**
 * POST /api/comms/polish  — Body: { pid, text }
 * Managers: clean a rough note into a clear announcement (preview only — the
 * manager still reviews + posts via /announce). RATE LIMIT: RAW pid.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateString } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';
import { polishAnnouncement } from '@/lib/comms/assistant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: { pid?: string; text?: string }) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const deadlineAt = Date.now() + 15_000;
    if (!ctx.isManager) {
      return ctx.err('only managers can polish announcements', { status: 403, code: ApiErrorCode.Forbidden });
    }

    const tV = validateString(ctx.body.text, { max: 2000, label: 'text' });
    if (tV.error) return ctx.err(tV.error, { status: 400, code: ApiErrorCode.ValidationFailed });

    const rl = await checkAndIncrementRateLimit('comms-polish', ctx.pid);
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    const text = await polishAnnouncement(tV.value!, ctx.lang, {
      deadlineAt,
      abortSignal: ctx.req.signal,
      ledger: {
        userId: ctx.accountId,
        propertyId: ctx.pid,
        requestId: ctx.requestId,
        feature: 'communications.announcement_polish',
      },
    });
    return ctx.ok({ text });
  },
});
