-- ═══════════════════════════════════════════════════════════════════════════
-- 0250 — packages (front-desk incoming guest-delivery log)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Front desk logs parcels that arrive for in-house / arriving guests (Amazon,
-- FedEx, UPS boxes held behind the desk), optionally texts the guest, and marks
-- them picked up. The AI touch: snap the shipping label → Claude Vision pre-fills
-- guest name / room / carrier / tracking (scan only — nothing is auto-saved).
--
-- Security model matches lost_and_found_items (0230) and the pms_* tables (0202):
-- RLS enabled, browser roles (anon + authenticated) denied outright, service_role
-- is the only reader/writer. Rows carry guest PII (name, room, optional phone) so
-- service-role-only is the right posture — the app reads/writes EXCLUSIVELY through
-- /api/front-desk/packages/* with supabaseAdmin (CLAUDE.md "RLS bug class"). UNLIKE
-- Lost & Found, the API gate allows ANY signed-in user with access to the property
-- (front-desk staff, not management-only) — the access decision lives in the API
-- gate, not in RLS; the table itself stays deny-all-browser either way.
--
-- @rls: service-role-only — guest PII; the app writes/reads this table exclusively
-- through /api/front-desk/packages/* with supabaseAdmin.

create table if not exists public.packages (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references public.properties(id) on delete cascade,

  -- Recipient. Required — a parcel with no addressee can't be handed back.
  guest_name              text not null,

  -- Structured room when known (guest may be a future arrival → null).
  room_number             text,

  -- Carrier, when identifiable from the label. Constrained so the UI filter +
  -- the AI scan normalize to a known set; null when unknown.
  carrier                 text check (carrier is null or carrier in (
                            'UPS','FedEx','USPS','Amazon','Other'
                          )),

  tracking_number         text,

  -- Optional guest phone (E.164-ish) captured at log time. Enables the
  -- "Notify guest" SMS; when null the UI hides the button. Guest PII.
  guest_phone             text,

  notes                   text,

  -- Storage key in the `package-label-photos` bucket:
  -- <property_id>/pkg/<scopeKey>/<uuid>.<ext>
  photo_path              text,

  status                  text not null default 'held' check (status in (
                            'held','picked_up'
                          )),

  -- Provenance. accounts.id of the staff session that logged it / marked it
  -- picked up. Plain uuid (no FK) so deleting an account never cascades away
  -- package history — mirrors lost_and_found_items.created_by_account_id.
  logged_by_account_id    uuid,
  logged_at               timestamptz not null default now(),

  picked_up_at            timestamptz,
  picked_up_by_account_id uuid,

  -- When the most-recent "package arrived" SMS was enqueued for the guest.
  guest_notified_at       timestamptz,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.packages is
  'Front-desk incoming guest-delivery log (Amazon/FedEx/UPS parcels held at the '
  'desk). Service-role only; reads/writes go through /api/front-desk/packages/* '
  'with supabaseAdmin. Carries guest PII. Created 0250.';

-- ─── Index ──────────────────────────────────────────────────────────────────
-- The list view filters by status and orders newest-first within a property.
create index if not exists packages_property_status_logged_idx
  on public.packages (property_id, status, logged_at desc);

-- ─── RLS — deny-all-browser, service-role only (matches 0230 / 0202) ─────────
alter table public.packages enable row level security;
revoke all on public.packages from public, anon, authenticated;
grant select, insert, update, delete on public.packages to service_role;
drop policy if exists packages_deny_all_browser on public.packages;
create policy packages_deny_all_browser on public.packages
  for all to anon, authenticated using (false) with check (false);
comment on policy packages_deny_all_browser on public.packages is
  'Service-role only. Front desk writes/reads via /api/front-desk/packages/* with '
  'supabaseAdmin. Carries guest PII. Created 0250.';

-- ─── updated_at trigger (reuse the shared pms helper from 0202) ──────────────
drop trigger if exists set_updated_at on public.packages;
create trigger set_updated_at before update on public.packages
  for each row execute function public._pms_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- Storage bucket — package-label-photos
-- ═══════════════════════════════════════════════════════════════════════════
-- Private bucket; 10 MB cap; image MIME allow-list (matches lost-found-item-
-- photos in 0230). Uploads happen via signed-upload URLs minted server-side
-- (the front-desk presign route). Browser writes are blocked.
--
-- @storage: service-role-only — uploads via server-minted signed-upload URLs;
-- views via server-minted signed URLs (signLabelPhotos). Browser/anon denied.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('package-label-photos', 'package-label-photos', false, 10485760,
   array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "service role rw package-label-photos" on storage.objects;
create policy "service role rw package-label-photos"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'package-label-photos')
  with check (bucket_id = 'package-label-photos');

drop policy if exists "anon deny package-label-photos" on storage.objects;
create policy "anon deny package-label-photos"
  on storage.objects
  for all
  to anon, authenticated
  using (bucket_id <> 'package-label-photos')
  with check (bucket_id <> 'package-label-photos');

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0250',
  'packages: front-desk incoming guest-delivery log (held → picked_up) + AI '
  'shipping-label scan. Service-role only + package-label-photos storage bucket.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
