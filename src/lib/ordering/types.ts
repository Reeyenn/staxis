// ═══════════════════════════════════════════════════════════════════════════
// Inventory vendors + ordering — shared domain types.
//
// 2026-07-18: the purchase-order types (PurchaseOrder, CatalogItem, cart /
// receive inputs, spend rollup) were removed with the ordering flow — every
// hotel orders differently and the flow is being redesigned as a per-hotel
// workflow. Vendor survived: inventory items link to a vendor record, and the
// vendors table (migration 0246) still backs /api/inventory/vendors.
//
// 2026-07-28: the redesign landed as the AI Ordering Manager. "Every hotel
// orders differently" is now modelled directly — OrderMethod is the shape of
// that difference, and it is NULLABLE because how a hotel orders from a vendor
// is the one fact no data we hold can reveal.
// ═══════════════════════════════════════════════════════════════════════════

/** How this hotel places an order with this vendor.
 *
 *  Exactly one of these is true per vendor, and only ONE of them is something
 *  Staxis can carry out (`email`). The other three end with a human acting, so
 *  every button label bound to them says so. */
export type OrderMethod = 'email' | 'website' | 'store' | 'phone';

export const ORDER_METHODS: readonly OrderMethod[] = ['email', 'website', 'store', 'phone'];

/** Whether a human asserted this vendor or we inferred it.
 *
 *  A suggestion renders visibly as a suggestion and is never counted as hotel
 *  knowledge — the order cards do not group by it and nothing is sent on its
 *  behalf until someone taps confirm. */
export type VendorReviewState = 'suggested' | 'confirmed';

/** Where a suggestion came from. Shown to the manager so a confirm tap is an
 *  informed one ("we saw this on an invoice" vs "this is in your contacts"). */
export type VendorSuggestionSource = 'contact' | 'invoice' | 'chat';

export const VENDOR_SUGGESTION_SOURCES: readonly VendorSuggestionSource[] = [
  'contact',
  'invoice',
  'chat',
];

export interface Vendor {
  id: string;
  propertyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  accountNumber: string | null;
  notes: string | null;
  isActive: boolean;
  /** NULL = we have not been told. Renders as the one missing-piece chip. */
  orderMethod: OrderMethod | null;
  websiteUrl: string | null;
  /** The knowledge_contacts row this vendor was built from, if any. A link,
   *  never a copy — the contact stays the one place to edit name/phone/email. */
  knowledgeContactId: string | null;
  reviewState: VendorReviewState;
  suggestedFrom: VendorSuggestionSource | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** The inventory page's own category partition, reused verbatim.
 *
 *  Not a second taxonomy: these are the chips the manager already sees at the
 *  top of the inventory list. Every item resolves to exactly one. */
export type BucketKey = 'general' | 'breakfast' | `custom:${string}`;

export interface VendorCategoryLink {
  bucketKey: BucketKey;
  vendorId: string;
}

/** Why a given item is attributed to a given vendor.
 *
 *  Surfaced in the UI because "where did this come from?" is the question a
 *  manager asks the first time a card groups an item under a vendor they did
 *  not pick for it. */
export type VendorSourceKind =
  /** inventory.vendor_id — someone set this item's vendor directly. */
  | 'item'
  /** vendor_category_map — inherited from the item's category. */
  | 'category'
  /** inventory.vendor_name free text with no matching vendor row. Legacy; a
   *  name we can show but cannot order from. */
  | 'legacy_name'
  /** Nothing knows who supplies this. Renders the "Who supplies this?" chip. */
  | 'unknown';

export interface ResolvedVendorRef {
  kind: VendorSourceKind;
  vendorId: string | null;
  /** Display name. For 'legacy_name' this is the free-text value. */
  vendorName: string | null;
  /** The bucket the item fell into — always present, even when unmatched, so
   *  the picker can offer "map this whole category" as well as "just this item". */
  bucketKey: BucketKey;
}

/** How confident the "you go through ~N/week" line is.
 *
 *  Mirrors BurnSource from inventory-predictions.ts one-for-one. It is carried
 *  through to the UI rather than collapsed into a number because the honesty
 *  rule is that a rate with no data behind it renders as a dash, never as a
 *  confident-looking figure derived from par/60. */
export type BurnConfidence = 'ml' | 'rule-occupancy' | 'thin' | 'none';

export interface OrderCandidate {
  itemId: string;
  name: string;
  unit: string;
  bucketKey: BucketKey;
  /** Usable stock right now (current_stock − set_aside, floored at 0). */
  onHand: number;
  par: number;
  /** 'critical' | 'low' — 'good' items never become candidates. */
  status: 'critical' | 'low';
  /** How many units to bring it back to par. Always ≥ 1 when listed. */
  suggestedQty: number;
  burnPerDay: number | null;
  burnConfidence: BurnConfidence;
  /** Days until empty at the current rate. NULL whenever burnConfidence is
   *  'thin' or 'none' — the UI renders a dash, not a number. */
  daysLeft: number | null;
  /** Last invoice price in CENTS, or null when this item has never appeared on
   *  a scanned invoice. NEVER an estimate: no receipt means no figure. */
  lastPriceCents: number | null;
  /** When that price was last seen, so the figure can be labelled. */
  lastPriceAt: string | null;
  /** suggestedQty × lastPriceCents, or null when lastPriceCents is null. */
  lineTotalCents: number | null;
  vendor: ResolvedVendorRef;
}

/** One vendor's worth of candidates, plus what we can honestly do about them. */
export interface OrderGroup {
  vendorId: string | null;
  vendorName: string | null;
  /** NULL for the unmatched group and for vendors nobody has told us about. */
  orderMethod: OrderMethod | null;
  vendorEmail: string | null;
  vendorPhone: string | null;
  websiteUrl: string | null;
  reviewState: VendorReviewState | null;
  items: OrderCandidate[];
  /** Sum of lineTotalCents over items that HAVE a receipt price. Items without
   *  one are excluded and counted in `itemsWithoutPrice` — a total that quietly
   *  skipped half the list would read as the whole order's cost. */
  knownSubtotalCents: number;
  itemsWithoutPrice: number;
  /** Why this vendor's primary button is or is not available. */
  blocked: OrderBlockReason | null;
}

/** The honest reason a vendor cannot be acted on yet. Each maps to a chip. */
export type OrderBlockReason =
  /** order_method is null — nobody told us how they order from this vendor. */
  | 'method_unknown'
  /** email vendor with no address on file. */
  | 'no_email'
  /** website vendor with no URL on file. */
  | 'no_url'
  /** phone vendor with no number on file. */
  | 'no_phone'
  /** the vendor row is still a suggestion. */
  | 'unconfirmed';

export interface VendorSuggestion {
  /** Stable key for the confirm tap. For contact-sourced suggestions this is
   *  the knowledge_contacts id; for invoice-sourced it is a normalized name. */
  key: string;
  name: string;
  source: VendorSuggestionSource;
  email: string | null;
  phone: string | null;
  knowledgeContactId: string | null;
  /** How many scanned invoices carried this vendor name. 0 for contacts. */
  seenOnInvoices: number;
  /** Categories we saw this vendor's items land in, offered pre-ticked in the
   *  confirm step. Empty when we have no evidence — never guessed. */
  bucketHints: BucketKey[];
}
