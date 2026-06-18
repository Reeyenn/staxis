/**
 * GET /api/admin/coverage/hotels?pmsFamily=<family>
 *   → { ok, data: { hotels: [{ id, name, attached, pmsType, sessionStatus }] } }
 *
 * feature/coverage-hotel-list-delete — every hotel + whether it's attached to
 * the given PMS family (pms_type === family) and its current session status.
 *
 * Powers the per-hotel detach/attach list in the PMS coverage modal and the
 * Switch/Detach controls on Live Hotels. Attached hotels are listed first.
 *
 * Read-only. Auth: requireAdmin. supabaseAdmin (deny-all-browser RLS).
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { isPMSType } from '@/lib/pms/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PropRow { id: string; name: string | null; pms_type: string | null }
interface SessRow { property_id: string; status: string | null }

export interface CoverageHotel {
  id: string;
  name: string | null;
  attached: boolean;
  pmsType: string | null;
  sessionStatus: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const pmsFamily = req.nextUrl.searchParams.get('pmsFamily');
  if (!isPMSType(pmsFamily) || pmsFamily === 'other') {
    return err('pmsFamily must be a known PMS family', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { data: propRows, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id, name, pms_type')
    .order('name', { ascending: true });
  if (propErr) {
    return err('could not load hotels', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }

  const { data: sessRows, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select('property_id, status');
  if (sessErr) {
    return err('could not load sessions', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }
  const sessByProp = new Map<string, string | null>();
  for (const s of (sessRows ?? []) as SessRow[]) sessByProp.set(s.property_id, s.status);

  const hotels: CoverageHotel[] = ((propRows ?? []) as PropRow[]).map((p) => ({
    id: p.id,
    name: p.name,
    attached: p.pms_type === pmsFamily,
    pmsType: p.pms_type,
    sessionStatus: sessByProp.get(p.id) ?? null,
  }));

  // Attached hotels first, then by name (already name-ordered from the query).
  hotels.sort((a, b) => (a.attached === b.attached ? 0 : a.attached ? -1 : 1));

  return ok({ hotels }, { requestId });
}
