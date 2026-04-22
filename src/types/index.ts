// ─── Property & Settings ───────────────────────────────────────────────────

export interface Property {
  id: string;
  name: string;
  totalRooms: number;
  avgOccupancy: number;
  hourlyWage: number;
  checkoutMinutes: number;      // default 30
  /**
   * @deprecated Use `stayoverDay1Minutes` + `stayoverDay2Minutes` instead.
   * Kept as fallback for existing property docs and any aggregate math that
   * has no per-room day-of-stay signal. New code should prefer the two
   * day-specific fields so light-touch vs full-service cleans are timed
   * correctly through the 2-day cycle.
   */
  stayoverMinutes: number;      // default 20  (legacy — average / fallback)
  stayoverDay1Minutes?: number; // default 15  — light touch, no bed change
  stayoverDay2Minutes?: number; // default 20  — full clean w/ bed change
  prepMinutesPerActivity: number; // default 5
  shiftMinutes: number;         // default 480 (8 hrs)
  totalStaffOnRoster: number;
  weeklyBudget?: number;
  morningBriefingTime?: string; // "06:30"
  eveningForecastTime?: string; // "18:00"
  pmsType?: string;
  pmsUrl?: string;
  pmsConnected?: boolean;
  lastSyncedAt?: Date | null;
  createdAt: Date;
}

// ─── Staff ─────────────────────────────────────────────────────────────────

export type StaffDepartment = 'housekeeping' | 'front_desk' | 'maintenance' | 'other';

export type SchedulePriority = 'priority' | 'normal' | 'excluded';

export interface StaffMember {
  id: string;
  name: string;
  phone?: string;
  language: 'en' | 'es';
  isSenior: boolean;
  department?: StaffDepartment;  // default 'housekeeping' if not set
  hourlyWage?: number;          // override property wage
  scheduledToday: boolean;
  weeklyHours: number;          // tracked this week
  maxWeeklyHours: number;       // default 40
  maxDaysPerWeek?: number;      // default 5
  daysWorkedThisWeek?: number;  // tracked this week
  vacationDates?: string[];     // YYYY-MM-DD strings
  isActive?: boolean;           // default true (undefined = active)
  fcmToken?: string;            // FCM device token for push notifications
  schedulePriority?: SchedulePriority; // 'priority' = auto-selected first, 'normal' = backup, 'excluded' = never auto-selected
  isSchedulingManager?: boolean; // single person who receives shift-confirmation escalation texts. Only one per property.
}

// ─── Public Areas ──────────────────────────────────────────────────────────

export interface PublicArea {
  id: string;
  name: string;
  floor: string;                // "1", "2", "3", "4", "exterior"
  locations: number;
  frequencyDays: number;        // every X days
  minutesPerClean: number;
  startDate: string;            // ISO date - used to calc cycle
  onlyWhenRented?: boolean;     // for meeting room etc.
  isRentedToday?: boolean;
}

// ─── Deep Cleaning Config ─────────────────────────────────────────────────

export interface DeepCleanConfig {
  frequencyDays: number;          // how often each room needs deep cleaning (default 90)
  minutesPerRoom: number;         // time for one deep clean (default 60)
  targetPerWeek: number;          // ideal rooms to deep clean per week (default 5)
}

// ─── Deep Clean Room Record ───────────────────────────────────────────────

export interface DeepCleanRecord {
  id: string;                     // same as room number for easy lookup
  roomNumber: string;
  lastDeepClean: string;          // ISO date YYYY-MM-DD
  cleanedBy?: string;             // staff name (legacy single)
  cleanedByTeam?: string[];       // staff names (multi-staff)
  notes?: string;
  status?: 'in_progress' | 'completed'; // in-progress or done
  assignedAt?: string;            // ISO date when team was assigned
  completedAt?: string;           // ISO date when marked done
}

// ─── Laundry Config ────────────────────────────────────────────────────────

export interface LaundryCategory {
  id: string;
  name: string;
  unitsPerCheckout: number;
  twoBedMultiplier: number;
  stayoverFactor: number;
  roomEquivsPerLoad: number;
  minutesPerLoad: number;
}

// ─── Room ──────────────────────────────────────────────────────────────────

export type RoomStatus = 'dirty' | 'in_progress' | 'clean' | 'inspected';
export type RoomType = 'checkout' | 'stayover' | 'vacant';
export type RoomPriority = 'standard' | 'vip' | 'early';

