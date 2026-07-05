// POST /api/engineer/save-language
// Body: { pid, staffId, language }
//
// Mirrors /api/housekeeper/save-language for the engineer surface. The UPDATE
// is scoped to (id, property_id), so it doubles as the capability check.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
} from '@/lib/api-ratelimit';
import { requireEngineerStaff } from '@/lib/compliance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const LANGS = ['en', 'es', 'ht', 'tl', 'vi'];

interface Body { pid?: unknown; staffId?: unknown; language?: unknown }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (typeof body.language !== 'string' || !LANGS.includes(body.language)) {
    return err('language must be one of en/es/ht/tl/vi', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!, staffId = staffV.value!, language = body.language;

  const rl = await checkAndIncrementRateLimit('engineer-save-language', pid, { subKey: staffId });
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Capability gate also rejects inactive staff (stale-link), matching the
  // other /api/engineer/* routes.
  // Security audit 2026-06-26 #1: verify the per-staff link token (body.tok),
  // not the raw (pid, staffId) tuple.
  const gate = await requireEngineerStaff(req, { pid, staffId, requestId, bodyToken: (body as { tok?: unknown } | null)?.tok });
  if (!gate.ok) return gate.response;
  const staff = gate.staff;

  const { data, error: updErr } = await supabaseAdmin
    .from('staff')
    .update({ language })
    .eq('id', staffId)
    .eq('property_id', pid)
    .select('id')
    .maybeSingle();
  if (updErr) {
    log.error('[engineer/save-language] update failed', { requestId, msg: errToString(updErr) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!data) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  return ok({ id: data.id, language }, { requestId });
}
