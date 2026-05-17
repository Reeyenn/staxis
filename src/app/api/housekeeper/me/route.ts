/**
 * Housekeeper "me" — fetch the bare minimum staff fields the public
 * /housekeeper/[id] page needs to render.
 *
 * Why this exists:
 *   The page used to call supabase.from('staff').select(...) directly
 *   from the browser to read the housekeeper's saved language preference.
 *   That worked for the owner (signed in) but quietly returned NULL for
 *   actual housekeepers (unauthenticated → RLS denies). Same root cause
 *   as /api/housekeeper/rooms — RLS blocks reads from anon, even when the
 *   page is publicly linkable by design.
 *
 *   This route runs server-side with supabaseAdmin so the call always
 *   succeeds, then projects the response down to the few fields the
 *   page actually uses (no PII, no payroll). Mirrors /api/staff-list's
 *   security posture.
 *
 * Response: { id, name, language: 'en' | 'es' | null }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);

  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;
  const staffId = staffV.value!;

  const { data, error: queryError } = await supabaseAdmin
    .from('staff')
    .select('id, name, language')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();

  if (queryError) {
    log.error('[housekeeper/me] query failed', { err: queryError, requestId });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!data) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Tight projection: only what the public page actually consumes.
  const lang = data.language === 'es' || data.language === 'en' ? data.language : null;
  return ok({ id: data.id, name: data.name, language: lang }, { requestId });
}
