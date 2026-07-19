// ─── Property & Settings ───────────────────────────────────────────────────

import type { OnboardingState } from '@/lib/onboarding/state';
import type { EnabledSections } from '@/lib/sections/registry';

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
  /**
   * Onboarding tracking (M1.5 wizard). `onboardingCompletedAt` is set only
   * when the 8-step wizard finishes; `onboardingState` carries the in-progress
   * step markers. The login funnel (Home, property-selector, dashboard) reads these
   * via `isOnboardingInProgress` to keep a mid-onboarding owner inside the
   * wizard instead of dropping them into an empty app. Legacy / imported
   * hotels have BOTH null → treated as fully live (never gated).
   */
  onboardingCompletedAt?: string | null;
  onboardingState?: OnboardingState | null;
  /**
   * Set the first time the setup wizard is auto-opened for this hotel (the
   * resume route stamps it). Once set, the login funnel never re-opens the
   * wizard — later logins land in the app. Drives `shouldResumeOnboarding`.
   */
  onboardingPromptShownAt?: string | null;
  /**
   * Demo/showcase property (properties.is_test). Real hotels see an honest
   * "learning from your PMS" dashboard until real occupancy/revenue exists;
   * only a demo property shows the full synthetic chart/KPI showcase.
   */
  isTest?: boolean;
  /**
   * Per-hotel section on/off map (properties.enabled_sections). Undefined / null
   * / a missing key ⇒ that section is ON (default) — so existing hotels with no
   * stored value show all 8 sections. Only an explicit `false` disables a
   * section for EVERYONE at the hotel. Resolved through isSectionEnabled() in
   * @/lib/sections/registry.
   */
  enabledSections?: EnabledSections;
  /**
   * How this hotel budgets inventory (properties.inventory_budget_mode):
   * 'total' = one whole-inventory number per month; 'sections' (default) =
   * per-category rows plus custom section:<uuid> rows. Set from the
   * inventory Budgets panel.
   */
  inventoryBudgetMode?: InventoryBudgetMode;
  /**
   * How this hotel arranges its inventory filter tabs
   * (properties.inventory_tab_layout, migration 0308). `order` is the display
   * order of tab keys ('general' | 'breakfast' | 'custom:<uuid>'); 'all' is
   * always pinned first and never listed. `hidden` is the set of built-in tabs
   * the hotel removed. Undefined / null (every existing hotel) = the default
   * layout (All, General, Breakfast, then customs) with nothing hidden.
   */
  inventoryTabLayout?: InventoryTabLayout | null;
  createdAt: Date;
}

export type InventoryBudgetMode = 'total' | 'sections';

export interface InventoryTabLayout {
  /** Display order of tab keys: 'general' | 'breakfast' | `custom:${uuid}`. */
  order: string[];
  /** Built-in tab keys the hotel has removed: subset of 'general' | 'breakfast'. */
  hidden: string[];
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
  issueNote?: string | null;    // reported by housekeeper via mobile view (null clears)
  inspectedBy?: string | null;  // name of supervisor who signed off
  inspectedAt?: Date | null;    // timestamp of inspection sign-off
  isDnd?: boolean;              // Do Not Disturb flag
  dndNote?: string | null;      // optional DND note (null clears)
  arrival?: string;             // guest arrival date "M/D/YY" (from CSV pull)
  stayoverDay?: number;         // 0 = arrival day, 1 = light, 2 = full, 3 = light, … (null if checkout/vacant)
  stayoverMinutes?: number;     // classified cleaning time (0/15/20) — written by CSV scraper
  helpRequested?: boolean;      // housekeeper tapped "Need Help" — shows SOS badge on Maria's view
  checklist?: Record<string, boolean>; // legacy unused jsonb (kept for back-compat)
  photoUrl?: string;            // issue photo URL
  // Workflow rebuild piece A (migration 0214). Tap-Start → tap-Pause →
  // tap-Resume → tap-Done with five exception types and per-cleaning-type
  // checklists. New code reads/writes these; legacy is_dnd is mirrored
  // when exception_type === 'dnd' so older readers still see DND.
  isPaused?: boolean;
  pausedAt?: Date | null;
  totalPausedSeconds?: number;
  exceptionType?: 'dnd' | 'nsr' | 'dla' | 'sleep_out' | 'skipped' | null;
  exceptionNote?: string | null;
  exceptionAt?: Date | null;
  floor?: string;
  checklistTemplateId?: string | null;
  checklistProgress?: string[]; // array of completed checklist item IDs
  managerNotes?: string | null; // display-side; mirrored from manager_room_notes by piece B
  housekeeperNote?: string | null; // quick note the housekeeper attached
  componentParentNumber?: string | null; // if non-null, this room is a sub-room of a multi-room suite
  isRush?: boolean;
  rushDueBy?: Date | null;
  markedForInspectionAt?: Date | null;
  // feat/cua-partial-promotion — which signal produced `status`:
  //   'assignment' — today's HK plan row (app/CUA workflow state)
  //   'pms'        — a real pms_room_status_log value
  //   'default'    — NO signal at all; the merge's conservative 'dirty'.
  // When the property's roomStatus feed is still learning, UI surfaces
  // render 'default' rooms as a neutral "—" instead of dirty — otherwise a
  // missing feed reads as a confident "84 rooms to clean" board.
  statusSource?: 'assignment' | 'pms' | 'default';
}

