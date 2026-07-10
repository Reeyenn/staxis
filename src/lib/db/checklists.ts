// ═══════════════════════════════════════════════════════════════════════════
// Checklist editor — db helpers for the manager-facing checklist editor.
//
// Two checklist systems live behind this module, both edited additively on
// top of the EXISTING tables (migrations 0212 + 0222). Nothing here merges or
// rebuilds them.
//
//   CLEANING  (0222) — cleaning_checklist_templates + cleaning_checklist_items.
//     One GLOBAL default per cleaning_type (property_id IS NULL, is_default).
//     One PER-PROPERTY override per cleaning_type (property_id = pid). The
//     editor edits the per-property override; the global default rows are
//     NEVER touched. First edit clones the default into a fresh override.
//
//   INSPECTION (0212) — inspection_checklists + inspection_checklist_items.
//     Free-form: globals (property_id NULL) + any number of per-property
//     checklists, resolved at inspection-start by lib/inspections/selectChecklist.
//     The editor edits a per-property checklist (identity = property_id+name);
//     the global default is never mutated. First edit clones the resolved
//     checklist into a per-property copy.
//
// All callers are server-side API routes under /api/settings/checklists/* using
// the supabaseAdmin (service-role) client — the tables are service-role-only
// per RLS (deny-all to anon/authenticated). Browser code never touches them.
//
// Re-exported through src/lib/db.ts so callers `import { ... } from '@/lib/db'`.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

// ─── Allowed enum values (mirror the CHECK constraints in 0212 / 0222) ──────

export const CLEANING_TYPES = ['departure', 'stayover', 'deep', 'refresh', 'inspection'] as const;
export type CleaningType = (typeof CLEANING_TYPES)[number];

export const CLEANING_AREAS = ['bathroom', 'bedroom', 'living', 'kitchen', 'entry', 'amenities', 'final'] as const;
export type CleaningArea = (typeof CLEANING_AREAS)[number];

export const INSPECTION_CATEGORIES = ['bathroom', 'bedroom', 'living', 'kitchen', 'welcome', 'other'] as const;
export type InspectionCategory = (typeof INSPECTION_CATEGORIES)[number];

export const INSPECTION_SEVERITIES = ['minor', 'major', 'critical'] as const;
export type InspectionSeverity = (typeof INSPECTION_SEVERITIES)[number];

// Cleaning types an inspection checklist may scope to. Mirrors the cleaning
// types plus the `departure_deep` value the seeded global default uses.
export const INSPECTION_APPLIES_CLEANING_TYPES = [
  'departure', 'departure_deep', 'stayover', 'deep', 'refresh',
] as const;

// Hard caps so a malformed save can't insert thousands of rows.
export const MAX_ITEMS_PER_CHECKLIST = 100;
export const MAX_NAME_LEN = 120;
export const MAX_ITEM_TEXT_LEN = 200;

// ─── Cleaning: types ────────────────────────────────────────────────────────

export interface CleaningItemInput {
  area: CleaningArea;
  itemEn: string;
  itemEs: string;
  isCritical: boolean;
}

export interface CleaningItemDTO extends CleaningItemInput {
  id: string;
  sortOrder: number;
}

export interface EffectiveCleaningChecklist {
  cleaningType: CleaningType;
  nameEn: string;
  nameEs: string;
  /** True when a per-property override exists (the manager has customized it). */
  isOverride: boolean;
  /** Retained for API compatibility. Always false as of 0305: global Staxis
   *  defaults are no longer a fallback — a hotel with no override is empty. */
  hasDefault: boolean;
  items: CleaningItemDTO[];
}

interface CleaningTemplateRow {
  id: string;
  property_id: string | null;
  cleaning_type: string;
  name_en: string;
  name_es: string;
  is_default: boolean;
  is_active: boolean;
}

interface CleaningItemRow {
  id: string;
  area: string;
  item_en: string;
  item_es: string;
  sort_order: number;
  is_critical: boolean;
}

function toCleaningItemDTO(r: CleaningItemRow): CleaningItemDTO {
  return {
    id: r.id,
    area: r.area as CleaningArea,
    itemEn: r.item_en,
    itemEs: r.item_es,
    sortOrder: r.sort_order,
    isCritical: r.is_critical,
  };
}

