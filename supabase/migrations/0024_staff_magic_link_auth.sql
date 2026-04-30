-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0024 — Magic-link auth for housekeepers
--
-- Each staff member can have a backing auth.users row. When Maria sends
-- shift confirmations (or hits the Link/Copy button on the schedule), the
-- server lazily creates that auth user (if missing) and mints a one-time
-- magic-link token. The token is embedded in the housekeeper URL the SMS
-- carries; the page consumes it on mount and establishes a Supabase
-- session. With a real session, the supabase-realtime channel actually
-- delivers postgres_changes payloads instead of silently no-op'ing under
-- RLS — which means Start/Done taps reflect on screen instantly without
-- the 4-second polling fallback we shipped earlier today.
--
-- Key design choice: the staff.id and auth.users.id are NOT the same
-- value. We track the linkage via a new staff.auth_user_id column. That
-- way the existing staff IDs (referenced from a dozen tables and from
-- Maria's manual share links) stay stable, and we get to set/replace the
-- auth user without touching any of those references.
--
-- The housekeeper auth users use a synthetic email of the form
-- 'staff-{uuid}@staxis.invalid'. The `.invalid` TLD is reserved by RFC
-- 2606 and routes nowhere — these are NOT real email addresses, just an
-- identity placeholder that satisfies Supabase's auth.users requirement
-- of an email per row.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Link staff → auth.users ────────────────────────────────────────────
alter table staff
  add column if not exists auth_user_id uuid
  references auth.users(id) on delete set null;

-- Indexed because the housekeeper-read RLS policy below joins on it for
-- every row read — without the index Postgres seq-scans staff on each
-- subscribe payload.
create index if not exists staff_auth_user_id_idx on staff(auth_user_id);

comment on column staff.auth_user_id is
  'Supabase auth user backing this staff record. Populated lazily by '
  'src/lib/staff-auth.ts when Maria first generates a housekeeper link. '
  'Used by the rooms-by-housekeeper RLS policy below to scope reads.';

-- ─── 2. RLS policy: housekeepers read their own assigned rooms ─────────────
-- The existing "owner rw rooms" policy is unchanged; this new policy is
-- additive (RLS combines policies with OR for SELECT). For an
-- authenticated housekeeper session, this policy matches when the room's
-- assigned_to points at a staff row whose auth_user_id == auth.uid().
-- Owners (Maria) get matched by the existing policy; nothing changes for
-- her.
--
-- Note we do NOT add a corresponding write policy — all housekeeper
-- writes still go through /api/housekeeper/room-action with service role.
-- That keeps the audit / cleaning_events insert / capability check logic
-- in one server-side place.
create policy "housekeeper read own rooms"
  on rooms for select
  to authenticated
  using (
    exists (
      select 1 from staff s
      where s.id = rooms.assigned_to
        and s.auth_user_id = auth.uid()
    )
  );

-- Housekeepers also need to read their own staff row (for the language
-- preference + name on the page). Same join, same scoping.
create policy "housekeeper read own staff row"
  on staff for select
  to authenticated
  using (auth_user_id = auth.uid());
