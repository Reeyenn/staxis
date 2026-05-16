/**
 * GET /api/admin/audit-log
 *
 * Read-only feed of admin actions. Used by the System tab to show
 * "what did Reeyen (or future teammates) click recently."
 *
 * Sort: newest first. Default limit 100, ?limit=N up to 500.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
  // Optional ?propertyId=... — filters to events tagged with metadata.hotel_id
  // matching the property OR target_id matching the property. Used by
  // /admin/properties/[id] for the per-hotel audit panel.
  // Security review 2026-05-16 (Pattern D): validate as UUID BEFORE
  // interpolating into the PostgREST .or() filter — without this an
  // admin could (intentionally or accidentally) inject extra filter
  // fragments via the query string. Admin gate limits blast radius to
  // "admin shoots own foot" but consistency-with-the-rest-of-the-codebase
  // is the bar.
  const propertyIdRaw = url.searchParams.get('propertyId');
  let propertyId: string | null = null;
  if (propertyIdRaw) {
    const v = validateUuid(propertyIdRaw, 'propertyId');
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    propertyId = v.value!;
  }

  let query = supabaseAdmin
    .from('admin_audit_log')
    .select('*')
    .order('ts', { ascending: false })
    .limit(limit);
  if (propertyId) {
    query = query.or(`metadata->>hotel_id.eq.${propertyId},target_id.eq.${propertyId}`);
  }

  const { data, error } = await query;
  if (error) return err(`audit-log query failed: ${error.message}`, { requestId, status: 500 });

  return ok({ entries: data ?? [] }, { requestId });
}
