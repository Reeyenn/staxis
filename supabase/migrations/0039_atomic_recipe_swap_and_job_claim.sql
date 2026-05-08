-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0039: atomic recipe swap + atomic job claim + force_remap flag
--
-- Two HIGH findings from review pass 3:
--
--   H7 — /api/admin/regenerate-recipe demoted the active recipe BEFORE
--        queuing the new mapping job. Recipes are scoped per-pms_type
--        (not per-property), so demoting cloudbeds' active recipe for
--        Property A breaks cloudbeds for Properties B, C, D until the
--        new mapping run lands. Plus the demote-then-queue sequence
--        wasn't atomic — a queue failure left the fleet recipe-less.
--
--        Fix: don't eager-demote. Let the worker swap atomically
--        AT SUCCESS TIME using staxis_swap_active_recipe() — a single
--        plpgsql function that demotes-then-promotes inside one
--        transaction. If the promote fails, the demote rolls back too.
--
--        Also adds onboarding_jobs.force_remap so the worker can run
--        the mapper even when an active recipe exists (which the
--        regenerate path needs — it explicitly wants a fresh map).
--
--   H8 — cua-service/src/index.ts claimNextJob did SELECT-then-UPDATE
--        scoped by .eq('status','queued'). Works today by accident
--        (PostgREST + READ COMMITTED happens to serialize correctly)
--        but is load-bearing on internals. Add a proper Postgres
--        function using FOR UPDATE SKIP LOCKED so multiple workers
--        can claim concurrently with truly atomic semantics. The
--        cua-service worker switches to RPC in the same PR.
--
-- All changes safe to apply on a live DB — additive only, no breaking
-- schema changes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. onboarding_jobs.force_remap column ─────────────────────────────

alter table public.onboarding_jobs
  add column if not exists force_remap boolean not null default false;

comment on column public.onboarding_jobs.force_remap is
  'When true, the worker runs the CUA mapper even if an active recipe exists for this pms_type. Used by /api/admin/regenerate-recipe to refresh a stale recipe without taking the fleet offline first.';

-- ─── 2. staxis_swap_active_recipe — atomic demote+promote ─────────────

create or replace function public.staxis_swap_active_recipe(
  p_new_recipe_id uuid,
  p_pms_type      text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Demote any currently-active recipes for this pms_type FIRST. This
  -- frees the partial-unique constraint slot from migration 0032
  -- (`UNIQUE (pms_type) WHERE status='active'`) so the subsequent
  -- promote can succeed.
  update public.pms_recipes
  set status = 'deprecated'
  where pms_type = p_pms_type
    and status = 'active'
    and id <> p_new_recipe_id;

  -- Now promote. If this update affects 0 rows (recipe was deleted, wrong
  -- UUID, etc.), RAISE so the implicit transaction rolls back — including
  -- the demote — so the previous active recipe stays active and the fleet
  -- doesn't lose its mapping. (A 0-row UPDATE in plpgsql does NOT raise on
  -- its own; we have to check ROW_COUNT explicitly.)
  update public.pms_recipes
  set status = 'active'
  where id = p_new_recipe_id;
  if not found then
    raise exception 'staxis_swap_active_recipe: recipe % not found (was it deleted?)', p_new_recipe_id;
  end if;
end;
$$;

comment on function public.staxis_swap_active_recipe is
  'Atomically demotes existing active recipes for a pms_type and promotes the new one. If promote fails the demote rolls back — the fleet never goes recipe-less. Use from cua-service after a successful mapping run.';

-- ─── 3. staxis_claim_next_job — atomic FOR UPDATE SKIP LOCKED claim ───

create or replace function public.staxis_claim_next_job(
  p_worker_id text
)
returns table (
  id            uuid,
  property_id   uuid,
  pms_type      text,
  force_remap   boolean,
  worker_id     text,
  started_at    timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- The CTE picks the oldest queued job and locks the row, skipping any
  -- rows already locked by other concurrent claim calls. This gives
  -- multiple workers truly atomic claim semantics — no two workers
  -- can ever pick the same job, even under high concurrency.
  return query
  with picked as (
    select j.id
    from public.onboarding_jobs j
    where j.status = 'queued'
    order by j.created_at
    limit 1
    for update skip locked
  )
  update public.onboarding_jobs j
  set
    status     = 'running',
    worker_id  = p_worker_id,
    started_at = now(),
    step       = 'starting',
    progress_pct = 5
  from picked
  where j.id = picked.id
  returning j.id, j.property_id, j.pms_type, j.force_remap, j.worker_id, j.started_at;
end;
$$;

comment on function public.staxis_claim_next_job is
  'Atomically claims the next queued onboarding_job for the given worker, using FOR UPDATE SKIP LOCKED. Returns the row if one was claimed, empty if no queued jobs.';

-- ─── 4. Lock down access — service_role only (matches 0037 pattern) ──

revoke execute on function public.staxis_swap_active_recipe(uuid, text) from public;
revoke execute on function public.staxis_swap_active_recipe(uuid, text) from anon, authenticated;
grant  execute on function public.staxis_swap_active_recipe(uuid, text) to   service_role;

revoke execute on function public.staxis_claim_next_job(text) from public;
revoke execute on function public.staxis_claim_next_job(text) from anon, authenticated;
grant  execute on function public.staxis_claim_next_job(text) to   service_role;

-- ─── Record migration ───────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0039', 'atomic recipe swap + atomic job claim + force_remap flag')
on conflict (version) do nothing;
