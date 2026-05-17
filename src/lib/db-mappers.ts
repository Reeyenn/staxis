// ═══════════════════════════════════════════════════════════════════════════
// Row mappers — Postgres rows ↔ app domain types.
//
// Lifted out of db.ts on 2026-04-27 because db.ts had grown to 1800+ lines
// and ~60% of that was straight-line column-mapping boilerplate. Carving
// these out leaves db.ts focused on the data flow (queries, subscriptions,
// retries) and lets the mappers live in one place where new fields can be
// added without re-reading the rest of the data layer.
//
// Naming convention:
//   • toXxxRow(domain)  — domain object → Postgres column-shaped object.
//                          Uses dropUndefined so partial updates don't
//                          overwrite columns the caller didn't touch.
//   • fromXxxRow(row)   — Postgres row → domain object. Hard-codes column
//                          names + provides safe defaults so an unexpected
//                          NULL never explodes a render.
//
// All mappers are pure synchronous functions. They don't talk to Supabase,
// don't log, don't throw — feed them garbage, get a domain object with
// safe defaults. That makes them trivially unit-testable and keeps the
// data layer's failure surface narrow.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  Property,
  StaffMember,
  PublicArea,
  LaundryCategory,
  Room,
  DailyLog,
  WorkOrder,
  WorkOrderPriority,
  WorkOrderStatus,
  PreventiveTask,
  InventoryItem,
  InventoryCount,
  InventoryOrder,
  InventoryDiscard,
  InventoryReconciliation,
  InventoryBudget,
  HandoffEntry,
  GuestRequest,
  ShiftConfirmation,
  ManagerNotification,
  DeepCleanRecord,
} from '@/types';

// ─── tiny utilities ─────────────────────────────────────────────────────────
//
// Shared by every fromXxxRow / toXxxRow. Exported so db.ts and any future
// caller (server-side scripts, smoke tests) can reuse the same coercion.

export const toDate = (v: unknown): Date | null => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
};

export const toISO = (v: unknown): string | null => {
  const d = toDate(v);
  return d ? d.toISOString() : null;
};

export function dropUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ─── Runtime narrowers for unchecked column reads ───────────────────────────
//
// Supabase's row types come back loose (JSONB, text union columns, text[]).
// Each `fromXxxRow` used to cast — `(r.foo as string) ?? undefined` — which
// satisfies TypeScript but silently lies if the column drifts (rename, type
// change). These helpers narrow at runtime so a drift produces `undefined` /
// the fallback instead of a wrong-typed value sneaking into the domain layer.

export function parseStringField(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function parseStringFieldOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

export function parseBoolField(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function parseNumberField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function parseUnionField<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

export function parseOptionalUnionField<T extends string>(
  v: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

export function parseArrayField<T>(
  v: unknown,
  coerce: (x: unknown) => T | undefined,
): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    const y = coerce(x);
    if (y !== undefined) out.push(y);
  }
  return out;
}

export function parseRecordField<V>(
  v: unknown,
  coerceValue: (x: unknown) => V | undefined,
): Record<string, V> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, V> = {};
  for (const [k, x] of Object.entries(v)) {
    const y = coerceValue(x);
    if (y !== undefined) out[k] = y;
  }
  return out;
}

// ─── Union constants ───────────────────────────────────────────────────────
// Paired with the typed unions in src/types/index.ts. Kept here as runtime
// arrays so the parsers can validate at runtime — TS narrowing alone doesn't
// catch a stale DB value.
const ROOM_STATUSES = ['dirty', 'in_progress', 'clean', 'inspected'] as const;
const ROOM_TYPES = ['checkout', 'stayover', 'vacant'] as const;
const ROOM_PRIORITIES = ['standard', 'vip', 'early'] as const;
const LANGUAGES = ['en', 'es'] as const;
const STAFF_DEPARTMENTS = ['housekeeping', 'front_desk', 'maintenance', 'other'] as const;
const SCHEDULE_PRIORITIES = ['priority', 'normal', 'excluded'] as const;
const INVENTORY_CATEGORIES = ['housekeeping', 'maintenance', 'breakfast'] as const;
const INVENTORY_DISCARD_REASONS = ['stained', 'damaged', 'lost', 'theft', 'other'] as const;
const HANDOFF_SHIFT_TYPES = ['morning', 'afternoon', 'night'] as const;
const GUEST_REQUEST_STATUSES = ['pending', 'in_progress', 'done'] as const;
const GUEST_REQUEST_TYPES = ['towels', 'pillows', 'blanket', 'iron', 'crib', 'toothbrush', 'amenities', 'maintenance', 'other'] as const;
const CONFIRMATION_STATUSES = ['sent', 'pending', 'confirmed', 'declined'] as const;
const NOTIFICATION_TYPES = ['decline', 'no_response', 'all_confirmed', 'replacement_found', 'no_replacement'] as const;
const DEEP_CLEAN_STATUSES = ['in_progress', 'completed'] as const;