export interface Room {
  id: string;
  number: string;
  type: RoomType;
  priority: RoomPriority;
  status: RoomStatus;
  assignedTo?: string;          // staffId
  assignedName?: string;
  startedAt?: Date | null;
  completedAt?: Date | null;
  date: string;                 // YYYY-MM-DD
  propertyId: string;
  issueNote?: string;           // reported by housekeeper via mobile view
  inspectedBy?: string;         // name of supervisor who signed off
  inspectedAt?: Date | null;    // timestamp of inspection sign-off
  isDnd?: boolean;              // Do Not Disturb flag
  dndNote?: string;             // optional DND note
  arrival?: string;             // guest arrival date "M/D/YY" (from CSV pull)
  stayoverDay?: number;         // 0 = arrival day, 1 = light, 2 = full, 3 = light, … (null if checkout/vacant)
  stayoverMinutes?: number;     // classified cleaning time (0/15/20) — written by CSV scraper
  helpRequested?: boolean;      // housekeeper tapped "Need Help" — shows SOS badge on Maria's view
  checklist?: Record<string, boolean>; // cleaning checklist item completion
  photoUrl?: string;            // issue photo URL
}

// ─── Inventory / Supply Tracking ───────────────────────────────────────────

export type InventoryCategory = 'housekeeping' | 'maintenance' | 'breakfast';

export interface InventoryItem {
  id: string;
  propertyId: string;
  name: string;
  category: InventoryCategory;
  currentStock: number;
  parLevel: number;             // minimum desired stock
  reorderAt?: number;           // stock threshold that triggers a reorder notification
  unit: string;                 // "sets", "units", "bottles", etc.
  notes?: string;
  updatedAt: Date | null;
  // Usage prediction fields
  usagePerCheckout?: number;    // how many of this item used per checkout room
  usagePerStayover?: number;    // how many used per stayover room
  reorderLeadDays?: number;     // days before empty to trigger reorder (default 3)
  vendorName?: string;          // supplier name
  lastOrderedAt?: Date | null;  // when last ordered
}

// ─── Inspections ──────────────────────────────────────────────────────────

