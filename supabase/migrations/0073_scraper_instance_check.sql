-- 0073_scraper_instance_check.sql
-- Tightens the scraper_credentials.scraper_instance column at the DB
-- layer to match the regex the admin reassign endpoint already enforces.
--
-- Background: migration 0018 added scraper_instance as free-form text
-- with a default of 'default'. Tier 3 introduced
-- /api/admin/scraper-assign which validates new values against
-- /^[A-Za-z0-9._-]{1,64}$/. That keeps the UI honest, but doesn't stop
-- a direct service-role INSERT (a one-off `psql` reassign, a future
-- admin route that forgets to validate, an ops mistake) from
-- persisting "alpha shard 1\n" or 500 chars of garbage.
--
-- Two failure modes that DB-side enforcement prevents:
--   1. Log/grep filter break — if scraper_instance contains a newline,
--      grepping Railway logs by "instance=alpha" silently misses
--      "alpha\nfoo" rows.
--   2. Env-var mismatch — SCRAPER_INSTANCE_ID env vars on Railway can
--      only hold "normal" identifier characters in practice. A row
--      with weird characters becomes orphaned (no Railway service can
--      match it) and the hotel stops syncing without an error.
--
-- Approach: add the CHECK constraint NOT VALID, then VALIDATE in the
-- same migration. NOT VALID means existing rows aren't checked at the
-- moment the constraint is added (cheap operation), and VALIDATE then
-- checks them after the constraint is in place for future writes. The
-- alternative — adding a VALID constraint directly — would acquire an
-- ACCESS EXCLUSIVE lock for the duration of the table scan. At our
-- current row count it's instant, but writing the migration this way
-- means the same SQL works when the table grows.

alter table public.scraper_credentials
  add constraint scraper_credentials_scraper_instance_format
  check (
    scraper_instance ~ '^[A-Za-z0-9._-]+$'
    and char_length(scraper_instance) between 1 and 64
  ) not valid;

-- Validate against the existing row(s). If this fails, an operator has
-- already INSERTed a malformed scraper_instance value via psql or a
-- one-off script — fix the row, re-run the migration.
alter table public.scraper_credentials
  validate constraint scraper_credentials_scraper_instance_format;

comment on constraint scraper_credentials_scraper_instance_format
  on public.scraper_credentials is
  'scraper_instance must match /^[A-Za-z0-9._-]{1,64}$/ — same regex as the admin reassign endpoint. Added in 0073 to enforce the contract at the DB layer regardless of write path.';

insert into public.applied_migrations (version, description)
values ('0073', 'scraper_credentials.scraper_instance regex check at DB layer')
on conflict (version) do nothing;
