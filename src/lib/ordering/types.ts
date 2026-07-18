// ═══════════════════════════════════════════════════════════════════════════
// Inventory vendors — shared domain types.
//
// 2026-07-18: the purchase-order types (PurchaseOrder, CatalogItem, cart /
// receive inputs, spend rollup) were removed with the ordering flow — every
// hotel orders differently and the flow is being redesigned as a per-hotel
// workflow. Vendor survives: inventory items link to a vendor record, and the
// vendors table (migration 0246) still backs /api/inventory/vendors.
// ═══════════════════════════════════════════════════════════════════════════

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
