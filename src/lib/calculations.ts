import { format, differenceInDays, parseISO, addMinutes } from 'date-fns';
import type {
  PublicArea,
  LaundryCategory,
  Property,
  ScheduleResult,
  MorningSetupForm,
  StaffMember,
  DeepCleanConfig,
  DeepCleanRecord,
  Room,
} from '@/types';

// ─── Public Area - is due today? ───────────────────────────────────────────

export function isAreaDueToday(area: PublicArea, today: Date): boolean {
  if (area.onlyWhenRented) return area.isRentedToday ?? false;
  if (area.frequencyDays <= 0) return false;
  if (area.frequencyDays === 1) return true;

  const start = parseISO(area.startDate);
  const daysSinceStart = differenceInDays(today, start);
  if (daysSinceStart < 0) return false;
  return daysSinceStart % area.frequencyDays === 0;
}

export function getPublicAreasDueToday(areas: PublicArea[], today: Date): PublicArea[] {
  return areas.filter(a => isAreaDueToday(a, today));
}

export function calcPublicAreaMinutes(dueAreas: PublicArea[]): number {
  return dueAreas.reduce((sum, a) => sum + a.locations * a.minutesPerClean, 0);
}

// ─── Laundry calculations ──────────────────────────────────────────────────

export interface LaundryBreakdownItem {
  category: string;
  units: number;
  loads: number;
  minutes: number;
}

export function calcLaundryMinutes(
  categories: LaundryCategory[],
  oneBedCheckouts: number,
  twoBedCheckouts: number,
  stayovers: number
): { total: number; breakdown: LaundryBreakdownItem[] } {
  const breakdown: LaundryBreakdownItem[] = categories.map(cat => {
    const units =
      oneBedCheckouts * cat.unitsPerCheckout +
      twoBedCheckouts * cat.unitsPerCheckout * cat.twoBedMultiplier +
      stayovers * cat.unitsPerCheckout * cat.stayoverFactor;

    const loads = Math.ceil(units / Math.max(cat.roomEquivsPerLoad, 1));
    const minutes = loads * cat.minutesPerLoad;

    return { category: cat.name, units: Math.round(units), loads, minutes };
  });

  const total = breakdown.reduce((sum, b) => sum + b.minutes, 0);
  return { total, breakdown };
}

// ─── Schedule calculation ──────────────────────────────────────────────────

export function calcSchedule(
  form: MorningSetupForm,
  property: Property,
  areas: PublicArea[],
  laundryCategories: LaundryCategory[],
  availableStaff: StaffMember[],
  today: Date = new Date()
): ScheduleResult {
  const { occupied, checkouts, twoBedCheckouts, stayovers, vips, startTime } = form;
  const oneBedCheckouts = Math.max(0, checkouts - twoBedCheckouts);

  // A. Room minutes
  const roomMinutes =
    checkouts * property.checkoutMinutes +
    stayovers * property.stayoverMinutes;

  // B. Public area minutes
  const dueAreas = getPublicAreasDueToday(areas, today);
  const publicAreaMinutes = calcPublicAreaMinutes(dueAreas);

  // C. Laundry minutes
  const { total: laundryMinutes, breakdown: laundryBreakdown } = calcLaundryMinutes(
    laundryCategories,
    oneBedCheckouts,
    twoBedCheckouts,
    stayovers
  );

  const totalMinutes = roomMinutes + publicAreaMinutes + laundryMinutes;
  const shiftMinutes = property.shiftMinutes || 480;

  // Factor in available staff (not over 40 hrs)
  const availableCount = availableStaff.filter(
    s => s.scheduledToday && s.weeklyHours + shiftMinutes / 60 <= s.maxWeeklyHours
  ).length;

  const recommendedStaff = Math.ceil(totalMinutes / shiftMinutes);

  // Estimated completion time
  const [startHour, startMin] = startTime.split(':').map(Number);
  const startDate = new Date(today);
  startDate.setHours(startHour, startMin, 0, 0);
  const minutesPerHK = totalMinutes / Math.max(recommendedStaff, 1);
  const completionDate = addMinutes(startDate, minutesPerHK);
  const estimatedCompletionTime = format(completionDate, 'h:mm a');

  // Labor cost (form wage overrides property default)
  const hourlyWage = form.hourlyWage ?? property.hourlyWage ?? 12;
  const estimatedLaborCost =
    recommendedStaff * hourlyWage * (minutesPerHK / 60);

  // Labor saved vs full roster - always compare against the total roster size,
  // not against however many the manager happened to schedule today.
  // This represents "what you would have spent sending your full crew."
  const fullRoster = property.totalStaffOnRoster || form.scheduledStaff || recommendedStaff;
  const staffSaved = Math.max(0, fullRoster - recommendedStaff);
  const laborSaved = staffSaved * hourlyWage * (shiftMinutes / 60);

  return {
    roomMinutes,
    publicAreaMinutes,
    laundryMinutes,
    totalMinutes,
    recommendedStaff,
    estimatedCompletionTime,
    estimatedLaborCost,
    laborSaved,
    publicAreasDueToday: dueAreas,
    laundryBreakdown,
  };
}

