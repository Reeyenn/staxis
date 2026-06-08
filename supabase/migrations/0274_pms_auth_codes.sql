-- ═══════════════════════════════════════════════════════════════════════════
-- 0274 — PMS auth-code inbox (Okta 2FA email reader for the CUA robot)
--
-- Choice Hotels' PMS now logs in via ChoiceConnect → Okta SSO, which forces
-- MFA. Each hotel gets a dedicated "Staxis AI" Okta user that uses an email
-- address WE control (`<propertycode>@pms.getstaxis.com`, catch-all). The
-- robot reads its own login code from that inbox so every unattended
-- re-login needs no human.
--
-- Pipeline: Okta email → Cloudflare Email Routing (subdomain catch-all) →
-- Email Worker → POST /api/pms-inbox/inbound (verifies DKIM/DMARC + shared
-- secret) → pms_auth_codes. The CUA worker calls claim_pms_auth_code() to
-- atomically consume the newest unconsumed code (single-use).
--
-- SECURITY: codes are short-lived 2FA secrets. Service-role only, deny-all to
-- anon/authenticated (mirrors scraper_credentials 0018 / the pms_* tables).
-- They never reach the browser — the admin viewer reads them through an
-- admin API route that masks server-side. Single-use is enforced atomically
-- by the claim_pms_auth_code() RPC (UPDATE ... WHERE consumed_at IS NULL ...
-- FOR UPDATE SKIP LOCKED), and a short TTL is enforced query-time.
-- ═══════════════════════════════════════════════════════════════════════════

-- @rls: service-role-only — Okta 2FA codes; webhook writes, CUA reads; never user-readable
create table if not exists public.pms_auth_codes (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  -- The inbox address the code was delivered to (e.g. txa32@pms.getstaxis.com).
  email_to     text not null,
  -- 'email' today; 'sms' is a designed-for future factor (Twilio inbound).
  source       text not null default 'email' check (source in ('email', 'sms')),
  code         text not null,
  -- The verified sender (From). Kept for audit / debugging which Okta address sent it.
  sender       text,
  subject      text,
  received_at  timestamptz not null default now(),
  -- Set the moment the robot claims the code. Single-use: a consumed row is
  -- never returned again, even if the subsequent Okta submit fails.
  consumed_at  timestamptz,
  -- The provider message-id. UNIQUE (below) so a replayed/duplicate delivery
  -- of the same message can't insert twice.
  raw_ref      text
);

-- Newest-unconsumed-for-property lookup (the claim RPC's hot path).
create index if not exists pms_auth_codes_property_recv_idx
  on public.pms_auth_codes (property_id, received_at desc);

-- Dedup / replay guard: the same provider message can only ever store once.
-- Partial (where raw_ref is not null) so rows without a message-id are allowed.
create unique index if not exists pms_auth_codes_raw_ref_uidx
  on public.pms_auth_codes (raw_ref)
  where raw_ref is not null;

-- ── RLS: service-role only (mirrors scraper_credentials 0018) ──────────────
alter table public.pms_auth_codes enable row level security;
revoke all on public.pms_auth_codes from public, anon, authenticated;
grant select, insert, update, delete on public.pms_auth_codes to service_role;

drop policy if exists pms_auth_codes_deny_all_browser on public.pms_auth_codes;
create policy pms_auth_codes_deny_all_browser on public.pms_auth_codes
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.pms_auth_codes is
  'Okta 2FA one-time codes for the CUA robot''s PMS login. Service-role only; webhook (/api/pms-inbox/inbound) writes, CUA worker reads via claim_pms_auth_code(). Single-use + short TTL. Created 0274.';
comment on policy pms_auth_codes_deny_all_browser on public.pms_auth_codes is
  'Service-role only. 2FA codes must never be readable by the browser/anon. Created 0274.';

-- ── Inbox-address → property map ───────────────────────────────────────────
-- The webhook resolves the recipient address to a property via this column.
-- UNIQUE (case-insensitive) so an inbox address maps to exactly one hotel.
alter table public.scraper_credentials add column if not exists pms_login_email text;
create unique index if not exists scraper_credentials_pms_login_email_uidx
  on public.scraper_credentials (lower(pms_login_email))
  where pms_login_email is not null;
comment on column public.scraper_credentials.pms_login_email is
  'The AI Okta account''s email (e.g. txa32@pms.getstaxis.com). Maps an inbound 2FA-code email to this property. UNIQUE (lower). Added 0274.';

-- ── Atomic single-use claim ────────────────────────────────────────────────
-- Selects the newest unconsumed, non-expired code for a property and marks it
-- consumed in ONE statement (FOR UPDATE SKIP LOCKED → no select-then-claim
-- race between concurrent fetchers; the loser gets zero rows and re-polls).
-- p_not_before is the login watermark: callers that stamp when they triggered
-- the Okta send pass it so only codes that arrived AFTER the request count.
create or replace function public.claim_pms_auth_code(
  p_property_id     uuid,
  p_max_age_seconds int default 180,
  p_not_before      timestamptz default null
)
returns table (id uuid, code text)
language sql
security definer
set search_path = public
as $$
  update public.pms_auth_codes
     set consumed_at = now()
   where id = (
     select c.id
       from public.pms_auth_codes c
      where c.property_id = p_property_id
        and c.consumed_at is null
        and c.received_at >= greatest(
              coalesce(p_not_before, to_timestamp(0)),
              now() - make_interval(secs => p_max_age_seconds))
      order by c.received_at desc
      limit 1
      for update skip locked
   )
  returning pms_auth_codes.id, pms_auth_codes.code;
$$;

revoke all on function public.claim_pms_auth_code(uuid, int, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_pms_auth_code(uuid, int, timestamptz) to service_role;

comment on function public.claim_pms_auth_code(uuid, int, timestamptz) is
  'Atomically claim (consume) the newest unconsumed, non-expired pms_auth_codes row for a property. Single-use. Service-role only. Created 0274.';

insert into public.applied_migrations (version, description)
values ('0274', 'PMS auth-code inbox: pms_auth_codes + scraper_credentials.pms_login_email + claim_pms_auth_code() RPC')
on conflict (version) do nothing;
