/**
 * Laundry completion save — persists the public /laundry/[id] page's
 * checklist progress (completed public-area tasks + laundry load categories)
 * for (pid, staffId, date).
 *
 * Why this exists: the laundry page tracked completion in browser memory
 * only, so a refresh / midnight roll / 60s poll wiped the worker's whole
 * shift of checkmarks. This is the write half of the fix (read half lives in
 * /api/laundry/bootstrap, which now returns the saved sets to seed the page).
 *
 * Public-page rules (see CLAUDE.md "RLS bug class"): service-role write,
 * gated on a (pid, staffId) capability check — never the anon browser client.
 * Deactivated staff are blocked, same as the housekeeper workflow gate.
 *
 * Body: { pid, staffId, date, completedAreaIds: string[], completedLoadCategories: string[] }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

// Defensive bounds — a property won't have thousands of areas/loads; this
// caps a malformed/abusive body without rejecting any real shift.
const MAX_ITEMS = 500;
const MAX_ITEM_LEN = 200;

/** Coerce an unknown into a clean string[] (drop non-strings, trim, cap). */
function cleanStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.slice(0, MAX_ITEM_LEN);
    if (s.length > 0) out.push(s);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  let body: {
    pid?: unknown;
    staffId?: unknown;
    date?: unknown;
    completedAreaIds?: unknown;
    completedLoadCategories?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(typeof body.pid === 'string' ? body.pid : null, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffV = validateUuid(typeof body.staffId === 'string' ? body.staffId : null, 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const date = typeof body.date === 'string' ? body.date.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('date must be YYYY-MM-DD', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pid = pidV.value!;
  const staffId = staffV.value!;
  const completedAreaIds = cleanStringArray(body.completedAreaIds);
  const completedLoadCategories = cleanStringArray(body.completedLoadCategories);

  // Per-staff bucket: RAW pid keeps the api_limits.property_id FK valid (a hashed
  // composite key would FK-violate); staffId folds into the endpoint column so
  // one worker / a replayed SMS link can't 429 the whole property. Matches
  // laundry-bootstrap.
  const rl = await checkAndIncrementRateLimit('laundry-complete', pid, { subKey: staffId });
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Capability check: staff must exist on this property and not be deactivated.
  const { data: staff, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, property_id, is_active')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffErr) {
    log.error('[laundry/complete] staff lookup failed', { requestId, msg: errToString(staffErr), pid, staffId });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!staff) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (staff.is_active === false) {
    return err('staff inactive', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { error: upsertErr } = await supabaseAdmin
    .from('laundry_completion')
    .upsert(
      {
        property_id: pid,
        staff_id: staffId,
        shift_date: date,
        completed_area_ids: completedAreaIds,
        completed_load_categories: completedLoadCategories,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'property_id,staff_id,shift_date' },
    );
  if (upsertErr) {
    log.error('[laundry/complete] upsert failed', { requestId, msg: errToString(upsertErr), pid, staffId, date });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ saved: true }, { requestId });
}
