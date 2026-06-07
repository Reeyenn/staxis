-- ═══════════════════════════════════════════════════════════════════════════
-- 0266 — Knowledge document reading: chunks + embeddings (pgvector) + the
--        extraction state machine + per-doc/article visibility.
--
-- Builds on 0252 (knowledge hub). Turns the hub from "findable by keyword" into
-- "answerable" — the assistant retrieves the exact relevant passage of an
-- uploaded PDF/Word/SOP via hybrid semantic + keyword search, scoped to the
-- property and the asker's role.
--
-- ADDITIVE ONLY. New table is service-role-only / deny-all (mirrors 0252).
-- Columns added to knowledge_documents/articles have safe defaults
-- (extraction_status='pending', visibility='all_staff') — behaviour-neutral on
-- apply (prod has 0 docs/articles today). Reserved 0266 (prod high-water 0265).
-- ═══════════════════════════════════════════════════════════════════════════

-- pgvector + pg_trgm live in the `extensions` schema on Supabase. Put it on the
-- search_path so the `vector` type, `<=>` operator, and trgm/hnsw opclasses
-- resolve during this migration; the search RPC re-pins its own search_path so
-- it's self-contained at call time too.
set search_path = public, extensions, pg_temp;

create extension if not exists vector with schema extensions;     -- embeddings
create extension if not exists pg_trgm with schema extensions;    -- fast ILIKE keyword arm

-- ── 1. knowledge_documents: extraction state machine + visibility ────────────
alter table public.knowledge_documents
  add column if not exists extraction_status text not null default 'pending',
  add column if not exists extracted_at      timestamptz,
  add column if not exists extract_error     text,
  add column if not exists visibility        text not null default 'all_staff';

alter table public.knowledge_documents drop constraint if exists knowledge_documents_extraction_status_chk;
alter table public.knowledge_documents add  constraint knowledge_documents_extraction_status_chk
  check (extraction_status in ('pending','processing','ready','partial','failed','unsupported'));

alter table public.knowledge_documents drop constraint if exists knowledge_documents_visibility_chk;
alter table public.knowledge_documents add  constraint knowledge_documents_visibility_chk
  check (visibility in ('all_staff','managers'));

comment on column public.knowledge_documents.extraction_status is
  'Reading lifecycle: pending|processing|ready|partial|failed|unsupported. Set by src/lib/knowledge/indexing.ts. ready/partial = content is AI-searchable; unsupported = scanned PDF or legacy .doc; failed = junk extract. Added 0266.';
comment on column public.knowledge_documents.visibility is
  'all_staff (default) or managers — enforced in search, list, AND signed-URL minting. Added 0266.';

-- ── 2. knowledge_articles: visibility ────────────────────────────────────────
alter table public.knowledge_articles
  add column if not exists visibility text not null default 'all_staff';

alter table public.knowledge_articles drop constraint if exists knowledge_articles_visibility_chk;
alter table public.knowledge_articles add  constraint knowledge_articles_visibility_chk
  check (visibility in ('all_staff','managers'));

comment on column public.knowledge_articles.visibility is
  'all_staff (default) or managers — enforced in search + list. Added 0266.';

-- ── 3. knowledge_chunks — one embedded passage per document/SOP slice ────────
-- @rls: service-role-only — all access via supabaseAdmin (search + indexing).
-- Polymorphic parent via two nullable FKs with a one-parent CHECK; both FKs
-- cascade on parent delete so chunks self-clean when a doc/SOP is removed.
-- `visibility` is denormalized from the parent so the vector-search RPC can
-- filter by role in one indexed predicate (re-synced by indexing.ts on change).
create table if not exists public.knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id)          on delete cascade,
  document_id uuid          references public.knowledge_documents(id) on delete cascade,
  article_id  uuid          references public.knowledge_articles(id)  on delete cascade,
  source_type text not null check (source_type in ('document','article')),
  chunk_index int  not null,
  content     text not null,
  section     text,
  visibility  text not null default 'all_staff' check (visibility in ('all_staff','managers')),
  embedding   extensions.vector(1536),   -- text-embedding-3-small; null = embedding failed/skipped (keyword still works)
  char_count  int,
  created_at  timestamptz not null default now(),
  -- Exactly one parent, AND source_type must match the populated column so a
  -- mislabeled row can't pass and surface on the wrong fetch path.
  constraint knowledge_chunks_one_parent check (
    (source_type = 'document' and document_id is not null and article_id is null)
    or (source_type = 'article' and article_id is not null and document_id is null)
  )
);

