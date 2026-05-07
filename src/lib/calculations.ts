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
  /**
   * Optional supply predictions from active ML model. Map key is "${roomNumber}:${staffId}".
   * When provided, predicted_minutes_p50 values override static room-minute estimates
   * in the autoAssign workload calculation. When absent or no entry for a room-staff pair,
   * falls back to static rules.
   */
  supplyPredictions?: Map<string, number>;
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
  // 'excluded' (never auto-pick). The schedule auto-selector already
  // honors this — but if Mario manually adds an Excluded housekeeper to
  // today's crew via the Add Staff button, we still want auto-assign to
  // refuse to pile rooms on them. So we re-filter here as a safety net.
  // Within the remaining pool, 'priority' staff fill first (until at the
  // shift cap or out of suitable floor stickiness), then 'normal' staff
  // pick up the spillover. Floor-stickiness and least-load tiebreakers
  // apply within each tier — same logic as before, just two passes.
  const available = staff.filter(s =>
    s.scheduledToday && s.schedulePriority !== 'excluded',
  );
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

  // Sort by floor first (proximity), then checkouts before stayovers, then room number
  const sortedRooms = [...rooms].sort((a, b) => {
    const floorA = a.number.length >= 3 ? a.number[0] : '1';
    const floorB = b.number.length >= 3 ? b.number[0] : '1';
    if (floorA !== floorB) return floorA.localeCompare(floorB);
    const typeOrder = getRoomSortKey(a.type, a.priority) - getRoomSortKey(b.type, b.priority);
    if (typeOrder !== 0) return typeOrder;
    return a.number.localeCompare(b.number);
  });

  // Pick the best staff out of a candidate pool given a room. Stickiness
  // first (whoever has the most rooms on this floor), then least-load.
  // Returns null if the pool is empty or no one has capacity.
  function pickBest(
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

  // Track rooms we couldn't fit under the cap — surfaced as unassigned in the UI
  // so Reeyen can add another housekeeper or manually stretch someone. Never
  // pile over the cap silently — that's what produced 10h+ shifts in the past.
  for (const room of sortedRooms) {
    const floor = room.number.length >= 3 ? room.number[0] : '1';

    // Attempt to use ML supply predictions when available. Walk through Priority
    // staff first (they get first pick), then Normal staff, and find the first
    // HK with a prediction for this room. If found and ML is active, use the
    // predicted minutes. Otherwise fall back to static rules.
    let roomTime: number | null = null;

    if (config?.supplyPredictions) {
      for (const s of priorityStaff) {
        const key = `${room.number}:${s.id}`;
        if (config.supplyPredictions.has(key)) {
          roomTime = config.supplyPredictions.get(key)!;
          break;
        }
      }
      if (roomTime === null) {
        for (const s of normalStaff) {
          const key = `${room.number}:${s.id}`;
          if (config.supplyPredictions.has(key)) {
            roomTime = config.supplyPredictions.get(key)!;
            break;
          }
        }
      }
    }

    // Fall back to static rules if no ML prediction found
    if (roomTime === null) {
      let baseMins: number;
      if (room.type === 'checkout') {
        baseMins = coMins;
      } else if (typeof room.stayoverDay === 'number' && room.stayoverDay > 0) {
        baseMins = room.stayoverDay % 2 === 1 ? day1Mins : day2Mins;
      } else {
        baseMins = legacySoMins;
      }
      roomTime = baseMins + prepMins;
    }

    // Try Priority staff first. Only fall through to Normal staff when no
    // Priority candidate has capacity for this room. This means Priority
    // housekeepers fill toward the shift cap before any Normal one picks
    // up a room — matching the modal's promise of "Priority = picked first".
    let best = pickBest(priorityStaff, floor, roomTime);
    if (!best) best = pickBest(normalStaff, floor, roomTime);
    if (!best) continue; // leave in unassigned pool — no one has capacity

    assignments[room.id] = best.id;
    staffLoad[best.id].minutes += roomTime;
    const fmap = staffLoad[best.id].floors;
    fmap.set(floor, (fmap.get(floor) ?? 0) + 1);
  }

  return assignments;
}

// ─── Build per-housekeeper assignment view ─────────────────────────────────

export interface HousekeeperAssignment {
  staffId: string;
  name: string;
  isSenior: boolean;
  rooms: Array<{ id: string; number: string; type: string; priority: string }>;
  totalMinutes: number;
  estimatedDoneBy: string;
}

export function buildHousekeeperAssignments(
  rooms: Array<{ id: string; number: string; type: string; priority: string; stayoverDay?: number }>,
  staff: StaffMember[],
  assignments: Record<string, string>, // roomId → staffId
  startTime: string = '08:00',
  property?: { checkoutMinutes?: number; stayoverMinutes?: number; stayoverDay1Minutes?: number; stayoverDay2Minutes?: number },
): HousekeeperAssignment[] {
  const available = staff.filter(s => s.scheduledToday);
  const [startHour, startMin] = startTime.split(':').map(Number);

  const result: HousekeeperAssignment[] = [];

  for (const s of available) {
    const assignedRooms = rooms
      .filter(r => assignments[r.id] === s.id)
      .sort((a, b) => getRoomSortKey(a.type, a.priority) - getRoomSortKey(b.type, b.priority));

    if (assignedRooms.length === 0) continue;

    const totalMinutes = assignedRooms.reduce((sum, r) => sum + getRoomMinutes(r, property), 0);

    const startDate = new Date();
    startDate.setHours(startHour, startMin, 0, 0);
    const doneDate = addMinutes(startDate, totalMinutes);
    const estimatedDoneBy = format(doneDate, 'h:mm a');

    result.push({ staffId: s.id, name: s.name, isSenior: s.isSenior, rooms: assignedRooms, totalMinutes, estimatedDoneBy });
  }

  // Sort by least loaded first so most-available HK is on top
  return result.sort((a, b) => a.totalMinutes - b.totalMinutes);
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

/** Returns rooms that are overdue for deep cleaning */
export function getOverdueRooms(
  allRoomNumbers: string[],
  records: DeepCleanRecord[],
  config: DeepCleanConfig,
  today: Date = new Date()
): { roomNumber: string; daysSince: number }[] {
  return allRoomNumbers
    .map(num => ({ roomNumber: num, daysSince: daysSinceDeepClean(num, records, today) }))
    .filter(r => r.daysSince >= config.frequencyDays)
    .sort((a, b) => b.daysSince - a.daysSince); // most overdue first
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
