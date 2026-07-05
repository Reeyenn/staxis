-- 0291_pms_feed_values.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Per-feed PAGE-LEVEL scalars ("page values").
-- ═══════════════════════════════════════════════════════════════════════════
-- When the founder captures a one-off value on a feed page (e.g. the "Guest
-- Count: 23" / "Room Count: 10" totals in the Arrivals header), that value
-- describes the WHOLE feed, not any single data row. Previously such scope:'page'
-- values were stamped onto every extracted row's `raw` jsonb (duplicated N times,
-- and lost entirely when the feed had 0 rows). This table stores them ONCE per
-- (property, feed) per poll instead — the correct model for a feed-level number,
-- and it survives an empty feed.
--
-- One row per (property_id, feed_key), UPSERTED every poll. `values` is a flat
-- jsonb of {captured_key: text_value} (founder-named keys, any PMS). Mirrors
-- pms_in_house_snapshot's atomic last-good semantics: on a failed extraction we
-- keep the previous good `values` and flag has_error.
--
-- service-role only (like every pms_* table, 0202). The Staxis web app reads it
-- through an admin /api route using supabaseAdmin — never the browser client.

create table if not exists public.pms_feed_values (
  property_id    uuid not null references public.properties(id) on delete cascade,
  feed_key       text not null,
  values         jsonb not null default '{}'::jsonb,
  captured_at    timestamptz not null default now(),
  last_good_at   timestamptz,
  has_error      boolean not null default false,
  last_error     text,
  last_error_at  timestamptz,
  last_synced_at timestamptz not null default now(),
  primary key (property_id, feed_key)
);

comment on table public.pms_feed_values is
  'Per-feed page-level scalars (one-off "page values" the founder captures, e.g. "Guest Count: 23"). One row per (property, feed), upserted each poll; values jsonb = {key: text}. Stored ONCE per feed (not stamped per data row) and survives an empty feed. Atomic last-good semantics like pms_in_house_snapshot. service-role only; web reads via admin /api. Created 0291.';
comment on column public.pms_feed_values.values is
  'Flat {founder_key: text_value} of the feed-level page values captured this poll.';
comment on column public.pms_feed_values.last_good_at is
  'When values were last refreshed with a known-good extraction. Stale-but-true preserved when has_error=true.';

-- service-role only — mirrors the 0202 pms_* RLS posture (anon + authenticated
-- denied; the service role bypasses RLS; the web reads via admin /api).
alter table public.pms_feed_values enable row level security;
revoke all on public.pms_feed_values from public, anon, authenticated;
grant select, insert, update, delete on public.pms_feed_values to service_role;
drop policy if exists pms_feed_values_no_client on public.pms_feed_values;
create policy pms_feed_values_no_client on public.pms_feed_values
  for all to anon, authenticated using (false) with check (false);

-- Self-register (every migration does this; the doctor + migration-bookkeeping
-- test require the row).
insert into public.applied_migrations (version, description)
values ('0291', 'pms_feed_values: per-feed page-level scalars (page totals), one row per (property,feed), service-role only.')
on conflict (version) do nothing;

-- PostgREST schema cache must be reloaded after DDL (CLAUDE.md).
notify pgrst, 'reload schema';
