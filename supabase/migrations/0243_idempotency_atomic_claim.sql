-- ═══════════════════════════════════════════════════════════════════════════
-- 0243 — Atomic idempotency claim (close the double-send race)
--
-- The old flow was check-then-act: checkIdempotency SELECTed (no row → "first"),
-- the route did the work, then recordIdempotency INSERTed. Two concurrent
-- retries of the SAME key both read "no row" → both ran the work → double SMS /
-- double charge. The PK on `key` only stopped the duplicate ROW, not the
-- duplicate WORK.
--
-- This RPC makes the claim atomic. One caller wins the INSERT (or takes over an
-- EXPIRED row); concurrent callers get claimed=false plus the current state, so
-- the helper can return the cached response (work already done) or a 409
-- (work in progress). The winning caller writes a short-lived "pending" marker;
-- recordIdempotency replaces it with the real response + the full 24h TTL. A
-- crashed first-attempt therefore frees the key after 5 min, not 24h.
--
-- SECURITY DEFINER + fixed search_path (required by audit-security-definer-
-- search-path); execute revoked from anon/authenticated — called only via
-- supabaseAdmin (service-role) from server code.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.claim_idempotency_key(
  p_key   text,
  p_route text,
  p_pid   uuid default null
)
returns table (claimed boolean, existing_response jsonb, existing_status integer, existing_route text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  -- Claim by inserting a short-lived pending row, OR by taking over a row that
  -- has already expired. A still-fresh conflicting row is left untouched.
  insert into public.idempotency_log (key, route, response, status_code, property_id, created_at, expires_at)
  values (p_key, p_route, '{"__pending__":true}'::jsonb, 0, p_pid, v_now, v_now + interval '5 minutes')
  on conflict (key) do update
    set route       = excluded.route,
        response    = excluded.response,
        status_code = excluded.status_code,
        property_id = excluded.property_id,
        created_at  = v_now,
        expires_at  = excluded.expires_at
    where public.idempotency_log.expires_at < v_now;

  if found then
    -- We inserted, or took over an expired row → this caller owns the claim.
    return query select true, null::jsonb, null::integer, null::text;
    return;
  end if;

  -- Conflict on a still-fresh row → someone else holds it. Hand back its state
  -- so the helper can decide cached (real response) vs in-progress (__pending__).
  return query
    select false, il.response, il.status_code, il.route
    from public.idempotency_log il
    where il.key = p_key;
end;
$$;

revoke all on function public.claim_idempotency_key(text, text, uuid) from anon, authenticated;

comment on function public.claim_idempotency_key(text, text, uuid) is
  'Atomic idempotency claim. Returns claimed=true if this caller won the key (fresh insert or takeover of an expired row), else claimed=false plus the holder''s current response/status/route. Pending claims live 5 min; recordIdempotency extends to 24h on success.';

insert into public.applied_migrations (version, description)
values ('0243', 'Atomic idempotency claim RPC (close double-send race)')
on conflict (version) do nothing;