// ─── Property ───────────────────────────────────────────────────────────────

export function toPropertyRow(p: Partial<Property>): Record<string, unknown> {
  return dropUndefined({
    name: p.name,
    total_rooms: p.totalRooms,
    avg_occupancy: p.avgOccupancy,
    hourly_wage: p.hourlyWage,
    checkout_minutes: p.checkoutMinutes,
    stayover_minutes: p.stayoverMinutes,
    stayover_day1_minutes: p.stayoverDay1Minutes,
    stayover_day2_minutes: p.stayoverDay2Minutes,
    prep_minutes_per_activity: p.prepMinutesPerActivity,
    shift_minutes: p.shiftMinutes,
    total_staff_on_roster: p.totalStaffOnRoster,
    weekly_budget: p.weeklyBudget,
    morning_briefing_time: p.morningBriefingTime,
    evening_forecast_time: p.eveningForecastTime,
    pms_type: p.pmsType,
    pms_url: p.pmsUrl,
    pms_connected: p.pmsConnected,
    last_synced_at: toISO(p.lastSyncedAt),
    alert_phone: p.alertPhone,
  });
}

export function fromPropertyRow(r: Record<string, unknown>): Property {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    totalRooms: Number(r.total_rooms ?? 0),
    avgOccupancy: Number(r.avg_occupancy ?? 0),
    hourlyWage: Number(r.hourly_wage ?? 15),
    checkoutMinutes: Number(r.checkout_minutes ?? 30),
    stayoverMinutes: Number(r.stayover_minutes ?? 20),
    stayoverDay1Minutes: r.stayover_day1_minutes == null ? undefined : Number(r.stayover_day1_minutes),
    stayoverDay2Minutes: r.stayover_day2_minutes == null ? undefined : Number(r.stayover_day2_minutes),
    prepMinutesPerActivity: Number(r.prep_minutes_per_activity ?? 5),
    shiftMinutes: Number(r.shift_minutes ?? 480),
    totalStaffOnRoster: Number(r.total_staff_on_roster ?? 0),
    weeklyBudget: r.weekly_budget == null ? undefined : Number(r.weekly_budget),
    morningBriefingTime: parseStringField(r.morning_briefing_time),
    eveningForecastTime: parseStringField(r.evening_forecast_time),
    pmsType: parseStringField(r.pms_type),
    pmsUrl: parseStringField(r.pms_url),
    pmsConnected: parseBoolField(r.pms_connected),
    lastSyncedAt: toDate(r.last_synced_at),
    alertPhone: parseStringField(r.alert_phone),
    // room_inventory is a Postgres text[] of every room number in the hotel.
    // Used by the Housekeeping Rooms tab to render all rooms even when the
    // daily CA pull only mentions the dirty/occupied subset. Empty or null
    // for un-onboarded properties — caller falls back to whatever's in the
    // rooms table for that case. We return undefined (not []) for non-array
    // input so callers can distinguish "no inventory configured" from "empty hotel".
    roomInventory: Array.isArray(r.room_inventory)
      ? parseArrayField(r.room_inventory, (x) => x != null ? String(x) : undefined)
      : undefined,
    createdAt: toDate(r.created_at) ?? new Date(),
  };
}

// ─── Staff ──────────────────────────────────────────────────────────────────

