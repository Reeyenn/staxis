# Staged inventory-ML migrations — REVIEW + APPLY BY HAND

These two DDL changes are part of the inventory-ML improvements on
`chat/inventory-ml`, but they are **NOT applied** and **NOT committed as numbered
`supabase/migrations/*.sql` files**. Reasons:

- I can't run Postgres locally to validate them, and the repo applies migrations
  to prod **manually** — an untested `.sql` that looks "applied" is a trap.
- Parallel sessions are actively taking migration numbers (latest on this branch
  is `0285`), so a hard-coded `0286` would likely collide.

**How to apply:** load the `database-changes` skill, paste each block, let it
assign the next free number + run it against prod, then
`NOTIFY pgrst, 'reload schema';`. Both are `CREATE OR REPLACE` (reversible) and
**safe-degrading** (they only ever return *fewer* rows; consumers already handle
a missing row by skipping it).

---

## Migration A — observed-rate view: match the trainer's window hygiene

**Why:** the trainer + cohort-prior SQL now train ONLY on windows with observed
consumption `> 0` (dropping auto-stock-up / unexplained-increase windows — see
`INVENTORY_ML_LOG.md` change [5]). But `inventory_observed_rate_v` still
`greatest(..., 0)`-clamps those windows to a fake 0-rate. That view feeds
`post-count-process` → `prediction_log` → the realized-MAE backtest + the
graduation gate, so today **training and its own accuracy scorecard disagree on
which windows count.** This aligns them.

**Change vs `0096`:** drop the `greatest(..., 0)` clamp and add a
`consumption > 0` filter to the final `WHERE`. Everything else is identical.

```sql
create or replace view public.inventory_observed_rate_v as
with paired_counts as (
  select
    c.id              as newer_count_id,
    c.property_id,
    c.item_id,
    c.counted_at      as newer_counted_at,
    c.counted_stock   as newer_stock,
    lag(c.id)            over w as older_count_id,
    lag(c.counted_at)    over w as older_counted_at,
    lag(c.counted_stock) over w as older_stock
  from public.inventory_counts c
  window w as (partition by c.item_id order by c.counted_at asc, c.id asc)
),
windowed_movements as (
  select
    p.newer_count_id, p.property_id, p.item_id,
    p.older_counted_at, p.newer_counted_at, p.older_stock, p.newer_stock,
    coalesce((
      select sum(o.quantity) from public.inventory_orders o
      where o.item_id = p.item_id and o.property_id = p.property_id
        and o.received_at >  p.older_counted_at
        and o.received_at <= p.newer_counted_at
    ), 0)::numeric as orders_in_window,
    coalesce((
      select sum(d.quantity) from public.inventory_discards d
      where d.item_id = p.item_id and d.property_id = p.property_id
        and d.discarded_at >  p.older_counted_at
        and d.discarded_at <= p.newer_counted_at
    ), 0)::numeric as discards_in_window,
    extract(epoch from (p.newer_counted_at - p.older_counted_at)) / 86400.0 as raw_days_elapsed
  from paired_counts p
  where p.older_count_id is not null
)
select
  w.newer_count_id, w.property_id, w.item_id,
  w.older_counted_at, w.newer_counted_at, w.older_stock, w.newer_stock,
  w.orders_in_window, w.discards_in_window,
  w.raw_days_elapsed::numeric as days_elapsed,
  -- No greatest(...,0) clamp: only windows with observed consumption > 0
  -- survive the WHERE below, matching training/inventory_rate.py and
  -- inventory_priors.py (drop auto-stock-up / unexplained-increase windows).
  ((w.older_stock + w.orders_in_window - w.discards_in_window - w.newer_stock)
    / w.raw_days_elapsed)::numeric as observed_rate
from windowed_movements w
where w.raw_days_elapsed >= 1.0
  and (w.older_stock + w.orders_in_window - w.discards_in_window - w.newer_stock) > 0;

comment on view public.inventory_observed_rate_v is
  'Per-item observed daily consumption rate between consecutive counts. Mirrors the Python trainer + cohort-prior SQL: drops sub-day pairs and windows with consumption <= 0 (auto-stock-up / unexplained increase).';

grant select on public.inventory_observed_rate_v to service_role;
```

