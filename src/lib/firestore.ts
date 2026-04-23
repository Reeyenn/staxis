// ═══════════════════════════════════════════════════════════════════════════
// Data access layer — Supabase/Postgres.
//
// File name is kept as `firestore.ts` as a deliberate no-op rename so that
// every existing `import { ... } from '@/lib/firestore'` in the codebase
// continues to work without edits. The implementation has been entirely
// rewritten on top of Supabase (Postgres + Realtime). Function signatures
// are preserved exactly — the `uid` first arg is accepted for backward
// compatibility and ignored, because scoping is now by `property_id` plus
// RLS (authenticated user's JWT identifies them; service-role key bypasses
// RLS for scraper/cron/admin routes).
//
// All real-time listeners use Supabase Realtime's `postgres_changes`
// channel. Each subscribe* helper does an initial fetch, pushes the result
// to the callback, then subscribes to subsequent INSERT/UPDATE/DELETE
// events and re-fetches so the caller always sees a consistent snapshot.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase';
import type {
  Property,
  StaffMember,
  PublicArea,
  LaundryCategory,
  Room,
  DailyLog,
  UserProfile,
  WorkOrder,
  PreventiveTask,
  InventoryItem,
  Inspection,
  HandoffEntry,
  GuestRequest,
  ShiftConfirmation,
  ManagerNotification,
  DeepCleanConfig,
  DeepCleanRecord,
  LandscapingTask,
} from '@/types';

// ─── tiny utilities ─────────────────────────────────────────────────────────

const toDate = (v: unknown): Date | null => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
};

const toISO = (v: unknown): string | null => {
  const d = toDate(v);
  return d ? d.toISOString() : null;
};

function dropUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function logErr(tag: string, err: unknown): void {
  // Supabase PostgrestError is a plain object ({ message, details, hint,
  // code }), not an Error subclass — String(err) returns "[object Object]"
  // and hides the actual failure, which is the worst possible outcome in
  // a logger. Extract .message + .code + .hint + .details manually.
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else if (err !== null && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.code    === 'string') parts.push(`code=${e.code}`);
    if (typeof e.hint    === 'string') parts.push(`hint=${e.hint}`);
    if (typeof e.details === 'string') parts.push(`details=${e.details}`);
    msg = parts.length ? parts.join(' ') : JSON.stringify(err);
  } else {
    msg = String(err);
  }
  // eslint-disable-next-line no-console
  console.error(`[Supabase] ${tag}:`, msg);
}

// ─── Column mappers ────────────────────────────────────────────────────────

