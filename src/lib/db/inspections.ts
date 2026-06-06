// ═══════════════════════════════════════════════════════════════════════════
// Inspections — db helpers for the housekeeping inspections workflow.
//
// All callers are server-side API routes (under /api/housekeeping/inspections)
// using the supabaseAdmin client. The data is service-role only per RLS
// (matches pms_* and cleaning_tasks).
//
// Mapper functions convert between snake_case DB rows and the camelCase
// TS types in src/types/inspections.ts.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import type {
  Inspection,
  InspectionChecklist,
  InspectionChecklistItem,
  InspectionFailedItem,
  InspectionHistoryEntry,
  InspectionItemCategory,
  InspectionItemSeverity,
  InspectionResult,
} from '@/types/inspections';

// ─── Mappers ──────────────────────────────────────────────────────────────

interface InspectionRow {
  id: string;
  property_id: string;
  room_number: string;
  room_id: string | null;
  cleaning_task_id: string | null;
  checklist_id: string | null;
  inspector_staff_id: string | null;
  housekeeper_staff_id: string | null;
  started_at: string;
  completed_at: string | null;
  result: InspectionResult;
  failed_items: InspectionFailedItem[] | null;
  passed_items: string[] | null;
  correction_notice_sent_at: string | null;
  recheck_inspection_id: string | null;
  parent_inspection_id: string | null;
  notes: string | null;
  escalated: boolean;
  escalation_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ChecklistItemRow {
  id: string;
  checklist_id: string;
  category: InspectionItemCategory;
  label: string;
  label_es: string | null;
  severity_default: InspectionItemSeverity;
  requires_photo_on_fail: boolean;
  order_index: number;
}

interface ChecklistRow {
  id: string;
  property_id: string | null;
  name: string;
  applies_to_cleaning_types: string[] | null;
  applies_to_room_types: string[] | null;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export function fromInspectionRow(row: InspectionRow): Inspection {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomNumber: row.room_number,
    roomId: row.room_id,
    cleaningTaskId: row.cleaning_task_id,
    checklistId: row.checklist_id,
    inspectorStaffId: row.inspector_staff_id,
    housekeeperStaffId: row.housekeeper_staff_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    result: row.result,
    failedItems: Array.isArray(row.failed_items) ? row.failed_items : [],
    passedItems: Array.isArray(row.passed_items) ? row.passed_items : [],
    correctionNoticeSentAt: row.correction_notice_sent_at,
    recheckInspectionId: row.recheck_inspection_id,
    parentInspectionId: row.parent_inspection_id,
    notes: row.notes,
    escalated: row.escalated,
    escalationReason: row.escalation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromChecklistItemRow(row: ChecklistItemRow): InspectionChecklistItem {
  return {
    id: row.id,
    checklistId: row.checklist_id,
    category: row.category,
    label: row.label,
    labelEs: row.label_es,
    severityDefault: row.severity_default,
    requiresPhotoOnFail: row.requires_photo_on_fail,
    orderIndex: row.order_index,
  };
}

function fromChecklistRow(row: ChecklistRow, items: InspectionChecklistItem[]): InspectionChecklist {
  return {
    id: row.id,
    propertyId: row.property_id,
    name: row.name,
    appliesToCleaningTypes: row.applies_to_cleaning_types ?? [],
    appliesToRoomTypes: row.applies_to_room_types ?? [],
    isActive: row.is_active,
    version: row.version,
    items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Checklists ───────────────────────────────────────────────────────────

/**
 * Returns every active checklist visible to the property — both the
 * global defaults (property_id is null) and any property-specific
 * checklists. Items are loaded and attached to each checklist.
 */
export async function getActiveChecklists(propertyId: string): Promise<InspectionChecklist[]> {
  const { data: lists, error: listErr } = await supabaseAdmin
    .from('inspection_checklists')
    .select('id, property_id, name, applies_to_cleaning_types, applies_to_room_types, is_active, version, created_at, updated_at')
    .or(`property_id.is.null,property_id.eq.${propertyId}`)
    .eq('is_active', true)
    .order('property_id', { ascending: false, nullsFirst: false })
    .order('name', { ascending: true });

  if (listErr) throw listErr;
  const rows = (lists ?? []) as ChecklistRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: items, error: itemErr } = await supabaseAdmin
    .from('inspection_checklist_items')
    .select('id, checklist_id, category, label, label_es, severity_default, requires_photo_on_fail, order_index')
    .in('checklist_id', ids)
    .order('order_index', { ascending: true });

  if (itemErr) throw itemErr;
  const itemRows = (items ?? []) as ChecklistItemRow[];

  const byList = new Map<string, InspectionChecklistItem[]>();
  for (const item of itemRows) {
    const arr = byList.get(item.checklist_id) ?? [];
    arr.push(fromChecklistItemRow(item));
    byList.set(item.checklist_id, arr);
  }

  return rows.map((row) => fromChecklistRow(row, byList.get(row.id) ?? []));
}

export async function getChecklistById(id: string): Promise<InspectionChecklist | null> {
  const { data: list, error: listErr } = await supabaseAdmin
    .from('inspection_checklists')
    .select('id, property_id, name, applies_to_cleaning_types, applies_to_room_types, is_active, version, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (listErr) throw listErr;
  if (!list) return null;

  const { data: items, error: itemErr } = await supabaseAdmin
    .from('inspection_checklist_items')
    .select('id, checklist_id, category, label, label_es, severity_default, requires_photo_on_fail, order_index')
    .eq('checklist_id', id)
    .order('order_index', { ascending: true });

  if (itemErr) throw itemErr;
  const itemRows = (items ?? []) as ChecklistItemRow[];

  return fromChecklistRow(list as ChecklistRow, itemRows.map(fromChecklistItemRow));
}

export interface CreateChecklistArgs {
  propertyId: string | null;
  name: string;
  appliesToCleaningTypes: string[];
  appliesToRoomTypes: string[];
  items: Array<{
    category: InspectionItemCategory;
    label: string;
    labelEs?: string | null;
    severityDefault?: InspectionItemSeverity;
    requiresPhotoOnFail?: boolean;
    orderIndex?: number;
  }>;
}

export async function createChecklist(args: CreateChecklistArgs): Promise<InspectionChecklist> {
  const { data: row, error: insErr } = await supabaseAdmin
    .from('inspection_checklists')
    .insert({
      property_id: args.propertyId,
      name: args.name,
      applies_to_cleaning_types: args.appliesToCleaningTypes,
      applies_to_room_types: args.appliesToRoomTypes,
      is_active: true,
      version: 1,
    })
    .select('id, property_id, name, applies_to_cleaning_types, applies_to_room_types, is_active, version, created_at, updated_at')
    .single();

  if (insErr || !row) throw insErr ?? new Error('inspection_checklists insert returned no row');
  const list = row as ChecklistRow;

  if (args.items.length > 0) {
    const itemRows = args.items.map((it, i) => ({
      checklist_id: list.id,
      category: it.category,
      label: it.label,
      label_es: it.labelEs ?? null,
      severity_default: it.severityDefault ?? 'minor',
      requires_photo_on_fail: it.requiresPhotoOnFail ?? false,
      order_index: it.orderIndex ?? (i + 1) * 10,
    }));
    const { error: itemErr } = await supabaseAdmin
      .from('inspection_checklist_items')
      .insert(itemRows);
    if (itemErr) throw itemErr;
  }

  const built = await getChecklistById(list.id);
  if (!built) throw new Error('createChecklist could not read back the inserted row');
  return built;
}

// ─── Inspections ──────────────────────────────────────────────────────────

export async function getInspectionById(id: string): Promise<Inspection | null> {
  const { data, error } = await supabaseAdmin
    .from('inspections')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return fromInspectionRow(data as InspectionRow);
}

export interface CreateInspectionArgs {
  propertyId: string;
  roomNumber: string;
  roomId: string | null;
  cleaningTaskId: string | null;
  checklistId: string | null;
  inspectorStaffId: string | null;
  housekeeperStaffId: string | null;
  parentInspectionId: string | null;
}

export async function createInspection(args: CreateInspectionArgs): Promise<Inspection> {
  const { data, error } = await supabaseAdmin
    .from('inspections')
    .insert({
      property_id: args.propertyId,
      room_number: args.roomNumber,
      room_id: args.roomId,
      cleaning_task_id: args.cleaningTaskId,
      checklist_id: args.checklistId,
      inspector_staff_id: args.inspectorStaffId,
      housekeeper_staff_id: args.housekeeperStaffId,
      parent_inspection_id: args.parentInspectionId,
      result: 'in_progress',
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('inspections insert returned no row');
  return fromInspectionRow(data as InspectionRow);
}

export interface CompleteInspectionArgs {
  id: string;
  result: 'pass' | 'fail';
  failedItems: InspectionFailedItem[];
  passedItems: string[];
  notes: string | null;
  escalated: boolean;
  escalationReason: string | null;
  correctionNoticeSentAt: string | null;
}

export async function completeInspection(args: CompleteInspectionArgs): Promise<Inspection> {
  const { data, error } = await supabaseAdmin
    .from('inspections')
    .update({
      result: args.result,
      failed_items: args.failedItems,
      passed_items: args.passedItems,
      notes: args.notes,
      escalated: args.escalated,
      escalation_reason: args.escalationReason,
      correction_notice_sent_at: args.correctionNoticeSentAt,
      completed_at: new Date().toISOString(),
    })
    .eq('id', args.id)
    .eq('result', 'in_progress')  // guard: don't double-complete
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('inspections complete returned no row');
  return fromInspectionRow(data as InspectionRow);
}

export async function cancelInspection(id: string): Promise<Inspection> {
  const { data, error } = await supabaseAdmin
    .from('inspections')
    .update({
      result: 'cancelled',
      completed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('result', 'in_progress')
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('inspections cancel returned no row');
  return fromInspectionRow(data as InspectionRow);
}

export async function linkRecheck(parentId: string, recheckId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('inspections')
    .update({ recheck_inspection_id: recheckId })
    .eq('id', parentId);
  if (error) throw error;
}

/**
 * Walk the parent chain backwards, counting consecutive fails on the
 * same property + room. Used to decide whether the current inspection
 * escalates.
 *
 * Hardening (Codex M7 sweep + post-sweep tightening):
 *   - The caller MUST pass the expected propertyId and roomNumber.
 *     Every step is rejected if the parent's pair doesn't match.
 *   - The string-or-options overload that briefly existed for back-
 *     compat was removed (Codex follow-up) — that overload allowed
 *     callers to silently revert to no-scope walking.
 *   - Result must be `fail`; cancelled and pass rows interrupt the
 *     chain regardless of parent_inspection_id.
 *
 * Stops counting at the first non-matching row. 20-level guardrail.
 */
export interface CountConsecutiveFailsOpts {
  parentId: string | null;
  /** The property the calling inspection belongs to. Required. */
  propertyId: string;
  /** The room number the calling inspection is for. Required. */
  roomNumber: string;
}

export async function countConsecutiveFails(
  opts: CountConsecutiveFailsOpts,
): Promise<number> {
  // Runtime defense — types should prevent this, but if a JS caller or
  // a sloppy cast slips through, refuse to walk the chain rather than
  // silently dropping the cross-property guard.
  if (
    !opts ||
    typeof opts !== 'object' ||
    typeof opts.propertyId !== 'string' ||
    opts.propertyId.length === 0 ||
    typeof opts.roomNumber !== 'string' ||
    opts.roomNumber.length === 0
  ) {
    throw new Error(
      'countConsecutiveFails requires { parentId, propertyId, roomNumber } — refusing to walk without scope',
    );
  }

  let count = 0;
  let cursor: string | null = opts.parentId;
  for (let i = 0; i < 20 && cursor; i++) {
    const { data, error } = await supabaseAdmin
      .from('inspections')
      .select('result, parent_inspection_id, property_id, room_number')
      .eq('id', cursor)
      .maybeSingle();
    if (error || !data) break;
    const row = data as {
      result: string;
      parent_inspection_id: string | null;
      property_id: string;
      room_number: string;
    };
    if (row.result !== 'fail') break;
    if (row.property_id !== opts.propertyId) break;
    if (row.room_number !== opts.roomNumber) break;
    count += 1;
    cursor = row.parent_inspection_id;
  }
  return count;
}

export interface InspectionHistoryOpts {
  propertyId: string;
  /** ISO date floor, inclusive. */
  sinceIso?: string | null;
  /** Filter by inspector staff id. */
  inspectorStaffId?: string | null;
  /** Filter by room number (exact). */
  roomNumber?: string | null;
  /** 1..200 */
  limit?: number;
}

export async function getInspectionHistory(opts: InspectionHistoryOpts): Promise<InspectionHistoryEntry[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  let q = supabaseAdmin
    .from('inspections')
    .select('id, room_number, result, inspector_staff_id, housekeeper_staff_id, failed_items, started_at, completed_at, escalated')
    .eq('property_id', opts.propertyId)
    // Only real outcomes belong in "recent inspections" — exclude both
    // in-progress AND cancelled (an inspector opened the checklist then
    // backed out). Without excluding 'cancelled', the UI rendered it as a
    // "Fail", inflating the apparent fail count.
    .in('result', ['pass', 'fail'])
    .order('started_at', { ascending: false })
    .limit(limit);

  if (opts.sinceIso) q = q.gte('started_at', opts.sinceIso);
  if (opts.inspectorStaffId) q = q.eq('inspector_staff_id', opts.inspectorStaffId);
  if (opts.roomNumber) q = q.eq('room_number', opts.roomNumber);

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    id: string;
    room_number: string;
    result: InspectionResult;
    inspector_staff_id: string | null;
    housekeeper_staff_id: string | null;
    failed_items: InspectionFailedItem[] | null;
    started_at: string;
    completed_at: string | null;
    escalated: boolean;
  }>;

  const staffIds = new Set<string>();
  for (const r of rows) {
    if (r.inspector_staff_id) staffIds.add(r.inspector_staff_id);
    if (r.housekeeper_staff_id) staffIds.add(r.housekeeper_staff_id);
  }
  const staffNames = await lookupStaffNames(Array.from(staffIds));

  return rows.map((r) => ({
    id: r.id,
    roomNumber: r.room_number,
    result: r.result,
    inspectorName: r.inspector_staff_id ? staffNames.get(r.inspector_staff_id) ?? null : null,
    housekeeperName: r.housekeeper_staff_id ? staffNames.get(r.housekeeper_staff_id) ?? null : null,
    failedItemCount: Array.isArray(r.failed_items) ? r.failed_items.length : 0,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    escalated: r.escalated,
  }));
}

export async function lookupStaffNames(staffIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (staffIds.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .in('id', staffIds);
  if (error) return out;
  for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
    out.set(row.id, row.name);
  }
  return out;
}

/**
 * Returns true if the staff row has can_inspect=true. Used by the
 * /api/housekeeping/inspections/me route that the InspectorView calls
 * on mount to decide whether to render.
 */
export async function staffCanInspect(propertyId: string, staffId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, can_inspect')
    .eq('id', staffId)
    .eq('property_id', propertyId)
    .maybeSingle();
  if (error || !data) return false;
  return Boolean((data as { can_inspect: boolean }).can_inspect);
}

/**
 * Convenience for the manager-facing tab: list every staff member with
 * can_inspect=true for the property.
 */
export async function getInspectorStaff(propertyId: string): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('property_id', propertyId)
    .eq('can_inspect', true)
    .order('name', { ascending: true });
  if (error) return [];
  return ((data ?? []) as Array<{ id: string; name: string }>);
}