/**
 * Load the per-property override row for a (property, cleaning_type),
 * active-only. Global Staxis defaults (property_id IS NULL) are deliberately
 * NOT loaded: as of migration 0305 they are inert and a property with no
 * per-property template has an EMPTY effective checklist, never the default.
 * The (property_id, cleaning_type) unique index guarantees at most one row.
 */
async function loadCleaningOverrideTemplate(
  propertyId: string,
  cleaningType: CleaningType,
): Promise<CleaningTemplateRow | null> {
  const { data, error } = await supabaseAdmin
    .from('cleaning_checklist_templates')
    .select('id, property_id, cleaning_type, name_en, name_es, is_default, is_active')
    .eq('property_id', propertyId)
    .eq('cleaning_type', cleaningType)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return (data as CleaningTemplateRow | null) ?? null;
}

async function loadCleaningItems(templateId: string): Promise<CleaningItemDTO[]> {
  const { data, error } = await supabaseAdmin
    .from('cleaning_checklist_items')
    .select('id, area, item_en, item_es, sort_order, is_critical')
    .eq('template_id', templateId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as CleaningItemRow[]).map(toCleaningItemDTO);
}

/**
 * The effective cleaning checklist a property's housekeepers would see for a
 * cleaning type: the per-property override if one exists, otherwise EMPTY.
 * The global Staxis default is no longer a fallback (0305) — a hotel with no
 * per-property checklist starts from scratch and a manager builds their own.
 */
export async function getEffectiveCleaningChecklist(
  propertyId: string,
  cleaningType: CleaningType,
): Promise<EffectiveCleaningChecklist> {
  const override = await loadCleaningOverrideTemplate(propertyId, cleaningType);
  if (!override) {
    return {
      cleaningType,
      nameEn: '',
      nameEs: '',
      isOverride: false,
      hasDefault: false,
      items: [],
    };
  }
  const items = await loadCleaningItems(override.id);
  return {
    cleaningType,
    nameEn: override.name_en,
    nameEs: override.name_es,
    isOverride: true,
    hasDefault: false,
    items,
  };
}

/** Replace a cleaning template's items wholesale. Delete-then-insert so the
 *  (template_id, sort_order) unique index can never collide on a reorder.
 *
 *  Not wrapped in a DB transaction (supabase-js has no multi-statement tx): an
 *  INSERT failing after the DELETE would leave the template empty. Accepted
 *  because (a) this is an admin-only, low-concurrency save, (b) all inputs are
 *  validated + length-capped + enum-checked upstream so a non-outage INSERT
 *  failure is effectively impossible, and (c) the editor keeps the full item
 *  list in client state, so the manager simply re-saves on any error. */
async function replaceCleaningItems(templateId: string, items: CleaningItemInput[]): Promise<void> {
  const { error: delErr } = await supabaseAdmin
    .from('cleaning_checklist_items')
    .delete()
    .eq('template_id', templateId);
  if (delErr) throw delErr;

  if (items.length === 0) return;
  const rows = items.map((it, i) => ({
    template_id: templateId,
    area: it.area,
    item_en: it.itemEn,
    item_es: it.itemEs,
    sort_order: (i + 1) * 10,
    is_critical: it.isCritical,
  }));
  const { error: insErr } = await supabaseAdmin
    .from('cleaning_checklist_items')
    .insert(rows);
  if (insErr) throw insErr;
}

/** Load the per-property override row WITHOUT an is_active filter. The
 *  (property_id, cleaning_type) unique index covers active + inactive rows, so
 *  a save must find any existing override to update it rather than insert a
 *  colliding row. At most one row exists (enforced by the index). */
async function loadCleaningOverrideRow(
  propertyId: string,
  cleaningType: CleaningType,
): Promise<{ id: string; name_en: string; name_es: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('cleaning_checklist_templates')
    .select('id, name_en, name_es')
    .eq('property_id', propertyId)
    .eq('cleaning_type', cleaningType)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string; name_en: string; name_es: string } | null) ?? null;
}

