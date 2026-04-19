import type { PublicArea, LaundryCategory } from '@/types';
import { format, subDays } from 'date-fns';

// Default public areas for a 4-floor limited-service hotel
function today(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

// Stagger non-daily areas so they don't all fire on day 1
function daysAgo(n: number): string {
  return format(subDays(new Date(), n), 'yyyy-MM-dd');
}

export function getDefaultPublicAreas(): Omit<PublicArea, 'id'>[] {
  const d = today();
  // Stagger non-daily areas so they don't all pile up on day 1.
  // Areas with frequencyDays=2 start 1 day ago (next due tomorrow).
  // Areas with frequencyDays=3 start 1 day ago (next due in 2 days).
  // Areas with frequencyDays=7 start 3 days ago (next due in 4 days).
  const d1 = daysAgo(1);
  const d3 = daysAgo(3);
  return [
    // ── Floor 1 ──────────────────────────────────────────────────────
    { name: 'Elevator Area - 1st Floor', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 15, startDate: d },
    { name: '1st Floor Hallway', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 60, startDate: d },
    { name: 'Front Entrance + Breakfast Area + Pantry + Lobby', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 45, startDate: d },
    { name: 'Front Desk + Behind Front Desk', floor: '1', locations: 1, frequencyDays: 2, minutesPerClean: 15, startDate: d1 },
    { name: 'Restrooms', floor: '1', locations: 3, frequencyDays: 1, minutesPerClean: 15, startDate: d },
    { name: 'Pool area + Pool bathroom', floor: '1', locations: 1, frequencyDays: 3, minutesPerClean: 120, startDate: d1 },
    { name: 'Meeting Room', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 30, startDate: d, onlyWhenRented: true, isRentedToday: false },
    { name: 'Business Center', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 10, startDate: d },
    { name: 'Fitness Center', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 10, startDate: d },
    { name: 'Laundry + Linen Room', floor: '1', locations: 1, frequencyDays: 2, minutesPerClean: 30, startDate: d1 },
    { name: 'Laundry Break Room', floor: '1', locations: 1, frequencyDays: 2, minutesPerClean: 10, startDate: d1 },

    // ── Floor 2 ───────────────────────────────────────────────────────
    { name: '2nd Floor Hallway + Side Hallway', floor: '2', locations: 1, frequencyDays: 1, minutesPerClean: 16, startDate: d },
    { name: 'Guest Laundry Room', floor: '2', locations: 1, frequencyDays: 3, minutesPerClean: 15, startDate: d1 },
    { name: 'Soda Ice Room', floor: '2', locations: 1, frequencyDays: 3, minutesPerClean: 10, startDate: d1 },
    { name: 'Housekeeping Room', floor: '2', locations: 1, frequencyDays: 7, minutesPerClean: 15, startDate: d3 },

    // ── Floor 3 ───────────────────────────────────────────────────────
    { name: '3rd Floor Hallway + Side Hallway', floor: '3', locations: 1, frequencyDays: 1, minutesPerClean: 16, startDate: d },
    { name: 'Soda Ice Room', floor: '3', locations: 1, frequencyDays: 3, minutesPerClean: 10, startDate: d1 },
    { name: 'Housekeeping Room', floor: '3', locations: 1, frequencyDays: 7, minutesPerClean: 15, startDate: d3 },

    // ── Floor 4 ───────────────────────────────────────────────────────
    { name: '4th Floor Hallway + Side Hallway', floor: '4', locations: 1, frequencyDays: 1, minutesPerClean: 16, startDate: d },
    { name: 'Soda Ice Room', floor: '4', locations: 1, frequencyDays: 3, minutesPerClean: 10, startDate: d1 },
    { name: 'Housekeeping Room', floor: '4', locations: 1, frequencyDays: 7, minutesPerClean: 15, startDate: d3 },

    // ── Other ────────────────────────────────────────────────────────
    { name: 'Stairs', floor: 'other', locations: 2, frequencyDays: 7, minutesPerClean: 30, startDate: d3 },
    { name: 'Parking Lot Garbage', floor: 'other', locations: 1, frequencyDays: 3, minutesPerClean: 45, startDate: d1 },
    { name: 'Front + Side Glass (Outside)', floor: 'other', locations: 1, frequencyDays: 3, minutesPerClean: 45, startDate: d1 },
  ];
}

export function getDefaultLaundryCategories(): Omit<LaundryCategory, 'id'>[] {
  // minutesPerLoad = labor time only (loading + unloading + folding), not machine cycle time.
  // roomEquivsPerLoad = how many rooms' worth fits in one commercial washer load.
  return [
    {
      name: 'Towels / Bath Mats',
      unitsPerCheckout: 1,
      twoBedMultiplier: 1.5,
      stayoverFactor: 0.3,
      roomEquivsPerLoad: 20,
      minutesPerLoad: 15,
    },
    {
      name: 'Sheets',
      unitsPerCheckout: 1,
      twoBedMultiplier: 1.5,
      stayoverFactor: 0.3,
      roomEquivsPerLoad: 15,
      minutesPerLoad: 15,
    },
    {
      name: 'Comforters',
      unitsPerCheckout: 1,
      twoBedMultiplier: 2,
      stayoverFactor: 0.5,
      roomEquivsPerLoad: 8,
      minutesPerLoad: 15,
    },
  ];
}

export const DEFAULT_PROPERTY = {
  totalRooms: 74,
  avgOccupancy: 65,
  hourlyWage: 12,
  checkoutMinutes: 30,
  // Stayover cleaning uses a 2-day cycle:
  //   Day 1, 3, 5, … → 15 min (light touch, no bed change)
  //   Day 2, 4, 6, … → 20 min (full clean, bed change)
  // `stayoverMinutes` is kept as a legacy fallback; prefer the two below.
  stayoverMinutes: 20,
  stayoverDay1Minutes: 15,
  stayoverDay2Minutes: 20,
  prepMinutesPerActivity: 5,
  shiftMinutes: 480,
  totalStaffOnRoster: 8,
  weeklyBudget: 2500,
};
