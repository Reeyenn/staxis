-- 0321: inventory.set_aside — units owned but not usable right now.
--
-- One hotel keeps a "stained" pile: linens that can't go on a bed today but
-- may be recovered (rewash / repair), and they still count toward total
-- inventory value. Generalized as "set aside":
--
--   current_stock = TOTAL units on hand (usable + set aside). All value math
--                   (masthead, Reports, Compare, accounting) stays on
--                   current_stock and is unchanged by this column.
--   set_aside     = the portion of current_stock that can't be used today.
--   usable        = current_stock - set_aside (derived in the app; drives
--                   low-stock status and days-left, never stored).
--
-- No cap vs current_stock on purpose: stock moves via counts/deliveries and
-- a transient set_aside > current_stock (e.g. stock counted down before the
-- set-aside pile is updated) must not fail writes; the app clamps usable at 0.

alter table public.inventory
  add column if not exists set_aside integer not null default 0
  constraint inventory_set_aside_nonnegative check (set_aside >= 0);

insert into public.applied_migrations (version, description)
values ('0321', 'inventory.set_aside: unusable-but-owned units (stained linens etc.) — counted in value, excluded from usable stock')
on conflict (version) do nothing;
