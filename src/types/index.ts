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
  /**
   * IANA timezone name ("America/Chicago", "America/New_York", …). Set at
   * onboarding (M1.5 wizard Step 4). Used client-side to compute "today"
   * and "tomorrow" in the property's local time — without this, queries
   * for daily windows can roll past midnight in the wrong place. The DB
   * column exists since migration 0046 (Phase G). Phase M3.1 added it
   * to this type so ScheduleTab's ML confidence panel can pass it
   * through to getActiveOptimizerForTomorrow().
   */
  timezone?: string | null;
  alertPhone?: string;          // E.164 phone for inventory critical SMS alerts; falls back to MANAGER_PHONE env var
  /**
   * Master list of every room number in the hotel ("101", "102", "205", …).
   * Populated once at onboarding by the CUA worker (migration 0025), maintained
   * by the property settings UI. The Housekeeping Rooms tab uses this as the
   * canonical "what rooms exist" source so the board always renders all N
   * rooms regardless of what Choice Advantage's daily CSV happens to include.
   * Empty / undefined for properties that haven't been onboarded yet — callers
   * should treat that as "fall back to whatever the rooms table contains."
   */
  roomInventory?: string[];
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
  fcmToken?: string;            // FCM device token for push notifications (legacy — FCM was retired 2026-04-22)
  schedulePriority?: SchedulePriority; // 'priority' = auto-selected first, 'normal' = backup, 'excluded' = never auto-selected
  isSchedulingManager?: boolean; // single person who receives shift-confirmation escalation texts. Only one per property.
  lastPairedAt?: Date | null;   // set by /api/save-fcm-token when the staff member opens their housekeeper/laundry magic link. Manager uses it to spot housekeepers who never opened their device.
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
  unitCost?: number;            // dollars per unit (drives Total Inventory Value + variance $)
  lastAlertedAt?: Date | null;  // when this item last triggered a critical SMS alert (24h dedupe)
  lastCountedAt?: Date | null;  // when current_stock was last manually changed (only bumps on count, NOT on metadata edits)
  // Pack-size (cases ↔ units): null = sold individually
  packSize?: number;            // units per case/box
  caseUnit?: string;            // display label ("case", "box", "dozen") — purely cosmetic
}

// One row per item per Count Mode save. Powers reconciliation history and shrinkage trends.
export interface InventoryCount {
  id: string;
  propertyId: string;
  itemId: string;
  itemName: string;             // snapshotted (survives item deletion)
  countedStock: number;
  estimatedStock?: number;      // null when no usage rates were configured
  variance?: number;            // counted - estimated
  varianceValue?: number;       // variance * unitCost
  unitCost?: number;
  countedAt: Date | null;
  countedBy?: string;
  notes?: string;
}

// One row per restock event. Logged when stock goes up after a count, or via manual entry.
export interface InventoryOrder {
  id: string;
  propertyId: string;
  itemId: string;
  itemName: string;
  quantity: number;             // resolved units (cases * pack_size when received in case form)
  quantityCases?: number;       // case count when received in case form (null = received as units)
  unitCost?: number;
  totalCost?: number;           // quantity * unitCost
  vendorName?: string;
  orderedAt?: Date | null;
  receivedAt: Date | null;
  notes?: string;
}

// One row per discard event (stained linen, damaged goods, theft, lost). Tracked
// separately from normal consumption so shrinkage shows up in $-terms and we can
// flag anomalies (e.g. "you replaced 152 last month, only 18 this month").
export type InventoryDiscardReason = 'stained' | 'damaged' | 'lost' | 'theft' | 'other';

export interface InventoryDiscard {
  id: string;
  propertyId: string;
  itemId: string;
  itemName: string;             // snapshotted
  quantity: number;
  reason: InventoryDiscardReason;
  costValue?: number;           // quantity * unitCost at discard time
  unitCost?: number;            // snapshotted
  discardedAt: Date | null;
  discardedBy?: string;
  notes?: string;
}

