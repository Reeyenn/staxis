/**
 * /api/admin/prospects — sales pipeline CRUD.
 *
 *   GET  → list every prospect (newest first, status grouped client-side)
 *   POST → create a prospect
 *
 * PATCH/DELETE per id live in [id]/route.ts.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { writeAuditLog } from '@/lib/admin-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const VALID_STATUSES = new Set(['talking', 'negotiating', 'committed', 'onboarded', 'dropped']);

// prospects schema per migration 0050. Audit follow-up 2026-05-17.
const PROSPECT_FIELDS =
  'id, hotel_name, contact_name, contact_email, contact_phone, pms_type, ' +
  'expected_launch_date, status, notes, checklist, created_at, updated_at';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await supabaseAdmin
    .from('prospects')
    .select(PROSPECT_FIELDS)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return err(`prospects list failed: ${error.message}`, { requestId, status: 500 });
  return ok({ prospects: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const hotelName = (body.hotelName as string | undefined)?.trim();
  if (!hotelName) return err('hotelName is required', { requestId, status: 400 });

  const status = (body.status as string | undefined) ?? 'talking';
  if (!VALID_STATUSES.has(status)) return err(`invalid status: ${status}`, { requestId, status: 400 });

  const { data, error } = await supabaseAdmin
    .from('prospects')
    .insert({
      hotel_name: hotelName,
      contact_name: body.contactName ?? null,
      contact_email: body.contactEmail ?? null,
      contact_phone: body.contactPhone ?? null,
      pms_type: body.pmsType ?? null,
      expected_launch_date: body.expectedLaunchDate ?? null,
      status,
      notes: body.notes ?? null,
      checklist: body.checklist ?? {},
    })
    .select(PROSPECT_FIELDS)
    .single<Record<string, unknown>>();

  if (error || !data) return err(`prospect create failed: ${error?.message ?? 'unknown'}`, { requestId, status: 500 });

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: 'prospect.create',
    targetType: 'prospect',
    targetId: data.id as string,
    metadata: { hotelName, status },
  });

  return ok({ prospect: data }, { requestId });
}
