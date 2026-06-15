/**
 * POST /api/admin/access/apply-to-all
 * Body: { propertyId }  — the source hotel whose setup to copy.
 *
 * Admin-only. Replaces every OTHER hotel's capability restrictions with a copy
 * of the source hotel's. Admin-only capabilities are never in the table, so they
 * can't leak through here.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { requireAdmin } from '@/lib/admin-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isCapabilityKey, isHotelRole } from '@/lib/capabilities/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { propertyId?: unknown }

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const idCheck = validateUuid(body.propertyId, 'propertyId');
  if (idCheck.error || !idCheck.value) {
    return err('propertyId is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const source = idCheck.value;

  // Source hotel's restrictions (defensively filtered to known caps/roles).
  const { data: sourceRows, error: srcErr } = await supabaseAdmin
    .from('capability_overrides')
    .select('capability, role, allowed')
    .eq('property_id', source);
  if (srcErr) return err('could not read source hotel', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  const rows = (sourceRows ?? []).filter(
    (r) => isCapabilityKey(r.capability) && isHotelRole(r.role),
  );

  // Every other hotel.
  const { data: props, error: propErr } = await supabaseAdmin.from('properties').select('id');
  if (propErr) return err('could not list hotels', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  const targets = (props ?? []).map((p) => (p as { id: string }).id).filter((id) => id && id !== source);

  let applied = 0;
  for (const targetId of targets) {
    const { error: delErr } = await supabaseAdmin
      .from('capability_overrides')
      .delete()
      .eq('property_id', targetId);
    if (delErr) continue; // skip a hotel we couldn't clear rather than abort the batch
    if (rows.length > 0) {
      const { error: insErr } = await supabaseAdmin.from('capability_overrides').insert(
        rows.map((r) => ({
          property_id: targetId,
          capability: r.capability,
          role: r.role,
          allowed: r.allowed,
          updated_by: auth.accountId,
        })),
      );
      if (insErr) continue;
    }
    applied += 1;
  }

  return ok({ source, hotelsUpdated: applied }, { requestId });
}
