/**
 * Phase M1.5 (2026-05-14) — shared default inventory items list.
 *
 * Previously inlined in src/app/inventory/page.tsx where it auto-seeded
 * on first inventory page load. Extracted so the new admin
 * "+ New hotel" flow can seed these at property creation time, eliminating
 * the "open inventory page once before ML can train" race.
 *
 * Both consumers import from here so the list never drifts (the same
 * 4-place duplication anti-pattern Phase J flagged as a bug source).
 */

export interface DefaultInventoryItem {
  name: string;
  category: 'housekeeping' | 'breakfast' | 'maintenance';
  currentStock: number;
  parLevel: number;
  unit: string;
}

export const DEFAULT_INVENTORY_ITEMS: ReadonlyArray<DefaultInventoryItem> = [
  { name: 'King Sheets',           category: 'housekeeping', currentStock: 0, parLevel: 80,  unit: 'sets' },
  { name: 'Queen Sheets',          category: 'housekeeping', currentStock: 0, parLevel: 120, unit: 'sets' },
  { name: 'Pillowcases',           category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units' },
  { name: 'Bath Towels',           category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units' },
  { name: 'Hand Towels',           category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units' },
  { name: 'Washcloths',            category: 'housekeeping', currentStock: 0, parLevel: 200, unit: 'units' },
  { name: 'Bath Mats',             category: 'housekeeping', currentStock: 0, parLevel: 100, unit: 'units' },
  { name: 'Shampoo',               category: 'housekeeping', currentStock: 0, parLevel: 150, unit: 'bottles' },
  { name: 'Conditioner',           category: 'housekeeping', currentStock: 0, parLevel: 150, unit: 'bottles' },
  { name: 'Body Wash',             category: 'housekeeping', currentStock: 0, parLevel: 150, unit: 'bottles' },
  { name: 'All-Purpose Cleaner',   category: 'housekeeping', currentStock: 0, parLevel: 24,  unit: 'bottles' },
  { name: 'Glass Cleaner',         category: 'housekeeping', currentStock: 0, parLevel: 12,  unit: 'bottles' },
  { name: 'Trash Liners (Large)',  category: 'housekeeping', currentStock: 0, parLevel: 500, unit: 'bags' },
  { name: 'Coffee Pods',           category: 'breakfast',    currentStock: 0, parLevel: 200, unit: 'pods' },
  { name: 'Light Bulbs (LED)',     category: 'maintenance',  currentStock: 0, parLevel: 50,  unit: 'bulbs' },
  { name: 'HVAC Filters',          category: 'maintenance',  currentStock: 0, parLevel: 10,  unit: 'filters' },
];
