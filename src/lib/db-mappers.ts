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
  PreventiveTask,
  InventoryItem,
  Inspection,
  HandoffEntry,
  GuestRequest,
  ShiftConfirmation,
  ManagerNotification,
  DeepCleanRecord,
  LandscapingTask,
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
    morningBriefingTime: (r.morning_briefing_time as string) ?? undefined,
    eveningForecastTime: (r.evening_forecast_time as string) ?? undefined,
    pmsType: (r.pms_type as string) ?? undefined,
    pmsUrl: (r.pms_url as string) ?? undefined,
    pmsConnected: (r.pms_connected as boolean) ?? undefined,
    lastSyncedAt: toDate(r.last_synced_at),
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
    phone: (r.phone as string) ?? undefined,
    language: (r.language as 'en' | 'es') ?? 'en',
    isSenior: Boolean(r.is_senior),
    department: (r.department as StaffMember['department']) ?? undefined,
    hourlyWage: r.hourly_wage == null ? undefined : Number(r.hourly_wage),
    scheduledToday: Boolean(r.scheduled_today),
    weeklyHours: Number(r.weekly_hours ?? 0),
    maxWeeklyHours: Number(r.max_weekly_hours ?? 40),
    maxDaysPerWeek: r.max_days_per_week == null ? undefined : Number(r.max_days_per_week),
    daysWorkedThisWeek: r.days_worked_this_week == null ? undefined : Number(r.days_worked_this_week),
    vacationDates: (r.vacation_dates as string[]) ?? undefined,
    isActive: r.is_active == null ? undefined : Boolean(r.is_active),
    schedulePriority: (r.schedule_priority as StaffMember['schedulePriority']) ?? undefined,
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
    type: (r.type as Room['type']) ?? 'checkout',
    priority: (r.priority as Room['priority']) ?? 'standard',
    status: (r.status as Room['status']) ?? 'dirty',
    assignedTo: (r.assigned_to as string) ?? undefined,
    assignedName: (r.assigned_name as string) ?? undefined,
    startedAt: toDate(r.started_at),
    completedAt: toDate(r.completed_at),
    date: String(r.date ?? ''),
    propertyId: String(r.property_id ?? ''),
    issueNote: (r.issue_note as string) ?? undefined,
    inspectedBy: (r.inspected_by as string) ?? undefined,
    inspectedAt: toDate(r.inspected_at),
    isDnd: r.is_dnd == null ? undefined : Boolean(r.is_dnd),
    dndNote: (r.dnd_note as string) ?? undefined,
    arrival: (r.arrival as string) ?? undefined,
    stayoverDay: r.stayover_day == null ? undefined : Number(r.stayover_day),
    stayoverMinutes: r.stayover_minutes == null ? undefined : Number(r.stayover_minutes),
    helpRequested: r.help_requested == null ? undefined : Boolean(r.help_requested),
    checklist: (r.checklist as Record<string, boolean>) ?? undefined,
    photoUrl: (r.photo_url as string) ?? undefined,
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
    publicAreasDueToday: (r.public_areas_due_today as string[]) ?? [],
    laundryLoads: (r.laundry_loads as DailyLog['laundryLoads']) ?? { towels: 0, sheets: 0, comforters: 0 },
    roomsCompleted: r.rooms_completed == null ? undefined : Number(r.rooms_completed),
    avgTurnaroundMinutes: r.avg_turnaround_minutes == null ? undefined : Number(r.avg_turnaround_minutes),
  };
}

// ─── Work order ─────────────────────────────────────────────────────────────

export function toWorkOrderRow(o: Partial<WorkOrder>): Record<string, unknown> {
  return dropUndefined({
    property_id: o.propertyId,
    room_number: o.roomNumber,
    description: o.description,
    severity: o.severity,
    status: o.status,
    submitted_by: o.submittedBy,
    submitted_by_name: o.submittedByName,
    assigned_to: o.assignedTo,
    assigned_name: o.assignedName,
    photo_url: o.photoUrl,
    notes: o.notes,
    blocked_room: o.blockedRoom,
    source: o.source,
    ca_work_order_number: o.caWorkOrderNumber,
    ca_from_date: o.caFromDate,
    ca_to_date: o.caToDate,
    resolved_at: toISO(o.resolvedAt),
  });
}

export function fromWorkOrderRow(r: Record<string, unknown>): WorkOrder {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    roomNumber: String(r.room_number ?? ''),
    description: String(r.description ?? ''),
    severity: (r.severity as WorkOrder['severity']) ?? 'low',
    status: (r.status as WorkOrder['status']) ?? 'submitted',
    submittedBy: (r.submitted_by as string) ?? undefined,
    submittedByName: (r.submitted_by_name as string) ?? undefined,
    assignedTo: (r.assigned_to as string) ?? undefined,
    assignedName: (r.assigned_name as string) ?? undefined,
    photoUrl: (r.photo_url as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    blockedRoom: r.blocked_room == null ? undefined : Boolean(r.blocked_room),
    source: (r.source as WorkOrder['source']) ?? undefined,
    caWorkOrderNumber: (r.ca_work_order_number as string) ?? undefined,
    caFromDate: (r.ca_from_date as string) ?? undefined,
    caToDate: (r.ca_to_date as string) ?? undefined,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    resolvedAt: toDate(r.resolved_at),
  };
}

// ─── Preventive ─────────────────────────────────────────────────────────────

