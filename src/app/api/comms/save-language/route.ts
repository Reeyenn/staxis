/**
 * POST /api/comms/save-language  — Body: { pid, language }
 * Persists the authenticated user's app-wide language choice server-side
 * (accounts.preferred_language) so it follows them across devices, mirroring
 * the housekeeper save-language flow. Also syncs the caller's staff.language.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateEnum } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LANGS = ['en', 'es', 'ht', 'tl', 'vi'] as const;

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; language?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
  if (!ctx.ok) return ctx.response;

  const langV = validateEnum(body.language, LANGS, 'language');
  if (langV.error) {
    return err(langV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
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

  return ok({ language: langV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}
