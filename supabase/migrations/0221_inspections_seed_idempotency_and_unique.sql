-- ═══════════════════════════════════════════════════════════════════════════
-- 0221 — inspections follow-up: idempotent seed + one-in-progress unique
--
-- Renumbered from 0215 → 0221 to clear collisions with mapping-help (0215),
-- phase-b-review (0216), phase-b-hardening (0217), voice-issue (0218),
-- reassign-cleaning-task-rpc (0219), and reports-and-role-management (0220)
-- — all of which landed after this migration was authored.
--
-- Two follow-ups to migration 0212 (post-merge Codex sweep, 2026-05-25):
--
-- 1. Re-seed the Standard Departure Clean checklist if it exists but has
--    zero items. The original 0212 do-block early-exited when the row
--    existed, which left a partially-failed apply (checklist row inserted
--    but items insert crashed) with an empty checklist that the
--    inspector would see as a blank list. (Codex M8)
--
-- 2. Add a partial unique index that allows only one in_progress
--    inspection per (property_id, room_number) at a time. Application
--    code in start routes already does a read-then-insert; this prevents
--    races between two inspectors picking the same room (Codex M1).
--    The constraint is partial — only applies when result='in_progress'
--    — so a room can still have many historical pass/fail rows.
--
-- Manual prod apply per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Backfill checklist items if the standard checklist is empty ─────────
do $$
declare
  v_checklist_id uuid;
  v_count integer;
begin
  select id into v_checklist_id
  from public.inspection_checklists
  where property_id is null
    and name = 'Standard Departure Clean'
  limit 1;

  if v_checklist_id is null then
    -- 0212 didn't run yet (shouldn't happen, but defensive). Skip.
    return;
  end if;

  select count(*) into v_count
  from public.inspection_checklist_items
  where checklist_id = v_checklist_id;

  if v_count > 0 then
    return;  -- already populated, nothing to do
  end if;

  insert into public.inspection_checklist_items
    (checklist_id, category, label, label_es, severity_default, requires_photo_on_fail, order_index)
  values
    (v_checklist_id, 'bedroom', 'Bed made with hospital corners',          'Cama hecha con esquinas hospitalarias',  'major',    false, 10),
    (v_checklist_id, 'bedroom', 'Linens fresh, no hair or stains',         'Sábanas limpias, sin pelo ni manchas',   'critical', true,  20),
    (v_checklist_id, 'bedroom', 'Pillows fluffed and centered',            'Almohadas mullidas y centradas',         'minor',    false, 30),
    (v_checklist_id, 'bedroom', 'Nightstands dusted and clear',            'Mesitas de noche limpias y despejadas',  'minor',    false, 40),
    (v_checklist_id, 'bathroom','Toilet clean inside and out',             'Inodoro limpio por dentro y por fuera',  'critical', true,  50),
    (v_checklist_id, 'bathroom','Shower / tub scrubbed, no soap scum',     'Ducha / tina restregada, sin jabón',     'critical', true,  60),
    (v_checklist_id, 'bathroom','Mirror polished, no streaks',             'Espejo pulido, sin rayas',               'major',    false, 70),
    (v_checklist_id, 'bathroom','Towels folded and stocked',               'Toallas dobladas y abastecidas',         'minor',    false, 80),
    (v_checklist_id, 'bathroom','Amenities stocked (soap, shampoo)',       'Amenidades abastecidas (jabón, champú)', 'major',    false, 90),
    (v_checklist_id, 'living',  'Floor vacuumed, no debris',               'Piso aspirado, sin escombros',           'major',    false, 100),
    (v_checklist_id, 'living',  'All trash removed',                       'Toda la basura retirada',                'critical', true,  110),
    (v_checklist_id, 'living',  'Surfaces dusted (TV, desk, lamps)',       'Superficies limpias (TV, escritorio)',   'minor',    false, 120),
    (v_checklist_id, 'kitchen', 'Coffee station stocked and clean',        'Estación de café abastecida y limpia',   'minor',    false, 130),
    (v_checklist_id, 'welcome', 'HVAC set to standard temp',               'Aire acondicionado a temperatura estándar','minor',  false, 140),
    (v_checklist_id, 'welcome', 'Room smells fresh',                       'La habitación huele a limpio',           'major',    false, 150);
end $$;

-- ── 2. One in_progress inspection per (property, room_number) ──────────────
-- Partial unique index — only enforces uniqueness while result='in_progress'.
-- Race-safety upgrade for the find-then-insert pattern in the start routes.
create unique index if not exists inspections_one_in_progress_per_room
  on public.inspections (property_id, room_number)
  where result = 'in_progress';

-- ── 3. Migration record ────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0221',
  'inspections follow-up: backfill standard checklist items if empty; add partial unique index for one in_progress inspection per (property, room).'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
