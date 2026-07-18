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
  /** Hotel-defined custom category id (0307), or null for a built-in item. */
  customCategoryId: string | null;
  thumb: ThumbKind;
  counted: number;          // last physical count (currentStock — TOTAL incl. set-aside)
  /** Units owned but unusable right now (stained / awaiting repair). Counted
   *  in value, excluded from usable stock (0321). */
  setAside: number;
  /** estimated − setAside, clamped at 0 — what can actually be used today.
   *  Drives status + days-left so 30 stained sheets can't hide a shortage. */
  usable: number;
  estimated: number;        // ML/occupancy estimate as of now (TOTAL incl. set-aside)
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
  /**
   * True when this item has never had a physical count AND its stock is 0 —
   * i.e. a brand-new hotel's seeded item. Such an item has no real signal, so
   * the UI renders a neutral "not counted yet" state instead of a red
   * "below par / critical" (which would falsely imply it's running out). It is
   * also excluded from Order-now / reorder counts + the reorder list. Once a
   * count is recorded (lastCountedAt set), it rejoins the normal triage.
   */
  uncounted: boolean;
  daysLeft: number;
  value: number;
  lastCountedAt: Date | null;
}
