-- 0269 — Housekeeper workflow state columns on pms_housekeeping_assignments.
--
-- Context: the Plan-v4 rebuild (0204/0205) stubbed the legacy `rooms` table
-- empty and moved the room read path to the pms_* schema
-- (mergePmsRoomsForStaff). But the housekeeper WORKFLOW write endpoints
-- (start/pause/resume/complete/reset/exception + checklist toggle) still
-- read/wrote `rooms` via loadRoomForStaff — which is now empty, so every
-- Start/Done 404'd. This migration adds the workflow-state columns to
-- pms_housekeeping_assignments so those endpoints can persist against the
-- same table the page reads, finishing the housekeeper side of the rebuild.
--
-- started_at / completed_at / status already exist on the table; the read
-- path (deriveStatus) already derives dirty/in_progress/clean from them.
-- These 8 columns carry the rest of the workflow state (pause accounting,
-- per-room checklist progress + template, and exceptions).
--
-- All additive + nullable → no backfill, no behaviour change for existing
-- readers. RLS is already deny-all on pms_* (service-role only); no policy
-- change needed.

ALTER TABLE pms_housekeeping_assignments
  ADD COLUMN IF NOT EXISTS is_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS total_paused_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checklist_template_id uuid,
  ADD COLUMN IF NOT EXISTS checklist_progress text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS exception_type text,
  ADD COLUMN IF NOT EXISTS exception_note text,
  ADD COLUMN IF NOT EXISTS exception_at timestamptz;

-- Mirror the legacy rooms.exception_type allow-list.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pms_hk_assign_exception_type_chk'
  ) THEN
    ALTER TABLE pms_housekeeping_assignments
      ADD CONSTRAINT pms_hk_assign_exception_type_chk
      CHECK (exception_type IS NULL OR exception_type IN
        ('dnd', 'nsr', 'dla', 'sleep_out', 'skipped'));
  END IF;
END $$;

insert into applied_migrations (version, description)
values ('0269', 'pms_housekeeping_assignments workflow state columns')
on conflict (version) do nothing;

-- Reload PostgREST so the REST layer sees the new columns immediately.
notify pgrst, 'reload schema';
