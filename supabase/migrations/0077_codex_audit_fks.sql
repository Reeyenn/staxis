-- Migration 0077: add missing FK constraints to per-tenant columns
--
-- Codex audit (2026-05-12) flagged two tables whose property_id column
-- has no FK to properties(id). Orphan rows are possible if an upstream
-- bug or service-role RPC writes a nonexistent property_id, which
-- contaminates analytics and tenant cleanup.
--
-- Both tables are append-only / service-role-only in normal operation,
-- so the risk surface is small — but defense-in-depth costs nothing
-- here and an explicit FK lets cascade-delete clean up properly when
-- a property is removed.
--
-- Safety:
--   - DELETE orphans first (rows whose property_id no longer points at
--     a real properties row). Both tables are recoverable from upstream
--     sources (rate limits are time-bucketed; history is reproducible
--     from inventory_rate_predictions writes).
--   - Add the constraint as VALID (no NOT VALID needed — orphan cleanup
--     above guarantees the validation will pass).
--   - ON DELETE CASCADE so when a property is deleted, both audit
--     trails get cleaned up rather than left as zombie rows.

-- ─── api_limits ───────────────────────────────────────────────────────
-- Time-bucketed rate-limit counts. Pruning is handled by a separate
-- digest job (see 0008 comment). Orphans here are old rows for
-- since-deleted properties — safe to delete outright.

delete from public.api_limits
where property_id not in (select id from public.properties);

alter table public.api_limits
  add constraint api_limits_property_id_fkey
  foreign key (property_id) references public.properties(id)
  on delete cascade;

-- ─── inventory_rate_prediction_history ────────────────────────────────
-- Insert-only audit of ML inventory predictions. Orphans here would
-- be history rows from deleted properties — also safe to drop.

delete from public.inventory_rate_prediction_history
where property_id not in (select id from public.properties);

alter table public.inventory_rate_prediction_history
  add constraint inventory_rate_prediction_history_property_id_fkey
  foreign key (property_id) references public.properties(id)
  on delete cascade;

-- ─── Bookkeeping ──────────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values ('0077', 'Codex audit: FK constraints on api_limits + inventory_rate_prediction_history')
on conflict (version) do nothing;
