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

  const available = staff.filter(s => s.scheduledToday);
  if (available.length === 0) return {};

  const assignments: Record<string, string> = {};
  const staffLoad: Record<string, { minutes: number; floors: Set<string> }> = {};
  available.forEach(s => { staffLoad[s.id] = { minutes: 0, floors: new Set() }; });

  // Sort by floor first (proximity), then checkouts before stayovers, then room number
  const sortedRooms = [...rooms].sort((a, b) => {
    const floorA = a.number.length >= 3 ? a.number[0] : '1';
    const floorB = b.number.length >= 3 ? b.number[0] : '1';
    if (floorA !== floorB) return floorA.localeCompare(floorB);
    const typeOrder = getRoomSortKey(a.type, a.priority) - getRoomSortKey(b.type, b.priority);
    if (typeOrder !== 0) return typeOrder;
    return a.number.localeCompare(b.number);
  });

  for (const room of sortedRooms) {
    const floor = room.number.length >= 3 ? room.number[0] : '1';
    let baseMins: number;
    if (room.type === 'checkout') {
      baseMins = coMins;
    } else if (typeof room.stayoverDay === 'number' && room.stayoverDay > 0) {
      baseMins = room.stayoverDay % 2 === 1 ? day1Mins : day2Mins;
    } else {
      baseMins = legacySoMins;
    }
    const roomTime = baseMins + prepMins;

    // Find staff who still have capacity
    const withCapacity = available.filter(s => staffLoad[s.id].minutes + roomTime <= shiftCap);
    const pool = withCapacity.length > 0 ? withCapacity : available; // safety fallback

    // Prefer someone already on this floor
    const sameFloor = pool.filter(s => staffLoad[s.id].floors.has(floor));

    // From candidates, pick the MOST loaded (fill up before moving to next person)
    const candidates = sameFloor.length > 0 ? sameFloor : pool;
    const mostLoaded = candidates.reduce((best, s) =>
      staffLoad[s.id].minutes > staffLoad[best.id].minutes ? s : best
    );

    assignments[room.id] = mostLoaded.id;
    staffLoad[mostLoaded.id].minutes += roomTime;
    staffLoad[mostLoaded.id].floors.add(floor);
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
