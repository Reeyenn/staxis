-- 0283_mapping_feed_captures.sql
-- feature/cua-mapper-phases-captures — durable per-feed PROVENANCE screenshots.
--
-- When the CUA PMS-learning mapper successfully extracts a feed, it saves ONE
-- masked screenshot of the screen it read the feed off, at the durable storage
-- key `mapping-screenshots/{job_id}/feeds/{feed_key}.png` (private bucket,
-- service-role only, upsert). This table is the index over those objects so the
-- admin live view / provenance UI can list "here's where Arrivals came from"
-- per feed, long after the run ends.
--
-- Unlike the live frame (`{job_id}/live.png`, deleted on job teardown) these
-- objects + rows are DURABLE — kept for provenance. Nothing prefix-wipes
-- `{job_id}/`, so they survive (verified against live-frame.close() and the
-- expire-help-requests cron, both of which remove only explicit object keys).
--
-- @rls: SERVICE-ROLE-ONLY (deny-all-browser), exactly like 0278
-- (mapper_takeover_sessions) and pms_knowledge_files (0201). The cua-service
-- worker (service_role) inserts. The READER is a companion admin Next API route
-- (supabaseAdmin + requireAdmin, reads the rows + mints signed URLs for the
-- objects) built by the web app to this contract — NOT shipped in this change,
-- so on this branch the table is write-only until that route lands. The browser
-- NEVER touches this table directly (RLS bug-class rule for anything an
-- unauthenticated/anon visitor could otherwise hit). No realtime — the board
-- reads it by polling that admin route, so no publication / replica identity.

create table if not exists public.mapping_feed_captures (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.workflow_jobs(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  -- The PMS family this map was learned for (e.g. 'choice_advantage'). Knowledge
  -- files are per-family, so provenance is too.
  pms_family text not null,
  -- The mapper target / Recipe.actions key (e.g. 'getRoomStatus', 'getArrivals').
  feed_key text not null,
  -- Storage object key in the private 'mapping-screenshots' bucket:
  -- `{job_id}/feeds/{feed_key}.png`.
  screenshot_path text not null,
  created_at timestamptz not null default now()
);

-- The board reads "the capture(s) for this job's feed". A re-mapped feed in a
-- later attempt of the same job overwrites the storage object (upsert) but may
-- add a fresh row pointing at the same deterministic path; the reader takes the
-- newest by created_at. Non-unique on purpose.
create index if not exists mapping_feed_captures_job_feed_idx
  on public.mapping_feed_captures (job_id, feed_key);

-- ─── RLS: service-role-only (deny-all-browser) ──────────────────────────────
alter table public.mapping_feed_captures enable row level security;
revoke all on public.mapping_feed_captures from public, anon, authenticated;
grant select, insert, update, delete on public.mapping_feed_captures to service_role;

drop policy if exists mapping_feed_captures_deny_all_browser on public.mapping_feed_captures;
create policy mapping_feed_captures_deny_all_browser
  on public.mapping_feed_captures
  for all
  to anon, authenticated
  using (false) with check (false);
comment on policy mapping_feed_captures_deny_all_browser on public.mapping_feed_captures is
  'Deny all browser access. cua-service (service_role) inserts; Next admin API (supabaseAdmin) reads + signs URLs. service_role bypasses RLS.';

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0283', 'feature/cua-mapper-phases-captures: mapping_feed_captures — durable per-feed provenance screenshot index, service-role only.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
