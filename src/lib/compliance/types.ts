// Engineering Compliance — shared types + constants.
//
// Two parts:
//   A) READINGS  — recurring measurements (pool chem, meters, boiler, area temps)
//   B) PM CHECKS — recurring equipment compliance logs (life-safety gear)
//
// Tables live in migration 0229. All access is service-role via /api/* (the
// engineer mobile page is a public SMS-link page — see CLAUDE.md RLS bug class).

export const READING_CATEGORIES = ['pool', 'utility_meter', 'boiler', 'area_temp', 'other'] as const;
export type ReadingCategory = (typeof READING_CATEGORIES)[number];

export const READING_CADENCES = ['per_shift', 'daily', 'weekly', 'monthly'] as const;
export type ReadingCadence = (typeof READING_CADENCES)[number];

export const PM_CATEGORIES = ['life_safety', 'other'] as const;
export type PmCategory = (typeof PM_CATEGORIES)[number];

export const PM_CADENCES = ['monthly', 'quarterly', 'annual'] as const;
export type PmCadence = (typeof PM_CADENCES)[number];

export const READING_SOURCES = ['manual', 'voice', 'photo'] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];

export const PM_STATUSES = ['pass', 'fail'] as const;
export type PmStatus = (typeof PM_STATUSES)[number];

// ─── Definition rows ────────────────────────────────────────────────────────

export interface ReadingType {
  id: string;
  propertyId: string;
  category: ReadingCategory;
  name: string;
  unit: string;
  cadence: ReadingCadence;
  assignedDepartment: string;
  minValue: number | null;
  maxValue: number | null;
  templateKey: string | null;
  sortOrder: number;
  active: boolean;
}

export interface PmTask {
  id: string;
  propertyId: string;
  category: PmCategory;
  name: string;
  equipmentType: string | null;
  unitCount: number;
  cadence: PmCadence;
  assignedDepartment: string;
  templateKey: string | null;
  sortOrder: number;
  active: boolean;
}

// ─── History rows ───────────────────────────────────────────────────────────

export interface Reading {
  id: string;
  propertyId: string;
  readingTypeId: string;
  value: number | null;
  textValue: string | null;
  unit: string;
  readingDate: string;       // YYYY-MM-DD (property-local)
  periodKey: string;
  outOfRange: boolean;
  source: ReadingSource;
  note: string | null;
  photoPath: string | null;
  loggedByStaffId: string | null;
  loggedByName: string | null;
  loggedAt: string;          // ISO
  workOrderId: string | null;
}

export interface PmCheck {
  id: string;
  propertyId: string;
  pmTaskId: string;
  periodKey: string;
  status: PmStatus;
  unitsChecked: number | null;
  note: string | null;
  photoPath: string | null;
  checkedByStaffId: string | null;
  checkedByName: string | null;
  checkedAt: string;         // ISO
  workOrderId: string | null;
}

// ─── Derived view models (computed server-side, sent to the UI) ──────────────

/** A reading type plus its current-period status. */
export interface ReadingTypeStatus {
  type: ReadingType;
  /** The most recent reading, if any. */
  latest: Reading | null;
  /** True when the current cadence period already has a logged reading. */
  doneThisPeriod: boolean;
  /** Current period key (what a fresh log would be filed under). */
  currentPeriodKey: string;
  /** Human label for the period, e.g. "today", "this week", "May". */
  periodLabel: string;
  /** True when the latest reading is out of its safe range. */
  latestOutOfRange: boolean;
}

/** A PM task plus its current-period / overdue status. */
export interface PmTaskStatus {
  task: PmTask;
  latest: PmCheck | null;
  doneThisPeriod: boolean;
  currentPeriodKey: string;
  periodLabel: string;
  /** True when the task's cadence interval has elapsed without a pass check. */
  overdue: boolean;
  /** ISO date the next check is due (informational). */
  nextDueISO: string | null;
}

/** Payload for the manager Compliance tab + engineer page. */
export interface ComplianceOverview {
  readings: ReadingTypeStatus[];
  pmTasks: PmTaskStatus[];
  /** % of active reading types satisfied in their current period (0-100). */
  readingsCompletePct: number;
  readingsDone: number;
  readingsTotal: number;
  /** # of active PM tasks currently overdue. */
  pmOverdueCount: number;
  pmTotal: number;
}

// ─── Inspector-ready report ──────────────────────────────────────────────────

export interface ComplianceReportRow {
  category: string;
  name: string;
  unit?: string;
  entries: Array<{ when: string; value: string; by: string; status: string }>;
}

export interface ComplianceReport {
  propertyId: string;
  fromDate: string;
  toDate: string;
  readings: ComplianceReportRow[];
  pmChecks: ComplianceReportRow[];
  totals: { readingCount: number; outOfRangeCount: number; pmCheckCount: number; pmFailCount: number };
}

/** Lightweight payload for the owner Dashboard tile. */
export interface ComplianceSummary {
  readingsCompletePct: number;
  readingsDone: number;
  readingsTotal: number;
  pmOverdueCount: number;
  pmTotal: number;
  /** 70/30 status color the tile renders. */
  status: 'good' | 'low' | 'critical';
}
