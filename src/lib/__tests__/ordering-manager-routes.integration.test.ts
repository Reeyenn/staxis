/**
 * THE ORDERING SCREEN, AGAINST A REAL POSTGRES.
 *
 * WHY THIS RUNS AGAINST A REAL DATABASE RATHER THAN A STUB
 * Four of this feature's promises are database behaviour, and a fake client
 * would prove none of them:
 *
 *   • NEVER RE-ASK. "The screen only ever asks for what the database doesn't
 *     already hold" is one filter over two real tables. A stub would return
 *     whatever the test told it to and the filter could be missing entirely.
 *   • THE TENANT WALL. `vendors`, `vendor_category_map` and `purchase_orders`
 *     are deny-all to anon AND authenticated, so there is no RLS policy
 *     standing behind these routes — the `.eq('property_id', …)` filters and
 *     the 0377 cross-property trigger ARE the wall.
 *   • ONE VENDOR PER CATEGORY rests on the (property_id, bucket_key) unique
 *     index. A stub would happily hold two.
 *   • MIGRATION 0377 ITSELF applies here before anything runs, so a CHECK that
 *     rejects a legal value, or a trigger that does not compile, fails in CI
 *     rather than on the founder's hand-applied production run.
 *
 * It also pins the thing most likely to be got wrong by a later change: an
 * order that has been PLACED must not write the receipt ledger. `inventory_orders`
 * means stock physically arrived and money was spent, and it feeds the month's
 * purchases figure — a placed order landing there inflates spend for goods
 * nobody has, then double-counts when the invoice is scanned.
 *
 * NOTE ON RLS: PGlite runs as the table owner, exactly as the service-role key
 * bypasses policies in production. What is under test is app-level scoping.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Local-dev/test break-glass: skips the trusted-device half of requireSession
// so the route tests below exercise the ORDERING route's own behaviour rather
// than the 2FA plumbing, which has its own suites.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
// DELIBERATELY NO RESEND KEY. With no mail credential sendTransactionalEmail
// soft-fails, which is exactly the ambiguous send outcome the duplicate-order
// tests need: the route writes its draft, the mail does not go, and the panel
// invites the retry that used to produce a second purchase order.
delete process.env.RESEND_API_KEY;

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET as ORDERING_GET, POST as ORDERING_POST } from '@/app/api/inventory/ordering/route';
import {
  listVendors,
  updateVendorOrdering,
  listVendorCategoryMap,
  setVendorCategory,
  setItemVendorOverride,
  lastInvoicePrices,
  buildVendorSuggestions,
  recordPlacedOrder,
  getIntroDismissedAt,
  dismissIntro,
  openOrdersByItem,
  findRecentMatchingOrder,
  knowledgeContactBelongsToProperty,
} from '@/lib/ordering/db';
import { resolveVendorForItem, buildCandidate, groupByVendor, rankCandidates } from '@/lib/ordering/resolve';
import type { BucketKey } from '@/lib/ordering/types';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  PID_A1,
  PID_B1,
  UID_MARIA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

const ACTOR = { userId: 'aaaa2222-0000-4000-8000-000000000001', name: 'Maria Garcia' };

// Ids we control, so assertions can name them.
let sysco = '';
let guestSupply = '';
let hotelBVendor = '';
let towelsA = '';
let eggsA = '';

async function one<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await pg.query<T>(sql, params);
  return r.rows[0] ?? null;
}

/**
 * Assert that a call is refused, and that the refusal SAYS WHY.
 *
 * A bare `assert.rejects(fn, /regex/)` is wrong here and silently so: the data
 * layer re-throws PostgREST's error OBJECT, which is not an Error instance, so
 * node matches the regex against "[object Object]" and the assertion fails even
 * when the database refused correctly. Reading the message off whatever was
 * thrown is what makes these tests test the trigger rather than the shim's
 * choice of error class.
 */
async function refuses(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown !== undefined, 'expected the call to be refused, but it succeeded');
  const message = String(
    (thrown as { message?: unknown })?.message ?? thrown,
  );
  assert.match(message, pattern);
}

// ─── Driving the real route ─────────────────────────────────────────────────
//
// Maria is the seed's property-scope GM at hotel A, so requireOrderingAccess
// resolves her to general_manager with hotelMutationAllowed. (UID_ANA, the
// audit ACTOR above, is a COMPANY-scope owner and is read-only at the hotel —
// using her here would 403 every write and prove nothing.)
let signedInAs: string | null = UID_MARIA;

