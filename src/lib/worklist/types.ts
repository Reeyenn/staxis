// ═══════════════════════════════════════════════════════════════════════════
// Unified Worklist — shared DTO (server + client).
//
// One normalized shape for every open actionable item across the property,
// regardless of which module it came from (manual to-do, complaint, work order,
// inspection-due room, preventive-maintenance task, a due reminder, a decision
// waiting on a manager). The Staxis list renders WorklistItem[] interleaved
// with the AI's finding cards; the /api/worklist routes produce + dispatch on it.
// ═══════════════════════════════════════════════════════════════════════════

/** Which module an item originated from. Drives the source tag + dispatch. */
export type WorklistSourceType =
  | 'task'
  | 'complaint'
  | 'workorder'
  | 'inspection'
  | 'pm'
  | 'reminder'
  | 'approval';

export const WORKLIST_SOURCE_TYPES: readonly WorklistSourceType[] = [
  'task', 'complaint', 'workorder', 'inspection', 'pm', 'reminder', 'approval',
];

/** Normalized priority lane across sources. */
export type WorklistPriority = 'urgent' | 'high' | 'normal' | 'low';

/**
 * One open item in the unified worklist. `id` is a synthetic
 * `"sourceType:sourceId"` composite (stable React key + the only handle the
 * dispatch routes need); `sourceId` is the real row id in its source table
 * (or the room id, for an inspection-queue entry).
 */
export interface WorklistItem {
  id: string;
  sourceType: WorklistSourceType;
  sourceId: string;
  title: string;
  location: string | null;
  assigneeStaffId: string | null;
  assigneeName: string | null;
  dept: string | null;
  dueDate: string | null;   // ISO; null when the source has no due concept
  status: string;
  priority: WorklistPriority | null;
  propertyId: string;
  // ── UI affordances (derived server-side so the client stays dumb) ──────────
  /** Aging past its source's SLA / overdue (sorts to the top). */
  overdue: boolean;
  /** Can be completed from the worklist (false for inspection → deep-link only). */
  canComplete: boolean;
  /** Has an assign control (staff for task/complaint, priority lane for workorder). */
  canAssign: boolean;
  /** Path to the item's real module (row "Open" link). */
  deepLink: string;
  createdAt: string | null;
  // ── the one list ──────────────────────────────────────────────────────────
  /**
   * Who this came from, as the front half of the row's sentence — "Marcus asked
   * you to", "Staxis noticed". Null when nobody in particular asked: a work
   * order or an inspection-due room is a fact about the hotel, and inventing a
   * sender for it would be a claim we cannot back.
   *
   * The founder's rule is that who-it-is-from is part of the SENTENCE, not a
   * category system: there are no lanes, no tags and no filters on this list.
   */
  fromLabel: string | null;
  /**
   * Real money attached to this row, in cents, or null.
   *
   * ONLY ever a number stored on the source row (a capital request's requested
   * amount today). Never estimated, never derived, never a placeholder — the
   * list sorts dollars first, and a made-up figure would sort a fiction above a
   * fact. Null is the correct and common answer.
   */
  amountCents: number | null;
  /** Set on a task the assignee marked "Can't do this". Their words, verbatim. */
  blockedReason?: string | null;
}

/**
 * Who is looking. Present on every list read so the list can be the SAME page
 * sized to the person: a task assigned to somebody else is not on your list, and
 * a decision that belongs to a manager is not on a maintenance tech's.
 */
export interface WorklistViewer {
  staffId: string;
  accountId: string;
  role: string;
  /** The staff row's department, when they have one. */
  dept: string | null;
}

/** One task this person handed to somebody else, and where it got to. */
export interface AssignedByMeItem {
  taskId: string;
  title: string;
  assigneeStaffId: string | null;
  assigneeName: string | null;
  assignedDepartment: string | null;
  /** 'waiting' until the assignee acts; then what they said. */
  state: 'waiting' | 'done' | 'cant';
  dueDate: string | null;
  createdAt: string | null;
  /** Who tapped, and when. Null while waiting. */
  settledByName: string | null;
  /** The settler's staff id, so "somebody else finished it" can be told apart
   *  from the author closing their own to-do without comparing display names. */
  settledByStaffId: string | null;
  settledAt: string | null;
  /** Verbatim, for a 'cant'. */
  reason: string | null;
  /** Whole days since it was handed over. Drives the staleness line. */
  ageDays: number;
}
