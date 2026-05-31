// ════════════════════════════════════════════════════════════════════════════
// Financials — shared types, constants, and money math.
//
// This file is import-safe from BOTH client and server (no supabaseAdmin / no
// server-only imports), so the React UI and the API routes share one source of
// truth for shapes, department keys, and — critically — money formatting.
//
// MONEY RULE: everything is integer CENTS end-to-end. Dollars only exist as
// display strings or as user input that is immediately rounded to cents via
// parseDollarsToCents(). Never multiply/divide cents by a float and store it.
// ════════════════════════════════════════════════════════════════════════════

// ── Departments (the budget dimension) ──────────────────────────────────────
export const DEPARTMENTS = [
  'rooms',
  'housekeeping',
  'maintenance',
  'front_desk',
  'breakfast',
  'utilities',
  'sales_marketing',
  'admin_general',
  'other',
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export function isDepartment(s: unknown): s is Department {
  return typeof s === 'string' && (DEPARTMENTS as readonly string[]).includes(s);
}

// English labels. Spanish labels live in translations.ts and are applied in the
// UI via useLang(); these EN labels are the fallback for server-side surfaces
// (agent tool replies, SMS alerts) that don't carry a language.
export const DEPARTMENT_LABELS_EN: Record<Department, string> = {
  rooms: 'Rooms',
  housekeeping: 'Housekeeping',
  maintenance: 'Maintenance',
  front_desk: 'Front Desk',
  breakfast: 'Breakfast / F&B',
  utilities: 'Utilities',
  sales_marketing: 'Sales & Marketing',
  admin_general: 'Admin & General',
  other: 'Other',
};

export function departmentLabel(d: Department): string {
  return DEPARTMENT_LABELS_EN[d] ?? d;
}

// ── Capex statuses (approval workflow) ──────────────────────────────────────
// Requested → Approved | Rejected | Revisions-Needed → In-Progress → Completed
// (+ Cancelled).
export const CAPEX_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'revisions_needed',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type CapexStatus = (typeof CAPEX_STATUSES)[number];

export function isCapexStatus(s: unknown): s is CapexStatus {
  return typeof s === 'string' && (CAPEX_STATUSES as readonly string[]).includes(s);
}

export const CAPEX_STATUS_LABELS_EN: Record<CapexStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  revisions_needed: 'Revisions Needed',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

// View buckets.
export const CAPEX_PENDING_STATUSES: readonly CapexStatus[] = ['requested', 'revisions_needed'];
export const CAPEX_ACTIVE_STATUSES: readonly CapexStatus[] = ['approved', 'in_progress'];
export const CAPEX_CLOSED_STATUSES: readonly CapexStatus[] = ['completed', 'rejected', 'cancelled'];

export const REQUEST_TYPES = ['budgeted', 'emergency'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export function isRequestType(s: unknown): s is RequestType {
  return s === 'budgeted' || s === 'emergency';
}

export const CAPEX_CATEGORIES = [
  'renovation',
  'equipment',
  'technology',
  'safety',
  'exterior',
  'furniture',
  'other',
] as const;
export type CapexCategory = (typeof CAPEX_CATEGORIES)[number];
export function isCapexCategory(s: unknown): s is CapexCategory {
  return typeof s === 'string' && (CAPEX_CATEGORIES as readonly string[]).includes(s);
}

// ── Expense source ──────────────────────────────────────────────────────────
export const EXPENSE_SOURCES = ['manual', 'invoice_scan'] as const;
export type ExpenseSource = (typeof EXPENSE_SOURCES)[number];

// ── Row shapes (camelCase; the API maps from snake_case DB rows) ────────────
export interface FinancialExpense {
  id: string;
  propertyId: string;
  expenseDate: string; // YYYY-MM-DD
  amountCents: number;
  vendor: string | null;
  department: Department;
  category: string | null;
  source: ExpenseSource;
  notes: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentBudget {
  propertyId: string;
  department: Department;
  monthStart: string; // YYYY-MM-01
  budgetCents: number;
  notes: string | null;
  updatedAt: string;
}

export interface CapexLineItem {
  id: string;
  capexProjectId: string;
  propertyId: string;
  label: string;
  amountCents: number;
  vendor: string | null;
  incurredDate: string | null;
  source: ExpenseSource;
  createdAt: string;
}

export interface CapexProject {
  id: string;
  propertyId: string;
  name: string;
  description: string | null;
  quoteCents: number; // scanned-quote figure (Smart CapEx)
  estimatedCostCents: number; // the estimate the request is approved on
  requestType: RequestType;
  category: CapexCategory | null;
  status: CapexStatus;
  pctComplete: number;
  vendor: string | null;
  startDate: string | null;
  targetDate: string | null;
  submittedByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  attachmentPath: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  // Derived (filled by the API when line items are joined):
  spentCents?: number;
  lineItems?: CapexLineItem[];
}

/** The estimate overrun is measured against (the approved estimate, or the
 *  scanned quote when no estimate was entered). */
export function capexEstimateCents(p: { estimatedCostCents: number; quoteCents: number }): number {
  return p.estimatedCostCents > 0 ? p.estimatedCostCents : p.quoteCents;
}

/** Overrun % of spent vs the estimate; null when there's no estimate. Positive = over. */
export function capexOverrunPct(spentCents: number, estimateCents: number): number | null {
  if (estimateCents <= 0) return null;
  return ((spentCents - estimateCents) / estimateCents) * 100;
}

// ── Budget vs. actual (per department, one month) ───────────────────────────
export interface BudgetVsActual {
  department: Department;
  budgetCents: number;
  actualCents: number;
  remainingCents: number; // budget - actual (can be negative = over)
  pctUsed: number | null; // null when no budget set
  status: BudgetStatus;
}

// ── Month-level finance summary (single source of truth with the Dashboard) ──
export interface FinanceSummary {
  month: string; // YYYY-MM
  // Revenue is read from the SAME PMS source the owner Dashboard uses
  // (pms_revenue_daily + live pms_in_house_snapshot). Cold-start aware: when the
  // PMS doesn't expose financials yet, revenueCents is null (NOT zero) so the UI
  // can show "no PMS revenue yet" honestly instead of implying $0 of real sales.
  revenueCents: number | null;
  revenueIsLive: boolean; // true once any PMS revenue row exists for the month
  expensesCents: number; // sum of checkbook for the month (always known)
  // profit = revenue - expenses, or null when revenue is unknown (cold start).
  profitCents: number | null;
  occupiedRoomNights: number | null;
  // Owner metrics — null when the inputs aren't available yet (honest cold start).
  costPerOccupiedRoomCents: number | null; // expenses / occupiedRoomNights
  expensesPctOfRevenue: number | null; // expenses / revenue * 100
}

// ════════════════════════════════════════════════════════════════════════════
// Money math — the ONLY place dollars↔cents conversions live.
// ════════════════════════════════════════════════════════════════════════════

/** Format integer cents as a USD string, e.g. 123456 → "$1,234.56". */
export function formatCents(
  cents: number | null | undefined,
  opts: { showCents?: boolean } = {},
): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const showCents = opts.showCents ?? true;
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
}

/** Compact USD for tiles, e.g. 1234567 → "$12.3k". */
export function formatCentsCompact(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  });
}

