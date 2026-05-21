-- 0155 — staff_magic_codes: server-side exchange for housekeeper SMS-link tokens.
--
-- F-NEW-02 in the core-web/auth/RLS security plan (Batch D). Before this
-- migration, the housekeeper SMS-link URL embedded a Supabase magic-link
-- hashed_token directly in the query string:
--
--   https://getstaxis.com/housekeeper/{staffId}?pid={pid}&token={hashed_token}
--
-- That URL is a one-week capability credential (Supabase magic-link
-- consumes to a ~1-week session). URLs are logged everywhere — Vercel
-- access logs, Sentry breadcrumbs (Sentry's default scrubber filters
-- `password=` not arbitrary `token=` params), browser history (Chrome
-- syncs across logged-in devices), `Referer` headers if the page
-- navigates anywhere external. SMS is the delivery channel and is not
-- end-to-end-encrypted at the carrier layer.
--
-- Batch D moves the token out of the URL. The flow becomes:
--
--   1. Server mints a short opaque CODE (~40 bits entropy, 15-min TTL,
--      single-use) and stores `{code → hashed_token}` in this table.
--   2. SMS contains the code in the URL: …?code={short_code}
--   3. Housekeeper page POSTs the code to /api/housekeeper/exchange-code,
--      which returns the hashed_token IN THE RESPONSE BODY (not in the
--      URL). The exchange route also marks the code consumed so it
--      can't be replayed.
--   4. Page calls supabase.auth.verifyOtp with the hashed_token to
--      establish the session, exactly like today.
--
-- The OLD ?token= URL keeps working for the transition window — see
-- src/app/housekeeper/[id]/page.tsx for the dual-format handling.
--
-- Idempotent. Safe to re-run.

create table if not exists public.staff_magic_codes (
  -- Short opaque code embedded in the SMS URL. 8 chars from a 32-char
  -- alphabet ≈ 40 bits of entropy; combined with the per-IP rate limit
  -- on the exchange endpoint, brute-forcing the code space is
  -- infeasible (10/hour × ~1e12 codes = millennia per real code).
  code text primary key,

  -- Identity binding: the code is valid ONLY for this staff member at
  -- this property. The exchange route verifies the body's claimed
  -- staffId + pid match what's stored here, so even if a code leaks
  -- the attacker can't use it to mint a session for a different staff.
  staff_id    uuid not null references public.staff(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,

  -- The actual Supabase magic-link hashed_token. Sensitive — never
  -- returned to the browser except via the exchange route, and only
  -- once (the row is marked consumed after the first exchange).
  hashed_token text not null,

  -- 15-minute TTL — shorter than Supabase's own 1-hour magic-link
  -- default. The window is "user taps SMS link within 15 min of
  -- Mario hitting Send." If they don't, Mario can just hit Send
  -- again (the per-staff_confirmations row dedup handles re-sends).
  expires_at timestamptz not null,

  -- Single-use. Set to now() on first successful exchange; subsequent
  -- exchanges of the same code fail. Defense against attacker who
  -- captures the code mid-flight (e.g. a man-in-the-middle on the
  -- carrier SMS path) — the legitimate first exchange consumes it
  -- and the attacker's replay fails.
  consumed_at timestamptz,

  created_at timestamptz not null default now()
);

-- Cleanup support: cron sweeps expired+consumed rows periodically.
-- The migration doesn't need the cron itself — the table grows slowly
-- (one row per Send Shift Confirmations × crew size = ~5-15 rows/day
-- per property) and the index keeps the lookup fast. A weekly purge
-- via the existing retention crons would zero it out.
create index if not exists staff_magic_codes_expires_idx
  on public.staff_magic_codes (expires_at);
create index if not exists staff_magic_codes_staff_idx
  on public.staff_magic_codes (staff_id);

-- RLS: service-role only. The exchange route uses supabaseAdmin; the
-- housekeeper page never touches this table directly. Anon and
-- authenticated roles have no policies → default-deny.
alter table public.staff_magic_codes enable row level security;
-- Idempotent re-runs: drop any existing policies before declaring new
-- ones. (We declare none; the deny-all default is intentional.)
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'staff_magic_codes'
  loop
    execute format('drop policy if exists %I on public.staff_magic_codes', pol.policyname);
  end loop;
end $$;

comment on table public.staff_magic_codes is
  'F-NEW-02 / Batch D: server-side exchange for housekeeper SMS-link tokens. SMS URL carries a short opaque code; /api/housekeeper/exchange-code swaps it for the real Supabase hashed_token. Service-role only.';

-- Bookkeeping
insert into public.applied_migrations (version, description)
values (
  '0155',
  'F-NEW-02 / Batch D: staff_magic_codes table for server-side housekeeper magic-link exchange'
)
on conflict (version) do nothing;
