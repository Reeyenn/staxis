/**
 * POST /api/events
 *
 * Client-side event firehose. Used by the activity tracker to log
 * page views and feature uses scoped to the user's active property.
 *
 * Caller passes:
 *   - eventType  — e.g. 'page_view', 'feature_use', 'staff_confirm'
 *   - propertyId — the active property the user is viewing
 *   - metadata   — anything extra (path, button id, etc.)
 *
 * Server determines user_id and user_role from the session — never
 * trust the client to claim them. Admin (role='admin') events are
 * still written but flagged so the engagement panel can filter them
 * out without losing them entirely.
 *
 * Best-effort: failures are swallowed to never break the UI.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { recordAppEvent } from '@/lib/event-recorder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 5;

const ALLOWED_TYPES = new Set([
  'page_view',
  'feature_use',
  'staff_confirm',
  'sms_sent_internal',
  'pms_sync_triggered',
]);

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => ({}));
  const eventType = body.eventType as string | undefined;
  if (!eventType || !ALLOWED_TYPES.has(eventType)) {
    return err(`invalid eventType: ${eventType}`, { requestId, status: 400 });
  }

  const propertyId = body.propertyId as string | undefined;
  // propertyId is allowed to be null — admin pages don't have a property
  // context. We still log so admin behavior is auditable separately.

  // Look up user role once. Cheap; cached locally per instance.
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('role')
    .eq('data_user_id', session.userId)
    .maybeSingle();

  const userRole = (account?.role as string | undefined) ?? null;

  const metadata = (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata))
    ? body.metadata
    : {};

  // recordAppEvent handles insert failure (structured console.error +
  // rate-limited Sentry escalation) — never throws.
  await recordAppEvent({
    property_id: propertyId ?? null,
    user_id: session.userId,
    user_role: userRole,
    event_type: eventType,
    metadata,
  });

  return ok({ logged: true }, { requestId });
}
