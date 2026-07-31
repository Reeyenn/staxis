// ═══════════════════════════════════════════════════════════════════════════
// Ordering — vendor resolution and the "worth ordering now" list.
//
// PURE. No database, no clock, no imports from the inventory UI tree. Every
// input arrives as an argument so the precedence rules and the ranking can be
// tested directly, which matters because both encode product rulings that are
// invisible from the outside: which vendor wins for an item, and what a
// missing price is allowed to look like.
//
// A separate file from db.ts on purpose — db.ts is service-role-only and
// imports supabaseAdmin, so anything importing it drags a live DB client into
// scope. These functions are also called from the agent tool layer and from
// tests that must not touch Supabase.
// ═══════════════════════════════════════════════════════════════════════════

import { stockStatus } from '@/lib/stock-status';
import type {
  BucketKey,
  BurnConfidence,
  OpenOrderRef,
  OrderBlockReason,
  OrderCandidate,
  OrderGroup,
  ResolvedVendorRef,
  Vendor,
} from './types';

// ─── Category bucket ────────────────────────────────────────────────────────

/** The minimum an item must expose to be bucketed. Structural rather than the
 *  full InventoryItem so tests and the agent layer can pass literals. */
export interface BucketableItem {
  category: string | null;
  customCategoryId: string | null;
}

/**
 * Which category chip this item lives under.
 *
 * Mirrors `inBucket` in src/app/inventory/_components/tokens.ts exactly, and
 * must keep mirroring it: the whole point of reusing the page's partition is
 * that a manager mapping "Breakfast → Sysco" sees the same set of items under
 * that chip as the ones the order card then groups under Sysco. If the two
 * drift, the setup screen and the order screen disagree about the same word.
 *
 * The partition is total and disjoint — a custom category wins outright, then
 * breakfast, then everything else is general — so every item has exactly one
 * bucket and inheritance can never be ambiguous.
 */
export function bucketKeyForItem(item: BucketableItem): BucketKey {
  if (item.customCategoryId) return `custom:${item.customCategoryId}`;
  if (item.category === 'breakfast') return 'breakfast';
  return 'general';
}

// ─── The hotel's own name ───────────────────────────────────────────────────

/** Lowercase, punctuation-free, single-spaced — the comparison form for
 *  "is this the same trading name?". */
function comparableName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Does this candidate supplier name look like the property itself?
 *
 * The invoice scanner reads vendor_name off a photographed page, and on some
 * layouts the most prominent name on the page is the BILL-TO — the hotel.
 * Live example: "Grand Harbor Hotel" was offered to Grand Harbor Hotel as a
 * supplier it might use. A hotel is never its own supplier, so suggestion
 * building drops any candidate whose normalized name equals, contains, or is
 * contained by the property's own name. Containment matters because the
 * printed form is rarely exact: "Grand Harbor Hotel LLC" (longer) and "Grand
 * Harbor" (shorter) are both the hotel. The shorter side must still be a
 * substantial name (6+ characters) so a short real vendor can never be
 * swallowed by a hotel that happens to share a word with it.
 */
export function looksLikePropertyItself(
  candidate: string,
  propertyName: string | null | undefined,
): boolean {
  const a = comparableName(candidate);
  const b = comparableName(propertyName ?? '');
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  // Whole words only: "Grand Harbor" is the hotel, "Harborview Supply" is not.
  return shorter.length >= 6 && ` ${longer} `.includes(` ${shorter} `);
}

// ─── Vendor resolution ──────────────────────────────────────────────────────

export interface VendorResolvableItem extends BucketableItem {
  vendorId: string | null;
  vendorName: string | null;
}

