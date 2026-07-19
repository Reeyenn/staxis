# Inventory 0324 deployment gate

Migration `0324_inventory_operational_corrections.sql` keeps legacy archived
items out of active inventory totals, but it deliberately refuses to turn an
unverified archive into a fake zero during month close.

## Required production preflight

Run the checked-in gate as the migration owner immediately after applying 0324
and before enabling the new month-close flow:

```bash
npx tsx scripts/check-inventory-0324-archive-preflight.ts
```

It prints aggregate counts only and exits nonzero when the release must stop.
The equivalent read-only SQL for manual use in the production SQL editor is:

```sql
select
  i.property_id,
  i.id as item_id,
  i.name,
  i.archived_at,
  i.current_stock,
  coalesce(i.set_aside, 0) as set_aside,
  case
    when i.current_stock <> 0 or coalesce(i.set_aside, 0) <> 0
      then 'BLOCKED_STOCK_BALANCE'
    else 'NEEDS_PHYSICAL_ZERO_VERIFICATION'
  end as required_action
from public.inventory i
where i.archived_at is not null
  and (
    i.current_stock <> 0
    or coalesce(i.set_aside, 0) <> 0
    or (
      public.staxis_inventory_has_stock_evidence(i.property_id, i.id)
      and not exists (
        select 1
        from public.staxis_inventory_archive_zero_evidence(i.property_id, i.id)
      )
    )
  )
order by i.property_id, i.name, i.id;
```

The go-live result is **zero rows**. Do not grant browser roles access to the
two internal evidence helpers just to run this check.

## Repairing a zero-stock legacy archive

Only a row marked `NEEDS_PHYSICAL_ZERO_VERIFICATION` may use the recovery RPC.
A manager must first physically confirm that on-hand and set-aside are both
zero. Keep one generated request UUID per item and reuse it if the call is
retried:

```sql
begin;
select set_config('request.jwt.claim.role', 'service_role', true);

select public.staxis_verify_legacy_archived_inventory_zero(
  '<property_id>'::uuid,
  '<stable_request_uuid>'::uuid,
  '<item_id>'::uuid,
  '<exact_archived_at_from_preflight>'::timestamptz,
  '<person_who_physically_verified>',
  '<where/how zero stock was verified>'
);

commit;
```

This appends an immutable zero count at the real verification time. It does not
backdate history or change live stock. Rerun the preflight after every repair.

## Stocked archived rows

`BLOCKED_STOCK_BALANCE` is a stop condition. Do not directly set the quantity
to zero and do not run the legacy verifier. Investigate with the hotel, restore
the item to the active workflow under an approved support procedure, record a
real count/loss/correction, and archive it again with that evidence. Until
resolved, affected month close remains fail-closed by design.