function orderingPost(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://staxis.test/api/inventory/ordering', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ordering-route-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

interface RouteReply {
  status: number;
  body: { ok: boolean; error?: string; data?: Record<string, unknown> };
}

async function post(body: Record<string, unknown>): Promise<RouteReply> {
  const res = await ORDERING_POST(orderingPost(body));
  return { status: res.status, body: (await res.json()) as RouteReply['body'] };
}

async function getScreen(pid: string): Promise<RouteReply> {
  const res = await ORDERING_GET(new NextRequest(
    `https://staxis.test/api/inventory/ordering?pid=${pid}`,
    { method: 'GET', headers: { authorization: 'Bearer ordering-route-test-token' } },
  ));
  return { status: res.status, body: (await res.json()) as RouteReply['body'] };
}

/** Every purchase order this hotel holds, newest first. */
async function ordersFor(pid: string) {
  const r = await pg.query<{
    id: string; po_number: string; status: string; vendor_id: string | null;
  }>(
    `select id, po_number, status, vendor_id from purchase_orders
      where property_id = $1 order by created_at desc, po_number`,
    [pid],
  );
  return r.rows;
}

async function linesOf(orderId: string) {
  const r = await pg.query<{ item_id: string; qty_ordered: string }>(
    'select item_id, qty_ordered from purchase_order_lines where purchase_order_id = $1',
    [orderId],
  );
  return r.rows;
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  // requireSession's token check. Which session it is, is what the route tests
  // vary; that a session exists is not what they are about.
  supabaseAdmin.auth.getUser = (async () => (signedInAs
    ? { data: { user: { id: signedInAs, email: `${signedInAs}@ordering.test` } }, error: null }
    : {
        data: { user: null },
        error: { message: 'invalid token', status: 401, name: 'AuthApiError' },
      })) as unknown as typeof supabaseAdmin.auth.getUser;
  await seedTwoCompanies(pg);

  // ── Hotel A: two suppliers, one of them a website vendor ──
  sysco = (await one<{ id: string }>(
    `insert into vendors (property_id, name, email, order_method, review_state)
     values ($1, 'Sysco', 'orders@sysco.test', 'email', 'confirmed') returning id`,
    [PID_A1],
  ))!.id;
  guestSupply = (await one<{ id: string }>(
    `insert into vendors (property_id, name, order_method, website_url, review_state)
     values ($1, 'Guest Supply', 'website', 'https://gs.test/order', 'confirmed') returning id`,
    [PID_A1],
  ))!.id;
  // ── Hotel B: a supplier hotel A must never see ──
  hotelBVendor = (await one<{ id: string }>(
    `insert into vendors (property_id, name, order_method, review_state)
     values ($1, 'Tyler Linens', 'store', 'confirmed') returning id`,
    [PID_B1],
  ))!.id;

  // ── Hotel A inventory: one general item, one breakfast item ──
  towelsA = (await one<{ id: string }>(
    `insert into inventory (property_id, name, category, current_stock, par_level, unit)
     values ($1, 'Bath towels', 'housekeeping', 12, 100, 'each') returning id`,
    [PID_A1],
  ))!.id;
  eggsA = (await one<{ id: string }>(
    `insert into inventory (property_id, name, category, current_stock, par_level, unit)
     values ($1, 'Eggs', 'breakfast', 2, 20, 'case') returning id`,
    [PID_A1],
  ))!.id;

  // A receipt, so exactly one item has a real last-paid price.
  await pg.query(
    `insert into inventory_orders
       (property_id, item_id, item_name, quantity, unit_cost, total_cost, received_at, entry_kind, vendor_name)
     values ($1,$2,'Bath towels',10,2.50,25.00, now() - interval '10 days', 'receipt', 'Old Linen Co')`,
    [PID_A1, towelsA],
  );

  // A vendor contact in the directory that hotel A has NOT yet turned into a
  // vendor — the pre-build source.
  await pg.query(
    `insert into knowledge_contacts (property_id, name, company, phone, email, category)
     values ($1, 'Dana', 'Beaumont Paper Co', '(409) 555-0134', 'dana@bpc.test', 'vendor')`,
    [PID_A1],
  );
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Migration 0377 itself
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — the schema the screen stands on', () => {
  test('a vendor may exist with NO order method — the missing piece is representable', async () => {
    // If this column had picked up a default, the screen could never render the
    // "tell us how you order from them" chip, because no row would ever lack an
    // answer. The honest half-known state has to be storable.
    const row = await one<{ id: string; order_method: string | null }>(
      `insert into vendors (property_id, name) values ($1, 'Unknown Method Co')
       returning id, order_method`,
      [PID_A1],
    );
    assert.equal(row!.order_method, null);
    await pg.query('delete from vendors where id = $1', [row!.id]);
  });

  test('pre-existing vendors read as CONFIRMED, because a human typed them', async () => {
    const row = await one<{ review_state: string }>(
      'select review_state from vendors where id = $1', [sysco],
    );
    assert.equal(row!.review_state, 'confirmed');
  });

  test('a website URL cannot be attached to a non-website vendor', async () => {
    // The pairing CHECK. Without it a phone vendor could carry a URL and the
    // card would render a link nobody can order through.
    await refuses(
      () => pg.query(
        `insert into vendors (property_id, name, order_method, website_url)
         values ($1, 'Contradiction Co', 'phone', 'https://nope.test')`,
        [PID_A1],
      ),
      /vendors_website_url_pairing_ck|violates check constraint/i,
    );
  });

  test('one category maps to exactly ONE vendor', async () => {
    await setVendorCategory(PID_A1, 'breakfast', sysco, ACTOR);
    await setVendorCategory(PID_A1, 'breakfast', guestSupply, ACTOR);
    const links = await listVendorCategoryMap(PID_A1);
    const breakfast = links.filter((l) => l.bucketKey === 'breakfast');
    assert.equal(breakfast.length, 1, 'remapping replaces, it does not add a second answer');
    assert.equal(breakfast[0].vendorId, guestSupply);
    await setVendorCategory(PID_A1, 'breakfast', sysco, ACTOR); // restore
  });

  test('a category cannot be pointed at ANOTHER hotel\'s vendor', async () => {
    // The tenant wall, enforced by the 0377 trigger rather than by a route.
    await refuses(
      () => setVendorCategory(PID_A1, 'general', hotelBVendor, ACTOR),
      /another property|not found/i,
    );
  });

  test('a nonsense bucket key is refused', async () => {
    await refuses(
      () => pg.query(
        `insert into vendor_category_map (property_id, vendor_id, bucket_key) values ($1,$2,'chairs')`,
        [PID_A1, sysco],
      ),
      /violates check constraint/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. State awareness — first open, knowing DB, fiftieth open
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — the screen only asks for what it does not hold', () => {
  test('first ever open has no dismissal stamp; after one tap it has one, forever', async () => {
    assert.equal(await getIntroDismissedAt(PID_A1), null, 'the welcome should be due on a first open');
    await dismissIntro(PID_A1);
    const stamped = await getIntroDismissedAt(PID_A1);
    assert.ok(stamped, 'the welcome must not come back on the second open');
    // The fiftieth open reads the same stamp — nothing here re-arms it.
    assert.equal(await getIntroDismissedAt(PID_A1), stamped);
  });

  test('a hotel that dismissed it does NOT dismiss it for the other hotel', async () => {
    assert.equal(await getIntroDismissedAt(PID_B1), null);
  });

  test('NEVER RE-ASK: a contact already stored as a vendor stops being suggested', async () => {
    // The whole never-re-ask rule in one assertion. Before: the paper company
    // is in contacts only, so it is offered. After: it is a vendor, so the
    // screen must stop asking about it.
    const before = await buildVendorSuggestions(PID_A1, await listVendors(PID_A1));
    const paper = before.find((s) => s.name === 'Beaumont Paper Co');
    assert.ok(paper, 'a vendor contact nobody has confirmed should be suggested');
    assert.equal(paper!.source, 'contact');
    assert.ok(paper!.knowledgeContactId, 'the suggestion must LINK to the contact, not copy it');

    const created = await one<{ id: string }>(
      `insert into vendors (property_id, name, knowledge_contact_id, review_state)
       values ($1, 'Beaumont Paper Co', $2, 'confirmed') returning id`,
      [PID_A1, paper!.knowledgeContactId],
    );
    const after = await buildVendorSuggestions(PID_A1, await listVendors(PID_A1));
    assert.equal(
      after.find((s) => s.name === 'Beaumont Paper Co'),
      undefined,
      'a supplier we have been told about must never be asked about again',
    );
    await pg.query('delete from vendors where id = $1', [created!.id]);
  });

  test('a supplier seen only on invoices is suggested, and says how many times', async () => {
    const suggestions = await buildVendorSuggestions(PID_A1, await listVendors(PID_A1));
    const linen = suggestions.find((s) => s.name === 'Old Linen Co');
    assert.ok(linen, 'a vendor name on a scanned invoice should be offered');
    assert.equal(linen!.source, 'invoice');
    assert.equal(linen!.seenOnInvoices, 1);
    assert.deepEqual(linen!.bucketHints, ['general'], 'the category its items landed in is offered as a hint');
  });

  test('a scanned invoice naming the HOTEL ITSELF is never offered as a supplier', async () => {
    // The extractor sometimes reads the bill-to — the hotel — as vendor_name
    // (live example: "Grand Harbor Hotel" suggested to Grand Harbor Hotel).
    // Hotel A here is "Beaumont Suites"; both its exact name and its printed
    // legal variant must be dropped, while "Beaumont Paper Co" — a real
    // supplier that shares the town name — must keep being suggested.
    await pg.query(
      `insert into inventory_orders
         (property_id, item_id, item_name, quantity, received_at, entry_kind, vendor_name)
       values
         ($1,$2,'Bath towels',5, now() - interval '40 days', 'receipt', 'Beaumont Suites'),
         ($1,$2,'Bath towels',5, now() - interval '41 days', 'receipt', 'Beaumont Suites LLC')`,
      [PID_A1, towelsA],
    );
    const suggestions = await buildVendorSuggestions(PID_A1, await listVendors(PID_A1));
    assert.equal(
      suggestions.find((s) => /beaumont suites/i.test(s.name)),
      undefined,
      'the hotel must never be suggested as its own supplier',
    );
    assert.ok(
      suggestions.find((s) => s.name === 'Beaumont Paper Co'),
      'a real supplier sharing a word with the hotel must not be swallowed',
    );
    await pg.query(
      `delete from inventory_orders where property_id = $1 and vendor_name like 'Beaumont Suites%'`,
      [PID_A1],
    );
  });

  test('suggestions never cross the tenant wall', async () => {
    const forB = await buildVendorSuggestions(PID_B1, await listVendors(PID_B1));
    assert.equal(
      forB.find((s) => s.name === 'Beaumont Paper Co'),
      undefined,
      "hotel A's contacts must not be offered to hotel B",
    );
    assert.equal(forB.find((s) => s.name === 'Old Linen Co'), undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Inheritance, override, and the tenant wall on reads
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — who supplies what, at the database', () => {
  test('hotel A never sees hotel B\'s suppliers', async () => {
    const a = await listVendors(PID_A1);
    assert.ok(a.every((v) => v.name !== 'Tyler Linens'), 'a cross-hotel vendor leaked into the list');
    const b = await listVendors(PID_B1);
    assert.deepEqual(b.map((v) => v.name), ['Tyler Linens']);
  });

  test('an item inherits its category vendor, and a per-item override beats it', async () => {
    await setVendorCategory(PID_A1, 'breakfast', sysco, ACTOR);
    const vendors = await listVendors(PID_A1);
    const byId = new Map(vendors.map((v) => [v.id, v]));
    const map = new Map<BucketKey, string>(
      (await listVendorCategoryMap(PID_A1)).map((l) => [l.bucketKey, l.vendorId] as const),
    );

    const inherited = resolveVendorForItem(
      { category: 'breakfast', customCategoryId: null, vendorId: null, vendorName: null },
      map, byId,
    );
    assert.equal(inherited.kind, 'category');
    assert.equal(inherited.vendorId, sysco);

    // Now point the eggs somewhere else, the way one tap on the card does.
    await setItemVendorOverride(PID_A1, eggsA, guestSupply);
    const row = await one<{ vendor_id: string }>('select vendor_id from inventory where id = $1', [eggsA]);
    const overridden = resolveVendorForItem(
      { category: 'breakfast', customCategoryId: null, vendorId: row!.vendor_id, vendorName: null },
      map, byId,
    );
    assert.equal(overridden.kind, 'item');
    assert.equal(overridden.vendorId, guestSupply, 'the override must survive the category mapping');
    await setItemVendorOverride(PID_A1, eggsA, null);
  });

  test('an item override pointing at another hotel\'s vendor is refused at the database', async () => {
    await refuses(
      () => setItemVendorOverride(PID_A1, towelsA, hotelBVendor),
      /does not belong to property/i,
    );
  });

  test('last-paid prices come only from receipts, and only for this hotel', async () => {
    const prices = await lastInvoicePrices(PID_A1, [towelsA, eggsA]);
    assert.equal(prices.get(towelsA)?.cents, 250, '$2.50 in the dollars ledger is 250 cents here');
    assert.equal(prices.get(eggsA), undefined, 'an item never on an invoice has NO price, not zero');

    const forB = await lastInvoicePrices(PID_B1, [towelsA]);
    assert.equal(forB.get(towelsA), undefined, "hotel B must not read hotel A's prices");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Placing an order
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — recording a placed order', () => {
  test('writes the order and its lines, stamps the items, and does NOT touch the receipt ledger', async () => {
    const receiptsBefore = await one<{ n: string }>(
      'select count(*) as n from inventory_orders where property_id = $1', [PID_A1],
    );

    const recorded = await recordPlacedOrder(
      PID_A1,
      {
        vendorId: sysco,
        vendorName: 'Sysco',
        placedVia: 'email',
        lines: [{ itemId: towelsA, description: 'Bath towels', qty: 88, unitCostCents: 250 }],
        subtotalCents: 22000,
        sentToEmail: 'orders@sysco.test',
        notes: null,
        poNumber: 'PO-260728-TEST',
      },
      ACTOR,
    );
    assert.ok(recorded);
    assert.equal(recorded!.poNumber, 'PO-260728-TEST', 'the number the email quoted is the number we kept');

    const po = await one<{ status: string; placed_via: string; sent_to_email: string; subtotal_cents: number; created_by_name: string }>(
      'select status, placed_via, sent_to_email, subtotal_cents, created_by_name from purchase_orders where id = $1',
      [recorded!.id],
    );
    assert.equal(po!.status, 'sent');
    assert.equal(po!.placed_via, 'email', 'how it was placed must be recoverable from the row');
    assert.equal(po!.sent_to_email, 'orders@sysco.test');
    assert.equal(Number(po!.subtotal_cents), 22000);
    assert.equal(po!.created_by_name, 'Maria Garcia');

    const line = await one<{ qty_ordered: string; unit_cost_cents: number }>(
      'select qty_ordered, unit_cost_cents from purchase_order_lines where purchase_order_id = $1',
      [recorded!.id],
    );
    assert.equal(Number(line!.qty_ordered), 88);
    assert.equal(Number(line!.unit_cost_cents), 250);

    const stamped = await one<{ last_ordered_at: string | null }>(
      'select last_ordered_at from inventory where id = $1', [towelsA],
    );
    assert.ok(stamped!.last_ordered_at, 'the item must be stamped so it leaves tomorrow\'s list');

    // THE ONE THAT MATTERS. A placed order is not a delivery.
    const receiptsAfter = await one<{ n: string }>(
      'select count(*) as n from inventory_orders where property_id = $1', [PID_A1],
    );
    assert.equal(
      receiptsAfter!.n,
      receiptsBefore!.n,
      'placing an order must NOT write the receipt ledger — that would inflate the month\'s '
      + 'spend for goods nobody has, then double-count when the invoice is scanned',
    );
  });

  test('a store run records how it was placed and no email address', async () => {
    const recorded = await recordPlacedOrder(
      PID_A1,
      {
        vendorId: null, vendorName: "Sam's Club", placedVia: 'store',
        lines: [{ itemId: eggsA, description: 'Eggs', qty: 18, unitCostCents: null }],
        subtotalCents: 0, sentToEmail: null, notes: null,
      },
      ACTOR,
    );
    const po = await one<{ placed_via: string; sent_to_email: string | null; subtotal_cents: number }>(
      'select placed_via, sent_to_email, subtotal_cents from purchase_orders where id = $1', [recorded!.id],
    );
    assert.equal(po!.placed_via, 'store');
    assert.equal(po!.sent_to_email, null);
    // A line we have no receipt price for stores 0 cents but the ORDER total
    // stays 0 too — nothing here invents a figure.
    assert.equal(Number(po!.subtotal_cents), 0);
  });

  test('two orders in the same hotel get distinct numbers', async () => {
    const a = await recordPlacedOrder(PID_A1, {
      vendorId: sysco, vendorName: 'Sysco', placedVia: 'phone',
      lines: [], subtotalCents: 0, sentToEmail: null, notes: null,
    }, ACTOR);
    const b = await recordPlacedOrder(PID_A1, {
      vendorId: sysco, vendorName: 'Sysco', placedVia: 'phone',
      lines: [], subtotalCents: 0, sentToEmail: null, notes: null,
    }, ACTOR);
    assert.notEqual(a!.poNumber, b!.poNumber);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The screen a manager actually sees, assembled from real rows
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — the assembled screen', () => {
  test('groups low items under the supplier their category names, with real prices', async () => {
    await setVendorCategory(PID_A1, 'general', sysco, ACTOR);
    await setVendorCategory(PID_A1, 'breakfast', guestSupply, ACTOR);

    const vendors = await listVendors(PID_A1);
    const byId = new Map(vendors.map((v) => [v.id, v]));
    const map = new Map<BucketKey, string>(
      (await listVendorCategoryMap(PID_A1)).map((l) => [l.bucketKey, l.vendorId] as const),
    );
    const prices = await lastInvoicePrices(PID_A1, [towelsA, eggsA]);

    const rows = await pg.query<{
      id: string; name: string; unit: string; category: string;
      current_stock: string; par_level: string;
    }>(
      'select id, name, unit, category, current_stock, par_level from inventory where property_id = $1 order by name',
      [PID_A1],
    );

    const candidates = rows.rows.map((r) => buildCandidate(
      {
        itemId: r.id, name: r.name, unit: r.unit,
        onHand: Number(r.current_stock), par: Number(r.par_level),
        category: r.category, customCategoryId: null,
        vendorId: null, vendorName: null,
        burnPerDay: null, burnConfidence: 'none',
        lastPriceCents: prices.get(r.id)?.cents ?? null,
        lastPriceAt: prices.get(r.id)?.at ?? null,
        openOrder: null,
      },
      map, byId,
    )).filter((c): c is NonNullable<typeof c> => c != null);

    const groups = groupByVendor(rankCandidates(candidates), byId);
    const syscoGroup = groups.find((g) => g.vendorId === sysco);
    const gsGroup = groups.find((g) => g.vendorId === guestSupply);

    assert.ok(syscoGroup, 'the general category should group under Sysco');
    assert.deepEqual(syscoGroup!.items.map((i) => i.name), ['Bath towels']);
    assert.equal(syscoGroup!.orderMethod, 'email');
    assert.equal(syscoGroup!.blocked, null, 'an email vendor with an address is ready to send');
    assert.equal(syscoGroup!.knownSubtotalCents, 250 * 88);

    assert.ok(gsGroup, 'breakfast should group under Guest Supply');
    assert.deepEqual(gsGroup!.items.map((i) => i.name), ['Eggs']);
    assert.equal(gsGroup!.orderMethod, 'website');
    assert.equal(gsGroup!.itemsWithoutPrice, 1, 'eggs have no receipt, so the card says so');
    assert.equal(gsGroup!.knownSubtotalCents, 0);
    assert.equal(gsGroup!.items[0].daysLeft, null, 'no burn evidence means no days-left number');
  });

  test('a suggested supplier is blocked until confirmed, then becomes actionable', async () => {
    const pending = (await one<{ id: string }>(
      `insert into vendors (property_id, name, email, order_method, review_state, suggested_from)
       values ($1, 'Maybe Foods', 'x@maybe.test', 'email', 'suggested', 'invoice') returning id`,
      [PID_A1],
    ))!.id;

    let vendors = await listVendors(PID_A1);
    let v = vendors.find((x) => x.id === pending)!;
    assert.equal(v.reviewState, 'suggested');

    // Confirming is the ONLY thing that changes it — nothing infers it.
    await updateVendorOrdering(PID_A1, pending, { reviewState: 'confirmed' });
    vendors = await listVendors(PID_A1);
    v = vendors.find((x) => x.id === pending)!;
    assert.equal(v.reviewState, 'confirmed');
    assert.equal(v.orderMethod, 'email');
    assert.equal(v.email, 'x@maybe.test');

    await pg.query('delete from vendors where id = $1', [pending]);
  });

  test('clearing a website vendor\'s method clears the URL with it', async () => {
    // Otherwise the paired CHECK rejects the update and the manager sees an
    // opaque failure while trying to correct a mistake.
    const id = (await one<{ id: string }>(
      `insert into vendors (property_id, name, order_method, website_url)
       values ($1, 'Switcher Co', 'website', 'https://switch.test') returning id`,
      [PID_A1],
    ))!.id;
    await updateVendorOrdering(PID_A1, id, { orderMethod: 'phone' });
    const row = await one<{ order_method: string; website_url: string | null }>(
      'select order_method, website_url from vendors where id = $1', [id],
    );
    assert.equal(row!.order_method, 'phone');
    assert.equal(row!.website_url, null);
    await pg.query('delete from vendors where id = $1', [id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The route itself, through requireOrderingAccess
//
// Everything below drives the REAL handler with a real session, because every
// bug it pins lives at the route seam and not in the pure layer: the qty floor
// and the empty-order guard are in resolveOrderLines, the duplicate-send is in
// the send path's ordering, and the two validation bugs are in what the route
// checks and in what order it writes.
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering route — one tap, one order', () => {
  /** A vendor + one genuinely short item, isolated per test. Names carry a
   *  uuid because `inventory` is unique on (property, name) per hotel. */
  async function scratchItem(label: string, stock = 0, par = 40): Promise<string> {
    return (await one<{ id: string }>(
      `insert into inventory (property_id, name, category, current_stock, par_level, unit)
       values ($1, $2 || ' ' || gen_random_uuid(), 'housekeeping', $3, $4, 'each') returning id`,
      [PID_A1, label, stock, par],
    ))!.id;
  }

  async function scratchOrder(opts: { stock?: number; par?: number } = {}) {
    const vendorId = (await one<{ id: string }>(
      `insert into vendors (property_id, name, email, order_method, review_state)
       values ($1, 'Scratch Supply ' || gen_random_uuid(), 'ap@scratch.test', 'email', 'confirmed')
       returning id`,
      [PID_A1],
    ))!.id;
    const itemId = await scratchItem('Scratch item', opts.stock ?? 0, opts.par ?? 40);
    return { vendorId, itemId };
  }

  test('the ambiguous send, retried, reuses ONE purchase order and one number', async () => {
    // THE DUPLICATE-VENDOR-EMAIL BUG. With no mail credential the send fails
    // the way a timeout or a 502 fails: the manager is told "could not send,
    // try again", and the order is still on the screen. The retry used to mint
    // a second PO number and put a second order in the vendor's inbox.
    const { vendorId, itemId } = await scratchOrder();

    const first = await post({ pid: PID_A1, action: 'send_po', vendorId, itemIds: [itemId] });
    assert.equal(first.status, 502, 'the send could not go out, and says so');

    const afterFirst = (await ordersFor(PID_A1)).filter((o) => o.vendor_id === vendorId);
    assert.equal(afterFirst.length, 1, 'the attempt is recorded, so nothing is lost');
    assert.equal(afterFirst[0].status, 'draft', 'nothing claims the vendor has it');

    const second = await post({ pid: PID_A1, action: 'send_po', vendorId, itemIds: [itemId] });
    assert.equal(second.status, 502);

    const afterRetry = (await ordersFor(PID_A1)).filter((o) => o.vendor_id === vendorId);
    assert.equal(afterRetry.length, 1, 'the retry is the SAME order, not a second one');
    assert.equal(
      afterRetry[0].po_number,
      afterFirst[0].po_number,
      'one reference, so the vendor cannot be looking at two orders for one delivery',
    );
    assert.equal(afterRetry[0].id, afterFirst[0].id);

    await pg.query('delete from purchase_orders where vendor_id = $1', [vendorId]);
  });

  test('a send whose outcome was lost is never emailed a second time', async () => {
    // The other ambiguous outcome: the mail WAS accepted and the reply never
    // reached the browser. The order is 'sent', so the retry must report that
    // same order and must not go near the mail server again.
    const { vendorId, itemId } = await scratchOrder();
    await post({ pid: PID_A1, action: 'send_po', vendorId, itemIds: [itemId] });
    const [draft] = (await ordersFor(PID_A1)).filter((o) => o.vendor_id === vendorId);
    await pg.query(
      "update purchase_orders set status = 'sent', sent_at = now() where id = $1",
      [draft.id],
    );

    const retry = await post({ pid: PID_A1, action: 'send_po', vendorId, itemIds: [itemId] });
    assert.equal(retry.status, 200, 'the manager is told it went, because it did');
    assert.equal(retry.body.ok, true);
    assert.equal(retry.body.data?.alreadySent, true);
    assert.equal(
      (retry.body.data?.order as { poNumber: string }).poNumber,
      draft.po_number,
      'the same order, reported again',
    );

    const rows = (await ordersFor(PID_A1)).filter((o) => o.vendor_id === vendorId);
    assert.equal(rows.length, 1, 'no second purchase order exists to be emailed');

    await pg.query('delete from purchase_orders where vendor_id = $1', [vendorId]);
  });

  test('a different set of items is a different order and gets its own number', async () => {
    // The idempotency must not swallow a real second order. Adding one item is
    // a new order, not a retry of the old one.
    const { vendorId, itemId } = await scratchOrder();
    const extra = await scratchItem('Scratch extra', 0, 10);

    await post({ pid: PID_A1, action: 'send_po', vendorId, itemIds: [itemId] });
    await post({ pid: PID_A1, action: 'send_po', vendorId, itemIds: [itemId, extra] });

    const rows = (await ordersFor(PID_A1)).filter((o) => o.vendor_id === vendorId);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].po_number, rows[1].po_number);

    await pg.query('delete from purchase_orders where vendor_id = $1', [vendorId]);
    await pg.query('delete from inventory where id = $1', [extra]);
  });

  test('an item that needs nothing never gets a line, whatever the screen said', async () => {
    // THE QTY FLOOR. resolveOrderLines used to force every requested item to at
    // least one unit, so an item restocked between the screen loading and the
    // send went onto a real purchase order for a unit nobody needed.
    const { vendorId, itemId } = await scratchOrder();
    const full = await scratchItem('Already full', 50, 20);

    const reply = await post({
      pid: PID_A1, action: 'mark_ordered', placedVia: 'store', vendorId, itemIds: [itemId, full],
    });
    assert.equal(reply.status, 201);

    const orderId = (reply.body.data?.order as { id: string }).id;
    const lines = await linesOf(orderId);
    assert.deepEqual(lines.map((l) => l.item_id), [itemId], 'only the item that was actually short');

    await pg.query('delete from purchase_orders where vendor_id = $1', [vendorId]);
    await pg.query('delete from inventory where id = $1', [full]);
  });

  test('a failed email attempt does not swallow a later "I placed it"', async () => {
    // The idempotency must not mistake an abandoned draft for a placed order.
    // If it did, the manager who gave up on emailing and phoned it in instead
    // would be told it was recorded while the row stayed a draft and the items
    // were never stamped, so the same order would be asked for again tomorrow.
    const { vendorId, itemId } = await scratchOrder();
    await post({ pid: PID_A1, action: 'send_po', vendorId, itemIds: [itemId] });
    const [draft] = (await ordersFor(PID_A1)).filter((o) => o.vendor_id === vendorId);
    assert.equal(draft.status, 'draft');

    const placed = await post({
      pid: PID_A1, action: 'mark_ordered', placedVia: 'phone', vendorId, itemIds: [itemId],
    });
    assert.equal(placed.status, 201, 'the phone order is really recorded');

    const rows = (await ordersFor(PID_A1)).filter((o) => o.vendor_id === vendorId);
    assert.equal(rows.filter((o) => o.status === 'sent').length, 1, 'and it counts as placed');

    // A SECOND tap on the same button is still one order.
    const again = await post({
      pid: PID_A1, action: 'mark_ordered', placedVia: 'phone', vendorId, itemIds: [itemId],
    });
    assert.equal(again.body.data?.alreadyRecorded, true);
    assert.equal(
      (await ordersFor(PID_A1)).filter((o) => o.vendor_id === vendorId && o.status === 'sent').length,
      1,
      'a double tap does not double the hotel\'s record of what it bought',
    );

    await pg.query('delete from purchase_orders where vendor_id = $1', [vendorId]);
  });

  test('marking an order with nothing to order records no order at all', async () => {
    // send_po has always refused an empty order. mark_ordered did not, so a
    // list whose items were all restocked wrote a purchase order with no lines
    // and no meaning.
    const { vendorId } = await scratchOrder();
    const full = await scratchItem('Stocked up', 99, 10);

    const reply = await post({
      pid: PID_A1, action: 'mark_ordered', placedVia: 'store', vendorId, itemIds: [full],
    });
    assert.equal(reply.status, 400);
    assert.match(String(reply.body.error), /nothing to order/);
    assert.equal(
      (await ordersFor(PID_A1)).filter((o) => o.vendor_id === vendorId).length,
      0,
      'no empty purchase order in the hotel\'s history',
    );

    await pg.query('delete from inventory where id = $1', [full]);
  });
});

describe('ordering route — what it refuses before it writes', () => {
  // Confirming a supplier goes through `staxis_create_inventory_vendor` (0326),
  // which refuses anything that is not the service role. In production the
  // service-role key makes PostgREST set that claim; PGlite's `auth.role()`
  // stub reads the same setting and nothing sets it. Without this the confirm
  // fails for a reason that does not exist in production, and the "nothing was
  // written" assertions below would pass for the wrong reason.
  before(async () => {
    await pg.query("select set_config('request.jwt.claim.role', 'service_role', false)");
  });
  after(async () => {
    await pg.query("select set_config('request.jwt.claim.role', '', false)");
  });

  test('a category key the database would refuse is a 400, not a 500', async () => {
    // The route regex used to accept 36 hex characters with no hyphens, which
    // the 0377 CHECK refuses. The manager got an opaque failure from a value
    // this layer was supposed to catch.
    const noHyphens = `custom:${'a'.repeat(32)}${'b'.repeat(4)}`;
    const reply = await post({
      pid: PID_A1, action: 'set_category_vendor', bucketKey: noHyphens, vendorId: sysco,
    });
    assert.equal(reply.status, 400, 'refused here, where it can be explained');
    assert.match(String(reply.body.error), /bucketKey/);
  });

  test('a real custom category key still works', async () => {
    // The tightened regex must not have closed the legitimate door.
    const custom = (await one<{ id: string }>(
      "insert into inventory_custom_categories (property_id, name) values ($1, 'Pool') returning id",
      [PID_A1],
    ))!.id;
    const reply = await post({
      pid: PID_A1, action: 'set_category_vendor', bucketKey: `custom:${custom}`, vendorId: sysco,
    });
    assert.equal(reply.status, 200);
    await pg.query('delete from vendor_category_map where property_id = $1 and bucket_key = $2',
      [PID_A1, `custom:${custom}`]);
    await pg.query('delete from inventory_custom_categories where id = $1', [custom]);
  });

  test('a confirm that cannot finish leaves no half-made supplier behind', async () => {
    // The category keys used to be parsed AFTER the vendor was written, so a
    // key the database refused failed with the supplier already created and
    // its categories not applied.
    const before = await pg.query<{ n: string }>(
      'select count(*)::text as n from vendors where property_id = $1', [PID_A1],
    );
    const reply = await post({
      pid: PID_A1,
      action: 'confirm_suggestion',
      name: 'Half Made Co',
      orderMethod: 'phone',
      bucketKeys: ['general', `custom:${'f'.repeat(36)}`],
    });
    assert.equal(reply.status, 400);
    const after = await pg.query<{ n: string }>(
      'select count(*)::text as n from vendors where property_id = $1', [PID_A1],
    );
    assert.equal(after.rows[0].n, before.rows[0].n, 'nothing was written');
    const named = await one('select id from vendors where property_id = $1 and name = $2',
      [PID_A1, 'Half Made Co']);
    assert.equal(named, null);
  });

  test('a contact from another hotel cannot be linked, and answers nothing', async () => {
    // THE CROSS-TENANT PROBE. vendors.knowledge_contact_id is a plain FK with
    // no tenant trigger, so hotel B's contact id would have been accepted and
    // stored. Nothing renders it, but the accept/reject answer alone is an
    // existence oracle for another hotel's contact ids.
    const foreign = (await one<{ id: string }>(
      `insert into knowledge_contacts (property_id, name, company, category)
       values ($1, 'Tyler Vendor', 'Tyler Paper', 'vendor') returning id`,
      [PID_B1],
    ))!.id;

    const reply = await post({
      pid: PID_A1,
      action: 'confirm_suggestion',
      name: 'Borrowed Contact Co',
      knowledgeContactId: foreign,
    });
    assert.equal(reply.status, 400, 'refused');
    assert.equal(
      await one('select id from vendors where property_id = $1 and name = $2',
        [PID_A1, 'Borrowed Contact Co']),
      null,
      'and refused BEFORE the vendor row was written',
    );

    // A contact id that does not exist at all must be refused the same way, or
    // the difference between the two answers is the oracle.
    const missing = await post({
      pid: PID_A1,
      action: 'confirm_suggestion',
      name: 'Ghost Contact Co',
      knowledgeContactId: '99999999-9999-4999-8999-999999999999',
    });
    assert.equal(missing.status, reply.status);
    assert.equal(missing.body.error, reply.body.error, 'same refusal, no information leaked');

    // The hotel's OWN contact still confirms, so the check guards rather than blocks.
    const mine = (await one<{ id: string }>(
      `insert into knowledge_contacts (property_id, name, company, category)
       values ($1, 'Local Dana', 'Local Paper', 'vendor') returning id`,
      [PID_A1],
    ))!.id;
    const okReply = await post({
      pid: PID_A1, action: 'confirm_suggestion', name: 'Local Paper', knowledgeContactId: mine,
    });
    assert.equal(okReply.status, 201);

    assert.equal(await knowledgeContactBelongsToProperty(PID_A1, foreign), false);
    assert.equal(await knowledgeContactBelongsToProperty(PID_A1, mine), true);

    await pg.query('delete from vendors where property_id = $1 and name = $2', [PID_A1, 'Local Paper']);
    await pg.query('delete from knowledge_contacts where id = any($1::uuid[])', [[foreign, mine]]);
  });
});

describe('ordering — an order already on its way', () => {
  async function scratchItem(name: string, stock = 0, par = 40): Promise<string> {
    return (await one<{ id: string }>(
      `insert into inventory (property_id, name, category, current_stock, par_level, unit)
       values ($1, $2, 'housekeeping', $3, $4, 'each') returning id`,
      [PID_A1, name, stock, par],
    ))!.id;
  }


  async function placeOrder(itemId: string, daysAgo: number): Promise<string> {
    const id = (await one<{ id: string }>(
      `insert into purchase_orders
         (property_id, po_number, status, placed_via, sent_at, created_at)
       values ($1, 'PO-TEST-' || substr(gen_random_uuid()::text, 1, 8), 'sent', 'store',
               now() - ($2 || ' days')::interval, now() - ($2 || ' days')::interval)
       returning id`,
      [PID_A1, String(daysAgo)],
    ))!.id;
    await pg.query(
      `insert into purchase_order_lines (purchase_order_id, item_id, description, qty_ordered)
       values ($1, $2, 'Scratch', 5)`,
      [id, itemId],
    );
    return id;
  }

  test('an order sent yesterday is on its way; a delivery clears it', async () => {
    const itemId = await scratchItem('On the way');
    const orderId = await placeOrder(itemId, 1);

    const open = await openOrdersByItem(PID_A1, [itemId]);
    assert.ok(open.get(itemId), 'the item has an order in flight');

    // Scanning the delivery is what puts a still-short item back on the list.
    await pg.query(
      `insert into inventory_orders
         (property_id, item_id, item_name, quantity, unit_cost, total_cost, received_at, entry_kind)
       values ($1,$2,'On the way',5,1.00,5.00, now(), 'receipt')`,
      [PID_A1, itemId],
    );
    const afterDelivery = await openOrdersByItem(PID_A1, [itemId]);
    assert.equal(afterDelivery.get(itemId), undefined, 'delivered, so nothing is on its way');

    await pg.query('delete from purchase_orders where id = $1', [orderId]);
    await pg.query('delete from inventory_orders where item_id = $1', [itemId]);
    await pg.query('delete from inventory where id = $1', [itemId]);
  });

  test('the screen stops asking for what was just ordered, and asks again when it is late',
    async () => {
      // THE FEATURE'S CORE PROMISE, end to end through the real GET. The stamp
      // this used to write was read by nothing, so an ordered item sat on the
      // list every day until the delivery landed.
      const fresh = await scratchItem('Ordered today');
      const late = await scratchItem('Ordered long ago');
      const freshOrder = await placeOrder(fresh, 1);
      const lateOrder = await placeOrder(late, 12);

      const screen = await getScreen(PID_A1);
      assert.equal(screen.status, 200);
      const names = (screen.body.data?.groups as Array<{ items: Array<{ name: string }> }>)
        .flatMap((g) => g.items.map((i) => i.name));
      assert.ok(!names.includes('Ordered today'), 'already ordered, so not asked for again');
      assert.ok(names.includes('Ordered long ago'), 'late enough that it must be chased');

      const lateRow = (screen.body.data?.groups as Array<{
        items: Array<{ name: string; openOrder: { daysAgo: number } | null }>;
      }>).flatMap((g) => g.items).find((i) => i.name === 'Ordered long ago')!;
      assert.equal(lateRow.openOrder?.daysAgo, 12, 'and says it was already ordered, so nobody double-orders blind');

      await pg.query('delete from purchase_orders where id = any($1::uuid[])', [[freshOrder, lateOrder]]);
      await pg.query('delete from inventory where id = any($1::uuid[])', [[fresh, late]]);
    });

  test('an identical order minutes ago is found; the same order from another hotel is not', async () => {
    const itemId = await scratchItem('Content keyed');
    const orderId = (await one<{ id: string }>(
      `insert into purchase_orders (property_id, po_number, status, vendor_id, placed_via)
       values ($1, 'PO-MATCH-01', 'draft', $2, 'email') returning id`,
      [PID_A1, sysco],
    ))!.id;
    await pg.query(
      `insert into purchase_order_lines (purchase_order_id, item_id, description, qty_ordered)
       values ($1, $2, 'Content keyed', 5)`,
      [orderId, itemId],
    );

    const match = await findRecentMatchingOrder(PID_A1, sysco, [itemId]);
    assert.equal(match?.poNumber, 'PO-MATCH-01');
    assert.equal(match?.status, 'draft');

    // A different vendor, and a different hotel, are different orders.
    assert.equal(await findRecentMatchingOrder(PID_A1, guestSupply, [itemId]), null);
    assert.equal(await findRecentMatchingOrder(PID_B1, sysco, [itemId]), null);

    await pg.query('delete from purchase_orders where id = $1', [orderId]);
    await pg.query('delete from inventory where id = $1', [itemId]);
  });
});