/**
 * Who supplies this item.
 *
 * PRECEDENCE, and the order is the product ruling:
 *
 *   1. the item's OWN vendor (inventory.vendor_id) — the per-item override.
 *      One tap on a card that looks wrong sets this, and it must then beat the
 *      category forever, including after the category is remapped. An override
 *      that a later category change could silently undo would make the "fix it
 *      once" promise false.
 *   2. the CATEGORY map — the one-minute setup. This is where almost every
 *      item gets its answer.
 *   3. the legacy free-text `vendor_name` with no row behind it. Shown, never
 *      ordered from: we have a name and nothing else — no method, no address —
 *      so it is a label, not a supplier.
 *   4. nothing. Renders the "Who supplies this?" chip.
 *
 * A vendor id that does not resolve to a known vendor (deleted, deactivated,
 * or another hotel's — the last of which the tenant trigger already refuses at
 * the database) falls THROUGH to the category rather than resolving to a
 * dangling id, so a removed vendor degrades to inheritance instead of to a
 * card that names nobody.
 */
export function resolveVendorForItem(
  item: VendorResolvableItem,
  categoryMap: ReadonlyMap<BucketKey, string>,
  vendorsById: ReadonlyMap<string, Vendor>,
): ResolvedVendorRef {
  const bucketKey = bucketKeyForItem(item);

  if (item.vendorId) {
    const own = vendorsById.get(item.vendorId);
    if (own && own.isActive) {
      return { kind: 'item', vendorId: own.id, vendorName: own.name, bucketKey };
    }
  }

  const mapped = categoryMap.get(bucketKey);
  if (mapped) {
    const vendor = vendorsById.get(mapped);
    if (vendor && vendor.isActive) {
      return { kind: 'category', vendorId: vendor.id, vendorName: vendor.name, bucketKey };
    }
  }

  const legacy = item.vendorName?.trim();
  if (legacy) {
    return { kind: 'legacy_name', vendorId: null, vendorName: legacy, bucketKey };
  }

  return { kind: 'unknown', vendorId: null, vendorName: null, bucketKey };
}

// ─── Worth ordering now ─────────────────────────────────────────────────────

/** Everything the candidate builder needs about one item. Assembled by the
 *  route from the inventory row plus the burn-rate and price lookups. */
export interface CandidateInput {
  itemId: string;
  name: string;
  unit: string;
  /** current_stock − set_aside, floored at 0, already computed by the caller
   *  (the set-aside rule lives in the inventory layer, not here). */
  onHand: number;
  par: number;
  category: string | null;
  customCategoryId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  /** Per-day burn and where it came from. NULL rate ⇒ confidence must be
   *  'thin' or 'none'; the builder asserts nothing, it just refuses to
   *  publish daysLeft for those. */
  burnPerDay: number | null;
  burnConfidence: BurnConfidence;
  /** Most recent price actually seen on a scanned invoice, in CENTS. */
  lastPriceCents: number | null;
  lastPriceAt: string | null;
  /** An order already placed for this item that nothing has been delivered
   *  against, or null. REQUIRED, not optional, and that is the point: the
   *  screen's core promise is that ordering something takes it off the list,
   *  and a caller that forgets to look it up must fail to compile rather than
   *  quietly re-list everything the hotel ordered yesterday. */
  openOrder: OpenOrderRef | null;
}

/**
 * How long an order keeps its items off the list.
 *
 * The honest bound on "we already ordered this". An order normally leaves the
 * list the moment the delivery is scanned, which is the real signal; this is
 * the backstop for the order that never arrives, because an item that is
 * genuinely out of stock and whose order has vanished must come back rather
 * than stay hidden forever behind a purchase order nobody honoured. A week is
 * long enough to cover any supplier's lead time and short enough that a lost
 * order surfaces before the hotel runs dry.
 */
export const OPEN_ORDER_SUPPRESS_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/** Whole days between an ISO timestamp and now, or null when the timestamp is
 *  unreadable. Callers treat null as "we cannot say", never as zero. */
export function daysSince(iso: string, now: Date): number | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return (now.getTime() - then) / MS_PER_DAY;
}

/** Burn sources that are allowed to produce a days-left number.
 *
 *  'thin' is the par/60 fallback — a number that looks like a forecast and is
 *  arithmetic on the par level; 'none' is no data at all. Both render as a
 *  dash. This is the same rule the item cards already follow (BurnSource in
 *  inventory-predictions.ts), restated here so the ordering screen cannot
 *  quietly become the one surface that shows the confident-looking fiction. */
