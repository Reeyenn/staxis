-- ═══════════════════════════════════════════════════════════════════════════
-- 0230 — lost_and_found_items (app-side Lost & Found register)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The first feature to actually surface Lost & Found. Two data sources feed
-- the unified Front-Desk register:
--
--   1. pms_lost_and_found  (migration 0202) — CUA-owned, service-role, READ-ONLY
--      from the app's perspective. The vision worker syncs items the PMS knows
--      about. The app NEVER writes here.
--   2. lost_and_found_items (THIS table) — staff-logged items (front desk +
--      housekeeper "Found an item" + voice). The app owns this table.
--
-- Reads UNION both server-side via supabaseAdmin (see src/lib/lost-and-found/
-- store.ts) because BOTH tables are deny-all-browser — the anon client returns
-- zero rows (CLAUDE.md "RLS bug class"). Every read/write goes through /api/*.
--
-- Security model matches the pms_* tables (0202) and cleaning_tasks (0210):
-- RLS enabled, browser roles denied outright, service_role is the only writer.
-- L&F rows carry guest PII (contact phone/email) so service-role-only is the
-- right posture — no authenticated-read policy.
--
-- @rls: service-role-only — guest PII; CUA owns the sibling pms_lost_and_found,
-- the app writes/reads this table exclusively through /api/* with supabaseAdmin.

create table if not exists public.lost_and_found_items (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,

  -- 'found' = staff found an item; 'lost' = guest reported something missing.
  type                  text not null check (type in ('found','lost')),

  item_description      text not null,
  category              text check (category is null or category in (
                          'electronics','clothing','jewelry','documents','bags',
                          'keys','toiletries','eyewear','toys','money','other'
                        )),

  -- location is free-text ("pool deck", "lobby restroom"); room_number is the
  -- structured room when known (auto-filled from the housekeeper's job card).
  location              text,
  room_number           text,

  -- Storage key in the `lost-found-item-photos` bucket:
  -- <property_id>/<item_id-or-draft>/<uuid>.<ext>
  photo_path            text,

  status                text not null default 'open' check (status in (
                          'open','matched','returned','shipped','disposed','expired'
                        )),

  -- Provenance. found_by/reported_by are display strings for the register;
  -- found_by_staff_id links a housekeeper-logged item back to staff.
  found_by              text,
  found_by_staff_id     uuid,
  reported_by           text,

  -- Guest PII — who the item belongs to / who reported it lost.
  guest_name            text,
  guest_contact         text,

  -- Self-reference: a 'lost' report and the 'found' item it pairs with point
  -- at each other. ON DELETE SET NULL so deleting one side doesn't cascade.
  matched_item_id       uuid references public.lost_and_found_items(id) on delete set null,

  -- When the item was found / reported lost — drives the auto-match date window.
  occurred_at           timestamptz,

  -- Disposal deadline for found items (default 90-day hold, set app-side).
  -- Absolute instant, so the disposal sweep is timezone-proof.
  hold_until            timestamptz,

  claimed_at            timestamptz,
  returned_at           timestamptz,

  -- {carrier, tracking, address, sms_job_id, sms_sent_at, guest_reply, ...}
  shipping_info         jsonb,

  source                text not null default 'front_desk' check (source in (
                          'front_desk','housekeeper','voice','staff'
                        )),

  notes                 text,

  -- accounts.id of whoever logged it (front-desk session / voice agent). Null
  -- for housekeeper-logged items (those use found_by_staff_id instead).
  created_by_account_id uuid,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.lost_and_found_items is
  'App-side Lost & Found register (staff-logged found items + guest lost reports). '
  'UNIONed with pms_lost_and_found for the Front-Desk view. Service-role only; '
  'reads/writes go through /api/* with supabaseAdmin. Created 0229.';

-- ─── Indexes ────────────────────────────────────────────────────────────────
create index if not exists laf_items_property_status_idx
  on public.lost_and_found_items (property_id, status);
create index if not exists laf_items_property_type_status_idx
  on public.lost_and_found_items (property_id, type, status);
create index if not exists laf_items_property_created_idx
  on public.lost_and_found_items (property_id, created_at desc);
-- Disposal sweep: open found items past/near their hold deadline.
create index if not exists laf_items_hold_until_idx
  on public.lost_and_found_items (property_id, hold_until)
  where status = 'open' and type = 'found' and hold_until is not null;
create index if not exists laf_items_matched_idx
  on public.lost_and_found_items (matched_item_id)
  where matched_item_id is not null;

-- ─── RLS — deny-all-browser, service-role only (matches 0202 / 0210) ─────────
alter table public.lost_and_found_items enable row level security;
revoke all on public.lost_and_found_items from public, anon, authenticated;
grant select, insert, update, delete on public.lost_and_found_items to service_role;
drop policy if exists lost_and_found_items_deny_all_browser on public.lost_and_found_items;
create policy lost_and_found_items_deny_all_browser on public.lost_and_found_items
  for all to anon, authenticated using (false) with check (false);
comment on policy lost_and_found_items_deny_all_browser on public.lost_and_found_items is
  'Service-role only. Front desk + housekeeper write via /api/* with supabaseAdmin; '
  'app reads via /api/* (union with pms_lost_and_found). Carries guest PII. Created 0229.';

-- ─── updated_at trigger (reuse the shared pms helper from 0202) ──────────────
drop trigger if exists set_updated_at on public.lost_and_found_items;
create trigger set_updated_at before update on public.lost_and_found_items
  for each row execute function public._pms_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- Storage bucket — lost-found-item-photos
-- ═══════════════════════════════════════════════════════════════════════════
-- Private bucket; 10 MB cap; image MIME allow-list (matches housekeeping-issue
-- -photos in 0227). Uploads happen via signed-upload URLs minted server-side
-- (front desk + housekeeper presign routes). Browser writes are blocked.
--
-- @storage: service-role-only — uploads via server-minted signed-upload URLs;
-- views via server-minted signed URLs (signItemPhotos). Browser/anon denied.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('lost-found-item-photos', 'lost-found-item-photos', false, 10485760,
   array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "service role rw lost-found-item-photos" on storage.objects;
create policy "service role rw lost-found-item-photos"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'lost-found-item-photos')
  with check (bucket_id = 'lost-found-item-photos');

drop policy if exists "anon deny lost-found-item-photos" on storage.objects;
create policy "anon deny lost-found-item-photos"
  on storage.objects
  for all
  to anon, authenticated
  using (bucket_id <> 'lost-found-item-photos')
  with check (bucket_id <> 'lost-found-item-photos');

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0230',
  'lost_and_found_items: app-side Lost & Found register (found items + lost reports), '
  'UNIONed with pms_lost_and_found for the Front-Desk view. Service-role only + '
  'lost-found-item-photos storage bucket.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
