// ════════════════════════════════════════════════════════════════════════════
// Financials — server data access (service-role). Imported ONLY by API routes,
// the cron sweep, and agent tools. Never by client components.
//
// CROSS-TENANT RULE: every query filters by property_id — including reads/writes
// that already have a row id. A forged id from another property therefore
// matches zero rows (read returns null, write/delete affects 0 rows) instead of
// leaking or mutating another hotel's books. There is no code path here that
// touches a finance row without the property_id predicate.
//
// Money is integer cents throughout. Aggregation is plain integer addition — no
// floats enter the pipeline (dollars→cents rounding happens once, in the API
// layer via parseDollarsToCents).
// ════════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  DEPARTMENTS,
  type Department,
  type FinancialExpense,
  type DepartmentBudget,
  type CapexProject,
  type CapexLineItem,
  type CapexStatus,
  type ExpenseSource,
  type BudgetVsActual,
  type FinanceSummary,
  budgetStatus,
  pctUsed,
  monthStartISO,
  nextMonthStartISO,
} from './shared';
import { getMonthRevenue } from './revenue';

// ── Row mappers (snake_case DB → camelCase domain) ──────────────────────────
type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function mapExpense(r: Row): FinancialExpense {
  return {
    id: r.id as string,
    propertyId: r.property_id as string,
    expenseDate: r.expense_date as string,
    amountCents: num(r.amount_cents),
    vendor: str(r.vendor),
    department: (r.department as Department) ?? 'other',
    category: str(r.category),
    source: (r.source as ExpenseSource) ?? 'manual',
    notes: str(r.notes),
    invoiceNumber: str(r.invoice_number),
    invoiceDate: str(r.invoice_date),
    createdByName: str(r.created_by_name),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapBudget(r: Row): DepartmentBudget {
  return {
    propertyId: r.property_id as string,
    department: (r.department as Department) ?? 'other',
    monthStart: r.month_start as string,
    budgetCents: num(r.budget_cents),
    notes: str(r.notes),
    updatedAt: r.updated_at as string,
  };
}

function mapLineItem(r: Row): CapexLineItem {
  return {
    id: r.id as string,
    capexProjectId: r.capex_project_id as string,
    propertyId: r.property_id as string,
    label: r.label as string,
    amountCents: num(r.amount_cents),
    vendor: str(r.vendor),
    incurredDate: str(r.incurred_date),
    source: (r.source as ExpenseSource) ?? 'manual',
    createdAt: r.created_at as string,
  };
}

function mapProject(r: Row): CapexProject {
  return {
    id: r.id as string,
    propertyId: r.property_id as string,
    name: r.name as string,
    description: str(r.description),
    quoteCents: num(r.quote_cents),
    status: (r.status as CapexStatus) ?? 'planned',
    vendor: str(r.vendor),
    startDate: str(r.start_date),
    targetDate: str(r.target_date),
    createdByName: str(r.created_by_name),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CHECKBOOK (financial_expenses)
// ════════════════════════════════════════════════════════════════════════════

export interface ExpenseFilter {
  month?: string; // "YYYY-MM"
  department?: Department;
}

export async function listExpenses(pid: string, filter: ExpenseFilter = {}): Promise<FinancialExpense[]> {
  let q = supabaseAdmin
    .from('financial_expenses')
    .select('*')
    .eq('property_id', pid)
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (filter.month) {
    q = q.gte('expense_date', monthStartISO(filter.month)).lt('expense_date', nextMonthStartISO(filter.month));
  }
  if (filter.department) {
    q = q.eq('department', filter.department);
  }
  const { data, error } = await q;
  if (error) {
    log.error('[financials/db] listExpenses failed', { pid, err: new Error(error.message) });
    throw new Error('listExpenses failed');
  }
  return (data ?? []).map(mapExpense);
}

/** Sum the month's spend per department (integer cents). Missing depts = 0. */
export async function sumExpensesByDepartment(
  pid: string,
  month: string,
): Promise<Record<Department, number>> {
  const totals = Object.fromEntries(DEPARTMENTS.map((d) => [d, 0])) as Record<Department, number>;
  const { data, error } = await supabaseAdmin
    .from('financial_expenses')
    .select('department, amount_cents')
    .eq('property_id', pid)
    .gte('expense_date', monthStartISO(month))
    .lt('expense_date', nextMonthStartISO(month));
  if (error) {
    log.error('[financials/db] sumExpensesByDepartment failed', { pid, err: new Error(error.message) });
    throw new Error('sumExpensesByDepartment failed');
  }
  for (const r of data ?? []) {
    const dept = ((r as Row).department as Department) ?? 'other';
    if (dept in totals) totals[dept] += num((r as Row).amount_cents);
  }
  return totals;
}

export async function totalExpenses(pid: string, month: string): Promise<number> {
  const byDept = await sumExpensesByDepartment(pid, month);
  return Object.values(byDept).reduce((a, b) => a + b, 0);
}

export interface NewExpense {
  expenseDate: string;
  amountCents: number;
  vendor?: string | null;
  department: Department;
  category?: string | null;
  source?: ExpenseSource;
  notes?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
}

export async function createExpense(
  pid: string,
  createdBy: string | null,
  createdByName: string | null,
  e: NewExpense,
): Promise<FinancialExpense> {
  const { data, error } = await supabaseAdmin
    .from('financial_expenses')
    .insert({
      property_id: pid,
      expense_date: e.expenseDate,
      amount_cents: Math.max(0, Math.round(e.amountCents)),
      vendor: e.vendor ?? null,
      department: e.department,
      category: e.category ?? null,
      source: e.source ?? 'manual',
      notes: e.notes ?? null,
      invoice_number: e.invoiceNumber ?? null,
      invoice_date: e.invoiceDate ?? null,
      created_by: createdBy,
      created_by_name: createdByName,
    })
    .select('*')
    .single();
  if (error || !data) {
    log.error('[financials/db] createExpense failed', { pid, err: new Error(error?.message ?? 'no row') });
    throw new Error('createExpense failed');
  }
  return mapExpense(data);
}

export interface ExpensePatch {
  expenseDate?: string;
  amountCents?: number;
  vendor?: string | null;
  department?: Department;
  category?: string | null;
  notes?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
}

export async function updateExpense(
  pid: string,
  id: string,
  patch: ExpensePatch,
): Promise<FinancialExpense | null> {
  const upd: Row = {};
  if (patch.expenseDate !== undefined) upd.expense_date = patch.expenseDate;
  if (patch.amountCents !== undefined) upd.amount_cents = Math.max(0, Math.round(patch.amountCents));
  if (patch.vendor !== undefined) upd.vendor = patch.vendor;
  if (patch.department !== undefined) upd.department = patch.department;
  if (patch.category !== undefined) upd.category = patch.category;
  if (patch.notes !== undefined) upd.notes = patch.notes;
  if (patch.invoiceNumber !== undefined) upd.invoice_number = patch.invoiceNumber;
  if (patch.invoiceDate !== undefined) upd.invoice_date = patch.invoiceDate;
  if (Object.keys(upd).length === 0) {
    // Nothing to change — return the current row (still property-scoped).
    const { data } = await supabaseAdmin
      .from('financial_expenses')
      .select('*')
      .eq('property_id', pid)
      .eq('id', id)
      .maybeSingle();
    return data ? mapExpense(data) : null;
  }
  const { data, error } = await supabaseAdmin
    .from('financial_expenses')
    .update(upd)
    .eq('property_id', pid)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) {
    log.error('[financials/db] updateExpense failed', { pid, err: new Error(error.message) });
    throw new Error('updateExpense failed');
  }
  return data ? mapExpense(data) : null;
}

export async function deleteExpense(pid: string, id: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('financial_expenses')
    .delete()
    .eq('property_id', pid)
    .eq('id', id)
    .select('id');
  if (error) {
    log.error('[financials/db] deleteExpense failed', { pid, err: new Error(error.message) });
    throw new Error('deleteExpense failed');
  }
  return (data ?? []).length > 0;
}

/** Prior invoice amounts for a vendor (for the 2×-outlier check). */
export async function vendorHistoryCents(
  pid: string,
  vendor: string,
  beforeDate?: string,
  limit = 40,
): Promise<number[]> {
  // Escape LIKE wildcards in OCR-derived vendor text so a vendor name
  // containing % or _ matches literally (case-insensitively) rather than
  // broadening the match and skewing the outlier baseline (Codex review V5).
  const escapedVendor = vendor.replace(/[\\%_]/g, '\\$&');
  let q = supabaseAdmin
    .from('financial_expenses')
    .select('amount_cents, expense_date')
    .eq('property_id', pid)
    .ilike('vendor', escapedVendor)
    .order('expense_date', { ascending: false })
    .limit(limit);
  if (beforeDate) q = q.lt('expense_date', beforeDate);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []).map((r) => num((r as Row).amount_cents)).filter((n) => n > 0);
}

// ════════════════════════════════════════════════════════════════════════════
// BUDGETS (department_budgets) + budget-vs-actual
// ════════════════════════════════════════════════════════════════════════════

export async function listBudgets(pid: string, month: string): Promise<DepartmentBudget[]> {
  const { data, error } = await supabaseAdmin
    .from('department_budgets')
    .select('*')
    .eq('property_id', pid)
    .eq('month_start', monthStartISO(month));
  if (error) {
    log.error('[financials/db] listBudgets failed', { pid, err: new Error(error.message) });
    throw new Error('listBudgets failed');
  }
  return (data ?? []).map(mapBudget);
}

export async function upsertBudget(
  pid: string,
  department: Department,
  month: string,
  budgetCents: number,
  notes?: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('department_budgets')
    .upsert(
      {
        property_id: pid,
        department,
        month_start: monthStartISO(month),
        budget_cents: Math.max(0, Math.round(budgetCents)),
        notes: notes ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'property_id,department,month_start' },
    );
  if (error) {
    log.error('[financials/db] upsertBudget failed', { pid, err: new Error(error.message) });
    throw new Error('upsertBudget failed');
  }
}

/** Per-department budget vs. actual for a month (one row per department). */
export async function budgetVsActual(pid: string, month: string): Promise<BudgetVsActual[]> {
  const [budgets, actuals] = await Promise.all([
    listBudgets(pid, month),
    sumExpensesByDepartment(pid, month),
  ]);
  const budgetByDept = Object.fromEntries(budgets.map((b) => [b.department, b.budgetCents])) as Record<
    Department,
    number
  >;
  return DEPARTMENTS.map((dept) => {
    const budgetCents = budgetByDept[dept] ?? 0;
    const actualCents = actuals[dept] ?? 0;
    return {
      department: dept,
      budgetCents,
      actualCents,
      remainingCents: budgetCents - actualCents,
      pctUsed: pctUsed(actualCents, budgetCents),
      status: budgetStatus(actualCents, budgetCents),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CAPEX (capex_projects + capex_line_items)
// ════════════════════════════════════════════════════════════════════════════

export async function listCapexProjects(pid: string): Promise<CapexProject[]> {
  const { data, error } = await supabaseAdmin
    .from('capex_projects')
    .select('*')
    .eq('property_id', pid)
    .order('created_at', { ascending: false });
  if (error) {
    log.error('[financials/db] listCapexProjects failed', { pid, err: new Error(error.message) });
    throw new Error('listCapexProjects failed');
  }
  const projects = (data ?? []).map(mapProject);
  if (projects.length === 0) return projects;

  // Roll up spent-to-date per project from line items (property-scoped).
  const { data: lines } = await supabaseAdmin
    .from('capex_line_items')
    .select('capex_project_id, amount_cents')
    .eq('property_id', pid);
  const spentByProject = new Map<string, number>();
  for (const l of lines ?? []) {
    const pidKey = (l as Row).capex_project_id as string;
    spentByProject.set(pidKey, (spentByProject.get(pidKey) ?? 0) + num((l as Row).amount_cents));
  }
  for (const p of projects) p.spentCents = spentByProject.get(p.id) ?? 0;
  return projects;
}

export async function getCapexProject(pid: string, id: string): Promise<CapexProject | null> {
  const { data, error } = await supabaseAdmin
    .from('capex_projects')
    .select('*')
    .eq('property_id', pid)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    log.error('[financials/db] getCapexProject failed', { pid, err: new Error(error.message) });
    throw new Error('getCapexProject failed');
  }
  if (!data) return null;
  const project = mapProject(data);
  const { data: lines } = await supabaseAdmin
    .from('capex_line_items')
    .select('*')
    .eq('property_id', pid)
    .eq('capex_project_id', id)
    .order('created_at', { ascending: true });
  const lineItems = (lines ?? []).map(mapLineItem);
  project.lineItems = lineItems;
  project.spentCents = lineItems.reduce((a, l) => a + l.amountCents, 0);
  return project;
}

export interface NewCapexProject {
  name: string;
  description?: string | null;
  quoteCents?: number;
  status?: CapexStatus;
  vendor?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
}

export async function createCapexProject(
  pid: string,
  createdBy: string | null,
  createdByName: string | null,
  p: NewCapexProject,
): Promise<CapexProject> {
  const { data, error } = await supabaseAdmin
    .from('capex_projects')
    .insert({
      property_id: pid,
      name: p.name,
      description: p.description ?? null,
      quote_cents: Math.max(0, Math.round(p.quoteCents ?? 0)),
      status: p.status ?? 'planned',
      vendor: p.vendor ?? null,
      start_date: p.startDate ?? null,
      target_date: p.targetDate ?? null,
      created_by: createdBy,
      created_by_name: createdByName,
    })
    .select('*')
    .single();
  if (error || !data) {
    log.error('[financials/db] createCapexProject failed', { pid, err: new Error(error?.message ?? 'no row') });
    throw new Error('createCapexProject failed');
  }
  const project = mapProject(data);
  project.spentCents = 0;
  project.lineItems = [];
  return project;
}

export interface CapexPatch {
  name?: string;
  description?: string | null;
  quoteCents?: number;
  status?: CapexStatus;
  vendor?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
}

export async function updateCapexProject(
  pid: string,
  id: string,
  patch: CapexPatch,
): Promise<CapexProject | null> {
  const upd: Row = {};
  if (patch.name !== undefined) upd.name = patch.name;
  if (patch.description !== undefined) upd.description = patch.description;
  if (patch.quoteCents !== undefined) upd.quote_cents = Math.max(0, Math.round(patch.quoteCents));
  if (patch.status !== undefined) upd.status = patch.status;
  if (patch.vendor !== undefined) upd.vendor = patch.vendor;
  if (patch.startDate !== undefined) upd.start_date = patch.startDate;
  if (patch.targetDate !== undefined) upd.target_date = patch.targetDate;
  if (Object.keys(upd).length === 0) return getCapexProject(pid, id);
  const { data, error } = await supabaseAdmin
    .from('capex_projects')
    .update(upd)
    .eq('property_id', pid)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) {
    log.error('[financials/db] updateCapexProject failed', { pid, err: new Error(error.message) });
    throw new Error('updateCapexProject failed');
  }
  if (!data) return null;
  return getCapexProject(pid, id);
}

export async function deleteCapexProject(pid: string, id: string): Promise<boolean> {
  // Line items cascade via the FK; still property-scoped on the project delete.
  const { data, error } = await supabaseAdmin
    .from('capex_projects')
    .delete()
    .eq('property_id', pid)
    .eq('id', id)
    .select('id');
  if (error) {
    log.error('[financials/db] deleteCapexProject failed', { pid, err: new Error(error.message) });
    throw new Error('deleteCapexProject failed');
  }
  return (data ?? []).length > 0;
}

export interface NewCapexLineItem {
  label: string;
  amountCents: number;
  vendor?: string | null;
  incurredDate?: string | null;
  source?: ExpenseSource;
}

/**
 * Add a line item to a project — but ONLY if that project belongs to pid. The
 * project lookup is property-scoped, so a forged projectId from another hotel
 * returns null (route → 404) and nothing is written.
 */
export async function addCapexLineItem(
  pid: string,
  projectId: string,
  item: NewCapexLineItem,
): Promise<CapexLineItem | null> {
  const owner = await supabaseAdmin
    .from('capex_projects')
    .select('id')
    .eq('property_id', pid)
    .eq('id', projectId)
    .maybeSingle();
  if (owner.error || !owner.data) return null;

  const { data, error } = await supabaseAdmin
    .from('capex_line_items')
    .insert({
      capex_project_id: projectId,
      property_id: pid,
      label: item.label,
      amount_cents: Math.max(0, Math.round(item.amountCents)),
      vendor: item.vendor ?? null,
      incurred_date: item.incurredDate ?? null,
      source: item.source ?? 'manual',
    })
    .select('*')
    .single();
  if (error || !data) {
    log.error('[financials/db] addCapexLineItem failed', { pid, err: new Error(error?.message ?? 'no row') });
    throw new Error('addCapexLineItem failed');
  }
  return mapLineItem(data);
}

export async function deleteCapexLineItem(pid: string, id: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('capex_line_items')
    .delete()
    .eq('property_id', pid)
    .eq('id', id)
    .select('id');
  if (error) {
    log.error('[financials/db] deleteCapexLineItem failed', { pid, err: new Error(error.message) });
    throw new Error('deleteCapexLineItem failed');
  }
  return (data ?? []).length > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// SUMMARY — profit = PMS revenue − expenses (live), CPOR, labor/expense ratio.
// Revenue comes from getMonthRevenue (the Dashboard's source) — never recomputed.
// ════════════════════════════════════════════════════════════════════════════

export async function getFinanceSummary(pid: string, month: string): Promise<FinanceSummary> {
  const [rev, expensesCents] = await Promise.all([
    getMonthRevenue(pid, month),
    totalExpenses(pid, month),
  ]);
  const profitCents = rev.revenueCents != null ? rev.revenueCents - expensesCents : null;
  const costPerOccupiedRoomCents =
    rev.occupiedRoomNights && rev.occupiedRoomNights > 0
      ? Math.round(expensesCents / rev.occupiedRoomNights)
      : null;
  const expensesPctOfRevenue =
    rev.revenueCents && rev.revenueCents > 0 ? (expensesCents / rev.revenueCents) * 100 : null;
  return {
    month,
    revenueCents: rev.revenueCents,
    revenueIsLive: rev.revenueIsLive,
    expensesCents,
    profitCents,
    occupiedRoomNights: rev.occupiedRoomNights,
    costPerOccupiedRoomCents,
    expensesPctOfRevenue,
  };
}
