/**
 * HotelOps AI — Nightly Scheduler
 *
 * Runs at 10pm local time. Reads today's room data from Firestore,
 * calculates tomorrow's workload (rooms + public areas), smart-assigns
 * rooms to housekeepers, saves the schedule, and fires push notifications.
 */

const { Timestamp } = require('firebase-admin/firestore');

// ─── Staffing constants ─────────────────────────────────────────────────────

// Minutes to clean each room type (replace with calibrated values once
// fingerprint machine data is available)
const CLEANING_TIMES = {
  checkout: 30,
  stayover: 20,
};

const SHIFT_MINUTES = 480; // 8-hour shift

// Fixed staff — always scheduled regardless of occupancy.
// These are NOT included in the variable HK recommendation.
const FIXED_STAFF = [
  { role: 'Laundry',     hours: 8,  notes: 'Dedicated laundry — every day' },
  { role: 'Head HK',     hours: 8,  notes: 'Supervision + misc help' },
  { role: 'Maintenance', hours: 8,  notes: 'Maintenance tasks' },
  { role: 'Breakfast',   hours: 7,  notes: '5:00 AM – 12:00 PM daily' },
];

// ─── Public areas ───────────────────────────────────────────────────────────

// Reference date for frequency cycle (day 0 = everything cleaned that day).
// Adjust if you want cycles to start from a different date.
const CYCLE_REFERENCE = new Date('2026-03-24T00:00:00.000Z');

// All public areas with their cleaning schedules.
// frequencyDays: clean every N days (1 = daily, 2 = every other day, etc.)
const PUBLIC_AREAS = [
  // ── Daily ──────────────────────────────────────────────────────────────
  { name: 'Elevator Area – 1st Floor',           locations: 1, frequencyDays: 1, minutesPerClean: 15 },
  { name: '1st Floor Hallway',                    locations: 1, frequencyDays: 1, minutesPerClean: 60 },
  { name: 'Entrance + Breakfast Area + Lobby',    locations: 1, frequencyDays: 1, minutesPerClean: 45 },
  { name: 'Restrooms (lobby area, x3)',           locations: 3, frequencyDays: 1, minutesPerClean: 15 },
  { name: 'Business Center',                      locations: 1, frequencyDays: 1, minutesPerClean: 10 },
  { name: 'Fitness Center',                       locations: 1, frequencyDays: 1, minutesPerClean: 10 },
  { name: 'Floor 2 Hallway + Elevator Lobby',     locations: 1, frequencyDays: 1, minutesPerClean: 60 },
  { name: 'Floor 3 Hallway + Elevator Lobby',     locations: 1, frequencyDays: 1, minutesPerClean: 60 },
  { name: 'Floor 4 Hallway + Elevator Lobby',     locations: 1, frequencyDays: 1, minutesPerClean: 60 },

  // ── Every 2 days ───────────────────────────────────────────────────────
  { name: 'Front Desk + Behind Front Desk',       locations: 1, frequencyDays: 2, minutesPerClean: 15 },
  { name: 'Staff/Service Rooms (x5)',             locations: 5, frequencyDays: 2, minutesPerClean: 10 },

  // ── Every 3-4 days ─────────────────────────────────────────────────────
  { name: 'Pool Area + Pool Bathroom',            locations: 1, frequencyDays: 3, minutesPerClean: 120 },
  { name: 'Parking Lot Garbage',                  locations: 1, frequencyDays: 3, minutesPerClean: 45  },
  { name: 'Front + Side Glass (Outside)',         locations: 1, frequencyDays: 3, minutesPerClean: 45  },
  { name: 'Guest Laundry/Vending/Ice – Floor 2', locations: 1, frequencyDays: 4, minutesPerClean: 15  },
  { name: 'Guest Laundry/Vending/Ice – Floor 3', locations: 1, frequencyDays: 4, minutesPerClean: 15  },
  { name: 'Guest Laundry/Vending/Ice – Floor 4', locations: 1, frequencyDays: 4, minutesPerClean: 15  },

  // ── Weekly ─────────────────────────────────────────────────────────────
  { name: 'Stairs – Both Stairwells',             locations: 2, frequencyDays: 7, minutesPerClean: 30  },
  { name: 'HK Staff Rooms – Floor 2 (x3)',        locations: 3, frequencyDays: 7, minutesPerClean: 15  },
  { name: 'HK Staff Rooms – Floor 3 (x3)',        locations: 3, frequencyDays: 7, minutesPerClean: 15  },
  { name: 'HK Staff Rooms – Floor 4 (x3)',        locations: 3, frequencyDays: 7, minutesPerClean: 15  },
];

