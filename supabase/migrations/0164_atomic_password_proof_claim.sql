-- Phase 2B / Door B follow-up (audit 2026-05-22 Codex finding #3).
--
-- Problem: Phase A's /api/auth/trust-device does:
--   1. SELECT one unused proof for the user
--   2. INSERT into trusted_devices
--   3. UPDATE the proof set used_at=now()
--
-- Two concurrent trust-device requests can both observe the same unused
-- proof in step 1, both succeed in step 2, both run step 3 (second is a
-- no-op). Net result: one proof "consumed" twice → two trusted_devices
-- rows from one password sign-in. Violates the single-use promise.
--
-- Fix: this RPC atomically claims one proof in a single UPDATE statement
-- using FOR UPDATE SKIP LOCKED. Only the request that wins the row lock
-- gets a returning row; the loser sees an empty result and 403s.
--
-- The RPC returns the proof id (so the caller can release it via
-- staxis_release_password_signin_proof if the trusted_devices insert
-- fails downstream).

create or replace function public.staxis_claim_password_signin_proof(
  p_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Claim atomically: only one concurrent caller wins the SKIP LOCKED.
  with claimed as (
    select id
      from public.password_signin_proofs
     where user_id = p_user_id
       and used_at is null
       and expires_at > now()
     order by created_at desc
     limit 1
       for update skip locked
  )
  update public.password_signin_proofs
     set used_at = now()
    from claimed
   where public.password_signin_proofs.id = claimed.id
  returning public.password_signin_proofs.id into v_id;

  return v_id;  -- null if nothing claimed
end;
$$;

-- Service-role-only — never callable from the browser. trust-device runs
-- under service-role via supabaseAdmin.rpc().
grant execute on function public.staxis_claim_password_signin_proof(uuid)
  to service_role, supabase_auth_admin;
revoke execute on function public.staxis_claim_password_signin_proof(uuid)
  from anon, authenticated, public;

comment on function public.staxis_claim_password_signin_proof(uuid) is
  'Atomic single-use claim of a password_signin_proofs row. Returns the '
  'claimed proof id, or NULL if no unused+unexpired proof was available. '
  'Closes a race in trust-device where two concurrent OTP verifications '
  'could both consume the same proof and mint two trusted devices.';

-- Release helper for the case where trust-device's trusted_devices
-- insert fails AFTER claiming the proof. Without this, a transient
-- failure burns the proof and forces the user back to password sign-in.
create or replace function public.staxis_release_password_signin_proof(
  p_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.password_signin_proofs
     set used_at = null
   where id = p_id
     -- Defense: only release if the proof is still unexpired. A long
     -- enough downstream failure shouldn't resurrect an effectively-dead
     -- proof.
     and expires_at > now();
end;
$$;

grant execute on function public.staxis_release_password_signin_proof(uuid)
  to service_role, supabase_auth_admin;
revoke execute on function public.staxis_release_password_signin_proof(uuid)
  from anon, authenticated, public;

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0164',
  'Audit 2026-05-22 follow-up: atomic password_signin_proofs claim RPC (Codex review #3 — race condition fix).'
)
on conflict (version) do nothing;