export function toStaffRow(s: Partial<StaffMember>): Record<string, unknown> {
  // phone_lookup mirrors the digit-only tail of phone for SMS reverse-lookup.
  // Three cases:
  //   - phone undefined  → caller didn't touch phone, leave phone_lookup alone
  //   - phone is ''      → caller cleared phone, also clear phone_lookup so a
  //                         stale value doesn't keep an old SMS match alive
  //                         after the staff member's number was removed
  //   - phone has digits → recompute phone_lookup from the new digits
  const phoneLookup =
    s.phone === undefined ? undefined :
    s.phone === ''        ? null :
    s.phone.replace(/\D/g, '').slice(-10);
  return dropUndefined({
    name: s.name,
    phone: s.phone,
    phone_lookup: phoneLookup,
    language: s.language,
    is_senior: s.isSenior,
    department: s.department,
    hourly_wage: s.hourlyWage,
    scheduled_today: s.scheduledToday,
    weekly_hours: s.weeklyHours,
    max_weekly_hours: s.maxWeeklyHours,
    max_days_per_week: s.maxDaysPerWeek,
    days_worked_this_week: s.daysWorkedThisWeek,
    vacation_dates: s.vacationDates,
    is_active: s.isActive,
    schedule_priority: s.schedulePriority,
    is_scheduling_manager: s.isSchedulingManager,
  });
}

export function fromStaffRow(r: Record<string, unknown>): StaffMember {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    phone: parseStringField(r.phone),
    language: parseUnionField(r.language, LANGUAGES, 'en'),
    isSenior: Boolean(r.is_senior),
    department: parseOptionalUnionField(r.department, STAFF_DEPARTMENTS),
    hourlyWage: r.hourly_wage == null ? undefined : Number(r.hourly_wage),
    scheduledToday: Boolean(r.scheduled_today),
    weeklyHours: Number(r.weekly_hours ?? 0),
    maxWeeklyHours: Number(r.max_weekly_hours ?? 40),
    maxDaysPerWeek: r.max_days_per_week == null ? undefined : Number(r.max_days_per_week),
    daysWorkedThisWeek: r.days_worked_this_week == null ? undefined : Number(r.days_worked_this_week),
    vacationDates: Array.isArray(r.vacation_dates)
      ? parseArrayField(r.vacation_dates, parseStringField)
      : undefined,
    isActive: r.is_active == null ? undefined : Boolean(r.is_active),
    schedulePriority: parseOptionalUnionField(r.schedule_priority, SCHEDULE_PRIORITIES),
    isSchedulingManager: r.is_scheduling_manager == null ? undefined : Boolean(r.is_scheduling_manager),
    lastPairedAt: toDate(r.last_paired_at),
  };
}

// ─── Room ───────────────────────────────────────────────────────────────────

export function toRoomRow(room: Partial<Room> & { propertyId?: string }): Record<string, unknown> {
  return dropUndefined({
    property_id: room.propertyId,
    number: room.number,
    date: room.date,
    type: room.type,
    priority: room.priority,
    status: room.status,
    assigned_to: room.assignedTo,
    assigned_name: room.assignedName,
    started_at: toISO(room.startedAt),
    completed_at: toISO(room.completedAt),
    issue_note: room.issueNote,
    inspected_by: room.inspectedBy,
    inspected_at: toISO(room.inspectedAt),
    is_dnd: room.isDnd,
    dnd_note: room.dndNote,
    arrival: room.arrival,
    stayover_day: room.stayoverDay,
    stayover_minutes: room.stayoverMinutes,
    help_requested: room.helpRequested,
    checklist: room.checklist,
    photo_url: room.photoUrl,
  });
}

export function fromRoomRow(r: Record<string, unknown>): Room {
  return {
    id: String(r.id),
    number: String(r.number ?? ''),
    type: parseUnionField(r.type, ROOM_TYPES, 'checkout'),
    priority: parseUnionField(r.priority, ROOM_PRIORITIES, 'standard'),
    status: parseUnionField(r.status, ROOM_STATUSES, 'dirty'),
    assignedTo: parseStringField(r.assigned_to),
    assignedName: parseStringField(r.assigned_name),
    startedAt: toDate(r.started_at),
    completedAt: toDate(r.completed_at),
    date: String(r.date ?? ''),
    propertyId: String(r.property_id ?? ''),
    issueNote: parseStringField(r.issue_note),
    inspectedBy: parseStringField(r.inspected_by),
    inspectedAt: toDate(r.inspected_at),
    isDnd: r.is_dnd == null ? undefined : Boolean(r.is_dnd),
    dndNote: parseStringField(r.dnd_note),
    arrival: parseStringField(r.arrival),
    stayoverDay: r.stayover_day == null ? undefined : Number(r.stayover_day),
    stayoverMinutes: r.stayover_minutes == null ? undefined : Number(r.stayover_minutes),
    helpRequested: r.help_requested == null ? undefined : Boolean(r.help_requested),
    checklist: parseRecordField(r.checklist, parseBoolField),
    photoUrl: parseStringField(r.photo_url),
  };
}

