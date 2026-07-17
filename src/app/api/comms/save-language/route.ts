/**
 * POST /api/comms/save-language  — Body: { pid, language }
 * Persists the authenticated user's app-wide language choice server-side
 * (accounts.preferred_language) so it follows them across devices, mirroring
 * the housekeeper save-language flow. Also syncs the caller's staff.language.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateEnum } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { defineRoute } from '@/lib/api-route';
import { commsContext } from '@/lib/comms/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LANGS = ['en', 'es', 'ht', 'tl', 'vi'] as const;

export const POST = defineRoute({
  body: 'empty',
  resolve: (req, body: { pid?: string; language?: string }) => commsContext(req, body.pid ?? null),
  handler: async (ctx) => {
    const langV = validateEnum(ctx.body.language, LANGS, 'language');
    if (langV.error) {
      return ctx.err(langV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const rl = await checkAndIncrementRateLimit('comms-save-language', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    // Write only to the caller's own account (scoped by data_user_id).
    await supabaseAdmin
      .from('accounts')
      .update({ preferred_language: langV.value })
      .eq('id', ctx.accountId)
      .eq('data_user_id', ctx.userId);
    // Keep the caller's floor identity (staff.language) in sync.
    await supabaseAdmin
      .from('staff')
      .update({ language: langV.value })
      .eq('id', ctx.staffId)
      .eq('property_id', ctx.pid);

    return ctx.ok({ language: langV.value });
  },
});
