-- ═══════════════════════════════════════════════════════════════════════════
-- 0020 — SMS jobs queue
--
-- Backs an at-least-once durable queue for outbound SMS. Producers (route
-- handlers) call `enqueueSms` to add a row; a cron-driven worker pops a
-- batch every minute via `claimSmsJobs` (atomic SELECT…FOR UPDATE SKIP
-- LOCKED), calls Twilio, and updates the row to 'sent' or back to
-- 'queued' with a backoff. After max_attempts the row goes to 'dead'.
--
-- Why a queue at all:
--   - Today every SMS-firing route does `await sendSms` inside the HTTP
--     request. 100 staff x 1.5s/Twilio call = 2.5min wall time, well past
--     Vercel's 30s function cap. A queue decouples send from request.
--   - Twilio hiccups should retry that one row, not the whole batch.
--   - Mario should see "27 of 30 sent, 3 retrying" instead of "Sent" or
--     "Error" — the queue gives us per-message status to render.
--
-- Idempotency: the (property_id, idempotency_key) UNIQUE constraint dedupes
-- enqueues within the 24h window. Same Mario double-click → same key →
-- second insert noops.
--
-- Privacy / RLS: deny-all to anon and authenticated. The queue lives in
-- service-role land. UI reads of "queued vs sent" should go through a
-- read endpoint that filters to the calling user's properties.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.sms_jobs (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,

  -- payload
  to_phone        text not null,
  body            text not null,

  -- lifecycle
  status          text not null default 'queued'
    check (status in ('queued','sending','sent','failed','dead')),
  attempts        integer not null default 0,
  max_attempts    integer not null default 3,

  -- when this row becomes eligible for processing (used for backoff)
  next_attempt_at timestamptz not null default now(),
  -- when we transitioned to 'sending' (used to detect dead workers)
  started_at      timestamptz,
  -- when Twilio confirmed send
  sent_at         timestamptz,

  -- Twilio result + last error
  twilio_sid      text,
  error_code      text,
  error_message   text,

  -- caller-supplied dedup key. Collision within (property_id,key) is a
  -- duplicate enqueue — the unique constraint below short-circuits it.
  idempotency_key text not null,

  -- audit + UI hooks
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Optional metadata blob; UI uses this for "for staff X, shift Y" labels.
  metadata        jsonb       not null default '{}'::jsonb,

  unique (property_id, idempotency_key)
);

comment on table public.sms_jobs is
  'Durable at-least-once queue for outbound SMS. Producers enqueue, cron worker drains.';
comment on column public.sms_jobs.status is
  '''queued'' = waiting to send. ''sending'' = worker has claimed it. ''sent'' = Twilio accepted. ''failed'' = transient error, will retry. ''dead'' = exhausted retries, give up.';
comment on column public.sms_jobs.next_attempt_at is
  'Earliest moment this row should be re-claimed. After a transient failure the worker bumps this forward by an exponential backoff.';
comment on column public.sms_jobs.idempotency_key is
  'Caller-chosen key. Same (property_id, key) within 24h returns the existing row instead of creating a new one.';

-- Hot path: worker poll. Index on status='queued' AND next_attempt_at
-- ascending so the cron's `select … for update skip locked` is fast.
create index if not exists sms_jobs_claim_idx
  on public.sms_jobs (next_attempt_at)
  where status = 'queued';

-- Investigation path: per-property status pages.
create index if not exists sms_jobs_property_status_idx
  on public.sms_jobs (property_id, status, created_at desc);

-- Watchdog path: detect rows stuck in 'sending' (worker died mid-call).
create index if not exists sms_jobs_sending_idx
  on public.sms_jobs (started_at)
  where status = 'sending';

-- ── RLS — deny-all to anon/authenticated; service-role only ────────────────

alter table public.sms_jobs enable row level security;

revoke all on public.sms_jobs from public, anon, authenticated;
grant select, insert, update on public.sms_jobs to service_role;

drop policy if exists sms_jobs_deny_browser on public.sms_jobs;
create policy sms_jobs_deny_browser on public.sms_jobs
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- ── updated_at trigger ─────────────────────────────────────────────────────

create or replace function public.touch_sms_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sms_jobs_touch_updated_at on public.sms_jobs;
create trigger sms_jobs_touch_updated_at
  before update on public.sms_jobs
  for each row
  execute function public.touch_sms_jobs_updated_at();

-- ── claim_sms_jobs RPC: atomic batch claim ─────────────────────────────────
-- Worker calls this each tick. `for update skip locked` lets two workers
-- run in parallel without claiming the same row. Returns the rows the
-- caller now owns (status flipped to 'sending').

create or replace function public.staxis_claim_sms_jobs(p_limit integer)
returns table (
  id              uuid,
  property_id     uuid,
  to_phone        text,
  body            text,
  attempts        integer,
  max_attempts    integer,
  idempotency_key text,
  metadata        jsonb
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  -- Hard cap on batch size so a single tick can't run away.
  v_limit integer := least(greatest(p_limit, 1), 200);
begin
  return query
  with claimed as (
    select j.id
      from public.sms_jobs j
     where j.status = 'queued'
       and j.next_attempt_at <= now()
     order by j.next_attempt_at
     limit v_limit
     for update skip locked
  )
  update public.sms_jobs s
     set status = 'sending',
         attempts = s.attempts + 1,
         started_at = now()
   where s.id in (select c.id from claimed c)
   returning s.id, s.property_id, s.to_phone, s.body, s.attempts, s.max_attempts, s.idempotency_key, s.metadata;
end;
$$;

revoke all on function public.staxis_claim_sms_jobs(integer) from public, anon, authenticated;

-- ── reset_stuck_sms_jobs RPC: watchdog ─────────────────────────────────────
-- Rows stuck in 'sending' for too long mean a worker died mid-call.
-- Bounce them back to 'queued' so the next tick picks them up.

create or replace function public.staxis_reset_stuck_sms_jobs(p_max_seconds integer default 300)
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_count integer;
begin
  update public.sms_jobs
     set status = 'queued',
         started_at = null
   where status = 'sending'
     and started_at < now() - make_interval(secs => p_max_seconds);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.staxis_reset_stuck_sms_jobs(integer) from public, anon, authenticated;

insert into public.applied_migrations (version, description)
values ('0020', 'SMS jobs queue (durable at-least-once SMS dispatch)')
on conflict (version) do nothing;
