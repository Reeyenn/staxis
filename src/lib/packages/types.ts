// ═══════════════════════════════════════════════════════════════════════════
// Packages — shared types + constants.
//
// PURE module: no supabase-admin, no env, no server-only imports. Both the
// server store (src/lib/packages/store.ts) and the client data layer
// (src/lib/db/packages.ts, type-only + the carrier const) import from here, so
// it must never pull anything that carries `import 'server-only'` into the
// browser bundle.
// ═══════════════════════════════════════════════════════════════════════════

/** Carriers the label scan / UI normalize to. Mirrors the migration CHECK. */
export const PACKAGE_CARRIERS = ['UPS', 'FedEx', 'USPS', 'Amazon', 'Other'] as const;
export type PackageCarrier = (typeof PACKAGE_CARRIERS)[number];

export const PACKAGE_STATUSES = ['held', 'picked_up'] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

/** Normalized package row as the API returns it (camelCase, photo signed). */
export interface PackageRow {
  id: string;
  guestName: string;
  roomNumber: string | null;
  carrier: PackageCarrier | null;
  trackingNumber: string | null;
  notes: string | null;
  photoPath: string | null;
  /** Short-lived signed view URL for the label photo, when present. */
  photoUrl: string | null;
  status: PackageStatus;
  loggedAt: string;
  pickedUpAt: string | null;
}

export interface PackageCounts {
  held: number;
  pickedUp: number;
}

/** Result of the AI shipping-label scan (nothing saved; the form pre-fills). */
export interface ScannedLabel {
  guestName: string | null;
  roomNumber: string | null;
  carrier: PackageCarrier | null;
  trackingNumber: string | null;
}