/** Load the global default row for name-fallback when creating an override. */
async function loadCleaningDefaultRow(
  cleaningType: CleaningType,
): Promise<{ name_en: string; name_es: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('cleaning_checklist_templates')
    .select('name_en, name_es')
    .is('property_id', null)
    .eq('cleaning_type', cleaningType)
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw error;
  return (data as { name_en: string; name_es: string } | null) ?? null;
}

export interface SaveCleaningArgs {
  nameEn?: string | null;
  nameEs?: string | null;
  items: CleaningItemInput[];
}

/**
 * Create or update the PER-PROPERTY override for a (property, cleaning_type)
 * and replace its item list. On first edit (no override yet) a fresh override
 * row is created, cloning the default's name unless a name is supplied. The
 * global default (property_id IS NULL) is never read-for-write or mutated.
 */
export async function saveCleaningOverride(
  propertyId: string,
  cleaningType: CleaningType,
  args: SaveCleaningArgs,
): Promise<EffectiveCleaningChecklist> {
  const overrideRow = await loadCleaningOverrideRow(propertyId, cleaningType);
  const defRow = overrideRow ? null : await loadCleaningDefaultRow(cleaningType);

  const nameEn = (args.nameEn ?? '').trim() || overrideRow?.name_en || defRow?.name_en || cleaningType;
  const nameEs = (args.nameEs ?? '').trim() || overrideRow?.name_es || defRow?.name_es || cleaningType;

  let templateId: string;
  if (overrideRow) {
    templateId = overrideRow.id;
    const { error } = await supabaseAdmin
      .from('cleaning_checklist_templates')
      .update({ name_en: nameEn, name_es: nameEs, is_active: true, updated_at: new Date().toISOString() })
      .eq('id', templateId)
      .eq('property_id', propertyId); // guard: never the global default
    if (error) throw error;
  } else {
    const { data, error } = await supabaseAdmin
      .from('cleaning_checklist_templates')
      .insert({
        property_id: propertyId,
        cleaning_type: cleaningType,
        name_en: nameEn,
        name_es: nameEs,
        is_default: false,
        is_active: true,
      })
      .select('id')
      .single();
    if (error || !data) throw error ?? new Error('cleaning override insert returned no row');
    templateId = (data as { id: string }).id;
  }

  await replaceCleaningItems(templateId, args.items);
  return getEffectiveCleaningChecklist(propertyId, cleaningType);
}

/**
 * Reset a property to the Staxis default for a cleaning type by deleting its
 * per-property override (items cascade). Refuses to touch the global default.
 * Returns true if an override was deleted.
 */
