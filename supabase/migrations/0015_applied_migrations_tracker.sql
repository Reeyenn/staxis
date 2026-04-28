-- ═══════════════════════════════════════════════════════════════════════════
-- 0015 — Applied-migrations tracker
--
-- From the 2026-04-28 founder-perspective audit. Numbered migrations live as
-- files in /supabase/migrations/ but Supabase doesn't ship a built-in tracker
-- for which ones have been applied to a given project. Today they're hand-
-- applied via the SQL editor; if a deploy ships code that calls a column
-- added in 00NN before 00NN was applied, the route 500s with a cryptic
-- "relation … not found" error and Mario sees a broken page.
--
-- Fix: add a tiny tracker. Each migration self-registers when it runs. The
-- doctor endpoint (added separately) compares applied versions against the
-- set of files in the repo and refuses green if any are missing — surfacing
-- schema drift before it surfaces as a user incident.
--
-- This migration is BEHAVIOR-NEUTRAL. It only adds a new table and seeds it
-- with the existing migration history; nothing in the app reads from it
-- yet. The doctor check is wired in a follow-up commit.
--
-- ───── NOT included in 0015 (deferred to post-launch) ────────────────────
--
-- The audit also flagged that the `accounts` table has no RLS — a future
-- engineer wiring a browser query could leak the full user table. The
-- right policy is "authenticated users can read their own row only"
-- (matching how src/contexts/AuthContext.tsx already queries it). That
-- migration is drafted but DEFERRED to a post-launch verification window
-- because RLS changes can break login in subtle ways and the cost of a
-- wrong policy at 9 AM tomorrow is much higher than the cost of waiting
-- a few days. See the audit report for the full SQL when ready.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.applied_migrations (
  version       text primary key,                 -- '0001', '0015', etc.
  applied_at    timestamptz not null default now(),
  -- Short human-readable name so the doctor's report is readable.
  description   text
);

-- Tracker is server-only — nothing in the browser should ever touch it.
-- service_role bypasses RLS, so the doctor (which runs server-side) reads
-- it fine. Any browser query gets fail-closed instead of fail-open.
alter table public.applied_migrations enable row level security;
drop policy if exists applied_migrations_deny_browser on public.applied_migrations;
create policy applied_migrations_deny_browser on public.applied_migrations
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.applied_migrations is
  'Tracks which numbered migrations have been applied to this Supabase project. Each migration self-inserts a row at the bottom of its file. The /api/admin/doctor endpoint reads this table to detect schema drift between code and DB.';


-- Bootstrap: insert rows for every migration this project ships with so
-- a fresh doctor run on the production DB doesn't show 14 missing
-- migrations. ON CONFLICT DO NOTHING means re-applying this file is safe.
insert into public.applied_migrations (version, description) values
  ('0001', 'Initial schema (Firebase → Supabase migration)'),
  ('0002', 'Auth bridge (accounts ↔ auth.users)'),
  ('0003', 'RLS policies'),
  ('0004', 'RLS status view'),
  ('0005', 'Schedule confirmations'),
  ('0006', 'Realtime replication identity'),
  ('0007', 'Plan snapshots'),
  ('0008', 'Schedule assignments'),
  ('0009', 'Staff column-list publication'),
  ('0010', 'Work orders + OOO'),
  ('0011', 'Pull metrics + scraper session'),
  ('0012', 'Cleaning events'),
  ('0013', 'Fix REPLICA IDENTITY on staff/shift_confirmations'),
  ('0014', 'Allow hk_center_on_demand pull_type'),
  ('0015', 'Applied-migrations tracker')
on conflict (version) do nothing;