// ─── Public area ────────────────────────────────────────────────────────────

export function toPublicAreaRow(a: Partial<PublicArea>): Record<string, unknown> {
  return dropUndefined({
    name: a.name,
    floor: a.floor,
    locations: a.locations,
    frequency_days: a.frequencyDays,
    minutes_per_clean: a.minutesPerClean,
    start_date: a.startDate,
    only_when_rented: a.onlyWhenRented,
    is_rented_today: a.isRentedToday,
  });
}

export function fromPublicAreaRow(r: Record<string, unknown>): PublicArea {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    floor: String(r.floor ?? ''),
    locations: Number(r.locations ?? 1),
    frequencyDays: Number(r.frequency_days ?? 1),
    minutesPerClean: Number(r.minutes_per_clean ?? 0),
    startDate: String(r.start_date ?? ''),
    onlyWhenRented: r.only_when_rented == null ? undefined : Boolean(r.only_when_rented),
    isRentedToday: r.is_rented_today == null ? undefined : Boolean(r.is_rented_today),
  };
}

// ─── Laundry ────────────────────────────────────────────────────────────────

export function toLaundryRow(c: Partial<LaundryCategory>): Record<string, unknown> {
  return dropUndefined({
    name: c.name,
    units_per_checkout: c.unitsPerCheckout,
    two_bed_multiplier: c.twoBedMultiplier,
    stayover_factor: c.stayoverFactor,
    room_equivs_per_load: c.roomEquivsPerLoad,
    minutes_per_load: c.minutesPerLoad,
  });
}

export function fromLaundryRow(r: Record<string, unknown>): LaundryCategory {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    unitsPerCheckout: Number(r.units_per_checkout ?? 0),
    twoBedMultiplier: Number(r.two_bed_multiplier ?? 1),
    stayoverFactor: Number(r.stayover_factor ?? 0),
    roomEquivsPerLoad: Number(r.room_equivs_per_load ?? 1),
    minutesPerLoad: Number(r.minutes_per_load ?? 60),
  };
}

// ─── Daily log ──────────────────────────────────────────────────────────────

export function toDailyLogRow(l: Partial<DailyLog> & { propertyId?: string }): Record<string, unknown> {
  return dropUndefined({
    property_id: l.propertyId,
    date: l.date,
    occupied: l.occupied,
    checkouts: l.checkouts,
    two_bed_checkouts: l.twoBedCheckouts,
    stayovers: l.stayovers,
    vips: l.vips,
    early_checkins: l.earlyCheckins,
    room_minutes: l.roomMinutes,
    public_area_minutes: l.publicAreaMinutes,
    laundry_minutes: l.laundryMinutes,
    total_minutes: l.totalMinutes,
    recommended_staff: l.recommendedStaff,
    actual_staff: l.actualStaff,
    hourly_wage: l.hourlyWage,
    labor_cost: l.laborCost,
    labor_saved: l.laborSaved,
    start_time: l.startTime,
    completion_time: l.completionTime,
    public_areas_due_today: l.publicAreasDueToday,
    laundry_loads: l.laundryLoads,
    rooms_completed: l.roomsCompleted,
    avg_turnaround_minutes: l.avgTurnaroundMinutes,
  });
}

