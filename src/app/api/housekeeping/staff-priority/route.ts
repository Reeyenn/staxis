/**
 * POST /api/housekeeping/staff-priority
 *
 * Persists a housekeeper's auto-assign eligibility. Writes
 * staff.schedule_priority:
 *   - 'priority'  → eligible, weighted first by the engine
 *   - 'normal'    → eligible (default)
 *   - 'excluded'  → never auto-placed (POST /auto-assign skips them)
 *
 * Caller: the "Automatic room assignment" picker on the person's card in
 * My Hotel → People (src/app/company/_components/PersonEmploymentForm.tsx).
 * It used to be the Schedule board's "★ Priority" modal, removed 2026-07-24
 * when that board became a view of today rather than a config surface; it then
 * lived in Staff → Directory until that screen was folded into My Hotel on
 * 2026-07-27. That picker is still the ONLY editor for this field anywhere.
 *
 * This route — not the browser's staff write — is deliberately the write
 * path, for the same reason as PUT /api/staff/wages: the anon client's
 * UPDATE can be filtered to zero rows by RLS without raising an error, and
 * a silent no-op here would leave a housekeeper permanently un-assignable
 * with an "EXCLUDED" badge nobody could clear. The update below `.select()`s
 * and 404s when it touched nothing.
 *
 * One staff per call. Scoped to housekeeping staff of a property the caller
 * can access, via the service-role client.
 *
 * Auth: requireSession (manager-facing) + property-access gate.
 *
 * Body: { propertyId: uuid, staffId: uuid, priority: 'priority'|'normal'|'excluded' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIORITIES = ['priority', 'normal', 'excluded'] as const;
type Priority = (typeof PRIORITIES)[number];

interface Body {
  propertyId?: unknown;
  staffId?: unknown;
  priority?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('invalid JSON body', { requestId, status: 400, code: 'validation_failed' });
  }

  const pidCheck = validateUuid(body.propertyId, 'propertyId');
  if (pidCheck.error) return err(pidCheck.error, { requestId, status: 400, code: 'validation_failed' });
  const staffCheck = validateUuid(body.staffId, 'staffId');
  if (staffCheck.error) return err(staffCheck.error, { requestId, status: 400, code: 'validation_failed' });
  if (!PRIORITIES.includes(body.priority as Priority)) {
    return err('priority must be one of: priority, normal, excluded', {
      requestId, status: 400, code: 'validation_failed',
    });
  }

  const propertyId = pidCheck.value!;
  const staffId = staffCheck.value!;
  const priority = body.priority as Priority;

  const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
  if (!hasAccess) {
    log.warn('staff-priority: forbidden — user lacks property access', {
      requestId, userId: auth.userId, propertyId,
    });
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: 'forbidden',
    });
  }

  try {
    // Scope the write to housekeeping staff of THIS property so a valid
    // session can't repoint another hotel's roster with two sprayed UUIDs.
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('staff')
      .update({ schedule_priority: priority })
      .eq('id', staffId)
      .eq('property_id', propertyId)
      .eq('department', 'housekeeping')
      .select('id');
    if (updErr) {
      log.error('staff-priority: update failed', { requestId, msg: updErr.message });
      return err('save failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    if (!updated || updated.length === 0) {
      return err('housekeeper not found for this property', {
        requestId, status: 404, code: 'not_found',
      });
    }

    log.info('staff-priority: ok', { requestId, propertyId, staffId, priority });
    return ok({ staffId, priority }, { requestId });
  } catch (e) {
    log.error('staff-priority: unexpected error', { requestId, msg: errToString(e) });
    return err('save failed', { requestId, status: 500, code: 'internal_error' });
  }
}
