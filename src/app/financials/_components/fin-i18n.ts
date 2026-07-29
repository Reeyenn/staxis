// English strings for the Financials suite.

import { formatCents, type Department, type CapexStatus, type CapexCategory, type RequestType } from '@/lib/financials/shared';

type Lang = 'en' | 'es';

export const DEPT_LABELS: Record<'en', Record<Department, string>> = {
  en: {
    rooms: 'Rooms',
    housekeeping: 'Housekeeping',
    maintenance: 'Maintenance',
    front_desk: 'Front Desk',
    breakfast: 'Breakfast / F&B',
    utilities: 'Utilities',
    sales_marketing: 'Sales & Marketing',
    admin_general: 'Admin & General',
    other: 'Other',
  },

};

export const CAPEX_STATUS_LABELS: Record<'en', Record<CapexStatus, string>> = {
  en: {
    requested: 'Requested',
    approved: 'Approved',
    rejected: 'Rejected',
    revisions_needed: 'Revisions Needed',
    in_progress: 'In Progress',
    completed: 'Completed',
    cancelled: 'Cancelled',
  },

};

export const CAPEX_CATEGORY_LABELS: Record<'en', Record<CapexCategory, string>> = {
  en: {
    renovation: 'Renovation',
    equipment: 'Equipment',
    technology: 'Technology',
    safety: 'Safety',
    exterior: 'Exterior',
    furniture: 'Furniture',
    other: 'Other',
  },

};

export const REQUEST_TYPE_LABELS: Record<'en', Record<RequestType, string>> = {
  en: { budgeted: 'Budgeted', emergency: 'Emergency' },

};

export function capexCategoryLabel(lang: Lang, c: CapexCategory): string {
  return CAPEX_CATEGORY_LABELS['en']?.[c] ?? CAPEX_CATEGORY_LABELS.en[c] ?? c;
}
export function requestTypeLabel(lang: Lang, t: RequestType): string {
  return REQUEST_TYPE_LABELS['en']?.[t] ?? REQUEST_TYPE_LABELS.en[t] ?? t;
}

const STRINGS = {
  en: {
    // shell
    title: 'Financials',
    tagline: 'Your books, filled in for you.',
    tabCheckbook: 'Checkbook',
    tabBudget: 'Budget',
    tabCapex: 'CapEx',
    // summary
    revenue: 'Revenue',
    expenses: 'Expenses',
    profit: 'Profit',
    margin: 'Margin',
    costPerRoom: 'Cost / occupied room',
    pctOfRevenue: 'Expenses % of revenue',
    noRevenueYet: 'No PMS revenue yet',
    fromPms: 'from the PMS',
    revenueComingSoon: 'Revenue auto-flows from the PMS once it reports financials.',
    // checkbook
    addExpense: 'Add expense',
    scanInvoice: 'Scan invoice',
    vendor: 'Vendor',
    amount: 'Amount',
    department: 'Department',
    category: 'Category',
    date: 'Date',
    notes: 'Notes',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    monthTotal: 'Month total',
    noExpenses: 'No expenses logged for this month yet.',
    allDepartments: 'All departments',
    confirmDelete: 'Delete this expense?',
    scanning: 'Reading invoice…',
    scanFailed: 'Could not read that image. Try a clearer photo.',
    scanHint: 'Snap a vendor invoice. We read the vendor, total, and category for you.',
    fromScan: 'from scan',
    optional: 'optional',
    // budget
    budgetVsActual: 'Budget vs. actual',
    setBudgets: 'Set budgets',
    budget: 'Budget',
    actual: 'Actual',
    remaining: 'Remaining',
    over: 'over',
    headroom: 'left',
    leftToSpend: 'left to spend',
    overBy: 'over by',
    totalMonthly: 'Total monthly',
    onTrack: 'On track',
    overBudget: 'Over budget',
    approaching: 'Approaching',
    noBudget: 'No budget set',
    saveBudgets: 'Save budgets',
    forecast: 'Month-end forecast',
    projected: 'Projected',
    trendingOver: 'Trending over budget',
    tooEarly: 'Too early in the month to forecast reliably.',
    anomalies: 'Spend alerts',
    noAnomalies: 'No unusual spend this month.',
    // capex
    projects: 'Capital projects',
    newProject: 'New project',
    scanQuote: 'Scan quote',
    projectName: 'Project name',
    quote: 'Quote',
    spent: 'Spent',
    status: 'Status',
    overrun: 'overrun',
    underQuote: 'under quote',
    lineItems: 'Line items',
    addLine: 'Add line item',
    label: 'Label',
    startDate: 'Start date',
    targetDate: 'Target date',
    description: 'Description',
    noProjects: 'No capital projects yet.',
    deleteProject: 'Delete project',
    confirmDeleteProject: 'Delete this project and its line items?',
    scanQuoteHint: 'Snap a contractor quote. We read the project, total, and line items.',
    back: 'Back',
    // capex approval workflow
    capOverview: 'Overview',
    capPending: 'Pending',
    capActive: 'Active',
    capClosed: 'Closed',
    capForecast: 'Forecast',
    capBinder: 'Binder',
    rollup: 'All properties',
    newRequest: 'New request',
    requestTitle: 'Title',
    estimatedCost: 'Estimated cost',
    typeLabel: 'Type',
    budgeted: 'Budgeted',
    emergency: 'Emergency',
    submitRequest: 'Submit request',
    approve: 'Approve',
    reject: 'Reject',
    requestRevisions: 'Request changes',
    decisionNotes: 'Notes / reason',
    submittedBy: 'Submitted by',
    decidedBy: 'Decided by',
    markInProgress: 'Start work',
    markComplete: 'Mark complete',
    percentComplete: '% complete',
    estimate: 'Estimate',
    totalRequests: 'Requests',
    totalEstimated: 'Estimated',
    totalSpent: 'Spent',
    approvedPct: '% approved',
    startedPct: '% started',
    completedPct: '% completed',
    budgetedVsEmergency: 'Budgeted vs. emergency',
    binderQuote: 'Quote & estimate',
    binderApprovals: 'Approvals',
    binderReceipts: 'Receipts',
    attachment: 'Attached quote / photo',
    addAttachment: 'Attach quote / photo',
    noAttachment: 'No attachment',
    viewAttachment: 'View attachment',
    upcomingByMonth: 'Upcoming capital spend',
    awaitingApproval: 'Awaiting approval',
    noPending: 'Nothing awaiting approval.',
    noActive: 'No active projects.',
    noClosed: 'Nothing closed yet.',
    noForecastCapex: 'No upcoming capital spend scheduled.',
    selectProject: 'Pick a project to open its binder.',
    acrossProperties: 'Across your properties',
    // common
    loading: 'Loading…',
    errorLoading: 'Could not load. Tap to retry.',
    close: 'Close',
    saving: 'Saving…',
    // errors / validation (mutation failures must never be silent)
    couldNotSave: 'Could not save. Try again.',
    couldNotDelete: 'Could not delete. Try again.',
    invalidAmount: 'Enter a valid amount.',
    linesPartial: 'Request saved, but some scanned line items could not be added. Add them in the project binder.',
    attachmentOpenFailed: 'Could not open the attachment. Try again.',
    scanRateLimited: 'Scan limit reached. Wait a bit and try again.',
    scanBudgetCap: 'Daily AI budget reached. Scanning is paused until tomorrow.',
    scanServiceDown: 'The scan service is temporarily unavailable. Try again soon.',
    // budget card footer words ("$1,200 spent / of $2,000")
    spentWord: 'spent',
    ofWord: 'of',
  },

};

