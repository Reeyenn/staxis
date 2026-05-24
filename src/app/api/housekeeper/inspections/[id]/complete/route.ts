/**
 * POST /api/housekeeper/inspections/[id]/complete
 *
 * Public mirror of /api/housekeeping/inspections/[id]/complete for the
 * mobile InspectorView. Body adds pid + staffId for capability check.
 */

import { NextRequest } from 'next/server';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { getInspectionById, staffCanInspect } from '@/lib/db/inspections';
import { finalizeInspection } from '@/lib/inspections';
import type { InspectionFailedItem, InspectionItemSeverity } from '@/types/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface CompleteBody {
  pid?: unknown;
  staffId?: unknown;
  result?: unknown;
  failedItems?: unknown;
  passedItems?: unknown;
  notes?: unknown;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const requestId = getOrMintRequestId(req);
  const { id } = await ctx.params;

  const idV = validateUuid(id, 'id');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  let body: CompleteBody;
  try {
    body = (await req.json()) as CompleteBody;
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffId = staffV.value!;

  const resultV = validateEnum(body.result, ['pass', 'fail'] as const, 'result');
  if (resultV.error) {
    return err(resultV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const failedItems = parseFailedItems(body.failedItems);
  if (failedItems.error) {
    return err(failedItems.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const passedItems = parsePassedItems(body.passedItems);
  if (passedItems.error) {
    return err(passedItems.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null && body.notes !== '') {
    const v = validateString(body.notes, { max: 1000, label: 'notes' });
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    notes = v.value!;
  }

  if (resultV.value === 'pass' && failedItems.value!.length > 0) {
    return err('result=pass requires failedItems to be empty', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (resultV.value === 'fail' && failedItems.value!.length === 0) {
    return err('result=fail requires at least one failed item', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const canInspect = await staffCanInspect(pid, staffId);
  if (!canInspect) {
    return err('forbidden — not an inspector', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const before = await getInspectionById(id);
    if (!before) {
      return err('Inspection not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    if (before.propertyId !== pid) {
      return err('Inspection does not belong to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    const out = await finalizeInspection({
      inspectionId: id,
      result: resultV.value!,
      failedItems: failedItems.value!,
      passedItems: passedItems.value!,
      notes,
    });

    return ok(out, { requestId });
  } catch (e: unknown) {
    log.error('[housekeeper/inspections/[id]/complete] failed', {
      requestId, id, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

const SEVERITIES = ['minor', 'major', 'critical'] as const satisfies readonly InspectionItemSeverity[];

function parseFailedItems(raw: unknown): { error?: string; value?: InspectionFailedItem[] } {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'failedItems must be an array' };
  if (raw.length > 200) return { error: 'failedItems too long (max 200 items)' };
  const out: InspectionFailedItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const obj = raw[i];
    if (!obj || typeof obj !== 'object') {
      return { error: `failedItems[${i}] must be an object` };
    }
    const it = obj as Record<string, unknown>;
    if (typeof it.itemId !== 'string' || it.itemId.length === 0) {
      return { error: `failedItems[${i}].itemId is required` };
    }
    if (typeof it.label !== 'string' || it.label.length === 0) {
      return { error: `failedItems[${i}].label is required` };
    }
    if (typeof it.severity !== 'string' || !(SEVERITIES as readonly string[]).includes(it.severity)) {
      return { error: `failedItems[${i}].severity must be one of ${SEVERITIES.join(', ')}` };
    }
    const photoUrl = typeof it.photoUrl === 'string' && it.photoUrl.length > 0 ? it.photoUrl : null;
    const note = typeof it.note === 'string' && it.note.length > 0 ? it.note.slice(0, 500) : null;
    out.push({
      itemId: it.itemId,
      label: it.label.slice(0, 200),
      severity: it.severity as InspectionItemSeverity,
      photoUrl,
      note,
    });
  }
  return { value: out };
}

function parsePassedItems(raw: unknown): { error?: string; value?: string[] } {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'passedItems must be an array' };
  if (raw.length > 500) return { error: 'passedItems too long (max 500 items)' };
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'string' || v.length === 0) {
      return { error: `passedItems[${i}] must be a non-empty string` };
    }
    out.push(v);
  }
  return { value: out };
}
