/**
 * /api/financials/capex — capital projects (quote vs spent-to-date).
 *
 *   GET    ?pid=            → projects[] (each with spentCents)
 *   GET    ?pid=&id=        → one project with its line items
 *   POST   { pid, name, quoteCents|quoteDollars, status?, vendor?, description?,
 *            startDate?, targetDate? }                → create
 *   PATCH  { pid, id, ...patch }                      → update
 *   DELETE { pid, id }                                → delete (line items cascade)
 *
 * Spent-to-date = sum of line items; overrun % is computed client-side from
 * spentCents vs quoteCents. Money is integer cents.
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import { validateString, validateInt } from '@/lib/api-validate';
import { isCapexStatus, parseDollarsToCents } from '@/lib/financials/shared';
import {
  listCapexProjects,
  getCapexProject,
  createCapexProject,
  updateCapexProject,
  deleteCapexProject,
} from '@/lib/financials/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const YMD_RX = /^\d{4}-\d{2}-\d{2}$/;

function readCents(body: Record<string, unknown>, centsKey: string, dollarsKey: string): number | null {
  if (body[centsKey] !== undefined && body[centsKey] !== null) {
    const r = validateInt(body[centsKey], { min: 0, max: 1_000_000_000_00, label: centsKey });
    return r.error ? null : (r.value ?? null);
  }
  if (body[dollarsKey] !== undefined) return parseDollarsToCents(body[dollarsKey] as string);
  return null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireFinanceAccess(req, pid);
  if (!gate.ok) return gate.response;

  const id = req.nextUrl.searchParams.get('id');
  try {
    if (id) {
      const project = await getCapexProject(gate.pid, id);
      if (!project) return err('project not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
      return ok({ project }, { requestId: gate.requestId });
    }
    const projects = await listCapexProjects(gate.pid);
    return ok({ projects }, { requestId: gate.requestId });
  } catch {
    return err('failed to load capex', { requestId: gate.requestId, status: 500, code: 'load_failed' });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const nameCheck = validateString(body.name, { max: 200, label: 'name' });
  if (nameCheck.error || !nameCheck.value) return err('name is required', { requestId: gate.requestId, status: 400, code: 'invalid_name' });

  const quoteCents = readCents(body, 'quoteCents', 'quoteDollars') ?? 0;
  const status = isCapexStatus(body.status) ? body.status : 'planned';

  try {
    const project = await createCapexProject(gate.pid, gate.accountId, null, {
      name: nameCheck.value,
      description: optStr(body.description, 2000),
      quoteCents,
      status,
      vendor: optStr(body.vendor, 200),
      startDate: ymdOrNull(body.startDate),
      targetDate: ymdOrNull(body.targetDate),
    });
    return ok({ project }, { requestId: gate.requestId });
  } catch {
    return err('failed to create project', { requestId: gate.requestId, status: 500, code: 'create_failed' });
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const idCheck = validateString(body.id, { max: 40, label: 'id' });
  if (idCheck.error || !idCheck.value) return err('id is required', { requestId: gate.requestId, status: 400, code: 'invalid_id' });

  const patch: Parameters<typeof updateCapexProject>[2] = {};
  if (body.name !== undefined) {
    const n = validateString(body.name, { max: 200, label: 'name' });
    if (n.error || !n.value) return err('name is invalid', { requestId: gate.requestId, status: 400, code: 'invalid_name' });
    patch.name = n.value;
  }
  if (body.description !== undefined) patch.description = optStr(body.description, 2000);
  if (body.quoteCents !== undefined || body.quoteDollars !== undefined) {
    const c = readCents(body, 'quoteCents', 'quoteDollars');
    if (c == null || c < 0) return err('quote must be a non-negative number', { requestId: gate.requestId, status: 400, code: 'invalid_amount' });
    patch.quoteCents = c;
  }
  if (body.status !== undefined) {
    if (!isCapexStatus(body.status)) return err('status is invalid', { requestId: gate.requestId, status: 400, code: 'invalid_status' });
    patch.status = body.status;
  }
  if (body.vendor !== undefined) patch.vendor = optStr(body.vendor, 200);
  if (body.startDate !== undefined) patch.startDate = ymdOrNull(body.startDate);
  if (body.targetDate !== undefined) patch.targetDate = ymdOrNull(body.targetDate);

  try {
    const project = await updateCapexProject(gate.pid, idCheck.value, patch);
    if (!project) return err('project not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    return ok({ project }, { requestId: gate.requestId });
  } catch {
    return err('failed to update project', { requestId: gate.requestId, status: 500, code: 'update_failed' });
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const idCheck = validateString(body.id, { max: 40, label: 'id' });
  if (idCheck.error || !idCheck.value) return err('id is required', { requestId: gate.requestId, status: 400, code: 'invalid_id' });

  try {
    const deleted = await deleteCapexProject(gate.pid, idCheck.value);
    if (!deleted) return err('project not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    return ok({ deleted: true }, { requestId: gate.requestId });
  } catch {
    return err('failed to delete project', { requestId: gate.requestId, status: 500, code: 'delete_failed' });
  }
}

function optStr(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s.slice(0, max);
}
function ymdOrNull(v: unknown): string | null {
  return typeof v === 'string' && YMD_RX.test(v) ? v : null;
}
