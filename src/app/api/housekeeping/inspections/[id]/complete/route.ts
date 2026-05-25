/**
 * POST /api/housekeeping/inspections/[id]/complete
 *
 * Body: { result: 'pass' | 'fail', failedItems: [...], passedItems: [...], notes?: string }
 *
 * Finalizes an in-progress inspection. On fail, writes a correction
 * notice to the linked room so the housekeeper sees it in her queue.
 * Tracks consecutive fails to trigger manager escalation.
 *
 * Manager-facing route — requireSession + property access. The mobile
 * public mirror is /api/housekeeper/inspections/[id]/complete.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { getChecklistById, getInspectionById } from '@/lib/db/inspections';
import { finalizeInspection } from '@/lib/inspections';
import type { InspectionFailedItem, InspectionItemSeverity } from '@/types/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface CompleteBody {
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

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

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

  const resultV = validateEnum(body.result, ['pass', 'fail'] as const, 'result');
  if (resultV.error) {
    return err(resultV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const failedItemsParsed = parseFailedItems(body.failedItems);
  if (failedItemsParsed.error) {
    return err(failedItemsParsed.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const passedItemsParsed = parsePassedItems(body.passedItems);
  if (passedItemsParsed.error) {
    return err(passedItemsParsed.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null && body.notes !== '') {
    const v = validateString(body.notes, { max: 1000, label: 'notes' });
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    notes = v.value!;
  }

  // For result=pass, failedItems must be empty.
  if (resultV.value === 'pass' && failedItemsParsed.value!.length > 0) {
    return err('result=pass requires failedItems to be empty', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  // For result=fail, failedItems must have at least one entry.
  if (resultV.value === 'fail' && failedItemsParsed.value!.length === 0) {
    return err('result=fail requires at least one failed item', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const before = await getInspectionById(id);
    if (!before) {
      return err('Inspection not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    const hasAccess = await userHasPropertyAccess(auth.userId, before.propertyId);
    if (!hasAccess) {
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    // Codex M3 + M2: validate every failedItem.itemId belongs to the
    // linked checklist AND enforce requiresPhotoOnFail server-side.
    // Previously the UI was the only enforcement, so a direct API
    // call could bypass both rules.
    if (before.checklistId) {
      const checklist = await getChecklistById(before.checklistId);
      if (checklist) {
        const validIds = new Set(checklist.items.map((i) => i.id));
        const photoRequired = new Set(
          checklist.items.filter((i) => i.requiresPhotoOnFail).map((i) => i.id),
        );
        for (const f of failedItemsParsed.value!) {
          if (!validIds.has(f.itemId)) {
            return err(`failedItems contains an itemId not in the checklist: ${f.itemId}`, {
              requestId, status: 400, code: ApiErrorCode.ValidationFailed,
            });
          }
          if (photoRequired.has(f.itemId) && !f.photoUrl) {
            return err(`item ${f.itemId} requires a photo on fail`, {
              requestId, status: 400, code: ApiErrorCode.ValidationFailed,
            });
          }
        }
        for (const itemId of passedItemsParsed.value!) {
          if (!validIds.has(itemId)) {
            return err(`passedItems contains an itemId not in the checklist: ${itemId}`, {
              requestId, status: 400, code: ApiErrorCode.ValidationFailed,
            });
          }
        }
      }
    }

    const out = await finalizeInspection({
      inspectionId: id,
      result: resultV.value!,
      failedItems: failedItemsParsed.value!,
      passedItems: passedItemsParsed.value!,
      notes,
    });

    return ok(out, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/[id]/complete] failed', { requestId, id, msg: errToString(e) });
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
    if (
      typeof it.severity !== 'string' ||
      !(SEVERITIES as readonly string[]).includes(it.severity)
    ) {
      return { error: `failedItems[${i}].severity must be one of ${SEVERITIES.join(', ')}` };
    }
    const photoUrl =
      typeof it.photoUrl === 'string' && it.photoUrl.length > 0 ? it.photoUrl : null;
    const note =
      typeof it.note === 'string' && it.note.length > 0 ? it.note.slice(0, 500) : null;
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