/**
 * Returns public area minutes and the list of areas due on a given ISO date.
 */
function getPublicAreaMinutes(dateISO) {
  const date = new Date(dateISO + 'T12:00:00.000Z'); // noon UTC to avoid DST edge
  const daysSinceRef = Math.round((date - CYCLE_REFERENCE) / (1000 * 60 * 60 * 24));

  let totalMinutes = 0;
  const areasToday = [];

  for (const area of PUBLIC_AREAS) {
    if (daysSinceRef % area.frequencyDays === 0) {
      const mins = area.locations * area.minutesPerClean;
      totalMinutes += mins;
      areasToday.push({ name: area.name, locations: area.locations, minutesToday: mins });
    }
  }

  return { totalMinutes, areasToday };
}

// ─── Smart room assignment ──────────────────────────────────────────────────

/**
 * Assigns rooms to N housekeepers.
 * Strategy: group rooms by floor, then distribute floor-groups to the
 * housekeeper with the least work (greedy load balancing). This keeps
 * rooms close together on each housekeeper's list.
 *
 * Checkouts are sorted before stayovers within each floor.
 */
function smartAssignRooms(rooms, numHousekeepers) {
  if (numHousekeepers <= 0 || rooms.length === 0) return [];

  // Group by floor (first digit of room number)
  const byFloor = {};
  for (const room of rooms) {
    const floor = String(room.number).charAt(0);
    if (!byFloor[floor]) byFloor[floor] = [];
    byFloor[floor].push(room);
  }

  // Within each floor: checkouts first, then stayovers, both sorted numerically
  for (const floor of Object.keys(byFloor)) {
    byFloor[floor].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'checkout' ? -1 : 1;
      return parseInt(a.number) - parseInt(b.number);
    });
  }

  // Initialize housekeeper slots
  const hks = Array.from({ length: numHousekeepers }, (_, i) => ({
    index: i,
    rooms: [],
    totalMinutes: 0,
  }));

  // Assign each floor-group to the least-loaded housekeeper
  const floors = Object.keys(byFloor).sort();
  for (const floor of floors) {
    const floorRooms = byFloor[floor];
    const hk = hks.reduce((min, h) => h.totalMinutes < min.totalMinutes ? h : min);
    for (const room of floorRooms) {
      const mins = room.type === 'checkout' ? CLEANING_TIMES.checkout : CLEANING_TIMES.stayover;
      hk.rooms.push(room.number);
      hk.totalMinutes += mins;
    }
  }

  return hks;
}

// ─── Main scheduler ─────────────────────────────────────────────────────────

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} config  — { USER_ID, PROPERTY_ID, TIMEZONE, APP_URL }
 * @param {function} log   — logging function
 */
