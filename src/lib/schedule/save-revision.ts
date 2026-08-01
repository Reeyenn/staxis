/**
 * A queued save may clear only the optimistic edit revision it captured.
 * Newer local edits must remain visible even when an earlier request fails.
 */
export function scheduleRevisionStillOwned(
  currentRevision: number | undefined,
  savedRevision: number | undefined,
): boolean {
  return currentRevision === savedRevision;
}
