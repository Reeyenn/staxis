/**
 * GET  /api/admin/feedback
 * PATCH /api/admin/feedback   — body: { id, status, adminNote? }
 *
 * Admin inbox reader + status updater. GET returns up to 200 rows
 * newest-first with property name joined; PATCH transitions a single
 * feedback row's status (new → in_progress / resolved / wontfix).
 *
 * PATCH lives on the same route (not a [id] sub-route) for simplicity —
 * the inbox UI passes the id in the body.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { defineRoute, adminGate } from '@/lib/api-route';
import { writeAuditLog } from '@/lib/admin-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const VALID_STATUSES = new Set(['new', 'in_progress', 'resolved', 'wontfix']);

export const GET = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {

  const { data, error } = await supabaseAdmin
    .from('user_feedback')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return ctx.err(`feedback list failed: ${error.message}`, { status: 500 });

  // Resolve property names
  const propertyIds = Array.from(new Set((data ?? []).map((r) => (r as { property_id: string | null }).property_id).filter((v): v is string => !!v)));
  let nameById = new Map<string, string | null>();
  if (propertyIds.length > 0) {
    const { data: nameRows } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .in('id', propertyIds);
    nameById = new Map((nameRows ?? []).map((r) => [(r as { id: string; name: string | null }).id, (r as { id: string; name: string | null }).name]));
  }

  type FeedbackRow = { property_id: string | null; status: string; [k: string]: unknown };
  const enriched = (data ?? []).map((row) => {
    const r = row as FeedbackRow;
    return { ...r, property_name: r.property_id ? (nameById.get(r.property_id) ?? null) : null };
  });

  const counts = {
    new: enriched.filter((r) => r.status === 'new').length,
    inProgress: enriched.filter((r) => r.status === 'in_progress').length,
    total: enriched.length,
  };

  return ctx.ok({ feedback: enriched, counts });
  },
});

export const PATCH = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {

  const body = await ctx.req.json().catch(() => ({}));
  const id = body.id as string | undefined;
  const status = body.status as string | undefined;
  const adminNote = body.adminNote as string | undefined;

  if (!id) return ctx.err('id is required', { status: 400 });
  if (status && !VALID_STATUSES.has(status)) {
    return ctx.err(`invalid status: ${status}`, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (status) {
    update.status = status;
    if (status === 'resolved' || status === 'wontfix') {
      update.resolved_at = new Date().toISOString();
    } else {
      update.resolved_at = null;
    }
  }
  if (typeof adminNote === 'string') update.admin_note = adminNote;

  if (Object.keys(update).length === 0) {
    return ctx.err('no fields to update', { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('user_feedback')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) return ctx.err(`feedback update failed: ${error.message}`, { status: 500 });

  await writeAuditLog({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: 'feedback.update',
    targetType: 'feedback',
    targetId: id,
    metadata: { status: status ?? null },
  });

  return ctx.ok({ feedback: data });
  },
});
