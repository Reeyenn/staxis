-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Normalize auth.users token fields
--
-- Problem this solves:
--   GoTrue (Supabase Auth) has a long-standing bug where its Go code scans
--   several token columns in auth.users into non-nullable strings. If any
--   row has NULL in those columns, every /auth/v1/admin/users and
--   /auth/v1/token request 500s with "Database error loading user" or
--   "Database error querying schema" — effectively breaking login for
--   everyone.
--
--   Rows created via `supa.auth.admin.createUser(...)` (as the seed script
--   does) leave these columns as NULL by default. Rows created via the
--   normal signUp flow get empty strings. The admin-created path is the
--   one that bites us.
--
--   Hit on 2026-04-23 — Reeyen couldn't log in for hours after the Supabase
--   migration. Root cause took an hour to diagnose because the Vercel-side
--   doctor only tests data-plane, not auth-plane.
--
-- Fix, in two layers:
--   1. UPDATE all existing rows with COALESCE(col, '') so any already-
--      broken user is immediately repaired.
--   2. Install a BEFORE INSERT OR UPDATE trigger that catches any future
--      INSERT / UPDATE that would set one of these columns to NULL and
--      rewrites it to '' before it ever hits the table. Defense-in-depth:
--      even if Supabase patches GoTrue and admin.createUser starts writing
--      '' on its own, the trigger keeps us safe across version drift.
--
-- Safe to re-run: the UPDATE is idempotent (COALESCE of '' is still ''),
-- the trigger uses CREATE OR REPLACE FUNCTION + DROP IF EXISTS + CREATE
-- TRIGGER so there's no duplicate-trigger risk.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Repair existing rows ────────────────────────────────────────────────────
update auth.users set
  confirmation_token         = coalesce(confirmation_token, ''),
  email_change               = coalesce(email_change, ''),
  email_change_token_new     = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  recovery_token             = coalesce(recovery_token, ''),
  phone_change               = coalesce(phone_change, ''),
  phone_change_token         = coalesce(phone_change_token, ''),
  reauthentication_token     = coalesce(reauthentication_token, '')
where
  confirmation_token         is null
  or email_change               is null
  or email_change_token_new     is null
  or email_change_token_current is null
  or recovery_token             is null
  or phone_change               is null
  or phone_change_token         is null
  or reauthentication_token     is null;

-- 2. Trigger function: rewrite NULLs to '' on write ──────────────────────────
-- security definer so it runs with postgres privileges regardless of which
-- role is driving the write (supabase_auth_admin, service_role, postgres).
-- search_path pinned to prevent injection via shadowed functions.
create or replace function public.staxis_normalize_auth_tokens()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.confirmation_token         := coalesce(new.confirmation_token, '');
  new.email_change               := coalesce(new.email_change, '');
  new.email_change_token_new     := coalesce(new.email_change_token_new, '');
  new.email_change_token_current := coalesce(new.email_change_token_current, '');
  new.recovery_token             := coalesce(new.recovery_token, '');
  new.phone_change               := coalesce(new.phone_change, '');
  new.phone_change_token         := coalesce(new.phone_change_token, '');
  new.reauthentication_token     := coalesce(new.reauthentication_token, '');
  return new;
end;
$$;

-- 3. Attach the trigger to auth.users ────────────────────────────────────────
-- Drop-then-create so re-applying the migration doesn't stack triggers.
drop trigger if exists staxis_normalize_auth_tokens_trg on auth.users;

create trigger staxis_normalize_auth_tokens_trg
  before insert or update on auth.users
  for each row
  execute function public.staxis_normalize_auth_tokens();

-- ═══════════════════════════════════════════════════════════════════════════
-- Verify after applying:
--
--   select count(*) filter (where confirmation_token         is null) as nul_ct,
--          count(*) filter (where email_change               is null) as nul_ec,
--          count(*) filter (where recovery_token             is null) as nul_rt
--     from auth.users;
--   -- Expected: all zeros.
--
--   select tgname from pg_trigger
--     where tgrelid = 'auth.users'::regclass
--       and tgname  = 'staxis_normalize_auth_tokens_trg';
--   -- Expected: one row.
-- ═══════════════════════════════════════════════════════════════════════════
