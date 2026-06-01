// Shared time-off decision logic.
//
// A manager approving/denying a time-off request runs the SAME core steps
// whether the decision arrives over HTTP (PUT /api/staff-schedule/time-off)
// or through the AI assistant (the `decide_time_off` agent tool). That core —
// load the pending request, stamp the decision, and on approve auto-remove the
// matching scheduled shift — lives here so the two surfaces can never drift
// apart. Both callers do their OWN auth/role gate first, then hand a resolved
// (hotelId, requestId) to this helper.
//
// Server-only: imports supabaseAdmin (which carries `import 'server-only'`).
// Never import this from a client component.

import { supabaseAdmin } from '@/lib/supabase-admin';

export type TimeOffDecision = 'approve' | 'deny';

export type DecideTimeOffResult =
  | {
      ok: true;
      /** True when an approve also deleted a scheduled shift for that day. */
      removedShift: boolean;
      staffId: string;
      requestDate: string;
    }
  | {
      ok: false;
      /** Stable reason the caller maps to its own error envelope. */
      reason: 'load_failed' | 'not_found' | 'already_decided' | 'update_failed';
    };

/**
 * Apply a manager's approve/deny decision to a pending time-off request,
 * scoped to a single property. On approve, the matching scheduled_shifts row
 * (same staff + date, kind='shift') is auto-removed so the day reads as off —
 * identical to the long-standing PUT behaviour.
 *
 * Caller MUST have already authorized the manager for `hotelId`. This helper
 * does NOT check roles; it only enforces that the request exists at the
 * property and is still pending (so a double-decide is rejected).
 */
export async function applyTimeOffDecision(opts: {
  hotelId: string;
  requestId: string;
  decision: TimeOffDecision;
  denyReason?: string | null;
  /** accounts.id of the deciding manager, or null. */
  decidedBy: string | null;
}): Promise<DecideTimeOffResult> {
  const { hotelId, requestId, decision, denyReason, decidedBy } = opts;

  // Load the request so we know which (staff, date) tuple to auto-remove and
  // so we can refuse a request that doesn't belong to this property.
  const { data: tor, error: torErr } = await supabaseAdmin
    .from('time_off_requests')
    .select('*')
    .eq('id', requestId)
    .eq('property_id', hotelId)
    .maybeSingle();
  if (torErr) return { ok: false, reason: 'load_failed' };
  if (!tor) return { ok: false, reason: 'not_found' };
  if (tor.status !== 'pending') return { ok: false, reason: 'already_decided' };

  const update: Record<string, unknown> = {
    status: decision === 'approve' ? 'approved' : 'denied',
    decided_at: new Date().toISOString(),
    decided_by: decidedBy,
  };
  if (decision === 'deny' && denyReason?.trim()) {
    update.deny_reason = denyReason.trim();
  }

  // Conditional update — re-assert status='pending' in the WHERE so only the
  // caller that still sees a pending row wins. Closes the read-then-write race
  // when two managers (or a manager + the agent tool) decide the same request
  // at once: the loser matches 0 rows and is reported as already-decided
  // instead of silently clobbering the winner's decision.
  const { error: upErr, count } = await supabaseAdmin
    .from('time_off_requests')
    .update(update, { count: 'exact' })
    .eq('id', requestId)
    .eq('property_id', hotelId)
    .eq('status', 'pending');
  if (upErr) return { ok: false, reason: 'update_failed' };
  if ((count ?? 0) === 0) return { ok: false, reason: 'already_decided' };

  // On approve, auto-remove the scheduled shift for that staff+date. A failure
  // here does NOT fail the decision — the request is already approved and the
  // manager can unassign manually (matches the original route semantics).
  let removedShift = false;
  if (decision === 'approve') {
    const { error: delErr, count } = await supabaseAdmin
      .from('scheduled_shifts')
      .delete({ count: 'exact' })
      .eq('property_id', hotelId)
      .eq('staff_id', tor.staff_id)
      .eq('shift_date', tor.request_date)
      .eq('kind', 'shift');
    if (!delErr && (count ?? 0) > 0) removedShift = true;
  }

  return {
    ok: true,
    removedShift,
    staffId: String(tor.staff_id),
    requestDate: String(tor.request_date),
  };
}
