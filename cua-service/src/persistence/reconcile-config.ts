/**
 * Per-table behavior for the reconcile write path. Lives in its own file
 * (no imports) so tests can pin the configuration without dragging in the
 * Supabase singleton — which fails to construct under Node 20 because
 * @supabase/realtime-js needs a native WebSocket.
 *
 * The reconciler in generic-table-writer.ts imports from this file; a
 * misconfiguration shows up both here and in production.
 */

export interface OnMissingBehavior {
  /** Column to write when an existing row "disappeared" from a full snapshot. */
  column: string;
  /** Value to write (typically a terminal status like 'resolved' or 'disposed'). */
  value: string;
  /**
   * Optional per-table guard: only auto-resolve rows that pass this
   * filter. Used by pms_work_orders_v2 (since migration 0225 / feature
   * #11 follow-up) to skip Staxis-originated rows like
   * source='housekeeper_voice' — those have no PMS counterpart, so
   * the "row disappeared from the PMS snapshot" signal is meaningless
   * for them. Without this filter, every voice-issue ticket would be
   * auto-resolved 30s after creation on the next CUA sync.
   */
  sourceFilter?: { column: string; value: string };
}

export const RECONCILE_ON_MISSING: Record<string, OnMissingBehavior> = {
  pms_work_orders_v2: {
    column: 'status',
    value: 'resolved',
    // Only PMS-feed rows are eligible for auto-resolve. Voice-originated
    // (or any future Staxis-internal) rows are invisible to this pass.
    sourceFilter: { column: 'source', value: 'pms_sync' },
  },
  pms_lost_and_found: { column: 'status', value: 'disposed' },
};
