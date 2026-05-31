// Server-side data access for the Equipment (asset) registry — 0249.
//
// SERVICE-ROLE ONLY. Imported exclusively by /api/maintenance/equipment/*
// routes (supabaseAdmin bypasses RLS; the equipment table is deny-all for
// anon + authenticated). Every function is property-scoped — callers pass the
// `pid` the route already authorized via requireSession + userHasPropertyAccess.
// Mirrors src/lib/compliance/store.ts.

import { supabaseAdmin } from '@/lib/supabase-admin';
import type {
  Equipment,
  EquipmentInput,
  EquipmentDetail,
  EquipmentHistoryItem,
} from './types';

const EQUIPMENT_COLUMNS =
  'id, property_id, name, category, location, manufacturer, model_number, serial_number, ' +
  'status, install_date, expected_lifetime_years, purchase_cost, replacement_cost, ' +
  'pm_interval_days, last_pm_at, warranty_provider, warranty_expires_at, notes, ' +
  'created_at, updated_at';

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function mapRow(r: Record<string, unknown>): Equipment {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    name: String(r.name ?? ''),
    category: (r.category as Equipment['category']) ?? 'other',
    location: str(r.location),
    manufacturer: str(r.manufacturer),
    modelNumber: str(r.model_number),
    serialNumber: str(r.serial_number),
    status: (r.status as Equipment['status']) ?? 'operational',
    installDate: str(r.install_date),
    expectedLifetimeYears: num(r.expected_lifetime_years),
    purchaseCost: num(r.purchase_cost),
    replacementCost: num(r.replacement_cost),
    pmIntervalDays: num(r.pm_interval_days),
    lastPmAt: str(r.last_pm_at),
    warrantyProvider: str(r.warranty_provider),
    warrantyExpiresAt: str(r.warranty_expires_at),
    notes: str(r.notes),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

// Map a (partial) camelCase input to a snake_case row. Only keys present on
// `input` are emitted, so the same helper serves create (full) + patch (subset).
function inputToRow(input: Partial<EquipmentInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.category !== undefined) row.category = input.category;
  if (input.location !== undefined) row.location = input.location;
  if (input.manufacturer !== undefined) row.manufacturer = input.manufacturer;
  if (input.modelNumber !== undefined) row.model_number = input.modelNumber;
  if (input.serialNumber !== undefined) row.serial_number = input.serialNumber;
  if (input.status !== undefined) row.status = input.status;
  if (input.installDate !== undefined) row.install_date = input.installDate;
  if (input.expectedLifetimeYears !== undefined) row.expected_lifetime_years = input.expectedLifetimeYears;
  if (input.purchaseCost !== undefined) row.purchase_cost = input.purchaseCost;
  if (input.replacementCost !== undefined) row.replacement_cost = input.replacementCost;
  if (input.pmIntervalDays !== undefined) row.pm_interval_days = input.pmIntervalDays;
  if (input.warrantyProvider !== undefined) row.warranty_provider = input.warrantyProvider;
  if (input.warrantyExpiresAt !== undefined) row.warranty_expires_at = input.warrantyExpiresAt;
  if (input.notes !== undefined) row.notes = input.notes;
  return row;
}

/** All assets for a property, newest first. */
export async function listEquipment(pid: string): Promise<Equipment[]> {
  const { data, error } = await supabaseAdmin
    .from('equipment')
    .select(EQUIPMENT_COLUMNS)
    .eq('property_id', pid)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => mapRow(r as unknown as Record<string, unknown>));
}

/** One asset + its derived repair/PM history. Null if not found on this property. */
export async function getEquipmentDetail(pid: string, id: string): Promise<EquipmentDetail | null> {
  const { data: row, error } = await supabaseAdmin
    .from('equipment')
    .select(EQUIPMENT_COLUMNS)
    .eq('property_id', pid)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const equipment = mapRow(row as unknown as Record<string, unknown>);

  // Linked work orders + preventive tasks. BOTH scoped by property_id AND
  // equipment_id so a stray cross-property link can never surface here.
  const [woRes, pmRes] = await Promise.all([
    supabaseAdmin
      .from('work_orders')
      .select('id, room_number, description, status, repair_cost, resolved_at, created_at')
      .eq('property_id', pid)
      .eq('equipment_id', id),
    supabaseAdmin
      .from('preventive_tasks')
      .select('id, name, area, last_completed_at, created_at')
      .eq('property_id', pid)
      .eq('equipment_id', id),
  ]);
  if (woRes.error) throw woRes.error;
  if (pmRes.error) throw pmRes.error;

  const workOrders = (woRes.data ?? []) as Record<string, unknown>[];
  const preventive = (pmRes.data ?? []) as Record<string, unknown>[];

  const history: EquipmentHistoryItem[] = [
    ...workOrders.map((w): EquipmentHistoryItem => ({
      kind: 'work_order',
      id: String(w.id),
      date: str(w.resolved_at) ?? str(w.created_at),
      title: String(w.description ?? ''),
      detail: str(w.room_number),
      cost: num(w.repair_cost),
      status: w.status === 'resolved' ? 'done' : 'open',
      priority: null,
    })),
    ...preventive.map((p): EquipmentHistoryItem => ({
      kind: 'preventive',
      id: String(p.id),
      date: str(p.last_completed_at) ?? str(p.created_at),
      title: String(p.name ?? ''),
      detail: str(p.area),
      cost: null,
      status: null,
      priority: null,
    })),
  ].sort((a, b) => {
    // Newest first; undated rows sink to the bottom.
    const ta = a.date ? Date.parse(a.date) : -Infinity;
    const tb = b.date ? Date.parse(b.date) : -Infinity;
    return tb - ta;
  });

  const totalRepairSpend = workOrders.reduce((sum, w) => sum + (num(w.repair_cost) ?? 0), 0);

  return {
    equipment,
    history,
    totalRepairSpend,
    failureCount: workOrders.length,
    workOrderCount: workOrders.length,
    preventiveCount: preventive.length,
  };
}

/** Create an asset. Returns the new id. */
export async function createEquipment(pid: string, input: EquipmentInput): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('equipment')
    .insert({ ...inputToRow(input), property_id: pid })
    .select('id')
    .single();
  if (error) throw error;
  return { id: String(data.id) };
}

/** Patch an asset. Returns false when no row on this property matched (→ 404). */
export async function updateEquipment(
  pid: string, id: string, patch: Partial<EquipmentInput>,
): Promise<boolean> {
  const row = inputToRow(patch);
  if (Object.keys(row).length === 0) return true;  // nothing to change
  const { data, error } = await supabaseAdmin
    .from('equipment')
    .update(row)
    .eq('property_id', pid)
    .eq('id', id)
    .select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Delete an asset (linked work orders / PM tasks are unlinked, not deleted —
 *  the FK is ON DELETE SET NULL). Returns false when nothing matched (→ 404). */
export async function deleteEquipment(pid: string, id: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('equipment')
    .delete()
    .eq('property_id', pid)
    .eq('id', id)
    .select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
