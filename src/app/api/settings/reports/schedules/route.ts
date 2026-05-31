/**
 * /api/settings/reports/schedules
 *
 *   GET    ?propertyId=UUID                  → list schedules for the property
 *   POST   { ...schedule }                   → create or update a schedule
 *   DELETE ?id=UUID&propertyId=UUID          → delete a schedule
 *
 * Auth: manager/owner/admin + property access on EVERY method. Schedules can
 * email arbitrary recipients (like report CC lists), so the manager gate +
 * property scoping + service-role-only table is the control. Recipients are
 * validated as emails and capped.
 */

import type { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api-response';
import { isValidEmail, validateEnum, validateInt, validateString, validateUuid } from '@/lib/api-validate';
import { reportKeys } from '@/lib/reports/catalog';
import { gateReportsAccess } from '@/lib/reports/catalog/gate';
import {
  deleteSchedule,
  listSchedules,
  upsertSchedule,
  type Cadence,
  type ScheduleRangeKind,
} from '@/lib/reports/catalog/store';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_RECIPIENTS = 20;
const CADENCES = ['daily', 'weekly', 'monthly'] as const;
const RANGE_KINDS = ['last7', 'last30', 'mtd', 'prev_month'] as const;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const pidV = validateUuid(req.nextUrl.searchParams.get('propertyId'), 'propertyId');
    if (pidV.error) return err(pidV.error ?? 'invalid propertyId', { requestId, status: 400, code: 'validation_failed' });
    const gate = await gateReportsAccess(req, pidV.value!);
    if (!gate.ok) return err(gate.error, { requestId, status: gate.status, code: gate.code });
    const schedules = await listSchedules(pidV.value!);
    return ok({ schedules }, { requestId });
  } catch (e) {
    log.error('reports schedules list failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to load schedules.', { requestId, status: 500, code: 'internal_error' });
  }
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const pidV = validateUuid(body.propertyId, 'propertyId');
    if (pidV.error) return err(pidV.error ?? 'invalid propertyId', { requestId, status: 400, code: 'validation_failed' });
    const propertyId = pidV.value!;

    const gate = await gateReportsAccess(req, propertyId);
    if (!gate.ok) return err(gate.error, { requestId, status: gate.status, code: gate.code });

    const keyV = validateString(body.reportKey, { label: 'reportKey', max: 100 });
    if (keyV.error) return err(keyV.error ?? 'invalid reportKey', { requestId, status: 400, code: 'validation_failed' });
    if (!reportKeys().includes(keyV.value!)) return err('Unknown report.', { requestId, status: 404, code: 'unknown_report' });

    const cadV = validateEnum(body.cadence, CADENCES, 'cadence');
    if (cadV.error) return err(cadV.error ?? 'invalid cadence', { requestId, status: 400, code: 'validation_failed' });
    const cadence = cadV.value as Cadence;

    const hourV = validateInt(body.hourLocal ?? 8, { label: 'hourLocal', min: 0, max: 23 });
    if (hourV.error) return err(hourV.error ?? 'invalid hourLocal', { requestId, status: 400, code: 'validation_failed' });

    let dayOfWeek: number | null = null;
    let dayOfMonth: number | null = null;
    if (cadence === 'weekly') {
      const dV = validateInt(body.dayOfWeek, { label: 'dayOfWeek', min: 0, max: 6 });
      if (dV.error) return err(dV.error ?? 'invalid dayOfWeek', { requestId, status: 400, code: 'validation_failed' });
      dayOfWeek = dV.value!;
    } else if (cadence === 'monthly') {
      const dV = validateInt(body.dayOfMonth, { label: 'dayOfMonth', min: 1, max: 28 });
      if (dV.error) return err(dV.error ?? 'invalid dayOfMonth', { requestId, status: 400, code: 'validation_failed' });
      dayOfMonth = dV.value!;
    }

    const rangeV = validateEnum(body.rangeKind ?? 'last7', RANGE_KINDS, 'rangeKind');
    if (rangeV.error) return err(rangeV.error ?? 'invalid rangeKind', { requestId, status: 400, code: 'validation_failed' });

    // Recipients — array of valid emails, deduped, capped.
    const rawRecipients = Array.isArray(body.recipients) ? body.recipients : [];
    const recipients = Array.from(
      new Set(
        rawRecipients
          .filter(isValidEmail)
          .map((e) => e.trim().toLowerCase()),
      ),
    );
    if (recipients.length === 0) {
      return err('Add at least one valid recipient email.', { requestId, status: 400, code: 'no_recipients' });
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return err(`Too many recipients (max ${MAX_RECIPIENTS}).`, { requestId, status: 400, code: 'too_many_recipients' });
    }

    let id: string | undefined;
    if (body.id !== undefined && body.id !== null) {
      const idV = validateUuid(body.id, 'id');
      if (idV.error) return err(idV.error ?? 'invalid id', { requestId, status: 400, code: 'validation_failed' });
      id = idV.value!;
    }

    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);

    const schedule = await upsertSchedule({
      id,
      propertyId,
      reportKey: keyV.value!,
      cadence,
      hourLocal: hourV.value!,
      dayOfWeek,
      dayOfMonth,
      rangeKind: rangeV.value as ScheduleRangeKind,
      recipients,
      enabled,
      createdByAccountId: gate.caller.accountId,
    });
    return ok({ schedule }, { requestId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'schedule_not_found') {
      return err('Schedule not found.', { requestId, status: 404, code: 'not_found' });
    }
    log.error('reports schedule upsert failed', { requestId, error: msg });
    return err('Failed to save schedule.', { requestId, status: 500, code: 'internal_error' });
  }
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const idV = validateUuid(req.nextUrl.searchParams.get('id'), 'id');
    if (idV.error) return err(idV.error ?? 'invalid id', { requestId, status: 400, code: 'validation_failed' });
    const pidV = validateUuid(req.nextUrl.searchParams.get('propertyId'), 'propertyId');
    if (pidV.error) return err(pidV.error ?? 'invalid propertyId', { requestId, status: 400, code: 'validation_failed' });

    const gate = await gateReportsAccess(req, pidV.value!);
    if (!gate.ok) return err(gate.error, { requestId, status: gate.status, code: gate.code });

    const deleted = await deleteSchedule(idV.value!, pidV.value!);
    if (!deleted) return err('Schedule not found.', { requestId, status: 404, code: 'not_found' });
    return ok({ deleted: true }, { requestId });
  } catch (e) {
    log.error('reports schedule delete failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to delete schedule.', { requestId, status: 500, code: 'internal_error' });
  }
}