function toPropertyRow(p: Partial<Property>): Record<string, unknown> {
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

function fromPropertyRow(r: Record<string, unknown>): Property {
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

function toStaffRow(s: Partial<StaffMember>): Record<string, unknown> {
  return dropUndefined({
    name: s.name,
    phone: s.phone,
    phone_lookup: s.phone ? s.phone.replace(/\D/g, '').slice(-10) : undefined,
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

function fromStaffRow(r: Record<string, unknown>): StaffMember {
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
  };
}

function toRoomRow(room: Partial<Room> & { propertyId?: string }): Record<string, unknown> {
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

function fromRoomRow(r: Record<string, unknown>): Room {
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

function toPublicAreaRow(a: Partial<PublicArea>): Record<string, unknown> {
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

function fromPublicAreaRow(r: Record<string, unknown>): PublicArea {
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

function toLaundryRow(c: Partial<LaundryCategory>): Record<string, unknown> {
  return dropUndefined({
    name: c.name,
    units_per_checkout: c.unitsPerCheckout,
    two_bed_multiplier: c.twoBedMultiplier,
    stayover_factor: c.stayoverFactor,
    room_equivs_per_load: c.roomEquivsPerLoad,
    minutes_per_load: c.minutesPerLoad,
  });
}

function fromLaundryRow(r: Record<string, unknown>): LaundryCategory {
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

function toDailyLogRow(l: Partial<DailyLog> & { propertyId?: string }): Record<string, unknown> {
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

function fromDailyLogRow(r: Record<string, unknown>): DailyLog {
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

function toWorkOrderRow(o: Partial<WorkOrder>): Record<string, unknown> {
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

function fromWorkOrderRow(r: Record<string, unknown>): WorkOrder {
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

function fromPreventiveRow(r: Record<string, unknown>): PreventiveTask {
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

function toPreventiveRow(t: Partial<PreventiveTask>): Record<string, unknown> {
  return dropUndefined({
    property_id: t.propertyId,
    name: t.name,
    frequency_days: t.frequencyDays,
    last_completed_at: toISO(t.lastCompletedAt),
    last_completed_by: t.lastCompletedBy,
    notes: t.notes,
  });
}

function fromLandscapingRow(r: Record<string, unknown>): LandscapingTask {
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

function toLandscapingRow(t: Partial<LandscapingTask>): Record<string, unknown> {
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

function fromInventoryRow(r: Record<string, unknown>): InventoryItem {
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

function toInventoryRow(i: Partial<InventoryItem>): Record<string, unknown> {
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

function fromInspectionRow(r: Record<string, unknown>): Inspection {
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

function toInspectionRow(i: Partial<Inspection>): Record<string, unknown> {
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

function fromHandoffRow(r: Record<string, unknown>): HandoffEntry {
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

function fromGuestRequestRow(r: Record<string, unknown>): GuestRequest {
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

function toGuestRequestRow(g: Partial<GuestRequest>): Record<string, unknown> {
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

function fromShiftConfirmationRow(r: Record<string, unknown>): ShiftConfirmation {
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

function fromManagerNotificationRow(r: Record<string, unknown>): ManagerNotification {
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

function fromDeepCleanRecordRow(r: Record<string, unknown>): DeepCleanRecord {
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

// ═══════════════════════════════════════════════════════════════════════════
// Realtime helper: initial fetch + postgres_changes subscription
// ═══════════════════════════════════════════════════════════════════════════
//
// Postgres Realtime delivers one row per event. Instead of diff-merging on
// the client, each change triggers a cheap re-fetch so the callback always
// receives the full, consistent list — mirrors Firestore's `onSnapshot`
// semantics exactly.
//
// `filter` is a Postgres-level filter (e.g. `property_id=eq.xxx`). `doFetch`
// is the initial + refresh loader. Returns an unsubscribe function.
function subscribeTable<T>(
  channelName: string,
  table: string,
  filter: string | null,
  doFetch: () => Promise<T[]>,
  callback: (rows: T[]) => void,
): () => void {
  let active = true;

  const fire = () => {
    if (!active) return;
    doFetch()
      .then(rows => { if (active) callback(rows); })
      .catch(err => logErr(`Listener error in ${channelName}`, err));
  };

  fire();

  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes' as never,
      filter ? { event: '*', schema: 'public', table, filter } : { event: '*', schema: 'public', table },
      fire,
    )
    .subscribe();

  return () => {
    active = false;
    supabase.removeChannel(channel);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// User — the Firestore `users/{uid}` profile doc doesn't have a Postgres
// counterpart; user state lives in `auth.users` now. These helpers are
// retained as soft no-ops so legacy callers compile without change.
// ═══════════════════════════════════════════════════════════════════════════

export async function createOrUpdateUser(_uid: string, _data: Partial<UserProfile>): Promise<void> {
  // no-op: Supabase Auth owns the user record
}

export async function getUser(uid: string): Promise<UserProfile | null> {
  // Best-effort: synthesize a minimal profile from the auth session. Callers
  // that relied on rich Firestore-side profile fields should use Supabase Auth
  // getUser() directly going forward.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== uid) return null;
  return {
    uid: user.id,
    email: user.email ?? '',
    displayName: (user.user_metadata?.display_name as string) ?? user.email ?? '',
    createdAt: toDate(user.created_at) ?? new Date(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Properties
// ═══════════════════════════════════════════════════════════════════════════

export async function getProperties(_uid: string): Promise<Property[]> {
  const { data, error } = await supabase.from('properties').select('*');
  if (error) { logErr('getProperties', error); throw error; }
  return (data ?? []).map(fromPropertyRow);
}

export async function getProperty(_uid: string, pid: string): Promise<Property | null> {
  const { data, error } = await supabase.from('properties').select('*').eq('id', pid).maybeSingle();
  if (error) { logErr('getProperty', error); throw error; }
  return data ? fromPropertyRow(data) : null;
}

export async function createProperty(_uid: string, data: Omit<Property, 'id' | 'createdAt'>): Promise<string> {
  const row = toPropertyRow(data);
  const { data: { user } } = await supabase.auth.getUser();
  if (user?.id) row.owner_id = user.id;
  const { data: inserted, error } = await supabase
    .from('properties').insert(row).select('id').single();
  if (error) { logErr('createProperty', error); throw error; }
  return String(inserted.id);
}

export async function updateProperty(_uid: string, pid: string, data: Partial<Property>): Promise<void> {
  const { error } = await supabase.from('properties').update(toPropertyRow(data)).eq('id', pid);
  if (error) { logErr('updateProperty', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Staff
// ═══════════════════════════════════════════════════════════════════════════

export async function getStaff(_uid: string, pid: string): Promise<StaffMember[]> {
  const { data, error } = await supabase.from('staff').select('*').eq('property_id', pid);
  if (error) { logErr('getStaff', error); throw error; }
  return (data ?? []).map(fromStaffRow);
}

export function subscribeToStaff(
  _uid: string, pid: string,
  callback: (staff: StaffMember[]) => void,
): () => void {
  return subscribeTable<StaffMember>(
    `staff:${pid}`, 'staff', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase.from('staff').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromStaffRow);
    },
    callback,
  );
}

export async function addStaffMember(_uid: string, pid: string, data: Omit<StaffMember, 'id'>): Promise<string> {
  try {
    const row = { ...toStaffRow(data), property_id: pid };
    const { data: inserted, error } = await supabase
      .from('staff').insert(row).select('id').single();
    if (error) throw error;
    return String(inserted.id);
  } catch (err) { logErr('addStaffMember', err); throw err; }
}

export async function updateStaffMember(_uid: string, _pid: string, sid: string, data: Partial<StaffMember>): Promise<void> {
  try {
    const { error } = await supabase.from('staff').update(toStaffRow(data)).eq('id', sid);
    if (error) throw error;
  } catch (err) { logErr('updateStaffMember', err); throw err; }
}

export async function deleteStaffMember(_uid: string, _pid: string, sid: string): Promise<void> {
  try {
    const { error } = await supabase.from('staff').delete().eq('id', sid);
    if (error) throw error;
  } catch (err) { logErr('deleteStaffMember', err); throw err; }
}

/** No-op in Supabase world — FCM push has been dropped in favor of Twilio SMS.
 * Retained so legacy callers compile without edits. */
export async function saveStaffFcmToken(_uid: string, _pid: string, _sid: string, _fcmToken: string): Promise<void> {
  // intentionally no-op
}

// ═══════════════════════════════════════════════════════════════════════════
// Public Areas
// ═══════════════════════════════════════════════════════════════════════════

export async function getPublicAreas(_uid: string, pid: string): Promise<PublicArea[]> {
  const { data, error } = await supabase.from('public_areas').select('*').eq('property_id', pid);
  if (error) { logErr('getPublicAreas', error); throw error; }
  return (data ?? []).map(fromPublicAreaRow);
}

export async function setPublicArea(_uid: string, pid: string, area: PublicArea): Promise<void> {
  const row = { ...toPublicAreaRow(area), id: area.id, property_id: pid };
  const { error } = await supabase.from('public_areas').upsert(row);
  if (error) { logErr('setPublicArea', error); throw error; }
}

export async function deletePublicArea(_uid: string, _pid: string, aid: string): Promise<void> {
  const { error } = await supabase.from('public_areas').delete().eq('id', aid);
  if (error) { logErr('deletePublicArea', error); throw error; }
}

export async function bulkSetPublicAreas(_uid: string, pid: string, areas: PublicArea[]): Promise<void> {
  const rows = areas.map(a => ({ ...toPublicAreaRow(a), id: a.id, property_id: pid }));
  const { error } = await supabase.from('public_areas').upsert(rows);
  if (error) { logErr('bulkSetPublicAreas', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Laundry Config
// ═══════════════════════════════════════════════════════════════════════════

export async function getLaundryConfig(_uid: string, pid: string): Promise<LaundryCategory[]> {
  const { data, error } = await supabase.from('laundry_config').select('*').eq('property_id', pid);
  if (error) { logErr('getLaundryConfig', error); throw error; }
  return (data ?? []).map(fromLaundryRow);
}

export async function setLaundryCategory(_uid: string, pid: string, cat: LaundryCategory): Promise<void> {
  const row = { ...toLaundryRow(cat), id: cat.id, property_id: pid };
  const { error } = await supabase.from('laundry_config').upsert(row);
  if (error) { logErr('setLaundryCategory', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Daily Logs
// ═══════════════════════════════════════════════════════════════════════════

export async function getDailyLog(_uid: string, pid: string, date: string): Promise<DailyLog | null> {
  const { data, error } = await supabase
    .from('daily_logs').select('*')
    .eq('property_id', pid).eq('date', date).maybeSingle();
  if (error) { logErr('getDailyLog', error); throw error; }
  return data ? fromDailyLogRow(data) : null;
}

export async function saveDailyLog(_uid: string, pid: string, log: DailyLog): Promise<void> {
  try {
    const row = { ...toDailyLogRow({ ...log, propertyId: pid }), property_id: pid, date: log.date };
    const { error } = await supabase
      .from('daily_logs').upsert(row, { onConflict: 'property_id,date' });
    if (error) throw error;
  } catch (err) { logErr('saveDailyLog', err); throw err; }
}

export async function getRecentDailyLogs(_uid: string, pid: string, days = 30): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from('daily_logs').select('*')
    .eq('property_id', pid)
    .order('date', { ascending: false })
    .limit(days);
  if (error) { logErr('getRecentDailyLogs', error); throw error; }
  return (data ?? []).map(fromDailyLogRow);
}

// ═══════════════════════════════════════════════════════════════════════════
// Rooms (real-time)
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToRooms(
  _uid: string, pid: string, date: string,
  callback: (rooms: Room[]) => void,
): () => void {
  return subscribeTable<Room>(
    `rooms:${pid}:${date}`, 'rooms', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('rooms').select('*')
        .eq('property_id', pid).eq('date', date);
      if (error) throw error;
      return (data ?? []).map(fromRoomRow);
    },
    callback,
  );
}

export function subscribeToAllRooms(
  _uid: string, pid: string,
  callback: (rooms: Room[]) => void,
): () => void {
  return subscribeTable<Room>(
    `rooms-all:${pid}`, 'rooms', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase.from('rooms').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromRoomRow);
    },
    callback,
  );
}

export async function addRoom(_uid: string, pid: string, room: Omit<Room, 'id'>): Promise<string> {
  try {
    const row = { ...toRoomRow({ ...room, propertyId: pid }), property_id: pid };
    const { data: inserted, error } = await supabase
      .from('rooms').insert(row).select('id').single();
    if (error) throw error;
    return String(inserted.id);
  } catch (err) { logErr('addRoom', err); throw err; }
}

export async function updateRoom(_uid: string, _pid: string, rid: string, data: Partial<Room>): Promise<void> {
  const { error } = await supabase.from('rooms').update(toRoomRow(data)).eq('id', rid);
  if (error) { logErr('updateRoom', error); throw error; }
}

export async function deleteRoom(_uid: string, _pid: string, rid: string): Promise<void> {
  const { error } = await supabase.from('rooms').delete().eq('id', rid);
  if (error) { logErr('deleteRoom', error); throw error; }
}

export async function bulkAddRooms(_uid: string, pid: string, rooms: Omit<Room, 'id'>[]): Promise<void> {
  try {
    if (rooms.length === 0) return;
    const rows = rooms.map(r => ({ ...toRoomRow({ ...r, propertyId: pid }), property_id: pid }));
    const { error } = await supabase.from('rooms').insert(rows);
    if (error) throw error;
  } catch (err) { logErr('bulkAddRooms', err); throw err; }
}

export async function getRoomsForDate(_uid: string, pid: string, date: string): Promise<Room[]> {
  const { data, error } = await supabase
    .from('rooms').select('*').eq('property_id', pid).eq('date', date);
  if (error) { logErr('getRoomsForDate', error); throw error; }
  return (data ?? []).map(fromRoomRow);
}

export async function carryOverRooms(_uid: string, pid: string, fromDate: string, toDate: string): Promise<number> {
  const yesterday = await getRoomsForDate(_uid, pid, fromDate);
  if (yesterday.length === 0) return 0;
  const rows = yesterday.map(r => ({
    property_id: pid,
    number: r.number,
    type: r.type,
    priority: r.priority,
    status: 'dirty',
    date: toDate,
  }));
  const { error } = await supabase.from('rooms').insert(rows);
  if (error) { logErr('carryOverRooms', error); throw error; }
  return yesterday.length;
}

// ═══════════════════════════════════════════════════════════════════════════
// Work Orders
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToWorkOrders(
  _uid: string, pid: string,
  callback: (orders: WorkOrder[]) => void,
): () => void {
  return subscribeTable<WorkOrder>(
    `work_orders:${pid}`, 'work_orders', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('work_orders').select('*')
        .eq('property_id', pid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromWorkOrderRow);
    },
    callback,
  );
}

export async function addWorkOrder(
  _uid: string, pid: string,
  order: Omit<WorkOrder, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<string> {
  try {
    const row = { ...toWorkOrderRow({ ...order, propertyId: pid }), property_id: pid };
    const { data: inserted, error } = await supabase
      .from('work_orders').insert(row).select('id').single();
    if (error) throw error;
    return String(inserted.id);
  } catch (err) { logErr('addWorkOrder', err); throw err; }
}

export async function updateWorkOrder(
  _uid: string, _pid: string, wid: string, data: Partial<WorkOrder>,
): Promise<void> {
  try {
    const { error } = await supabase.from('work_orders').update(toWorkOrderRow(data)).eq('id', wid);
    if (error) throw error;
  } catch (err) { logErr('updateWorkOrder', err); throw err; }
}

export async function deleteWorkOrder(_uid: string, _pid: string, wid: string): Promise<void> {
  const { error } = await supabase.from('work_orders').delete().eq('id', wid);
  if (error) { logErr('deleteWorkOrder', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Preventive Maintenance Tasks
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToPreventiveTasks(
  _uid: string, pid: string,
  callback: (tasks: PreventiveTask[]) => void,
): () => void {
  return subscribeTable<PreventiveTask>(
    `preventive_tasks:${pid}`, 'preventive_tasks', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('preventive_tasks').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromPreventiveRow);
    },
    callback,
  );
}

export async function addPreventiveTask(
  _uid: string, pid: string,
  task: Omit<PreventiveTask, 'id' | 'createdAt'>,
): Promise<string> {
  const row = { ...toPreventiveRow({ ...task, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('preventive_tasks').insert(row).select('id').single();
  if (error) { logErr('addPreventiveTask', error); throw error; }
  return String(inserted.id);
}

export async function updatePreventiveTask(
  _uid: string, _pid: string, tid: string, data: Partial<PreventiveTask>,
): Promise<void> {
  const { error } = await supabase.from('preventive_tasks').update(toPreventiveRow(data)).eq('id', tid);
  if (error) { logErr('updatePreventiveTask', error); throw error; }
}

export async function deletePreventiveTask(_uid: string, _pid: string, tid: string): Promise<void> {
  const { error } = await supabase.from('preventive_tasks').delete().eq('id', tid);
  if (error) { logErr('deletePreventiveTask', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Landscaping Tasks
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToLandscapingTasks(
  _uid: string, pid: string,
  callback: (tasks: LandscapingTask[]) => void,
): () => void {
  return subscribeTable<LandscapingTask>(
    `landscaping_tasks:${pid}`, 'landscaping_tasks', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('landscaping_tasks').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromLandscapingRow);
    },
    callback,
  );
}

export async function addLandscapingTask(
  _uid: string, pid: string,
  task: Omit<LandscapingTask, 'id' | 'createdAt'>,
): Promise<string> {
  const row = { ...toLandscapingRow({ ...task, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('landscaping_tasks').insert(row).select('id').single();
  if (error) { logErr('addLandscapingTask', error); throw error; }
  return String(inserted.id);
}

export async function updateLandscapingTask(
  _uid: string, _pid: string, tid: string, data: Partial<LandscapingTask>,
): Promise<void> {
  const { error } = await supabase.from('landscaping_tasks').update(toLandscapingRow(data)).eq('id', tid);
  if (error) { logErr('updateLandscapingTask', error); throw error; }
}

export async function deleteLandscapingTask(_uid: string, _pid: string, tid: string): Promise<void> {
  const { error } = await supabase.from('landscaping_tasks').delete().eq('id', tid);
  if (error) { logErr('deleteLandscapingTask', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Inventory
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToInventory(
  _uid: string, pid: string,
  callback: (items: InventoryItem[]) => void,
): () => void {
  return subscribeTable<InventoryItem>(
    `inventory:${pid}`, 'inventory', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('inventory').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromInventoryRow);
    },
    callback,
  );
}

export async function addInventoryItem(
  _uid: string, pid: string,
  item: Omit<InventoryItem, 'id' | 'updatedAt'>,
): Promise<string> {
  const row = { ...toInventoryRow({ ...item, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('inventory').insert(row).select('id').single();
  if (error) { logErr('addInventoryItem', error); throw error; }
  return String(inserted.id);
}

export async function updateInventoryItem(
  _uid: string, _pid: string, iid: string, data: Partial<InventoryItem>,
): Promise<void> {
  const { error } = await supabase.from('inventory').update(toInventoryRow(data)).eq('id', iid);
  if (error) { logErr('updateInventoryItem', error); throw error; }
}

export async function deleteInventoryItem(_uid: string, _pid: string, iid: string): Promise<void> {
  const { error } = await supabase.from('inventory').delete().eq('id', iid);
  if (error) { logErr('deleteInventoryItem', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Inspections
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToInspections(
  _uid: string, pid: string,
  callback: (items: Inspection[]) => void,
): () => void {
  return subscribeTable<Inspection>(
    `inspections:${pid}`, 'inspections', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('inspections').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromInspectionRow);
    },
    callback,
  );
}

export async function addInspection(
  _uid: string, pid: string,
  item: Omit<Inspection, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<string> {
  const row = { ...toInspectionRow({ ...item, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('inspections').insert(row).select('id').single();
  if (error) { logErr('addInspection', error); throw error; }
  return String(inserted.id);
}

export async function updateInspection(
  _uid: string, _pid: string, iid: string, data: Partial<Inspection>,
): Promise<void> {
  const { error } = await supabase.from('inspections').update(toInspectionRow(data)).eq('id', iid);
  if (error) { logErr('updateInspection', error); throw error; }
}

export async function deleteInspection(_uid: string, _pid: string, iid: string): Promise<void> {
  const { error } = await supabase.from('inspections').delete().eq('id', iid);
  if (error) { logErr('deleteInspection', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Handoff Logs
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToHandoffLogs(
  _uid: string, pid: string,
  callback: (entries: HandoffEntry[]) => void,
): () => void {
  return subscribeTable<HandoffEntry>(
    `handoff_logs:${pid}`, 'handoff_logs', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('handoff_logs').select('*')
        .eq('property_id', pid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromHandoffRow);
    },
    callback,
  );
}

export async function addHandoffEntry(
  _uid: string, pid: string,
  entry: Omit<HandoffEntry, 'id' | 'createdAt'>,
): Promise<string> {
  const row = dropUndefined({
    property_id: pid,
    shift_type: entry.shiftType,
    author: entry.author,
    notes: entry.notes,
    acknowledged: entry.acknowledged,
    acknowledged_by: entry.acknowledgedBy,
    acknowledged_at: toISO(entry.acknowledgedAt),
  });
  const { data: inserted, error } = await supabase
    .from('handoff_logs').insert(row).select('id').single();
  if (error) { logErr('addHandoffEntry', error); throw error; }
  return String(inserted.id);
}

export async function acknowledgeHandoffEntry(
  _uid: string, _pid: string, hid: string, by: string,
): Promise<void> {
  const { error } = await supabase
    .from('handoff_logs')
    .update({ acknowledged: true, acknowledged_by: by, acknowledged_at: new Date().toISOString() })
    .eq('id', hid);
  if (error) { logErr('acknowledgeHandoffEntry', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Guest Requests
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToGuestRequests(
  _uid: string, pid: string,
  callback: (requests: GuestRequest[]) => void,
): () => void {
  return subscribeTable<GuestRequest>(
    `guest_requests:${pid}`, 'guest_requests', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('guest_requests').select('*')
        .eq('property_id', pid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromGuestRequestRow);
    },
    callback,
  );
}

export async function addGuestRequest(
  _uid: string, pid: string,
  req: Omit<GuestRequest, 'id' | 'createdAt'>,
): Promise<string> {
  const row = { ...toGuestRequestRow({ ...req, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('guest_requests').insert(row).select('id').single();
  if (error) { logErr('addGuestRequest', error); throw error; }
  return String(inserted.id);
}

export async function updateGuestRequest(
  _uid: string, _pid: string, gid: string, data: Partial<GuestRequest>,
): Promise<void> {
  const { error } = await supabase.from('guest_requests').update(toGuestRequestRow(data)).eq('id', gid);
  if (error) { logErr('updateGuestRequest', error); throw error; }
}

export async function deleteGuestRequest(_uid: string, _pid: string, gid: string): Promise<void> {
  const { error } = await supabase.from('guest_requests').delete().eq('id', gid);
  if (error) { logErr('deleteGuestRequest', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Plan Snapshots (CSV scraper data)
// ═══════════════════════════════════════════════════════════════════════════

export interface PlanSnapshot {
  date: string;
  pulledAt: Date | null;
  pullType: 'evening' | 'morning';
  totalRooms: number;
  checkouts: number;
  stayovers: number;
  stayoverDay1: number;
  stayoverDay2: number;
  stayoverArrivalDay: number;
  stayoverUnknown: number;
  arrivals: number;
  vacantClean: number;
  vacantDirty: number;
  ooo: number;
  checkoutMinutes: number;
  stayoverDay1Minutes: number;
  stayoverDay2Minutes: number;
  vacantDirtyMinutes: number;
  totalCleaningMinutes: number;
  recommendedHKs: number;
  checkoutRoomNumbers: string[];
  stayoverDay1RoomNumbers: string[];
  stayoverDay2RoomNumbers: string[];
  stayoverArrivalRoomNumbers: string[];
  arrivalRoomNumbers: string[];
  vacantCleanRoomNumbers: string[];
  vacantDirtyRoomNumbers: string[];
  oooRoomNumbers: string[];
  rooms: Array<{
    number: string;
    roomType: string;
    status: string;
    condition: string;
    stayType: string | null;
    service: string;
    adults: number;
    children: number;
    housekeeper: string | null;
    arrival: string | null;
    departure: string | null;
    lastClean: string | null;
    stayoverDay?: number | null;
    stayoverMinutes?: number;
  }>;
}

function fromPlanSnapshotRow(r: Record<string, unknown>): PlanSnapshot {
  return {
    date: String(r.date ?? ''),
    pulledAt: toDate(r.pulled_at),
    pullType: (r.pull_type as PlanSnapshot['pullType']) ?? 'evening',
    totalRooms: Number(r.total_rooms ?? 0),
    checkouts: Number(r.checkouts ?? 0),
    stayovers: Number(r.stayovers ?? 0),
    stayoverDay1: Number(r.stayover_day1 ?? 0),
    stayoverDay2: Number(r.stayover_day2 ?? 0),
    stayoverArrivalDay: Number(r.stayover_arrival_day ?? 0),
    stayoverUnknown: Number(r.stayover_unknown ?? 0),
    arrivals: Number(r.arrivals ?? 0),
    vacantClean: Number(r.vacant_clean ?? 0),
    vacantDirty: Number(r.vacant_dirty ?? 0),
    ooo: Number(r.ooo ?? 0),
    checkoutMinutes: Number(r.checkout_minutes ?? 0),
    stayoverDay1Minutes: Number(r.stayover_day1_minutes ?? 0),
    stayoverDay2Minutes: Number(r.stayover_day2_minutes ?? 0),
    vacantDirtyMinutes: Number(r.vacant_dirty_minutes ?? 0),
    totalCleaningMinutes: Number(r.total_cleaning_minutes ?? 0),
    recommendedHKs: Number(r.recommended_hks ?? 0),
    checkoutRoomNumbers: (r.checkout_room_numbers as string[]) ?? [],
    stayoverDay1RoomNumbers: (r.stayover_day1_room_numbers as string[]) ?? [],
    stayoverDay2RoomNumbers: (r.stayover_day2_room_numbers as string[]) ?? [],
    stayoverArrivalRoomNumbers: (r.stayover_arrival_room_numbers as string[]) ?? [],
    arrivalRoomNumbers: (r.arrival_room_numbers as string[]) ?? [],
    vacantCleanRoomNumbers: (r.vacant_clean_room_numbers as string[]) ?? [],
    vacantDirtyRoomNumbers: (r.vacant_dirty_room_numbers as string[]) ?? [],
    oooRoomNumbers: (r.ooo_room_numbers as string[]) ?? [],
    rooms: (r.rooms as PlanSnapshot['rooms']) ?? [],
  };
}

export function subscribeToPlanSnapshot(
  _uid: string, pid: string, date: string,
  callback: (snapshot: PlanSnapshot | null) => void,
): () => void {
  return subscribeTable<PlanSnapshot>(
    `plan_snapshots:${pid}:${date}`, 'plan_snapshots', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('plan_snapshots').select('*')
        .eq('property_id', pid).eq('date', date).maybeSingle();
      if (error) throw error;
      return data ? [fromPlanSnapshotRow(data)] : [];
    },
    (rows) => callback(rows[0] ?? null),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard numbers (CA View pages) — scraper_status/dashboard row
// ═══════════════════════════════════════════════════════════════════════════

export type DashboardErrorCode =
  | 'login_failed'
  | 'session_expired'
  | 'selector_miss'
  | 'timeout'
  | 'parse_error'
  | 'validation_failed'
  | 'ca_unreachable'
  | 'unknown';

export interface DashboardNumbers {
  inHouse:    number | null;
  arrivals:   number | null;
  departures: number | null;
  inHouseGuests?:    number | null;
  arrivalsGuests?:   number | null;
  departuresGuests?: number | null;
  pulledAt: Date | null;
  errorCode:    DashboardErrorCode | null;
  errorMessage: string | null;
  errorPage:    string | null;
  erroredAt:    Date | null;
  error: string | null;
}

export const DASHBOARD_STALE_MINUTES = 25;

export type DashboardFreshness = 'fresh' | 'stale' | 'error' | 'unknown';

export function dashboardFreshness(
  d: DashboardNumbers | null,
  nowMs: number = Date.now(),
): DashboardFreshness {
  if (!d) return 'unknown';
  if (d.errorCode) return 'error';
  if (!d.pulledAt) return 'unknown';
  const ageMs = nowMs - d.pulledAt.getTime();
  return ageMs > DASHBOARD_STALE_MINUTES * 60_000 ? 'stale' : 'fresh';
}

function dashboardFromJson(d: Record<string, unknown> | null): DashboardNumbers | null {
  if (!d) return null;
  return {
    inHouse:    typeof d.inHouse    === 'number' ? d.inHouse    : null,
    arrivals:   typeof d.arrivals   === 'number' ? d.arrivals   : null,
    departures: typeof d.departures === 'number' ? d.departures : null,
    inHouseGuests:    typeof d.inHouseGuests    === 'number' ? d.inHouseGuests    : null,
    arrivalsGuests:   typeof d.arrivalsGuests   === 'number' ? d.arrivalsGuests   : null,
    departuresGuests: typeof d.departuresGuests === 'number' ? d.departuresGuests : null,
    pulledAt:     toDate(d.pulledAt),
    errorCode:    typeof d.errorCode    === 'string' ? d.errorCode as DashboardErrorCode : null,
    errorMessage: typeof d.errorMessage === 'string' ? d.errorMessage : null,
    errorPage:    typeof d.errorPage    === 'string' ? d.errorPage    : null,
    erroredAt:    toDate(d.erroredAt),
    error:        typeof d.error === 'string' ? d.error : null,
  };
}

export function subscribeToDashboardNumbers(
  callback: (nums: DashboardNumbers | null) => void,
): () => void {
  return subscribeTable<DashboardNumbers>(
    'scraper_status:dashboard', 'scraper_status', `key=eq.dashboard`,
    async () => {
      const { data, error } = await supabase
        .from('scraper_status').select('data').eq('key', 'dashboard').maybeSingle();
      if (error) throw error;
      const parsed = dashboardFromJson((data?.data as Record<string, unknown>) ?? null);
      return parsed ? [parsed] : [];
    },
    (rows) => callback(rows[0] ?? null),
  );
}

export async function getDashboardForDate(dateStr: string): Promise<DashboardNumbers | null> {
  try {
    const { data, error } = await supabase
      .from('dashboard_by_date').select('*').eq('date', dateStr).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as Record<string, unknown>;
    return {
      inHouse:    typeof r.in_house    === 'number' ? r.in_house    : null,
      arrivals:   typeof r.arrivals    === 'number' ? r.arrivals    : null,
      departures: typeof r.departures  === 'number' ? r.departures  : null,
      inHouseGuests:    typeof r.in_house_guests    === 'number' ? r.in_house_guests    : null,
      arrivalsGuests:   typeof r.arrivals_guests    === 'number' ? r.arrivals_guests    : null,
      departuresGuests: typeof r.departures_guests  === 'number' ? r.departures_guests  : null,
      pulledAt:     toDate(r.pulled_at),
      errorCode:    typeof r.error_code    === 'string' ? r.error_code as DashboardErrorCode : null,
      errorMessage: typeof r.error_message === 'string' ? r.error_message : null,
      errorPage:    typeof r.error_page    === 'string' ? r.error_page    : null,
      erroredAt:    toDate(r.errored_at),
      error:        null,
    };
  } catch (err) { logErr('getDashboardForDate', err); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Schedule Assignments (Maria's HK→room assignments)
// ═══════════════════════════════════════════════════════════════════════════

export interface CsvRoomSnapshot {
  number: string;
  type: 'checkout' | 'stayover';
}

export interface ScheduleAssignments {
  date: string;
  roomAssignments: Record<string, string>;
  crew: string[];
  staffNames?: Record<string, string>;
  csvRoomSnapshot?: CsvRoomSnapshot[];
  csvPulledAt?: string | null;
  updatedAt: Date | null;
}

function fromScheduleAssignmentsRow(r: Record<string, unknown>): ScheduleAssignments {
  return {
    date: String(r.date ?? ''),
    roomAssignments: (r.room_assignments as Record<string, string>) ?? {},
    crew: (r.crew as string[]) ?? [],
    staffNames: (r.staff_names as Record<string, string>) ?? {},
    csvRoomSnapshot: (r.csv_room_snapshot as CsvRoomSnapshot[]) ?? [],
    csvPulledAt: (r.csv_pulled_at as string | null) ?? null,
    updatedAt: toDate(r.updated_at),
  };
}

export function subscribeToScheduleAssignments(
  _uid: string, pid: string, date: string,
  callback: (sa: ScheduleAssignments | null) => void,
): () => void {
  return subscribeTable<ScheduleAssignments>(
    `schedule_assignments:${pid}:${date}`, 'schedule_assignments', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('schedule_assignments').select('*')
        .eq('property_id', pid).eq('date', date).maybeSingle();
      if (error) throw error;
      return data ? [fromScheduleAssignmentsRow(data)] : [];
    },
    (rows) => callback(rows[0] ?? null),
  );
}

export async function saveScheduleAssignments(
  _uid: string, pid: string, date: string,
  payload: {
    roomAssignments: Record<string, string>;
    crew: string[];
    staffNames?: Record<string, string>;
    csvRoomSnapshot?: CsvRoomSnapshot[];
    csvPulledAt?: string | null;
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    property_id: pid,
    date,
    room_assignments: payload.roomAssignments,
    crew: payload.crew,
    staff_names: payload.staffNames ?? {},
    updated_at: new Date().toISOString(),
  };
  if (payload.csvRoomSnapshot !== undefined) row.csv_room_snapshot = payload.csvRoomSnapshot;
  if (payload.csvPulledAt !== undefined) row.csv_pulled_at = payload.csvPulledAt;
  const { error } = await supabase
    .from('schedule_assignments').upsert(row, { onConflict: 'property_id,date' });
  if (error) { logErr('saveScheduleAssignments', error); throw error; }
}

export async function getScheduleAssignments(
  _uid: string, pid: string, date: string,
): Promise<ScheduleAssignments | null> {
  const { data, error } = await supabase
    .from('schedule_assignments').select('*')
    .eq('property_id', pid).eq('date', date).maybeSingle();
  if (error) { logErr('getScheduleAssignments', error); throw error; }
  return data ? fromScheduleAssignmentsRow(data) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shift Confirmations
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToShiftConfirmations(
  _uid: string, pid: string, shiftDate: string,
  callback: (confirmations: ShiftConfirmation[]) => void,
): () => void {
  return subscribeTable<ShiftConfirmation>(
    `shift_confirmations:${pid}:${shiftDate}`, 'shift_confirmations', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('shift_confirmations').select('*')
        .eq('property_id', pid).eq('shift_date', shiftDate);
      if (error) throw error;
      return (data ?? []).map(fromShiftConfirmationRow);
    },
    callback,
  );
}

export async function getShiftConfirmationsForDate(
  _uid: string, pid: string, shiftDate: string,
): Promise<ShiftConfirmation[]> {
  const { data, error } = await supabase
    .from('shift_confirmations').select('*')
    .eq('property_id', pid).eq('shift_date', shiftDate);
  if (error) { logErr('getShiftConfirmationsForDate', error); throw error; }
  return (data ?? []).map(fromShiftConfirmationRow);
}

// ═══════════════════════════════════════════════════════════════════════════
// Manager Notifications
// ═══════════════════════════════════════════════════════════════════════════

export function subscribeToManagerNotifications(
  _uid: string, pid: string,
  callback: (notifications: ManagerNotification[]) => void,
): () => void {
  return subscribeTable<ManagerNotification>(
    `manager_notifications:${pid}`, 'manager_notifications', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('manager_notifications').select('*')
        .eq('property_id', pid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromManagerNotificationRow);
    },
    callback,
  );
}

export async function markNotificationRead(_uid: string, _pid: string, nid: string): Promise<void> {
  const { error } = await supabase.from('manager_notifications').update({ read: true }).eq('id', nid);
  if (error) { logErr('markNotificationRead', error); throw error; }
}

export async function markAllNotificationsRead(_uid: string, pid: string): Promise<void> {
  const { error } = await supabase
    .from('manager_notifications').update({ read: true })
    .eq('property_id', pid).eq('read', false);
  if (error) { logErr('markAllNotificationsRead', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Deep Cleaning Config & Records
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_DEEP_CLEAN_CONFIG: DeepCleanConfig = {
  frequencyDays: 90,
  minutesPerRoom: 60,
  targetPerWeek: 5,
};

export async function getDeepCleanConfig(_uid: string, pid: string): Promise<DeepCleanConfig> {
  const { data, error } = await supabase
    .from('deep_clean_config').select('*').eq('property_id', pid).maybeSingle();
  if (error) { logErr('getDeepCleanConfig', error); throw error; }
  if (!data) return { ...DEFAULT_DEEP_CLEAN_CONFIG };
  return {
    frequencyDays: Number(data.frequency_days ?? 90),
    minutesPerRoom: Number(data.minutes_per_room ?? 60),
    targetPerWeek: Number(data.target_per_week ?? 5),
  };
}

export async function setDeepCleanConfig(_uid: string, pid: string, config: DeepCleanConfig): Promise<void> {
  const row = {
    property_id: pid,
    frequency_days: config.frequencyDays,
    minutes_per_room: config.minutesPerRoom,
    target_per_week: config.targetPerWeek,
  };
  const { error } = await supabase.from('deep_clean_config').upsert(row);
  if (error) { logErr('setDeepCleanConfig', error); throw error; }
}

export async function getDeepCleanRecords(_uid: string, pid: string): Promise<DeepCleanRecord[]> {
  const { data, error } = await supabase
    .from('deep_clean_records').select('*').eq('property_id', pid);
  if (error) { logErr('getDeepCleanRecords', error); throw error; }
  return (data ?? []).map(fromDeepCleanRecordRow);
}

export async function setDeepCleanRecord(_uid: string, pid: string, record: DeepCleanRecord): Promise<void> {
  const row = dropUndefined({
    property_id: pid,
    room_number: record.roomNumber,
    last_deep_clean: record.lastDeepClean,
    cleaned_by: record.cleanedBy,
    cleaned_by_team: record.cleanedByTeam,
    notes: record.notes,
    status: record.status,
    assigned_at: record.assignedAt,
    completed_at: record.completedAt,
  });
  const { error } = await supabase
    .from('deep_clean_records').upsert(row, { onConflict: 'property_id,room_number' });
  if (error) { logErr('setDeepCleanRecord', error); throw error; }
}

export async function markRoomDeepCleaned(
  _uid: string, pid: string, roomNumber: string, cleanedBy?: string, notes?: string,
): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA');
  const row = dropUndefined({
    property_id: pid,
    room_number: roomNumber,
    last_deep_clean: today,
    status: 'completed',
    completed_at: today,
    cleaned_by: cleanedBy,
    notes,
  });
  const { error } = await supabase
    .from('deep_clean_records').upsert(row, { onConflict: 'property_id,room_number' });
  if (error) { logErr('markRoomDeepCleaned', error); throw error; }
}

export async function assignRoomDeepClean(
  _uid: string, pid: string, roomNumber: string, team: string[],
): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA');
  // Preserve prior lastDeepClean if the row already exists.
  const { data: existing } = await supabase
    .from('deep_clean_records').select('last_deep_clean')
    .eq('property_id', pid).eq('room_number', roomNumber).maybeSingle();
  const row = {
    property_id: pid,
    room_number: roomNumber,
    last_deep_clean: (existing?.last_deep_clean as string) ?? '',
    cleaned_by_team: team,
    status: 'in_progress',
    assigned_at: today,
  };
  const { error } = await supabase
    .from('deep_clean_records').upsert(row, { onConflict: 'property_id,room_number' });
  if (error) { logErr('assignRoomDeepClean', error); throw error; }
}

export async function completeRoomDeepClean(
  _uid: string, pid: string, roomNumber: string, team: string[],
): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA');
  const row = {
    property_id: pid,
    room_number: roomNumber,
    last_deep_clean: today,
    cleaned_by_team: team,
    cleaned_by: team.join(', '),
    status: 'completed',
    completed_at: today,
  };
  const { error } = await supabase
    .from('deep_clean_records').upsert(row, { onConflict: 'property_id,room_number' });
  if (error) { logErr('completeRoomDeepClean', error); throw error; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Housekeeper / Laundry staff-facing helpers
//
// These power /housekeeper/[id] and /laundry/[id] — the HK-facing pages
// where one staff member sees only their own assigned rooms (across any
// date, not just today). Previously the pages ran a Firestore
// collectionGroup('rooms') query with where('assignedTo','==',staffId).
// Here we expose the equivalent on top of the `rooms` Postgres table.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Subscribe to every room (across all dates) assigned to a given staff
 * member at a given property. Callback is invoked with the initial
 * snapshot and again on every INSERT/UPDATE/DELETE to `rooms`.
 */
export function subscribeToRoomsForStaff(
  pid: string,
  staffId: string,
  callback: (rooms: Room[]) => void,
): () => void {
  return subscribeTable<Room>(
    `rooms-hk:${pid}:${staffId}`,
    'rooms',
    `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('rooms').select('*')
        .eq('property_id', pid)
        .eq('assigned_to', staffId);
      if (error) throw error;
      return (data ?? []).map(fromRoomRow);
    },
    callback,
  );
}

/**
 * Fetch a single staff member by id, scoped to a property.
 * Returns null if not found. Used by the HK-facing pages to read the
 * staff member's saved `language` preference on first render.
 */
export async function getStaffMember(pid: string, sid: string): Promise<StaffMember | null> {
  const { data, error } = await supabase
    .from('staff').select('*')
    .eq('property_id', pid).eq('id', sid).maybeSingle();
  if (error) { logErr('getStaffMember', error); throw error; }
  return data ? fromStaffRow(data) : null;
}

/**
 * Persist a staff member's language choice. Small convenience wrapper
 * over updateStaffMember — lets the HK-facing language toggle stay
 * one line.
 */
export async function saveStaffLanguage(sid: string, language: 'en' | 'es'): Promise<void> {
  const { error } = await supabase.from('staff').update({ language }).eq('id', sid);
  if (error) { logErr('saveStaffLanguage', error); throw error; }
}
