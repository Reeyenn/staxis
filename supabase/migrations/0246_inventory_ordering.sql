-- ════════════════════════════════════════════════════════════════════════
-- 0246_inventory_ordering.sql — Inventory "Ordering" (light default + Pro mode)
-- ════════════════════════════════════════════════════════════════════════
-- Turns the inventory reorder cart into REAL purchase orders that can be
-- emailed to a vendor and tracked Sent → Received, plus an optional Pro mode
-- (PO numbers + an approval step) togglable per property, a shared item/vendor
-- catalog for fast multi-hotel onboarding, and a cross-property spend rollup.
--
-- Additive to the existing inventory surface:
--   • `inventory` (items), `inventory_orders` (restock ledger, DOLLARS),
--     `inventory_counts`, `inventory_budgets` are UNCHANGED. Receiving an order
--     still writes an `inventory_orders` row so "spend this month" keeps working.
--   • The new ordering tables store money in CENTS (integers) to match the
--     financials convention (0237). The boundary to the dollars-based
--     `inventory_orders` ledger is converted explicitly in src/lib/ordering/db.ts.
--
-- Money: purchase_orders.subtotal_cents + purchase_order_lines.unit_cost_cents
--        are INTEGER CENTS. inventory.unit_cost / inventory_orders.* stay DOLLARS.
--
-- Security model: every new table is SERVICE-ROLE-ONLY (RLS enabled, browser
-- roles revoked + denied). All reads/writes go through /api/inventory/* routes
-- that use supabaseAdmin behind requireOrderingAccess (owner/GM/admin) — the
-- same posture as 0237 financials / 0241 communications. This sidesteps the
-- RLS silent-empty-state bug class entirely (the #1 recurring bug): the browser
-- never touches these tables directly.
-- ════════════════════════════════════════════════════════════════════════

-- ── Vendors ───────────────────────────────────────────────────────────────
-- Real per-property supplier records. An inventory item can reference a
-- vendor_id (added below) while the legacy free-text inventory.vendor_name
-- keeps working as a fallback. email drives the "email this order" flow.
-- @rls: service-role-only — accessed only via /api/inventory/* with supabaseAdmin; RLS enabled with explicit deny-all browser policy
create table if not exists public.vendors (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  name            text not null,
  email           text,
  phone           text,
  account_number  text,
  notes           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists vendors_property_idx
  on public.vendors (property_id, is_active, name);

-- ── Purchase orders ─────────────────────────────────────────────────────────
-- One row per order to one vendor. po_number is a human-friendly, per-property
-- sequence (unique within a property). vendor_name_snapshot preserves the
-- display name even if the vendor row is later renamed/removed. subtotal_cents
-- is the sum of the lines (qty_ordered * unit_cost_cents) at create time.
--
-- status state machine (enforced in src/lib/ordering/db.ts):
--   simple mode:  draft → sent → (partially_received) → received
--   pro mode:     pending_approval → approved → sent → (partially_received) → received
--   either:       * → cancelled
-- @rls: service-role-only — accessed only via /api/inventory/* with supabaseAdmin; RLS enabled with explicit deny-all browser policy
create table if not exists public.purchase_orders (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  po_number           text not null,
  vendor_id           uuid references public.vendors(id) on delete set null,
  vendor_name_snapshot text,
  status              text not null default 'draft'
                        check (status in ('draft','pending_approval','approved','sent','partially_received','received','cancelled')),
  subtotal_cents      integer not null default 0 check (subtotal_cents >= 0),
  notes               text,
  created_by          uuid,          -- accounts.id of the manager who placed it
  approved_by         uuid,          -- accounts.id of the approver (pro mode)
  approved_at         timestamptz,
  sent_at             timestamptz,
  sent_to_email       text,          -- the address the order was emailed to
  received_at         timestamptz,   -- stamped when fully received
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (property_id, po_number)
);
create index if not exists purchase_orders_property_status_idx
  on public.purchase_orders (property_id, status, created_at desc);
create index if not exists purchase_orders_property_created_idx
  on public.purchase_orders (property_id, created_at desc);
create index if not exists purchase_orders_vendor_idx
  on public.purchase_orders (vendor_id);

-- ── Purchase-order lines ────────────────────────────────────────────────────
-- One row per item on a PO. unit_cost_cents is INTEGER CENTS. qty_received
-- accumulates as deliveries land (cumulative target, never decreased — see
-- receivePurchaseOrder). description snapshots the item name so a deleted item
-- still renders on the order. No tenant column: lines are always reached via
-- their property-scoped parent PO (service-role-only).
-- @rls: service-role-only — accessed only via /api/inventory/* with supabaseAdmin; RLS enabled with explicit deny-all browser policy
create table if not exists public.purchase_order_lines (
  id                 uuid primary key default gen_random_uuid(),
  purchase_order_id  uuid not null references public.purchase_orders(id) on delete cascade,
  item_id            uuid references public.inventory(id) on delete set null,
  description        text not null,
  qty_ordered        numeric not null check (qty_ordered >= 0),
  unit_cost_cents    integer not null default 0 check (unit_cost_cents >= 0),
  qty_received       numeric not null default 0 check (qty_received >= 0),
  created_at         timestamptz not null default now()
);
create index if not exists purchase_order_lines_po_idx
  on public.purchase_order_lines (purchase_order_id);

-- ── Shared starter catalog (GLOBAL — non-tenant) ────────────────────────────
-- A curated template list of common select-service-hotel supplies, used to
-- seed a brand-new property's inventory in one click (the 300+-hotel onboarding
-- accelerator). NOT property-scoped: one shared list. Importing copies rows
-- into public.inventory for the target property (idempotent by name+category).
-- suggested_unit_cost_cents is INTEGER CENTS; importing converts to the
-- dollars-based inventory.unit_cost column.
-- @rls: service-role-only — accessed only via /api/inventory/catalog* with supabaseAdmin; RLS enabled with explicit deny-all browser policy
create table if not exists public.catalog_items (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  category                 text not null check (category in ('housekeeping','maintenance','breakfast')),
  default_vendor_name      text,
  suggested_par            numeric,
  unit                     text not null default 'each',
  suggested_unit_cost_cents integer check (suggested_unit_cost_cents is null or suggested_unit_cost_cents >= 0),
  sort_order               integer not null default 0,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  unique (name, category)
);
create index if not exists catalog_items_active_idx
  on public.catalog_items (is_active, sort_order, name);

-- ── Item → vendor link (additive column on the existing inventory table) ────
-- Lets an item point at a real vendor record. The legacy vendor_name text
-- column is preserved and still authoritative as a fallback (orders snapshot
-- whichever is present). on delete set null so removing a vendor doesn't
-- orphan the item — it just falls back to vendor_name.
alter table public.inventory
  add column if not exists vendor_id uuid references public.vendors(id) on delete set null;

-- ── Per-property ordering mode (feature flag on properties) ─────────────────
-- 'simple' (default): reorder cart → email the vendor → track Sent/Received.
-- 'pro': new orders start 'pending_approval' and must be approved before send;
-- PO numbers shown prominently. Same column-on-properties pattern as the
-- compliance_anomaly_sms_enabled flag (0238).
alter table public.properties
  add column if not exists ordering_mode text not null default 'simple'
    check (ordering_mode in ('simple','pro'));

comment on column public.properties.ordering_mode is
  'Inventory ordering workflow per property. "simple" (default) = reorder cart emails the vendor + Sent/Received tracking, no approval. "pro" = PO numbers + an approval step (orders start pending_approval, must be approved before sent). Toggled by management in the inventory Ordering settings. Added 0246.';

-- ── RLS: service-role only (deny anon/authenticated; access via /api/*) ─────
alter table public.vendors              enable row level security;
alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.catalog_items        enable row level security;

revoke all on public.vendors              from public, anon, authenticated;
revoke all on public.purchase_orders      from public, anon, authenticated;
revoke all on public.purchase_order_lines from public, anon, authenticated;
revoke all on public.catalog_items        from public, anon, authenticated;

grant select, insert, update, delete on public.vendors              to service_role;
grant select, insert, update, delete on public.purchase_orders      to service_role;
grant select, insert, update, delete on public.purchase_order_lines to service_role;
grant select, insert, update, delete on public.catalog_items        to service_role;

drop policy if exists vendors_deny_browser on public.vendors;
create policy vendors_deny_browser on public.vendors
  for all to anon, authenticated using (false) with check (false);

drop policy if exists purchase_orders_deny_browser on public.purchase_orders;
create policy purchase_orders_deny_browser on public.purchase_orders
  for all to anon, authenticated using (false) with check (false);

drop policy if exists purchase_order_lines_deny_browser on public.purchase_order_lines;
create policy purchase_order_lines_deny_browser on public.purchase_order_lines
  for all to anon, authenticated using (false) with check (false);

drop policy if exists catalog_items_deny_browser on public.catalog_items;
create policy catalog_items_deny_browser on public.catalog_items
  for all to anon, authenticated using (false) with check (false);

comment on table public.vendors is
  'Per-property supplier records (name/email/phone/account#). Service-role only; managed via /api/inventory/vendors. Items link via inventory.vendor_id with vendor_name as fallback. Added 0246.';
comment on table public.purchase_orders is
  'Inventory purchase orders. Money in CENTS (subtotal_cents). Status state machine: simple = draft→sent→received; pro = pending_approval→approved→sent→received. Service-role only; via /api/inventory/orders/*. Added 0246.';
comment on table public.purchase_order_lines is
  'Lines on a purchase_order. unit_cost_cents = INTEGER CENTS. qty_received is a cumulative target (never decreased). Service-role only. Added 0246.';
comment on table public.catalog_items is
  'GLOBAL starter catalog for onboarding a new property (idempotent import into inventory). Non-tenant. suggested_unit_cost_cents = INTEGER CENTS. Service-role only; via /api/inventory/catalog*. Added 0246.';

-- ── Seed the shared starter catalog (idempotent — unique(name,category)) ────
-- A small, sensible default set for limited-service hotels. Costs in CENTS.
insert into public.catalog_items (name, category, default_vendor_name, suggested_par, unit, suggested_unit_cost_cents, sort_order)
values
  ('Bath Towels',            'housekeeping', 'HD Supply',        200, 'each', 450,  10),
  ('Hand Towels',            'housekeeping', 'HD Supply',        200, 'each', 250,  20),
  ('Washcloths',             'housekeeping', 'HD Supply',        300, 'each', 120,  30),
  ('Bath Mats',              'housekeeping', 'HD Supply',        120, 'each', 380,  40),
  ('Queen Sheet Sets',       'housekeeping', 'HD Supply',        120, 'set',  1800, 50),
  ('King Sheet Sets',        'housekeeping', 'HD Supply',         80, 'set',  2100, 60),
  ('Pillowcases',            'housekeeping', 'HD Supply',        240, 'each', 350,  70),
  ('Toilet Paper',           'housekeeping', 'Staples',          480, 'roll', 65,   80),
  ('Facial Tissue',          'housekeeping', 'Staples',          120, 'box',  140,  90),
  ('Shampoo (1.0oz)',        'housekeeping', 'Guest Supply',     500, 'each', 28,   100),
  ('Conditioner (1.0oz)',    'housekeeping', 'Guest Supply',     500, 'each', 28,   110),
  ('Bar Soap (1.5oz)',       'housekeeping', 'Guest Supply',     600, 'each', 22,   120),
  ('Body Lotion (1.0oz)',    'housekeeping', 'Guest Supply',     400, 'each', 30,   130),
  ('All-Purpose Cleaner',    'housekeeping', 'Ecolab',            48, 'bottle', 380, 140),
  ('Glass Cleaner',          'housekeeping', 'Ecolab',            36, 'bottle', 350, 150),
  ('Trash Bags (13gal)',     'housekeeping', 'Staples',          500, 'each', 12,   160),
  ('Laundry Detergent',      'housekeeping', 'Ecolab',            12, 'jug',  2400, 170),
  ('Coffee (in-room packs)', 'breakfast',    'Sysco',            600, 'each', 35,   180),
  ('Coffee Cups (12oz)',     'breakfast',    'Sysco',            800, 'each', 9,    190),
  ('Disposable Plates',      'breakfast',    'Sysco',            800, 'each', 7,    200),
  ('Plastic Cutlery Sets',   'breakfast',    'Sysco',            800, 'set',  6,    210),
  ('Napkins',                'breakfast',    'Sysco',           1200, 'each', 3,    220),
  ('Cereal (single-serve)',  'breakfast',    'Sysco',            300, 'each', 45,   230),
  ('Orange Juice (gal)',     'breakfast',    'Sysco',             24, 'gal',  650,  240),
  ('Light Bulbs (LED A19)',  'maintenance',  'Grainger',         120, 'each', 220,  250),
  ('HVAC Filters',           'maintenance',  'Grainger',          80, 'each', 480,  260),
  ('Batteries (AA)',         'maintenance',  'Grainger',         200, 'each', 35,   270),
  ('Smoke Detector Batteries (9V)', 'maintenance', 'Grainger',    80, 'each', 90,   280),
  ('Caulk (white)',          'maintenance',  'Home Depot Pro',    24, 'tube', 380,  290),
  ('Plunger',                'maintenance',  'Home Depot Pro',    20, 'each', 650,  300)
on conflict (name, category) do nothing;

-- PostgREST schema-cache reload (picked up by the running API).
notify pgrst, 'reload schema';

-- Self-register so the doctor's applied-migrations check + the
-- migration-bookkeeping drift test see this version.
insert into public.applied_migrations (version, description)
values ('0246', 'inventory ordering: vendors + purchase_orders (cents) + purchase_order_lines + global catalog_items (seeded) + inventory.vendor_id + properties.ordering_mode (simple|pro). Service-role-only; access via /api/inventory/*. Receiving still writes the dollars-based inventory_orders ledger so spend metrics keep working.')
on conflict (version) do nothing;
