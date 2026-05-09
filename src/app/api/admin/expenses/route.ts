/**
 * /api/admin/expenses — Money tab CRUD.
 *
 *   GET    → list expenses (newest first, last 12 months by default)
 *   POST   → create one
 *   PATCH  → update one
 *   DELETE → remove one
 *
 * Auto-rolled-up Claude API spend (source='auto') lives in the same
 * table; the manual-entry flow flips to source='manual' on insert.
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

const VALID_CATEGORIES = new Set([
  'claude_api', 'hosting', 'twilio', 'supabase', 'vercel', 'fly', 'other',
]);

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const monthsBack = Math.min(parseInt(url.searchParams.get('monthsBack') ?? '12', 10) || 12, 60);
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);

  const { data, error } = await supabaseAdmin
    .from('expenses')
    .select('*')
    .gte('incurred_on', since.toISOString().slice(0, 10))
    .order('incurred_on', { ascending: false })
    .limit(500);

  if (error) return err(`expenses list failed: ${error.message}`, { requestId, status: 500 });
  return ok({ expenses: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const category = body.category as string | undefined;
  if (!category || !VALID_CATEGORIES.has(category)) {
    return err(`invalid category: ${category}`, { requestId, status: 400 });
  }

  const amountCents = body.amountCents as number | undefined;
  if (typeof amountCents !== 'number' || !Number.isFinite(amountCents)) {
    return err('amountCents must be a number', { requestId, status: 400 });
  }

  const incurredOn = (body.incurredOn as string | undefined) ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await supabaseAdmin
    .from('expenses')
    .insert({
      category,
      amount_cents: Math.round(amountCents),
      description: body.description ?? null,
      vendor: body.vendor ?? null,
      incurred_on: incurredOn,
      source: 'manual',
      property_id: body.propertyId ?? null,
      metadata: body.metadata ?? {},
    })
    .select('*')
    .single();

  if (error) return err(`expense create failed: ${error.message}`, { requestId, status: 500 });

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: 'expense.create',
    targetType: 'expense',
    targetId: data.id as string,
    metadata: { category, amountCents, incurredOn },
  });

  return ok({ expense: data }, { requestId });
}

export async function PATCH(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const id = body.id as string | undefined;
  if (!id) return err('id is required', { requestId, status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.category === 'string') {
    if (!VALID_CATEGORIES.has(body.category)) return err(`invalid category`, { requestId, status: 400 });
    update.category = body.category;
  }
  if (typeof body.amountCents === 'number') update.amount_cents = Math.round(body.amountCents);
  if ('description' in body) update.description = body.description;
  if ('vendor' in body) update.vendor = body.vendor;
  if (typeof body.incurredOn === 'string') update.incurred_on = body.incurredOn;
  if ('propertyId' in body) update.property_id = body.propertyId;

  if (Object.keys(update).length === 0) return err('no fields to update', { requestId, status: 400 });

  const { data, error } = await supabaseAdmin
    .from('expenses')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) return err(`expense update failed: ${error.message}`, { requestId, status: 500 });

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: 'expense.update',
    targetType: 'expense',
    targetId: id,
    metadata: { fields: Object.keys(update) },
  });

  return ok({ expense: data }, { requestId });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const id = body.id as string | undefined;
  if (!id) return err('id is required', { requestId, status: 400 });

  const { error } = await supabaseAdmin
    .from('expenses')
    .delete()
    .eq('id', id);

  if (error) return err(`expense delete failed: ${error.message}`, { requestId, status: 500 });

  await writeAuditLog({
    actorUserId: auth.userId,
    actorEmail: auth.email,
    action: 'expense.delete',
    targetType: 'expense',
    targetId: id,
  });

  return ok({ deleted: true }, { requestId });
}