// One row per reconciliation event. The user enters a physical count, the system
// snapshots its estimate, and we compute unaccounted variance in $-terms. This
// is the trust layer the regional director asked for.
export interface InventoryReconciliation {
  id: string;
  propertyId: string;
  itemId: string;
  itemName: string;
  reconciledAt: Date | null;
  physicalCount: number;
  systemEstimate: number;
  discardsSinceLast: number;
  unaccountedVariance: number;          // physical - (estimate - discardsSinceLast); negative = unexplained loss
  unaccountedVarianceValue?: number;    // variance * unitCost
  unitCost?: number;
  reconciledBy?: string;
  notes?: string;
}

// One row per (property, category, month). Drives the budget headroom badge
// on the Smart Reorder List and the Budget vs Actual block in the accounting view.
export interface InventoryBudget {
  propertyId: string;
  category: InventoryCategory;
  monthStart: Date | null;       // first day of the budget month (always normalised to UTC midnight)
  budgetCents: number;
  notes?: string;
  updatedAt: Date | null;
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
  // ── Asset linkage + cost (added 2026-05-08, migration 0030) ─────────────
  equipmentId?: string;       // optional link to the equipment asset that broke
  repairCost?: number;        // dollars spent fixing this issue
  partsUsed?: string[];       // free-text list of parts/supplies consumed
  // ── Vendor (added 2026-05-09, migration 0043) ───────────────────────────
  vendorId?: string;          // optional link to the vendor who performed the repair
  createdAt: Date | null;
  updatedAt: Date | null;
  resolvedAt?: Date | null;
}

// ─── Equipment / Asset Registry ────────────────────────────────────────────

export type EquipmentCategory =
  | 'hvac' | 'plumbing' | 'electrical' | 'appliance' | 'structural'
  | 'elevator' | 'pool' | 'laundry' | 'kitchen' | 'other';

export type EquipmentStatus =
  | 'operational' | 'degraded' | 'failed' | 'replaced' | 'decommissioned';

export interface Equipment {
  id: string;
  propertyId: string;
  name: string;
  category: EquipmentCategory;
  location?: string;
  modelNumber?: string;
  manufacturer?: string;
  installDate?: Date | null;
  expectedLifetimeYears?: number;
  purchaseCost?: number;
  replacementCost?: number;
  status: EquipmentStatus;
  pmIntervalDays?: number;
  lastPmAt?: Date | null;
  notes?: string;
  // ── Vendor + warranty (added 2026-05-09, migration 0043) ────────────────
  vendorId?: string;             // optional link to vendor who installs/services this asset
  warrantyEndDate?: Date | null; // manufacturer/installer warranty end (null = none tracked)
  createdAt: Date;
  updatedAt: Date;
}

// ─── Vendors ───────────────────────────────────────────────────────────────

export type VendorCategory =
  | 'hvac' | 'plumbing' | 'electrical' | 'appliance' | 'pool'
  | 'landscaping' | 'pest' | 'fire' | 'elevator' | 'laundry'
  | 'kitchen' | 'structural' | 'other';

export interface Vendor {
  id: string;
  propertyId: string;
  name: string;
  category: VendorCategory;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Service Contracts ─────────────────────────────────────────────────────

export type ServiceContractCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

export interface ServiceContract {
  id: string;
  propertyId: string;
  vendorId?: string;             // who performs the service (optional)
  name: string;                  // e.g. "Pool service - Bayou Pools"
  category: VendorCategory;      // shares the vendor category vocabulary
  cadence: ServiceContractCadence;
  lastServicedAt?: Date | null;  // YYYY-MM-DD anchored
  nextDueAt?: Date | null;       // computed from last+cadence on insert; user can override
  monthlyCost?: number;          // dollars per month (annualized for non-monthly cadences when summed)
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
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
  equipmentId?: string;         // optional link to the equipment asset (added migration 0030)
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