export type FinStrings = (typeof STRINGS)['en'];

export function ft(lang: Lang): FinStrings {
  return STRINGS['en'] ?? STRINGS.en;
}

export function deptLabel(lang: Lang, d: Department): string {
  return DEPT_LABELS['en']?.[d] ?? DEPT_LABELS.en[d] ?? d;
}

export function capexStatusLabel(lang: Lang, s: CapexStatus): string {
  return CAPEX_STATUS_LABELS['en']?.[s] ?? CAPEX_STATUS_LABELS.en[s] ?? s;
}

/**
 * Map a scan failure to the right user-facing message (used by ScanButton;
 * lives here so it stays a pure, test-importable function). The server
 * distinguishes rate limiting (429 rate_limited — note: NOT the standard
 * envelope, the error text itself is 'rate_limited' with no code), the daily
 * AI budget cap (429 user_cap/property_cap/global_cap), and the vision
 * service being down (503/500 vision_unavailable/vision_failed) — telling
 * the manager "try a clearer photo" for those sends them retaking photos
 * pointlessly.
 */
export function scanErrorLabel(
  S: Pick<FinStrings, 'scanRateLimited' | 'scanBudgetCap' | 'scanServiceDown'>,
  fallback: string,
  code: string | undefined,
  status: number | undefined,
  errorText: string | undefined,
): string {
  if (code === 'user_cap' || code === 'property_cap' || code === 'global_cap') return S.scanBudgetCap;
  if (code === 'rate_limited' || errorText === 'rate_limited' || status === 429) return S.scanRateLimited;
  if (code === 'vision_unavailable' || code === 'vision_failed' || status === 503) return S.scanServiceDown;
  return fallback;
}

// ── Bilingual rebuilds of server-generated alert sentences ──────────────────
// The forecast/anomaly APIs return English-only `message` strings (built in
// src/lib/financials/forecast.ts / anomaly.ts, which have no lang). The
// responses also carry the structured numbers, so the client rebuilds the
// sentence in the viewer's language. EN output matches the server string
// byte-for-byte so English users see no change.

/** "Housekeeping is trending 23% over budget (projected $4,100.00 vs $3,200.00)." */
export function forecastTrendingMsg(
  lang: Lang,
  department: Department,
  pctOverBudget: number,
  projectedCents: number,
  budgetCents: number,
): string {
  const dept = deptLabel(lang, department);
  const pct = Math.round(pctOverBudget);
  const projected = formatCents(projectedCents);
  const budget = formatCents(budgetCents);
  return `${dept} is trending ${pct}% over budget (projected ${projected} vs ${budget}).`;
}

/** "Utilities spend is 40% over last month ($700.00 vs $500.00)." */
export function anomalySpikeMsg(
  lang: Lang,
  department: Department,
  ratio: number,
  currentCents: number,
  baselineCents: number,
): string {
  const dept = deptLabel(lang, department);
  const pct = Math.round((ratio - 1) * 100);
  const cur = formatCents(currentCents);
  const base = formatCents(baselineCents);
  return `${dept} spend is ${pct}% over last month (${cur} vs ${base}).`;
}
