-- ═══════════════════════════════════════════════════════════════════════════
-- 0231 — Front-desk ↔ housekeeping coordination scaffolding.
--
-- What this migration adds:
--
--   1. properties.sms_notifications_mode — per-hotel switch between
--      'dry_run' (default) and 'live'. Coordination dispatchSMS() reads
--      this and ALWAYS audits to notification_events; only when 'live'
--      does it call Twilio. Lets a hotel flip the entire coordination
--      surface from "test" to "real texts go out" with one row update,
--      without code or env changes.
--
--   2. notification_events — append-only audit of every coordination
--      event the system would have texted (or did text). One row per
--      recipient per event. Stays useful in BOTH modes:
--        dry_run: the row IS the side-effect (panel renders it).
--        live:   the row is the receipt (provider_id + status from Twilio).
--      Service-role-only RLS — UI reads through
--      /api/front-desk/notification-log mediated by supabaseAdmin.
--
-- No code path on main reads these yet — they exist purely so the
-- feature/front-desk-coordination-and-nav branch can stand up its
-- dispatch layer + log panel.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent (create-if-not-exists + drop-policy-if-exists). Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. properties.sms_notifications_mode
-- ───────────────────────────────────────────────────────────────────────────
alter table public.properties
  add column if not exists sms_notifications_mode text not null default 'dry_run';

-- Drop any pre-existing version of the check (idempotent re-run safety),
-- then assert the {dry_run | live} domain.
alter table public.properties
  drop constraint if exists properties_sms_notifications_mode_check;
alter table public.properties
  add constraint properties_sms_notifications_mode_check
  check (sms_notifications_mode in ('dry_run', 'live'));

comment on column public.properties.sms_notifications_mode is
  '''dry_run'' = coordination SMS dispatch writes notification_events only (no Twilio); ''live'' = also calls Twilio. Default ''dry_run''. Created 0231.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. notification_events
-- ───────────────────────────────────────────────────────────────────────────
-- @rls: service-role-only — UI reads through /api/front-desk/notification-log
-- via supabaseAdmin. Same pattern as pms_*, cleaning_tasks, activity_log.

create table if not exists public.notification_events (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,

  -- Coordination event taxonomy. Keep CHECK aligned with the
  -- DispatchEventType union in src/lib/front-desk-coordination/types.ts.
  event_type            text not null
                        check (event_type in (
                          'room_ready',
                          'vip_arrival',
                          'room_move',
                          'walk_in',
                          'rush'
                        )),

  -- Recipient is denormalized so the audit row stays useful after the
  -- staff row is deleted / phone is updated.
  recipient_staff_id    uuid references public.staff(id) on delete set null,
  recipient_phone       text,
  recipient_name        text,

  body                  text not null,
  payload               jsonb not null default '{}'::jsonb,

  mode                  text not null
                        check (mode in ('dry_run', 'live')),
  would_have_sent_at    timestamptz not null default now(),

  -- Twilio side, populated only in 'live' mode.
  provider_id           text,
  provider_status       text,
  error_text            text,

  created_at            timestamptz not null default now()
);

comment on table public.notification_events is
  'Append-only audit of every coordination SMS the system would have sent (dry_run) or did send (live). Service-role-only. Created 0231.';
comment on column public.notification_events.mode is
  'Mirror of properties.sms_notifications_mode at the moment of dispatch. Snapshotted (not joined) so a later mode flip never rewrites historical rows.';
comment on column public.notification_events.payload is
  'Event-shape jsonb (e.g. { room_number, room_type, completed_by_staff_id }). Free-form per event_type.';
comment on column public.notification_events.would_have_sent_at is
  'When the dispatch decision happened. In live mode this is also when the Twilio call was placed (or attempted).';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Indexes
-- ───────────────────────────────────────────────────────────────────────────

-- Primary read path: notification-log panel pulls latest-N per property.
create index if not exists notification_events_property_time_idx
  on public.notification_events (property_id, would_have_sent_at desc);

-- Per-recipient lookup (e.g. forensic "what did Front-Desk Maria see").
create index if not exists notification_events_recipient_idx
  on public.notification_events (property_id, recipient_staff_id, would_have_sent_at desc)
  where recipient_staff_id is not null;

-- Per-event-type filter (room_ready vs walk_in counts on dashboards).
create index if not exists notification_events_event_type_idx
  on public.notification_events (property_id, event_type, would_have_sent_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. RLS — service-role only
-- ───────────────────────────────────────────────────────────────────────────
alter table public.notification_events enable row level security;
revoke all on public.notification_events from public, anon, authenticated;
grant select, insert, update, delete on public.notification_events to service_role;

drop policy if exists notification_events_deny_all on public.notification_events;
create policy notification_events_deny_all on public.notification_events
  for all to anon, authenticated using (false) with check (false);
comment on policy notification_events_deny_all on public.notification_events is
  'Service-role only. UI reads/writes through /api/front-desk/* via supabaseAdmin. Created 0231.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. PostgREST schema reload — so the new column + table land in the API
-- cache immediately. Without this, the first request after applying the
-- migration 404s on the new column.
-- ───────────────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ───────────────────────────────────────────────────────────────────────────
-- 6. applied_migrations bookkeeping row.
-- ───────────────────────────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0231',
  'Front-desk coordination scaffolding: properties.sms_notifications_mode (dry_run|live, default dry_run) + notification_events table with service-role-only RLS. Audit trail for every coordination SMS (room_ready, vip_arrival, room_move, walk_in, rush). Created for feature/front-desk-coordination-and-nav.'
)
on conflict (version) do nothing;