export function fromPreventiveRow(r: Record<string, unknown>): PreventiveTask {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    name: String(r.name ?? ''),
    frequencyDays: Number(r.frequency_days ?? 1),
    lastCompletedAt: toDate(r.last_completed_at),
    lastCompletedBy: (r.last_completed_by as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    createdAt: toDate(r.created_at),
  };
}

export function toPreventiveRow(t: Partial<PreventiveTask>): Record<string, unknown> {
  return dropUndefined({
    property_id: t.propertyId,
    name: t.name,
    frequency_days: t.frequencyDays,
    last_completed_at: toISO(t.lastCompletedAt),
    last_completed_by: t.lastCompletedBy,
    notes: t.notes,
  });
}

// ─── Landscaping ────────────────────────────────────────────────────────────

export function fromLandscapingRow(r: Record<string, unknown>): LandscapingTask {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    name: String(r.name ?? ''),
    season: (r.season as LandscapingTask['season']) ?? 'year-round',
    frequencyDays: Number(r.frequency_days ?? 1),
    lastCompletedAt: toDate(r.last_completed_at),
    lastCompletedBy: (r.last_completed_by as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    createdAt: toDate(r.created_at),
  };
}

export function toLandscapingRow(t: Partial<LandscapingTask>): Record<string, unknown> {
  return dropUndefined({
    property_id: t.propertyId,
    name: t.name,
    season: t.season,
    frequency_days: t.frequencyDays,
    last_completed_at: toISO(t.lastCompletedAt),
    last_completed_by: t.lastCompletedBy,
    notes: t.notes,
  });
}

// ─── Inventory ──────────────────────────────────────────────────────────────

export function fromInventoryRow(r: Record<string, unknown>): InventoryItem {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    name: String(r.name ?? ''),
    category: (r.category as InventoryItem['category']) ?? 'housekeeping',
    currentStock: Number(r.current_stock ?? 0),
    parLevel: Number(r.par_level ?? 0),
    reorderAt: r.reorder_at == null ? undefined : Number(r.reorder_at),
    unit: String(r.unit ?? ''),
    notes: (r.notes as string) ?? undefined,
    updatedAt: toDate(r.updated_at),
    usagePerCheckout: r.usage_per_checkout == null ? undefined : Number(r.usage_per_checkout),
    usagePerStayover: r.usage_per_stayover == null ? undefined : Number(r.usage_per_stayover),
    reorderLeadDays: r.reorder_lead_days == null ? undefined : Number(r.reorder_lead_days),
    vendorName: (r.vendor_name as string) ?? undefined,
    lastOrderedAt: toDate(r.last_ordered_at),
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
  });
}

// ─── Inspection ─────────────────────────────────────────────────────────────

export function fromInspectionRow(r: Record<string, unknown>): Inspection {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    name: String(r.name ?? ''),
    dueMonth: String(r.due_month ?? ''),
    frequencyMonths: Number(r.frequency_months ?? 0),
    frequencyDays: r.frequency_days == null ? undefined : Number(r.frequency_days),
    lastInspectedDate: (r.last_inspected_date as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

export function toInspectionRow(i: Partial<Inspection>): Record<string, unknown> {
  return dropUndefined({
    property_id: i.propertyId,
    name: i.name,
    due_month: i.dueMonth,
    frequency_months: i.frequencyMonths,
    frequency_days: i.frequencyDays,
    last_inspected_date: i.lastInspectedDate,
    notes: i.notes,
  });
}

// ─── Handoff ────────────────────────────────────────────────────────────────

export function fromHandoffRow(r: Record<string, unknown>): HandoffEntry {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    shiftType: (r.shift_type as HandoffEntry['shiftType']) ?? 'morning',
    author: String(r.author ?? ''),
    notes: String(r.notes ?? ''),
    acknowledged: Boolean(r.acknowledged),
    acknowledgedBy: (r.acknowledged_by as string) ?? undefined,
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
    type: (r.type as GuestRequest['type']) ?? 'other',
    notes: (r.notes as string) ?? undefined,
    status: (r.status as GuestRequest['status']) ?? 'pending',
    assignedTo: (r.assigned_to as string) ?? undefined,
    assignedName: (r.assigned_name as string) ?? undefined,
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
    status: (r.status as ShiftConfirmation['status']) ?? 'sent',
    language: (r.language as 'en' | 'es') ?? 'en',
    sentAt: toDate(r.sent_at),
    respondedAt: toDate(r.responded_at),
    smsSent: Boolean(r.sms_sent),
    smsError: (r.sms_error as string) ?? undefined,
  };
}

export function fromManagerNotificationRow(r: Record<string, unknown>): ManagerNotification {
  return {
    id: String(r.id),
    uid: '',
    pid: String(r.property_id ?? ''),
    type: (r.type as ManagerNotification['type']) ?? 'no_response',
    message: String(r.message ?? ''),
    staffName: (r.staff_name as string) ?? undefined,
    replacementName: (r.replacement_name as string) ?? undefined,
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
    cleanedBy: (r.cleaned_by as string) ?? undefined,
    cleanedByTeam: (r.cleaned_by_team as string[]) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    status: (r.status as DeepCleanRecord['status']) ?? undefined,
    assignedAt: (r.assigned_at as string) ?? undefined,
    completedAt: (r.completed_at as string) ?? undefined,
  };
}