export function fromDailyLogRow(r: Record<string, unknown>): DailyLog {
  // Defensive parse for the JSONB laundry_loads column — accept the shape
  // we wrote, fall back to zeros for anything else.
  const ll = r.laundry_loads;
  const laundryLoads: DailyLog['laundryLoads'] =
    typeof ll === 'object' && ll !== null && !Array.isArray(ll)
      ? {
          towels: parseNumberField((ll as Record<string, unknown>).towels) ?? 0,
          sheets: parseNumberField((ll as Record<string, unknown>).sheets) ?? 0,
          comforters: parseNumberField((ll as Record<string, unknown>).comforters) ?? 0,
        }
      : { towels: 0, sheets: 0, comforters: 0 };
  return {
    date: String(r.date ?? ''),
    hotelId: String(r.property_id ?? ''),
    occupied: Number(r.occupied ?? 0),
    checkouts: Number(r.checkouts ?? 0),
    twoBedCheckouts: Number(r.two_bed_checkouts ?? 0),
    stayovers: Number(r.stayovers ?? 0),
    vips: Number(r.vips ?? 0),
    earlyCheckins: Number(r.early_checkins ?? 0),
    roomMinutes: Number(r.room_minutes ?? 0),
    publicAreaMinutes: Number(r.public_area_minutes ?? 0),
    laundryMinutes: Number(r.laundry_minutes ?? 0),
    totalMinutes: Number(r.total_minutes ?? 0),
    recommendedStaff: Number(r.recommended_staff ?? 0),
    actualStaff: Number(r.actual_staff ?? 0),
    hourlyWage: r.hourly_wage == null ? undefined : Number(r.hourly_wage),
    laborCost: Number(r.labor_cost ?? 0),
    laborSaved: Number(r.labor_saved ?? 0),
    startTime: String(r.start_time ?? ''),
    completionTime: String(r.completion_time ?? ''),
    publicAreasDueToday: parseArrayField(r.public_areas_due_today, parseStringField),
    laundryLoads,
    roomsCompleted: r.rooms_completed == null ? undefined : Number(r.rooms_completed),
    avgTurnaroundMinutes: r.avg_turnaround_minutes == null ? undefined : Number(r.avg_turnaround_minutes),
  };
}

// ─── Work order ─────────────────────────────────────────────────────────────
//
// New shape (migration 0131): the UI exposes only status 'open' | 'done' and
// priority 'urgent' | 'normal' | 'low'. The Postgres CHECK constraints still
// use the legacy 4-value status enum + severity 'low'/'medium'/'urgent', so
// we map at the boundary:
//   open  ↔ 'submitted'   |   done  ↔ 'resolved'
//   urgent/low pass through; 'normal' ↔ 'medium'.

const PRIORITY_TO_SEVERITY: Record<WorkOrderPriority, string> = {
  urgent: 'urgent',
  normal: 'medium',
  low:    'low',
};
const SEVERITY_TO_PRIORITY = (sev: unknown): WorkOrderPriority => {
  if (sev === 'urgent') return 'urgent';
  if (sev === 'low')    return 'low';
  return 'normal'; // 'medium' or anything unexpected coerces to normal
};

const STATUS_TO_DB: Record<WorkOrderStatus, string> = {
  open: 'submitted',
  done: 'resolved',
};
const STATUS_FROM_DB = (s: unknown): WorkOrderStatus =>
  s === 'resolved' ? 'done' : 'open';  // 'submitted'/'assigned'/'in_progress' all read as open

export function toWorkOrderRow(o: Partial<WorkOrder>): Record<string, unknown> {
  return dropUndefined({
    property_id: o.propertyId,
    room_number: o.location,                 // DB column kept; stores free-text location
    description: o.description,
    severity: o.priority === undefined ? undefined : PRIORITY_TO_SEVERITY[o.priority],
    status:   o.status   === undefined ? undefined : STATUS_TO_DB[o.status],
    submitted_by_name: o.submittedByName,
    submitter_role: o.submitterRole,
    submitter_photo_path: o.submitterPhotoPath,
    completed_by_name: o.completedByName,
    completion_note: o.completionNote,
    completion_photo_path: o.completionPhotoPath,
    resolved_at: toISO(o.completedAt),
  });
}

export function fromWorkOrderRow(r: Record<string, unknown>): WorkOrder {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    location: String(r.room_number ?? ''),
    description: String(r.description ?? ''),
    priority: SEVERITY_TO_PRIORITY(r.severity),
    status:   STATUS_FROM_DB(r.status),
    submittedByName: parseStringField(r.submitted_by_name),
    submitterRole: parseStringField(r.submitter_role),
    submitterPhotoPath: parseStringField(r.submitter_photo_path)
      ?? parseStringField(r.photo_url),       // legacy column fallback for pre-0131 rows
    completedByName: parseStringField(r.completed_by_name)
      ?? parseStringField(r.assigned_name),   // legacy fallback
    completionNote: parseStringField(r.completion_note),
    completionPhotoPath: parseStringField(r.completion_photo_path),
    completedAt: toDate(r.resolved_at),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

// ─── Preventive ─────────────────────────────────────────────────────────────

export function fromPreventiveRow(r: Record<string, unknown>): PreventiveTask {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    name: String(r.name ?? ''),
    area: parseStringField(r.area),
    frequencyDays: Number(r.frequency_days ?? 1),
    lastCompletedAt: toDate(r.last_completed_at),
    lastCompletedBy: parseStringField(r.last_completed_by),
    notes: parseStringField(r.notes),
    completionPhotoPath: parseStringField(r.completion_photo_path),
    createdAt: toDate(r.created_at),
  };
}

