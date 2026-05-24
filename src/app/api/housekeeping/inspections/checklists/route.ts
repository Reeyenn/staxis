/**
 * GET  /api/housekeeping/inspections/checklists?pid=
 * POST /api/housekeeping/inspections/checklists
 *
 * GET lists all active checklists (global + property-scoped).
 * POST creates a new property-scoped checklist.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { createChecklist, getActiveChecklists } from '@/lib/db/inspections';
import type { InspectionItemCategory, InspectionItemSeverity } from '@/types/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const CATEGORIES = ['bathroom', 'bedroom', 'living', 'kitchen', 'welcome', 'other'] as const satisfies readonly InspectionItemCategory[];
const SEVERITIES = ['minor', 'major', 'critical'] as const satisfies readonly InspectionItemSeverity[];

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const checklists = await getActiveChecklists(pid);
    return ok(checklists, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/checklists] GET failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

interface CreateChecklistBody {
  pid?: unknown;
  name?: unknown;
  appliesToCleaningTypes?: unknown;
  appliesToRoomTypes?: unknown;
  items?: unknown;
}

interface RawChecklistItem {
  category?: unknown;
  label?: unknown;
  labelEs?: unknown;
  severityDefault?: unknown;
  requiresPhotoOnFail?: unknown;
  orderIndex?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let body: CreateChecklistBody;
  try {
    body = (await req.json()) as CreateChecklistBody;
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const nameV = validateString(body.name, { max: 120, label: 'name' });
  if (nameV.error) {
    return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const name = nameV.value!;

  const cleaningTypes = parseStringArray(body.appliesToCleaningTypes, 'appliesToCleaningTypes');
  if (cleaningTypes.error) {
    return err(cleaningTypes.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const roomTypes = parseStringArray(body.appliesToRoomTypes, 'appliesToRoomTypes');
  if (roomTypes.error) {
    return err(roomTypes.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return err('items is required (at least one)', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (body.items.length > 100) {
    return err('items too long (max 100)', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const items: Array<{
    category: InspectionItemCategory;
    label: string;
    labelEs?: string | null;
    severityDefault?: InspectionItemSeverity;
    requiresPhotoOnFail?: boolean;
    orderIndex?: number;
  }> = [];
  for (let i = 0; i < body.items.length; i++) {
    const raw = body.items[i] as RawChecklistItem;
    if (!raw || typeof raw !== 'object') {
      return err(`items[${i}] must be an object`, {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    if (typeof raw.category !== 'string' || !(CATEGORIES as readonly string[]).includes(raw.category)) {
      return err(`items[${i}].category must be one of ${CATEGORIES.join(', ')}`, {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    if (typeof raw.label !== 'string' || raw.label.length === 0 || raw.label.length > 200) {
      return err(`items[${i}].label must be 1..200 chars`, {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    const sev = typeof raw.severityDefault === 'string' && (SEVERITIES as readonly string[]).includes(raw.severityDefault)
      ? (raw.severityDefault as InspectionItemSeverity)
      : 'minor';
    items.push({
      category: raw.category as InspectionItemCategory,
      label: raw.label,
      labelEs: typeof raw.labelEs === 'string' && raw.labelEs.length > 0 ? raw.labelEs.slice(0, 200) : null,
      severityDefault: sev,
      requiresPhotoOnFail: Boolean(raw.requiresPhotoOnFail),
      orderIndex: typeof raw.orderIndex === 'number' ? raw.orderIndex : undefined,
    });
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const checklist = await createChecklist({
      propertyId: pid,
      name,
      appliesToCleaningTypes: cleaningTypes.value!,
      appliesToRoomTypes: roomTypes.value!,
      items,
    });
    return ok(checklist, { requestId, status: 201 });
  } catch (e: unknown) {
    log.error('[inspections/checklists] POST failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

function parseStringArray(raw: unknown, label: string): { error?: string; value?: string[] } {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: `${label} must be an array of strings` };
  if (raw.length > 50) return { error: `${label} too long (max 50)` };
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'string' || v.length === 0 || v.length > 60) {
      return { error: `${label}[${i}] must be a non-empty string under 60 chars` };
    }
    out.push(v);
  }
  return { value: out };
}
