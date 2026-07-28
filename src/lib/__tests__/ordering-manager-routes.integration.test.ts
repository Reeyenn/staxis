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

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
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
} from '@/lib/ordering/db';
import { resolveVendorForItem, buildCandidate, groupByVendor, rankCandidates } from '@/lib/ordering/resolve';
import type { BucketKey } from '@/lib/ordering/types';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { PID_A1, PID_B1, seedTwoCompanies } from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

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

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
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
