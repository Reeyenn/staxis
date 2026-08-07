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
  /**
   * The calendar day this is due ON, at the HOTEL, as YYYY-MM-DD.
   *
   * `dueDate` above is an instant, and turning an instant back into a day is
   * something only the server can do correctly: it is the one side that knows
   * the hotel's timezone. The month grid and the week strip did it in the
   * browser, so a manager whose laptop is east of the hotel saw the end of the
   * hotel's Friday (23:59:59 local) land on Saturday's square. Every to-do due
   * that day carried a dot on the wrong day, and clicking the right day showed
   * an empty page. A single-hotel manager sitting in the hotel never sees it;
   * a VP with hotels in two zones sees it on one of them permanently.
   *
   * Absent on the sources with no calendar day of their own (a complaint, a
   * work order, an inspection-due room), where the calendar correctly has
   * nothing to place.
   */
  dueDay?: string | null;
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
  /**
   * Why a work order is not moving, verbatim, when somebody has said so.
   *
   * Set by "Waiting on parts". The row DELIBERATELY STAYS ON THE LIST when this
   * is set: a defer that removed the ticket would turn a stalled job into an
   * invisible one, and the whole reason to record the sentence is so that the
   * next person to look does not have to go and ask. It sinks instead of
   * vanishing (priority drops, overdue is cleared), and the words appear under
   * the title. Null on everything nobody has deferred, which is nearly all of it.
   */
  waitingReason?: string | null;
  /**
   * How many days between each one, on an upkeep schedule. Null on every other
   * row type.
   *
   * Carried so "Change the schedule" opens with the number it is changing rather
   * than with a blank. A cadence editor that starts empty is one where somebody
   * has to remember what it was, and the commonest edit is nudging 30 to 60.
   */
  cadenceDays?: number | null;
  // ── follow-through ────────────────────────────────────────────────────────
  /**
   * Who wrote this down, when anybody did.
   *
   * Carried so "just mine" can mean what a person means by it: work that is
   * ASSIGNED to them, and work that BELONGS to them because they are the one
   * who asked for it. Filtering on the assignee alone would hide a manager's
   * own house to-dos from their own narrowed list.
   */
  createdByStaffId: string | null;
  /**
   * Optional time of day, "HH:MM" on the hotel's own wall clock, or null.
   *
   * Display and sort only. `dueDate` still holds the end of the local due day
   * and is what every date comparison uses; this decides where the row sits
   * WITHIN its day and what the row says out loud. Null on almost every row.
   */
  dueTime?: string | null;
  /**
   * The template this is one instance of, when it repeats.
   *
   * Present so the list can collapse a run of missed instances into the one row
   * they are all saying. See collapseRepeatInstances.
   */
  recurringTemplateId?: string | null;
  /**
   * The first day this was owed and not done, YYYY-MM-DD, when that day has
   * passed. For a plain to-do it is its own due day. For a repeating one it is
   * the OLDEST open instance in the run, which is what "missed since Monday"
   * means and what "Did it Monday" credits the completion to.
   */
  missedSince?: string | null;
  /**
   * Open sibling instances this row stands in for, oldest first.
   *
   * Empty on everything that is not a collapsed repeat run. Settling this row
   * settles these too, which is the whole reason a missed daily to-do stops
   * being five copies of itself.
   */
  supersededIds?: string[];
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
  /**
   * 'waiting' until the assignee acts; then what they said.
   *
   * 'skipped' is "it stopped needing doing". Deliberately not folded into
   * 'cant': a refusal carries a reason and the database makes a reasonless one
   * unrepresentable, while "not needed" is not a refusal and demanding a
   * sentence for it just pushes people back to deleting the row.
   */
  state: 'waiting' | 'done' | 'cant' | 'skipped';
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
  /**
   * The day a completion was CREDITED to, when it is not the day it was
   * reported. Set by "Did it yesterday". Null on an ordinary completion, which
   * is most of them.
   */
  completedForDate: string | null;
  /** Whole days since it was handed over. Drives the staleness line. */
  ageDays: number;
}