export interface Inspection {
  id: string;
  propertyId: string;
  name: string;                   // e.g. "Fire Extinguisher Inspection"
  dueMonth: string;               // "YYYY-MM" — month the inspection is due
  frequencyMonths: number;        // legacy: months between inspections (kept for backward compat)
  frequencyDays?: number;         // canonical: days between inspections (preferred when set, supports weekly/biweekly)
  lastInspectedDate?: string;     // ISO date YYYY-MM-DD of last completed inspection
  notes?: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// ─── Landscaping Tasks ────────────────────────────────────────────────────

export type LandscapingSeason = 'year-round' | 'spring' | 'summer' | 'fall' | 'winter';

export interface LandscapingTask {
  id: string;
  propertyId: string;
  name: string;                    // e.g. "Grass Mowing", "Shrub Trimming"
  season: LandscapingSeason;       // when this task applies
  frequencyDays: number;           // how often it recurs (e.g. 7, 10, 14, 90)
  lastCompletedAt: Date | null;    // null = never done
  lastCompletedBy?: string;        // name of who did it
  notes?: string;
  createdAt: Date | null;
}

// ─── Shift Handoff Log ─────────────────────────────────────────────────────

export interface HandoffEntry {
  id: string;
  propertyId: string;
  shiftType: 'morning' | 'afternoon' | 'night';
  author: string;               // name of person writing
  notes: string;                // the handoff notes
  acknowledged: boolean;
  acknowledgedBy?: string;
  createdAt: Date | null;
  acknowledgedAt?: Date | null;
}

// ─── Guest Requests ────────────────────────────────────────────────────────

export type GuestRequestStatus = 'pending' | 'in_progress' | 'done';
export type GuestRequestType = 'towels' | 'pillows' | 'blanket' | 'iron' | 'crib' | 'toothbrush' | 'amenities' | 'maintenance' | 'other';

export interface GuestRequest {
  id: string;
  propertyId: string;
  roomNumber: string;
  type: GuestRequestType;
  notes?: string;
  status: GuestRequestStatus;
  assignedTo?: string;
  assignedName?: string;
  createdAt: Date | null;
  completedAt?: Date | null;
}

// ─── Daily Log ─────────────────────────────────────────────────────────────

export interface LaundryLoads {
  towels: number;
  sheets: number;
  comforters: number;
}

export interface DailyLog {
  date: string;                 // YYYY-MM-DD
  hotelId?: string;             // propertyId (denormalized for convenience)
  occupied: number;
  checkouts: number;
  twoBedCheckouts: number;
  stayovers: number;
  vips: number;
  earlyCheckins: number;
  roomMinutes: number;
  publicAreaMinutes: number;
  laundryMinutes: number;
  totalMinutes: number;
  recommendedStaff: number;
  actualStaff: number;
  hourlyWage?: number;          // wage used for this day's calculations
  laborCost: number;
  laborSaved: number;
  startTime: string;
  completionTime: string;
  publicAreasDueToday: string[];
  laundryLoads: LaundryLoads;
  roomsCompleted?: number;      // rooms marked clean by end of day
  avgTurnaroundMinutes?: number; // average room turnaround time
}

// ─── Schedule Calculation Result ───────────────────────────────────────────

export interface ScheduleResult {
  roomMinutes: number;
  publicAreaMinutes: number;
  laundryMinutes: number;
  totalMinutes: number;
  recommendedStaff: number;
  estimatedCompletionTime: string;
  estimatedLaborCost: number;
  laborSaved: number;
  publicAreasDueToday: PublicArea[];
  laundryBreakdown: {
    category: string;
    units: number;
    loads: number;
    minutes: number;
  }[];
}

// ─── Analytics ─────────────────────────────────────────────────────────────

export interface WeeklySummary {
  laborSaved: number;
  avgStaff: number;
  avgCompletionTime: string;
  totalRoomsCleaned: number;
  daysTracked: number;
}

export interface MonthlySummary {
  laborSaved: number;
  laborCost: number;
  roomsCleaned: number;
  avgStaff: number;
}

// ─── PMS Sync Log ──────────────────────────────────────────────────────────

export interface PMSSyncLog {
  id: string;
  timestamp: Date;
  success: boolean;
  pmsType: string;
  dataSnapshot?: Partial<DailyLog>;
  error?: string;
  changedFields?: string[];
}

// ─── Maintenance Work Orders ────────────────────────────────────────────────

export type WorkOrderStatus = 'submitted' | 'assigned' | 'in_progress' | 'resolved';
export type WorkOrderSeverity = 'low' | 'medium' | 'urgent';
export type WorkOrderSource = 'manual' | 'housekeeper' | 'ca_ooo';

export interface WorkOrder {
  id: string;
  propertyId: string;
  roomNumber: string;
  description: string;
  severity: WorkOrderSeverity;
  status: WorkOrderStatus;
  submittedBy?: string;       // staffId or free-text name
  submittedByName?: string;
  assignedTo?: string;        // staffId
  assignedName?: string;
  photoUrl?: string;          // optional photo attachment
  notes?: string;             // manager notes
  blockedRoom?: boolean;      // true = room is blocked from being rented due to maintenance
  source?: WorkOrderSource;   // 'ca_ooo' = auto-synced from Choice Advantage Out-of-Order list
  caWorkOrderNumber?: string; // CA's stable work order number, used to dedup ca_ooo docs
  caFromDate?: string;        // CA's "fromDate" string (e.g. "4/20/2026") for context
  caToDate?: string;          // CA's "toDate" string
  createdAt: Date | null;
  updatedAt: Date | null;
  resolvedAt?: Date | null;
}

// ─── Preventive Maintenance ────────────────────────────────────────────────

export interface PreventiveTask {
  id: string;
  propertyId: string;
  name: string;
  frequencyDays: number;        // how often it recurs
  lastCompletedAt: Date | null; // null = never done
  lastCompletedBy?: string;     // name of who did it
  notes?: string;
  createdAt: Date | null;
}

// ─── Shift Confirmation ────────────────────────────────────────────────────

// 'sent'      → link SMS went out. Normal resting state (Maria confirms
//                availability in person at 3pm, so no reply is expected).
// 'confirmed' → legacy from the old yes/no flow. New code doesn't write it.
// 'declined'  → legacy from the old yes/no flow. New code doesn't write it.
// 'pending'   → legacy from the old yes/no flow. Treated the same as 'sent'.
export type ConfirmationStatus = 'sent' | 'pending' | 'confirmed' | 'declined';

export interface ShiftConfirmation {
  id: string;               // token - also the Firestore doc ID
  uid: string;
  pid: string;
  staffId: string;
  staffName: string;
  staffPhone: string;
  shiftDate: string;        // YYYY-MM-DD
  status: ConfirmationStatus;
  language: 'en' | 'es';
  sentAt: Date | null;
  respondedAt: Date | null;
  smsSent: boolean;
  smsError?: string;
}

export type NotificationType = 'decline' | 'no_response' | 'all_confirmed' | 'replacement_found' | 'no_replacement';

export interface ManagerNotification {
  id: string;
  uid: string;
  pid: string;
  type: NotificationType;
  message: string;
  staffName?: string;
  replacementName?: string;
  shiftDate: string;
  read: boolean;
  createdAt: Date | null;
}

// ─── User ──────────────────────────────────────────────────────────────────

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  createdAt: Date;
  activePropertyId?: string;
}

// ─── Morning Setup Form ────────────────────────────────────────────────────

export interface MorningSetupForm {
  occupied: number;
  checkouts: number;
  twoBedCheckouts: number;
  stayovers: number;
  vips: number;
  earlyCheckins: number;
  startTime: string;
  scheduledStaff: number;
  hourlyWage?: number;          // override property default for today
  // Dashboard enrichment fields
  arrivals?: number;            // expected check-ins today
  reservations?: number;        // total reservations (including future)
  inHouse?: number;             // guests currently in-house
  adr?: number;                 // Average Daily Rate ($)
}
