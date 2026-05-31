/**
 * /api/financials/capex/line-items — actual costs under a capex project.
 *
 *   POST   { pid, projectId, label, amountCents|amountDollars, vendor?,
 *            incurredDate?, source? }   → add a line item
 *   DELETE { pid, id, projectId? }      → remove a line item
 *
 * Adds are only allowed onto a project that belongs to pid (the db layer
 * re-verifies ownership before insert). Both methods return the refreshed
 * project so the client can re-render spent-to-date in one round trip.
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import { validateString, validateInt } from '@/lib/api-validate';
import { parseDollarsToCents } from '@/lib/financials/shared';
import { addCapexLineItem, deleteCapexLineItem, getCapexProject } from '@/lib/financials/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const YMD_RX = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const projCheck = validateString(body.projectId, { max: 40, label: 'projectId' });
  if (projCheck.error || !projCheck.value) return err('projectId is required', { requestId: gate.requestId, status: 400, code: 'invalid_project' });
  const labelCheck = validateString(body.label, { max: 200, label: 'label' });
  if (labelCheck.error || !labelCheck.value) return err('label is required', { requestId: gate.requestId, status: 400, code: 'invalid_label' });

  let amountCents: number | null = null;
  if (body.amountCents !== undefined && body.amountCents !== null) {
    const r = validateInt(body.amountCents, { min: 0, max: 1_000_000_000_00, label: 'amountCents' });
    if (r.error) return err(r.error, { requestId: gate.requestId, status: 400, code: 'invalid_amount' });
    amountCents = r.value ?? null;
  } else if (body.amountDollars !== undefined) {
    amountCents = parseDollarsToCents(body.amountDollars as string);
  }
  if (amountCents == null || amountCents < 0) {
    return err('amount must be a non-negative number', { requestId: gate.requestId, status: 400, code: 'invalid_amount' });
  }

  const vendor = typeof body.vendor === 'string' ? body.vendor.trim().slice(0, 200) || null : null;
  const incurredDate = typeof body.incurredDate === 'string' && YMD_RX.test(body.incurredDate) ? body.incurredDate : null;
  const source = body.source === 'invoice_scan' ? 'invoice_scan' : 'manual';

  try {
    const line = await addCapexLineItem(gate.pid, projCheck.value, {
      label: labelCheck.value,
      amountCents,
      vendor,
      incurredDate,
      source,
    });
    if (!line) return err('project not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    const project = await getCapexProject(gate.pid, projCheck.value);
    return ok({ line, project }, { requestId: gate.requestId });
  } catch {
    return err('failed to add line item', { requestId: gate.requestId, status: 500, code: 'create_failed' });
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  const idCheck = validateString(body.id, { max: 40, label: 'id' });
  if (idCheck.error || !idCheck.value) return err('id is required', { requestId: gate.requestId, status: 400, code: 'invalid_id' });

  try {
    const deleted = await deleteCapexLineItem(gate.pid, idCheck.value);
    if (!deleted) return err('line item not found', { requestId: gate.requestId, status: 404, code: 'not_found' });
    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    const project = projectId ? await getCapexProject(gate.pid, projectId) : null;
    return ok({ deleted: true, project }, { requestId: gate.requestId });
  } catch {
    return err('failed to delete line item', { requestId: gate.requestId, status: 500, code: 'delete_failed' });
  }
}