// ─── Room sort priority ────────────────────────────────────────────────────

const SORT_ORDER: Record<string, number> = {
  'vip_checkout': 0,
  'early_checkout': 1,
  'standard_checkout': 2,
  'vip_stayover': 3,
  'standard_stayover': 4,
};

export function getRoomSortKey(type: string, priority: string): number {
  const key = `${priority}_${type}`;
  return SORT_ORDER[key] ?? 5;
}

// ─── Smart scheduling - predict from history ───────────────────────────────

export function predictTodayFromHistory(
  logs: Array<{ date: string; occupied: number; checkouts: number }>,
  today: Date
): { occupied: number; checkouts: number; label: string } | null {
  if (logs.length < 7) return null;

  const dayOfWeek = today.getDay(); // 0 = Sunday

  const sameDayLogs = logs.filter(l => {
    const d = parseISO(l.date);
    return d.getDay() === dayOfWeek;
  });

  if (sameDayLogs.length < 2) return null;

  const avgOccupied = Math.round(
    sameDayLogs.reduce((s, l) => s + l.occupied, 0) / sameDayLogs.length
  );
  const avgCheckouts = Math.round(
    sameDayLogs.reduce((s, l) => s + l.checkouts, 0) / sameDayLogs.length
  );

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    occupied: avgOccupied,
    checkouts: avgCheckouts,
    label: `Based on your last ${sameDayLogs.length} ${days[dayOfWeek]}s`,
  };
}

// ─── Room time estimates ───────────────────────────────────────────────────

const CHECKOUT_MINS = 30;
const STAYOVER_DAY1_MINS = 15;
const STAYOVER_DAY2_MINS = 20;

/**
 * Get estimated cleaning minutes for a room, accounting for stayover cycle day.
 * - checkout → checkout minutes
 * - stayover with stayoverDay known → Day 1 (odd) = light (15 default), Day 2 (even) = full (20 default)
 * - stayover without stayoverDay → fall back to Day 2 / legacy stayoverMinutes (safer higher estimate)
 * - arrival-day stayovers (stayoverDay=0) → fall back to legacy stayoverMinutes too (TBD)
 */
export function getRoomMinutes(
  room: { type: string; priority: string; stayoverDay?: number },
  property?: { checkoutMinutes?: number; stayoverMinutes?: number; stayoverDay1Minutes?: number; stayoverDay2Minutes?: number }
): number {
  if (room.type === 'checkout') {
    return property?.checkoutMinutes ?? CHECKOUT_MINS;
  }
  const day1 = property?.stayoverDay1Minutes ?? STAYOVER_DAY1_MINS;
  const day2 = property?.stayoverDay2Minutes ?? property?.stayoverMinutes ?? STAYOVER_DAY2_MINS;
  const fallback = property?.stayoverMinutes ?? day2;
  if (typeof room.stayoverDay !== 'number' || room.stayoverDay <= 0) return fallback;
  return room.stayoverDay % 2 === 1 ? day1 : day2;
}

// ─── Auto-assign rooms to staff ────────────────────────────────────────────

export interface AssignConfig {
  checkoutMinutes?: number;
  /** @deprecated Use stayoverDay1Minutes + stayoverDay2Minutes */
  stayoverMinutes?: number;
  stayoverDay1Minutes?: number;
  stayoverDay2Minutes?: number;
  prepMinutesPerRoom?: number;
  shiftMinutes?: number;
}