export function toPreventiveRow(t: Partial<PreventiveTask>): Record<string, unknown> {
  return dropUndefined({
    property_id: t.propertyId,
    name: t.name,
    area: t.area,
    frequency_days: t.frequencyDays,
    last_completed_at: toISO(t.lastCompletedAt),
    last_completed_by: t.lastCompletedBy,
    notes: t.notes,
    completion_photo_path: t.completionPhotoPath,
  });
}

// ─── Inventory ──────────────────────────────────────────────────────────────

export function fromInventoryRow(r: Record<string, unknown>): InventoryItem {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    name: String(r.name ?? ''),
    category: parseUnionField(r.category, INVENTORY_CATEGORIES, 'housekeeping'),
    currentStock: Number(r.current_stock ?? 0),
    parLevel: Number(r.par_level ?? 0),
    reorderAt: r.reorder_at == null ? undefined : Number(r.reorder_at),
    unit: String(r.unit ?? ''),
    notes: parseStringField(r.notes),
    updatedAt: toDate(r.updated_at),
    usagePerCheckout: r.usage_per_checkout == null ? undefined : Number(r.usage_per_checkout),
    usagePerStayover: r.usage_per_stayover == null ? undefined : Number(r.usage_per_stayover),
    reorderLeadDays: r.reorder_lead_days == null ? undefined : Number(r.reorder_lead_days),
    vendorName: parseStringField(r.vendor_name),
    lastOrderedAt: toDate(r.last_ordered_at),
    unitCost: r.unit_cost == null ? undefined : Number(r.unit_cost),
    lastAlertedAt: toDate(r.last_alerted_at),
    lastCountedAt: toDate(r.last_counted_at),
    packSize: r.pack_size == null ? undefined : Number(r.pack_size),
    caseUnit: parseStringField(r.case_unit),
  };
}

export function toInventoryRow(i: Partial<InventoryItem>): Record<string, unknown> {
  return dropUndefined({
    property_id: i.propertyId,
    name: i.name,
    category: i.category,
    current_stock: i.currentStock,
    par_level: i.parLevel,
    reorder_at: i.reorderAt,
    unit: i.unit,
    notes: i.notes,
    usage_per_checkout: i.usagePerCheckout,
    usage_per_stayover: i.usagePerStayover,
    reorder_lead_days: i.reorderLeadDays,
    vendor_name: i.vendorName,
    last_ordered_at: toISO(i.lastOrderedAt),
    unit_cost: i.unitCost,
    last_alerted_at: toISO(i.lastAlertedAt),
    last_counted_at: toISO(i.lastCountedAt),
    pack_size: i.packSize,
    case_unit: i.caseUnit,
  });
}

// ─── Inventory count (audit log of count events) ────────────────────────────

export function fromInventoryCountRow(r: Record<string, unknown>): InventoryCount {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    itemId: String(r.item_id ?? ''),
    itemName: String(r.item_name ?? ''),
    countedStock: Number(r.counted_stock ?? 0),
    estimatedStock: r.estimated_stock == null ? undefined : Number(r.estimated_stock),
    variance: r.variance == null ? undefined : Number(r.variance),
    varianceValue: r.variance_value == null ? undefined : Number(r.variance_value),
    unitCost: r.unit_cost == null ? undefined : Number(r.unit_cost),
    countedAt: toDate(r.counted_at),
    countedBy: parseStringField(r.counted_by),
    notes: parseStringField(r.notes),
  };
}

export function toInventoryCountRow(c: Partial<InventoryCount>): Record<string, unknown> {
  return dropUndefined({
    property_id: c.propertyId,
    item_id: c.itemId,
    item_name: c.itemName,
    counted_stock: c.countedStock,
    estimated_stock: c.estimatedStock,
    variance: c.variance,
    variance_value: c.varianceValue,
    unit_cost: c.unitCost,
    counted_by: c.countedBy,
    notes: c.notes,
  });
}

// ─── Inventory order (audit log of restocks) ────────────────────────────────

