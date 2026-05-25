/**
 * TypeScript types for the housekeeping inspections workflow.
 *
 * Mirrors the migration 0212 schema. All API routes under
 * /api/housekeeping/inspections return / accept these shapes.
 *
 * Database <-> TS naming: DB uses snake_case, TS uses camelCase. Mapper
 * functions live in src/lib/db/inspections.ts.
 */

export type InspectionResult = 'in_progress' | 'pass' | 'fail' | 'cancelled';

export type InspectionItemSeverity = 'minor' | 'major' | 'critical';

export type InspectionItemCategory =
  | 'bathroom'
  | 'bedroom'
  | 'living'
  | 'kitchen'
  | 'welcome'
  | 'other';

export interface InspectionChecklistItem {
  id: string;
  checklistId: string;
  category: InspectionItemCategory;
  label: string;
  labelEs: string | null;
  severityDefault: InspectionItemSeverity;
  requiresPhotoOnFail: boolean;
  orderIndex: number;
}

export interface InspectionChecklist {
  id: string;
  propertyId: string | null;
  name: string;
  appliesToCleaningTypes: string[];
  appliesToRoomTypes: string[];
  isActive: boolean;
  version: number;
  items: InspectionChecklistItem[];
  createdAt: string;
  updatedAt: string;
}

export interface InspectionFailedItem {
  itemId: string;
  label: string;
  severity: InspectionItemSeverity;
  /**
   * Signed Supabase Storage URL valid for ~7 days at upload time. The
   * canonical location is `photoPath` — the URL is stored too as a
   * UX convenience for the just-completed view, but anything reading
   * a >7-day-old inspection must re-sign using photoPath via
   * /api/housekeeping/inspections/sign-photo. See M5 fix in
   * fix/inspections-flow-followup.
   */
  photoUrl: string | null;
  /**
   * Permanent storage path (e.g. "<pid>/<inspectionId>/<item>-<ts>.jpg").
   * The single source of truth for the photo after the signed URL expires.
   * Older inspection rows may have this as null if they predate the M5 fix.
   */
  photoPath?: string | null;
  note: string | null;
}

export interface Inspection {
  id: string;
  propertyId: string;
  roomNumber: string;
  roomId: string | null;
  cleaningTaskId: string | null;
  checklistId: string | null;
  inspectorStaffId: string | null;
  housekeeperStaffId: string | null;
  startedAt: string;
  completedAt: string | null;
  result: InspectionResult;
  failedItems: InspectionFailedItem[];
  passedItems: string[];
  correctionNoticeSentAt: string | null;
  recheckInspectionId: string | null;
  parentInspectionId: string | null;
  notes: string | null;
  escalated: boolean;
  escalationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Rooms that appear in the inspector's queue. A room is queued for
 * inspection when it has just been cleaned (status='clean') and no
 * completed inspection exists for the same room on the same business
 * date, OR when a prior inspection failed and the room has been
 * re-cleaned since.
 */
export type InspectionQueueReason =
  | 'pending_inspection'   // freshly cleaned, never inspected
  | 'pending_recheck';     // failed earlier, re-cleaned by housekeeper

export interface InspectionQueueRoom {
  roomId: string;
  roomNumber: string;
  roomType: string;
  housekeeperStaffId: string | null;
  housekeeperName: string | null;
  completedAt: string | null;
  reason: InspectionQueueReason;
  parentInspectionId: string | null;
  priorFailCount: number;
}

export interface InspectionStats {
  todayPassRate: number;           // 0-1
  weekPassRate: number;            // 0-1
  reCleanRatePct: number;          // 0-100
  avgInspectionDurationSec: number;
  totalInspectionsToday: number;
  totalInspectionsWeek: number;
  topFailureItems: Array<{ label: string; count: number }>;
  inspectorLeaderboard: Array<{ inspectorName: string; passRate: number; count: number }>;
}

export interface InspectionHistoryEntry {
  id: string;
  roomNumber: string;
  result: InspectionResult;
  inspectorName: string | null;
  housekeeperName: string | null;
  failedItemCount: number;
  startedAt: string;
  completedAt: string | null;
  escalated: boolean;
}

/** Threshold above which a failed-room chain becomes "escalated". */
export const ESCALATION_THRESHOLD = 3;
