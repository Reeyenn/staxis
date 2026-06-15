-- ═══════════════════════════════════════════════════════════════════════════
-- 0282 — Knowledge Documents: folders + per-department access.
--
-- Builds on 0252 (knowledge hub) + 0266 (chunks/embeddings + per-doc visibility).
-- Two additions to the Documents cabinet:
--
--   1. FOLDERS — knowledge_folders (per-property, optional nesting) + a nullable
--      knowledge_documents.folder_id. folder_id is ON DELETE SET NULL — deleting
--      a folder un-files its documents, it NEVER deletes the files/embeddings.
--      Storage paths are unchanged (<pid>/knowledge/<uuid>.<ext>); folders are a
--      pure-DB grouping.
--
--   2. PER-DEPARTMENT ACCESS — visibility gains a third tier 'dept' (alongside
--      'all_staff' / 'managers'), with a companion visible_dept
--      (front_desk|housekeeping|maintenance) populated only when visibility='dept'.
--      Applied to knowledge_documents AND the denormalized knowledge_chunks (so
--      the vector-search RPC filters by department in one indexed predicate). The
--      app gates reads through the shared Access checker
--      (src/lib/capabilities/dept-scope.ts canReachDeptContent): managers reach
--      every department; other staff reach all_staff + their own department.
--
-- ADDITIVE ONLY. New table is service-role-only / deny-all (mirrors 0252/0266).
-- New columns are nullable / behaviour-neutral on apply (prod has 0 documents).
-- Reserved 0282 (prod high-water 0281).
-- ═══════════════════════════════════════════════════════════════════════════

-- pgvector lives in the `extensions` schema; the search RPC re-pins its own
-- search_path, but put it here too so the vector cast resolves during apply.
set search_path = public, extensions, pg_temp;

-- ── 1. knowledge_folders — per-property document folders ─────────────────────
-- @rls: service-role-only — all access via /api/knowledge/folders (commsContext;
--       canForUserId('manage_knowledge') for writes). parent_id self-FK supports
--       nesting (v1 UI is single-level); ON DELETE CASCADE removes descendant
--       folder rows, but each affected document only un-files (doc FK = SET NULL).
create table if not exists public.knowledge_folders (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id)        on delete cascade,
  parent_id       uuid          references public.knowledge_folders(id) on delete cascade,
  name            text not null,
  created_by      uuid,
  created_by_name text,
  created_at      timestamptz not null default now()
);

comment on table public.knowledge_folders is
  'Knowledge hub document folders: per-property grouping for knowledge_documents. parent_id allows nesting (v1 UI single-level). property_id scoped, service-role-only. All staff read, managers write — gated at /api/knowledge/folders. Added 0282.';

create index if not exists knowledge_folders_property_created_idx
  on public.knowledge_folders (property_id, created_at desc);
create index if not exists knowledge_folders_parent_idx
  on public.knowledge_folders (parent_id);

-- ── 2. knowledge_documents — folder_id + per-department visibility ───────────
alter table public.knowledge_documents
  add column if not exists folder_id    uuid references public.knowledge_folders(id) on delete set null,
  add column if not exists visible_dept text;

-- Replace the binary visibility CHECK with the 3-tier + dept-validity invariant.
-- Written so an invalid combination evaluates to FALSE (not NULL) — a 'dept' row
-- with a null/bogus visible_dept, or an all_staff/managers row carrying a dept,
-- is rejected outright.
alter table public.knowledge_documents drop constraint if exists knowledge_documents_visibility_chk;
alter table public.knowledge_documents add  constraint knowledge_documents_visibility_chk check (
  (visibility = 'all_staff' and visible_dept is null)
  or (visibility = 'managers' and visible_dept is null)
  or (visibility = 'dept' and visible_dept is not null
      and visible_dept in ('front_desk','housekeeping','maintenance'))
);

comment on column public.knowledge_documents.folder_id is
  'Optional folder (knowledge_folders.id). NULL = unfiled. ON DELETE SET NULL — deleting a folder un-files its documents, never deletes them. Added 0282.';
comment on column public.knowledge_documents.visible_dept is
  'Department a visibility=''dept'' document is scoped to (front_desk|housekeeping|maintenance); NULL for all_staff/managers. Enforced in list/search/signed-URL via the shared dept checker. Added 0282.';

-- ── 3. knowledge_chunks — denormalized visible_dept (mirror of the parent) ───
-- The vector-search RPC filters chunks by role+department in one predicate, so
-- the parent document's department must be denormalized here (re-synced by
-- core.ts updateDocumentAccess() / indexing.ts on change).
alter table public.knowledge_chunks
  add column if not exists visible_dept text;

