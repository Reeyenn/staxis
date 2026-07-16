// Durable exact-retry envelope for atomic inventory counts. A transport error
// can happen after Postgres commits but before the browser receives the result;
// retaining this UUID + payload across a remount keeps the retry idempotent.

import type { AtomicInventoryCountRow } from './inventory-atomic';
import { toInventoryCountRpcRows } from './inventory-atomic';

export interface FrozenInventoryCountAttempt {
  version: 1;
  propertyId: string;
  fingerprint: string;
  requestId: string;
  countedAt: string;
  countedBy: string;
  rows: AtomicInventoryCountRow[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class InventoryCountAttemptPersistenceError extends Error {
  readonly code = 'INVENTORY_COUNT_ATTEMPT_NOT_DURABLE';

  constructor() {
    super('The inventory count could not be verified in local storage.');
    this.name = 'InventoryCountAttemptPersistenceError';
  }
}

function browserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function inventoryCountAttemptStorageKey(propertyId: string): string {
  return `staxis:inventory-count-attempt:${propertyId}`;
}

function isAttempt(value: unknown): value is FrozenInventoryCountAttempt {
  if (!value || typeof value !== 'object') return false;
  const x = value as Partial<FrozenInventoryCountAttempt>;
  return x.version === 1
    && typeof x.propertyId === 'string'
    && typeof x.fingerprint === 'string'
    && typeof x.requestId === 'string'
    && typeof x.countedAt === 'string'
    && !Number.isNaN(new Date(x.countedAt).getTime())
    && typeof x.countedBy === 'string'
    && Array.isArray(x.rows)
    && x.rows.length > 0;
}

export function loadInventoryCountAttempt(
  propertyId: string,
  storage: StorageLike | null = browserStorage(),
): FrozenInventoryCountAttempt | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(inventoryCountAttemptStorageKey(propertyId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isAttempt(parsed) || parsed.propertyId !== propertyId) return null;
    // Re-run the same deterministic validation used by the RPC helper before a
    // localStorage value can become a retry payload.
    toInventoryCountRpcRows(parsed.rows);
    return parsed;
  } catch {
    return null;
  }
}

export function persistInventoryCountAttempt(
  attempt: FrozenInventoryCountAttempt,
  storage: StorageLike | null = browserStorage(),
): void {
  // Validate and durably freeze the exact RPC rows before the transaction is
  // allowed to start. Otherwise a lost response followed by a reload could
  // lose the UUID and append the same count history a second time.
  if (!isAttempt(attempt)) throw new InventoryCountAttemptPersistenceError();
  try { toInventoryCountRpcRows(attempt.rows); } catch {
    throw new InventoryCountAttemptPersistenceError();
  }
  if (!storage) throw new InventoryCountAttemptPersistenceError();
  const key = inventoryCountAttemptStorageKey(attempt.propertyId);
  const serialized = JSON.stringify(attempt);
  try {
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error('count retry envelope was not retained');
  } catch {
    try { storage.removeItem(key); } catch {}
    throw new InventoryCountAttemptPersistenceError();
  }
}

export function clearInventoryCountAttempt(
  propertyId: string,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try { storage.removeItem(inventoryCountAttemptStorageKey(propertyId)); } catch {}
}

export function hasDefinitiveDatabaseFailure(
  error: unknown,
  unresolvedAttempt = false,
): boolean {
  // A local persistence failure is definitively pre-send only for a brand-new
  // attempt. While retrying an earlier ambiguous RPC, it says nothing about
  // whether that earlier transaction committed, so the envelope must stay.
  if (error instanceof InventoryCountAttemptPersistenceError) return !unresolvedAttempt;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  const normalized = code.trim().toUpperCase();
  return /^(?:22|23|28|40|42|53|54|55|57|58|P0|XX)[0-9A-Z]{3}$/.test(normalized)
    || /^PGRST\d{3}$/.test(normalized);
}
