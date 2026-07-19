// Durable, request-keyed recovery envelopes for inventory mutations whose
// result can become unknown after the database commits (network loss, browser
// crash, deployment reload). Editable drafts live in sessionStorage; these
// envelopes deliberately live in localStorage until the exact idempotency key
// succeeds or the server definitively rejects a never-ambiguous request.

export type InventoryOperationAttemptKind =
  | 'opening-adjustment'
  | 'stock-loss'
  | 'delivery-correction';

export interface InventoryOperationAttemptScope {
  kind: InventoryOperationAttemptKind;
  userId: string;
  propertyId: string;
  scope: string;
}

export interface RequestKeyedAttempt {
  requestId: string;
}

export type InventoryOperationAttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  readonly length?: number;
  key?: (index: number) => string | null;
};

interface StoredAttempt<T> {
  version: 1;
  savedAt: number;
  data: T;
}

function browserStorage(): InventoryOperationAttemptStorage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

function safe(value: string): string {
  return encodeURIComponent(value.trim());
}

function baseKey(input: InventoryOperationAttemptScope): string {
  return [
    'staxis',
    'inventory-operation-attempt-v1',
    safe(input.kind),
    safe(input.userId),
    safe(input.propertyId),
    safe(input.scope),
  ].join(':');
}

function requestKey(input: InventoryOperationAttemptScope, requestId: string): string {
  return `${baseKey(input)}:request:${safe(requestId)}`;
}

function manifestKey(input: InventoryOperationAttemptScope): string {
  return `${baseKey(input)}:requests`;
}

function readManifest(
  input: InventoryOperationAttemptScope,
  storage: InventoryOperationAttemptStorage,
): string[] {
  try {
    const raw = storage.getItem(manifestKey(input));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))]
      : [];
  } catch {
    return [];
  }
}

function discoverRequestIds(
  input: InventoryOperationAttemptScope,
  storage: InventoryOperationAttemptStorage,
): string[] {
  const ids = new Set(readManifest(input, storage));
  const prefix = `${baseKey(input)}:request:`;
  if (typeof storage.length === 'number' && typeof storage.key === 'function') {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) {
        try { ids.add(decodeURIComponent(key.slice(prefix.length))); } catch {}
      }
    }
  }
  return [...ids];
}

export function persistInventoryOperationAttempt<T extends RequestKeyedAttempt>(
  input: InventoryOperationAttemptScope,
  data: T,
  storage: InventoryOperationAttemptStorage | null = browserStorage(),
  now = Date.now(),
): boolean {
  if (
    !storage
    || !input.userId.trim()
    || !input.propertyId.trim()
    || !input.scope.trim()
    || !data.requestId.trim()
  ) return false;
  try {
    const key = requestKey(input, data.requestId);
    const serialized = JSON.stringify({ version: 1, savedAt: now, data } satisfies StoredAttempt<T>);
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) return false;

    const ids = new Set(readManifest(input, storage));
    ids.add(data.requestId);
    const manifest = JSON.stringify([...ids]);
    storage.setItem(manifestKey(input), manifest);
    if (storage.getItem(manifestKey(input)) !== manifest) return false;
    return true;
  } catch {
    return false;
  }
}

export function loadInventoryOperationAttempt<T extends RequestKeyedAttempt>(
  input: InventoryOperationAttemptScope,
  validate: (value: unknown) => T | null,
  storage: InventoryOperationAttemptStorage | null = browserStorage(),
): T | null {
  if (!storage) return null;
  const found: Array<{ savedAt: number; data: T }> = [];
  for (const requestId of discoverRequestIds(input, storage)) {
    try {
      const raw = storage.getItem(requestKey(input, requestId));
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Partial<StoredAttempt<unknown>>;
      if (parsed.version !== 1 || typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) continue;
      const data = validate(parsed.data);
      if (!data || data.requestId !== requestId) continue;
      found.push({ savedAt: parsed.savedAt, data });
    } catch {}
  }
  found.sort((a, b) => a.savedAt - b.savedAt || a.data.requestId.localeCompare(b.data.requestId));
  return found[0]?.data ?? null;
}

export function clearInventoryOperationAttempt(
  input: InventoryOperationAttemptScope,
  requestId: string,
  storage: InventoryOperationAttemptStorage | null = browserStorage(),
): void {
  if (!storage || !requestId.trim()) return;
  try {
    storage.removeItem(requestKey(input, requestId));
    const remaining = readManifest(input, storage).filter((id) => id !== requestId);
    if (remaining.length > 0) storage.setItem(manifestKey(input), JSON.stringify(remaining));
    else storage.removeItem(manifestKey(input));
  } catch {
    // Cleanup failure is safe: the same idempotency key remains recoverable.
  }
}
