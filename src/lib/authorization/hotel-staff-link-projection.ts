/**
 * The active account/property staff link is an authority input. An inactive
 * link is not. This small projection keeps an inactive link available only as
 * a durable identity hint for the selected hotel's People merge.
 *
 * The database has one row per account/property pair, but this parser still
 * rejects conflicting active and historical rows so a malformed response can
 * never make the UI guess which staff identity belongs to a login.
 */

export interface HotelStaffLinkRow {
  accountId: unknown;
  staffId: unknown;
  isActive: unknown;
}

export interface HotelStaffLinkProjection {
  activeStaffIds: ReadonlyMap<string, string>;
  historicalStaffIds: ReadonlyMap<string, string>;
}

function setDeterministic(
  target: Map<string, string>,
  accountId: string,
  staffId: string,
): boolean {
  const existing = target.get(accountId);
  if (existing !== undefined && existing !== staffId) return false;
  target.set(accountId, staffId);
  return true;
}

/**
 * Project only links for the selected property and requested accounts.
 * Returns null when the identity payload is malformed or ambiguous.
 */
export function projectHotelStaffLinks(
  rows: readonly HotelStaffLinkRow[],
  accountIds: ReadonlySet<string>,
): HotelStaffLinkProjection | null {
  const activeStaffIds = new Map<string, string>();
  const historicalStaffIds = new Map<string, string>();

  for (const row of rows) {
    if (typeof row.accountId !== 'string'
        || row.accountId.length === 0
        || typeof row.staffId !== 'string'
        || row.staffId.length === 0
        || typeof row.isActive !== 'boolean') {
      return null;
    }
    if (!accountIds.has(row.accountId)) continue;
    const target = row.isActive ? activeStaffIds : historicalStaffIds;
    if (!setDeterministic(target, row.accountId, row.staffId)) return null;
  }

  for (const accountId of activeStaffIds.keys()) {
    if (historicalStaffIds.has(accountId)) return null;
  }

  return { activeStaffIds, historicalStaffIds };
}

/** Stable signature for the route's initial/final read consistency check. */
export function hotelStaffLinkProjectionSignature(
  projection: HotelStaffLinkProjection,
): string {
  const entries = (values: ReadonlyMap<string, string>) => [...values.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return JSON.stringify({
    active: entries(projection.activeStaffIds),
    historical: entries(projection.historicalStaffIds),
  });
}
