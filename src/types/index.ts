// ─── Property & Settings ───────────────────────────────────────────────────

export interface Property {
  id: string;
  name: string;
  totalRooms: number;
  avgOccupancy: number;
  hourlyWage: number;
  checkoutMinutes: number;      // default 30
  stayoverMinutes: number;      // default 20
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
  cleanedBy?: string;             // staff name
  notes?: string;
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
  checklist?: Record<string, boolean>; // cleaning checklist item completion
  photoUrl?: string;            // issue photo URL
}

// ─── Inventory / Supply Tracking ───────────────────────────────────────────

export type InventoryCategory = 'linens' | 'towels' | 'amenities' | 'cleaning' | 'maintenance' | 'other';

export interface InventoryItem {
  id: string;
  propertyId: string;
  name: string;
  category: InventoryCategory;
  currentStock: number;
  parLevel: number;             // minimum desired stock
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

export type ConfirmationStatus = 'pending' | 'confirmed' | 'declined' | 'no_response';

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
}
