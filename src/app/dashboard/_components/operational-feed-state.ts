/**
 * Identity-owned state for the Dashboard's live operational feeds.
 *
 * An empty array is meaningful only after a successful snapshot. Keeping that
 * bit separate from `rows` prevents a failed first read from becoming a false
 * zero / "all clear". Later refresh failures retain the last-good rows while
 * marking them stale, and a hotel/day change is synchronously masked in render.
 */
export interface ScopedFeedSnapshot<T> {
  propertyId: string | null;
  date: string | null;
  rows: T[];
  hasSnapshot: boolean;
  error: boolean;
}

export interface ScopedFeedView<T> {
  rows: T[];
  hasSnapshot: boolean;
  error: boolean;
}

export function emptyScopedFeed<T>(): ScopedFeedSnapshot<T> {
  return {
    propertyId: null,
    date: null,
    rows: [],
    hasSnapshot: false,
    error: false,
  };
}

function ownsScope<T>(
  snapshot: ScopedFeedSnapshot<T>,
  propertyId: string | null,
  date: string | null,
): boolean {
  return snapshot.propertyId === propertyId && snapshot.date === date;
}

/** Begin/retry a read. Same-scope last-good rows remain visible; another
 * hotel/day always starts from an unknown empty state. A stale/error verdict
 * remains until a successful refresh replaces it, so retrying never makes a
 * last-known snapshot look current before the network has actually settled. */
export function beginScopedFeed<T>(
  previous: ScopedFeedSnapshot<T>,
  propertyId: string,
  date: string,
): ScopedFeedSnapshot<T> {
  if (ownsScope(previous, propertyId, date) && previous.hasSnapshot) {
    return previous;
  }
  return { propertyId, date, rows: [], hasSnapshot: false, error: false };
}

export function publishScopedFeed<T>(
  propertyId: string,
  date: string,
  rows: T[],
): ScopedFeedSnapshot<T> {
  return { propertyId, date, rows, hasSnapshot: true, error: false };
}

/** Mark the exact feed unavailable without erasing a prior successful
 * snapshot. This is what lets later poll/realtime failures degrade honestly
 * instead of either blanking the dashboard or pretending stale zeroes are live. */
export function failScopedFeed<T>(
  previous: ScopedFeedSnapshot<T>,
  propertyId: string,
  date: string,
): ScopedFeedSnapshot<T> {
  if (ownsScope(previous, propertyId, date)) {
    return { ...previous, error: true };
  }
  return { propertyId, date, rows: [], hasSnapshot: false, error: true };
}

/** Synchronously mask a previous tenant/day before effects and cleanup run. */
export function scopedFeedView<T>(
  snapshot: ScopedFeedSnapshot<T>,
  propertyId: string | null,
  date: string | null,
): ScopedFeedView<T> {
  if (!ownsScope(snapshot, propertyId, date)) {
    return { rows: [], hasSnapshot: false, error: false };
  }
  return {
    rows: snapshot.rows,
    hasSnapshot: snapshot.hasSnapshot,
    error: snapshot.error,
  };
}
