/**
 * /api/admin/prospects — sales pipeline CRUD.
 *
 *   GET  → list every prospect (newest first, status grouped client-side)
 *   POST → create a prospect
 *
 * PATCH/DELETE per id live in [id]/route.ts.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { defineRoute, adminGate } from '@/lib/api-route';
import { writeAuditLog } from '@/lib/admin-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const VALID_STATUSES = new Set(['talking', 'negotiating', 'committed', 'onboarded', 'dropped']);

export const GET = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {

  const { data, error } = await supabaseAdmin
    .from('prospects')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return ctx.err(`prospects list failed: ${error.message}`, { status: 500 });
  return ctx.ok({ prospects: data ?? [] });
  },
});

export const POST = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {

  const body = await ctx.req.json().catch(() => ({}));
  const hotelName = (body.hotelName as string | undefined)?.trim();
  if (!hotelName) return ctx.err('hotelName is required', { status: 400 });

  const status = (body.status as string | undefined) ?? 'talking';
  if (!VALID_STATUSES.has(status)) return ctx.err(`invalid status: ${status}`, { status: 400 });

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
    .select('*')
    .single();

  if (error) return ctx.err(`prospect create failed: ${error.message}`, { status: 500 });

  await writeAuditLog({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: 'prospect.create',
    targetType: 'prospect',
    targetId: data.id as string,
    metadata: { hotelName, status },
  });

  return ctx.ok({ prospect: data });
  },
});
