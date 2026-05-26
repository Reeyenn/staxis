/**
 * GET /api/portfolio/properties
 *
 * Returns the lightweight list of properties the logged-in user can
 * access (id, name, totalRooms, timezone). Used by the /portfolio page
 * + the property switcher dropdown to show "all my hotels" without
 * pulling the heavy KPI payload from /tiles.
 *
 * Auth: requireSession. Reads accounts.property_access via supabaseAdmin
 * (bypasses RLS) so the route works identically for admin-role users
 * (wildcard '*') and regular owners (per-id array).
 *
 * Rate-limit: 600/hr per user (hashed auth user id) — see api-ratelimit.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const rlKey = hashToRateLimitKey(auth.userId);
  const rl = await checkAndIncrementRateLimit('portfolio-properties', rlKey);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Read the caller's account row to discover their property_access
  // array + role. Admin → wildcard; everyone else → explicit array.
  const { data: accountRow, error: accountErr } = await supabaseAdmin
    .from('accounts')
    .select('role, property_access')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (accountErr) {
    log.error('[portfolio/properties] accounts lookup failed', {
      requestId, userId: auth.userId, err: accountErr.message,
    });
    return err('account lookup failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // No account row → no properties (covers brand-new auth.users with no
  // accounts insert yet, e.g. during onboarding).
  if (!accountRow) {
    return ok({ properties: [] }, { requestId });
  }

  const role = String(accountRow.role ?? '');
  const accessArr: string[] = Array.isArray(accountRow.property_access)
    ? (accountRow.property_access as string[])
    : [];
  const isAdmin = role === 'admin' || accessArr.includes('*');

  let propertiesQuery = supabaseAdmin
    .from('properties')
    .select('id, name, total_rooms, timezone');
  if (!isAdmin) {
    if (accessArr.length === 0) {
      return ok({ properties: [] }, { requestId });
    }
    propertiesQuery = propertiesQuery.in('id', accessArr);
  }
  const { data: rows, error: propsErr } = await propertiesQuery;
  if (propsErr) {
    log.error('[portfolio/properties] properties read failed', {
      requestId, userId: auth.userId, err: propsErr.message,
    });
    return err('property read failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  type Row = { id: string; name: string; total_rooms: number; timezone: string | null };
  const properties = (rows as Row[]).map(r => ({
    id: r.id,
    name: r.name,
    totalRooms: r.total_rooms,
    timezone: r.timezone,
  }));
  // Sort by name for a stable grid order. Use locale-aware sort so
  // "Hotel B" comes before "Hotel a" the same way the existing nav
  // does (this is what owners expect when scanning).
  properties.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return ok({ properties }, { requestId });
}
