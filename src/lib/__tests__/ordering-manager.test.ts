/**
 * THE ORDERING MANAGER'S JUDGEMENT, without a database.
 *
 * Everything here is a rule a manager would notice being wrong, and every case
 * is written so it FAILS against the plausible bug rather than against a
 * rename:
 *
 *   • who supplies an item, when the item, its category and a legacy text name
 *     all have an opinion — the precedence is the product ruling, and the
 *     plausible bug (category quietly beating an explicit per-item override)
 *     makes "fix it once" false without changing anything visible;
 *   • what a MISSING price and a MISSING burn rate are allowed to look like —
 *     the plausible bug is a confident $0.00 or a days-left number derived from
 *     par ÷ 60, both of which read as facts;
 *   • what the purchase-order email says when half the lines have no price —
 *     it is a document a hotel can be billed against;
 *   • that every method's button promises only what that method can do.
 *
 * Pure functions only. The DB-shaped half — never re-asking, the tenant wall,
 * the two-phase confirm — is proved against a real Postgres in
 * agent-chat-do-wires.integration.test.ts and
 * ordering-manager-routes.integration.test.ts.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  bucketKeyForItem,
  resolveVendorForItem,
  buildCandidate,
  rankCandidates,
  groupByVendor,
  blockReasonFor,
} from '@/lib/ordering/resolve';
import { renderPoEmail, sendPoEmail } from '@/lib/ordering/po-email';
import { mintPoNumber } from '@/lib/ordering/db';
import type { BucketKey, Vendor } from '@/lib/ordering/types';
import { orderingStrings } from '@/app/inventory/_components/overlays/ordering-i18n';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CUSTOM_ID = '11111111-2222-4333-8444-555555555555';

function vendor(over: Partial<Vendor> & { id: string; name: string }): Vendor {
  return {
    propertyId: 'p1',
    email: null,
    phone: null,
    accountNumber: null,
    notes: null,
    isActive: true,
    orderMethod: null,
    websiteUrl: null,
    knowledgeContactId: null,
    reviewState: 'confirmed',
    suggestedFrom: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

const SYSCO = vendor({ id: 'v-sysco', name: 'Sysco', orderMethod: 'email', email: 'orders@sysco.test' });
const GUEST_SUPPLY = vendor({ id: 'v-gs', name: 'Guest Supply', orderMethod: 'website', websiteUrl: 'https://gs.test/order' });
const SAMS = vendor({ id: 'v-sams', name: "Sam's Club", orderMethod: 'store' });

const VENDORS = new Map([SYSCO, GUEST_SUPPLY, SAMS].map((v) => [v.id, v]));

// ═══════════════════════════════════════════════════════════════════════════
// 1. Category buckets — the partition every other rule stands on
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — the category an item falls into', () => {
  test('a custom category wins over the built-in one', () => {
    // Mirrors inBucket: a custom-category item shows ONLY under its own tab.
    // The plausible bug is checking `category` first, which would put every
    // custom-category breakfast item under Breakfast and hand it Breakfast's
    // vendor.
    assert.equal(
      bucketKeyForItem({ category: 'breakfast', customCategoryId: CUSTOM_ID }),
      `custom:${CUSTOM_ID}`,
    );
  });

  test('breakfast is its own bucket and everything else is general', () => {
    assert.equal(bucketKeyForItem({ category: 'breakfast', customCategoryId: null }), 'breakfast');
    assert.equal(bucketKeyForItem({ category: 'housekeeping', customCategoryId: null }), 'general');
    assert.equal(bucketKeyForItem({ category: 'maintenance', customCategoryId: null }), 'general');
    assert.equal(bucketKeyForItem({ category: null, customCategoryId: null }), 'general');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Who supplies this item — precedence
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — vendor resolution precedence', () => {
  const categoryMap = new Map<BucketKey, string>([['breakfast', 'v-sysco'], ['general', 'v-sams']]);

  test('items inherit their vendor from their category', () => {
    const resolved = resolveVendorForItem(
      { category: 'breakfast', customCategoryId: null, vendorId: null, vendorName: null },
      categoryMap,
      VENDORS,
    );
    assert.equal(resolved.kind, 'category');
    assert.equal(resolved.vendorId, 'v-sysco');
  });

  test("a per-item vendor BEATS the category, which is what makes 'fix it once' true", () => {
    // THE case. A breakfast item explicitly pointed at Sam's must stay with
    // Sam's. If the category won here, the one-tap override would appear to
    // work and silently revert on the next render.
    const resolved = resolveVendorForItem(
      { category: 'breakfast', customCategoryId: null, vendorId: 'v-sams', vendorName: null },
      categoryMap,
      VENDORS,
    );
    assert.equal(resolved.kind, 'item');
    assert.equal(resolved.vendorId, 'v-sams');
  });

  test('a deleted or deactivated vendor falls through to the category, never to a dangling id', () => {
    const withInactive = new Map(VENDORS);
    withInactive.set('v-gone', vendor({ id: 'v-gone', name: 'Gone', isActive: false }));
    const resolved = resolveVendorForItem(
      { category: 'breakfast', customCategoryId: null, vendorId: 'v-gone', vendorName: null },
      categoryMap,
      withInactive,
    );
    assert.equal(resolved.kind, 'category', 'an inactive override should degrade to inheritance');
    assert.equal(resolved.vendorId, 'v-sysco');
  });

  test('a legacy free-text name is shown but is not a supplier we can order from', () => {
    const resolved = resolveVendorForItem(
      { category: 'housekeeping', customCategoryId: CUSTOM_ID, vendorId: null, vendorName: 'Old Linen Co' },
      categoryMap,
      VENDORS,
    );
    assert.equal(resolved.kind, 'legacy_name');
    assert.equal(resolved.vendorName, 'Old Linen Co');
    assert.equal(resolved.vendorId, null, 'a name with no row behind it must not look orderable');
  });

  test('nothing known renders as unknown, which is what draws the "who supplies this?" chip', () => {
    const resolved = resolveVendorForItem(
      { category: 'housekeeping', customCategoryId: CUSTOM_ID, vendorId: null, vendorName: null },
      categoryMap,
      VENDORS,
    );
    assert.equal(resolved.kind, 'unknown');
    assert.equal(resolved.bucketKey, `custom:${CUSTOM_ID}`, 'the bucket is still reported so the picker can offer the whole category');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Worth ordering — and what a missing number looks like
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — what is worth ordering now', () => {
  const empty = new Map<BucketKey, string>();

  function candidate(over: Partial<Parameters<typeof buildCandidate>[0]> = {}) {
    return buildCandidate(
      {
        itemId: 'i1', name: 'Bath towels', unit: 'each',
        onHand: 12, par: 100,
        category: 'housekeeping', customCategoryId: null,
        vendorId: null, vendorName: null,
        burnPerDay: 9 / 7, burnConfidence: 'rule-occupancy',
        lastPriceCents: 250, lastPriceAt: '2026-07-01T00:00:00Z',
        ...over,
      },
      empty,
      VENDORS,
    );
  }

  test('uses the house 70/30 thresholds, not the inventory page\'s 50/100', () => {
    // 75% of par is GOOD under 70/30 and LOW under the page's 0.5/1.0 rule.
    // The spec pins this screen to 70/30, so a 75-of-100 item must not appear.
    assert.equal(candidate({ onHand: 75 }), null, '75% of par is above the 70% line');
    assert.ok(candidate({ onHand: 65 }), '65% of par is low');
    assert.equal(candidate({ onHand: 65 })!.status, 'low');
    assert.equal(candidate({ onHand: 12 })!.status, 'critical');
  });

  test('an item with no par is never ordered — there is no shortfall to compute', () => {
    // The plausible bug is treating par 0 as "everything is a shortage", which
    // would put every half-set-up item on a purchase order.
    assert.equal(candidate({ par: 0 }), null);
    assert.equal(candidate({ par: -5 }), null);
  });

  test('quantity brings it back to par, rounds up, and is never zero', () => {
    assert.equal(candidate({ onHand: 12, par: 100 })!.suggestedQty, 88);
    // A fractional gap rounds UP — ordering 3 when 3.5 are short leaves the
    // item below par the moment it arrives.
    assert.equal(candidate({ onHand: 6.5, par: 10 })!.suggestedQty, 4);
  });

  test('a thin or absent burn rate publishes NO days-left number', () => {
    // par ÷ 60 is arithmetic on the par level wearing a forecast's clothes.
    // Showing it is the exact dishonesty the BurnSource rule exists to stop.
    const thin = candidate({ burnConfidence: 'thin', burnPerDay: 100 / 60 })!;
    assert.equal(thin.daysLeft, null, 'a fallback rate must render as a dash, not a number');
    assert.equal(thin.burnPerDay, null);

    const none = candidate({ burnConfidence: 'none', burnPerDay: 1 })!;
    assert.equal(none.daysLeft, null);

    const real = candidate({ burnConfidence: 'ml', burnPerDay: 4 })!;
    assert.equal(real.daysLeft, 3, '12 on hand at 4/day is 3 days');
  });

  test('no invoice history means NO dollar figure — not an estimate, not zero', () => {
    const priced = candidate({ lastPriceCents: 250 })!;
    assert.equal(priced.lineTotalCents, 250 * 88);

    const unpriced = candidate({ lastPriceCents: null })!;
    assert.equal(unpriced.lastPriceCents, null);
    assert.equal(unpriced.lineTotalCents, null, 'a missing price must stay missing, never become 0');
    assert.equal(unpriced.lastPriceAt, null, 'no price means no "as of" claim either');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The queue rule
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — the order of the list', () => {
  const empty = new Map<BucketKey, string>();
  function make(name: string, onHand: number, par: number, priceCents: number | null) {
    return buildCandidate(
      {
        itemId: name, name, unit: 'each', onHand, par,
        category: 'housekeeping', customCategoryId: null,
        vendorId: null, vendorName: null,
        burnPerDay: 1, burnConfidence: 'ml',
        lastPriceCents: priceCents, lastPriceAt: '2026-07-01T00:00:00Z',
      },
      empty,
      VENDORS,
    )!;
  }

  test('biggest dollar impact leads', () => {
    const ranked = rankCandidates([
      make('cheap', 1, 10, 100),      // 9 × $1.00 = $9
      make('pricey', 1, 10, 5000),    // 9 × $50   = $450
      make('middle', 1, 10, 1000),    // 9 × $10   = $90
    ]);
    assert.deepEqual(ranked.map((c) => c.name), ['pricey', 'middle', 'cheap']);
  });

  test('items with no price sort AFTER priced ones, by severity — never as $0', () => {
    // The plausible bug is ranking an unknown price as zero, which buries a
    // critical unpriced item under every trivial priced one AND implies the
    // hotel pays nothing for it.
    const ranked = rankCandidates([
      make('unpriced-low', 6, 10, null),       // 60% of par → low
      make('unpriced-critical', 1, 10, null),  // 10% of par → critical
      make('priced-tiny', 6, 10, 1),           // low, and worth all of 4¢
    ]);
    assert.equal(ranked[0].name, 'priced-tiny', 'a real dollar figure leads');
    assert.deepEqual(
      ranked.slice(1).map((c) => c.name),
      ['unpriced-critical', 'unpriced-low'],
      'among unpriced items, severity decides',
    );
  });

  test('a hotel with no invoice history at all still gets a severity queue', () => {
    // The floor case. Day one, nothing scanned: the list must still be ordered
    // by something meaningful rather than arbitrarily.
    const ranked = rankCandidates([
      make('a-low', 6, 10, null),
      make('z-critical', 1, 10, null),
    ]);
    assert.deepEqual(ranked.map((c) => c.name), ['z-critical', 'a-low']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Grouping + what each vendor can honestly be asked to do
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — grouping and blocked reasons', () => {
  test('a vendor is blocked until we know how they take orders', () => {
    assert.equal(blockReasonFor(vendor({ id: 'v', name: 'V' })), 'method_unknown');
    assert.equal(blockReasonFor(vendor({ id: 'v', name: 'V', orderMethod: 'email' })), 'no_email');
    assert.equal(blockReasonFor(vendor({ id: 'v', name: 'V', orderMethod: 'website' })), 'no_url');
    assert.equal(blockReasonFor(vendor({ id: 'v', name: 'V', orderMethod: 'phone' })), 'no_phone');
    // A store run needs nothing but a name — there is nothing to be missing.
    assert.equal(blockReasonFor(vendor({ id: 'v', name: 'V', orderMethod: 'store' })), null);
    assert.equal(blockReasonFor(SYSCO), null);
  });

  test('a suggestion is blocked as UNCONFIRMED even when it looks complete', () => {
    // A guess that happens to carry an email must not become sendable just
    // because every other field is present. The confirm tap is the gate.
    const suggested = vendor({
      id: 'v', name: 'Maybe Co', orderMethod: 'email',
      email: 'a@b.test', reviewState: 'suggested', suggestedFrom: 'invoice',
    });
    assert.equal(blockReasonFor(suggested), 'unconfirmed');
  });

  test('unmatched items land in ONE trailing group, and legacy names join them', () => {
    const empty = new Map<BucketKey, string>();
    const mk = (name: string, vendorId: string | null, vendorName: string | null, price: number | null) =>
      buildCandidate(
        {
          itemId: name, name, unit: 'each', onHand: 1, par: 10,
          category: 'housekeeping', customCategoryId: null,
          vendorId, vendorName,
          burnPerDay: 1, burnConfidence: 'ml',
          lastPriceCents: price, lastPriceAt: null,
        },
        empty,
        VENDORS,
      )!;

    const groups = groupByVendor(
      rankCandidates([
        mk('towels', 'v-sysco', null, 1000),
        mk('mystery', null, null, null),
        mk('old-linen', null, 'Old Linen Co', null),
      ]),
      VENDORS,
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0].vendorId, 'v-sysco');
    const last = groups[groups.length - 1];
    assert.equal(last.vendorId, null, 'the unmatched group is pinned last');
    assert.deepEqual(
      last.items.map((i) => i.name).sort(),
      ['mystery', 'old-linen'],
      'a legacy name cannot be ordered from either, so it shares the setup group',
    );
  });

  test('a group total counts only priced lines and says how many it left out', () => {
    const empty = new Map<BucketKey, string>();
    const mk = (name: string, price: number | null) =>
      buildCandidate(
        {
          itemId: name, name, unit: 'each', onHand: 0, par: 10,
          category: 'housekeeping', customCategoryId: null,
          vendorId: 'v-sysco', vendorName: null,
          burnPerDay: 1, burnConfidence: 'ml',
          lastPriceCents: price, lastPriceAt: null,
        },
        empty,
        VENDORS,
      )!;
    const [group] = groupByVendor(rankCandidates([mk('a', 100), mk('b', null)]), VENDORS);
    assert.equal(group.knownSubtotalCents, 1000, '10 units at $1.00');
    assert.equal(group.itemsWithoutPrice, 1, 'the skipped line is counted, not silently dropped');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The purchase-order email
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — the purchase-order email', () => {
  const base = {
    to: 'orders@sysco.test',
    vendorName: 'Sysco',
    hotelName: 'Comfort Suites Beaumont',
    managerName: 'Maria Garcia',
    managerEmail: 'maria@hotel.test',
    poNumber: 'PO-260728-A1B2',
    accountNumber: '55123',
    notes: null,
  };

  test('says whose behalf it is on, and points replies at the hotel', () => {
    const r = renderPoEmail({ ...base, lines: [{ description: 'Eggs', qty: 4, unit: 'case', unitCostCents: 1200 }] });
    assert.match(r.html, /on behalf of/i);
    assert.match(r.text, /on behalf of/i);
    assert.match(r.html, /maria@hotel\.test/, 'the vendor must be able to reach a human at the hotel');
    assert.match(r.subject, /PO-260728-A1B2/);
  });

  test('a line with no price on file renders a dash, and the subtotal says it skipped it', () => {
    const r = renderPoEmail({
      ...base,
      lines: [
        { description: 'Eggs', qty: 4, unit: 'case', unitCostCents: 1200 },
        { description: 'Sausage', qty: 2, unit: 'case', unitCostCents: null },
      ],
    });
    assert.equal(r.knownSubtotalCents, 4800, 'only the priced line counts');
    assert.equal(r.linesWithoutPrice, 1);
    assert.match(r.text, /no price on file/i);
    assert.match(r.html, /no price on file/i);
    // The unpriced line must still APPEAR — the vendor needs to know it is wanted.
    assert.match(r.text, /Sausage/);
    assert.ok(!/\$0\.00/.test(r.text.split('Subtotal')[0]), 'an unpriced line must never render as $0.00');
  });

  test('it asks the vendor to confirm price and says it is not a contract', () => {
    const r = renderPoEmail({ ...base, lines: [{ description: 'Eggs', qty: 4, unit: 'case', unitCostCents: 1200 }] });
    assert.match(r.text, /confirm price and availability/i);
    assert.match(r.text, /not a contract/i);
  });

  test('a hostile vendor or hotel name cannot inject markup or split a header', () => {
    const r = renderPoEmail({
      ...base,
      hotelName: 'Evil\r\nBcc: someone@else.test',
      vendorName: '<script>alert(1)</script>',
      lines: [{ description: '<b>Eggs</b>', qty: 1, unit: 'case', unitCostCents: 100 }],
    });
    assert.ok(!r.subject.includes('\n') && !r.subject.includes('\r'), 'no CR/LF may reach the subject');
    assert.ok(!r.html.includes('<script>'), 'vendor name must be escaped');
    assert.match(r.html, /&lt;script&gt;/);
    assert.match(r.html, /&lt;b&gt;Eggs/, 'item descriptions are escaped too');
  });

  test('the send sets reply-to and a PO-stable idempotency key, and never invents a recipient', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const result = await sendPoEmail(
      { ...base, lines: [{ description: 'Eggs', qty: 4, unit: 'case', unitCostCents: 1200 }] },
      async (params) => {
        captured.push(params as unknown as Record<string, unknown>);
        return { ok: true, id: 'msg-1' };
      },
    );
    assert.equal(result.ok, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].to, 'orders@sysco.test');
    assert.equal(captured[0].replyTo, 'maria@hotel.test');
    assert.match(String(captured[0].idempotencyKey), /^inventory-po:/);

    // The same PO to the same vendor derives the SAME key, so a double-tap
    // cannot put two copies of one order in a supplier's inbox.
    const again: Array<Record<string, unknown>> = [];
    await sendPoEmail(
      { ...base, lines: [{ description: 'Eggs', qty: 4, unit: 'case', unitCostCents: 1200 }] },
      async (params) => { again.push(params as unknown as Record<string, unknown>); return { ok: true, id: 'msg-2' }; },
    );
    assert.equal(again[0].idempotencyKey, captured[0].idempotencyKey);
  });

  test('PO numbers are unique enough that two managers ordering at once do not collide', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(mintPoNumber(new Date('2026-07-28T00:00:00Z')));
    assert.ok(seen.size > 450, `expected mostly-distinct numbers, got ${seen.size}/500`);
    assert.match([...seen][0], /^PO-260728-[0-9A-F]{4}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Truthful button labels
// ═══════════════════════════════════════════════════════════════════════════

describe('ordering — the screen promises only what it can do', () => {
  for (const lang of ['en', 'es'] as const) {
    test(`[${lang}] the website action says PREP, never ORDER, and says who places it`, () => {
      const tx = orderingStrings(lang);
      // The founder's exact ruling: for a website vendor we prep the list and
      // hand over the link — we cannot and will not check out. A label that
      // said "Order" would be a promise the code deliberately does not keep.
      assert.ok(/prep|prepara/i.test(tx.prepOrder), `prepOrder should say prep, got "${tx.prepOrder}"`);
      assert.ok(
        /you place|tú haces/i.test(tx.prepHint),
        'the website hint must say the manager places the order',
      );
      assert.ok(
        /cannot|no podemos/i.test(tx.welcomeWebsite),
        'the welcome must say outright that we will not check out for them',
      );
    });

    test(`[${lang}] the welcome states all three money/privacy limits`, () => {
      const tx = orderingStrings(lang);
      assert.ok(/never spends|nunca gasta/i.test(tx.welcomeLine2));
      assert.ok(/card|tarjeta/i.test(tx.welcomeLine2));
      assert.ok(/email account|tu correo/i.test(tx.welcomeLine2));
    });

    test(`[${lang}] the undo copy admits the send has not started`, () => {
      const tx = orderingStrings(lang);
      assert.ok(
        /nothing is sent|no se envía nada/i.test(tx.undoHonesty),
        'the countdown must say nothing has gone out yet',
      );
      assert.ok(
        /close|cierras/i.test(tx.undoHonesty),
        'and must say what happens if they close the screen mid-countdown',
      );
    });

    test(`[${lang}] a missing price is described as missing, not as free`, () => {
      const tx = orderingStrings(lang);
      assert.ok(/no price|sin precio/i.test(tx.noPrice));
      assert.ok(/leaves|no incluye|no los incluye/i.test(tx.linesWithoutPrice(2)));
    });

    test(`[${lang}] an unmeasurable burn rate is a sentence, not a number`, () => {
      const tx = orderingStrings(lang);
      assert.ok(
        /not enough|no hay suficientes/i.test(tx.burnUnknown),
        'the no-data case must explain itself rather than print a figure',
      );
    });
  }

  test('every string exists in both languages', () => {
    const en = orderingStrings('en') as Record<string, unknown>;
    const es = orderingStrings('es') as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(en).sort(),
      Object.keys(es).sort(),
      'a key present in one language and missing in the other renders undefined to a user',
    );
    // Words that really are the same in both languages. The check below exists
    // to catch a copy-paste that left English in the Spanish block, so genuine
    // cognates are listed here rather than weakening the assertion for
    // everything.
    const SAME_IN_BOTH = new Set(['subtotal']);
    for (const [key, value] of Object.entries(en)) {
      if (typeof value === 'string') {
        assert.ok(value.trim().length > 0, `EN ${key} is empty`);
        assert.ok(String(es[key]).trim().length > 0, `ES ${key} is empty`);
        if (SAME_IN_BOTH.has(key)) continue;
        assert.notEqual(
          value,
          es[key],
          `${key} is byte-identical in both languages — it was probably never translated`,
        );
      }
    }
  });
});
