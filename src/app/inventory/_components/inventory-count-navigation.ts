/**
 * Decide where a completed full-count sheet should return.
 *
 * A count opened from Month Close is a temporary detour and must return to the
 * close checklist. A normal Start count belongs to the inventory board and
 * should simply dismiss when it saves.
 */
export function inventoryOverlayAfterCountSave(
  startedForMonthClose: boolean,
): 'close' | null {
  return startedForMonthClose ? 'close' : null;
}
