// ═══════════════════════════════════════════════════════════════════════════
// Inventory Ordering — shared domain types.
//
// Money: purchase-order amounts are INTEGER CENTS (subtotalCents,
// unitCostCents) to match the financials convention. The legacy inventory /
// inventory_orders ledger stays in DOLLARS — conversion happens at the
// boundary in src/lib/ordering/db.ts (createPurchaseOrders / receivePurchaseOrder).
//
// All access is service-role-only via /api/inventory/* (migration 0246).
// ═══════════════════════════════════════════════════════════════════════════

export type OrderStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'sent'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export type OrderingMode = 'simple' | 'pro';

export type CatalogCategory = 'housekeeping' | 'maintenance' | 'breakfast';

export interface Vendor {
  id: string;
  propertyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  accountNumber: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface PurchaseOrderLine {
  id: string;
  purchaseOrderId: string;
  itemId: string | null;
  description: string;
  qtyOrdered: number;
  unitCostCents: number;
  qtyReceived: number;
}

export interface PurchaseOrder {
  id: string;
  propertyId: string;
  poNumber: string;
  vendorId: string | null;
  vendorName: string | null; // snapshot
  vendorEmail: string | null; // joined from the vendor row for UI convenience
  status: OrderStatus;
  subtotalCents: number;
  notes: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  sentToEmail: string | null;
  receivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PurchaseOrderLine[];
}

export interface CatalogItem {
  id: string;
  name: string;
  category: CatalogCategory;
  defaultVendorName: string | null;
  suggestedPar: number | null;
  unit: string;
  suggestedUnitCostCents: number | null;
  sortOrder: number;
}

// One line from the reorder cart, handed to createPurchaseOrders. unitCostCents
// is derived client-side from the dollars-based inventory.unit_cost.
export interface CartLineInput {
  itemId: string | null;
  description: string;
  qtyOrdered: number;
  unitCostCents: number;
  vendorName: string | null; // free-text vendor on the item
  vendorId: string | null; // resolved vendor link, if the item has one
}

// Per-line receive instruction. qtyReceived is the CUMULATIVE target (the new
// total received for the line), not a delta — so re-submitting is idempotent
// and can never double-count stock.
export interface ReceiveLineInput {
  lineId: string;
  qtyReceived: number;
}

// ── Cross-property spend rollup (Phase E) ──────────────────────────────────
export interface SpendRollupRow {
  key: string; // propertyId | vendor name | category
  label: string; // display label
  spentCents: number;
  orderCount: number;
}

export interface SpendRollup {
  fromIso: string;
  toIso: string;
  totalCents: number;
  byProperty: SpendRollupRow[];
  byVendor: SpendRollupRow[];
  byCategory: SpendRollupRow[];
}
