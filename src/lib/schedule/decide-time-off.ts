// Shared time-off decision logic.
//
// A manager approving/denying a time-off request runs the SAME core steps
// whether the decision arrives over HTTP (PUT /api/staff-schedule/time-off)
// or through the AI assistant (the `decide_time_off` agent tool). That core —
// lock the pending request, stamp the decision, and on approve auto-remove the
// matching scheduled shift — lives in one transactional database function so
// the two surfaces can never drift apart. Both callers do their OWN auth/role
// gate first, then hand a resolved (hotelId, requestId) to this helper.
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
      reason: 'load_failed' | 'not_found' | 'already_decided' | 'past_date' | 'update_failed';
    };

/**
 * Apply a manager's approve/deny decision to a pending time-off request,
 * scoped to a single property. On approve, the matching scheduled_shifts row
 * (same staff + date, kind='shift') is removed in the same database transaction
 * so approval can never commit without its schedule consequence.
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
  const { data, error } = await supabaseAdmin.rpc('staxis_apply_time_off_decision', {
    p_property_id: hotelId,
    p_request_id: requestId,
    p_decision: decision,
    p_deny_reason: denyReason?.trim() || null,
    p_decided_by: decidedBy,
  });
  if (error) return { ok: false, reason: 'update_failed' };

  const result = data && typeof data === 'object'
    ? data as Record<string, unknown>
    : null;
  if (!result || result.ok !== true) {
    const reason = result?.reason;
    if (reason === 'not_found' || reason === 'already_decided' || reason === 'past_date') {
      return { ok: false, reason };
    }
    return { ok: false, reason: 'update_failed' };
  }

  return {
    ok: true,
    removedShift: result.removedShift === true,
    staffId: String(result.staffId),
    requestDate: String(result.requestDate),
  };
}
