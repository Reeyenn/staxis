/**
 * POST /api/feedback
 *
 * Submitted from the in-app feedback widget. Anyone signed in can post —
 * GMs, staff, owners. Admin reads via /api/admin/feedback.
 *
 * Server pulls user identity from the session; client supplies message
 * + category + (optionally) the active property they're attached to.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const VALID_CATEGORIES = new Set(['bug', 'feature_request', 'general', 'complaint', 'love']);

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => ({}));
  const message = (body.message as string | undefined)?.trim();
  if (!message) return err('message is required', { requestId, status: 400 });
  if (message.length > 10_000) return err('message too long (10k char limit)', { requestId, status: 400 });

  const category = (body.category as string | undefined) ?? 'general';
  if (!VALID_CATEGORIES.has(category)) {
    return err(`invalid category: ${category}`, { requestId, status: 400 });
  }

  // Pull user display name + email so we don't need a join later.
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('display_name, email')
    .eq('data_user_id', session.userId)
    .maybeSingle();

  const propertyId = (body.propertyId as string | undefined) ?? null;

  const { data, error } = await supabaseAdmin
    .from('user_feedback')
    .insert({
      property_id: propertyId,
      user_id: session.userId,
      user_email: (account?.email as string | undefined) ?? session.email ?? null,
      user_display_name: (account?.display_name as string | undefined) ?? null,
      message,
      category,
    })
    .select('id')
    .single();

  if (error) return err(`feedback insert failed: ${error.message}`, { requestId, status: 500 });
  return ok({ id: data.id }, { requestId });
}
