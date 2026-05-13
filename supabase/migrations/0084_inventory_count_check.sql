-- Migration 0082: floor on inventory_counts.counted_stock
--
-- Adversarial review (2026-05-13) flagged that the inventory page allows
-- negative count entries to persist:
--   - src/app/inventory/page.tsx:1187 uses parseInt(...) || 0 which permits
--     negative integers (only NaN/empty/0 fall through to the || branch).
--   - The HTML `min="0"` attribute is not enforced when JS reads
--     e.target.value.
--   - There was no DB CHECK constraint as a final guard.
--
-- Negative counts corrupt burn-rate math, anomaly detection, and the
-- shadow-MAE feedback loop that gates model graduation. UI clamping (E.5)
-- catches user errors at the keystroke; this CHECK is the durable floor.

-- Backfill any existing negatives to 0 so the constraint can be applied.
-- This SHOULD be a no-op in production today (no UI path produces negatives
-- on save), but defensive: an offline import or hand-fix could have leaked
-- one in. Better to clamp than to fail the migration.
update public.inventory_counts
set counted_stock = 0
where counted_stock < 0;

alter table public.inventory_counts
  add constraint inventory_counts_counted_stock_nonneg
  check (counted_stock >= 0);

comment on constraint inventory_counts_counted_stock_nonneg
  on public.inventory_counts is
  'Floor: rejects negative counted_stock. UI also clamps; DB is the safety net. Codex adversarial review 2026-05-13 (I-C7).';

insert into public.applied_migrations (version, description)
values ('0084', 'Codex review: CHECK constraint on inventory_counts.counted_stock (I-C7)')
on conflict (version) do nothing;
