-- ════════════════════════════════════════════════════════════════════════
-- 0377_ordering_manager.sql — AI Ordering Manager (AI employee #2)
-- ════════════════════════════════════════════════════════════════════════
-- Gives the hotel a screen that watches stock and preps orders. The screen is
-- STATE-AWARE: it only ever asks for what these tables do not already hold.
--
-- EXTENDS rather than adds. Migration 0246 provisioned `vendors`,
-- `purchase_orders` and `purchase_order_lines` and the July-2026 simplify pass
-- deleted the UI on top of them without dropping the tables. They are still
-- live, still service-role-only, and `inventory.vendor_id` still points at
-- `vendors`. This migration adds the four things 0246 had no concept of:
--
--   1. HOW you order from a vendor (email / website / store run / phone).
--      0246 assumed email for everyone. That assumption is the whole reason
--      the flow was deleted — "every hotel orders differently".
--   2. The vendor↔CATEGORY map. The product ruling: a 100-item hotel has 3-6
--      vendors, so you map vendors to the categories the hotel already has and
--      items INHERIT their vendor. Mapping per item would be 100 questions.
--   3. TOLD vs SUGGESTED. We pre-build a vendor list from the contacts
--      directory and from scanned invoices, but a guess must never render as
--      a fact. A row is a suggestion until a human taps confirm.
--   4. Whether the hotel has seen the one-time welcome.
--
-- Money stays where 0246 put it: purchase_orders.subtotal_cents and
-- purchase_order_lines.unit_cost_cents are INTEGER CENTS. inventory.unit_cost
-- and the inventory_orders receipt ledger stay DOLLARS. The boundary is
-- converted explicitly in src/lib/ordering/*.
--
-- Security: every table touched here is service-role-only. All access goes
-- through /api/inventory/* behind requireOrderingAccess (owner/GM/admin). The
-- one new table repeats that posture verbatim — RLS enabled, browser roles
-- revoked and explicitly denied. This sidesteps the RLS silent-empty-state
-- bug class: the browser never touches these tables.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Vendors: how you order, and whether we were told or we guessed ──────
--
-- order_method is NULLABLE ON PURPOSE and there is deliberately NO DEFAULT.
-- "How do you order from them?" is the one thing we can never infer from any
-- data we hold, so a null here is a REAL, DISPLAYABLE state — it renders as
-- the single missing-piece chip on the vendor row. Defaulting it to 'email'
-- would manufacture an answer nobody gave and would send the manager to a
-- button that emails a vendor who takes phone orders.
alter table public.vendors
  add column if not exists order_method text
    check (order_method is null or order_method in ('email','website','store','phone'));

-- Where a website vendor's order page lives. Only meaningful for
-- order_method='website'; enforced as a pair by the CHECK at the end.
alter table public.vendors
  add column if not exists website_url text;

-- THE LINK, NOT A COPY. The contacts directory (knowledge_contacts, category
-- 'vendor') is owned by the Knows tab and is where a manager already typed
-- their suppliers. A vendor pre-built from a contact points AT that row; it
-- does not duplicate the name/phone/email, so editing the contact stays the
-- one place to edit. on delete set null: deleting the contact must not delete
-- the ordering relationship, it just unlinks it.
alter table public.vendors
  add column if not exists knowledge_contact_id uuid
    references public.knowledge_contacts(id) on delete set null;

-- review_state defaults to 'confirmed' and that default is load-bearing.
-- Every vendor row that exists BEFORE this migration was typed by a human in
-- the Add-item sheet, so backfilling them as confirmed is not a convenience —
-- it is the truth. Only rows this feature pre-builds insert 'suggested'
-- explicitly, and they carry suggested_from to say where the guess came from.
alter table public.vendors
  add column if not exists review_state text not null default 'confirmed'
    check (review_state in ('suggested','confirmed'));

alter table public.vendors
  add column if not exists suggested_from text
    check (suggested_from is null or suggested_from in ('contact','invoice','chat'));

-- A website vendor without a URL cannot render its "Prep my order" link, and a
-- URL on a phone vendor is a contradiction. Pair them at the database so no
-- writer can produce a card that promises a link it does not have.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vendors_website_url_pairing_ck'
  ) then
    alter table public.vendors
      add constraint vendors_website_url_pairing_ck
      check (website_url is null or order_method = 'website');
  end if;
end $$;

-- An email vendor with no address cannot be emailed. We do NOT constrain that
-- pair: order_method is set the moment the manager says "by email", and the
-- address may legitimately arrive a tap later. The send route refuses instead,
-- and the card shows the missing-address chip. Constraining it here would make
-- the honest half-known state unrepresentable.

comment on column public.vendors.order_method is
  'How this hotel orders from this vendor. NULL = not told yet (renders as the missing-piece chip). Never defaulted.';
comment on column public.vendors.review_state is
  'suggested = pre-built from a contact/invoice/chat and not yet confirmed by a human; confirmed = hotel-asserted.';

-- ── 2. Vendor ↔ category map ──────────────────────────────────────────────
--
-- bucket_key is the inventory page's OWN category partition, not a second
-- taxonomy: 'general' | 'breakfast' | 'custom:<uuid>'. That partition is total
-- and disjoint (src/app/inventory/_components/tokens.ts:inBucket) — an item
-- with a custom category shows only under that custom tab, everything else is
-- breakfast or general — so every item resolves to exactly one bucket and
-- inheritance is deterministic. Reusing the chips the manager already sees is
-- what makes this a one-minute setup instead of a new thing to learn.
--
-- UNIQUE (property_id, bucket_key): one vendor per category. That is the
-- product ruling, not a limitation — exceptions are handled by the per-item
-- override (inventory.vendor_id), which is one tap on the item that is wrong.
-- Allowing several vendors per category would make "who supplies this item?"
-- ambiguous and would put the disambiguation back in front of the manager.
-- @rls: service-role-only — accessed only via /api/inventory/ordering with supabaseAdmin; RLS enabled with explicit deny-all browser policy
create table if not exists public.vendor_category_map (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  vendor_id       uuid not null references public.vendors(id) on delete cascade,
  bucket_key      text not null
                    check (bucket_key in ('general','breakfast')
                           or bucket_key ~ '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  created_at      timestamptz not null default now(),
  created_by      uuid,
  created_by_name text,
  unique (property_id, bucket_key)
);
create index if not exists vendor_category_map_property_idx
  on public.vendor_category_map (property_id, bucket_key);
create index if not exists vendor_category_map_vendor_idx
  on public.vendor_category_map (vendor_id);

alter table public.vendor_category_map enable row level security;
revoke all on public.vendor_category_map from anon, authenticated;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'vendor_category_map'
      and policyname = 'vendor_category_map_deny_all'
  ) then
    create policy vendor_category_map_deny_all on public.vendor_category_map
      for all to anon, authenticated using (false) with check (false);
  end if;
end $$;

-- Tenant integrity: the mapped vendor must belong to the same hotel as the
-- map row. Same shape as the inventory.vendor_id / purchase_orders.vendor_id
-- guards in 0312 — a cross-property vendor reference is the tenant wall
-- failing quietly, so it is refused at the database rather than in a route.
create or replace function public.staxis_vendor_category_map_same_property()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property uuid;
begin
  select property_id into v_property from public.vendors where id = new.vendor_id;
  if v_property is null then
    raise exception 'vendor % not found', new.vendor_id using errcode = '23503';
  end if;
  if v_property <> new.property_id then
    raise exception 'vendor % belongs to another property', new.vendor_id using errcode = '23503';
  end if;
  return new;
end $$;

drop trigger if exists vendor_category_map_tenant_ck on public.vendor_category_map;
create trigger vendor_category_map_tenant_ck
  before insert or update of vendor_id, property_id on public.vendor_category_map
  for each row execute function public.staxis_vendor_category_map_same_property();

comment on table public.vendor_category_map is
  'Vendor per inventory category. Items inherit their vendor from their category; inventory.vendor_id overrides per item.';

-- ── 3. Purchase orders: record HOW the order was placed ───────────────────
--
-- 0246 modelled one path (we email the vendor) because that was the only path
-- the deleted UI had. Three of the four methods are things the HUMAN does —
-- they open the vendor's site, they drive to the store, they phone it in — and
-- the row exists to record that they did, so the items can be marked ordered
-- and the same list is not prepped again tomorrow. Without this column a
-- store run and an email send are indistinguishable in the history, and the
-- app cannot tell the manager what it actually did on their behalf.
alter table public.purchase_orders
  add column if not exists placed_via text
    check (placed_via is null or placed_via in ('email','website','store','phone'));

-- The ledger convention everywhere else in inventory: snapshot the actor's
-- display name so history renders after an account is deactivated.
alter table public.purchase_orders
  add column if not exists created_by_name text;

comment on column public.purchase_orders.placed_via is
  'How the order actually reached the vendor. email = Staxis sent it. website/store/phone = the manager placed it and told us.';

-- ── 4. The one-time welcome ───────────────────────────────────────────────
--
-- Per HOTEL, not per user: the welcome explains what the feature is and what
-- it will and will not do with this hotel's money, and it is dismissed once
-- the hotel has been told. A column on properties rather than a new table —
-- there is nothing else to store and a one-column table would be a join for
-- a timestamp.
alter table public.properties
  add column if not exists ordering_intro_dismissed_at timestamptz;

comment on column public.properties.ordering_intro_dismissed_at is
  'When the Ordering welcome was dismissed. NULL = never opened; the welcome shows once.';

-- ── Bookkeeping ───────────────────────────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES ('0377', 'AI Ordering Manager. EXTENDS the tables 0246 provisioned and the July-2026 simplify pass left unused rather than adding new ones: vendors gains order_method (nullable with NO default — how a hotel orders from a supplier is the one fact no data we hold reveals, so "not told yet" must be storable and renders as the missing-piece chip), website_url paired to it by CHECK, knowledge_contact_id (a LINK to the contacts directory, never a copy), and review_state defaulting to confirmed so every pre-existing hand-typed vendor reads as the truth it is. New table vendor_category_map carries the product ruling that vendors map to CATEGORIES not items — one vendor per category via UNIQUE (property_id, bucket_key), with inventory.vendor_id as the per-item override — and repeats the service-role-only posture with RLS deny-all plus a cross-property trigger. purchase_orders gains placed_via, because three of the four order methods are things the human does and the row exists to record that they did. properties gains ordering_intro_dismissed_at for the one-time welcome.')
ON CONFLICT (version) DO NOTHING;

-- ── PostgREST schema cache ────────────────────────────────────────────────
notify pgrst, 'reload schema';
