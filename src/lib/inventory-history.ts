import type { InventoryCount } from '@/types';

/**
 * Stable grouping key for one physical-count event.
 *
 * New atomic saves stamp every item row with the same countSessionId. Legacy
 * rows do not have that column, so they retain the previous exact-timestamp
 * grouping behavior. Prefixes keep a session UUID from ever colliding with a
 * legacy timestamp string.
 */
export function inventoryCountEventKey(
  count: Pick<InventoryCount, 'countSessionId' | 'countedAt'>,
): string | null {
  if (!count.countedAt) return null;
  const sessionId = count.countSessionId?.trim();
  return sessionId
    ? `session:${sessionId}`
    : `legacy:${count.countedAt.toISOString()}`;
}

/** Group raw per-item count rows into the physical-count sessions shown in UI. */
export function groupInventoryCountsByEvent<T extends Pick<InventoryCount, 'countSessionId' | 'countedAt'>>(
  counts: readonly T[],
): T[][] {
  const grouped = new Map<string, T[]>();
  for (const count of counts) {
    const key = inventoryCountEventKey(count);
    if (!key) continue;
    const group = grouped.get(key);
    if (group) group.push(count);
    else grouped.set(key, [count]);
  }
  return [...grouped.values()];
}
