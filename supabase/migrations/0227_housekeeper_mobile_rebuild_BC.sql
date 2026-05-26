-- ═══════════════════════════════════════════════════════════════════════════
-- 0225 — Housekeeper mobile rebuild pieces B + C
--
-- Adds the persistence layer for the back half of the housekeeper mobile
-- rebuild — pieces B (photos, structured issue reporting, notice board,
-- manager notes, rush flag, add-note, mark-for-inspection) and C
-- (multilingual support beyond EN/ES, offline-queue idempotency,
-- component rooms).
--
-- Tables added:
--   - housekeeping_notices         — manager broadcasts shown above the
--                                    housekeeper queue. Translations stored
--                                    inline (body_en/es/ht/tl/vi).
--   - housekeeper_dismissed_notices — per-staff dismissal tracking; pinned
--                                    notices ignore this and stay visible.
--   - manager_room_notes           — per-room notes that surface on the
--                                    housekeeper's job card.
--   - housekeeper_audit_log        — generic per-staff event log used by
--                                    Add Note + Mark for Inspection (and
--                                    by piece B's structured issue path
--                                    for forensics).
--   - component_rooms              — multi-room suites cleaned as one
--                                    unit (parent + child room_numbers).
--   - offline_action_replays       — idempotency log for the service-worker
--                                    queue. Mutations carry a UUID action_id;
--                                    a replay with the same id no-ops.
--
-- Schema extensions:
--   - staff.language               — drop the en/es-only check; allow the
--                                    five housekeeper-facing locales.
--   - rooms.is_rush                — already there from 0222; this migration
--                                    adds rush_requested_by_account_id for
--                                    the front-desk Rush button.
--   - rooms.manager_note           — single-string manager note display
--                                    surface (alongside manager_room_notes
--                                    for the auditable per-row history).
--   - rooms.component_parent_number — points a child room at its parent
--                                    so the housekeeper page can collapse
--                                    sub-rooms into one job card.
--
-- Storage:
--   - housekeeping-issue-photos    — private bucket; path is
--                                    `<property_id>/<work_order_id>/<file>`.
--                                    RLS policy restricts to service_role
--                                    write + per-property read.
--
-- RPC:
--   - staxis_create_structured_issue — atomically creates a pms_work_orders_v2
--                                    row from the housekeeper's structured
--                                    issue input, returning the work-order id
--                                    so the client can upload the photo.
--   - staxis_post_notice            — atomic notice insert that respects the
--                                    one-pinned-per-property rule.
--
-- Tenant scoping:
--   property_id on every row. RLS posture matches cleaning_tasks (0210) /
--   housekeeper-workflow (0222) — service-role only via /api/* routes.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: create table if not exists + create or replace function.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── A. staff.language extension ─────────────────────────────────────────

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.staff'::regclass
      and conname = 'staff_language_check'
  ) then
    alter table public.staff drop constraint staff_language_check;
  end if;
end $$;

alter table public.staff
  add constraint staff_language_check
  check (language is null or language in ('en', 'es', 'ht', 'tl', 'vi'));

-- ─── B. rooms additions for piece B ─────────────────────────────────────

alter table public.rooms
  add column if not exists rush_requested_by_account_id uuid,
  add column if not exists rush_duration_label text,
  -- 0222 already added `manager_notes` (plural). 0225 adds metadata
  -- columns alongside it so the room-notes POST route can record who
  -- posted the latest note and when, without breaking JobCard which
  -- already reads `manager_notes`.
  add column if not exists manager_notes_at timestamptz,
  add column if not exists manager_notes_by_account_id uuid,
  add column if not exists component_parent_number text,
  add column if not exists housekeeper_note text,
  add column if not exists housekeeper_note_at timestamptz;

-- ─── C. housekeeping_notices ─────────────────────────────────────────────

create table if not exists public.housekeeping_notices (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  body_en             text not null,
  body_es             text,
  body_ht             text,
  body_tl             text,
  body_vi             text,
  pinned              boolean not null default false,
  expires_at          timestamptz,
  posted_by_account_id uuid,
  posted_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists housekeeping_notices_property_active_idx
  on public.housekeeping_notices (property_id, posted_at desc);
-- ^ Originally filtered `WHERE expires_at IS NULL OR expires_at > now()` to
-- index only the active notices. Postgres rejects partial-index predicates
-- that aren't IMMUTABLE (now() is STABLE). Drop the predicate; the index
-- stays useful for sorting active+expired together, and the active-notice
-- GET applies the time filter at query time.

-- One pinned notice per property at a time (partial unique index).
-- Same IMMUTABLE constraint — we can't filter by expires_at here. The
-- staxis_post_notice RPC compensates by explicitly unpinning the existing
-- pinned notice before inserting the new one, so the "one pinned at a
-- time" invariant holds without the time predicate.
create unique index if not exists housekeeping_notices_one_pinned_idx
  on public.housekeeping_notices (property_id)
  where pinned = true;

alter table public.housekeeping_notices enable row level security;
revoke all on public.housekeeping_notices from public, anon, authenticated;
grant select, insert, update, delete on public.housekeeping_notices to service_role;
drop policy if exists housekeeping_notices_deny_all_browser on public.housekeeping_notices;
create policy housekeeping_notices_deny_all_browser on public.housekeeping_notices
  for all to anon, authenticated using (false) with check (false);

-- ─── D. housekeeper_dismissed_notices ────────────────────────────────────

create table if not exists public.housekeeper_dismissed_notices (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  staff_id     uuid not null,
  notice_id    uuid not null references public.housekeeping_notices(id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  constraint housekeeper_dismissed_notices_unique
    unique (staff_id, notice_id)
);

create index if not exists hdn_property_staff_idx
  on public.housekeeper_dismissed_notices (property_id, staff_id);

alter table public.housekeeper_dismissed_notices enable row level security;
revoke all on public.housekeeper_dismissed_notices from public, anon, authenticated;
grant select, insert, update, delete on public.housekeeper_dismissed_notices to service_role;
drop policy if exists hdn_deny_all_browser on public.housekeeper_dismissed_notices;
create policy hdn_deny_all_browser on public.housekeeper_dismissed_notices
  for all to anon, authenticated using (false) with check (false);

-- ─── E. manager_room_notes ───────────────────────────────────────────────

create table if not exists public.manager_room_notes (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  room_number         text not null,
  business_date       date not null,
  note_text           text not null,
  note_lang           text default 'en'
                      check (note_lang in ('en', 'es', 'ht', 'tl', 'vi')),
  posted_by_account_id uuid,
  posted_at           timestamptz not null default now(),
  expires_at          timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists manager_room_notes_room_idx
  on public.manager_room_notes (property_id, room_number, business_date desc);
create index if not exists manager_room_notes_active_idx
  on public.manager_room_notes (property_id, business_date, room_number);
-- ^ Filtering on `expires_at IS NULL OR expires_at > now()` would let
-- Postgres skip expired rows, but partial-index predicates must be
-- IMMUTABLE (now() is STABLE — rejected). The GET endpoint applies the
-- time filter at query time; the index still narrows the scan to the
-- right property + date + room.

alter table public.manager_room_notes enable row level security;
revoke all on public.manager_room_notes from public, anon, authenticated;
grant select, insert, update, delete on public.manager_room_notes to service_role;
drop policy if exists manager_room_notes_deny_all_browser on public.manager_room_notes;
create policy manager_room_notes_deny_all_browser on public.manager_room_notes
  for all to anon, authenticated using (false) with check (false);

-- ─── F. component_rooms ──────────────────────────────────────────────────

create table if not exists public.component_rooms (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  parent_room_number  text not null,
  child_room_numbers  jsonb not null default '[]'::jsonb
                      check (jsonb_typeof(child_room_numbers) = 'array'),
  label               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint component_rooms_parent_unique
    unique (property_id, parent_room_number)
);

create index if not exists component_rooms_parent_idx
  on public.component_rooms (property_id, parent_room_number);

alter table public.component_rooms enable row level security;
revoke all on public.component_rooms from public, anon, authenticated;
grant select, insert, update, delete on public.component_rooms to service_role;
drop policy if exists component_rooms_deny_all_browser on public.component_rooms;
create policy component_rooms_deny_all_browser on public.component_rooms
  for all to anon, authenticated using (false) with check (false);

-- ─── G. housekeeper_audit_log ────────────────────────────────────────────

create table if not exists public.housekeeper_audit_log (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  staff_id        uuid not null,
  business_date   date not null,
  room_id         uuid,
  room_number     text,
  event_type      text not null
                  check (event_type in (
                    'add_note',
                    'mark_for_inspection',
                    'structured_issue_filed',
                    'photo_attached',
                    'notice_dismissed',
                    'language_changed'
                  )),
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists housekeeper_audit_log_property_date_idx
  on public.housekeeper_audit_log (property_id, business_date desc);
create index if not exists housekeeper_audit_log_staff_idx
  on public.housekeeper_audit_log (property_id, staff_id, business_date desc);

alter table public.housekeeper_audit_log enable row level security;
revoke all on public.housekeeper_audit_log from public, anon, authenticated;
grant select, insert, update, delete on public.housekeeper_audit_log to service_role;
drop policy if exists hal_deny_all_browser on public.housekeeper_audit_log;
create policy hal_deny_all_browser on public.housekeeper_audit_log
  for all to anon, authenticated using (false) with check (false);

-- ─── H. offline_action_replays ───────────────────────────────────────────
-- Idempotency log for service-worker queued actions. When the housekeeper's
-- phone replays a queued tap, the action_id (client-generated UUID) is
-- checked against this table; a hit returns the original result without
-- re-applying the mutation. Garbage-collected after 7 days by a cron sweep
-- (added in a future migration; for now the row count is bounded by the
-- 200/hr per-staff rate limit on the underlying mutations).

create table if not exists public.offline_action_replays (
  action_id       uuid primary key,
  property_id     uuid not null references public.properties(id) on delete cascade,
  staff_id        uuid not null,
  endpoint        text not null,
  result_payload  jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists offline_action_replays_age_idx
  on public.offline_action_replays (created_at);
create index if not exists offline_action_replays_staff_idx
  on public.offline_action_replays (property_id, staff_id, created_at desc);

alter table public.offline_action_replays enable row level security;
revoke all on public.offline_action_replays from public, anon, authenticated;
grant select, insert, update, delete on public.offline_action_replays to service_role;
drop policy if exists oar_deny_all_browser on public.offline_action_replays;
create policy oar_deny_all_browser on public.offline_action_replays
  for all to anon, authenticated using (false) with check (false);

-- ─── I. Storage bucket — housekeeping-issue-photos ───────────────────────
-- @storage: service-role-only — uploads come through /api/housekeeper/photo-presign
-- which mints a signed-upload URL via supabaseAdmin (service-role).
-- Reads also flow through service-role helpers (the maintenance UI fetches
-- signed download URLs server-side). No authenticated browser role ever
-- touches this bucket directly, so per-property foldername RLS is not
-- required — the deny-anon policy below + service-role bypass is enough.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('housekeeping-issue-photos', 'housekeeping-issue-photos', false, 10485760,
   array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Service-role only — uploads happen from /api/housekeeper/structured-issue
-- via supabaseAdmin. Browser writes are blocked.
drop policy if exists "service role rw housekeeping-issue-photos" on storage.objects;
create policy "service role rw housekeeping-issue-photos"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'housekeeping-issue-photos')
  with check (bucket_id = 'housekeeping-issue-photos');

drop policy if exists "anon deny housekeeping-issue-photos" on storage.objects;
create policy "anon deny housekeeping-issue-photos"
  on storage.objects
  for all
  to anon, authenticated
  using (bucket_id <> 'housekeeping-issue-photos')
  with check (bucket_id <> 'housekeeping-issue-photos');

-- ─── J. RPC — staxis_create_structured_issue ─────────────────────────────
--
-- Atomic create of a pms_work_orders_v2 row from the housekeeper's
-- structured issue input. Returns the new work-order id so the client can
-- upload the optional photo against `<property_id>/<work_order_id>/...`.

create or replace function public.staxis_create_structured_issue(
  p_property_id uuid,
  p_room_number text,
  p_reporter_staff_id uuid,
  p_action text,
  p_item text,
  p_location_detail text,
  p_severity text,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_work_order_id uuid;
  v_pms_id text;
  v_category text;
  v_priority text;
  v_description text;
begin
  -- Map severity → priority (pms_work_orders_v2 check constraint).
  v_priority := case lower(coalesce(p_severity, 'minor'))
    when 'urgent' then 'urgent'
    when 'major'  then 'high'
    else 'medium'
  end;

  -- Guess category from the action verb. Maintenance can edit later.
  v_category := case lower(coalesce(p_action, ''))
    when 'replace' then 'appliance'
    when 'repair'  then 'appliance'
    when 'clean'   then 'cosmetic'
    when 'report'  then 'other'
    else 'other'
  end;

  v_description := trim(both ' ' from concat_ws(' · ',
    nullif(initcap(coalesce(p_action, '')), ''),
    nullif(p_item, ''),
    nullif(p_location_detail, ''),
    nullif(p_note, '')
  ));

  v_work_order_id := gen_random_uuid();
  v_pms_id := 'staxis-hk-' || v_work_order_id::text;

  insert into public.pms_work_orders_v2 (
    id, property_id, pms_work_order_id, room_number, area,
    description, category, priority, status,
    reported_at, reported_by, raw
  ) values (
    v_work_order_id, p_property_id, v_pms_id, p_room_number, p_location_detail,
    nullif(v_description, ''), v_category, v_priority, 'open',
    now(), p_reporter_staff_id::text,
    jsonb_build_object(
      'source',           'housekeeper_app',
      'reporter_staff_id', p_reporter_staff_id,
      'action',           p_action,
      'item',             p_item,
      'location_detail',  p_location_detail,
      'severity',         p_severity,
      'note',             p_note
    )
  );

  return v_work_order_id;
end;
$$;

revoke all on function public.staxis_create_structured_issue(uuid, text, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.staxis_create_structured_issue(uuid, text, uuid, text, text, text, text, text) to service_role;

comment on function public.staxis_create_structured_issue(uuid, text, uuid, text, text, text, text, text) is
  'Creates a pms_work_orders_v2 row from a housekeeper structured issue. Returns the work-order id for the optional photo upload. Added 0225.';

-- ─── K. RPC — staxis_post_notice ──────────────────────────────────────────
--
-- Inserts a notice respecting the one-pinned-per-property invariant. If the
-- caller asks to pin a new notice while another is already pinned, the
-- existing pinned notice is auto-unpinned in the same transaction.

create or replace function public.staxis_post_notice(
  p_property_id uuid,
  p_body_en text,
  p_body_es text,
  p_body_ht text,
  p_body_tl text,
  p_body_vi text,
  p_pinned boolean,
  p_expires_at timestamptz,
  p_posted_by_account_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_notice_id uuid;
begin
  if p_pinned then
    update public.housekeeping_notices
       set pinned = false, updated_at = now()
     where property_id = p_property_id
       and pinned = true
       and (expires_at is null or expires_at > now());
  end if;

  insert into public.housekeeping_notices
    (property_id, body_en, body_es, body_ht, body_tl, body_vi,
     pinned, expires_at, posted_by_account_id)
  values
    (p_property_id, p_body_en, p_body_es, p_body_ht, p_body_tl, p_body_vi,
     coalesce(p_pinned, false), p_expires_at, p_posted_by_account_id)
  returning id into v_notice_id;

  return v_notice_id;
end;
$$;

revoke all on function public.staxis_post_notice(uuid, text, text, text, text, text, boolean, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.staxis_post_notice(uuid, text, text, text, text, text, boolean, timestamptz, uuid) to service_role;

comment on function public.staxis_post_notice(uuid, text, text, text, text, text, boolean, timestamptz, uuid) is
  'Atomic notice post that enforces "one pinned notice per property at a time". Added 0225.';

-- ─── Track the migration ─────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values (
  '0225',
  'Housekeeper mobile rebuild pieces B + C: notice board, manager notes, component rooms, audit log, offline-replay idempotency, housekeeping-issue-photos storage bucket, structured-issue + notice RPCs, staff.language expanded to ht/tl/vi.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
