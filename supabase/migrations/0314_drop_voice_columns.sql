-- 0314: Drop the three accounts columns left behind by the removed voice/Talk
-- feature (added in 0117_voice_surface.sql; feature deleted 2026-07-15).
-- Verified zero references across src/, cua-service/, ml-service/ before drop.
-- Dead-code purge audit, 2026-07-16.

ALTER TABLE accounts
  DROP COLUMN IF EXISTS voice_onboarded_at,
  DROP COLUMN IF EXISTS voice_replies_enabled,
  DROP COLUMN IF EXISTS wake_word_enabled;

insert into public.applied_migrations (version, description)
values ('0314', 'Drop unused accounts voice columns (voice feature removed 2026-07-15)')
on conflict (version) do nothing;

NOTIFY pgrst, 'reload schema';
