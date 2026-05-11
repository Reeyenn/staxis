-- 0072_harden_ml_shadow_and_exec_sql.sql
-- Hardening pass after a senior-engineer review of Tier 2 Phase 5 + the
-- exec_sql helper migration (0071). Three real issues this addresses:
--
--   1. exec_sql() accepted ANY SQL — including DML/DDL. Service-role
--      already has full DB access, but exec_sql also runs raw text from
--      callers via SECURITY DEFINER, so the moment any caller f-strings
--      user input into the SQL (which several training paths do, gated
--      by UUID validation but only one bad caller away from injection),
--      the whole DB is reachable. Now SELECT/WITH-only at the function
--      level — DML/DDL prefix is rejected with a clear exception.
--
--   2. model_runs has NO uniqueness invariant on "one active per
--      (property, layer, item)" or "one in-flight shadow per slot".
--      Phase 5's shadow gating had a subtle accumulation bug (shadow
--      retrains don't deactivate the previous shadow) — without a DB
--      constraint the bad state would silently grow. Adding partial-
--      unique indexes per slot so the bug is caught at write time.
--
--   3. ml-shadow-evaluate's promotion path does TWO separate UPDATEs
--      (deactivate old active, then flip shadow to active). A failure
--      between them leaves an item with no active model and inventory
--      predictions stop until next retrain. Now a single SECURITY
--      DEFINER function does the swap in one statement; either both
--      rows transition or neither does.
--
-- The Phase 5 training code change ships in the same commit so the
-- accumulation bug is fixed in code AND prevented at the DB layer.

-- ─── 1. exec_sql: SELECT/WITH only ──────────────────────────────────────
create or replace function public.exec_sql(sql text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  trimmed text;
  upper_prefix text;
begin
  -- Strip leading whitespace + comments, then require the statement to
  -- begin with SELECT or WITH. This is defense in depth, not a perfect
  -- SQL parser — but it eliminates the trivial DML/DDL injection paths
  -- and pushes any future "I just need to UPDATE one row" caller to do
  -- it the right way (write a real named function, or use the supabase
  -- builder).
  trimmed := regexp_replace(sql, '^[\s\n\r\t]+', '');
  -- Also peel off a leading SQL comment line (-- ...) if present.
  trimmed := regexp_replace(trimmed, '^--[^\n]*\n[\s\n\r\t]*', '');
  upper_prefix := upper(left(trimmed, 6));
  if not (
    upper_prefix like 'SELECT%' or
    upper_prefix like 'WITH %' or
    upper_prefix like 'WITH('
  ) then
    raise exception
      'exec_sql: only SELECT or WITH queries are permitted (got: %)',
      left(trimmed, 50);
  end if;

  execute format(
    'select coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb) from (%s) t',
    sql
  ) into result;
  return result;
end;
$$;

comment on function public.exec_sql(text) is
  'ML service helper: execute a SELECT or WITH query and return rows as jsonb. DML/DDL are rejected at the function level (hardened in migration 0072 after a senior-engineer review). EXECUTE grant remains service_role-only.';

revoke all on function public.exec_sql(text) from public, anon, authenticated;
grant execute on function public.exec_sql(text) to service_role;

-- ─── 2. model_runs uniqueness ───────────────────────────────────────────
-- Two partial-unique indexes per "slot" (item-scoped vs property-scoped),
-- one for active, one for in-flight shadow. Without these, the
-- application code carries the burden of maintaining the invariant
-- alone; with them, a bug in shadow gating or evaluate-cron promotion
-- surfaces as a constraint violation instead of silently corrupting
-- state.
--
-- Why partial: we want exactly-one-active-per-slot, but multiple
-- inactive/historical rows are fine (and necessary — we keep training
-- history). Partial WHERE clauses scope uniqueness to the live state.

create unique index if not exists model_runs_one_active_per_item_idx
  on public.model_runs (property_id, layer, item_id)
  where is_active = true and is_shadow = false and item_id is not null;

comment on index public.model_runs_one_active_per_item_idx is
  'Exactly one active (non-shadow) run per (property, layer, item). Catches stale-active bugs at write time. Item-scoped slot: inventory_rate.';

create unique index if not exists model_runs_one_active_no_item_idx
  on public.model_runs (property_id, layer)
  where is_active = true and is_shadow = false and item_id is null;

comment on index public.model_runs_one_active_no_item_idx is
  'Exactly one active (non-shadow) run per (property, layer) for property-scoped layers (demand, supply, optimizer).';

create unique index if not exists model_runs_one_shadow_per_item_idx
  on public.model_runs (property_id, layer, item_id)
  where is_shadow = true and shadow_promoted_at is null and item_id is not null;

comment on index public.model_runs_one_shadow_per_item_idx is
  'Exactly one in-flight shadow per (property, layer, item). Prevents the shadow-accumulation class of bug where weekly retrains pile up shadows that all soak in parallel.';

create unique index if not exists model_runs_one_shadow_no_item_idx
  on public.model_runs (property_id, layer)
  where is_shadow = true and shadow_promoted_at is null and item_id is null;

comment on index public.model_runs_one_shadow_no_item_idx is
  'Exactly one in-flight shadow per (property, layer) for property-scoped layers.';

-- ─── 3. Atomic shadow promotion ─────────────────────────────────────────
-- A single statement that flips one row from active→inactive and another
-- row from shadow→active. Either both succeed or neither does. Callers
-- (the daily ml-shadow-evaluate cron) get atomicity for free instead of
-- carrying retry/rollback logic.
create or replace function public.promote_shadow_model_run(
  p_shadow_id uuid,
  p_active_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_shadow_id is null then
    raise exception 'promote_shadow_model_run: p_shadow_id is required';
  end if;

  -- Single statement updates both rows. Postgres applies the row updates
  -- atomically within the statement; a failure on either row rolls back
  -- the whole thing.
  update public.model_runs
  set
    is_active        = case
                         when id = p_active_id then false
                         when id = p_shadow_id then true
                         else is_active
                       end,
    is_shadow        = case when id = p_shadow_id then false else is_shadow end,
    shadow_promoted_at = case when id = p_shadow_id then now() else shadow_promoted_at end,
    activated_at     = case when id = p_shadow_id then now() else activated_at end,
    deactivated_at   = case when id = p_active_id then now() else deactivated_at end,
    deactivation_reason = case when id = p_active_id then 'superseded_by_shadow_promotion' else deactivation_reason end
  where id in (p_shadow_id, p_active_id);
end;
$$;

comment on function public.promote_shadow_model_run(uuid, uuid) is
  'Atomic shadow→active promotion. Single UPDATE flips both rows so the previous active is deactivated and the shadow is activated in one transaction. Used by /api/cron/ml-shadow-evaluate.';

revoke all on function public.promote_shadow_model_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.promote_shadow_model_run(uuid, uuid) to service_role;

-- ─── Bookkeeping ────────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0072', 'harden Tier 2 Phase 5: read-only exec_sql, model_runs uniqueness, atomic shadow promotion')
on conflict (version) do nothing;
