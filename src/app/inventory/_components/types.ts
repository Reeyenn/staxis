// Shared display-only types for the inventory rebuild.
// `DisplayItem` is what the UI grids consume — keeps real data layer types
// (InventoryItem) untouched while letting components destructure cleanly.

import type { InventoryItem } from '@/types';
import type { BurnSource } from '@/lib/inventory-predictions';
import type { ThumbKind } from './ItemThumb';
import type { StockStatus, InvCat } from './tokens';

export interface DisplayItem {
  raw: InventoryItem;       // original DB row for save flows
  id: string;
  name: string;
  cat: InvCat;
  thumb: ThumbKind;
  counted: number;          // last physical count (currentStock)
  estimated: number;        // ML/occupancy estimate as of now
  par: number;
  unit: string;
  unitCost: number;
  vendor: string;
  leadDays: number;
  burn: number;             // daily rate (display)
  burnUnit: '/day' | '/occ-room';
  /**
   * Provenance of the burn-rate number above. Honesty-audit Phase 4: the UI
   * uses this to decide whether to render `daysLeft` as a number or em-dash,
   * whether to pre-check the reorder panel, and whether to show the
   * onboarding banner. See `selectBurnRate` in `@/lib/inventory-predictions`.
   */
  burnSource: BurnSource;
  graduated: boolean;
  status: StockStatus;
  daysLeft: number;
  value: number;
  lastCountedAt: Date | null;
}

export interface ReorderRec {
  itemId: string;
  suggestQty: number;
  packs: string;
  cost: number;
  reason: string;
  urgency: 'now' | 'soon' | 'ok';
  /** Passed through from DisplayItem so the reorder panel can apply the
   *  pre-check rule + suffix the reason text by burn source. */
  burnSource: BurnSource;
}
