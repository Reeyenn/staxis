/**
 * GET /api/admin/pms-inbox — last N Okta 2FA codes, MASKED (admin-only).
 *
 * Lets an admin confirm the inbox pipeline is delivering codes (e.g. during
 * the pilot) without ever exposing a usable code. Masking happens HERE, on the
 * server — the full `code` column is read but only the last-2-digit mask is
 * serialized to the browser. The table itself is service-role-only (0274), so
 * this admin route is the only read path.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { maskCode } from '@/lib/pms-inbox/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await supabaseAdmin
    .from('pms_auth_codes')
    .select('id, property_id, email_to, source, code, sender, subject, received_at, consumed_at')
    .order('received_at', { ascending: false })
    .limit(30);
  if (error) {
    return err(`pms-inbox query failed: ${error.message}`, { requestId, status: 500 });
  }

  const codes = (data ?? []).map((r) => ({
    id: r.id as string,
    propertyId: r.property_id as string,
    emailTo: r.email_to as string,
    source: r.source as string,
    // Server-side mask — the full code NEVER leaves the server.
    codeMasked: maskCode(String(r.code ?? '')),
    sender: (r.sender as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    receivedAt: r.received_at as string,
    consumedAt: (r.consumed_at as string | null) ?? null,
  }));

  return ok({ codes }, { requestId });
}
