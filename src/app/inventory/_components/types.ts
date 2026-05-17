// Shared display-only types for the inventory rebuild.
// `DisplayItem` is what the UI grids consume — keeps real data layer types
// (InventoryItem) untouched while letting components destructure cleanly.

import type { InventoryItem } from '@/types';
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
}
