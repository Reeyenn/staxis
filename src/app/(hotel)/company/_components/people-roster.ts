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

// ═══════════════════════════════════════════════════════════════════════════
// Your hotel's people, plus the company people responsible for YOUR hotel.
// Nothing else.
//
// When a hotel belongs to a management company, some of the logins that can
// open it are not employed there at all: the VP who oversees six hotels, the
// owner of the whole company. Merged into the roster they read as staff, and a
// GM looking at their own People screen could not tell "works here" from
// "watches over here". They are also not assignable, not schedulable, and not
// the GM's to edit.
//
// So they get their own short, read-only section. The split is by HAT SCOPE:
// a company-scope job (owner / VP / finance over a whole company) is oversight;
// a property-scope job names hotels and is employment.
//
// SIBLING ISOLATION IS INHERITED, NOT RE-IMPLEMENTED. The jobs handed to this
// function have already been narrowed by GET /api/auth/team to the hotels the
// viewer can actually reach, so a GM at hotel A sees "Oversees" next to their
// VP and never learns hotel B exists. This function must therefore never widen
// that: it only ever asks whether a job covers THE SELECTED hotel.
// ═══════════════════════════════════════════════════════════════════════════

/** The company job shape the People screen receives from /api/auth/team. */
export interface RosterCompanyJob {
  membershipId: string;
  scope: 'company' | 'property';
  role: string;
  label: { en: string };
  /** Already narrowed to the viewer's reach by the route. */
  propertyIds: string[];
}

/** One company person watching over this hotel. Read-only by construction:
 *  there are no actions on this shape at all. */
export interface CompanyOversightPerson<A extends RosterAccountLike = RosterAccountLike> {
  key: string;
  name: string;
  account: A;
  /** The company jobs that reach this hotel, for the role line. */
  jobs: RosterCompanyJob[];
}

export interface HotelPeopleSplit<
  A extends RosterAccountLike = RosterAccountLike,
  S extends RosterStaffLike = RosterStaffLike,
> {
  /** The hotel's own roster, grouped exactly as before. */
  hotelGroups: RosterGroup<A, S>[];
  /** Company oversight, alphabetical. */
  companyPeople: CompanyOversightPerson<A>[];
}

function coversHotel(job: RosterCompanyJob, hotelId: string): boolean {
  return job.propertyIds.includes(hotelId);
}

/**
 * Split one hotel's merged roster into "people here" and "company people over
 * here".
 *
 * A person moves to the company side only when every one of these is true:
 *   • they hold a company-scope job that reaches this hotel, and
 *   • they hold no property-scope job at this hotel, and
 *   • they have no employment record at this hotel.
 *
 * The last two matter. A VP who is ALSO the GM of one of their hotels, or who
 * has a roster row because they cover shifts there, genuinely works at that
 * hotel and stays in its list. Oversight is what is left over.
 */
export function splitHotelAndCompanyPeople<
  A extends RosterAccountLike,
  S extends RosterStaffLike,
>(
  groups: readonly RosterGroup<A, S>[],
  jobsByAccountId: Readonly<Record<string, readonly RosterCompanyJob[]>>,
  hotelId: string,
): HotelPeopleSplit<A, S> {
  const companyPeople: CompanyOversightPerson<A>[] = [];
  const hotelGroups = groups.map((group) => ({
    key: group.key,
    people: group.people.filter((person) => {
      const account = person.account;
      if (!account || person.staff) return true;
      const jobs = jobsByAccountId[account.accountId] ?? [];
      const oversight = jobs.filter((job) => job.scope === 'company' && coversHotel(job, hotelId));
      if (oversight.length === 0) return true;
      const worksHere = jobs.some((job) => job.scope === 'property' && coversHotel(job, hotelId));
      if (worksHere) return true;
      companyPeople.push({
        key: person.key,
        name: person.name,
        account,
        jobs: [...oversight].sort((left, right) => (
          left.membershipId.localeCompare(right.membershipId)
        )),
      });
      return false;
    }),
  }));

  return {
    hotelGroups,
    companyPeople: companyPeople.sort((left, right) => compareNames(left.name, right.name)),
  };
}
