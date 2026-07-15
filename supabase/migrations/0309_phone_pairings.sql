-- 0309 — QR phone handoff with email OTP and durable device trust.
--
-- A trusted desktop creates a 60-second QR capability. Scanning the QR
-- atomically consumes that capability and replaces it with a distinct
-- challenge capability. Email-code verification consumes the challenge and
-- replaces it with a distinct completion grant. Completion is bound to the
-- exact Supabase auth session created by the verified magic-link token and,
-- in one transaction, creates both durable device trust and session-scoped
-- MFA verification.
--
-- Every browser-facing capability is random 256-bit material. Only SHA-256
-- digests are stored. The six-digit OTP is stored as HMAC-SHA256 keyed by the
-- raw challenge token, so the database never contains the code and a database
-- read alone is insufficient for offline enumeration.

begin;

-- api_limits.property_id is a legacy column name. The limiter intentionally
-- accepts opaque UUID-shaped scopes for IPs, emails, accounts, and composite
-- identities (see hashToRateLimitKey/clientIpRateLimitKey). Migrations 0077
-- and 0142 later added a properties(id) FK, making every non-property scope
-- fail with a FK violation. Non-billing limits then failed open, while the
-- email limiter failed closed. Drop the incompatible FK; the 48-hour cleanup
-- RPC remains the lifecycle owner for all scope rows.
alter table public.api_limits
  drop constraint if exists api_limits_property_id_fkey;

comment on column public.api_limits.property_id is
  'Legacy name: opaque UUID-shaped rate-limit scope. May be a real property id or a SHA-256-derived IP/email/account/composite key. Deliberately has no properties FK; rows are pruned by staxis_api_limit_cleanup().';

