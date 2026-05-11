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
import { validateUuid } from '@/lib/api-validate';

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

  // Pull user display name + email AND property_access in one round-trip
  // so we can both denormalize identity onto the feedback row AND verify
  // the caller has access to whatever propertyId they're claiming. Without
  // the capability check, a signed-in team member of Hotel A could submit
  // feedback tagged with Hotel B's id (admin's "feedback by hotel" view
  // would attribute the complaint to the wrong property).
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('display_name, email, role, property_access')
    .eq('data_user_id', session.userId)
    .maybeSingle();

  // propertyId is optional — feedback CAN be untagged (a generic "love this
  // app" from a multi-property owner). But when supplied it must be a valid
  // UUID and within the caller's property_access (admins bypass).
  let propertyId: string | null = null;
  if (body.propertyId !== undefined && body.propertyId !== null && body.propertyId !== '') {
    const pidCheck = validateUuid(body.propertyId, 'propertyId');
    if (pidCheck.error) return err(pidCheck.error, { requestId, status: 400 });
    const claimedPid = pidCheck.value!;
    const isAdmin = account?.role === 'admin';
    const access = Array.isArray(account?.property_access) ? account!.property_access : [];
    if (!isAdmin && !access.includes(claimedPid)) {
      return err('You do not have access to that property', { requestId, status: 403 });
    }
    propertyId = claimedPid;
  }

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