---

## Migration B — broaden the canonical-name map (cold-start coverage)

**Why:** `item_canonical_name_view` is a ~20-pattern `CASE`. Any item it doesn't
recognise resolves to `'unknown'`, gets **no cohort prior**, and falls to the
flat `DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY = 0.20`. At 300 hotels with varied
naming, a lot of real items (amenity kits, mouthwash, q-tips, coffee filters,
napkins, water bottles, etc.) get no network signal on day 1. This is purely
additive synonym coverage + a coarse `item_category` column for the optional
phase-2 category-tier fallback (below).

```sql
create or replace view item_canonical_name_view as
select
  inv.id          as item_id,
  inv.property_id as property_id,
  inv.name        as item_name,
  case
    when lower(inv.name) like '%shampoo%'                              then 'shampoo'
    when lower(inv.name) like '%conditioner%'                          then 'conditioner'
    when lower(inv.name) like '%body wash%' or lower(inv.name) like '%bodywash%' then 'body wash'
    when lower(inv.name) like '%lotion%'                               then 'lotion'
    when lower(inv.name) like '%mouthwash%'                            then 'mouthwash'
    when lower(inv.name) like '%q-tip%' or lower(inv.name) like '%qtip%' or lower(inv.name) like '%cotton swab%' then 'cotton swab'
    when lower(inv.name) like '%cotton ball%' or lower(inv.name) like '%cotton round%' then 'cotton ball'
    when lower(inv.name) like '%shower cap%'                           then 'shower cap'
    when lower(inv.name) like '%shave%' or lower(inv.name) like '%razor%' then 'razor'
    when lower(inv.name) like '%dental%' or lower(inv.name) like '%toothbrush%' or lower(inv.name) like '%toothpaste%' then 'dental kit'
    when lower(inv.name) like '%sewing kit%'                           then 'sewing kit'
    when lower(inv.name) like '%amenity%' or lower(inv.name) like '%vanity kit%' then 'amenity kit'
    when lower(inv.name) like '%sanitizer%'                            then 'hand sanitizer'
    when lower(inv.name) like '%soap%' and lower(inv.name) not like '%dispenser%' then 'soap'
    when lower(inv.name) like '%bath%towel%' or lower(inv.name) like '%towel%bath%' then 'towel bath'
    when lower(inv.name) like '%hand%towel%' or lower(inv.name) like '%towel%hand%' then 'towel hand'
    when lower(inv.name) like '%wash%cloth%' or lower(inv.name) like '%washcloth%' or lower(inv.name) like '%towel%wash%' then 'towel wash'
    when lower(inv.name) like '%pool towel%'                           then 'towel pool'
    when lower(inv.name) like '%bath mat%' or lower(inv.name) like '%floor mat%' then 'bath mat'
    when lower(inv.name) like '%robe%'                                 then 'robe'
    when lower(inv.name) like '%toilet%paper%' or lower(inv.name) like '%tp %' or lower(inv.name) = 'tp' then 'toilet paper'
    when lower(inv.name) like '%paper towel%'                          then 'paper towel'
    when lower(inv.name) like '%napkin%'                               then 'napkin'
    when lower(inv.name) like '%tissue%' or lower(inv.name) like '%kleenex%' then 'tissues'
    when lower(inv.name) like '%cup%' and (lower(inv.name) like '%paper%' or lower(inv.name) like '%plastic%') then 'paper cup'
    when lower(inv.name) like '%coffee%pod%' or lower(inv.name) like '%k-cup%' or lower(inv.name) like '%coffee%cup%' then 'coffee pod'
    when lower(inv.name) like '%coffee filter%'                        then 'coffee filter'
    when lower(inv.name) like '%stir%'                                 then 'coffee stirrer'
    when lower(inv.name) like '%tea%bag%' or lower(inv.name) like '%tea %' then 'tea bag'
    when lower(inv.name) like '%sugar%'                                then 'sugar packet'
    when lower(inv.name) like '%sweetener%'                            then 'sweetener'
    when lower(inv.name) like '%creamer%' or lower(inv.name) like '%cream%coffee%' then 'creamer'
    when lower(inv.name) like '%water%bottle%' or lower(inv.name) like '%bottled water%' then 'water bottle'
    when lower(inv.name) like '%sheet%king%' or lower(inv.name) like '%king%sheet%' then 'sheet king'
    when lower(inv.name) like '%sheet%queen%' or lower(inv.name) like '%queen%sheet%' then 'sheet queen'
    when lower(inv.name) like '%sheet%twin%' or lower(inv.name) like '%twin%sheet%' then 'sheet twin'
    when lower(inv.name) like '%pillowcase%' or lower(inv.name) like '%pillow%case%' then 'pillowcase'
    when lower(inv.name) like '%blanket%'                              then 'blanket'
    when lower(inv.name) like '%comforter%' or lower(inv.name) like '%duvet%' then 'comforter'
    when lower(inv.name) like '%mattress pad%' or lower(inv.name) like '%mattress protector%' then 'mattress pad'
    when lower(inv.name) like '%garbage%bag%' or lower(inv.name) like '%trash%bag%' or lower(inv.name) like '%bin%liner%' then 'garbage bag'
    when lower(inv.name) like '%laundry bag%'                          then 'laundry bag'
    when lower(inv.name) like '%cleaner%' or lower(inv.name) like '%multi%surface%' or lower(inv.name) like '%all%purpose%' then 'all-purpose cleaner'
    when lower(inv.name) like '%disinfect%' or lower(inv.name) like '%sanitiz%wipe%' then 'disinfectant'
    when lower(inv.name) like '%light bulb%' or lower(inv.name) like '%lightbulb%' then 'light bulb'
    when lower(inv.name) like '%batter%'                               then 'battery'
    else 'unknown'
  end as item_canonical_name,
  -- Coarse category for the optional phase-2 category-tier prior fallback.
  case
    when lower(inv.name) like any (array['%shampoo%','%conditioner%','%body wash%','%bodywash%','%lotion%','%soap%','%mouthwash%','%q-tip%','%qtip%','%cotton%','%shower cap%','%shave%','%razor%','%dental%','%toothbrush%','%toothpaste%','%sewing kit%','%amenity%','%vanity kit%','%sanitizer%']) then 'amenity'
    when lower(inv.name) like any (array['%toilet%paper%','%paper towel%','%napkin%','%tissue%','%kleenex%','%tp %','%cup%']) then 'paper'
    when lower(inv.name) like any (array['%towel%','%sheet%','%pillow%','%blanket%','%comforter%','%duvet%','%mattress%','%robe%','%bath mat%','%floor mat%']) then 'linen'
    when lower(inv.name) like any (array['%coffee%','%k-cup%','%tea%','%sugar%','%sweetener%','%creamer%','%stir%','%water%bottle%','%bottled water%']) then 'breakfast'
    when lower(inv.name) like any (array['%cleaner%','%multi%surface%','%all%purpose%','%disinfect%','%garbage%bag%','%trash%bag%','%bin%liner%','%laundry bag%','%light bulb%','%lightbulb%','%batter%']) then 'cleaning'
    else 'misc'
  end as item_category
from inventory inv;
```

### Optional phase-2 (after Migration B): category-tier prior fallback

Once `item_category` exists, the prior lookup can degrade
`canonical → category → global → default` so an item with an unrecognised name
still gets *some* network signal instead of the flat 0.20. This is a Python
change in `ml-service/src/training/`:

1. `inventory_priors.aggregate_inventory_priors` — also bucket each contributing
   rate by `item_category` and upsert `cohort_key='global', item_canonical_name='cat:<category>'`
   rows (reuse the same outlier-clip + sane-range guards).
2. `inventory_rate._lookup_prior_with_source` — when `canonical == 'unknown'`,
   read the item's `item_category` from the view and try
   `(cohort_key, 'cat:<category>')` then `('global', 'cat:<category>')` before
   returning `'default'`. Keep `prior_strength <= 1.0` for category-tier hits so
   real property data dominates quickly.

This is testable with the existing `_make_client` mock pattern (see
`tests/test_inventory_priors_aggregate.py`). Left for a follow-up because it
only pays off *after* Migration B is applied and the priors cron re-runs.
