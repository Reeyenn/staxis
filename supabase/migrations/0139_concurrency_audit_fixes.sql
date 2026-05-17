-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0139: Concurrency audit fixes (RPCs + dedup tables + shift_starts)
--
-- Resolves the DB-side of the 17 findings recorded in
-- .claude/reports/concurrency-audit.md (May 2026). Each section maps to a
-- finding number from that report.
--
--   A. staxis_remove_property_access / staxis_grant_property_access   (#1)
--   B. schedule_assignments.shift_starts + staxis_get_or_set_shift_start (#2)
--   C. staxis_release_join_code_slot                                  (#3)
--   D. staxis_apply_shift_assignments                                 (#4)
--   E. staxis_record_ml_failure                                       (#5)
--   F. processed_twilio_webhooks                                      (#7)
--   G. processed_sentry_webhooks                                     (#17)
--
-- Findings #6 (Resend Idempotency-Key), #8 (CUA retry uncap), #9 (SMS
-- watchdog 300→120), #10-#16 are pure code changes — no DB surface here.
--
-- The new functions all follow the project convention:
--   language plpgsql security definer
--   set search_path = pg_catalog, public
--   revoke from public, anon, authenticated; grant to service_role.
-- ═══════════════════════════════════════════════════════════════════════════


-- ─── A. Property-access atomic mutations (fix #1) ────────────────────────
-- The team route used to do SELECT → array_filter → UPDATE in three round
-- trips. Two concurrent removals from different hotels on the same account
-- raced on the final UPDATE and could re-grant a hotel the other removal
-- just stripped. These two RPCs collapse the read-modify-write to a single
-- atomic SQL statement so concurrent calls cannot regress each other.
--
-- Return value: the resulting property_access length, or -1 if the account
-- row does not exist (lets the caller distinguish 404 from "already".)

create or replace function public.staxis_remove_property_access(
  p_account_id uuid,
  p_hotel_id   uuid
)
returns int
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_len int;
begin
  update public.accounts
     set property_access = array_remove(property_access, p_hotel_id),
         updated_at = now()
   where id = p_account_id
   returning coalesce(array_length(property_access, 1), 0) into v_len;
  if not found then return -1; end if;
  return v_len;
end;
$$;

create or replace function public.staxis_grant_property_access(
  p_account_id uuid,
  p_hotel_id   uuid
)
returns int
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_len int;
begin
  update public.accounts
     set property_access = case
           when p_hotel_id = any(coalesce(property_access, '{}'::uuid[]))
             then property_access
           else array_append(coalesce(property_access, '{}'::uuid[]), p_hotel_id)
         end,
         updated_at = now()
   where id = p_account_id
   returning coalesce(array_length(property_access, 1), 0) into v_len;
  if not found then return -1; end if;
  return v_len;
end;
$$;

revoke all on function public.staxis_remove_property_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.staxis_remove_property_access(uuid, uuid) to service_role;
revoke all on function public.staxis_grant_property_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.staxis_grant_property_access(uuid, uuid) to service_role;


-- ─── B. Shift-start server source-of-truth (fix #2) ──────────────────────
-- The housekeeper page used to keep shift_start in localStorage, so a
-- housekeeper switching devices mid-shift would end up with a different
-- anchor for cleaning-event durations. Move the anchor to the existing
-- schedule_assignments row (PK: property_id, date) — extend it with a
-- jsonb map keyed by staff_id. The RPC is get-or-set: it returns the
-- already-recorded shift_start if one exists, or atomically stores and
-- returns p_default_at if not. The "first writer wins" semantic mirrors
-- how a manager would think about a shift — once the housekeeper has
-- punched in (on any device), that's the anchor.

alter table public.schedule_assignments
  add column if not exists shift_starts jsonb not null default '{}'::jsonb;

comment on column public.schedule_assignments.shift_starts is
  'Map of staff_id (uuid as text) → ISO 8601 shift-start timestamptz. Set once per (property, date, staff) by the first cleaning event of the shift; immutable thereafter so device changes do not move the anchor.';

create or replace function public.staxis_get_or_set_shift_start(
  p_property   uuid,
  p_date       date,
  p_staff      uuid,
  p_default_at timestamptz
)
returns timestamptz
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_at timestamptz;
begin
  insert into public.schedule_assignments (property_id, date, shift_starts)
  values (p_property, p_date, jsonb_build_object(p_staff::text, p_default_at))
  on conflict (property_id, date) do update
     set shift_starts = case
           when public.schedule_assignments.shift_starts ? p_staff::text
             then public.schedule_assignments.shift_starts
           else public.schedule_assignments.shift_starts
                  || jsonb_build_object(p_staff::text, p_default_at)
         end,
         updated_at = now()
   returning (shift_starts ->> p_staff::text)::timestamptz into v_at;
  return v_at;
end;
$$;

revoke all on function public.staxis_get_or_set_shift_start(uuid, date, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.staxis_get_or_set_shift_start(uuid, date, uuid, timestamptz) to service_role;


-- ─── C. Join-code slot release (fix #3) ──────────────────────────────────
-- Old releaseSlot() in use-join-code/route.ts predicated its decrement on
-- the value we'd just CAS-incremented from, so a concurrent successful
-- signup that incremented the counter again would silently no-op the
-- decrement and leak a slot forever. Unconditional decrement (floored at
-- zero) is correct: the top-of-route CAS already prevents over-grant, so
-- releasing on failure just needs to atomically undo one slot.

create or replace function public.staxis_release_join_code_slot(
  p_id uuid
)
returns int
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_count int;
begin
  update public.hotel_join_codes
     set used_count = greatest(used_count - 1, 0)
   where id = p_id
   returning used_count into v_count;
  if not found then return -1; end if;
  return v_count;
end;
$$;

revoke all on function public.staxis_release_join_code_slot(uuid) from public, anon, authenticated;
grant execute on function public.staxis_release_join_code_slot(uuid) to service_role;


-- ─── D. Atomic shift-assignment apply (fix #4) ───────────────────────────
-- /api/send-shift-confirmations used to fire up to ~15 per-room UPDATEs
-- via Promise.all with no transaction boundary. One failure left the
-- rooms table in a partially-updated state. This RPC does the whole
-- assignment apply (upsert new + clear stale) inside a single transaction
-- so it's all-or-nothing.
--
-- p_assignments shape: jsonb array of
--   { number: text, staff_id: uuid|null, staff_name: text|null,
--     type: 'checkout'|'stayover', priority: text }
-- A null staff_id (or staff_name) is treated as "clear this room's
-- assignment for the day".

create or replace function public.staxis_apply_shift_assignments(
  p_property    uuid,
  p_date        date,
  p_assignments jsonb
)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  -- Upsert: create rooms that don't exist yet, update assigned_to/_name
  -- on rooms that already exist. The rooms unique constraint is
  -- (property_id, date, number).
  insert into public.rooms (
    property_id, date, number, type, status, priority,
    assigned_to, assigned_name
  )
  select
    p_property,
    p_date,
    a->>'number',
    coalesce(a->>'type', 'checkout'),
    'dirty',
    coalesce(a->>'priority', 'standard'),
    nullif(a->>'staff_id', '')::uuid,
    nullif(a->>'staff_name', '')
  from jsonb_array_elements(p_assignments) a
  where (a->>'number') is not null
  on conflict (property_id, date, number) do update
    set assigned_to   = excluded.assigned_to,
        assigned_name = excluded.assigned_name,
        updated_at    = now();

  -- Clear any existing assignment for rooms NOT mentioned in this call
  -- (the "drop-from-shift" path the route handles after the Promise.all
  -- block).
  update public.rooms r
     set assigned_to   = null,
         assigned_name = null,
         updated_at    = now()
   where r.property_id = p_property
     and r.date         = p_date
     and r.assigned_to is not null
     and not exists (
       select 1 from jsonb_array_elements(p_assignments) a
        where a->>'number' = r.number
     );
end;
$$;

revoke all on function public.staxis_apply_shift_assignments(uuid, date, jsonb) from public, anon, authenticated;
grant execute on function public.staxis_apply_shift_assignments(uuid, date, jsonb) to service_role;


-- ─── E. ML failure counter atomic record (fix #5) ────────────────────────
-- src/lib/ml-failure-counters.ts used to do SELECT data → push onto
-- recent[] in JS → UPSERT. Two concurrent ML failures on the same property
-- would both read the same starting array and the later write would
-- overwrite the earlier, hiding failures from the doctor's 24h alert
-- window. Move the whole thing to an atomic UPSERT + a separate trim
-- statement (separate because Postgres does not let us slice a jsonb
-- array inside an INSERT ... ON CONFLICT expression cleanly).

create or replace function public.staxis_record_ml_failure(
  p_pid  uuid,
  p_kind text,
  p_err  text
)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_key   text  := 'ml_failures:' || p_kind;
  v_entry jsonb := jsonb_build_object(
    'at',  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'pid', p_pid,
    'err', left(coalesce(p_err, ''), 200)
  );
begin
  -- Atomic upsert: append-prepend to recent[], increment total.
  insert into public.scraper_status (key, data, updated_at)
  values (
    v_key,
    jsonb_build_object(
      'recent', jsonb_build_array(v_entry),
      'total',  1
    ),
    now()
  )
  on conflict (key) do update
    set data = jsonb_build_object(
          'recent', jsonb_build_array(v_entry)
                      || coalesce(scraper_status.data->'recent', '[]'::jsonb),
          'total',  coalesce((scraper_status.data->>'total')::int, 0) + 1
        ),
        updated_at = now();

  -- Trim recent[] to the most recent 100 entries (separate statement
  -- because slicing inside the ON CONFLICT expression is fiddly).
  update public.scraper_status s
     set data = jsonb_set(
       s.data,
       '{recent}',
       (
         select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
           from jsonb_array_elements(s.data->'recent')
                with ordinality as t(elem, ord)
          where ord <= 100
       )
     )
   where s.key = v_key
     and jsonb_array_length(s.data->'recent') > 100;
end;
$$;

revoke all on function public.staxis_record_ml_failure(uuid, text, text) from public, anon, authenticated;
grant execute on function public.staxis_record_ml_failure(uuid, text, text) to service_role;


-- ─── F. Twilio webhook dedup table (fix #7) ──────────────────────────────
-- Mirrors the stripe_processed_events pattern from migration 0035 — PK on
-- the Twilio MessageSid, RLS deny-all, service-role only. Used by
-- /api/sms-reply and any future Twilio status-callback routes to ack
-- duplicate webhook deliveries with a 200 without re-sending the response.

create table if not exists public.processed_twilio_webhooks (
  message_sid  text primary key,
  webhook_kind text not null,
  property_id  uuid references public.properties(id) on delete set null,
  processed_at timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb
);

create index if not exists processed_twilio_webhooks_recent_idx
  on public.processed_twilio_webhooks (processed_at desc);

create index if not exists processed_twilio_webhooks_property_idx
  on public.processed_twilio_webhooks (property_id, processed_at desc)
  where property_id is not null;

alter table public.processed_twilio_webhooks enable row level security;

drop policy if exists processed_twilio_webhooks_deny_browser on public.processed_twilio_webhooks;
create policy processed_twilio_webhooks_deny_browser on public.processed_twilio_webhooks
  for all to anon, authenticated using (false) with check (false);

comment on table public.processed_twilio_webhooks is
  'Dedup table for Twilio webhook deliveries (inbound SMS + status callbacks). Insert first; if conflict (code 23505), this delivery was already processed and we 200 + skip. Service-role only.';


-- ─── G. Sentry webhook dedup table (fix #17) ─────────────────────────────
-- Same shape as F. PK is a synthesised event id (the handler hashes
-- payload.data.issue.id + payload.action, falling back to a hash of the
-- full payload if either is missing).

create table if not exists public.processed_sentry_webhooks (
  event_id     text primary key,
  webhook_kind text not null,
  processed_at timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb
);

create index if not exists processed_sentry_webhooks_recent_idx
  on public.processed_sentry_webhooks (processed_at desc);

alter table public.processed_sentry_webhooks enable row level security;

drop policy if exists processed_sentry_webhooks_deny_browser on public.processed_sentry_webhooks;
create policy processed_sentry_webhooks_deny_browser on public.processed_sentry_webhooks
  for all to anon, authenticated using (false) with check (false);

comment on table public.processed_sentry_webhooks is
  'Dedup table for Sentry webhook deliveries. Event id is synthesised from payload.data.issue.id + payload.action; the handler 200s on conflict so Sentry stops retrying. Service-role only.';


-- ─── Track migration ─────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0139',
  'concurrency audit fixes: property-access RPCs, shift_starts, join-code release, atomic shift-assignment, ml-failure record, twilio/sentry webhook dedup'
)
on conflict (version) do nothing;
