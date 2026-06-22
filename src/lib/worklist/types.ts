// ═══════════════════════════════════════════════════════════════════════════
// Unified Worklist — shared DTO (server + client).
//
// One normalized shape for every open actionable item across the property,
// regardless of which module it came from (manual to-do, complaint, work order,
// inspection-due room, preventive-maintenance task). The Communications To-do
// view renders WorklistItem[]; the /api/worklist routes produce + dispatch on it.
// ═══════════════════════════════════════════════════════════════════════════

/** Which module an item originated from. Drives the source tag + dispatch. */
export type WorklistSourceType = 'task' | 'complaint' | 'workorder' | 'inspection' | 'pm';

export const WORKLIST_SOURCE_TYPES: readonly WorklistSourceType[] = [
  'task', 'complaint', 'workorder', 'inspection', 'pm',
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
}