-- @rls: service-role-only — contains short-lived authentication material.
create table if not exists public.phone_pairings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,

  -- The capabilities are mutually successive. The QR hash remains only for
  -- same-challenge claim recovery during the original 60-second window, then
  -- is cleared on verification. The verified challenge proof is retained only
  -- until completion so a lost verify response can recover the same grant.
  -- The completion hash remains through its original TTL solely for exact
  -- same-session retries.
  pairing_token_hash text unique,
  challenge_token_hash text unique,
  completion_token_hash text unique,

  pair_expires_at timestamptz not null,
  challenge_expires_at timestamptz,
  completion_expires_at timestamptz,

  -- Supabase generateLink() output. The OTP digest is HMAC(code,
  -- raw-challenge-token); the hashed token is returned only after a correct
  -- code, retained briefly for lost-response recovery, then cleared on
  -- completion.
  otp_digest text,
  supabase_hashed_token text,
  send_count smallint not null default 0,
  send_reservation_id uuid,
  send_reservation_count smallint,
  send_reservation_started_at timestamptz,
  pending_otp_digest text,
  pending_supabase_hashed_token text,
  verify_attempt_count smallint not null default 0,
  last_send_started_at timestamptz,
  otp_sent_at timestamptz,
  otp_expires_at timestamptz,

  claimed_at timestamptz,
  otp_verified_at timestamptz,
  completed_at timestamptz,
  completed_session_id uuid,
  completed_device_token_hash text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),

  desktop_user_agent text,
  desktop_ip text,
  phone_user_agent text,
  phone_ip text,

  constraint phone_pairings_pair_hash_shape check (
    pairing_token_hash is null or pairing_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint phone_pairings_challenge_hash_shape check (
    challenge_token_hash is null or challenge_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint phone_pairings_completion_hash_shape check (
    completion_token_hash is null or completion_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint phone_pairings_completed_device_hash_shape check (
    completed_device_token_hash is null or completed_device_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint phone_pairings_otp_hash_shape check (
    otp_digest is null or otp_digest ~ '^[0-9a-f]{64}$'
  ),
  constraint phone_pairings_pending_otp_hash_shape check (
    pending_otp_digest is null or pending_otp_digest ~ '^[0-9a-f]{64}$'
  ),
  constraint phone_pairings_send_count_check check (send_count between 0 and 3),
  constraint phone_pairings_send_reservation_count_check check (
    send_reservation_count is null or send_reservation_count between 1 and 3
  ),
  constraint phone_pairings_send_reservation_state_check check (
    (
      send_reservation_id is null
      and send_reservation_count is null
      and send_reservation_started_at is null
      and pending_otp_digest is null
      and pending_supabase_hashed_token is null
    ) or (
      send_reservation_id is not null
      and send_reservation_count is not null
      and send_reservation_started_at is not null
      and (pending_otp_digest is null) = (pending_supabase_hashed_token is null)
    )
  ),
  constraint phone_pairings_attempt_count_check check (verify_attempt_count between 0 and 5),
  constraint phone_pairings_claim_state_check check (
    claimed_at is null or challenge_expires_at is not null
  ),
  constraint phone_pairings_verified_state_check check (
    otp_verified_at is null or (claimed_at is not null and completion_expires_at is not null)
  ),
  constraint phone_pairings_completed_state_check check (
    (
      completed_at is null
      and completed_session_id is null
      and completed_device_token_hash is null
    ) or (
      completed_at is not null
      and otp_verified_at is not null
      and completed_session_id is not null
      and completed_device_token_hash is not null
    )
  )
);

create index if not exists phone_pairings_account_created_idx
  on public.phone_pairings (account_id, created_at desc);
create index if not exists phone_pairings_pair_expires_idx
  on public.phone_pairings (pair_expires_at);
create index if not exists phone_pairings_challenge_expires_idx
  on public.phone_pairings (challenge_expires_at)
  where challenge_expires_at is not null;
create index if not exists phone_pairings_completion_expires_idx
  on public.phone_pairings (completion_expires_at)
  where completion_expires_at is not null;

alter table public.phone_pairings enable row level security;
revoke all on public.phone_pairings from public, anon, authenticated;
grant select, insert, update, delete on public.phone_pairings to service_role;

drop policy if exists phone_pairings_deny_all_browser on public.phone_pairings;
create policy phone_pairings_deny_all_browser on public.phone_pairings
  for all to anon, authenticated
  using (false) with check (false);

comment on table public.phone_pairings is
  'Service-role-only state machine for 60-second desktop QR -> email OTP -> phone session/device trust handoff. Stores only hashes/HMACs of browser capabilities and codes.';

-- Bound table growth without retaining browser/device diagnostics forever.
-- Pairing creation calls this best-effort for its own account. Keeping the
-- scope per-account and the batch at 100 makes the request cost predictable;
-- the daily retention purge is the global backstop for accounts that never
-- create another QR. Rows remain available for at least 24 hours after their
-- latest terminal or expiry timestamp for short-lived audit/debugging.
create or replace function public.staxis_cleanup_phone_pairings(
  p_account_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted integer;
begin
  with stale as (
    select p.id
      from public.phone_pairings as p
     where p.account_id = p_account_id
       and greatest(
         coalesce(p.completed_at, '-infinity'::timestamptz),
         coalesce(p.revoked_at, '-infinity'::timestamptz),
         coalesce(p.completion_expires_at, '-infinity'::timestamptz),
         coalesce(p.challenge_expires_at, '-infinity'::timestamptz),
         p.pair_expires_at
       ) < now() - interval '24 hours'
     order by p.created_at
     limit 100
     for update skip locked
  )
  delete from public.phone_pairings as p
   using stale
   where p.id = stale.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Consume a QR capability exactly once and reserve generation 1 of the email
-- challenge. An exact retry may recover that same deterministic challenge
-- during the original 60-second claim window, but is marked as a replay so it
-- never sends a second OTP. A different challenge or an expired claim fails.
create or replace function public.staxis_claim_phone_pairing(
  p_pairing_token_hash text,
  p_challenge_token_hash text,
  p_phone_user_agent text default null,
  p_phone_ip text default null
)
returns table (
  pairing_id uuid,
  account_id uuid,
  auth_user_id uuid,
  challenge_expires_at timestamptz,
  send_count smallint,
  send_reservation_id uuid,
  newly_claimed boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_pairing public.phone_pairings%rowtype;
begin
  select p.*
    into v_pairing
    from public.phone_pairings as p
   where p.pairing_token_hash = p_pairing_token_hash
   for update;

  if not found
     or v_pairing.completed_at is not null
     or v_pairing.revoked_at is not null then
    return;
  end if;

  if v_pairing.claimed_at is null then
    if v_pairing.pair_expires_at <= now() then
      return;
    end if;

    update public.phone_pairings as p
       set challenge_token_hash = p_challenge_token_hash,
           challenge_expires_at = now() + interval '60 seconds',
           claimed_at = now(),
           send_reservation_id = gen_random_uuid(),
           send_reservation_count = 1,
           send_reservation_started_at = now(),
           phone_user_agent = left(p_phone_user_agent, 1000),
           phone_ip = left(p_phone_ip, 128)
     where p.id = v_pairing.id
     returning p.* into v_pairing;

    return query
      select v_pairing.id, v_pairing.account_id, v_pairing.auth_user_id,
             v_pairing.challenge_expires_at,
             v_pairing.send_reservation_count,
             v_pairing.send_reservation_id,
             true;
    return;
  end if;

  if v_pairing.challenge_token_hash = p_challenge_token_hash
     and v_pairing.claimed_at + interval '60 seconds' > now()
     and v_pairing.challenge_expires_at > now()
     and v_pairing.otp_verified_at is null then
    return query
      select v_pairing.id, v_pairing.account_id, v_pairing.auth_user_id,
             v_pairing.challenge_expires_at,
             coalesce(v_pairing.send_reservation_count, v_pairing.send_count),
             v_pairing.send_reservation_id,
             false;
  end if;
end;
$$;

-- Reserve a resend before generating a new Supabase link. Accepted send_count
-- is not advanced and the active OTP is not replaced until Resend accepts the
-- email and finalize succeeds. Failures cancel the reservation; a crashed
-- worker's reservation can be replaced after 30 seconds.
create or replace function public.staxis_reserve_phone_pairing_resend(
  p_challenge_token_hash text
)
returns table (
  pairing_id uuid,
  account_id uuid,
  auth_user_id uuid,
  challenge_expires_at timestamptz,
  send_count smallint,
  send_reservation_id uuid
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.phone_pairings as p
     set send_reservation_id = gen_random_uuid(),
         send_reservation_count = (p.send_count + 1)::smallint,
         send_reservation_started_at = now(),
         pending_otp_digest = null,
         pending_supabase_hashed_token = null
   where p.challenge_token_hash = p_challenge_token_hash
     and p.challenge_expires_at > now()
     and p.otp_verified_at is null
     and p.completed_at is null
     and p.revoked_at is null
     and p.send_count < 3
     and p.verify_attempt_count < 5
     and (
       p.last_send_started_at is null
       or p.last_send_started_at <= now() - interval '10 seconds'
     )
     and (
       p.send_reservation_id is null
       or p.send_reservation_started_at <= now() - interval '30 seconds'
     )
  returning p.id, p.account_id, p.auth_user_id,
            p.challenge_expires_at, p.send_reservation_count,
            p.send_reservation_id;
$$;

-- Store one generated OTP only if its reservation is still the current
-- generation. Returns false if the challenge expired or a later resend won.
create or replace function public.staxis_store_phone_pairing_otp(
  p_pairing_id uuid,
  p_challenge_token_hash text,
  p_send_count smallint,
  p_send_reservation_id uuid,
  p_otp_digest text,
  p_supabase_hashed_token text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rows integer;
begin
  update public.phone_pairings as p
     set pending_otp_digest = p_otp_digest,
         pending_supabase_hashed_token = p_supabase_hashed_token
   where p.id = p_pairing_id
     and p.challenge_token_hash = p_challenge_token_hash
     and p.send_reservation_id = p_send_reservation_id
     and p.send_reservation_count = p_send_count
     and p.send_reservation_started_at > now() - interval '30 seconds'
     and p.otp_verified_at is null
     and p.completed_at is null
     and p.revoked_at is null;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Commit a prepared OTP only after Resend accepted the message. This is the
-- point that consumes one of the three sends and replaces the previous active
-- OTP. Returning null means the reservation was stale/cancelled/verified.
create or replace function public.staxis_finalize_phone_pairing_send(
  p_pairing_id uuid,
  p_challenge_token_hash text,
  p_send_count smallint,
  p_send_reservation_id uuid
)
returns timestamptz
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.phone_pairings as p
     set send_count = p.send_reservation_count,
         challenge_expires_at = now() + interval '60 seconds',
         otp_digest = p.pending_otp_digest,
         supabase_hashed_token = p.pending_supabase_hashed_token,
         otp_sent_at = now(),
         otp_expires_at = now() + interval '60 seconds',
         last_send_started_at = now(),
         send_reservation_id = null,
         send_reservation_count = null,
         send_reservation_started_at = null,
         pending_otp_digest = null,
         pending_supabase_hashed_token = null
   where p.id = p_pairing_id
     and p.challenge_token_hash = p_challenge_token_hash
     and p.send_reservation_id = p_send_reservation_id
     and p.send_reservation_count = p_send_count
     and p.send_reservation_started_at > now() - interval '30 seconds'
     and p.pending_otp_digest is not null
     and p.pending_supabase_hashed_token is not null
     and p.otp_verified_at is null
     and p.completed_at is null
     and p.revoked_at is null
  returning p.challenge_expires_at;
$$;

-- Compensate any pre-delivery/generation/provider failure. The accepted send
-- count, active OTP, and challenge expiry are untouched, so retries do not
-- burn a slot or invalidate the prior delivered code.
create or replace function public.staxis_cancel_phone_pairing_send(
  p_pairing_id uuid,
  p_challenge_token_hash text,
  p_send_count smallint,
  p_send_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rows integer;
begin
  update public.phone_pairings as p
     set send_reservation_id = null,
         send_reservation_count = null,
         send_reservation_started_at = null,
         pending_otp_digest = null,
         pending_supabase_hashed_token = null
   where p.id = p_pairing_id
     and p.challenge_token_hash = p_challenge_token_hash
     and p.send_reservation_id = p_send_reservation_id
     and p.send_reservation_count = p_send_count
     and p.otp_verified_at is null
     and p.completed_at is null;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Count failed verification attempts under a row lock. Five failures make the
-- row inert. Success creates one deterministic 60-second completion grant but
-- retains the verified proof until completion: an exact replay can recover the
-- same Supabase token/grant after a lost HTTP response without extending TTL.
create or replace function public.staxis_verify_phone_pairing(
  p_challenge_token_hash text,
  p_otp_digest text,
  p_completion_token_hash text
)
returns table (
  verified boolean,
  pairing_id uuid,
  auth_user_id uuid,
  supabase_hashed_token text,
  completion_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_pairing public.phone_pairings%rowtype;
  v_completion_expires_at timestamptz;
  v_supabase_hashed_token text;
begin
  select p.*
    into v_pairing
    from public.phone_pairings as p
   where p.challenge_token_hash = p_challenge_token_hash
   for update;

  if not found
     or v_pairing.completed_at is not null
     or v_pairing.revoked_at is not null then
    return query select false, null::uuid, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  -- Retry-safe success path. The caller derives the same completion token
  -- from the raw challenge + code, so both stored digests must match. Keep the
  -- original completion expiry; retries never lengthen the grant.
  if v_pairing.otp_verified_at is not null then
    if v_pairing.completion_expires_at <= now()
       or v_pairing.verify_attempt_count >= 5 then
      return query select false, null::uuid, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    if v_pairing.otp_digest = p_otp_digest
       and v_pairing.completion_token_hash = p_completion_token_hash
       and v_pairing.supabase_hashed_token is not null then
      return query
        select true, v_pairing.id, v_pairing.auth_user_id,
               v_pairing.supabase_hashed_token,
               v_pairing.completion_expires_at;
      return;
    end if;

    update public.phone_pairings as p
       set verify_attempt_count = (p.verify_attempt_count + 1)::smallint
     where p.id = v_pairing.id;

    return query select false, null::uuid, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if v_pairing.challenge_expires_at <= now()
     or v_pairing.verify_attempt_count >= 5 then
    return query select false, null::uuid, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if v_pairing.otp_digest is null
     or v_pairing.supabase_hashed_token is null
     or v_pairing.otp_expires_at is null
     or v_pairing.otp_expires_at <= now()
     or v_pairing.otp_digest <> p_otp_digest then
    update public.phone_pairings as p
       set verify_attempt_count = (p.verify_attempt_count + 1)::smallint
     where p.id = v_pairing.id;

    return query select false, null::uuid, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  v_completion_expires_at := now() + interval '60 seconds';
  v_supabase_hashed_token := v_pairing.supabase_hashed_token;

  update public.phone_pairings as p
     set pairing_token_hash = null,
         completion_token_hash = p_completion_token_hash,
         completion_expires_at = v_completion_expires_at,
         otp_verified_at = now(),
         send_reservation_id = null,
         send_reservation_count = null,
         send_reservation_started_at = null,
         pending_otp_digest = null,
         pending_supabase_hashed_token = null
   where p.id = v_pairing.id;

  return query
    select true, v_pairing.id, v_pairing.auth_user_id,
           v_supabase_hashed_token, v_completion_expires_at;
end;
$$;

-- Complete the handoff in one transaction. The completion grant is bound to
-- both the auth user and the exact auth.sessions row represented by the bearer
-- JWT. If any insert/update fails, the grant remains unconsumed and no partial
-- trusted-device state commits. A repeat for that exact session and derived
-- device token is an idempotent success while the original grant is live; it
-- never inserts again or revives revoked trust.
create or replace function public.staxis_complete_phone_pairing(
  p_completion_token_hash text,
  p_user_id uuid,
  p_session_id uuid,
  p_device_token_hash text,
  p_device_expires_at timestamptz,
  p_user_agent text default null,
  p_ip text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_pairing public.phone_pairings%rowtype;
begin
  select p.*
    into v_pairing
    from public.phone_pairings as p
   where p.completion_token_hash = p_completion_token_hash
   for update;

  if not found
     or v_pairing.completion_expires_at <= now()
     or v_pairing.revoked_at is not null
     or v_pairing.auth_user_id <> p_user_id then
    return null;
  end if;

  if not exists (
    select 1
      from auth.sessions as s
     where s.id = p_session_id
       and s.user_id = p_user_id
  ) then
    return null;
  end if;

  if not exists (
    select 1
      from public.accounts as a
     where a.id = v_pairing.account_id
       and a.data_user_id = p_user_id
  ) then
    return null;
  end if;

  if v_pairing.completed_at is not null then
    if v_pairing.completed_session_id <> p_session_id
       or v_pairing.completed_device_token_hash <> p_device_token_hash
       or not exists (
         select 1
           from public.trusted_devices as d
          where d.account_id = v_pairing.account_id
            and d.token_hash = p_device_token_hash
            and d.expires_at > now()
       )
       or not exists (
         select 1
           from public.mfa_verified_sessions as m
          where m.session_id = p_session_id
            and m.user_id = p_user_id
       ) then
      return null;
    end if;

    return v_pairing.id;
  end if;

  -- A session id can only belong to one auth user. Refuse inconsistent legacy
  -- data instead of overwriting it in the ON CONFLICT branch below.
  if exists (
    select 1
      from public.mfa_verified_sessions as m
     where m.session_id = p_session_id
       and m.user_id <> p_user_id
  ) then
    return null;
  end if;

  insert into public.trusted_devices (
    account_id, token_hash, user_agent, ip, expires_at
  ) values (
    v_pairing.account_id,
    p_device_token_hash,
    left(p_user_agent, 1000),
    left(p_ip, 128),
    p_device_expires_at
  );

  insert into public.mfa_verified_sessions (
    session_id, user_id, verified_at, verified_from_ip, verified_from_ua
  ) values (
    p_session_id,
    p_user_id,
    now(),
    left(p_ip, 128),
    left(p_user_agent, 1000)
  )
  on conflict (session_id) do update
    set verified_at = excluded.verified_at,
        verified_from_ip = excluded.verified_from_ip,
        verified_from_ua = excluded.verified_from_ua;

  update public.phone_pairings as p
     set challenge_token_hash = null,
         otp_digest = null,
         supabase_hashed_token = null,
         send_reservation_id = null,
         send_reservation_count = null,
         send_reservation_started_at = null,
         pending_otp_digest = null,
         pending_supabase_hashed_token = null,
         completed_at = now(),
         completed_session_id = p_session_id,
         completed_device_token_hash = p_device_token_hash
   where p.id = v_pairing.id;

  return v_pairing.id;
end;
$$;

revoke all on function public.staxis_claim_phone_pairing(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.staxis_cleanup_phone_pairings(uuid)
  from public, anon, authenticated;
revoke all on function public.staxis_cancel_phone_pairing_send(uuid, text, smallint, uuid)
  from public, anon, authenticated;
revoke all on function public.staxis_finalize_phone_pairing_send(uuid, text, smallint, uuid)
  from public, anon, authenticated;
revoke all on function public.staxis_reserve_phone_pairing_resend(text)
  from public, anon, authenticated;
revoke all on function public.staxis_store_phone_pairing_otp(uuid, text, smallint, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.staxis_verify_phone_pairing(text, text, text)
  from public, anon, authenticated;
revoke all on function public.staxis_complete_phone_pairing(text, uuid, uuid, text, timestamptz, text, text)
  from public, anon, authenticated;

grant execute on function public.staxis_claim_phone_pairing(text, text, text, text)
  to service_role;
grant execute on function public.staxis_cleanup_phone_pairings(uuid)
  to service_role;
grant execute on function public.staxis_cancel_phone_pairing_send(uuid, text, smallint, uuid)
  to service_role;
grant execute on function public.staxis_finalize_phone_pairing_send(uuid, text, smallint, uuid)
  to service_role;
grant execute on function public.staxis_reserve_phone_pairing_resend(text)
  to service_role;
grant execute on function public.staxis_store_phone_pairing_otp(uuid, text, smallint, uuid, text, text)
  to service_role;
grant execute on function public.staxis_verify_phone_pairing(text, text, text)
  to service_role;
grant execute on function public.staxis_complete_phone_pairing(text, uuid, uuid, text, timestamptz, text, text)
  to service_role;

insert into public.applied_migrations (version, description)
values (
  '0309',
  'QR phone pairing: service-role-only hashed capability state machine, atomic claim/verify/complete RPCs, bounded 24-hour retention cleanup, and removal of the incompatible api_limits property FK so hashed IP/email/account scopes enforce correctly.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
