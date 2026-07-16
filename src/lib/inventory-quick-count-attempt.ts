// Durable exact-retry envelopes for ledger quick counts.
//
// A quick count is an absolute stock write. If the response disappears after
// Postgres commits, reusing only the UUID is not enough: the complete RPC
// payload must also be identical. These helpers persist that frozen payload per
// property/item before the RPC is allowed to start.

import { toInventoryCountRpcRows, type AtomicInventoryCountRow } from './inventory-atomic';

export interface FrozenQuickCountAttempt {
  version: 1;
  userId: string;
  propertyId: string;
  itemId: string;
  requestId: string;
  countedAt: string;
  countedBy: string;
  row: AtomicInventoryCountRow;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class QuickCountStorageError extends Error {
  /** True when any older envelope for this item was already made unloadable. */
  readonly supersededRetired: boolean;

  constructor(
    message = 'Quick-count retry storage is unavailable.',
    supersededRetired = false,
  ) {
    super(message);
    this.name = 'QuickCountStorageError';
    this.supersededRetired = supersededRetired;
  }
}

function browserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function quickCountAttemptStorageKey(propertyId: string): string {
  return `staxis:inventory-quick-count-attempt-index:${propertyId}`;
}

export function quickCountItemStorageKey(propertyId: string, itemId: string): string {
  return `staxis:inventory-quick-count-attempt:${propertyId}:${encodeURIComponent(itemId)}`;
}

function validateAttempt(value: unknown, propertyId: string): FrozenQuickCountAttempt {
  if (!value || typeof value !== 'object') throw new QuickCountStorageError('Stored quick count is malformed.');
  const x = value as Partial<FrozenQuickCountAttempt>;
  if (
    x.version !== 1
    || typeof x.userId !== 'string'
    || !x.userId.trim()
    || x.propertyId !== propertyId
    || typeof x.itemId !== 'string'
    || !x.itemId.trim()
    || typeof x.requestId !== 'string'
    || !x.requestId.trim()
    || typeof x.countedAt !== 'string'
    || Number.isNaN(new Date(x.countedAt).getTime())
    || typeof x.countedBy !== 'string'
    || !x.row
    || typeof x.row !== 'object'
    || x.row.itemId !== x.itemId
  ) {
    throw new QuickCountStorageError('Stored quick count is malformed.');
  }
  // Apply the exact deterministic validation used immediately before the RPC.
  toInventoryCountRpcRows([x.row]);
  return x as FrozenQuickCountAttempt;
}

function readIndex(propertyId: string, storage: StorageLike): string[] {
  let raw: string | null;
  try {
    raw = storage.getItem(quickCountAttemptStorageKey(propertyId));
  } catch {
    throw new QuickCountStorageError();
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    if (!parsed.every((value) => typeof value === 'string' && value.trim().length > 0)) {
      throw new Error('invalid item index');
    }
    const ids = parsed as string[];
    if (new Set(ids).size !== ids.length) throw new Error('duplicate item');
    return ids;
  } catch (error) {
    if (error instanceof QuickCountStorageError) throw error;
    throw new QuickCountStorageError('Stored quick counts could not be read safely.');
  }
}

function writeIndex(propertyId: string, itemIds: string[], storage: StorageLike): void {
  const key = quickCountAttemptStorageKey(propertyId);
  const serialized = JSON.stringify(itemIds);
  try {
    if (itemIds.length === 0) {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error('index removal failed');
    } else {
      storage.setItem(key, serialized);
      if (storage.getItem(key) !== serialized) throw new Error('index write failed');
    }
  } catch {
    throw new QuickCountStorageError();
  }
}

function readAttempts(propertyId: string, storage: StorageLike): FrozenQuickCountAttempt[] {
  const attempts: FrozenQuickCountAttempt[] = [];
  for (const itemId of readIndex(propertyId, storage)) {
    let raw: string | null;
    try { raw = storage.getItem(quickCountItemStorageKey(propertyId, itemId)); } catch {
      throw new QuickCountStorageError();
    }
    // A missing slot is a harmless tombstone left by a failed replacement or
    // best-effort cleanup. Crucially, it can never replay the superseded value.
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const attempt = validateAttempt(parsed, propertyId);
      if (attempt.itemId !== itemId) throw new Error('item slot mismatch');
      attempts.push(attempt);
    } catch (error) {
      if (error instanceof QuickCountStorageError) throw error;
      throw new QuickCountStorageError('Stored quick counts could not be read safely.');
    }
  }
  return attempts;
}

export function loadQuickCountAttempts(
  propertyId: string,
  storage: StorageLike | null = browserStorage(),
): FrozenQuickCountAttempt[] {
  if (!storage) throw new QuickCountStorageError();
  return readAttempts(propertyId, storage);
}

/** Persist or replace one item's frozen envelope. Throws before any RPC when
 * durable storage cannot be confirmed. */
export function persistQuickCountAttempt(
  attempt: FrozenQuickCountAttempt,
  storage: StorageLike | null = browserStorage(),
): void {
  validateAttempt(attempt, attempt.propertyId);
  if (!storage) throw new QuickCountStorageError();
  const itemIds = readIndex(attempt.propertyId, storage);
  const indexed = itemIds.includes(attempt.itemId);
  if (!indexed) writeIndex(attempt.propertyId, [...itemIds, attempt.itemId], storage);
  const key = quickCountItemStorageKey(attempt.propertyId, attempt.itemId);
  let retired = !indexed;
  try {
    if (indexed) {
      // Neutralize A before attempting B. Other items live in separate slots,
      // so they remain durable even if B cannot be written.
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error('superseded attempt could not be retired');
      retired = true;
    }
    const serialized = JSON.stringify(attempt);
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error('storage verification failed');
  } catch {
    throw new QuickCountStorageError('Quick-count retry storage is unavailable.', retired);
  }
}

/** Best-effort cleanup after a confirmed success/rejection. A stale envelope
 * is harmless because replaying its request UUID is idempotent. */
export function clearQuickCountAttempt(
  propertyId: string,
  itemId: string,
  requestId: string,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    const itemIds = readIndex(propertyId, storage);
    if (!itemIds.includes(itemId)) return true;
    const key = quickCountItemStorageKey(propertyId, itemId);
    const raw = storage.getItem(key);
    if (raw) {
      const saved = validateAttempt(JSON.parse(raw) as unknown, propertyId);
      if (saved.requestId !== requestId) return true;
    }
    storage.removeItem(key);
    if (storage.getItem(key) !== null) return false;
    writeIndex(propertyId, itemIds.filter((id) => id !== itemId), storage);
    return true;
  } catch {
    return false;
  }
}

export function isDefinitiveQuickCountFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  const normalized = code.trim().toUpperCase();
  // A PostgreSQL SQLSTATE or a PostgREST response proves the server returned a
  // result for this transaction (and therefore rolled it back on error).
  // Browser/transport libraries also attach codes such as ECONNRESET and
  // NETWORK_ERROR; those remain ambiguous and must keep the frozen attempt.
  return /^(?:22|23|28|40|42|53|54|55|57|58|P0|XX)[0-9A-Z]{3}$/.test(normalized)
    || /^PGRST\d{3}$/.test(normalized);
}