export function autoAssignRooms(
  rooms: Array<{ id: string; number: string; type: string; priority: string; stayoverDay?: number }>,
  staff: StaffMember[],
  config?: AssignConfig,
): Record<string, string> {
  const coMins = config?.checkoutMinutes ?? 30;
  const day1Mins = config?.stayoverDay1Minutes ?? 15;
  const day2Mins = config?.stayoverDay2Minutes ?? config?.stayoverMinutes ?? 20;
  const legacySoMins = config?.stayoverMinutes ?? day2Mins;
  const prepMins = config?.prepMinutesPerRoom ?? 5;
  const shiftCap = config?.shiftMinutes ?? 420; // 7 hours max

  // Schedule-priority gate. The Staff Priority modal lets Mario mark each
  // housekeeper as 'priority' (auto-pick first), 'normal' (default), or
  // 'excluded' (never auto-pick). Within the pool, 'priority' staff fill
  // first (toward the shift cap), then 'normal' staff pick up the spillover.
  //
  // Codex adversarial review 2026-05-13 (I-C4): the prior version
  // ALSO filtered by `s.scheduledToday` here, but the caller in
  // ScheduleTab passes `activeCrew` (derived from crewIds) regardless
  // of `scheduledToday`. A manager who added Cindy via the off-crew
  // chip got her dropped silently — toast said "Rooms auto-assigned"
  // while Cindy ended up with 0 rooms.
  // Policy fix: the CALLER is responsible for passing in the staff that
  // should be considered. We only filter for `excluded` here (which is
  // a per-staff flag, not a per-day scheduling decision).
  const available = staff.filter(s => s.schedulePriority !== 'excluded');
  if (available.length === 0) return {};

  const priorityStaff = available.filter(s => s.schedulePriority === 'priority');
  const normalStaff   = available.filter(s => s.schedulePriority !== 'priority');

  const assignments: Record<string, string> = {};
  // floorCount[staffId][floor] = rooms already assigned to them on that floor.
  // Driving stickiness off a real count (not just a Set) means a person with
  // 5 rooms on floor 2 outranks a person with 1 room on floor 2 — important
  // when one person's filled their floor and others start picking it up.
  const staffLoad: Record<string, { minutes: number; floors: Map<string, number> }> = {};
  available.forEach(s => { staffLoad[s.id] = { minutes: 0, floors: new Map() }; });

  function roomMinutes(room: { type: string; stayoverDay?: number }): number {
    let baseMins: number;
    if (room.type === 'checkout') {
      baseMins = coMins;
    } else if (typeof room.stayoverDay === 'number' && room.stayoverDay > 0) {
      baseMins = room.stayoverDay % 2 === 1 ? day1Mins : day2Mins;
    } else {
      baseMins = legacySoMins;
    }
    return baseMins + prepMins;
  }

  // ── Floor-block assignment (2026-04-30 redesign) ────────────────────────
  //
  // Old behavior (caused Maria's 'why does Cindy have half of two floors?'
  // complaint): rooms were processed in floor order, and within each floor
  // the algorithm picked the housekeeper with the most stickiness on that
  // floor. As soon as the first HK hit the shift cap on a busy floor, the
  // SECOND HK started taking rooms on the SAME floor — and once both had
  // some rooms there, the next floor split the same way again. Result:
  // every busy floor got ping-ponged between the same two HKs.
  //
  // New behavior: process floors largest-first, and for each floor try to
  // give the WHOLE floor to a single HK. Only spill over to a second HK
  // when the floor is genuinely too big for one shift. The HK who picks
  // up the spillover then becomes the natural choice for the NEXT-largest
  // floor (because they're the least loaded), and they end up doing one
  // small floor + one big one. Other HKs stay on a single floor each.
  //
  // For the typical Comfort Suites layout (4 HKs, 4 floors, one floor
  // bigger than a single shift): the result is one HK shared across 1.x
  // floors and three HKs each on a single floor. Compare to before where
  // two HKs were shared across 2 floors each.
  //
  // Sorting:
  //   • Floors processed in order of total cleaning minutes DESCENDING
  //     (biggest first — biggest is most likely to overflow, so we resolve
  //     it before assigning small floors to anyone).
  //   • Within a floor, rooms ordered checkouts-first then ascending number
  //     so the cleaning sequence makes sense for the HK doing them.

  function getFloor(num: string): string {
    return num.length >= 3 ? num[0] : '1';
  }

  // Group rooms by floor and pre-compute minutes per room.
  type FloorRoom = { id: string; number: string; type: string; mins: number };
  const byFloor = new Map<string, FloorRoom[]>();
  for (const r of rooms) {
    const floor = getFloor(r.number);
    const mins = roomMinutes(r);
    const list = byFloor.get(floor);
    const entry: FloorRoom = { id: r.id, number: r.number, type: r.type, mins };
    if (list) list.push(entry); else byFloor.set(floor, [entry]);
  }

  // Within each floor: checkouts first (more involved cleans), then ascending
  // room number. Keeps the sequence walkable and consistent.
  for (const list of Array.from(byFloor.values())) {
    list.sort((a, b) => {
      const ka = getRoomSortKey(a.type, 'standard');
      const kb = getRoomSortKey(b.type, 'standard');
      if (ka !== kb) return ka - kb;
      return a.number.localeCompare(b.number);
    });
  }

  // Order floors by total minutes DESCENDING. Tie-break by floor label so
  // output is deterministic (same input → same assignment, important so
  // 'click Auto-assign twice' doesn't shuffle rooms).
  const floorEntries: Array<[string, FloorRoom[]]> = Array.from(byFloor.entries());
  floorEntries.sort((a, b) => {
    const ma = a[1].reduce((s, x) => s + x.mins, 0);
    const mb = b[1].reduce((s, x) => s + x.mins, 0);
    if (mb !== ma) return mb - ma;
    return a[0].localeCompare(b[0]);
  });

  // pickPool: choose the housekeeper that should claim the next room from
  // this floor. Among the pool members with capacity:
  //   1) prefer whoever already has the most rooms on this floor (let them
  //      finish what they started — minimizes walking),
  //   2) then prefer whoever has the LEAST total load (so a fresh shoulder
  //      gets the new floor instead of piling more on someone already busy).
  // Returns null when no one in the pool can fit even one room of this size.
  function pickPool(
    pool: StaffMember[],
    floor: string,
    roomTime: number,
  ): StaffMember | null {
    const withCapacity = pool.filter(s => staffLoad[s.id].minutes + roomTime <= shiftCap);
    if (withCapacity.length === 0) return null;
    let best: StaffMember | null = null;
    let bestFloorCount = -1;
    let bestLoad = Infinity;
    for (const s of withCapacity) {
      const fc = staffLoad[s.id].floors.get(floor) ?? 0;
      const load = staffLoad[s.id].minutes;
      if (fc > bestFloorCount || (fc === bestFloorCount && load < bestLoad)) {
        bestFloorCount = fc;
        bestLoad = load;
        best = s;
      }
    }
    return best;
  }

  // Assign each floor as a block, splitting only when the floor genuinely
  // doesn't fit on one shift. Inner loop: take rooms one at a time off the
  // queue; whoever's least loaded with capacity for the next room takes as
  // many as they can before we re-pick.
  for (const [floor, floorRooms] of floorEntries) {
    const queue: FloorRoom[] = [...floorRooms];
    while (queue.length > 0) {
      const next = queue[0];
      let chosen = pickPool(priorityStaff, floor, next.mins);
      if (!chosen) chosen = pickPool(normalStaff, floor, next.mins);
      if (!chosen) break; // nobody has capacity left — leave the rest unassigned

      // Greedy fill: keep handing this HK rooms from this floor until they
      // hit the shift cap or the floor is empty.
      while (queue.length > 0) {
        const r = queue[0];
        if (staffLoad[chosen.id].minutes + r.mins > shiftCap) break;
        assignments[r.id] = chosen.id;
        staffLoad[chosen.id].minutes += r.mins;
        const fmap = staffLoad[chosen.id].floors;
        fmap.set(floor, (fmap.get(floor) ?? 0) + 1);
        queue.shift();
      }
      // chosen is full (or queue empty); outer loop re-picks for any
      // remaining queue rooms.
    }
  }

  return assignments;
}

