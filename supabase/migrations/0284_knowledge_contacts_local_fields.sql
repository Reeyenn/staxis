-- ═══════════════════════════════════════════════════════════════════════════
-- 0284 — Local-contact fields on knowledge_contacts (QUORE "Local" parity)
--
-- The Knowledge directory's contacts are being promoted to their own
-- Communications → Contacts sub-tab. To match QUORE's "Local" directory we add
-- four optional fields for nearby places (pharmacy, hospital, grocery, …):
--   address          — street address (free text)
--   city_state_zip   — city / state / ZIP on one line (free text)
--   hours            — ONE free-text line ("Mon–Fri 8a–9p"). We deliberately do
--                      NOT replicate QUORE's 4 hours dropdowns — they go stale.
--   local_category   — the Local sub-type (Pharmacy, Hospitals/Clinics, …).
--                      Validated against LOCAL_CATEGORIES in the API, left
--                      free-text in the DB so a new bucket needs no migration.
--
-- We also DROP the category CHECK constraint and move category validation into
-- the API (mirrors how the Log book 0280 left its `category` free-text): future
-- contact buckets then need no migration either.
--
-- All columns are nullable + additive → live-safe. Existing rows unaffected.
-- @rls: unchanged — service-role-only, all access via /api/knowledge/contacts.
-- ═══════════════════════════════════════════════════════════════════════════

-- Category is now validated in the API (CONTACT_CATEGORIES), not the DB.
alter table public.knowledge_contacts
  drop constraint if exists knowledge_contacts_category_check;

alter table public.knowledge_contacts
  add column if not exists address        text,
  add column if not exists city_state_zip text,
  add column if not exists hours          text,
  add column if not exists local_category text;

comment on column public.knowledge_contacts.address is
  'Street address for a local contact (free text). Added 0284.';
comment on column public.knowledge_contacts.city_state_zip is
  'City / state / ZIP on one line (free text). Added 0284.';
comment on column public.knowledge_contacts.hours is
  'Hours as one free-text line (no structured dropdowns — they go stale). Added 0284.';
comment on column public.knowledge_contacts.local_category is
  'Local sub-type (LOCAL_CATEGORIES; API-validated, free-text in DB). Only meaningful when category = ''local''. Added 0284.';

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0284', 'feature/contacts-tab: knowledge_contacts local fields (address, city_state_zip, hours, local_category) + drop category check (API-validated).')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
