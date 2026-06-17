-- 0285_mapping_notes.sql
-- feature/cua-operator-notes — let the founder leave the running mapper a note.
--
-- The admin learning board (/admin/properties/mapper/[jobId]) gets a text box:
-- the founder types a nudge ("try the Reports menu", "wrong page, go back") at
-- ANY time while the robot is mapping. It lands here, and the cua-service worker
-- folds unconsumed notes for the job into the agent's next step (appended to the
-- trailing user turn — the same safe injection the takeover finish-hint uses;
-- never a consecutive-user message). The robot reads it on its next think-step
-- (seconds away), so it's effectively live.
--
-- @rls: SERVICE-ROLE-ONLY (deny-all-browser), exactly like 0283
-- (mapping_feed_captures) and 0278 (mapper_takeover_sessions). The Next admin API
-- route (supabaseAdmin + requireAdmin) inserts; the cua-service worker
-- (service_role) reads unconsumed rows + stamps consumed_at. The browser NEVER
-- touches this table directly (RLS bug-class rule). No realtime — the worker
-- polls it between steps; the board reflects sent notes from its own POST.

create table if not exists public.mapping_notes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.workflow_jobs(id) on delete cascade,
  -- Optional context: the hotel this job is mapping (notes are scoped by job_id;
  -- property_id is for future per-property history / auditing).
  property_id uuid references public.properties(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  -- NULL until the worker injects it into the agent; stamped at consumption so a
  -- note is delivered exactly once.
  consumed_at timestamptz
);

-- The hot query is "unconsumed notes for THIS job, oldest first" (the worker
-- drains them each step). Partial index keeps it tiny.
create index if not exists mapping_notes_job_unconsumed_idx
  on public.mapping_notes (job_id, created_at)
  where consumed_at is null;

-- ─── RLS: service-role-only (deny-all-browser) ──────────────────────────────
alter table public.mapping_notes enable row level security;
revoke all on public.mapping_notes from public, anon, authenticated;
grant select, insert, update, delete on public.mapping_notes to service_role;

drop policy if exists mapping_notes_deny_all_browser on public.mapping_notes;
create policy mapping_notes_deny_all_browser
  on public.mapping_notes
  for all
  to anon, authenticated
  using (false) with check (false);
comment on policy mapping_notes_deny_all_browser on public.mapping_notes is
  'Deny all browser access. Next admin API (supabaseAdmin + requireAdmin) inserts; cua-service (service_role) reads + consumes. service_role bypasses RLS.';

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0285', 'feature/cua-operator-notes: mapping_notes — founder nudges injected into the running mapper, service-role only.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