async function runNightlyScheduler(db, config, log) {
  log('=== Nightly Scheduler starting ===');

  const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: config.TIMEZONE }).format(new Date());

  // Tomorrow's date string (for the schedule document and area cycle calc)
  const tmrDate = new Date();
  tmrDate.setDate(tmrDate.getDate() + 1);
  const tomorrowISO = new Intl.DateTimeFormat('en-CA', { timeZone: config.TIMEZONE }).format(tmrDate);

  log(`Today: ${todayISO} | Planning for: ${tomorrowISO}`);

  // ── 1. Read today's rooms (these represent tomorrow's workload) ───────────
  const roomsSnap = await db
    .collection('users').doc(config.USER_ID)
    .collection('properties').doc(config.PROPERTY_ID)
    .collection('rooms')
    .where('date', '==', todayISO)
    .get();

  const rooms = roomsSnap.docs.map(d => d.data());
  const checkouts = rooms.filter(r => r.type === 'checkout');
  const stayovers = rooms.filter(r => r.type === 'stayover');

  log(`Rooms: ${checkouts.length} checkouts, ${stayovers.length} stayovers`);

  // ── 2. Calculate workload ─────────────────────────────────────────────────
  const roomMinutes = (checkouts.length * CLEANING_TIMES.checkout) +
                      (stayovers.length * CLEANING_TIMES.stayover);

  const { totalMinutes: publicAreaMinutes, areasToday } = getPublicAreaMinutes(tomorrowISO);

  const totalMinutes     = roomMinutes + publicAreaMinutes;
  const recommendedHKs   = Math.ceil(totalMinutes / SHIFT_MINUTES);

  log(`Workload: ${roomMinutes} room min + ${publicAreaMinutes} area min = ${totalMinutes} min → ${recommendedHKs} variable HKs`);
  log(`Fixed staff: ${FIXED_STAFF.map(f => f.role).join(', ')}`);

  // ── 3. Smart assign rooms ─────────────────────────────────────────────────
  const cleanableRooms = [...checkouts, ...stayovers];
  const assignments = smartAssignRooms(cleanableRooms, recommendedHKs);

  // ── 4. Read staff + FCM tokens ────────────────────────────────────────────
  const staffSnap = await db
    .collection('users').doc(config.USER_ID)
    .collection('properties').doc(config.PROPERTY_ID)
    .collection('staff')
    .get();

  const staff = staffSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.fcmToken); // only staff with registered devices

  log(`Staff with push tokens: ${staff.length}`);

  // ── 5. Save schedule to Firestore ─────────────────────────────────────────
  const scheduleDoc = {
    date:             tomorrowISO,
    generatedAt:      Timestamp.now(),
    checkouts:        checkouts.length,
    stayovers:        stayovers.length,
    roomMinutes,
    publicAreaMinutes,
    totalMinutes,
    recommendedHKs,
    fixedStaff:       FIXED_STAFF,
    areasScheduled:   areasToday,
    assignments:      assignments.map(a => ({
      hkIndex:      a.index,
      rooms:        a.rooms,
      totalMinutes: a.totalMinutes,
    })),
    notificationsSent: false, // updated after sending
  };

  const scheduleRef = db
    .collection('users').doc(config.USER_ID)
    .collection('properties').doc(config.PROPERTY_ID)
    .collection('schedules').doc(tomorrowISO);

  await scheduleRef.set(scheduleDoc);
  log(`Schedule saved → schedules/${tomorrowISO}`);

  // ── 6. Send push notifications ────────────────────────────────────────────
  const notifyEntries = assignments
    .filter(a => a.rooms.length > 0)
    .map((assignment, idx) => {
      // Match assignment slot to a real staff member (cycle if fewer staff than slots)
      const hk = staff[idx % staff.length];
      return hk ? { token: hk.fcmToken, name: hk.name || `HK ${idx + 1}`, rooms: assignment.rooms } : null;
    })
    .filter(Boolean);

  if (notifyEntries.length === 0) {
    log('No staff with FCM tokens — skipping push notifications');
    return scheduleDoc;
  }

  const appUrl = config.APP_URL || 'https://hotelops-ai.vercel.app';
  let notifyResult = { sent: 0, failed: 0 };

  try {
    const res = await fetch(`${appUrl}/api/notify-housekeepers`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(notifyEntries),
    });
    notifyResult = await res.json();
    log(`Notifications → ${notifyResult.sent} sent, ${notifyResult.failed} failed`);
  } catch (err) {
    log(`Notification error: ${err.message}`);
  }

  // Mark notifications as sent in the schedule doc
  await scheduleRef.update({ notificationsSent: true, notificationsResult: notifyResult });

  log(`=== Nightly Scheduler done. ${recommendedHKs} HKs assigned for ${tomorrowISO} ===`);
  return scheduleDoc;
}

module.exports = { runNightlyScheduler, getPublicAreaMinutes, smartAssignRooms, FIXED_STAFF, CLEANING_TIMES };