-- Idempotent: on re-apply against an already-migrated DB the table above is a
-- no-op, so (re)install the strengthened constraint explicitly.
alter table public.knowledge_chunks drop constraint if exists knowledge_chunks_one_parent;
alter table public.knowledge_chunks add constraint knowledge_chunks_one_parent check (
  (source_type = 'document' and document_id is not null and article_id is null)
  or (source_type = 'article' and article_id is not null and document_id is null)
);

comment on table public.knowledge_chunks is
  'Embedded passages of knowledge documents + SOPs for hybrid semantic/keyword search. property_id scoped, service-role-only (deny-all anon+authenticated). embedding = OpenAI text-embedding-3-small (1536d). Added 0266.';

create index if not exists knowledge_chunks_property_idx on public.knowledge_chunks (property_id);
create index if not exists knowledge_chunks_document_idx on public.knowledge_chunks (document_id);
create index if not exists knowledge_chunks_article_idx  on public.knowledge_chunks (article_id);
-- Keyword arm: trigram GIN over content for fast ILIKE (exact part numbers, names).
create index if not exists knowledge_chunks_content_trgm_idx
  on public.knowledge_chunks using gin (content extensions.gin_trgm_ops);
-- Vector arm: HNSW cosine over non-null embeddings. Scales where ILIKE-over-100KB
-- would not (300-hotel target). Partial so null-embedding rows aren't indexed.
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

-- ── 4. RLS — service-role only; anon + authenticated deny-all (mirror 0252) ──
alter table public.knowledge_chunks enable row level security;
revoke all on public.knowledge_chunks from public, anon, authenticated;
grant select, insert, update, delete on public.knowledge_chunks to service_role;
drop policy if exists knowledge_chunks_deny_all on public.knowledge_chunks;
create policy knowledge_chunks_deny_all on public.knowledge_chunks
  for all to anon, authenticated using (false) with check (false);

-- ── 5. Hybrid-search vector RPC ──────────────────────────────────────────────
-- Returns the top chunks by cosine similarity, scoped to the property and the
-- caller's role (manager-only chunks hidden unless p_include_manager_only).
-- SECURITY INVOKER (default) — only ever called by supabaseAdmin (service_role),
-- which holds the table grant and bypasses RLS. search_path pinned so `<=>`
-- and the vector cast resolve regardless of the caller's default path.
create or replace function public.staxis_search_knowledge_chunks(
  p_property_id          uuid,
  p_query_embedding      text,        -- pgvector text literal: '[0.1,0.2,...]'
  p_include_manager_only boolean,
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
    and (p_include_manager_only or c.visibility = 'all_staff')
  order by c.embedding <=> p_query_embedding::extensions.vector(1536)
  limit greatest(1, least(coalesce(p_match_count, 8), 50));
$$;

revoke all on function public.staxis_search_knowledge_chunks(uuid, text, boolean, int) from public, anon, authenticated;
grant execute on function public.staxis_search_knowledge_chunks(uuid, text, boolean, int) to service_role;

-- ── 6. Bookkeeping + schema reload ──────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0266',
  'Knowledge document reading: pgvector + pg_trgm; knowledge_chunks (embedded passages, HNSW + trgm indexes, service-role-only deny-all); extraction state machine (extraction_status/extracted_at/extract_error) + visibility (all_staff|managers) on knowledge_documents + knowledge_articles; staxis_search_knowledge_chunks hybrid-search RPC (property + role scoped).'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
