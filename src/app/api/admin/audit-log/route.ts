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
import { ok, err } from '@/lib/api-response';
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
  const propertyId = url.searchParams.get('propertyId');

  // admin_audit_log schema per migration 0054. Audit follow-up 2026-05-17.
  const AUDIT_LOG_FIELDS =
    'id, ts, actor_user_id, actor_email, action, target_type, target_id, metadata';
  let query = supabaseAdmin
    .from('admin_audit_log')
    .select(AUDIT_LOG_FIELDS)
    .order('ts', { ascending: false })
    .limit(limit);
  if (propertyId) {
    query = query.or(`metadata->>hotel_id.eq.${propertyId},target_id.eq.${propertyId}`);
  }

  const { data, error } = await query;
  if (error) return err(`audit-log query failed: ${error.message}`, { requestId, status: 500 });

  return ok({ entries: data ?? [] }, { requestId });
}
