// Atomic executor + durable retry envelope for inventory deliveries.
//
// The request UUID and the exact payload are written to localStorage BEFORE
// the RPC begins. If the response is lost after Postgres commits, every retry
// (including after a remount/reload) replays that same immutable envelope. The
// caller may discard it only after a database error with a concrete error code
// proves the transaction was rejected, or after durable persistence fails before
// the RPC is allowed to start.

import { receiveInventoryDeliveryAtomic } from '@/lib/db';
import {
  deliveryLinesFromCommitPlan,
  inventoryPayloadFingerprint,
  toInventoryDeliveryRpcLines,
  type InventoryDeliveryLine,
} from '@/lib/inventory-atomic';
import type { CommitPlan } from '@/lib/inventory-invoice-commit';
import { generateId } from '@/lib/utils';

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type DeliveryAttemptKind = 'manual' | 'scan';

export interface FrozenDeliveryAttempt {
  version: 1;
  kind: DeliveryAttemptKind;
  propertyId: string;
  requestId: string;
  receivedAt: string;
  vendorName: string | null;
  notes: string | null;
  lines: InventoryDeliveryLine[];
  fingerprint: string;
}

export type DeliveryAttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  /** Real Web Storage exposes these, allowing request-key discovery even if
   * two tabs race while updating the best-effort manifest. */
  readonly length?: number;
  key?: (index: number) => string | null;
};

export const DELIVERY_ATTEMPT_PERSISTENCE_ERROR = 'DELIVERY_ATTEMPT_PERSISTENCE_FAILED';

/** A definitive local failure: no additive delivery RPC was started. */
export class DeliveryAttemptPersistenceError extends Error {
  readonly code = DELIVERY_ATTEMPT_PERSISTENCE_ERROR;

  constructor(message = 'This delivery could not be saved safely for retry on this device.') {
    super(message);
    this.name = 'DeliveryAttemptPersistenceError';
  }
}

function browserStorage(): DeliveryAttemptStorage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function deliveryAttemptStorageKey(kind: DeliveryAttemptKind, propertyId: string): string {
  return `staxis:inventory-delivery-attempt:${kind}:${propertyId}`;
}

function deliveryAttemptEnvelopeKey(
  kind: DeliveryAttemptKind,
  propertyId: string,
  requestId: string,
): string {
  return `${deliveryAttemptStorageKey(kind, propertyId)}:request:${requestId}`;
}

function deliveryAttemptManifestKey(kind: DeliveryAttemptKind, propertyId: string): string {
  return `${deliveryAttemptStorageKey(kind, propertyId)}:requests`;
}

function readManifest(
  kind: DeliveryAttemptKind,
  propertyId: string,
  storage: DeliveryAttemptStorage,
): string[] {
  try {
    const raw = storage.getItem(deliveryAttemptManifestKey(kind, propertyId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))]
      : [];
  } catch {
    return [];
  }
}

function discoverRequestIds(
  kind: DeliveryAttemptKind,
  propertyId: string,
  storage: DeliveryAttemptStorage,
): string[] {
  const ids = new Set(readManifest(kind, propertyId, storage));
  const prefix = `${deliveryAttemptStorageKey(kind, propertyId)}:request:`;
  if (typeof storage.length === 'number' && typeof storage.key === 'function') {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
  }
  return [...ids];
}

function isFrozenDeliveryAttempt(value: unknown): value is FrozenDeliveryAttempt {
  if (!value || typeof value !== 'object') return false;
  const x = value as Partial<FrozenDeliveryAttempt>;
  const shapeValid = x.version === 1
    && (x.kind === 'manual' || x.kind === 'scan')
    && typeof x.propertyId === 'string'
    && x.propertyId.trim().length > 0
    && typeof x.requestId === 'string'
    && x.requestId.trim().length > 0
    && typeof x.receivedAt === 'string'
    && !Number.isNaN(new Date(x.receivedAt).getTime())
    && (x.vendorName === null || typeof x.vendorName === 'string')
    && (x.notes === null || typeof x.notes === 'string')
    && Array.isArray(x.lines)
    && x.lines.length > 0
    && typeof x.fingerprint === 'string';
  if (!shapeValid) return false;
  try {
    toInventoryDeliveryRpcLines(x.lines as InventoryDeliveryLine[]);
    return x.fingerprint === inventoryPayloadFingerprint({
      vendorName: x.vendorName,
      notes: x.notes,
      lines: x.lines,
    });
  } catch {
    return false;
  }
}

