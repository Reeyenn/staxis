/**
 * GET /api/feed/lifecycle?pid=<property UUID>
 *
 * The lifecycle rail is a read-only, tenant-scoped projection.  It never
 * reads raw evidence or accepts a caller-supplied owner/source and it never
 * turns a missing database view into an empty success response.
 */
import type { NextRequest } from 'next/server';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import { err, ApiErrorCode, ok } from '@/lib/api-response';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { LIFECYCLE_CONTRACT_VERSION, parseLifecycleProjectionRow, type LifecycleProjection } from '@/lib/staxis/lifecycle';

// commsContext performs requireSession + userHasPropertyAccess for the exact pid
// before this service-role projection read; keep the guard visible to the
// static tenant-scope audit as well as to the shared helper implementation.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;
const PROJECTION_LIMIT = 100;

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'), ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  const { data, error } = await supabaseAdmin
    .from('staxis_lifecycle_projection_v1')
    .select('*')
    .eq('property_id', ctx.pid)
    .order('recorded_at', { ascending: false })
    .limit(PROJECTION_LIMIT + 1);
  if (error) {
    // A missing/stale projection is not evidence that nothing happened. Keep
    // the distinction visible to the caller and to telemetry.
    return err('Lifecycle projection is unavailable', {
      requestId: ctx.requestId,
      status: 503,
      code: ApiErrorCode.InternalError,
      headers: ctx.headers,
    });
  }

  if (!Array.isArray(data)) {
    return err('Lifecycle projection failed integrity checks', {
      requestId: ctx.requestId,
      status: 503,
      code: ApiErrorCode.InternalError,
      headers: ctx.headers,
    });
  }
  const items: LifecycleProjection[] = [];
  for (const row of data) {
    const parsed = parseLifecycleProjectionRow(row);
    if (!parsed) {
      return err('Lifecycle projection failed integrity checks', {
        requestId: ctx.requestId,
        status: 503,
        code: ApiErrorCode.InternalError,
        headers: ctx.headers,
      });
    }
    items.push(parsed);
  }
  const truncated = items.length > PROJECTION_LIMIT;

  return ok({
    contractVersion: LIFECYCLE_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    items: items.slice(0, PROJECTION_LIMIT),
    coverage: {
      returned: Math.min(items.length, PROJECTION_LIMIT),
      limit: PROJECTION_LIMIT,
      truncated,
    },
  }, { requestId: ctx.requestId, headers: ctx.headers });
}
