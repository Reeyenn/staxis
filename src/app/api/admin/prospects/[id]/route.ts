/**
 * /api/admin/prospects/[id] — per-prospect update & delete.
 *
 *   PATCH  → partial update (status, notes, checklist, etc.)
 *   DELETE → remove permanently (rare; use status='dropped' for soft)
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

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const update: Record<string, unknown> = {};
  if (typeof body.hotelName === 'string') update.hotel_name = body.hotelName;
  if ('contactName' in body) update.contact_name = body.contactName;
  if ('contactEmail' in body) update.contact_email = body.contactEmail;
  if ('contactPhone' in body) update.contact_phone = body.contactPhone;
  if ('pmsType' in body) update.pms_type = body.pmsType;
  if ('expectedLaunchDate' in body) update.expected_launch_date = body.expectedLaunchDate;
  if ('notes' in body) update.notes = body.notes;
  if ('checklist' in body) update.checklist = body.checklist;
  if (typeof body.status === 'string') {
    if (!VALID_STATUSES.has(body.status)) {
      return err(`invalid status: ${body.status}`, { requestId, status: 400 });
    }
    update.status = body.status;
  }

  if (Object.keys(update).length === 0) {
    return err('no fields to update', { requestId, status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('prospects')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) return err(`prospect update failed: ${error.message}`, { requestId, status: 500 });

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: 'prospect.update',
    targetType: 'prospect',
    targetId: id,
    metadata: { fields: Object.keys(update) },
  });

  return ok({ prospect: data }, { requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const { error } = await supabaseAdmin
    .from('prospects')
    .delete()
    .eq('id', id);

  if (error) return err(`prospect delete failed: ${error.message}`, { requestId, status: 500 });

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: 'prospect.delete',
    targetType: 'prospect',
    targetId: id,
  });

  return ok({ deleted: true }, { requestId });
}
