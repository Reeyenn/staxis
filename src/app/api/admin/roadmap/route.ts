/**
 * /api/admin/roadmap — Reeyen's personal product TODO.
 *
 *   GET   → list all
 *   POST  → create one (body: title, description?, priority?, status?)
 *   PATCH → update one (body: id, partial fields)
 *   DELETE → remove one (body: id)
 *
 * No [id] sub-route on purpose — admin-only single-user CRUD is fine in
 * one file. All mutations are audited.
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

const VALID_STATUSES = new Set(['idea', 'planned', 'in_progress', 'done', 'dropped']);

// roadmap_items schema per migration 0053. Audit follow-up 2026-05-17.
const ROADMAP_FIELDS = 'id, title, description, status, priority, created_at, updated_at, done_at';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await supabaseAdmin
    .from('roadmap_items')
    .select(ROADMAP_FIELDS)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) return err(`roadmap list failed: ${error.message}`, { requestId, status: 500 });
  return ok({ items: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const title = (body.title as string | undefined)?.trim();
  if (!title) return err('title is required', { requestId, status: 400 });

  const status = (body.status as string | undefined) ?? 'idea';
  if (!VALID_STATUSES.has(status)) return err(`invalid status: ${status}`, { requestId, status: 400 });

  const { data, error } = await supabaseAdmin
    .from('roadmap_items')
    .insert({
      title,
      description: body.description ?? null,
      status,
      priority: typeof body.priority === 'number' ? body.priority : 0,
    })
    .select(ROADMAP_FIELDS)
    .single();

  if (error) return err(`roadmap create failed: ${error.message}`, { requestId, status: 500 });

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: 'roadmap.create',
    targetType: 'roadmap_item',
    targetId: data.id as string,
    metadata: { title, status },
  });

  return ok({ item: data }, { requestId });
}

export async function PATCH(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const id = body.id as string | undefined;
  if (!id) return err('id is required', { requestId, status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.title === 'string') update.title = body.title;
  if ('description' in body) update.description = body.description;
  if (typeof body.priority === 'number') update.priority = body.priority;
  if (typeof body.status === 'string') {
    if (!VALID_STATUSES.has(body.status)) return err(`invalid status: ${body.status}`, { requestId, status: 400 });
    update.status = body.status;
    if (body.status === 'done') update.done_at = new Date().toISOString();
    else update.done_at = null;
  }

  if (Object.keys(update).length === 0) return err('no fields to update', { requestId, status: 400 });

  const { data, error } = await supabaseAdmin
    .from('roadmap_items')
    .update(update)
    .eq('id', id)
    .select(ROADMAP_FIELDS)
    .single();

  if (error) return err(`roadmap update failed: ${error.message}`, { requestId, status: 500 });

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: 'roadmap.update',
    targetType: 'roadmap_item',
    targetId: id,
    metadata: { fields: Object.keys(update) },
  });

  return ok({ item: data }, { requestId });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const id = body.id as string | undefined;
  if (!id) return err('id is required', { requestId, status: 400 });

  const { error } = await supabaseAdmin
    .from('roadmap_items')
    .delete()
    .eq('id', id);

  if (error) return err(`roadmap delete failed: ${error.message}`, { requestId, status: 500 });

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: 'roadmap.delete',
    targetType: 'roadmap_item',
    targetId: id,
  });

  return ok({ deleted: true }, { requestId });
}
