/** Build the active inventory id set used to scope ML-derived aggregates. */
export function activeInventoryItemIds(
  items: readonly { id?: unknown }[],
): ReadonlySet<string> {
  return new Set(
    items
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}

/**
 * Model runs and predictions outlive an archived item for auditability. Keep
 * those historical rows out of active-inventory health and serving metrics.
 */
export function filterInventoryMlRowsToActiveItems<T extends { item_id?: unknown }>(
  rows: readonly T[],
  activeIds: ReadonlySet<string>,
): T[] {
  return rows.filter(
    (row) => typeof row.item_id === 'string' && activeIds.has(row.item_id),
  );
}
