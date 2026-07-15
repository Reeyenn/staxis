// Durable exact-retry envelope for the primary Add Item sheet.
//
// New catalog rows use a client-generated UUID. If the insert commits but its
// response is lost, the same immutable row can be retried with the same UUID;
// Postgres then reports the existing row instead of creating a duplicate.

import type { InventoryCategory } from '@/types';

export interface FrozenInventoryItemCreateAttempt {
  version: 1;
  propertyId: string;
  requestId: string;
  itemId: string;
  startedAt: string;
  nameInput: string;
  currentStockInput: string;
  parLevelInput: string;
  unitCostInput: string;
  vendorInput: string;
  includeUnitCost: boolean;
  name: string;
  category: InventoryCategory;
  customCategoryId: string | null;
  currentStock: number;
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
  parLevelInput: string;
  unitCostInput: string;
  vendorInput: string;
  vendorId: string | null;
  includeUnitCost: boolean;
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
  return {
    version: 1,
    propertyId,
    requestId,
    itemId,
    startedAt: input.startedAt,
    nameInput: input.nameInput,
    currentStockInput: input.currentStockInput,
    parLevelInput: input.parLevelInput,
    unitCostInput: input.unitCostInput,
    vendorInput: input.vendorInput,
    includeUnitCost: input.includeUnitCost,
    name,
    category: input.category,
    customCategoryId: input.customCategoryId,
    currentStock: finiteNonnegative(input.currentStockInput),
    parLevel: finiteNonnegative(input.parLevelInput),
    unitCost,
    vendorName: input.vendorInput.trim() || null,
    vendorId: input.vendorId,
  };
}

function isFrozenAttempt(value: unknown, propertyId: string): value is FrozenInventoryItemCreateAttempt {
  if (!value || typeof value !== 'object') return false;
  const x = value as Partial<FrozenInventoryItemCreateAttempt>;
  if (
    x.version !== 1
    || x.propertyId !== propertyId
    || typeof x.requestId !== 'string'
    || typeof x.itemId !== 'string'
    || typeof x.startedAt !== 'string'
    || typeof x.nameInput !== 'string'
    || typeof x.currentStockInput !== 'string'
    || typeof x.parLevelInput !== 'string'
    || typeof x.unitCostInput !== 'string'
    || typeof x.vendorInput !== 'string'
    || typeof x.includeUnitCost !== 'boolean'
    || typeof x.name !== 'string'
    || !['housekeeping', 'maintenance', 'breakfast'].includes(String(x.category))
    || (x.customCategoryId !== null && typeof x.customCategoryId !== 'string')
    || typeof x.currentStock !== 'number'
    || !Number.isFinite(x.currentStock)
    || x.currentStock < 0
    || typeof x.parLevel !== 'number'
    || !Number.isFinite(x.parLevel)
    || x.parLevel < 0
    || (x.unitCost !== null && (typeof x.unitCost !== 'number' || !Number.isFinite(x.unitCost) || x.unitCost < 0))
    || (x.vendorName !== null && typeof x.vendorName !== 'string')
    || (x.vendorId !== null && typeof x.vendorId !== 'string')
    || Number.isNaN(new Date(x.startedAt).getTime())
  ) return false;
  const parsedCost = x.unitCostInput.trim() === '' ? null : Number(x.unitCostInput);
  const canonicalCost = x.includeUnitCost
    && parsedCost != null
    && Number.isFinite(parsedCost)
    && parsedCost >= 0
    ? parsedCost
    : null;
  return x.requestId === x.requestId.trim()
    && x.requestId.length > 0
    && x.itemId === x.itemId.trim()
    && x.itemId.length > 0
    && x.name === x.nameInput.trim()
    && x.name.length > 0
    && x.currentStock === finiteNonnegative(x.currentStockInput)
    && x.parLevel === finiteNonnegative(x.parLevelInput)
    && x.vendorName === (x.vendorInput.trim() || null)
    && x.unitCost === canonicalCost;
}

export function persistInventoryItemCreateAttempt(
  attempt: FrozenInventoryItemCreateAttempt,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!isFrozenAttempt(attempt, attempt.propertyId) || !storage) {
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
    return isFrozenAttempt(parsed, propertyId) ? parsed : null;
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
