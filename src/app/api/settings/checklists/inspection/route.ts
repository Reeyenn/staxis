/**
 * /api/settings/checklists/inspection
 *
 *   GET    ?propertyId=UUID
 *            → the effective inspection checklist for the property (its own
 *              per-property checklist if it has one, else the global Staxis
 *              default shown as a starting point), with items + metadata.
 *   PUT    { propertyId, checklistId?, name, appliesToCleaningTypes[],
 *            appliesToRoomTypes[], items[] }
 *            → create/update the PER-PROPERTY checklist and replace its items.
 *              Never touches the global default (selectChecklist still resolves
 *              the per-property one first at inspection-start).
 *   DELETE ?propertyId=UUID&checklistId=UUID
 *            → delete the per-property checklist (then EMPTY — no global fallback as of 0305).
 *
 * Auth: manager/owner/admin + property access on EVERY method (gateChecklistAccess).
 * Service-role only — inspection_checklist* tables are deny-all to the browser.
 */

import type { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateEnum, validateString, validateUuid } from '@/lib/api-validate';
import { gateChecklistAccess } from '@/lib/checklists/access';
import {
  INSPECTION_CATEGORIES,
  INSPECTION_SEVERITIES,
  INSPECTION_APPLIES_CLEANING_TYPES,
  MAX_ITEMS_PER_CHECKLIST,
  MAX_ITEM_TEXT_LEN,
  MAX_NAME_LEN,
  getEffectiveInspectionChecklist,
  saveInspectionChecklist,
  deleteInspectionOverride,
  type InspectionItemInput,
} from '@/lib/db/checklists';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const MAX_APPLIES = 20;
const MAX_ROOM_TYPE_LEN = 40;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const pidV = validateUuid(req.nextUrl.searchParams.get('propertyId'), 'propertyId');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: 'validation_failed' });

    const gate = await gateChecklistAccess(req, pidV.value!, requestId);
    if (!gate.ok) return gate.response;

    const checklist = await getEffectiveInspectionChecklist(pidV.value!);
    return ok({ checklist }, { requestId });
  } catch (e) {
    log.error('checklists inspection GET failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to load checklist.', { requestId, status: 500, code: 'internal_error' });
  }
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const pidV = validateUuid(body.propertyId, 'propertyId');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: 'validation_failed' });

    const gate = await gateChecklistAccess(req, pidV.value!, requestId);
    if (!gate.ok) return gate.response;

    const nameV = validateString(body.name, { label: 'name', max: MAX_NAME_LEN });
    if (nameV.error) return err(nameV.error, { requestId, status: 400, code: 'validation_failed' });
    if (!nameV.value!.trim()) return err('name cannot be blank', { requestId, status: 400, code: 'validation_failed' });

    // checklistId optional — the per-property row being edited (from GET).
    let checklistId: string | null = null;
    if (body.checklistId !== undefined && body.checklistId !== null && body.checklistId !== '') {
      const v = validateUuid(body.checklistId, 'checklistId');
      if (v.error) return err(v.error, { requestId, status: 400, code: 'validation_failed' });
      checklistId = v.value!;
    }

    const cleaningTypes = parseAppliesCleaning(body.appliesToCleaningTypes);
    if (cleaningTypes.error) return err(cleaningTypes.error, { requestId, status: 400, code: 'validation_failed' });
    const roomTypes = parseAppliesRoom(body.appliesToRoomTypes);
    if (roomTypes.error) return err(roomTypes.error, { requestId, status: 400, code: 'validation_failed' });

    const parsed = parseInspectionItems(body.items);
    if (parsed.error) return err(parsed.error, { requestId, status: 400, code: 'validation_failed' });

    const checklist = await saveInspectionChecklist(pidV.value!, {
      checklistId,
      name: nameV.value!.trim(),
      appliesToCleaningTypes: cleaningTypes.value!,
      appliesToRoomTypes: roomTypes.value!,
      items: parsed.items!,
    });
    return ok({ checklist }, { requestId });
  } catch (e) {
    log.error('checklists inspection PUT failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to save checklist.', { requestId, status: 500, code: 'internal_error' });
  }
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const pidV = validateUuid(req.nextUrl.searchParams.get('propertyId'), 'propertyId');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: 'validation_failed' });
    const cidV = validateUuid(req.nextUrl.searchParams.get('checklistId'), 'checklistId');
    if (cidV.error) return err(cidV.error, { requestId, status: 400, code: 'validation_failed' });

    const gate = await gateChecklistAccess(req, pidV.value!, requestId);
    if (!gate.ok) return gate.response;

    const deleted = await deleteInspectionOverride(pidV.value!, cidV.value!);
    return ok({ reset: deleted }, { requestId });
  } catch (e) {
    log.error('checklists inspection DELETE failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to reset checklist.', { requestId, status: 500, code: 'internal_error' });
  }
}

function parseAppliesCleaning(raw: unknown): { error?: string; value?: string[] } {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'appliesToCleaningTypes must be an array' };
  if (raw.length > MAX_APPLIES) return { error: `Too many cleaning types (max ${MAX_APPLIES}).` };
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = validateEnum(raw[i], INSPECTION_APPLIES_CLEANING_TYPES, `appliesToCleaningTypes[${i}]`);
    if (v.error) return { error: v.error };
    out.push(v.value!);
  }
  return { value: out };
}

function parseAppliesRoom(raw: unknown): { error?: string; value?: string[] } {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'appliesToRoomTypes must be an array' };
  if (raw.length > MAX_APPLIES) return { error: `Too many room types (max ${MAX_APPLIES}).` };
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = validateString(raw[i], { label: `appliesToRoomTypes[${i}]`, max: MAX_ROOM_TYPE_LEN });
    if (v.error) return { error: v.error };
    out.push(v.value!.trim());
  }
  return { value: out };
}

/** Validate + normalize the inspection items array from a PUT body. */
function parseInspectionItems(raw: unknown): { error?: string; items?: InspectionItemInput[] } {
  if (!Array.isArray(raw)) return { error: 'items must be an array' };
  if (raw.length > MAX_ITEMS_PER_CHECKLIST) {
    return { error: `Too many items (max ${MAX_ITEMS_PER_CHECKLIST}).` };
  }
  const items: InspectionItemInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] as Record<string, unknown>;
    if (!it || typeof it !== 'object') return { error: `items[${i}] must be an object` };
    const catV = validateEnum(it.category, INSPECTION_CATEGORIES, `items[${i}].category`);
    if (catV.error) return { error: catV.error };
    const labelV = validateString(it.label, { label: `items[${i}].label`, max: MAX_ITEM_TEXT_LEN });
    if (labelV.error) return { error: labelV.error };
    const labelEsV = validateString(it.labelEs, { label: `items[${i}].labelEs`, max: MAX_ITEM_TEXT_LEN });
    if (labelEsV.error) return { error: labelEsV.error };
    const sevV = validateEnum(it.severityDefault, INSPECTION_SEVERITIES, `items[${i}].severityDefault`);
    if (sevV.error) return { error: sevV.error };
    const label = labelV.value!.trim();
    const labelEs = labelEsV.value!.trim();
    if (!label) return { error: `items[${i}].label cannot be blank` };
    if (!labelEs) return { error: `items[${i}].labelEs cannot be blank` };
    items.push({
      category: catV.value!,
      label,
      labelEs,
      severityDefault: sevV.value!,
      requiresPhotoOnFail: it.requiresPhotoOnFail === true,
    });
  }
  return { items };
}
