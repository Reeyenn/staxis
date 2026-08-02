/**
 * /api/admin/prospects/[id] — per-prospect update & delete.
 *
 *   PATCH  → partial update (status, notes, checklist, etc.)
 *   DELETE → remove permanently (rare; use status='dropped' for soft)
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { defineRoute, adminGate } from '@/lib/api-route';
import { writeAuditLog } from '@/lib/admin-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const VALID_STATUSES = new Set(['talking', 'negotiating', 'committed', 'onboarded', 'dropped']);
type AdminGateResult = Awaited<ReturnType<typeof adminGate>>;

export const PATCH = defineRoute<AdminGateResult, unknown, { id: string }>({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {

  const { id } = await ctx.params;
  const body = await ctx.req.json().catch(() => ({}));

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
      return ctx.err(`invalid status: ${body.status}`, { status: 400 });
    }
    update.status = body.status;
  }

  if (Object.keys(update).length === 0) {
    return ctx.err('no fields to update', { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('prospects')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) return ctx.err(`prospect update failed: ${error.message}`, { status: 500 });

  await writeAuditLog({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: 'prospect.update',
    targetType: 'prospect',
    targetId: id,
    metadata: { fields: Object.keys(update) },
  });

  return ctx.ok({ prospect: data });
  },
});

export const DELETE = defineRoute<AdminGateResult, unknown, { id: string }>({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {

  const { id } = await ctx.params;
  const { error } = await supabaseAdmin
    .from('prospects')
    .delete()
    .eq('id', id);

  if (error) return ctx.err(`prospect delete failed: ${error.message}`, { status: 500 });

  await writeAuditLog({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: 'prospect.delete',
    targetType: 'prospect',
    targetId: id,
  });

  return ctx.ok({ deleted: true });
  },
});
