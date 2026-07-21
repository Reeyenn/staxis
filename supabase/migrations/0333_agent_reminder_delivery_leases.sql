-- 0333: Crash-safe delivery leases for agent reminders.
--
-- The original reminder worker stamped fired_at before posting to Comms. A
-- serverless termination between those operations made the reminder look
-- complete forever. Keep fired_at as the terminal marker and add a short,
-- reclaimable lease for in-flight delivery. The message metadata key makes
-- the external side effect idempotent when a stale lease is retried after the
-- message insert succeeded but before the reminder was finalized.

begin;

alter table public.agent_reminders
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_token uuid;

create index if not exists agent_reminders_claimed_idx
  on public.agent_reminders (claimed_at)
  where fired_at is null and canceled_at is null and claim_token is not null;

create unique index if not exists comms_messages_agent_reminder_uq
  on public.comms_messages ((meta ->> 'agent_reminder_id'))
  where meta ? 'agent_reminder_id';

comment on column public.agent_reminders.claimed_at is
  'Start of the current delivery lease. A stale lease may be atomically reclaimed by process-agent-schedules.';

comment on column public.agent_reminders.claim_token is
  'Opaque owner of the current delivery lease; finalize/release operations must match it.';

comment on index public.comms_messages_agent_reminder_uq is
  'Exactly one Communications message per agent reminder, allowing safe stale-lease retry after a process crash.';

insert into public.applied_migrations (version, description)
values (
  '0333',
  'Add reclaimable agent-reminder delivery leases and a unique Comms message idempotency key'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
