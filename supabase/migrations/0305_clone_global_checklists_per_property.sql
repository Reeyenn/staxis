-- ═══════════════════════════════════════════════════════════════════════════
-- 0305 — Clone the global default checklists into every EXISTING property.
--
-- Product decision (Reeyen, 2026-07-09): NEW hotels start with EMPTY cleaning +
-- inspection checklists — no built-in steps; a manager writes their own.
-- EXISTING hotels must keep EXACTLY what they see today — including the live
-- customer Comfort Suites Beaumont, whose housekeepers may rely on the
-- built-in defaults.
--
-- Until now the effective checklist resolved to the per-property override if
-- one existed, else the GLOBAL default seeded with property_id IS NULL by
-- 0222 (cleaning: departure/stayover/deep/refresh/inspection) and 0212
-- (inspection: 'Standard Departure Clean'). The application layer is changing
-- to DROP that global-default fallback (a hotel with no per-property checklist
-- now sees an empty list). To keep every existing hotel unchanged, this
-- migration MATERIALISES each global default as a real per-property row for
-- every property that doesn't already have its own — exactly the shape the
-- app's "first edit clones the default" code path (saveCleaningOverride /
-- saveInspectionChecklist in src/lib/db/checklists.ts) would produce:
--
--   CLEANING   → cleaning_checklist_templates (property_id, cleaning_type,
--                name_en, name_es, is_default=false, is_active=true) + a copy
--                of every cleaning_checklist_items row.
--   INSPECTION → inspection_checklists (property_id, name,
--                applies_to_cleaning_types, applies_to_room_types,
--                is_active=true, version) + a copy of every
--                inspection_checklist_items row.
--
-- The global (property_id IS NULL) rows are LEFT IN PLACE — they simply become
-- inert once the code stops falling back to them (harmless; a later cleanup
-- could remove them, but nothing reads them after this ships).
--
-- Idempotent + behavior-preserving: the CLEANING clone is guarded per
-- cleaning_type (a property that already has a template for that type is
-- skipped), and the INSPECTION clone is guarded on the property having NO
-- inspection checklist at all (see the inline note — cloning into a property
-- that already has one could change selectChecklist's pick). Pre-existing
-- overrides are never touched, items are only ever inserted into templates THIS
-- block just created, and re-running does nothing.
--
-- Manual prod apply per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

do $$
declare
  v_prop record;
  v_def  record;
  v_new_id uuid;
begin
  for v_prop in select id from public.properties loop

    -- ── Cleaning checklists ────────────────────────────────────────────────
    -- One global default per cleaning_type (property_id IS NULL, is_default).
    for v_def in
      select id, cleaning_type, name_en, name_es
      from public.cleaning_checklist_templates
      where property_id is null and is_default = true and is_active = true
    loop
      -- Skip if this property already has ANY template for this cleaning_type
      -- (an existing override — leave it exactly as the manager has it).
      if exists (
        select 1 from public.cleaning_checklist_templates
        where property_id = v_prop.id and cleaning_type = v_def.cleaning_type
      ) then
        continue;
      end if;

      insert into public.cleaning_checklist_templates
        (property_id, cleaning_type, name_en, name_es, is_default, is_active)
      values
        (v_prop.id, v_def.cleaning_type, v_def.name_en, v_def.name_es, false, true)
      returning id into v_new_id;

      insert into public.cleaning_checklist_items
        (template_id, area, item_en, item_es, sort_order, is_critical)
      select v_new_id, area, item_en, item_es, sort_order, is_critical
      from public.cleaning_checklist_items
      where template_id = v_def.id;
    end loop;

    -- ── Inspection checklists ──────────────────────────────────────────────
    -- Only seed properties that have NO inspection checklist of their own
    -- today (they resolve entirely to the global default). A property that
    -- already built its own inspection checklist is LEFT UNTOUCHED: unlike the
    -- cleaning path (a direct per-type lookup), inspection selection runs
    -- selectChecklist() over a candidate SET where property-scoped rows outrank
    -- globals and ties break on newest updated_at. Cloning the global as a
    -- fresh (newest) property-scoped row would add a competing candidate and
    -- could change which checklist an existing hotel's inspector gets — so we
    -- don't. For a property with zero checklists, its single cloned copy is
    -- selected for every cleaning type exactly as the global was today (by
    -- score for departure, by the property-first last-resort branch otherwise).
    if not exists (
      select 1 from public.inspection_checklists where property_id = v_prop.id
    ) then
      for v_def in
        select id, name, applies_to_cleaning_types, applies_to_room_types, version
        from public.inspection_checklists
        where property_id is null and is_active = true
      loop
        insert into public.inspection_checklists
          (property_id, name, applies_to_cleaning_types, applies_to_room_types, is_active, version)
        values
          (v_prop.id, v_def.name, v_def.applies_to_cleaning_types, v_def.applies_to_room_types, true, v_def.version)
        returning id into v_new_id;

        insert into public.inspection_checklist_items
          (checklist_id, category, label, label_es, severity_default, requires_photo_on_fail, order_index)
        select v_new_id, category, label, label_es, severity_default, requires_photo_on_fail, order_index
        from public.inspection_checklist_items
        where checklist_id = v_def.id;
      end loop;
    end if;

  end loop;
end $$;

INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0305',
  'Clone global default cleaning (0222) + inspection (0212) checklists into a per-property row for every existing property, so they are unchanged after the app drops the global-default fallback (new hotels now start with empty checklists). Idempotent; global NULL-property rows left inert.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
