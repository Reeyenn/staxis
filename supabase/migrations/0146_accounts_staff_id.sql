-- Migration 0119: link accounts to staff
--
-- The redesigned /staff page splits into a manager view (canManageTeam roles)
-- and a "My Shifts" staff view (housekeeping / front_desk / maintenance /
-- staff). For the staff view to scope to "your own shifts", we need to know
-- which staff roster row this logged-in account *is*. There was no such link
-- before — accounts.role told us the kind of person, but not which `staff.id`
-- they map to.
--
-- This adds a nullable FK on accounts → staff. Manager assigns the link from
-- the Directory edit modal ("Linked login (optional)" field). When null, the
-- staff view shows a friendly "Ask your manager to link your account" state
-- instead of a broken empty view.
--
-- on delete set null: if a staff row is deleted, we don't want to delete the
-- account — we just want to break the link so the account falls back to the
-- "no staff record" state and can be re-linked later.

alter table public.accounts
  add column if not exists staff_id uuid references public.staff(id) on delete set null;

create index if not exists idx_accounts_staff_id
  on public.accounts(staff_id)
  where staff_id is not null;

-- ─── Bookkeeping ────────────────────────────────────────────────────
-- Backfilled to match the row already present in prod's applied_migrations
-- (migration was applied via psql before the file landed on main).
-- Closes the migration-bookkeeping test failure that the staff page PR
-- triggered when it merged without this INSERT.
insert into public.applied_migrations (version, description)
values ('0146', 'accounts.staff_id link → staff (for /staff My Shifts role-gated view)')
on conflict (version) do nothing;
