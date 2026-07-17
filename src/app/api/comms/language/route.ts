/**
 * /api/comms/language — the user's app-wide language preference.
 *   GET  → { language }              (loads accounts.preferred_language)
 *   POST { language } → { language } (persists it; follows the user across devices)
 * Property-agnostic (the choice is app-wide), so this uses requireSession only.
 * Mirrors the housekeeper save-language flow for account-based users.
 */
import { ApiErrorCode } from '@/lib/api-response';
import { validateEnum } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { defineRoute, sessionGate } from '@/lib/api-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LANGS = ['en', 'es', 'ht', 'tl', 'vi'] as const;

export const GET = defineRoute({
  resolve: (req) => sessionGate(req, { attachHeaders: true }),
  handler: async (ctx) => {
    const { data } = await supabaseAdmin
      .from('accounts')
      .select('preferred_language')
      .eq('data_user_id', ctx.userId)
      .maybeSingle();
    const raw = data?.preferred_language;
    const language = raw === 'es' || raw === 'ht' || raw === 'tl' || raw === 'vi' ? raw : 'en';
    return ctx.ok({ language });
  },
});

export const POST = defineRoute({
  body: 'empty',
  resolve: (req) => sessionGate(req, { attachHeaders: true }),
  handler: async (ctx) => {
    const langV = validateEnum((ctx.body as { language?: string }).language, LANGS, 'language');
    if (langV.error) {
      return ctx.err(langV.error, { status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const rl = await checkAndIncrementRateLimit('comms-save-language', hashToRateLimitKey(ctx.userId));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    await supabaseAdmin
      .from('accounts')
      .update({ preferred_language: langV.value })
      .eq('data_user_id', ctx.userId);

    return ctx.ok({ language: langV.value });
  },
});
