// Request-body validation for the equipment routes. Pure (no server imports)
// so it can live beside the shared types. Returns a FULL EquipmentInput (every
// key defined; optional fields coerced to null) — used by both create and the
// full-replace edit (PATCH), since the registry edit form always submits every
// field pre-filled.

import {
  validateString, validateEnum, validateNumber, validateInt, validateDateStr,
} from '@/lib/api-validate';
import { EQUIPMENT_CATEGORIES, EQUIPMENT_STATUSES, type EquipmentInput } from './types';

// undefined / null / '' → null; otherwise trim + length-check.
function optText(v: unknown, max: number, label: string): { error?: string; value?: string | null } {
  if (v === undefined || v === null) return { value: null };
  if (typeof v !== 'string') return { error: `${label} must be a string` };
  const t = v.trim();
  if (t === '') return { value: null };
  if (t.length > max) return { error: `${label} too long (max ${max} chars)` };
  return { value: t };
}
function optNumber(v: unknown, label: string, min: number, max: number): { error?: string; value?: number | null } {
  if (v === undefined || v === null || v === '') return { value: null };
  const r = validateNumber(v, { min, max, label });
  return r.error ? { error: r.error } : { value: r.value! };
}
function optIntField(v: unknown, label: string, min: number, max: number): { error?: string; value?: number | null } {
  if (v === undefined || v === null || v === '') return { value: null };
  const r = validateInt(v, { min, max, label });
  return r.error ? { error: r.error } : { value: r.value! };
}
function optDate(v: unknown, label: string): { error?: string; value?: string | null } {
  if (v === undefined || v === null || v === '') return { value: null };
  const r = validateDateStr(v, { label });
  return r.error ? { error: r.error } : { value: r.value! };
}

export function parseEquipmentInput(body: Record<string, unknown>): { error?: string; value?: EquipmentInput } {
  const nameV = validateString(body.name, { max: 120, label: 'name' });
  if (nameV.error) return { error: nameV.error };
  const catV = validateEnum(body.category, EQUIPMENT_CATEGORIES, 'category');
  if (catV.error) return { error: catV.error };

  // status optional → defaults to operational.
  let status: EquipmentInput['status'] = 'operational';
  if (body.status !== undefined && body.status !== null && body.status !== '') {
    const sV = validateEnum(body.status, EQUIPMENT_STATUSES, 'status');
    if (sV.error) return { error: sV.error };
    status = sV.value!;
  }

  const location = optText(body.location, 160, 'location');
  if (location.error) return { error: location.error };
  const manufacturer = optText(body.manufacturer, 120, 'manufacturer');
  if (manufacturer.error) return { error: manufacturer.error };
  const modelNumber = optText(body.modelNumber, 120, 'model number');
  if (modelNumber.error) return { error: modelNumber.error };
  const serialNumber = optText(body.serialNumber, 120, 'serial number');
  if (serialNumber.error) return { error: serialNumber.error };
  const warrantyProvider = optText(body.warrantyProvider, 120, 'warranty provider');
  if (warrantyProvider.error) return { error: warrantyProvider.error };
  const notes = optText(body.notes, 2000, 'notes');
  if (notes.error) return { error: notes.error };

  const installDate = optDate(body.installDate, 'install date');
  if (installDate.error) return { error: installDate.error };
  const warrantyExpiresAt = optDate(body.warrantyExpiresAt, 'warranty expiry');
  if (warrantyExpiresAt.error) return { error: warrantyExpiresAt.error };

  const expectedLifetimeYears = optNumber(body.expectedLifetimeYears, 'expected lifetime', 0, 200);
  if (expectedLifetimeYears.error) return { error: expectedLifetimeYears.error };
  const purchaseCost = optNumber(body.purchaseCost, 'purchase cost', 0, 100_000_000);
  if (purchaseCost.error) return { error: purchaseCost.error };
  const replacementCost = optNumber(body.replacementCost, 'replacement cost', 0, 100_000_000);
  if (replacementCost.error) return { error: replacementCost.error };
  const pmIntervalDays = optIntField(body.pmIntervalDays, 'PM interval (days)', 0, 100_000);
  if (pmIntervalDays.error) return { error: pmIntervalDays.error };

  return {
    value: {
      name: nameV.value!,
      category: catV.value!,
      status,
      location: location.value ?? null,
      manufacturer: manufacturer.value ?? null,
      modelNumber: modelNumber.value ?? null,
      serialNumber: serialNumber.value ?? null,
      warrantyProvider: warrantyProvider.value ?? null,
      notes: notes.value ?? null,
      installDate: installDate.value ?? null,
      warrantyExpiresAt: warrantyExpiresAt.value ?? null,
      expectedLifetimeYears: expectedLifetimeYears.value ?? null,
      purchaseCost: purchaseCost.value ?? null,
      replacementCost: replacementCost.value ?? null,
      pmIntervalDays: pmIntervalDays.value ?? null,
    },
  };
}

