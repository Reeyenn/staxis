-- 0060_local_worktrees.sql
-- Tracks every git worktree on Reeyen's local machine, surfaced to the
-- admin System tab's Marvel timeline. Lets the timeline be the single
-- source of truth — Reeyen never has to look at GitHub or his filesystem
-- to know what branches exist.
--
-- Vercel can't read his local filesystem, so a small sync script on his
-- Mac (~/.claude/hooks/staxis-worktrees-sync.sh) periodically posts the
-- current worktree list to /api/local-worktrees/sync. That endpoint
-- atomically replaces all rows for the host, so deleting a worktree
-- locally makes it disappear from the timeline on the next sync.

create table if not exists public.local_worktrees (
  -- Composite key: each (host, name) pair is one worktree. host gives
  -- us room to support multiple machines later (laptop + desktop) but
  -- today there's just one.
  host text not null default 'reeyen-mac',
  name text not null,
  branch text,
  -- Number of files with uncommitted changes. 0 means clean.
  dirty_files int not null default 0,
  -- Commits this branch has that main does not. > 0 means there's
  -- unpushed local work on this worktree.
  commits_ahead int not null default 0,
  -- Commits main has that this branch does not. Useful to detect
  -- worktrees that are far behind.
  commits_behind int not null default 0,
  -- ISO timestamp from the worktree's HEAD commit, if available. Lets
  -- the timeline tell stale worktrees from active ones.
  head_committed_at timestamptz,
  -- Branch tip's commit message (first line). Shown on hover on the
  -- timeline.
  head_message text,
  -- Set every time the sync script reports this worktree. Rows whose
  -- last_seen is older than ~10 min on the next sync are deleted as
  -- the worktree was probably removed locally.
  last_seen timestamptz not null default now(),
  primary key (host, name)
);

create index if not exists local_worktrees_last_seen_idx
  on public.local_worktrees (last_seen desc);

alter table public.local_worktrees enable row level security;
-- Service-role only (sync endpoint uses supabaseAdmin; admin reader
-- also goes through service-role).
