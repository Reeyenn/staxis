/**
 * GET /api/admin/pms-inbox — recent inbox activity (admin-only).
 *
 * Two views over the service-role-only inbox tables, both read here via
 * supabaseAdmin (the only read path):
 *   - `codes`    — last N Okta 2FA codes (0274), MASKED server-side (last 2
 *     digits only; the full code NEVER leaves the server) for the robot path.
 *   - `messages` — last N FULL inbound emails (0275) so an admin can click the
 *     Okta account-setup link. The raw `body_html` is NEVER serialized to the
 *     browser; we extract validated http(s) links from it HERE (extractLinks'
 *     scheme allowlist is the XSS gate) and ship only `bodyText` + `links`.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { maskCode, extractLinks } from '@/lib/pms-inbox/parse';

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

  // Full messages (0275). Read body_html ONLY to derive safe links — it is
  // never returned to the browser.
  const { data: msgData, error: msgError } = await supabaseAdmin
    .from('pms_inbox_messages')
    .select('id, property_id, email_to, from_addr, subject, body_text, body_html, received_at')
    .order('received_at', { ascending: false })
    .limit(50);
  if (msgError) {
    return err(`pms-inbox messages query failed: ${msgError.message}`, { requestId, status: 500 });
  }

  const messages = (msgData ?? []).map((r) => ({
    id: r.id as string,
    propertyId: r.property_id as string,
    emailTo: r.email_to as string,
    fromAddr: (r.from_addr as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    bodyText: (r.body_text as string | null) ?? null,
    // Scheme-validated http(s) links extracted server-side; raw HTML is dropped.
    links: extractLinks(r.body_html as string | null, r.body_text as string | null),
    receivedAt: r.received_at as string,
  }));

  return ok({ codes, messages }, { requestId });
}