const TRUSTED_BURN: ReadonlySet<BurnConfidence> = new Set<BurnConfidence>(['ml', 'rule-occupancy']);

/**
 * Turn one item into an order candidate, or null when it is not worth ordering.
 *
 * "Worth ordering" is status low-or-critical against par on the house 70/30
 * thresholds (src/lib/stock-status.ts). An item with no par (par ≤ 0) is never
 * a candidate: with nothing to compare against there is no shortfall to
 * compute, and inventing one would put items on a purchase order because
 * nobody had finished setting them up.
 *
 * AND IT IS NOT WORTH ORDERING TWICE. An item with an order already on its way
 * is not a candidate at all, however low the shelf is: stock does not move
 * until the delivery lands, so without this the screen asks the manager to
 * re-order everything they ordered yesterday, every day, until it arrives.
 * That is the one failure that makes the whole list untrustworthy, so the rule
 * lives here rather than in a caller. An order old enough that the delivery
 * should have come (OPEN_ORDER_SUPPRESS_DAYS) puts the item BACK on the list
 * and carries the order with it, so the row can say it was already ordered
 * instead of pretending nothing happened.
 */
export function buildCandidate(
  input: CandidateInput,
  categoryMap: ReadonlyMap<BucketKey, string>,
  vendorsById: ReadonlyMap<string, Vendor>,
  now: Date = new Date(),
): OrderCandidate | null {
  if (!(input.par > 0)) return null;

  const status = stockStatus(input.onHand, input.par);
  if (status === 'good') return null;

  // An unreadable order date is "we cannot say", and we do not hide a real
  // shortage on the strength of something we cannot read.
  const orderAgeDays = input.openOrder ? daysSince(input.openOrder.orderedAt, now) : null;
  if (orderAgeDays !== null && orderAgeDays < OPEN_ORDER_SUPPRESS_DAYS) return null;
  const openOrder = input.openOrder && orderAgeDays !== null
    ? { ...input.openOrder, daysAgo: Math.max(0, Math.floor(orderAgeDays)) }
    : null;

  const suggestedQty = Math.max(1, Math.ceil(input.par - input.onHand));

  const trusted = TRUSTED_BURN.has(input.burnConfidence) && input.burnPerDay != null && input.burnPerDay > 0;
  const daysLeft = trusted ? input.onHand / (input.burnPerDay as number) : null;

  const lastPriceCents = input.lastPriceCents != null && input.lastPriceCents >= 0
    ? Math.round(input.lastPriceCents)
    : null;

  return {
    itemId: input.itemId,
    name: input.name,
    unit: input.unit,
    bucketKey: bucketKeyForItem(input),
    onHand: input.onHand,
    par: input.par,
    status,
    suggestedQty,
    burnPerDay: trusted ? input.burnPerDay : null,
    burnConfidence: input.burnConfidence,
    daysLeft,
    lastPriceCents,
    lastPriceAt: lastPriceCents == null ? null : input.lastPriceAt,
    lineTotalCents: lastPriceCents == null ? null : lastPriceCents * suggestedQty,
    openOrder,
    vendor: resolveVendorForItem(input, categoryMap, vendorsById),
  };
}

const SEVERITY_RANK: Record<'critical' | 'low', number> = { critical: 0, low: 1 };

/**
 * The house queue rule: biggest dollar impact first, then severity.
 *
 * The wrinkle the rule does not state is what to do with an item that has NO
 * dollar impact — not a small one, an unknown one, because the hotel has never
 * scanned an invoice carrying it. Ranking it as $0 would sort every unpriced
 * item to the bottom, and on day one (no invoice history at all) that is the
 * entire list, leaving the floor case sorted by nothing.
 *
 * So: priced items rank above unpriced ones and sort by dollars descending;
 * unpriced items sort among themselves by severity, then by urgency, then by
 * name. A hotel with receipts gets the dollar-impact queue it was promised; a
 * hotel with none gets a severity queue instead of an arbitrary one, and never
 * a queue built on a number nobody can back up.
 */
