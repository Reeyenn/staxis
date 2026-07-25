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
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

// Kept in lock-step with the CHECK constraint on user_feedback.category
// (originally migration 0052, widened by 0350). Adding a category here without
// the migration means every such insert is rejected by Postgres.
//   ai_answer — a thumbs verdict on one AI answer/action, carrying decisionId.
//   ai_wrong  — "the AI got this wrong". Resolving one obliges naming the
//               permanent eval case that now covers it.
const VALID_CATEGORIES = new Set([
  'bug', 'feature_request', 'general', 'complaint', 'love', 'ai_answer', 'ai_wrong',
]);

/** Categories that must reference the decision they are about. A thumbs-down
 *  with no decision id is an opinion; with one it is a labelled example. */
const DECISION_LINKED_CATEGORIES = new Set(['ai_answer']);

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => ({}));
  const rawMessage = (body.message as string | undefined)?.trim();
  // A thumbs click carries a rating and no words. Requiring prose there would
  // mean the cheapest, most-used signal never gets collected — so a
  // decision-linked rating supplies its own message.
  const isThumbsOnly =
    !rawMessage
    && body.category === 'ai_answer'
    && (body.rating === -1 || body.rating === 0 || body.rating === 1);
  const message = rawMessage || (isThumbsOnly
    ? (body.rating === 1 ? 'thumbs up' : body.rating === -1 ? 'thumbs down' : 'neutral')
    : undefined);
  if (!message) return err('message is required', { requestId, status: 400 });
  if (message.length > 10_000) return err('message too long (10k char limit)', { requestId, status: 400 });

  const category = (body.category as string | undefined) ?? 'general';
  if (!VALID_CATEGORIES.has(category)) {
    return err(`invalid category: ${category}`, { requestId, status: 400 });
  }

  // Optional link to the AI decision this feedback is about (migration 0350).
  // A DB trigger mirrors the rating onto agent_decisions, so the corpus read
  // path stays single-table and cannot drift from the feedback row.
  let decisionId: string | null = null;
  if (body.decisionId !== undefined && body.decisionId !== null && body.decisionId !== '') {
    const check = validateUuid(body.decisionId, 'decisionId');
    if (check.error) return err(check.error, { requestId, status: 400 });
    decisionId = check.value!;
  }
  if (DECISION_LINKED_CATEGORIES.has(category) && !decisionId) {
    return err(`category ${category} requires decisionId`, { requestId, status: 400 });
  }

  let rating: number | null = null;
  if (body.rating !== undefined && body.rating !== null) {
    const n = Number(body.rating);
    if (![-1, 0, 1].includes(n)) {
      return err('rating must be -1, 0 or 1', { requestId, status: 400 });
    }
    rating = n;
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
      decision_id: decisionId,
      rating,
    })
    .select('id')
    .single();

  if (error) {
    log.error('[feedback:POST] insert failed', { requestId, msg: error.message });
    return err('Failed to submit feedback', { requestId, status: 500 });
  }
  return ok({ id: data.id }, { requestId });
}