/**
 * Parse a user-entered dollar string into integer cents. Accepts "$1,234.56",
 * "1234.5", "1,000". Returns null for blank/invalid input. Rounds to the
 * nearest cent (so 10.005 → 1001) — the single rounding boundary in the system,
 * applied ONCE at the input edge, never during aggregation.
 */
export function parseDollarsToCents(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  const cleaned = input.replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === '.' || cleaned === '-') return null;
  if (!/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

// ── Budget status (70/30 color system, inverted for spend) ──────────────────
// Stock uses good ≥70% of par; spend is the opposite (more = worse), so:
//   good:  used ≤ 70%   (sage)
//   warn:  70% < used ≤ 100%  (caramel)
//   over:  used > 100%  (warm)
export type BudgetStatus = 'good' | 'warn' | 'over' | 'none';

export function budgetStatus(actualCents: number, budgetCents: number): BudgetStatus {
  if (budgetCents <= 0) return 'none';
  const ratio = actualCents / budgetCents;
  if (ratio > 1) return 'over';
  if (ratio > 0.7) return 'warn';
  return 'good';
}

/** Percent of budget used (0..∞), or null when no budget set. */
export function pctUsed(actualCents: number, budgetCents: number): number | null {
  if (budgetCents <= 0) return null;
  return (actualCents / budgetCents) * 100;
}

// ── Month helpers ────────────────────────────────────────────────────────────
/** "YYYY-MM" for a Date (UTC). */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First-of-month ISO date "YYYY-MM-01" for a "YYYY-MM" key or Date. */
export function monthStartISO(monthOrDate: string | Date): string {
  if (typeof monthOrDate === 'string') {
    // Accept "YYYY-MM" or "YYYY-MM-DD"
    const m = /^(\d{4})-(\d{2})/.exec(monthOrDate);
    if (!m) throw new Error(`invalid month: ${monthOrDate}`);
    return `${m[1]}-${m[2]}-01`;
  }
  return `${monthOrDate.getUTCFullYear()}-${String(monthOrDate.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Exclusive first-of-next-month ISO date for a "YYYY-MM" key. */
export function nextMonthStartISO(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) throw new Error(`invalid month: ${month}`);
  const y = Number(m[1]);
  const mm = Number(m[2]);
  const ny = mm === 12 ? y + 1 : y;
  const nm = mm === 12 ? 1 : mm + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

/** Validate a "YYYY-MM" string. */
export function isMonthKey(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** Number of days in a "YYYY-MM" month. */
export function daysInMonth(month: string): number {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) throw new Error(`invalid month: ${month}`);
  // Day 0 of next month = last day of this month (UTC).
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
}

/** The "YYYY-MM" before a given month. */
export function priorMonthKey(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) throw new Error(`invalid month: ${month}`);
  const y = Number(m[1]);
  const mm = Number(m[2]);
  const py = mm === 1 ? y - 1 : y;
  const pm = mm === 1 ? 12 : mm - 1;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

/**
 * Days "elapsed" in a month relative to `today`:
 *   - a fully-past month → all its days (the month is complete),
 *   - the current month → today's day-of-month,
 *   - a future month → 0.
 * `today` is passed in so this stays pure/testable.
 */
export function daysElapsedInMonth(month: string, today: Date): number {
  const cur = monthKey(today);
  if (month < cur) return daysInMonth(month);
  if (month > cur) return 0;
  return today.getUTCDate();
}
