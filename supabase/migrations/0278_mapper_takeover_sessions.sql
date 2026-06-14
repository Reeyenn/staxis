-- 0278_mapper_takeover_sessions.sql
-- feature/cua-live-assist — founder-initiated, multi-step, robot-PAUSED takeover
-- of the CUA PMS-learning robot from the admin Learning Board.
--
-- Today the only "takeover" is single-click and ONLY fires when the robot
-- declares itself stuck (a mapping_help_requests row it opens). This table is
-- the FOUNDER-initiated interrupt + per-step command channel: the founder
-- presses "Take over" (or "Skip") on the board while the robot is working a
-- feed; the robot's mapActionCore loop polls this table at the top of each
-- step, and on an open row PAUSES its own AI decisions and drives by the
-- founder's clicks until Finish / Cancel / Skip.
--
-- Why a dedicated table (not mapping_help_requests): that table is robot-opened,
-- has a 15-min TTL + expire cron + one-pending-per-job + help-flood counting —
-- all wrong for an open-ended, founder-driven interactive session. Overloading
-- it would let the expire cron kill a takeover and the flood breaker miscount it.
--
-- @rls: SERVICE-ROLE-ONLY (deny-all-browser), exactly like pms_knowledge_files
-- (0201). The cua-service worker (service_role) subscribes for founder commands;
-- the Next API routes (supabaseAdmin + requireAdmin) do every founder write and
-- every board read. The browser NEVER touches this table directly (no anon/auth
-- realtime sub) — the board reads takeover state through
-- GET /api/admin/mapper/live/[jobId] (polled ~2.5s while a takeover is active).

create table if not exists public.mapper_takeover_sessions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.workflow_jobs(id) on delete cascade,

  -- 'requested' = founder pressed Take over / Skip; robot hasn't picked it up.
  -- 'active'    = robot paused its AI loop and is driving by founder clicks.
  -- 'ended'     = finished / cancelled / skipped / timeout / aborted.
  status text not null default 'requested'
    check (status in ('requested', 'active', 'ended')),

  -- The feed the robot was on when it entered takeover (robot fills on activate).
  -- For a Skip pressed against a specific searching feed, the API sets this so a
  -- mis-timed skip can never eat the NEXT feed (the gate no-ops a stale skip).
  target_key text,

  -- Robot bumps this AFTER it has uploaded the fresh takeover frame
  -- (mapping-screenshots/{job_id}/takeover.png). The board only enables
  -- "Send click" when the PAINTED frame's seq matches this; the founder's click
  -- carries command_frame_seq and the robot executes only if it still matches.
  frame_seq integer not null default 0,
  viewport_w integer not null default 1280,
  viewport_h integer not null default 800,

  -- Founder's latest command (written by the API on each click/finish/cancel/skip).
  command text check (command in ('click', 'finish', 'cancel', 'skip')),
  command_coordinate jsonb,            -- {x, y} viewport px for 'click'
  command_note text,
  command_seq integer not null default 0,    -- API increments per founder command
  command_frame_seq integer,           -- frame_seq the click was chosen against
  applied_command_seq integer not null default 0,  -- robot acks last processed command_seq

  requested_at timestamptz not null default now(),
  started_at timestamptz,              -- robot set when it paused + activated
  ended_at timestamptz,
  ended_reason text
    check (ended_reason in ('finished', 'cancelled', 'skipped', 'timeout', 'aborted', 'error')),
  admin_user_id uuid references public.accounts(id) on delete set null,
  created_at timestamptz not null default now()
);

-- One open takeover per job at a time. The API INSERTs and converges on 23505
-- (catch / re-select the winner) for double-click safety — mirrors
-- mapping_help_requests_one_pending_per_job.
create unique index if not exists mapper_takeover_one_open_per_job
  on public.mapper_takeover_sessions (job_id)
  where status in ('requested', 'active');

create index if not exists mapper_takeover_job_idx
  on public.mapper_takeover_sessions (job_id, created_at desc);

-- ─── RLS: service-role-only (deny-all-browser) ──────────────────────────────
alter table public.mapper_takeover_sessions enable row level security;
revoke all on public.mapper_takeover_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.mapper_takeover_sessions to service_role;

drop policy if exists mapper_takeover_deny_all_browser on public.mapper_takeover_sessions;
create policy mapper_takeover_deny_all_browser
  on public.mapper_takeover_sessions
  for all
  to anon, authenticated
  using (false) with check (false);
comment on policy mapper_takeover_deny_all_browser on public.mapper_takeover_sessions is
  'Deny all browser access. cua-service (service_role) + Next API routes (supabaseAdmin) only; service_role bypasses RLS.';

-- ─── Realtime: the cua-service worker subscribes for founder commands ───────
-- Mirrors migration 0216 for mapping_help_requests. Without REPLICA IDENTITY
-- FULL + publication membership the postgres_changes UPDATE events never reach
-- the worker's realtime subscription (it would idle the whole takeover).
alter table public.mapper_takeover_sessions replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.mapper_takeover_sessions;
  end if;
exception
  when duplicate_object then null;
end $$;

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0278', 'feature/cua-live-assist: mapper_takeover_sessions — founder-initiated multi-step robot-paused takeover (interrupt + per-step command channel), service-role only, realtime for the worker.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
