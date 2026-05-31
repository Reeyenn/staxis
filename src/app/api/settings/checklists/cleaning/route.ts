/**
 * /api/settings/checklists/cleaning
 *
 *   GET    ?propertyId=UUID&cleaningType=departure
 *            → the effective cleaning checklist for the property (per-property
 *              override if it exists, else the global Staxis default shown as a
 *              starting point), with all items + whether it's customized.
 *   PUT    { propertyId, cleaningType, nameEn?, nameEs?, items[] }
 *            → create/update the PER-PROPERTY override and replace its items.
 *              Never touches the global default.
 *   DELETE ?propertyId=UUID&cleaningType=departure
 *            → reset to the Staxis default by deleting the per-property override.
 *
 * Auth: manager/owner/admin + property access on EVERY method (gateChecklistAccess).
 * Service-role only — the cleaning_checklist_* tables are deny-all to the
 * browser; all access flows through here.
 */

import type { NextRequest } from 'next/server';
import { err, ok } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateEnum, validateString, validateUuid } from '@/lib/api-validate';
import { gateChecklistAccess } from '@/lib/checklists/access';
import {
  CLEANING_TYPES,
  CLEANING_AREAS,
  MAX_ITEMS_PER_CHECKLIST,
  MAX_ITEM_TEXT_LEN,
  MAX_NAME_LEN,
  getEffectiveCleaningChecklist,
  saveCleaningOverride,
  deleteCleaningOverride,
  type CleaningItemInput,
  type CleaningType,
} from '@/lib/db/checklists';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const pidV = validateUuid(req.nextUrl.searchParams.get('propertyId'), 'propertyId');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: 'validation_failed' });
    const typeV = validateEnum(req.nextUrl.searchParams.get('cleaningType'), CLEANING_TYPES, 'cleaningType');
    if (typeV.error) return err(typeV.error, { requestId, status: 400, code: 'validation_failed' });

    const gate = await gateChecklistAccess(req, pidV.value!);
    if (!gate.ok) return err(gate.error, { requestId, status: gate.status, code: gate.code });

    const checklist = await getEffectiveCleaningChecklist(pidV.value!, typeV.value as CleaningType);
    return ok({ checklist }, { requestId });
  } catch (e) {
    log.error('checklists cleaning GET failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to load checklist.', { requestId, status: 500, code: 'internal_error' });
  }
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const pidV = validateUuid(body.propertyId, 'propertyId');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: 'validation_failed' });
    const typeV = validateEnum(body.cleaningType, CLEANING_TYPES, 'cleaningType');
    if (typeV.error) return err(typeV.error, { requestId, status: 400, code: 'validation_failed' });

    const gate = await gateChecklistAccess(req, pidV.value!);
    if (!gate.ok) return err(gate.error, { requestId, status: gate.status, code: gate.code });

    const parsed = parseCleaningItems(body.items);
    if (parsed.error) return err(parsed.error, { requestId, status: 400, code: 'validation_failed' });

    // Optional names — fall back to the existing/default name inside the db layer.
    let nameEn: string | null = null;
    let nameEs: string | null = null;
    if (body.nameEn !== undefined && body.nameEn !== null) {
      const v = validateString(body.nameEn, { label: 'nameEn', max: MAX_NAME_LEN, allowEmpty: true });
      if (v.error) return err(v.error, { requestId, status: 400, code: 'validation_failed' });
      nameEn = v.value!;
    }
    if (body.nameEs !== undefined && body.nameEs !== null) {
      const v = validateString(body.nameEs, { label: 'nameEs', max: MAX_NAME_LEN, allowEmpty: true });
      if (v.error) return err(v.error, { requestId, status: 400, code: 'validation_failed' });
      nameEs = v.value!;
    }

    const checklist = await saveCleaningOverride(pidV.value!, typeV.value as CleaningType, {
      nameEn,
      nameEs,
      items: parsed.items!,
    });
    return ok({ checklist }, { requestId });
  } catch (e) {
    log.error('checklists cleaning PUT failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to save checklist.', { requestId, status: 500, code: 'internal_error' });
  }
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  try {
    const pidV = validateUuid(req.nextUrl.searchParams.get('propertyId'), 'propertyId');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: 'validation_failed' });
    const typeV = validateEnum(req.nextUrl.searchParams.get('cleaningType'), CLEANING_TYPES, 'cleaningType');
    if (typeV.error) return err(typeV.error, { requestId, status: 400, code: 'validation_failed' });

    const gate = await gateChecklistAccess(req, pidV.value!);
    if (!gate.ok) return err(gate.error, { requestId, status: gate.status, code: gate.code });

    const deleted = await deleteCleaningOverride(pidV.value!, typeV.value as CleaningType);
    return ok({ reset: deleted }, { requestId });
  } catch (e) {
    log.error('checklists cleaning DELETE failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    return err('Failed to reset checklist.', { requestId, status: 500, code: 'internal_error' });
  }
}

/** Validate + normalize the items array from a PUT body. */
function parseCleaningItems(raw: unknown): { error?: string; items?: CleaningItemInput[] } {
  if (!Array.isArray(raw)) return { error: 'items must be an array' };
  if (raw.length > MAX_ITEMS_PER_CHECKLIST) {
    return { error: `Too many items (max ${MAX_ITEMS_PER_CHECKLIST}).` };
  }
  const items: CleaningItemInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] as Record<string, unknown>;
    if (!it || typeof it !== 'object') return { error: `items[${i}] must be an object` };
    const areaV = validateEnum(it.area, CLEANING_AREAS, `items[${i}].area`);
    if (areaV.error) return { error: areaV.error };
    const enV = validateString(it.itemEn, { label: `items[${i}].itemEn`, max: MAX_ITEM_TEXT_LEN });
    if (enV.error) return { error: enV.error };
    const esV = validateString(it.itemEs, { label: `items[${i}].itemEs`, max: MAX_ITEM_TEXT_LEN });
    if (esV.error) return { error: esV.error };
    items.push({
      area: areaV.value!,
      itemEn: enV.value!.trim(),
      itemEs: esV.value!.trim(),
      isCritical: it.isCritical === true,
    });
  }
  return { items };
}