-- Drop the inline binary visibility check from 0266 (auto-named) and any prior
-- 0282 re-apply, then install the same 3-tier + dept-validity invariant. Article
-- chunks stay all_staff/managers (visible_dept null) — covered by this check.
alter table public.knowledge_chunks drop constraint if exists knowledge_chunks_visibility_check;
alter table public.knowledge_chunks drop constraint if exists knowledge_chunks_visibility_chk;
alter table public.knowledge_chunks add  constraint knowledge_chunks_visibility_chk check (
  (visibility = 'all_staff' and visible_dept is null)
  or (visibility = 'managers' and visible_dept is null)
  or (visibility = 'dept' and visible_dept is not null
      and visible_dept in ('front_desk','housekeeping','maintenance'))
);

comment on column public.knowledge_chunks.visible_dept is
  'Denormalized from the parent document''s visible_dept (NULL for all_staff/managers and for all article chunks). Filtered by the search RPC + keyword arm. Added 0282.';

-- Indexed predicate for the gated keyword/vector queries.
create index if not exists knowledge_chunks_property_visibility_idx
  on public.knowledge_chunks (property_id, visibility, visible_dept);
create index if not exists knowledge_documents_property_folder_idx
  on public.knowledge_documents (property_id, folder_id);

-- ── 4. Hybrid-search RPC — ADD a dept-aware overload (additive, pre-merge safe) ─
-- We ADD a 5-arg overload (new p_dept) rather than replacing the 4-arg version,
-- so this migration can be applied to prod BEFORE this branch merges: the
-- currently-deployed code keeps calling the 4-arg function (no 'dept' documents
-- exist until this feature ships, so its predicate is still correct), while this
-- branch's code calls the 5-arg version. PostgREST disambiguates the two by
-- argument names. The orphaned 4-arg version can be dropped in a follow-up once
-- this is merged + deployed. p_dept = the caller's own normalized department, or
-- NULL for managers / dept-less staff.
create or replace function public.staxis_search_knowledge_chunks(
  p_property_id          uuid,
  p_query_embedding      text,        -- pgvector text literal: '[0.1,0.2,...]'
  p_include_manager_only boolean,     -- true for managers (admin/owner/general_manager)
  p_dept                 text,        -- caller's own department, or NULL
  p_match_count          int
)
returns table (
  id          uuid,
  document_id uuid,
  article_id  uuid,
  source_type text,
  chunk_index int,
  content     text,
  section     text,
  visibility  text,
  similarity  double precision
)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select
    c.id, c.document_id, c.article_id, c.source_type, c.chunk_index,
    c.content, c.section, c.visibility,
    1 - (c.embedding <=> p_query_embedding::extensions.vector(1536)) as similarity
  from public.knowledge_chunks c
  where c.property_id = p_property_id
    and c.embedding is not null
    and (
      p_include_manager_only
      or c.visibility = 'all_staff'
      or (c.visibility = 'dept' and c.visible_dept = p_dept)
    )
  order by c.embedding <=> p_query_embedding::extensions.vector(1536)
  limit greatest(1, least(coalesce(p_match_count, 8), 50));
$$;

revoke all on function public.staxis_search_knowledge_chunks(uuid, text, boolean, text, int) from public, anon, authenticated;
grant execute on function public.staxis_search_knowledge_chunks(uuid, text, boolean, text, int) to service_role;

-- ── 5. RLS — knowledge_folders service-role only; anon+authenticated deny-all ─
alter table public.knowledge_folders enable row level security;
revoke all on public.knowledge_folders from public, anon, authenticated;
grant select, insert, update, delete on public.knowledge_folders to service_role;
drop policy if exists knowledge_folders_deny_all on public.knowledge_folders;
create policy knowledge_folders_deny_all on public.knowledge_folders
  for all to anon, authenticated using (false) with check (false);

-- ── 6. Bookkeeping + schema reload ──────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0282',
  'Knowledge Documents folders + per-department access: knowledge_folders (per-property, nestable, service-role-only deny-all) + knowledge_documents.folder_id (ON DELETE SET NULL); visibility 3-tier (all_staff|dept|managers) + visible_dept on knowledge_documents and the denormalized knowledge_chunks (combined CHECK enforces dept validity); staxis_search_knowledge_chunks gains p_dept. Reads gated via the shared dept checker (canReachDeptContent).'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
