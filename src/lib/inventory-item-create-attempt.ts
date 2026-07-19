// Durable exact-retry envelope for the primary Add Item sheet.
//
// New catalog rows use a client-generated UUID. If the insert commits but its
// response is lost, the same immutable row can be retried with the same UUID;
// Postgres then reports the existing row instead of creating a duplicate.

import type { InventoryCategory } from '@/types';

export interface FrozenInventoryItemCreateAttempt {
  version: 3;
  propertyId: string;
  requestId: string;
  itemId: string;
  startedAt: string;
  nameInput: string;
  currentStockInput: string;
  setAsideInput: string;
  parLevelInput: string;
  unitCostInput: string;
  vendorInput: string;
  includeUnitCost: boolean;
  openingAdjustmentConfirmed: boolean;
  name: string;
  category: InventoryCategory;
  customCategoryId: string | null;
  currentStock: number;
  setAside: number;
  parLevel: number;
  unitCost: number | null;
  vendorName: string | null;
  vendorId: string | null;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class InventoryItemCreatePersistenceError extends Error {
  readonly code = 'ITEM_CREATE_ATTEMPT_NOT_DURABLE';

  constructor() {
    super('The new item was not sent because its recovery copy could not be saved.');
    this.name = 'InventoryItemCreatePersistenceError';
  }
}

function browserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

function finiteNonnegative(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function finiteNonnegativeInteger(raw: string): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function inventoryItemCreateMarker(requestId: string): string {
  return `staxis:add-item:${requestId}`;
}

export function inventoryItemCreateStorageKey(propertyId: string): string {
  return `staxis:inventory-item-create-attempt:${propertyId}`;
}

export function createFrozenInventoryItemAttempt(input: {
  propertyId: string;
  requestId: string;
  itemId: string;
  startedAt: string;
  nameInput: string;
  category: InventoryCategory;
  customCategoryId: string | null;
  currentStockInput: string;
  setAsideInput: string;
  parLevelInput: string;
  unitCostInput: string;
  vendorInput: string;
  vendorId: string | null;
  includeUnitCost: boolean;
  openingAdjustmentConfirmed: boolean;
}): FrozenInventoryItemCreateAttempt {
  const propertyId = input.propertyId.trim();
  const requestId = input.requestId.trim();
  const itemId = input.itemId.trim();
  const name = input.nameInput.trim();
  if (!propertyId || !requestId || !itemId || !name) {
    throw new Error('Property, request, item, and name are required.');
  }
  if (!['housekeeping', 'maintenance', 'breakfast'].includes(input.category)) {
    throw new Error('Inventory category is invalid.');
  }
  if (Number.isNaN(new Date(input.startedAt).getTime())) {
    throw new Error('Inventory item timestamp is invalid.');
  }
  const parsedCost = input.unitCostInput.trim() === '' ? null : Number(input.unitCostInput);
  const unitCost = input.includeUnitCost
    && parsedCost != null
    && Number.isFinite(parsedCost)
    && parsedCost >= 0
    ? parsedCost
    : null;
  const currentStock = finiteNonnegative(input.currentStockInput);
  const setAside = finiteNonnegativeInteger(input.setAsideInput);
  if (setAside > currentStock) {
    throw new Error('Set-aside quantity cannot exceed on-hand stock.');
  }
  if (currentStock > 0 && !input.openingAdjustmentConfirmed) {
    throw new Error('Positive starting stock must be confirmed as pre-existing opening inventory.');
  }
  if (currentStock > 0 && unitCost == null) {
    throw new Error('A unit cost is required to value pre-existing opening inventory.');
  }
  return {
    version: 3,
    propertyId,
    requestId,
    itemId,
    startedAt: input.startedAt,
    nameInput: input.nameInput,
    currentStockInput: input.currentStockInput,
    setAsideInput: input.setAsideInput,
    parLevelInput: input.parLevelInput,
    unitCostInput: input.unitCostInput,
    vendorInput: input.vendorInput,
    includeUnitCost: input.includeUnitCost,
    openingAdjustmentConfirmed: currentStock > 0 && input.openingAdjustmentConfirmed,
    name,
    category: input.category,
    customCategoryId: input.customCategoryId,
    currentStock,
    setAside,
    parLevel: finiteNonnegative(input.parLevelInput),
    unitCost,
    vendorName: input.vendorInput.trim() || null,
    vendorId: input.vendorId,
  };
}

/**
 * Canonicalize every retry envelope that has shipped. V1 predates opening
 * adjustments and Set Aside; V2 adds opening-adjustment provenance; V3 adds
 * Set Aside. Migrating in memory preserves the original item/request ids, so
 * an ambiguous older insert remains safe to retry instead of being dropped.
 */
function normalizeFrozenAttempt(
  value: unknown,
  propertyId: string,
): FrozenInventoryItemCreateAttempt | null {
  if (!value || typeof value !== 'object') return null;
  const x = value as Record<string, unknown>;
  const version = x.version;
  if (
    (version !== 1 && version !== 2 && version !== 3)
    || x.propertyId !== propertyId
    || typeof x.requestId !== 'string'
    || typeof x.itemId !== 'string'
    || typeof x.startedAt !== 'string'
    || typeof x.nameInput !== 'string'
    || typeof x.currentStockInput !== 'string'
    || (version === 3 && typeof x.setAsideInput !== 'string')
    || typeof x.parLevelInput !== 'string'
    || typeof x.unitCostInput !== 'string'
    || typeof x.vendorInput !== 'string'
    || typeof x.includeUnitCost !== 'boolean'
    || (version >= 2 && typeof x.openingAdjustmentConfirmed !== 'boolean')
    || typeof x.name !== 'string'
    || !['housekeeping', 'maintenance', 'breakfast'].includes(String(x.category))
    || (x.customCategoryId !== null && typeof x.customCategoryId !== 'string')
    || typeof x.currentStock !== 'number'
    || !Number.isFinite(x.currentStock)
    || x.currentStock < 0
    || (version === 3 && (
      typeof x.setAside !== 'number'
      || !Number.isInteger(x.setAside)
      || x.setAside < 0
    ))
    || typeof x.parLevel !== 'number'
    || !Number.isFinite(x.parLevel)
    || x.parLevel < 0
    || (x.unitCost !== null && (typeof x.unitCost !== 'number' || !Number.isFinite(x.unitCost) || x.unitCost < 0))
    || (x.vendorName !== null && typeof x.vendorName !== 'string')
    || (x.vendorId !== null && typeof x.vendorId !== 'string')
    || Number.isNaN(new Date(x.startedAt).getTime())
  ) return null;

  // Reject hybrid/partially upgraded payloads. A legacy retry had no Set
  // Aside keys at all, so accepting one key without the other would break the
  // exact-payload guarantee.
  if (version < 3 && ('setAsideInput' in x || 'setAside' in x)) return null;
  if (version === 1 && 'openingAdjustmentConfirmed' in x) return null;

  const parsedCost = x.unitCostInput.trim() === '' ? null : Number(x.unitCostInput);
  const canonicalCost = x.includeUnitCost
    && parsedCost != null
    && Number.isFinite(parsedCost)
    && parsedCost >= 0
    ? parsedCost
    : null;
  const currentStock = finiteNonnegative(x.currentStockInput);
  const openingAdjustmentConfirmed = version >= 2
    ? x.openingAdjustmentConfirmed as boolean
    : false;
  const setAsideInput = version === 3 ? x.setAsideInput as string : '0';
  const valid = x.requestId === x.requestId.trim()
    && x.requestId.length > 0
    && x.itemId === x.itemId.trim()
    && x.itemId.length > 0
    && x.name === x.nameInput.trim()
    && x.name.length > 0
    && x.currentStock === currentStock
    && (version < 3 || x.setAside === finiteNonnegativeInteger(setAsideInput))
    && x.parLevel === finiteNonnegative(x.parLevelInput)
    && (version === 1 || openingAdjustmentConfirmed === (currentStock > 0))
    && (version === 1 || currentStock === 0 || canonicalCost != null)
    && x.vendorName === (x.vendorInput.trim() || null)
    && x.unitCost === canonicalCost;
  if (!valid) return null;

  return {
    version: 3,
    propertyId: x.propertyId,
    requestId: x.requestId,
    itemId: x.itemId,
    startedAt: x.startedAt,
    nameInput: x.nameInput,
    currentStockInput: x.currentStockInput,
    setAsideInput,
    parLevelInput: x.parLevelInput,
    unitCostInput: x.unitCostInput,
    vendorInput: x.vendorInput,
    includeUnitCost: x.includeUnitCost,
    openingAdjustmentConfirmed,
    name: x.name,
    category: x.category as InventoryCategory,
    customCategoryId: x.customCategoryId,
    currentStock,
    setAside: version === 3 ? x.setAside as number : 0,
    parLevel: x.parLevel,
    unitCost: x.unitCost,
    vendorName: x.vendorName,
    vendorId: x.vendorId,
  };
}

export function persistInventoryItemCreateAttempt(
  attempt: FrozenInventoryItemCreateAttempt,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!normalizeFrozenAttempt(attempt, attempt.propertyId) || !storage) {
    throw new InventoryItemCreatePersistenceError();
  }
  const key = inventoryItemCreateStorageKey(attempt.propertyId);
  const serialized = JSON.stringify(attempt);
  try {
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error('storage verification failed');
  } catch {
    // Do not remove here: this may be a transient failure while re-verifying a
    // previously durable retry. Keeping the last confirmed envelope is safer
    // than erasing the only recovery copy.
    throw new InventoryItemCreatePersistenceError();
  }
}

export function loadInventoryItemCreateAttempt(
  propertyId: string,
  storage: StorageLike | null = browserStorage(),
): FrozenInventoryItemCreateAttempt | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(inventoryItemCreateStorageKey(propertyId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return normalizeFrozenAttempt(parsed, propertyId);
  } catch {
    return null;
  }
}

export function clearInventoryItemCreateAttempt(
  propertyId: string,
  requestId: string,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    const existing = loadInventoryItemCreateAttempt(propertyId, storage);
    if (!existing || existing.requestId === requestId) {
      storage.removeItem(inventoryItemCreateStorageKey(propertyId));
    }
  } catch {
    // A stale exact-retry envelope is safe; the fixed item UUID is idempotent.
  }
}

export function isDefinitiveInventoryItemCreateFailure(error: unknown): boolean {
  if (error instanceof InventoryItemCreatePersistenceError) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  const normalized = code.trim().toUpperCase();
  // SQLSTATE/PostgREST errors prove that Postgres returned a rejection.
  // Transport codes such as ECONNRESET or NETWORK_ERROR remain ambiguous.
  return /^(?:22|23|28|40|42|53|54|55|57|58|P0|XX)[0-9A-Z]{3}$/.test(normalized)
    || /^PGRST\d{3}$/.test(normalized);
}
