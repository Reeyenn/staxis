/**
 * Persist a housekeeper's language preference from the public
 * /housekeeper/[id] page.
 *
 * Why this exists:
 *   Same RLS-blocks-anon story as /api/housekeeper/rooms and
 *   /api/housekeeper/me. The page used to call
 *   supabase.from('staff').update({ language }) directly from the browser.
 *   For unauthenticated housekeepers RLS silently filtered the UPDATE to
 *   zero rows — Postgres returned 200 OK, the supabase JS client treated
 *   that as success, but no row actually changed. The toggle appeared to
 *   work locally (state updates) but the next session reverted to English
 *   because the column never moved.
 *
 *   This route runs server-side with supabaseAdmin so the write actually
 *   lands. Capability check: staff_id must belong to property_id.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: unknown;
  staffId?: unknown;
  language?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (body.language !== 'en' && body.language !== 'es') {
    return err("language must be 'en' or 'es'", {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const pid = pidV.value!;
  const staffId = staffV.value!;
  const language = body.language;

  // Capability: write only if (staff_id, property_id) actually matches.
  // .update().eq().eq() is enough — if there's no matching row the update
  // is a no-op; we then return 404 so the client surface a real error.
  const { data, error: updateError } = await supabaseAdmin
    .from('staff')
    .update({ language })
    .eq('id', staffId)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();

  if (updateError) {
    console.error('[housekeeper/save-language] update failed', errToString(updateError));
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!data) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  return ok({ id: data.id, language }, { requestId });
}