// ─── Format helpers ────────────────────────────────────────────────────────

export function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function calcROI(totalSaved: number, monthlyPrice: number, monthsUsed: number): number {
  const totalPaid = monthlyPrice * monthsUsed;
  if (totalPaid === 0) return 0;
  return totalSaved / totalPaid;
}

// ─── Deep Cleaning helpers ────────────────────────────────────────────────

/** Returns how many days since a room's last deep clean (Infinity if never) */
export function daysSinceDeepClean(roomNumber: string, records: DeepCleanRecord[], today: Date = new Date()): number {
  const rec = records.find(r => r.roomNumber === roomNumber);
  if (!rec) return Infinity;
  return differenceInDays(today, parseISO(rec.lastDeepClean));
}

/** Calculate freed minutes from DND rooms that can be used for deep cleaning */
export function calcDndFreedMinutes(
  rooms: Array<{ isDnd?: boolean; type: string; stayoverDay?: number; priority?: string }>,
  property: Property
): number {
  return rooms
    .filter(r => r.isDnd)
    .reduce((sum, r) => {
      const mins = getRoomMinutes(
        { type: r.type, priority: r.priority ?? 'standard', stayoverDay: r.stayoverDay },
        property
      );
      return sum + mins;
    }, 0);
}

/** Suggest how many deep cleans can fit into available free time */
export function suggestDeepCleans(
  freedMinutes: number,
  slackMinutes: number,
  config: DeepCleanConfig,
  overdueCount: number
): { count: number; source: string; minutes: number } {
  const availableMinutes = freedMinutes + Math.max(0, slackMinutes);
  const possibleRooms = Math.floor(availableMinutes / config.minutesPerRoom);
  const count = Math.min(possibleRooms, overdueCount); // don't suggest more than overdue
  return {
    count,
    source: freedMinutes > 0 ? 'dnd' : 'slack',
    minutes: count * config.minutesPerRoom,
  };
}
