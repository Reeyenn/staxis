/**
 * /api/financials/expenses — the Checkbook register.
 *
 *   GET    ?pid=&month=YYYY-MM&department=  → list + month totals (per dept)
 *   POST   { pid, expenseDate, amountCents|amountDollars, vendor, department,
 *            category?, notes?, source? }   → create one expense
 *   PATCH  { pid, id, ...patch }            → edit one expense
 *   DELETE { pid, id }                      → delete one expense
 *
 * Every method goes through requireFinanceAccess (owner/GM/admin + property
 * scope). Money is integer cents; dollars are accepted only as input and
 * rounded once via parseDollarsToCents.
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import { validateString, validateInt } from '@/lib/api-validate';
import {
  isDepartment,
  isMonthKey,
  parseDollarsToCents,
  type Department,
} from '@/lib/financials/shared';
import {
  listExpenses,
  sumExpensesByDepartment,
  totalExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
} from '@/lib/financials/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const YMD_RX = /^\d{4}-\d{2}-\d{2}$/;

function readAmountCents(body: Record<string, unknown>): number | null {
  if (body.amountCents !== undefined && body.amountCents !== null) {
    const r = validateInt(body.amountCents, { min: 0, max: 1_000_000_000_00, label: 'amountCents' });
    return r.error ? null : (r.value ?? null);
  }
  if (body.amountDollars !== undefined || body.amount !== undefined) {
    return parseDollarsToCents((body.amountDollars ?? body.amount) as string);
  }
  return null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireFinanceAccess(req, pid);
  if (!gate.ok) return gate.response;

  const monthParam = req.nextUrl.searchParams.get('month') ?? undefined;
  const month = monthParam && isMonthKey(monthParam) ? monthParam : undefined;
  const deptParam = req.nextUrl.searchParams.get('department');
  const department = deptParam && isDepartment(deptParam) ? (deptParam as Department) : undefined;

  try {
    const [expenses, byDepartment] = await Promise.all([
      listExpenses(gate.pid, { month, department }),
      month ? sumExpensesByDepartment(gate.pid, month) : Promise.resolve(null),
    ]);
    const total = expenses.reduce((a, e) => a + e.amountCents, 0);
    return ok({ expenses, total, byDepartment, month: month ?? null }, { requestId: gate.requestId });
  } catch {
    return err('failed to load expenses', { requestId: gate.requestId, status: 500, code: 'load_failed' });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  // expense_date
  const expenseDate = body.expenseDate;
  if (typeof expenseDate !== 'string' || !YMD_RX.test(expenseDate)) {
    return err('expenseDate must be YYYY-MM-DD', { requestId: gate.requestId, status: 400, code: 'invalid_date' });
  }
  // amount
  const amountCents = readAmountCents(body);
  if (amountCents == null || amountCents < 0) {
    return err('amount must be a non-negative number', { requestId: gate.requestId, status: 400, code: 'invalid_amount' });
  }
  // department
  if (!isDepartment(body.department)) {
    return err('department is invalid', { requestId: gate.requestId, status: 400, code: 'invalid_department' });
  }
  // optional strings
  const vendor = optionalString(body.vendor, 200);
  if (vendor === false) return err('vendor too long', { requestId: gate.requestId, status: 400 });
  const category = optionalString(body.category, 100);
  if (category === false) return err('category too long', { requestId: gate.requestId, status: 400 });
  const notes = optionalString(body.notes, 2000);
  if (notes === false) return err('notes too long', { requestId: gate.requestId, status: 400 });
  const source = body.source === 'invoice_scan' ? 'invoice_scan' : 'manual';
  const invoiceNumber = optionalString(body.invoiceNumber, 100);
  const invoiceDate = typeof body.invoiceDate === 'string' && YMD_RX.test(body.invoiceDate) ? body.invoiceDate : null;

  try {
    const expense = await createExpense(gate.pid, gate.accountId, null, {
      expenseDate,
      amountCents,
      vendor: vendor || null,
      department: body.department,
      category: category || null,
      notes: notes || null,
      source,
      invoiceNumber: invoiceNumber || null,
      invoiceDate,
    });
    return ok({ expense }, { requestId: gate.requestId });
  } catch {
    return err('failed to create expense', { requestId: gate.requestId, status: 500, code: 'create_failed' });
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const idCheck = validateString(body.id, { max: 40, label: 'id' });
  if (idCheck.error || !idCheck.value) return err('id is required', { requestId: gate.requestId, status: 400, code: 'invalid_id' });

  const patch: Parameters<typeof updateExpense>[2] = {};
  if (body.expenseDate !== undefined) {
    if (typeof body.expenseDate !== 'string' || !YMD_RX.test(body.expenseDate)) {
      return err('expenseDate must be YYYY-MM-DD', { requestId: gate.requestId, status: 400, code: 'invalid_date' });
    }
    patch.expenseDate = body.expenseDate;
  }
  if (body.amountCents !== undefined || body.amountDollars !== undefined || body.amount !== undefined) {
    const cents = readAmountCents(body);
    if (cents == null || cents < 0) return err('amount must be a non-negative number', { requestId: gate.requestId, status: 400, code: 'invalid_amount' });
    patch.amountCents = cents;
  }
  if (body.department !== undefined) {
    if (!isDepartment(body.department)) return err('department is invalid', { requestId: gate.requestId, status: 400, code: 'invalid_department' });
    patch.department = body.department;
  }
  if (body.vendor !== undefined) patch.vendor = clampString(body.vendor, 200);
  if (body.category !== undefined) patch.category = clampString(body.category, 100);
  if (body.notes !== undefined) patch.notes = clampString(body.notes, 2000);
  if (body.invoiceNumber !== undefined) patch.invoiceNumber = clampString(body.invoiceNumber, 100);
  if (body.invoiceDate !== undefined) {
    patch.invoiceDate = typeof body.invoiceDate === 'string' && YMD_RX.test(body.invoiceDate) ? body.invoiceDate : null;
  }

  try {
    const expense = await updateExpense(gate.pid, idCheck.value, patch);
    if (!expense) return err('expense not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    return ok({ expense }, { requestId: gate.requestId });
  } catch {
    return err('failed to update expense', { requestId: gate.requestId, status: 500, code: 'update_failed' });
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const idCheck = validateString(body.id, { max: 40, label: 'id' });
  if (idCheck.error || !idCheck.value) return err('id is required', { requestId: gate.requestId, status: 400, code: 'invalid_id' });

  try {
    const deleted = await deleteExpense(gate.pid, idCheck.value);
    if (!deleted) return err('expense not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    // Hand back the fresh month total so the client can update running totals.
    const month = typeof body.month === 'string' && isMonthKey(body.month) ? body.month : undefined;
    const total = month ? await totalExpenses(gate.pid, month) : undefined;
    return ok({ deleted: true, total }, { requestId: gate.requestId });
  } catch {
    return err('failed to delete expense', { requestId: gate.requestId, status: 500, code: 'delete_failed' });
  }
}

// ── tiny local helpers ──────────────────────────────────────────────────────
// Returns the trimmed string, '' for nullish, or false when over max (→ 400).
function optionalString(v: unknown, max: number): string | false {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length > max) return false;
  return s;
}
// Coerce to a capped string (or null) without erroring — used in PATCH.
function clampString(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s.slice(0, max);
}