export async function deleteCleaningOverride(
  propertyId: string,
  cleaningType: CleaningType,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('cleaning_checklist_templates')
    .delete()
    .eq('property_id', propertyId) // guard: property_id IS NULL (global) can never match
    .eq('cleaning_type', cleaningType)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

// ─── Inspection: types ──────────────────────────────────────────────────────

export interface InspectionItemInput {
  category: InspectionCategory;
  label: string;
  labelEs: string;
  severityDefault: InspectionSeverity;
  requiresPhotoOnFail: boolean;
}

export interface InspectionItemDTO extends InspectionItemInput {
  id: string;
  orderIndex: number;
}

export interface EffectiveInspectionChecklist {
  /** The id of the resolved checklist. Null only when nothing exists at all. */
  checklistId: string | null;
  name: string;
  appliesToCleaningTypes: string[];
  appliesToRoomTypes: string[];
  /** True when the resolved checklist is a per-property one (manager-owned). */
  isOverride: boolean;
  /** Retained for API compatibility. Always false as of 0305: global Staxis
   *  defaults are no longer a fallback — a hotel with no checklist is empty. */
  hasDefault: boolean;
  /** Count of ADDITIONAL active per-property checklists this property has beyond
   *  the one shown. The editor manages the most-recent; >0 means others exist
   *  (the selector may still pick them at inspection time) — surfaced as a notice. */
  otherCount: number;
  items: InspectionItemDTO[];
}

interface InspectionChecklistRow {
  id: string;
  property_id: string | null;
  name: string;
  applies_to_cleaning_types: string[] | null;
  applies_to_room_types: string[] | null;
  is_active: boolean;
  version: number;
  updated_at: string;
}

interface InspectionItemRow {
  id: string;
  category: string;
  label: string;
  label_es: string | null;
  severity_default: string;
  requires_photo_on_fail: boolean;
  order_index: number;
}

function toInspectionItemDTO(r: InspectionItemRow): InspectionItemDTO {
  return {
    id: r.id,
    category: r.category as InspectionCategory,
    label: r.label,
    labelEs: r.label_es ?? '',
    severityDefault: r.severity_default as InspectionSeverity,
    requiresPhotoOnFail: r.requires_photo_on_fail,
    orderIndex: r.order_index,
  };
}

async function loadInspectionItems(checklistId: string): Promise<InspectionItemDTO[]> {
  const { data, error } = await supabaseAdmin
    .from('inspection_checklist_items')
    .select('id, category, label, label_es, severity_default, requires_photo_on_fail, order_index')
    .eq('checklist_id', checklistId)
    .order('order_index', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as InspectionItemRow[]).map(toInspectionItemDTO);
}

/** All active per-property inspection checklists for a property, newest first.
 *  The editor manages the most-recent (index 0); any others are surfaced via
 *  otherCount so the manager knows more exist and which the selector may pick. */
async function loadPropertyInspectionChecklists(propertyId: string): Promise<InspectionChecklistRow[]> {
  const { data, error } = await supabaseAdmin
    .from('inspection_checklists')
    .select('id, property_id, name, applies_to_cleaning_types, applies_to_room_types, is_active, version, updated_at')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as InspectionChecklistRow[];
}

function toEffectiveInspection(
  row: InspectionChecklistRow,
  items: InspectionItemDTO[],
  isOverride: boolean,
  hasDefault: boolean,
  otherCount: number,
): EffectiveInspectionChecklist {
  return {
    checklistId: row.id,
    name: row.name,
    appliesToCleaningTypes: row.applies_to_cleaning_types ?? [],
    appliesToRoomTypes: row.applies_to_room_types ?? [],
    isOverride,
    hasDefault,
    otherCount,
    items,
  };
}

/**
 * The effective inspection checklist for a property: its own per-property
 * checklist if one exists, otherwise EMPTY. The global Staxis default is no
 * longer a fallback (0305) — a hotel with no per-property checklist starts
 * from scratch and a manager builds their own.
 */
export async function getEffectiveInspectionChecklist(
  propertyId: string,
): Promise<EffectiveInspectionChecklist> {
  const propRows = await loadPropertyInspectionChecklists(propertyId);
  const propRow = propRows[0] ?? null;
  if (!propRow) {
    return {
      checklistId: null,
      name: '',
      appliesToCleaningTypes: [],
      appliesToRoomTypes: [],
      isOverride: false,
      hasDefault: false,
      otherCount: 0,
      items: [],
    };
  }
  const items = await loadInspectionItems(propRow.id);
  const otherCount = Math.max(0, propRows.length - 1);
  return toEffectiveInspection(propRow, items, true, false, otherCount);
}

/** Replace an inspection checklist's items wholesale (delete-then-insert). Same
 *  non-transactional trade-off as replaceCleaningItems — admin-only, validated
 *  inputs, client retains state for retry — so the brief failure window is
 *  acceptable. */
async function replaceInspectionItems(checklistId: string, items: InspectionItemInput[]): Promise<void> {
  const { error: delErr } = await supabaseAdmin
    .from('inspection_checklist_items')
    .delete()
    .eq('checklist_id', checklistId);
  if (delErr) throw delErr;

  if (items.length === 0) return;
  const rows = items.map((it, i) => ({
    checklist_id: checklistId,
    category: it.category,
    label: it.label,
    label_es: it.labelEs,
    severity_default: it.severityDefault,
    requires_photo_on_fail: it.requiresPhotoOnFail,
    order_index: (i + 1) * 10,
  }));
  const { error: insErr } = await supabaseAdmin
    .from('inspection_checklist_items')
    .insert(rows);
  if (insErr) throw insErr;
}

/** Find an existing per-property checklist by (property_id, name). Identity for
 *  idempotent saves + copies. Returns the row id or null. */
async function findPropertyInspectionByName(propertyId: string, name: string): Promise<string | null> {
  // order + limit(1) keeps this deterministic and safe even if a pre-0247 DB
  // somehow holds two same-name rows (maybeSingle would otherwise throw).
  const { data, error } = await supabaseAdmin
    .from('inspection_checklists')
    .select('id')
    .eq('property_id', propertyId)
    .eq('name', name)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

export interface SaveInspectionArgs {
  /** The per-property checklist id being edited, if any (from the GET). */
  checklistId?: string | null;
  name: string;
  appliesToCleaningTypes: string[];
  appliesToRoomTypes: string[];
  items: InspectionItemInput[];
}

/**
 * Create or update a PER-PROPERTY inspection checklist and replace its items.
 *
 * Target resolution (never edits a global default):
 *   1. `checklistId` that is a per-property row for THIS property → edit it.
 *   2. else an existing per-property row with the same name → edit it.
 *   3. else create a new per-property checklist (clones the edited content).
 */
export async function saveInspectionChecklist(
  propertyId: string,
  args: SaveInspectionArgs,
): Promise<EffectiveInspectionChecklist> {
  const name = args.name.trim();
  const fields = {
    name,
    applies_to_cleaning_types: dedupeStrings(args.appliesToCleaningTypes),
    applies_to_room_types: dedupeStrings(args.appliesToRoomTypes),
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  // Resolve the target per-property row id (never a global default).
  let targetId: string | null = null;
  if (args.checklistId) {
    const { data, error } = await supabaseAdmin
      .from('inspection_checklists')
      .select('id, property_id')
      .eq('id', args.checklistId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { id: string; property_id: string | null } | null;
    if (row && row.property_id === propertyId) targetId = row.id; // only a property row, never global
  }
  if (!targetId) targetId = await findPropertyInspectionByName(propertyId, name);

  if (targetId) {
    const { error } = await supabaseAdmin
      .from('inspection_checklists')
      .update(fields)
      .eq('id', targetId)
      .eq('property_id', propertyId); // guard: never the global default
    if (error) throw error;
  } else {
    const ins = await supabaseAdmin
      .from('inspection_checklists')
      .insert({ property_id: propertyId, version: 1, ...fields })
      .select('id')
      .single();
    if (ins.error) {
      // The 0247 unique index (property_id, name) can fire if a same-name row
      // was created concurrently. Re-resolve by name and update instead of
      // failing the save — keeps the save idempotent under the index.
      if ((ins.error as { code?: string }).code === '23505') {
        const existing = await findPropertyInspectionByName(propertyId, name);
        if (!existing) throw ins.error;
        targetId = existing;
        const { error: updErr } = await supabaseAdmin
          .from('inspection_checklists')
          .update(fields)
          .eq('id', targetId)
          .eq('property_id', propertyId);
        if (updErr) throw updErr;
      } else {
        throw ins.error;
      }
    } else if (!ins.data) {
      throw new Error('inspection checklist insert returned no row');
    } else {
      targetId = (ins.data as { id: string }).id;
    }
  }

  await replaceInspectionItems(targetId, args.items);
  return getEffectiveInspectionChecklist(propertyId);
}

/**
 * Reset a property's inspection checklist back to the Staxis default by
 * deleting the given per-property checklist (items cascade). Guarded so it can
 * only ever delete a row that belongs to this property. Returns true if a row
 * was deleted.
 */
export async function deleteInspectionOverride(
  propertyId: string,
  checklistId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('inspection_checklists')
    .delete()
    .eq('id', checklistId)
    .eq('property_id', propertyId) // guard: global default (property_id NULL) never matches
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

// ─── Copy to other properties ───────────────────────────────────────────────

export interface CopyOutcome {
  propertyId: string;
  ok: boolean;
  error?: string;
}

/**
 * Copy a property's effective CLEANING checklist for one cleaning type onto
 * each target property, creating/overwriting that target's per-property
 * override. Idempotent. The caller MUST have already verified access to the
 * source and every target property.
 */
export async function copyCleaningToProperties(
  sourcePropertyId: string,
  cleaningType: CleaningType,
  targetPropertyIds: string[],
): Promise<CopyOutcome[]> {
  const source = await getEffectiveCleaningChecklist(sourcePropertyId, cleaningType);
  const items: CleaningItemInput[] = source.items.map((it) => ({
    area: it.area,
    itemEn: it.itemEn,
    itemEs: it.itemEs,
    isCritical: it.isCritical,
  }));

  const outcomes: CopyOutcome[] = [];
  for (const targetId of targetPropertyIds) {
    if (targetId === sourcePropertyId) {
      outcomes.push({ propertyId: targetId, ok: true });
      continue;
    }
    try {
      await saveCleaningOverride(targetId, cleaningType, {
        nameEn: source.nameEn,
        nameEs: source.nameEs,
        items,
      });
      outcomes.push({ propertyId: targetId, ok: true });
    } catch (e) {
      log.error('copyCleaningToProperties: target failed', { targetId, error: e instanceof Error ? e.message : String(e) });
      outcomes.push({ propertyId: targetId, ok: false, error: 'Could not copy to this property.' });
    }
  }
  return outcomes;
}

interface FullInspectionSource {
  name: string;
  appliesToCleaningTypes: string[];
  appliesToRoomTypes: string[];
  items: InspectionItemInput[];
}

/** Load any inspection checklist by id (global default or per-property) plus
 *  its property_id, for the copy source. Returns null if it doesn't exist. */
export async function loadInspectionSource(
  checklistId: string,
): Promise<{ propertyId: string | null; source: FullInspectionSource } | null> {
  const { data, error } = await supabaseAdmin
    .from('inspection_checklists')
    .select('id, property_id, name, applies_to_cleaning_types, applies_to_room_types')
    .eq('id', checklistId)
    .eq('is_active', true) // don't copy a retired/inactive checklist
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    id: string;
    property_id: string | null;
    name: string;
    applies_to_cleaning_types: string[] | null;
    applies_to_room_types: string[] | null;
  };
  const items = await loadInspectionItems(row.id);
  return {
    propertyId: row.property_id,
    source: {
      name: row.name,
      appliesToCleaningTypes: row.applies_to_cleaning_types ?? [],
      appliesToRoomTypes: row.applies_to_room_types ?? [],
      items: items.map((it) => ({
        category: it.category,
        label: it.label,
        labelEs: it.labelEs,
        severityDefault: it.severityDefault,
        requiresPhotoOnFail: it.requiresPhotoOnFail,
      })),
    },
  };
}

/**
 * Copy an inspection checklist (by id — may be a global default or a
 * per-property one) onto each target property, creating/overwriting that
 * target's per-property checklist with the same name. Idempotent. The caller
 * MUST have already verified access to the source and every target property.
 */
export async function copyInspectionToProperties(
  sourceChecklistId: string,
  targetPropertyIds: string[],
): Promise<{ outcomes: CopyOutcome[]; sourcePropertyId: string | null } | null> {
  const loaded = await loadInspectionSource(sourceChecklistId);
  if (!loaded) return null;
  const { source, propertyId: sourcePropertyId } = loaded;

  const outcomes: CopyOutcome[] = [];
  for (const targetId of targetPropertyIds) {
    if (targetId === sourcePropertyId) {
      outcomes.push({ propertyId: targetId, ok: true });
      continue;
    }
    try {
      await saveInspectionChecklist(targetId, {
        name: source.name,
        appliesToCleaningTypes: source.appliesToCleaningTypes,
        appliesToRoomTypes: source.appliesToRoomTypes,
        items: source.items,
      });
      outcomes.push({ propertyId: targetId, ok: true });
    } catch (e) {
      log.error('copyInspectionToProperties: target failed', { targetId, error: e instanceof Error ? e.message : String(e) });
      outcomes.push({ propertyId: targetId, ok: false, error: 'Could not copy to this property.' });
    }
  }
  return { outcomes, sourcePropertyId };
}

function dedupeStrings(arr: string[]): string[] {
  return Array.from(new Set(arr.map((s) => s.trim()).filter((s) => s.length > 0)));
}
