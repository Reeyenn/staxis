-- 0051_app_events.sql
-- Activity tracking. Every time a GM or staff member does something in the
-- app (page view, feature use, etc.) the client fires an event row.
--
-- Powers the per-hotel engagement panel on the Live hotels tab so Reeyen
-- can see what each hotel actually uses vs ignores.
--
-- Admin activity is intentionally NOT logged here (filtered at the API
-- layer by user_role). Reeyen's own clicks would pollute the per-hotel
-- engagement view.

create table if not exists public.app_events (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references public.properties(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  -- Denormalized so we can filter admins out cheaply without a join.
  -- Values: 'admin','owner','staff' (matches AppUser.role).
  user_role text,
  -- e.g. 'page_view', 'feature_use', 'sms_sent_internal', 'staff_confirm'
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  ts timestamptz not null default now()
);

create index if not exists app_events_property_ts_idx on public.app_events (property_id, ts desc);
create index if not exists app_events_user_ts_idx on public.app_events (user_id, ts desc);
create index if not exists app_events_type_ts_idx on public.app_events (event_type, ts desc);

alter table public.app_events enable row level security;
-- No public policies: writes go through /api/events (server-side, with
-- the user's auth header) and reads go through /api/admin/activity.
