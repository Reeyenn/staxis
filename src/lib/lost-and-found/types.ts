// ═══════════════════════════════════════════════════════════════════════════
// Lost & Found — shared types.
//
// Used by the server store (src/lib/lost-and-found/store.ts), the client db
// helper (src/lib/db/lost-and-found.ts), the API routes, and the UI. The
// register UNIONs two physical tables (the app's lost_and_found_items + the
// CUA-owned pms_lost_and_found) into ONE normalized `LostFoundItem` shape.
// ═══════════════════════════════════════════════════════════════════════════

export type LostFoundType = 'found' | 'lost';

/** App status vocabulary. `claimed` only appears on PMS-sourced rows (the PMS
 *  uses a slightly different vocabulary — see normalizePmsRow). */
export type LostFoundStatus =
  | 'open'
  | 'matched'
  | 'returned'
  | 'shipped'
  | 'disposed'
  | 'expired'
  | 'claimed';

/** Where a register row physically lives. `pms` rows are READ-ONLY in the app. */
export type LostFoundSource = 'app' | 'pms';

/** Categories the vision auto-describe + the manual chooser use. Kept in sync
 *  with the CHECK constraint in migration 0229. */
export const LAF_CATEGORIES = [
  'electronics',
  'clothing',
  'jewelry',
  'documents',
  'bags',
  'keys',
  'toiletries',
  'eyewear',
  'toys',
  'money',
  'other',
] as const;
export type LostFoundCategory = (typeof LAF_CATEGORIES)[number];

/** App-side row provenance (lost_and_found_items.source CHECK). */
export const LAF_SOURCES = ['front_desk', 'housekeeper', 'voice', 'staff'] as const;
export type LostFoundOrigin = (typeof LAF_SOURCES)[number];

/** Default holding period for found items before they're flagged for disposal. */
export const LAF_HOLD_DAYS = 90;
/** Window (days) before hold_until that counts as "nearing disposal". */
export const LAF_NEARING_DISPOSAL_DAYS = 7;

/**
 * One row of the unified register. Both physical tables normalize into this.
 * Timestamps are ISO strings (serialized over the API boundary).
 */
export interface LostFoundItem {
  id: string;
  source: LostFoundSource;
  type: LostFoundType;
  itemDescription: string;
  category: string | null;
  location: string | null;
  roomNumber: string | null;
  photoPath: string | null;
  /** Short-lived signed view URL for photoPath, set server-side on the register
   *  read (the bucket is private — the browser can't sign it). */
  photoUrl?: string | null;
  status: string;
  foundBy: string | null;
  reportedBy: string | null;
  guestName: string | null;
  matchedItemId: string | null;
  occurredAt: string | null;
  holdUntil: string | null;
  claimedAt: string | null;
  returnedAt: string | null;
  shippingInfo: Record<string, unknown> | null;
  notes: string | null;
  createdAt: string;
  /** false for PMS-sourced rows — the app must never mutate the CUA's table. */
  editable: boolean;
}

/** Tile counts for the owner dashboard + the register header. */
export interface LostFoundCounts {
  /** Open + actionable (found waiting to be returned, or lost not yet matched). */
  open: number;
  /** Matched but not yet handed back / shipped. */
  awaitingReturn: number;
  /** Open found items within LAF_NEARING_DISPOSAL_DAYS of their hold deadline. */
  nearingDisposal: number;
}

/** Statuses that count as "resolved" (no further action needed). */
export const LAF_RESOLVED_STATUSES: ReadonlySet<string> = new Set([
  'returned',
  'shipped',
  'disposed',
  'expired',
  'claimed',
]);
