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
    { name: 'Elevator Area (1st Floor)', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 15, startDate: d },
    { name: '1st Floor Hallway', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 60, startDate: d },
    { name: 'Front Entrance / Breakfast Area / Lobby', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 45, startDate: d },
    { name: 'Front Desk + Behind Front Desk', floor: '1', locations: 1, frequencyDays: 2, minutesPerClean: 15, startDate: d1 },
    { name: 'Restrooms (3 total)', floor: '1', locations: 3, frequencyDays: 1, minutesPerClean: 15, startDate: d },
    { name: 'Pool Area + Pool Bathroom', floor: '1', locations: 1, frequencyDays: 3, minutesPerClean: 120, startDate: d1 },
    { name: 'Meeting Room', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 30, startDate: d, onlyWhenRented: true, isRentedToday: false },
    { name: 'Business Center', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 10, startDate: d },
    { name: 'Fitness Center', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 10, startDate: d },
    { name: 'Stairwells (Ground Floor)', floor: '1', locations: 2, frequencyDays: 7, minutesPerClean: 30, startDate: d3 },
    { name: 'Staff / Service Rooms (laundry, linen, break room)', floor: '1', locations: 5, frequencyDays: 2, minutesPerClean: 10, startDate: d1 },

    // ── Floor 2 ──────────────────────────────────────────────────────
    { name: 'Floor 2 Hallway + Elevator Lobby', floor: '2', locations: 1, frequencyDays: 1, minutesPerClean: 60, startDate: d },
    { name: 'Floor 2 Guest Laundry / Vending / Ice', floor: '2', locations: 1, frequencyDays: 3, minutesPerClean: 15, startDate: d1 },
    { name: 'Floor 2 Stairwells', floor: '2', locations: 2, frequencyDays: 7, minutesPerClean: 30, startDate: d3 },
    { name: 'Floor 2 Housekeeping/Staff Rooms', floor: '2', locations: 3, frequencyDays: 7, minutesPerClean: 15, startDate: d3 },

    // ── Floor 3 ──────────────────────────────────────────────────────
    { name: 'Floor 3 Hallway + Elevator Lobby', floor: '3', locations: 1, frequencyDays: 1, minutesPerClean: 60, startDate: d },
    { name: 'Floor 3 Guest Laundry / Vending / Ice', floor: '3', locations: 1, frequencyDays: 3, minutesPerClean: 15, startDate: d1 },
    { name: 'Floor 3 Stairwells', floor: '3', locations: 2, frequencyDays: 7, minutesPerClean: 30, startDate: d3 },
    { name: 'Floor 3 Housekeeping/Staff Rooms', floor: '3', locations: 3, frequencyDays: 7, minutesPerClean: 15, startDate: d3 },

    // ── Floor 4 ──────────────────────────────────────────────────────
    { name: 'Floor 4 Hallway + Elevator Lobby', floor: '4', locations: 1, frequencyDays: 1, minutesPerClean: 60, startDate: d },
    { name: 'Floor 4 Guest Laundry / Vending / Ice', floor: '4', locations: 1, frequencyDays: 3, minutesPerClean: 15, startDate: d1 },
    { name: 'Floor 4 Stairwells', floor: '4', locations: 2, frequencyDays: 7, minutesPerClean: 30, startDate: d3 },
    { name: 'Floor 4 Housekeeping/Staff Rooms', floor: '4', locations: 3, frequencyDays: 7, minutesPerClean: 15, startDate: d3 },

    // ── Exterior ──────────────────────────────────────────────────────
    { name: 'Parking Lot Garbage', floor: 'exterior', locations: 1, frequencyDays: 3, minutesPerClean: 45, startDate: d1 },
    { name: 'Front + Side Glass (Outside)', floor: 'exterior', locations: 1, frequencyDays: 3, minutesPerClean: 45, startDate: d1 },
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
  stayoverMinutes: 20,
  prepMinutesPerActivity: 5,
  shiftMinutes: 480,
  totalStaffOnRoster: 8,
  weeklyBudget: 2500,
};
