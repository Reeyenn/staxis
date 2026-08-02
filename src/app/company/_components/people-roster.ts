// ═══════════════════════════════════════════════════════════════════════════
// One hotel, one list of people.
//
// Staxis stores a person in two different places and neither one is "the
// person":
//   • `accounts`  — a Staxis LOGIN. An owner who never touches a room has one.
//   • `staff`     — an EMPLOYMENT record: department, hours cap, wage, vacation.
//                   A housekeeper who shares a phone at the linen closet has
//                   one and no login at all.
// The canonical join is `account_property_staff_links`, surfaced by
// GET /api/auth/team as `staffId` on each account row. A historical inactive
// link is surfaced separately as `historicalStaffId` for identity matching
// only; it is never an authority input.
//
// Until 2026-07-27 the UI mirrored the storage: Staff → Directory listed the
// `staff` table, My Hotel → People listed `accounts` and then, underneath, the
// leftover `staff` rows. The same human appeared twice with no explanation.
// This module collapses both tables into ONE list keyed by person, so a linked
// human is exactly one row that carries whatever we know about them.
//
// Pure and DOM-free on purpose: the merge is the part worth testing, and the
// test must not need React or a CSS module.
// ═══════════════════════════════════════════════════════════════════════════

/** The five buckets used to choose a person's department label. */
export type RosterGroupKey =
  | 'management'
  | 'housekeeping'
  | 'front_desk'
  | 'maintenance'
  | 'other';

/** Stable department order used by the flat roster. */
export const ROSTER_GROUP_ORDER: readonly RosterGroupKey[] = [
  'management',
  'housekeeping',
  'front_desk',
  'maintenance',
  'other',
] as const;

const STAFF_DEPARTMENTS: ReadonlySet<string> = new Set([
  'housekeeping',
  'front_desk',
  'maintenance',
  'other',
]);

/** Login roles that name a department. Everything else (owner, general
 *  manager, plain `staff`, admin) is management/office. */
const ROLE_DEPARTMENTS: Readonly<Record<string, RosterGroupKey>> = {
  housekeeping: 'housekeeping',
  front_desk: 'front_desk',
  maintenance: 'maintenance',
};

/** The minimum an account row must carry to be merged. Structural so the
 *  panel can pass its full `HotelTeamMember` and a test can pass a literal. */
export interface RosterAccountLike {
  accountId: string;
  displayName: string;
  role: string;
  /** From `account_property_staff_links` for THIS hotel, never the legacy
   *  account-wide `accounts.staff_id`. */
  staffId: string | null;
  /** Read-only identity hint from an inactive link for THIS hotel. */
  historicalStaffId?: string | null;
}

/** The minimum a staff row must carry to be merged. */
export interface RosterStaffLike {
  id: string;
  name: string;
  department?: string;
  isActive?: boolean;
}

/** One human at this hotel. Exactly one of these per person, whichever of the
 *  two records they happen to have. */
export interface RosterPerson<
  A extends RosterAccountLike = RosterAccountLike,
  S extends RosterStaffLike = RosterStaffLike,
> {
  /** Stable React key. Account id wins so a person keeps their key when a
   *  staff record is linked or unlinked underneath them. */
  key: string;
  /** The name to show: the employment record's name when there is one, since
   *  that is what the schedule, the board and the printed roster all use. */
  name: string;
  account: A | null;
  staff: S | null;
  group: RosterGroupKey;
}

export interface RosterGroup<
  A extends RosterAccountLike = RosterAccountLike,
  S extends RosterStaffLike = RosterStaffLike,
> {
  key: RosterGroupKey;
  people: RosterPerson<A, S>[];
}

/** Directory behavior, preserved: an unknown or missing department reads as
 *  Housekeeping (see asDeptKey in the old staff tokens), never silently
 *  disappears. */
function departmentOf(staff: RosterStaffLike | null): RosterGroupKey | null {
  if (!staff) return null;
  const value = staff.department;
  if (typeof value === 'string' && STAFF_DEPARTMENTS.has(value)) {
    return value as RosterGroupKey;
  }
  return 'housekeeping';
}

/**
 * Where a person belongs. Employment wins when we have it, because that is the
 * department they actually work in. Otherwise the login's role answers — and
 * when the role names no department (an owner, a GM, a bare `staff` login) the
 * person goes to management/office rather than being dropped, which is exactly
 * the case the two-list layout used to lose.
 */
export function groupForPerson(
  account: RosterAccountLike | null,
  staff: RosterStaffLike | null,
): RosterGroupKey {
  const fromEmployment = departmentOf(staff);
  if (fromEmployment) return fromEmployment;
  if (!account) return 'other';
  return ROLE_DEPARTMENTS[account.role] ?? 'management';
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right);
}

/**
 * Merge every login and every employment record for one hotel into a single
 * roster, grouped by department.
 *
 * A linked human appears ONCE. An account whose active or historical identity
 * points at a staff row we were not given (a roster still loading, or a row
 * from another hotel) is kept as a login-only person rather than vanishing.
 *
 * Sort order inside a group is alphabetical. Operational schedule data does not
 * affect this identity-first surface; it belongs on the manager Staff page.
 */
export function buildHotelRoster<
  A extends RosterAccountLike,
  S extends RosterStaffLike,
>(accounts: readonly A[], staff: readonly S[]): RosterGroup<A, S>[] {
  const staffById = new Map<string, S>();
  for (const member of staff) staffById.set(member.id, member);

  const claimedStaffIds = new Set<string>();
  const people: RosterPerson<A, S>[] = [];

  const identityStaffId = (account: A): string | null => {
    const activeStaffId = account.staffId;
    const historicalStaffId = account.historicalStaffId ?? null;
    // The route rejects this shape before it reaches the panel. Keep the pure
    // merge conservative as well if a stale/test payload bypasses that route.
    if (activeStaffId && historicalStaffId && activeStaffId !== historicalStaffId) {
      return null;
    }
    return activeStaffId ?? historicalStaffId;
  };

  for (const account of accounts) {
    // A staff row can only be claimed once. The database enforces this too
    // (one active link per staff row), but a stale payload must not delete a
    // person from the screen.
    const linkedStaffId = identityStaffId(account);
    const linked = linkedStaffId && !claimedStaffIds.has(linkedStaffId)
      ? staffById.get(linkedStaffId) ?? null
      : null;
    if (linked) claimedStaffIds.add(linked.id);
    people.push({
      key: account.accountId,
      name: linked?.name || account.displayName,
      account,
      staff: linked,
      group: groupForPerson(account, linked),
    });
  }

  for (const member of staff) {
    if (claimedStaffIds.has(member.id)) continue;
    people.push({
      key: member.id,
      name: member.name,
      account: null,
      staff: member,
      group: groupForPerson(null, member),
    });
  }

  const byGroup = new Map<RosterGroupKey, RosterPerson<A, S>[]>(
    ROSTER_GROUP_ORDER.map((key) => [key, []]),
  );
  for (const person of people) byGroup.get(person.group)!.push(person);

  return ROSTER_GROUP_ORDER.map((key) => ({
    key,
    people: byGroup.get(key)!.sort((left, right) => compareNames(left.name, right.name)),
  }));
}
