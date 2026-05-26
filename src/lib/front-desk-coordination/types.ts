/**
 * Shared types for the front-desk ↔ housekeeping coordination layer.
 *
 * Kept in its own file so dispatch-sms, the API routes, and the React
 * components can import from one canonical place without circular deps.
 *
 * Event taxonomy MUST match the CHECK constraint on
 * `notification_events.event_type` (migration 0231). Adding a new event
 * type requires both this union AND the SQL CHECK to be extended.
 */

export type DispatchEventType =
  | 'room_ready'
  | 'vip_arrival'
  | 'room_move'
  | 'walk_in'
  | 'rush';

export type DispatchMode = 'dry_run' | 'live';

/**
 * Per-recipient outcome of a dispatch call. `auditId` is the
 * notification_events row id so callers can correlate downstream
 * (e.g. surface "this is the row your panel just rendered").
 *
 * `sent` reflects what actually happened:
 *   dry_run: always `false` — the row was audited but Twilio was not called.
 *   live:    `true` on Twilio success, `false` on Twilio failure (errorText
 *            populated). The audit row is still written either way.
 */
export interface DispatchOutcome {
  auditId: string;
  mode: DispatchMode;
  sent: boolean;
  recipientStaffId: string | null;
  recipientPhone: string | null;
  recipientName: string | null;
  providerId: string | null;
  errorText: string | null;
}

/** One recipient + their phone, as resolved by find-currently-working. */
export interface DispatchRecipient {
  staffId: string;
  name: string;
  phone: string | null;
}
