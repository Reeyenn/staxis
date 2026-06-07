-- 0270 — Remaining housekeeper workflow-state columns on
-- pms_housekeeping_assignments.
--
-- Context: migration 0269 moved 8 workflow-state columns (pause accounting,
-- checklist, exception) off the legacy `rooms` table onto
-- pms_housekeeping_assignments so the housekeeper start/pause/resume/complete
-- endpoints could persist against the same row the page reads. This finishes
-- the job: the remaining legacy `rooms` workflow fields that still had no
-- pms_* home — manager/housekeeper notes, rush flags, inspection sign-off,
-- and the issue/help/dnd notes the AI + housekeeper actions write. Once the
-- app writers repoint here (feature/pms-rooms-retire), the legacy `rooms`
-- table can be dropped.
--
-- All additive + nullable (the two booleans default false) → no backfill, no
-- behaviour change for existing readers. RLS is already deny-all on pms_*
-- (service-role only); no policy change needed. Column types mirror the
-- legacy `rooms` definitions (0205 stub + 0222/0224 alters).

ALTER TABLE pms_housekeeping_assignments
  ADD COLUMN IF NOT EXISTS manager_notes text,
  ADD COLUMN IF NOT EXISTS manager_notes_at timestamptz,
  ADD COLUMN IF NOT EXISTS manager_notes_by_account_id uuid,
  ADD COLUMN IF NOT EXISTS housekeeper_note text,
  ADD COLUMN IF NOT EXISTS housekeeper_note_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_rush boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rush_due_by timestamptz,
  ADD COLUMN IF NOT EXISTS rush_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS rush_set_by uuid,
  ADD COLUMN IF NOT EXISTS rush_requested_by_account_id uuid,
  ADD COLUMN IF NOT EXISTS rush_duration_label text,
  ADD COLUMN IF NOT EXISTS marked_for_inspection_at timestamptz,
  ADD COLUMN IF NOT EXISTS inspected_by text,
  ADD COLUMN IF NOT EXISTS inspected_at timestamptz,
  ADD COLUMN IF NOT EXISTS issue_note text,
  ADD COLUMN IF NOT EXISTS help_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dnd_note text;

insert into applied_migrations (version, description)
values ('0270', 'pms_housekeeping_assignments workflow state remainder (notes/rush/inspection/issue/help/dnd)')
on conflict (version) do nothing;

-- Reload PostgREST so the REST layer sees the new columns immediately.
notify pgrst, 'reload schema';