// ─── Housekeeper job-card context (joined from pms_reservations) ───────────

export interface RoomReservationContext {
  roomNumber: string;
  guestName?: string;
  arrivalDate?: string;
  arrivalTime?: string;
  numNights?: number;
  isVip?: boolean;       // inferred from special_requests / package_name
  specialRequests?: string;
}

// ─── Inventory / Supply Tracking ───────────────────────────────────────────

export type InventoryCategory = 'housekeeping' | 'maintenance' | 'breakfast';

export interface InventoryItem {
  id: string;
  propertyId: string;
  /** Immutable provenance recorded by Postgres for new rows. Legacy rows may
   * be null because inventory predates item-level authorship tracking. */
  createdAt?: Date | null;
  createdBy?: string | null;
  /** Soft-archive provenance. Archived items stay in the database so their
   * count, delivery, discard, and purchase-order history remains intact. */
  archivedAt?: Date | null;
  archivedBy?: string | null;
  name: string;
  category: InventoryCategory;
  /**
   * Optional hotel-defined custom category (migration 0307). NULL/undefined
   * (every legacy item) = the item lives in its built-in `category`'s
   * General/Breakfast bucket, unchanged. Set → the item shows only under its
   * custom tab. The built-in `category` still drives its icon/color.
   */
  customCategoryId?: string | null;
  currentStock: number;
  /**
   * Units of currentStock that can't be used right now (stained linens,
   * awaiting repair) but are still owned — counted in inventory VALUE,
   * excluded from usable stock (0321). usable = currentStock − setAside,
   * clamped at 0 in the display layer.
   */
  setAside?: number;
  parLevel: number;             // minimum desired stock
  reorderAt?: number;           // stock threshold that triggers a reorder notification
  unit: string;                 // "sets", "units", "bottles", etc.
  notes?: string;
  updatedAt: Date | null;
  // Usage prediction fields
  usagePerCheckout?: number;    // how many of this item used per checkout room
  usagePerStayover?: number;    // how many used per stayover room
  reorderLeadDays?: number;     // days before empty to trigger reorder (default 3)
  vendorName?: string;          // supplier name (free-text; fallback when no vendorId)
  vendorId?: string | null;     // FK to a real vendors row (migration 0246); vendorName stays as fallback
  lastOrderedAt?: Date | null;  // when last ordered
  unitCost?: number;            // dollars per unit (drives Total Inventory Value + variance $)
  lastAlertedAt?: Date | null;  // when this item last triggered a critical SMS alert (24h dedupe)
  lastCountedAt?: Date | null;  // when current_stock was last manually changed (only bumps on count, NOT on metadata edits)
  /**
   * Immutable provenance for stock that was already on the shelf when a new
   * catalog item was discovered. This is opening inventory, never a delivery
   * or purchase. Postgres freezes these fields and writes an audit event.
   */
  openingAdjustmentQuantity?: number | null;
  openingAdjustmentUnitCost?: number | null;
  openingAdjustmentAt?: Date | null;
  openingAdjustmentRequestId?: string | null;
  // Pack-size (cases ↔ units): null = sold individually
  packSize?: number;            // units per case/box
  caseUnit?: string;            // display label ("case", "box", "dozen") — purely cosmetic
}