export function fromInventoryOrderRow(r: Record<string, unknown>): InventoryOrder {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    itemId: String(r.item_id ?? ''),
    itemName: String(r.item_name ?? ''),
    quantity: Number(r.quantity ?? 0),
    quantityCases: r.quantity_cases == null ? undefined : Number(r.quantity_cases),
    unitCost: r.unit_cost == null ? undefined : Number(r.unit_cost),
    totalCost: r.total_cost == null ? undefined : Number(r.total_cost),
    vendorName: parseStringField(r.vendor_name),
    orderedAt: toDate(r.ordered_at),
    receivedAt: toDate(r.received_at),
    notes: parseStringField(r.notes),
  };
}

export function toInventoryOrderRow(o: Partial<InventoryOrder>): Record<string, unknown> {
  return dropUndefined({
    property_id: o.propertyId,
    item_id: o.itemId,
    item_name: o.itemName,
    quantity: o.quantity,
    quantity_cases: o.quantityCases,
    unit_cost: o.unitCost,
    total_cost: o.totalCost,
    vendor_name: o.vendorName,
    ordered_at: toISO(o.orderedAt),
    received_at: toISO(o.receivedAt),
    notes: o.notes,
  });
}

// ─── Inventory discard (stained linen / damaged / lost / theft) ─────────────

export function fromInventoryDiscardRow(r: Record<string, unknown>): InventoryDiscard {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    itemId: String(r.item_id ?? ''),
    itemName: String(r.item_name ?? ''),
    quantity: Number(r.quantity ?? 0),
    reason: parseUnionField(r.reason, INVENTORY_DISCARD_REASONS, 'other'),
    costValue: r.cost_value == null ? undefined : Number(r.cost_value),
    unitCost: r.unit_cost == null ? undefined : Number(r.unit_cost),
    discardedAt: toDate(r.discarded_at),
    discardedBy: parseStringField(r.discarded_by),
    notes: parseStringField(r.notes),
  };
}

export function toInventoryDiscardRow(d: Partial<InventoryDiscard>): Record<string, unknown> {
  return dropUndefined({
    property_id: d.propertyId,
    item_id: d.itemId,
    item_name: d.itemName,
    quantity: d.quantity,
    reason: d.reason,
    cost_value: d.costValue,
    unit_cost: d.unitCost,
    discarded_at: toISO(d.discardedAt),
    discarded_by: d.discardedBy,
    notes: d.notes,
  });
}

// ─── Inventory reconciliation (physical recount with $-variance) ────────────

export function fromInventoryReconciliationRow(r: Record<string, unknown>): InventoryReconciliation {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    itemId: String(r.item_id ?? ''),
    itemName: String(r.item_name ?? ''),
    reconciledAt: toDate(r.reconciled_at),
    physicalCount: Number(r.physical_count ?? 0),
    systemEstimate: Number(r.system_estimate ?? 0),
    discardsSinceLast: Number(r.discards_since_last ?? 0),
    unaccountedVariance: Number(r.unaccounted_variance ?? 0),
    unaccountedVarianceValue: r.unaccounted_variance_value == null ? undefined : Number(r.unaccounted_variance_value),
    unitCost: r.unit_cost == null ? undefined : Number(r.unit_cost),
    reconciledBy: parseStringField(r.reconciled_by),
    notes: parseStringField(r.notes),
  };
}

export function toInventoryReconciliationRow(r: Partial<InventoryReconciliation>): Record<string, unknown> {
  return dropUndefined({
    property_id: r.propertyId,
    item_id: r.itemId,
    item_name: r.itemName,
    reconciled_at: toISO(r.reconciledAt),
    physical_count: r.physicalCount,
    system_estimate: r.systemEstimate,
    discards_since_last: r.discardsSinceLast,
    unaccounted_variance: r.unaccountedVariance,
    unaccounted_variance_value: r.unaccountedVarianceValue,
    unit_cost: r.unitCost,
    reconciled_by: r.reconciledBy,
    notes: r.notes,
  });
}

// ─── Inventory budget (per-property × category × month) ─────────────────────

export function fromInventoryBudgetRow(r: Record<string, unknown>): InventoryBudget {
  return {
    propertyId: String(r.property_id ?? ''),
    category: parseUnionField(r.category, INVENTORY_CATEGORIES, 'housekeeping'),
    monthStart: toDate(r.month_start),
    budgetCents: Number(r.budget_cents ?? 0),
    notes: parseStringField(r.notes),
    updatedAt: toDate(r.updated_at),
  };
}

