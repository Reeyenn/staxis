/**
 * Shared core for completing (finalizing) an inspection.
 *
 * The two complete routes — /api/housekeeper/inspections/[id]/complete
 * (public, staff-link-token gated) and
 * /api/housekeeping/inspections/[id]/complete (manager, session gated) —
 * share everything downstream of auth: parsing/validating the request
 * body (failedItems / passedItems / severities + the pass-empty /
 * fail-nonempty rule), validating item ids against the linked checklist
 * (incl. requiresPhotoOnFail), and the finalizeInspection call.
 *
 * Auth and the property-ownership gate stay in the route files: the
 * public route knows `pid` up front and checks before.propertyId === pid;
 * the session route derives the property from the inspection and checks
 * userHasPropertyAccess. Both load `before` themselves and hand it here.
 */

import { finalizeInspection } from './correction-loop';
import { getChecklistById } from '@/lib/db/inspections';
import type {
  Inspection,
  InspectionFailedItem,
  InspectionItemSeverity,
} from '@/types/inspections';
import type { CompleteInspectionResult } from './correction-loop';

const SEVERITIES = ['minor', 'major', 'critical'] as const satisfies readonly InspectionItemSeverity[];

export interface ParsedCompleteBody {
  result: 'pass' | 'fail';
  failedItems: InspectionFailedItem[];
  passedItems: string[];
  notes: string | null;
}

/**
 * Parse + validate the raw complete-inspection body. Returns a single
 * error string (the route maps it to a 400) or the parsed values.
 *
 * `notes` is pre-validated by the route (it needs the shared
 * validateString length gate), so it is passed through here.
 */
export function parseCompleteInspectionBody(input: {
  result: 'pass' | 'fail';
  failedItemsRaw: unknown;
  passedItemsRaw: unknown;
  notes: string | null;
}): { error?: string; value?: ParsedCompleteBody } {
  const failed = parseFailedItems(input.failedItemsRaw);
  if (failed.error) return { error: failed.error };
  const passed = parsePassedItems(input.passedItemsRaw);
  if (passed.error) return { error: passed.error };

  if (input.result === 'pass' && failed.value!.length > 0) {
    return { error: 'result=pass requires failedItems to be empty' };
  }
  if (input.result === 'fail' && failed.value!.length === 0) {
    return { error: 'result=fail requires at least one failed item' };
  }

  return {
    value: {
      result: input.result,
      failedItems: failed.value!,
      passedItems: passed.value!,
      notes: input.notes,
    },
  };
}

/**
 * Validate every failedItem / passedItem against the inspection's linked
 * checklist (Codex M3 + M2: enforce membership AND requiresPhotoOnFail
 * server-side), then finalize. Validation failures come back as an error
 * string (route → 400); anything finalizeInspection throws propagates to
 * the route's try/catch.
 */
export async function validateAndFinalizeInspection(args: {
  before: Inspection;
  parsed: ParsedCompleteBody;
}): Promise<{ error?: string; value?: CompleteInspectionResult }> {
  const { before, parsed } = args;

  if (before.checklistId) {
    const checklist = await getChecklistById(before.checklistId);
    if (checklist) {
      const validIds = new Set(checklist.items.map((i) => i.id));
      const photoRequired = new Set(
        checklist.items.filter((i) => i.requiresPhotoOnFail).map((i) => i.id),
      );
      for (const f of parsed.failedItems) {
        if (!validIds.has(f.itemId)) {
          return { error: `failedItems contains an itemId not in the checklist: ${f.itemId}` };
        }
        if (photoRequired.has(f.itemId) && !f.photoUrl) {
          return { error: `item ${f.itemId} requires a photo on fail` };
        }
      }
      for (const itemId of parsed.passedItems) {
        if (!validIds.has(itemId)) {
          return { error: `passedItems contains an itemId not in the checklist: ${itemId}` };
        }
      }
    }
  }

  const out = await finalizeInspection({
    inspectionId: before.id,
    result: parsed.result,
    failedItems: parsed.failedItems,
    passedItems: parsed.passedItems,
    notes: parsed.notes,
  });

  return { value: out };
}

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
