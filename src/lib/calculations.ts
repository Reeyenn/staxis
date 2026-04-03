import { format, differenceInDays, parseISO, addMinutes } from 'date-fns';
import type {
  PublicArea,
  LaundryCategory,
  Property,
  ScheduleResult,
  MorningSetupForm,
  StaffMember,
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

    const loads = Math.ceil(units / cat.roomEquivsPerLoad);
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
const STAYOVER_MINS = 15;
const VIP_BONUS_MINS = 10; // suites / VIP rooms take longer

export function getRoomMinutes(room: { type: string; priority: string }): number {
  const base = room.type === 'checkout' ? CHECKOUT_MINS : STAYOVER_MINS;
  return base + (room.priority === 'vip' ? VIP_BONUS_MINS : 0);
}

// ─── Auto-assign rooms to staff ────────────────────────────────────────────

export function autoAssignRooms(
  rooms: Array<{ id: string; number: string; type: string; priority: string }>,
  staff: StaffMember[]
): Record<string, string> {
  // Filter available staff
  const available = staff.filter(s => s.scheduledToday);
  if (available.length === 0) return {};

  const assignments: Record<string, string> = {};
  const staffLoad: Record<string, { staffId: string; name: string; minutes: number; floor: string }> = {};
  available.forEach(s => { staffLoad[s.id] = { staffId: s.id, name: s.name, minutes: 0, floor: '' }; });

  // Sort VIP rooms to senior staff
  const seniorStaff = available.filter(s => s.isSenior);

  const sortedRooms = [...rooms].sort((a, b) => getRoomSortKey(a.type, a.priority) - getRoomSortKey(b.type, b.priority));

  for (const room of sortedRooms) {
    const floor = room.number.length >= 3 ? room.number[0] : '1';
    const isVIP = room.priority === 'vip';
    const minutes = getRoomMinutes(room);

    // Prefer same-floor assignment, then least-loaded staff
    const pool = isVIP && seniorStaff.length > 0 ? seniorStaff : available;
    const sameFloor = pool.filter(s => staffLoad[s.id].floor === floor);
    const candidates = sameFloor.length > 0 ? sameFloor : pool;

    const leastLoaded = candidates.reduce((min, s) =>
      staffLoad[s.id].minutes < staffLoad[min.id].minutes ? s : min
    );

    assignments[room.id] = leastLoaded.id;
    staffLoad[leastLoaded.id].minutes += minutes;
    if (!staffLoad[leastLoaded.id].floor) staffLoad[leastLoaded.id].floor = floor;
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
  rooms: Array<{ id: string; number: string; type: string; priority: string }>,
  staff: StaffMember[],
  assignments: Record<string, string>, // roomId → staffId
  startTime: string = '08:00',
): HousekeeperAssignment[] {
  const available = staff.filter(s => s.scheduledToday);
  const [startHour, startMin] = startTime.split(':').map(Number);

  const result: HousekeeperAssignment[] = [];

  for (const s of available) {
    const assignedRooms = rooms
      .filter(r => assignments[r.id] === s.id)
      .sort((a, b) => getRoomSortKey(a.type, a.priority) - getRoomSortKey(b.type, b.priority));

    if (assignedRooms.length === 0) continue;

    const totalMinutes = assignedRooms.reduce((sum, r) => sum + getRoomMinutes(r), 0);

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