export function loadDeliveryAttempt(
  kind: DeliveryAttemptKind,
  propertyId: string,
  storage: DeliveryAttemptStorage | null = browserStorage(),
): FrozenDeliveryAttempt | null {
  if (!storage) return null;
  try {
    const found: FrozenDeliveryAttempt[] = [];
    for (const requestId of discoverRequestIds(kind, propertyId, storage)) {
      const raw = storage.getItem(deliveryAttemptEnvelopeKey(kind, propertyId, requestId));
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (isFrozenDeliveryAttempt(parsed) && parsed.kind === kind && parsed.propertyId === propertyId) {
        found.push(parsed);
      }
    }

    // One-time compatibility with the original single-slot key. Persisting it
    // into the request-keyed store prevents a later tab from overwriting it.
    const legacyKey = deliveryAttemptStorageKey(kind, propertyId);
    const legacyRaw = storage.getItem(legacyKey);
    if (legacyRaw) {
      const legacy: unknown = JSON.parse(legacyRaw);
      if (isFrozenDeliveryAttempt(legacy) && legacy.kind === kind && legacy.propertyId === propertyId) {
        if (!found.some((attempt) => attempt.requestId === legacy.requestId)) found.push(legacy);
        try {
          persistDeliveryAttempt(legacy, storage);
          storage.removeItem(legacyKey);
        } catch {
          // Keep the legacy envelope in place; it is still safer than losing it.
        }
      }
    }

    return found.sort((a, b) => (
      new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime()
      || a.requestId.localeCompare(b.requestId)
    ))[0] ?? null;
  } catch {
    return null;
  }
}

export function persistDeliveryAttempt(
  attempt: FrozenDeliveryAttempt,
  storage: DeliveryAttemptStorage | null = browserStorage(),
): void {
  // Additive stock writes are not allowed to begin without a durable retry
  // envelope. Safari private browsing and storage policies can expose
  // localStorage but still throw on setItem, so absence and write failures are
  // definitive PRE-RPC errors rather than ambiguous delivery outcomes.
  if (!isFrozenDeliveryAttempt(attempt) || !storage) {
    throw new DeliveryAttemptPersistenceError();
  }
  const key = deliveryAttemptEnvelopeKey(attempt.kind, attempt.propertyId, attempt.requestId);
  try {
    const serialized = JSON.stringify(attempt);
    storage.setItem(key, serialized);
    // Verify the synchronous write. A storage shim/policy that silently drops
    // the value is no safer than a thrown quota error.
    if (storage.getItem(key) !== serialized) throw new Error('delivery retry envelope was not retained');
    const manifestKey = deliveryAttemptManifestKey(attempt.kind, attempt.propertyId);
    const requestIds = new Set(readManifest(attempt.kind, attempt.propertyId, storage));
    requestIds.add(attempt.requestId);
    storage.setItem(manifestKey, JSON.stringify([...requestIds]));
  } catch {
    throw new DeliveryAttemptPersistenceError();
  }
}

export function clearDeliveryAttempt(
  kind: DeliveryAttemptKind,
  propertyId: string,
  requestIdOrStorage?: string | DeliveryAttemptStorage | null,
  storageOverride?: DeliveryAttemptStorage | null,
): void {
  const requestId = typeof requestIdOrStorage === 'string' ? requestIdOrStorage : null;
  const storage = typeof requestIdOrStorage === 'string'
    ? (storageOverride ?? browserStorage())
    : (requestIdOrStorage ?? browserStorage());
  if (!storage) return;
  try {
    const manifestKey = deliveryAttemptManifestKey(kind, propertyId);
    if (requestId) {
      storage.removeItem(deliveryAttemptEnvelopeKey(kind, propertyId, requestId));
      const remaining = readManifest(kind, propertyId, storage).filter((id) => id !== requestId);
      if (remaining.length > 0) storage.setItem(manifestKey, JSON.stringify(remaining));
      else storage.removeItem(manifestKey);
      return;
    }
    for (const id of discoverRequestIds(kind, propertyId, storage)) {
      storage.removeItem(deliveryAttemptEnvelopeKey(kind, propertyId, id));
    }
    storage.removeItem(deliveryAttemptStorageKey(kind, propertyId));
    storage.removeItem(manifestKey);
  } catch {
    // A failed cleanup is safe: a later retry replays the same idempotency key.
  }
}

interface AttemptDraft {
  kind: DeliveryAttemptKind;
  propertyId: string;
  receivedAt: Date;
  vendorName?: string | null;
  notes?: string | null;
  lines: readonly InventoryDeliveryLine[];
  requestId?: string;
}

/** Existing always wins, even if the visible draft changed after an error.
 * This is the central no-double-delivery invariant. */
