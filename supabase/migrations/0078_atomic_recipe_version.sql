-- Migration 0078: atomic recipe-version allocator
--
-- Codex audit (2026-05-12) flagged a race in src/lib/pms/recipe-loader.ts
-- saveDraftRecipe(): it does SELECT max(version) → JS-increment → INSERT.
-- Two concurrent CUA mappings for the same pms_type can both observe
-- version N, both try to insert N+1, and one trips the
-- pms_recipes_pms_type_version_key UNIQUE (pms_type, version) constraint
-- (migration 0033). Batch G mitigated this with a JS retry loop, but a
-- proper fix serializes the version compute inside Postgres.
--
-- Design: advisory lock keyed on pms_type so concurrent calls serialize
-- only against the same PMS, plus one combined RPC that reads the next
-- version + inserts the row in a single transaction. Caller no longer
-- needs the retry loop.
--
-- Advisory lock vs sequence: we keep the version column an INTEGER
-- maintained by application logic so we don't change the pms_recipes
-- shape. Per-pms_type sequences would need DDL for every new PMS — the
-- advisory lock approach has zero ongoing maintenance.

create or replace function public.staxis_insert_draft_recipe(
  p_pms_type text,
  p_recipe jsonb,
  p_learned_by_property_id uuid,
  p_notes text
)
returns table(id uuid, version integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_id uuid;
  v_version integer;
begin
  -- Lock against concurrent inserts for THIS pms_type only.
  -- 'x' || first 16 hex of md5 → cast through bit(64) to bigint produces
  -- a deterministic per-pms_type lock key without colliding with other
  -- advisory-lock callers (no integer-only keys in use elsewhere).
  v_lock_key := ('x' || substr(md5('pms_recipes:' || p_pms_type), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- Compute next version under the lock.
  select coalesce(max(version), 0) + 1 into v_version
  from public.pms_recipes
  where pms_type = p_pms_type;

  -- Insert. With the lock held, this can't race against another
  -- staxis_insert_draft_recipe for the same pms_type. Other writers
  -- (manual SQL, hypothetical future code) would still race but those
  -- paths are not used in production.
  insert into public.pms_recipes (
    pms_type, version, recipe, status,
    learned_by_property_id, notes
  ) values (
    p_pms_type, v_version, p_recipe, 'draft',
    p_learned_by_property_id, p_notes
  )
  returning pms_recipes.id into v_id;

  return query select v_id, v_version;
end;
$$;

comment on function public.staxis_insert_draft_recipe is
  'Atomically allocate next pms_recipes.version for a pms_type and insert a draft row. Serializes concurrent inserts via pg_advisory_xact_lock keyed on the pms_type. Replaces the JS retry-on-23505 loop in saveDraftRecipe(). Codex audit 2026-05-12.';

revoke execute on function public.staxis_insert_draft_recipe(text, jsonb, uuid, text) from public;
revoke execute on function public.staxis_insert_draft_recipe(text, jsonb, uuid, text) from anon, authenticated;
grant  execute on function public.staxis_insert_draft_recipe(text, jsonb, uuid, text) to   service_role;

insert into public.applied_migrations (version, description)
values ('0078', 'Codex audit: atomic recipe-version RPC (replaces JS retry loop)')
on conflict (version) do nothing;
