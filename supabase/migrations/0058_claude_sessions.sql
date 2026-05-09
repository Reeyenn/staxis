-- 0058_claude_sessions.sql
-- Tracks every active Claude Code session that's pinging the heartbeat
-- endpoint. The admin System tab uses this to show "X Claude sessions
-- are working RIGHT NOW" with per-session branch + last-action info.
--
-- Heartbeats are emitted by a PostToolUse hook in .claude/settings.json.
-- Sessions whose last_heartbeat is older than 2 minutes are considered
-- gone and disappear from the live view automatically (no explicit
-- shutdown signal needed — Claude sessions don't always exit cleanly).

create table if not exists public.claude_sessions (
  -- The Claude Code session_id (uuid). Stable for the lifetime of one
  -- session; primary key so heartbeats from the same session upsert.
  session_id text primary key,
  -- Working git branch at the time of the latest heartbeat. Null if the
  -- session is in a non-git directory.
  branch text,
  -- The tool that just fired. 'Edit', 'Bash', 'Read', 'Write', etc.
  current_tool text,
  -- When the very first heartbeat for this session arrived.
  started_at timestamptz not null default now(),
  -- Updated on every heartbeat. The "is this session still alive"
  -- check compares this against now() with a 2-min window.
  last_heartbeat timestamptz not null default now(),
  -- Working directory of the session — useful to tell apart sessions
  -- across worktrees that share a branch name.
  cwd text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists claude_sessions_heartbeat_idx
  on public.claude_sessions (last_heartbeat desc);
create index if not exists claude_sessions_branch_idx
  on public.claude_sessions (branch);

alter table public.claude_sessions enable row level security;
-- Service-role only (heartbeat endpoint + admin reader use supabaseAdmin).