// PATCH variant — emits ONLY the keys actually present in the body, so a
// partial update can't silently null out fields the caller didn't send. The
// registry edit form sends every field (→ behaves as a full update), but any
// other caller gets true PATCH semantics. name/category, if present, must be
// valid (name non-empty; both have NOT NULL / CHECK constraints).
export function parseEquipmentPatch(body: Record<string, unknown>): { error?: string; value?: Partial<EquipmentInput> } {
  const out: Partial<EquipmentInput> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;

  if (has('name')) {
    const r = validateString(body.name, { max: 120, label: 'name' });
    if (r.error) return { error: r.error };
    out.name = r.value!;
  }
  if (has('category')) {
    const r = validateEnum(body.category, EQUIPMENT_CATEGORIES, 'category');
    if (r.error) return { error: r.error };
    out.category = r.value!;
  }
  if (has('status')) {
    const r = validateEnum(body.status, EQUIPMENT_STATUSES, 'status');
    if (r.error) return { error: r.error };
    out.status = r.value!;
  }
  if (has('location'))          { const r = optText(body.location, 160, 'location');                  if (r.error) return { error: r.error }; out.location = r.value!; }
  if (has('manufacturer'))      { const r = optText(body.manufacturer, 120, 'manufacturer');          if (r.error) return { error: r.error }; out.manufacturer = r.value!; }
  if (has('modelNumber'))       { const r = optText(body.modelNumber, 120, 'model number');           if (r.error) return { error: r.error }; out.modelNumber = r.value!; }
  if (has('serialNumber'))      { const r = optText(body.serialNumber, 120, 'serial number');         if (r.error) return { error: r.error }; out.serialNumber = r.value!; }
  if (has('warrantyProvider'))  { const r = optText(body.warrantyProvider, 120, 'warranty provider'); if (r.error) return { error: r.error }; out.warrantyProvider = r.value!; }
  if (has('notes'))             { const r = optText(body.notes, 2000, 'notes');                       if (r.error) return { error: r.error }; out.notes = r.value!; }
  if (has('installDate'))       { const r = optDate(body.installDate, 'install date');                if (r.error) return { error: r.error }; out.installDate = r.value!; }
  if (has('warrantyExpiresAt')) { const r = optDate(body.warrantyExpiresAt, 'warranty expiry');       if (r.error) return { error: r.error }; out.warrantyExpiresAt = r.value!; }
  if (has('expectedLifetimeYears')) { const r = optNumber(body.expectedLifetimeYears, 'expected lifetime', 0, 200);    if (r.error) return { error: r.error }; out.expectedLifetimeYears = r.value!; }
  if (has('purchaseCost'))      { const r = optNumber(body.purchaseCost, 'purchase cost', 0, 100_000_000);     if (r.error) return { error: r.error }; out.purchaseCost = r.value!; }
  if (has('replacementCost'))   { const r = optNumber(body.replacementCost, 'replacement cost', 0, 100_000_000); if (r.error) return { error: r.error }; out.replacementCost = r.value!; }
  if (has('pmIntervalDays'))    { const r = optIntField(body.pmIntervalDays, 'PM interval (days)', 0, 100_000);   if (r.error) return { error: r.error }; out.pmIntervalDays = r.value!; }

  return { value: out };
}
