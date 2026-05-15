-- Round 15 follow-up (2026-05-14): make INV-24 DB-enforced.
--
-- INV-24 says properties.total_rooms must equal array_length(room_inventory).
-- Round 15 enforced this via doctor check + Math.max in code, both of which
-- catch drift after the fact. This migration prevents drift from ever
-- existing by syncing total_rooms ← array_length(room_inventory) inside
-- a BEFORE INSERT/UPDATE trigger.
--
-- Why a trigger and not a generated column:
--   - The existing CHECK constraint properties_total_rooms_positive
--     (migration 0116) requires total_rooms > 0. A generated column
--     deriving from an empty inventory would produce 0, failing the
--     CHECK — which would break every property in its onboarding phase
--     before room_inventory is populated.
--   - Existing writers (src/app/api/admin/properties/create/route.ts
--     and src/app/onboard/page.tsx) set total_rooms directly. A
--     generated column would error their INSERTs. The trigger leaves
--     those writes working as-is when room_inventory is empty.
--
-- Behavior:
--   - INSERT with non-empty room_inventory → total_rooms = inventory.length
--   - INSERT with empty inventory → total_rooms keeps whatever the caller set
--     (the existing "onboarding wizard wrote total_rooms; inventory not yet
--     captured" state). Doctor's rooms_today_seeded check WARNs on this.
--   - UPDATE that changes room_inventory → total_rooms = inventory.length
--   - UPDATE that doesn't touch room_inventory → trigger no-ops; direct
--     total_rooms writes still work (admin can set total_rooms before
--     populating inventory).
--
-- Doctrine: "inventory wins." When the two disagree, the source-of-truth
-- room list (room_inventory) defines the count. Admins who think they
-- know better get overridden the moment they update inventory.

create or replace function staxis_sync_total_rooms_to_inventory()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.room_inventory is not null
       and array_length(new.room_inventory, 1) is not null then
      new.total_rooms := array_length(new.room_inventory, 1);
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.room_inventory is distinct from old.room_inventory then
    if new.room_inventory is not null
       and array_length(new.room_inventory, 1) is not null then
      new.total_rooms := array_length(new.room_inventory, 1);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists properties_sync_total_rooms on public.properties;

create trigger properties_sync_total_rooms
  before insert or update on public.properties
  for each row
  execute function staxis_sync_total_rooms_to_inventory();

comment on function staxis_sync_total_rooms_to_inventory() is
  'INV-24 enforcement: keeps properties.total_rooms = array_length(properties.room_inventory) when inventory is non-empty. See migration 0125 for rationale.';

insert into applied_migrations (version, description)
values ('0125', 'staxis_sync_total_rooms_to_inventory trigger — DB-level INV-24 enforcement')
on conflict (version) do nothing;
