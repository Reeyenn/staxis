-- ═══════════════════════════════════════════════════════════════════════════
-- 0252 — Knowledge hub (SOPs · Documents · Contacts · Calendar)
--
-- A per-property knowledge base that lives as a third view inside
-- Communications (Chats · Tasks · Knowledge). Four tables:
--
--   knowledge_articles   — SOPs / how-to write-ups (title + markdown/plain body)
--   knowledge_documents  — uploaded files (private bucket) + extracted text for AI search
--   knowledge_contacts   — vendor / emergency / brand / local directory
--   knowledge_events     — simple team calendar (date-ranged entries)
--
-- ACCESS MODEL — ALL STAFF READ, MANAGERS WRITE:
--   Reads (list/search) are available to every authenticated user with access
--   to the property; writes (create/edit/delete SOPs, upload docs, edit
--   contacts, add calendar events) are MANAGEMENT-ONLY (canManageTeam:
--   admin / owner / general_manager).
--
-- RLS posture — SERVICE-ROLE ONLY (mirrors comms_* 0241 / equipment 0249 /
-- compliance 0229 / activity_log). Every read/write goes through
-- /api/knowledge/* using supabaseAdmin AFTER the route has authenticated the
-- caller (commsContext) and — for writes — checked canManageTeam(role). The
-- AI assistant's read-only search_knowledge tool reads the same tables via
-- supabaseAdmin, scoped to ctx.propertyId. anon + authenticated are deny-all so
-- a browser client can never read or write these tables directly. The
-- all-staff-read / manager-write split is enforced at the route layer, NOT by
-- RLS alone (matches the 2026 "service-role + API gate" convention).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. knowledge_articles — SOPs ────────────────────────────────────────────
-- @rls: service-role-only — all access via /api/knowledge/articles (commsContext + canManageTeam for writes).
create table if not exists public.knowledge_articles (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,

  title           text not null,
  body            text not null default '',
  category        text,                       -- free-text section ("Breakfast", "Safety", …); nullable

  created_by      uuid,                        -- accounts.id of the author (audit; no hard FK, mirrors comms_ack_campaigns.created_by_account)
  created_by_name text,                         -- display-name snapshot for rendering without a join
  updated_by      uuid,
  updated_by_name text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.knowledge_articles is
  'Knowledge hub SOPs: per-property how-to write-ups (title + markdown/plain body). property_id scoped, service-role-only. All staff read, managers write — gated at /api/knowledge/articles. Added 0252.';

create index if not exists knowledge_articles_property_updated_idx
  on public.knowledge_articles (property_id, updated_at desc);
create index if not exists knowledge_articles_property_category_idx
  on public.knowledge_articles (property_id, category);

-- ── 2. knowledge_documents — uploaded files ─────────────────────────────────
-- @rls: service-role-only — files live in the private 'knowledge-docs' bucket; signed URLs minted server-side.
create table if not exists public.knowledge_documents (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references public.properties(id) on delete cascade,

  title            text not null,
  file_path        text not null,              -- object path inside the 'knowledge-docs' bucket: <pid>/knowledge/<uuid>.<ext>
  mime_type        text,
  size_bytes       bigint,
  extracted_text   text,                        -- plain-text/markdown extracted on upload for AI search; NULL for PDF/doc (content extraction = fast-follow)

  uploaded_by      uuid,
  uploaded_by_name text,

  created_at       timestamptz not null default now()
);

comment on table public.knowledge_documents is
  'Knowledge hub uploaded files: a metadata row per object in the private knowledge-docs bucket. extracted_text holds plain-text/markdown content for AI search (PDF/doc content extraction is a documented fast-follow). property_id scoped, service-role-only. Added 0252.';
comment on column public.knowledge_documents.file_path is
  'Object path inside the private knowledge-docs bucket. Always begins with <property_id>/knowledge/ — the register route rejects any path not scoped to the caller''s property, so a row can never point at another tenant''s file.';

create unique index if not exists knowledge_documents_file_path_key
  on public.knowledge_documents (file_path);
create index if not exists knowledge_documents_property_created_idx
  on public.knowledge_documents (property_id, created_at desc);

-- ── 3. knowledge_contacts — vendor / emergency / brand / local directory ────
-- @rls: service-role-only — all access via /api/knowledge/contacts.
create table if not exists public.knowledge_contacts (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,

  name            text not null,
  company         text,                         -- role / company ("Plumber", "ABC Plumbing")
  phone           text,
  email           text,
  notes           text,
  category        text check (category is null or category in ('vendor','emergency','brand','local')),

  created_by      uuid,
  created_by_name text,

  created_at      timestamptz not null default now()
);

comment on table public.knowledge_contacts is
  'Knowledge hub directory: vendor / emergency / brand / local contacts per property. property_id scoped, service-role-only. All staff read, managers write. Added 0252.';

create index if not exists knowledge_contacts_property_category_idx
  on public.knowledge_contacts (property_id, category);

-- ── 4. knowledge_events — simple team calendar ──────────────────────────────
-- @rls: service-role-only — all access via /api/knowledge/events.
create table if not exists public.knowledge_events (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,

  title           text not null,
  event_date      date not null,
  end_date        date,                         -- nullable; null = single-day event
  notes           text,

  created_by      uuid,
  created_by_name text,

  created_at      timestamptz not null default now(),

  constraint knowledge_events_date_order check (end_date is null or end_date >= event_date)
);

comment on table public.knowledge_events is
  'Knowledge hub team calendar: simple date-ranged entries (training days, vendor visits, brand audits). property_id scoped, service-role-only. All staff read, managers write. Added 0252.';

create index if not exists knowledge_events_property_date_idx
  on public.knowledge_events (property_id, event_date);

-- ── 5. RLS — service-role only; anon + authenticated deny-all ───────────────
-- Every table: browser clients (anon + authenticated) are denied entirely; the
-- /api/knowledge/* routes use supabaseAdmin (service_role) after authenticating
-- the caller. Matches comms_* (0241), equipment (0249), compliance (0229).
do $$
declare t text;
begin
  foreach t in array array['knowledge_articles','knowledge_documents','knowledge_contacts','knowledge_events']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('revoke all on public.%I from public, anon, authenticated;', t);
    execute format('grant select, insert, update, delete on public.%I to service_role;', t);
    execute format('drop policy if exists %I on public.%I;', t || '_deny_all', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false);', t || '_deny_all', t);
  end loop;
end $$;

-- ── 6. updated_at trigger on articles (shared fn from 0202/0211) ────────────
drop trigger if exists set_updated_at on public.knowledge_articles;
create trigger set_updated_at before update on public.knowledge_articles
  for each row execute function public._pms_set_updated_at();

-- ── 7. Private storage bucket for uploaded documents ────────────────────────
-- PRIVATE bucket — never on the public CDN. The service role (supabaseAdmin)
-- mints short-lived signed upload + download URLs server-side; no storage.objects
-- policy is granted to anon/authenticated, so a browser client can neither list
-- nor read objects directly (service_role bypasses RLS for the signed-URL mint).
-- Path convention: <property_id>/knowledge/<uuid>.<ext> — keeps per-property
-- cleanup trivial and lets the register route reject cross-tenant paths.
-- allowed_mime_types is the document set the presign route resolves from the
-- file extension (it sends a server-chosen Content-Type, so the PUT always
-- matches one of these exactly).
-- @storage: service-role-only — private bucket; supabaseAdmin mints all signed upload/download URLs server-side. No anon/authenticated policy by design (browser clients can neither list nor read). Per-property tenant scoping is enforced in /api/knowledge/documents (register rejects any object path not under <property_id>/knowledge/).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'knowledge-docs', 'knowledge-docs', false, 10485760,
  array[
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 8. Bookkeeping + schema reload ──────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0252',
  'Knowledge hub: knowledge_articles (SOPs) + knowledge_documents (private knowledge-docs bucket + extracted_text) + knowledge_contacts (vendor/emergency/brand/local) + knowledge_events (team calendar). All service-role-only (deny-all anon+authenticated); all-staff read / manager write enforced at /api/knowledge/*. Read-only AI search via search_knowledge tool (scoped to ctx.propertyId). Plain-text/markdown docs AI-searchable; PDF content extraction is a fast-follow.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
