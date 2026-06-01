// Shared types for the Equipment (asset) registry — feature revived 0249.
//
// Pure types + const enums only. NO supabaseAdmin / server imports here so this
// module is safe to import from both the API routes (server) and the registry
// UI / client db wrappers (browser). Mirrors src/lib/compliance/types.ts.

export const EQUIPMENT_CATEGORIES = [
  'hvac', 'plumbing', 'electrical', 'appliance', 'structural',
  'elevator', 'pool', 'laundry', 'kitchen', 'other',
] as const;
export type EquipmentCategory = typeof EQUIPMENT_CATEGORIES[number];

export const EQUIPMENT_STATUSES = [
  'operational', 'degraded', 'failed', 'replaced', 'decommissioned',
] as const;
export type EquipmentStatus = typeof EQUIPMENT_STATUSES[number];

/** One asset row, camelCase, as returned by /api/maintenance/equipment. */
export interface Equipment {
  id: string;
  propertyId: string;
  name: string;
  category: EquipmentCategory;
  location: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  status: EquipmentStatus;
  installDate: string | null;          // YYYY-MM-DD
  expectedLifetimeYears: number | null;
  purchaseCost: number | null;         // dollars
  replacementCost: number | null;      // dollars
  pmIntervalDays: number | null;
  lastPmAt: string | null;             // ISO timestamp
  warrantyProvider: string | null;
  warrantyExpiresAt: string | null;    // YYYY-MM-DD
  notes: string | null;
  createdAt: string | null;            // ISO timestamp
  updatedAt: string | null;            // ISO timestamp
}

/** Writable fields. name + category required on create; all optional on patch. */
export interface EquipmentInput {
  name: string;
  category: EquipmentCategory;
  location: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  status: EquipmentStatus;
  installDate: string | null;
  expectedLifetimeYears: number | null;
  purchaseCost: number | null;
  replacementCost: number | null;
  pmIntervalDays: number | null;
  warrantyProvider: string | null;
  warrantyExpiresAt: string | null;
  notes: string | null;
}

/** A single row in an asset's combined repair/PM history. */
export interface EquipmentHistoryItem {
  kind: 'work_order' | 'preventive';
  id: string;
  date: string | null;     // ISO — completed/last-done date, else created_at
  title: string;           // work-order description OR PM task name
  detail: string | null;   // location (WO) / area (PM)
  cost: number | null;     // work-order repair_cost; null for PM
  status: string | null;   // work order: 'open' | 'done'; PM: null
  priority: string | null; // work order priority; PM: null
}

/** Asset detail + derived history/spend, as returned by the [id] GET route. */
export interface EquipmentDetail {
  equipment: Equipment;
  history: EquipmentHistoryItem[];
  totalRepairSpend: number;   // sum of linked work-order repair_cost
  failureCount: number;       // count of linked work orders
  workOrderCount: number;
  preventiveCount: number;
}
