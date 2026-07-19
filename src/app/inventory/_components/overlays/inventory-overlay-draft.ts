// Best-effort draft storage for inventory overlays.
//
// Transaction retry envelopes (count-save.ts / scan-commit.ts / the primary
// Add Item attempt) remain the source of truth once a database request starts.
// This helper protects the editable work *before* Save is pressed, including a
// refresh or accidental same-tab navigation. Drafts are scoped by user, hotel,
// overlay, and optional item id, and use sessionStorage so financial fields do
// not remain on a shared hotel device after the browser tab/session closes.

export type InventoryOverlayDraftKind =
  | 'item'
  | 'count'
  | 'delivery'
  | 'invoice-review'
  | 'stock-loss'
  | 'delivery-correction';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface StoredDraft<T> {
  version: 1;
  savedAt: number;
  data: T;
}

export const INVENTORY_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function browserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage; } catch { return null; }
}

function safePart(value: string): string {
  return encodeURIComponent(value.trim());
}

export function inventoryOverlayDraftKey(input: {
  kind: InventoryOverlayDraftKind;
  userId: string;
  propertyId: string;
  scope?: string;
}): string {
  const scope = input.scope?.trim() || 'default';
  return [
    'staxis',
    'inventory-draft-v1',
    safePart(input.kind),
    safePart(input.userId),
    safePart(input.propertyId),
    safePart(scope),
  ].join(':');
}

export function persistInventoryOverlayDraft<T>(
  input: {
    kind: InventoryOverlayDraftKind;
    userId: string;
    propertyId: string;
    scope?: string;
    data: T;
  },
  storage: StorageLike | null = browserStorage(),
  now = Date.now(),
): boolean {
  if (!storage || !input.userId.trim() || !input.propertyId.trim()) return false;
  try {
    const value: StoredDraft<T> = { version: 1, savedAt: now, data: input.data };
    storage.setItem(inventoryOverlayDraftKey(input), JSON.stringify(value));
    return true;
  } catch {
    // The transactional Save paths have their own fail-closed storage. A draft
    // is best-effort only, so unavailable/quota-limited storage must not block
    // the employee from continuing to edit or save.
    return false;
  }
}

export function loadInventoryOverlayDraft<T>(
  input: {
    kind: InventoryOverlayDraftKind;
    userId: string;
    propertyId: string;
    scope?: string;
  },
  storage: StorageLike | null = browserStorage(),
  now = Date.now(),
): T | null {
  if (!storage || !input.userId.trim() || !input.propertyId.trim()) return null;
  const key = inventoryOverlayDraftKey(input);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft<T>>;
    if (
      parsed.version !== 1
      || typeof parsed.savedAt !== 'number'
      || !Number.isFinite(parsed.savedAt)
      || parsed.savedAt > now + 60_000
      || now - parsed.savedAt > INVENTORY_DRAFT_TTL_MS
      || !('data' in parsed)
    ) {
      storage.removeItem(key);
      return null;
    }
    return parsed.data as T;
  } catch {
    try { storage.removeItem(key); } catch {}
    return null;
  }
}

export function clearInventoryOverlayDraft(
  input: {
    kind: InventoryOverlayDraftKind;
    userId: string;
    propertyId: string;
    scope?: string;
  },
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage || !input.userId.trim() || !input.propertyId.trim()) return;
  try { storage.removeItem(inventoryOverlayDraftKey(input)); } catch {}
}
