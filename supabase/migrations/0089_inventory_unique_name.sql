-- Migration 0088: prevent duplicate inventory item names per property
--
-- Adversarial review (2026-05-13) finding I-C5: src/app/inventory/page.tsx:1138
-- looks up the photo-counted item via items.find(i => i.name === c.item_name).
-- The inventory schema has no UNIQUE on (property_id, name), so two items
-- named "Bath Towels" (e.g. one in housekeeping category and another in
-- maintenance after a category re-org) silently collide on .find — the
-- count gets applied to whichever row Postgres returned first. Wrong
-- stock numbers, wrong reorder list, wrong category accounting, no warning.
--
-- This migration adds a partial unique index (case-insensitive) so the DB
-- rejects duplicates at write time. The UI fix (E.9) handles disambiguation
-- if a duplicate already exists; this index prevents new ones from being
-- created.
--
-- Defensive backfill: log existing duplicates before applying the index.
-- We do NOT auto-merge (data loss risk) — the index will simply fail to
-- create if duplicates exist, and ops can review.

do $$
declare
  v_dup_count int;
begin
  select count(*) into v_dup_count
  from (
    select property_id, lower(name) as nname
    from public.inventory
    where name is not null
    group by property_id, lower(name)
    having count(*) > 1
  ) dups;

  if v_dup_count > 0 then
    raise warning
      'inventory has % duplicate (property_id, lower(name)) groups. The unique index below will FAIL to create. Resolve duplicates first.', v_dup_count;
  end if;
end $$;

create unique index if not exists inventory_property_name_unique_idx
  on public.inventory (property_id, lower(name))
  where name is not null;

comment on index public.inventory_property_name_unique_idx is
  'Case-insensitive unique constraint on inventory item names within a property. Prevents the photo-count item-match collision bug. Codex adversarial review 2026-05-13 (I-C5).';

insert into public.applied_migrations (version, description)
values ('0089', 'Codex review: case-insensitive unique index on inventory item names (I-C5)')
on conflict (version) do nothing;