export function retainOrCreateDeliveryAttempt(
  existing: FrozenDeliveryAttempt | null,
  draft: AttemptDraft,
): FrozenDeliveryAttempt {
  if (existing) return existing;
  const lines = draft.lines.map((line) => ({ ...line })) as InventoryDeliveryLine[];
  // Run all deterministic client validation before assigning a request UUID.
  // A malformed draft therefore stays editable instead of being mistaken for
  // an ambiguous network result and locked into an impossible retry.
  toInventoryDeliveryRpcLines(lines);
  const vendorName = draft.vendorName?.trim() || null;
  const notes = draft.notes?.trim() || null;
  return {
    version: 1,
    kind: draft.kind,
    propertyId: draft.propertyId,
    requestId: draft.requestId ?? generateId(),
    receivedAt: draft.receivedAt.toISOString(),
    vendorName,
    notes,
    lines,
    fingerprint: inventoryPayloadFingerprint({ vendorName, notes, lines }),
  };
}

/** A concrete Postgres/PostgREST code means the server returned a rejection,
 * so its transaction rolled back and the envelope can safely be released. A
 * A typed persistence error is definitive only for a brand-new attempt; it
 * cannot resolve an earlier ambiguous RPC. Missing/transport codes remain
 * ambiguous. */
export function isDefinitiveDeliveryFailure(
  error: unknown,
  unresolvedAttempt = false,
): boolean {
  // Failing to re-persist a previously ambiguous request does not resolve the
  // earlier database outcome. Only a fresh, never-sent attempt may be released.
  if (error instanceof DeliveryAttemptPersistenceError) return !unresolvedAttempt;
  // Once a send has an unknown outcome, an auth/MFA/schema-cache/validation
  // error on a later replay does not prove whether the original request
  // committed. Keep the one idempotency key until the RPC returns its saved
  // result (or a dedicated receipt-status check is added).
  if (unresolvedAttempt) return false;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  const normalized = code.trim().toUpperCase();
  return /^(?:22|23|28|40|42|53|54|55|57|58|P0|XX)[0-9A-Z]{3}$/.test(normalized)
    || /^PGRST\d{3}$/.test(normalized);
}

export function numberedInvoiceSaveBlocked(args: {
  invoiceNumber: string | null;
  checking: boolean;
  duplicate: boolean;
  checkFailed: boolean;
}): boolean {
  return !!args.invoiceNumber && (args.checking || args.duplicate || args.checkFailed);
}

export async function submitFrozenDeliveryAttempt(
  attempt: FrozenDeliveryAttempt,
  ctx: { uid: string; pid: string },
): Promise<void> {
  await receiveInventoryDeliveryAtomic(
    ctx.uid,
    // Property is part of the frozen retry envelope. Never substitute the
    // currently selected hotel if the user switches properties while a request
    // is in flight.
    attempt.propertyId,
    attempt.requestId,
    new Date(attempt.receivedAt),
    attempt.vendorName,
    attempt.notes,
    attempt.lines,
  );
}

export interface CommitProgress {
  attempt: FrozenDeliveryAttempt | null;
}

export function newCommitProgress(attempt: FrozenDeliveryAttempt | null = null): CommitProgress {
  return { attempt };
}

export async function executeCommit(
  plan: CommitPlan,
  progress: CommitProgress,
  ctx: { uid: string; pid: string },
): Promise<void> {
  const lines = deliveryLinesFromCommitPlan(plan);
  // Reject an empty plan before allocating/persisting a request envelope. This
  // is a local validation failure, not an ambiguous delivery result.
  if (lines.length === 0) throw new Error('The invoice has no delivery lines to save.');
  progress.attempt = retainOrCreateDeliveryAttempt(progress.attempt, {
    kind: 'scan',
    propertyId: ctx.pid,
    receivedAt: plan.receivedAt,
    vendorName: plan.vendorName,
    notes: plan.notesTag,
    lines,
  });
  persistDeliveryAttempt(progress.attempt);
  await submitFrozenDeliveryAttempt(progress.attempt, ctx);
  clearDeliveryAttempt('scan', progress.attempt.propertyId, progress.attempt.requestId);
  progress.attempt = null;
}

export async function retryCommit(
  progress: CommitProgress,
  ctx: { uid: string; pid: string },
): Promise<void> {
  if (!progress.attempt) throw new Error('There is no saved delivery attempt to retry.');
  persistDeliveryAttempt(progress.attempt);
  await submitFrozenDeliveryAttempt(progress.attempt, ctx);
  clearDeliveryAttempt('scan', progress.attempt.propertyId, progress.attempt.requestId);
  progress.attempt = null;
}

export function releaseRejectedCommit(progress: CommitProgress, propertyId: string): void {
  if (progress.attempt) clearDeliveryAttempt('scan', propertyId, progress.attempt.requestId);
  progress.attempt = null;
}