export function toInventoryBudgetRow(b: Partial<InventoryBudget>): Record<string, unknown> {
  return dropUndefined({
    property_id: b.propertyId,
    category: b.category,
    // month_start is a DATE column — serialise as YYYY-MM-DD (UTC) so we don't
    // accidentally drift to the previous day in negative-offset timezones.
    month_start: b.monthStart instanceof Date
      ? b.monthStart.toISOString().slice(0, 10)
      : (b.monthStart === null ? null : undefined),
    budget_cents: b.budgetCents,
    notes: b.notes,
  });
}

// ─── Handoff ────────────────────────────────────────────────────────────────

export function fromHandoffRow(r: Record<string, unknown>): HandoffEntry {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    shiftType: parseUnionField(r.shift_type, HANDOFF_SHIFT_TYPES, 'morning'),
    author: String(r.author ?? ''),
    notes: String(r.notes ?? ''),
    acknowledged: Boolean(r.acknowledged),
    acknowledgedBy: parseStringField(r.acknowledged_by),
    createdAt: toDate(r.created_at),
    acknowledgedAt: toDate(r.acknowledged_at),
  };
}

// ─── Guest request ──────────────────────────────────────────────────────────

export function fromGuestRequestRow(r: Record<string, unknown>): GuestRequest {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    roomNumber: String(r.room_number ?? ''),
    type: parseUnionField(r.type, GUEST_REQUEST_TYPES, 'other'),
    notes: parseStringField(r.notes),
    status: parseUnionField(r.status, GUEST_REQUEST_STATUSES, 'pending'),
    assignedTo: parseStringField(r.assigned_to),
    assignedName: parseStringField(r.assigned_name),
    createdAt: toDate(r.created_at),
    completedAt: toDate(r.completed_at),
  };
}

export function toGuestRequestRow(g: Partial<GuestRequest>): Record<string, unknown> {
  return dropUndefined({
    property_id: g.propertyId,
    room_number: g.roomNumber,
    type: g.type,
    notes: g.notes,
    status: g.status,
    assigned_to: g.assignedTo,
    assigned_name: g.assignedName,
    completed_at: toISO(g.completedAt),
  });
}

// ─── Shift confirmation + manager notification ──────────────────────────────

export function fromShiftConfirmationRow(r: Record<string, unknown>): ShiftConfirmation {
  return {
    id: String(r.token ?? r.id ?? ''),
    uid: '',
    pid: String(r.property_id ?? ''),
    staffId: String(r.staff_id ?? ''),
    staffName: String(r.staff_name ?? ''),
    staffPhone: String(r.staff_phone ?? ''),
    shiftDate: String(r.shift_date ?? ''),
    status: parseUnionField(r.status, CONFIRMATION_STATUSES, 'sent'),
    language: parseUnionField(r.language, LANGUAGES, 'en'),
    sentAt: toDate(r.sent_at),
    respondedAt: toDate(r.responded_at),
    smsSent: Boolean(r.sms_sent),
    smsError: parseStringField(r.sms_error),
  };
}

export function fromManagerNotificationRow(r: Record<string, unknown>): ManagerNotification {
  return {
    id: String(r.id),
    uid: '',
    pid: String(r.property_id ?? ''),
    type: parseUnionField(r.type, NOTIFICATION_TYPES, 'no_response'),
    message: String(r.message ?? ''),
    staffName: parseStringField(r.staff_name),
    replacementName: parseStringField(r.replacement_name),
    shiftDate: String(r.shift_date ?? ''),
    read: Boolean(r.read),
    createdAt: toDate(r.created_at),
  };
}

// ─── Deep clean ─────────────────────────────────────────────────────────────

export function fromDeepCleanRecordRow(r: Record<string, unknown>): DeepCleanRecord {
  return {
    id: String(r.room_number ?? ''),
    roomNumber: String(r.room_number ?? ''),
    lastDeepClean: String(r.last_deep_clean ?? ''),
    cleanedBy: parseStringField(r.cleaned_by),
    cleanedByTeam: Array.isArray(r.cleaned_by_team)
      ? parseArrayField(r.cleaned_by_team, parseStringField)
      : undefined,
    notes: parseStringField(r.notes),
    status: parseOptionalUnionField(r.status, DEEP_CLEAN_STATUSES),
    assignedAt: parseStringField(r.assigned_at),
    completedAt: parseStringField(r.completed_at),
  };
}