// One row per item per Count Mode save. Powers reconciliation history and shrinkage trends.
export interface InventoryCount {
  id: string;
  propertyId: string;
  /** Shared request UUID for every row written by one atomic Count Mode save. */
  countSessionId?: string;
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

export type InventoryBudgetBasis = 'purchases' | 'usage';

// One row per (property, budget key, month, basis). Legacy rows budget the
// purchase ledger; new Inventory budgets cap closed monthly usage. Keeping the
// basis durable prevents a purchase cap from silently becoming a usage cap.
export interface InventoryBudget {
  propertyId: string;
  /**
   * Budget key: one of the three InventoryCategory values, 'total' (the
   * whole-inventory cap when the hotel budgets one number), or
   * 'section:<uuid>' pointing at inventory_budget_sections (custom hotel
   * sections). Migration 0306.
   */
  category: string;
  basis: InventoryBudgetBasis;
  monthStart: Date | null;       // first day of the budget month (always normalised to UTC midnight)
  budgetCents: number;
  notes?: string;
  updatedAt: Date | null;
}

// A hotel-defined budget section ("Pool supplies"): a name plus the inventory
// item ids whose usage is attributed to it at month close. Budget dollars live
// in inventory_budgets keyed 'section:<id>' with basis='usage'.
export interface InventoryBudgetSection {
  id: string;
  propertyId: string;
  name: string;
  itemIds: string[];
  sort: number;
}

// A hotel-defined custom inventory category shown as a filter tab (e.g.
// "Liquor", "Petty cash"). Items point at one via inventory.custom_category_id.
// Migration 0307.
export interface InventoryCustomCategory {
  id: string;
  propertyId: string;
  name: string;
  sort: number;
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

// ─── Maintenance Work Orders ────────────────────────────────────────────────
// New shape (Claude Design handoff, migration 0131): the tab is now a
// physical-book replacement. Two statuses only — open and done — and a
// free-text location instead of a structured room number. The DB still
// uses the legacy CHECK constraints; the mapper coerces:
//   open  ↔ DB status 'submitted'
//   done  ↔ DB status 'resolved'
//   priority 'normal' ↔ DB severity 'medium'   (urgent/low are identity)

export type WorkOrderStatus = 'open' | 'done';
export type WorkOrderPriority = 'urgent' | 'normal' | 'low';

export interface WorkOrder {
  id: string;
  propertyId: string;
  location: string;             // free-text — "Room 312", "Lobby", "Hall 2F"
  description: string;          // "AC blowing warm. Filter looked dirty."
  priority: WorkOrderPriority;
  status: WorkOrderStatus;

  submittedByName?: string;     // display name auto-filled from the logged-in user
  submitterRole?: string;       // free-text role label — "Front desk", "Head housekeeper"
  submitterPhotoPath?: string;  // Storage path in maintenance-photos bucket

  completedByName?: string;     // who clicked Mark Done
  completionNote?: string;      // optional free-text — "Replaced filter, unit is old"
  completionPhotoPath?: string;
  completedAt: Date | null;     // null until status === 'done'

  equipmentId?: string | null;  // optional link to an equipment asset (registry 0249)
  repairCost?: number | null;   // optional $ spent resolving — summed per-asset (0249)

  // "Call in a professional" lane (migration 0262). needsPro routes the card to
  // the Professional column regardless of priority; the pro* fields record the
  // contractor that was called (all optional).
  needsPro?: boolean;
  proTrade?: string | null;     // "Plumbing", "Electrical", "HVAC", …
  proCompany?: string | null;   // who was called
  proPhone?: string | null;
  proCalledAt?: Date | null;

  createdAt: Date | null;
  updatedAt: Date | null;
}

// ─── Preventive Maintenance ────────────────────────────────────────────────

export interface PreventiveTask {
  id: string;
  propertyId: string;
  name: string;                 // "Elevator inspection", "HVAC filter swap"
  area?: string;                // "Floor 2", "Building", "Pool"
  frequencyDays: number;        // how often it recurs
  lastCompletedAt: Date | null; // null = never done
  lastCompletedBy?: string;     // display name of who completed it last
  notes?: string;
  completionPhotoPath?: string;
  equipmentId?: string | null;  // optional link to an equipment asset (registry 0249)
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

// ─── Staff Schedule Domain ─────────────────────────────────────────────────
// Backed by migration 0147. The new /staff manager week grid + staff My
// Shifts view both consume these models.

/** Named shift template — manager-defined per property + department. */
export interface ShiftPreset {
  id: string;
  propertyId: string;
  name: string;
  department: StaffDepartment;
  startTime: string;            // 'HH:MM' (24h)
  endTime: string;              // 'HH:MM' (24h)
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ScheduledShiftKind = 'shift' | 'open';
export type ScheduledShiftStatus = 'draft' | 'published' | 'sent' | 'confirmed' | 'declined';

/** One assigned or open cell on the week grid. */
export interface ScheduledShift {
  id: string;
  propertyId: string;
  staffId: string | null;       // null when kind='open' and not yet picked up
  department: StaffDepartment;
  shiftDate: string;            // YYYY-MM-DD
  startTime: string;            // 'HH:MM' (24h)
  endTime: string;              // 'HH:MM' (24h)
  kind: ScheduledShiftKind;
  status: ScheduledShiftStatus;
  presetId: string | null;
  reason: string | null;        // why this is open (e.g. "Brenda declined")
  note: string | null;          // free-form manager note
  filledByHistory: string[];    // prior staff_id(s) before bail
  createdAt: Date;
  updatedAt: Date;
}

export type TimeOffStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

/** Staff-submitted time-off request, manager-decided in-app. */
export interface TimeOffRequest {
  id: string;
  propertyId: string;
  staffId: string;
  requestDate: string;          // YYYY-MM-DD
  reason: string | null;
  status: TimeOffStatus;
  submittedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;     // accounts.id
  denyReason: string | null;
}

/** A single "this week is published" stamp. Latest row per (property, week) wins. */
export interface WeekPublication {
  id: string;
  propertyId: string;
  weekStart: string;            // YYYY-MM-DD (Monday)
  publishedAt: Date;
  publishedBy: string | null;   // accounts.id
}
