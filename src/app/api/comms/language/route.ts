/**
 * /api/comms/language — the user's app-wide language preference.
 *   GET  → { language }              (loads accounts.preferred_language)
 *   POST { language } → { language } (persists it; follows the user across devices)
 * Property-agnostic (the choice is app-wide), so this uses requireSession only.
 * Mirrors the housekeeper save-language flow for account-based users.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateEnum } from '@/lib/api-validate';
import { requireSession } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LANGS = ['en', 'es', 'ht', 'tl', 'vi'] as const;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const { data } = await supabaseAdmin
    .from('accounts')
    .select('preferred_language')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  const raw = data?.preferred_language;
  const language = raw === 'es' || raw === 'ht' || raw === 'tl' || raw === 'vi' ? raw : 'en';
  return ok({ language }, { requestId, headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let body: { language?: string };
  try { body = await req.json(); } catch { body = {}; }
  const langV = validateEnum(body.language, LANGS, 'language');
  if (langV.error) {
    return err(langV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-save-language', hashToRateLimitKey(session.userId));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  await supabaseAdmin
    .from('accounts')
    .update({ preferred_language: langV.value })
    .eq('data_user_id', session.userId);

  return ok({ language: langV.value }, { requestId, headers });
}