export function rankCandidates(candidates: readonly OrderCandidate[]): OrderCandidate[] {
  return [...candidates].sort((a, b) => {
    const aPriced = a.lineTotalCents != null;
    const bPriced = b.lineTotalCents != null;
    if (aPriced !== bPriced) return aPriced ? -1 : 1;
    if (aPriced && bPriced && a.lineTotalCents !== b.lineTotalCents) {
      return (b.lineTotalCents as number) - (a.lineTotalCents as number);
    }
    const sev = SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status];
    if (sev !== 0) return sev;
    // Soonest to run out first. A null days-left sorts last within its band —
    // it is not "far away", it is unknown, and an unknown must not outrank a
    // measured shortage.
    const aDays = a.daysLeft ?? Number.POSITIVE_INFINITY;
    const bDays = b.daysLeft ?? Number.POSITIVE_INFINITY;
    if (aDays !== bDays) return aDays - bDays;
    return a.name.localeCompare(b.name);
  });
}

// ─── Grouping by vendor ─────────────────────────────────────────────────────

/**
 * Why this vendor's primary action is unavailable, or null when it is ready.
 *
 * Order matters: an unconfirmed suggestion is reported as unconfirmed even if
 * it is also missing its method, because confirming is the tap in front of the
 * manager and telling them about a second gap they have not reached yet is
 * noise.
 */
export function blockReasonFor(vendor: Vendor): OrderBlockReason | null {
  if (vendor.reviewState === 'suggested') return 'unconfirmed';
  if (!vendor.orderMethod) return 'method_unknown';
  if (vendor.orderMethod === 'email' && !vendor.email) return 'no_email';
  if (vendor.orderMethod === 'website' && !vendor.websiteUrl) return 'no_url';
  if (vendor.orderMethod === 'phone' && !vendor.phone) return 'no_phone';
  return null;
}

/** Sort key for the unmatched group so it always renders last. */
const UNMATCHED_KEY = '￿';

/**
 * Group ranked candidates under their vendors.
 *
 * Everything with no resolvable vendor row — unknown AND legacy free-text —
 * lands in ONE trailing group with vendorId null. Legacy names join it rather
 * than forming per-name groups because a name with no method and no address
 * cannot be ordered from either; giving it its own card would render a header
 * that looks actionable and is not. The name still shows on the item row, so
 * the picker can pre-fill it.
 *
 * Group order follows the queue rule at group level: the group holding the
 * biggest known dollar total leads. The unmatched group is pinned last
 * regardless — it is a setup task, not an order.
 */
export function groupByVendor(
  ranked: readonly OrderCandidate[],
  vendorsById: ReadonlyMap<string, Vendor>,
): OrderGroup[] {
  const groups = new Map<string, OrderGroup>();

  for (const candidate of ranked) {
    const vendorId = candidate.vendor.vendorId;
    const key = vendorId ?? UNMATCHED_KEY;
    let group = groups.get(key);
    if (!group) {
      const vendor = vendorId ? vendorsById.get(vendorId) : undefined;
      group = {
        vendorId: vendorId,
        vendorName: vendor?.name ?? null,
        orderMethod: vendor?.orderMethod ?? null,
        vendorEmail: vendor?.email ?? null,
        vendorPhone: vendor?.phone ?? null,
        websiteUrl: vendor?.websiteUrl ?? null,
        reviewState: vendor?.reviewState ?? null,
        items: [],
        knownSubtotalCents: 0,
        itemsWithoutPrice: 0,
        blocked: vendor ? blockReasonFor(vendor) : null,
      };
      groups.set(key, group);
    }
    group.items.push(candidate);
    if (candidate.lineTotalCents == null) group.itemsWithoutPrice += 1;
    else group.knownSubtotalCents += candidate.lineTotalCents;
  }

  return [...groups.values()].sort((a, b) => {
    const aUnmatched = a.vendorId == null;
    const bUnmatched = b.vendorId == null;
    if (aUnmatched !== bUnmatched) return aUnmatched ? 1 : -1;
    if (a.knownSubtotalCents !== b.knownSubtotalCents) {
      return b.knownSubtotalCents - a.knownSubtotalCents;
    }
    return (a.vendorName ?? '').localeCompare(b.vendorName ?? '');
  });
}
