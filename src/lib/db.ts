// ═══════════════════════════════════════════════════════════════════════════
// Data access layer — Supabase/Postgres.
//
// This is the single entry point every page uses to read/write app data.
// The public function surface (subscribeToRooms, updateRoom, getStaffMember,
// etc.) is stable — callers don't care which database is underneath.
//
// The `uid` first arg on many functions is a legacy parameter from the old
// Firestore era, accepted for backward compatibility and ignored, because
// scoping is now by `property_id` plus RLS (authenticated user's JWT
// identifies them; service-role key bypasses RLS for scraper/cron/admin).
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
import {
  toDate,
  toISO,
  dropUndefined,
  toPropertyRow,
  fromPropertyRow,
  toStaffRow,
  fromStaffRow,
  toRoomRow,
  fromRoomRow,
  toPublicAreaRow,
  fromPublicAreaRow,
  toLaundryRow,
  fromLaundryRow,
  toDailyLogRow,
  fromDailyLogRow,
  toWorkOrderRow,
  fromWorkOrderRow,
  fromPreventiveRow,
  toPreventiveRow,
  fromLandscapingRow,
  toLandscapingRow,
  fromInventoryRow,
  toInventoryRow,
  fromInspectionRow,
  toInspectionRow,
  fromHandoffRow,
  fromGuestRequestRow,
  toGuestRequestRow,
  fromShiftConfirmationRow,
  fromManagerNotificationRow,
  fromDeepCleanRecordRow,
} from './db-mappers';

// ─── tiny utilities ─────────────────────────────────────────────────────────

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

// ─── Column mappers (extracted to db-mappers.ts) ──────────────────────────
// All toXxxRow / fromXxxRow functions live in src/lib/db-mappers.ts now.
// They are imported above. Edit them there, not here.


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

  const filterSpec = filter
    ? { event: '*', schema: 'public', table, filter }
    : { event: '*', schema: 'public', table };

  // `let`, not `const`: visibility recovery may swap the channel out for a
  // fresh one if iOS Safari (or any other mobile browser) silently kills
  // the WebSocket while the tab is backgrounded.
  let channel = supabase
    .channel(channelName)
    .on('postgres_changes' as never, filterSpec, fire)
    .subscribe();

  // ── Mobile Safari / phone-wake recovery ────────────────────────────────
  // Realtime over WebSockets dies silently when iOS Safari throttles a
  // backgrounded tab. The channel object stays in memory but no events
  // fire after the tab returns to the foreground. Without recovery, every
  // page in this app looks frozen until the user hard-refreshes — and
  // housekeepers, who use this on shared phones in the back office, never
  // hard-refresh anything.
  //
  // On every visibility change back to "visible":
  //   1. Always refetch — guarantees the UI is correct even if no realtime
  //      events arrive while we're re-establishing the WebSocket.
  //   2. If the channel state is 'closed' or 'errored', tear it down and
  //      create a fresh subscription with the same name + filter so future
  //      mutations resume propagating.
  const onVisibility = () => {
    if (!active) return;
    if (typeof document === 'undefined' || document.hidden) return;
    fire();
    // .state isn't in the public type but is exposed at runtime.
    type WithState = { state?: string };
    const state = (channel as unknown as WithState).state;
    if (state === 'closed' || state === 'errored') {
      try { supabase.removeChannel(channel); } catch { /* best effort */ }
      channel = supabase
        .channel(channelName)
        .on('postgres_changes' as never, filterSpec, fire)
        .subscribe();
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    active = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
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
    // Realtime postgres_changes only supports a single binary filter, so we
    // narrow on property_id and let the doFetch query handle the date filter.
    // Receiving an extra change event for another date just triggers a re-fetch.
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
    // Single-filter only on realtime — see subscribeToRooms note.
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
  // Off-hours suppression: scraper only pulls dashboard numbers between
  // 5am and 11pm Central. Outside that window the data is naturally
  // stale, but Maria shouldn't see a red "PMS stale" banner at midnight
  // when nothing's broken. Mirror the scraper's gate exactly.
  const localHourCT = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(new Date(nowMs)),
    10,
  );
  const inScraperWindow = localHourCT >= 5 && localHourCT < 23;
  if (!inScraperWindow) return 'fresh';
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
    // Single-filter only on realtime — see subscribeToRooms note.
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
    // Single-filter only on realtime — see subscribeToRooms note.
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
    // Single-filter only on realtime — see subscribeToRooms note.
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

// ═══════════════════════════════════════════════════════════════════════════
// Cleaning Events (Migration 0012)
// ═══════════════════════════════════════════════════════════════════════════
//
// Permanent audit log — one row per Done tap. Powers the Housekeeping
// Performance tab. See supabase/migrations/0012_cleaning_events.sql for the
// schema and lifecycle rules.
//
// IMPORTANT: This table is independent of the rooms table. The
// populate-rooms-from-plan route wipes started_at/completed_at on every
// re-pull, but this audit log persists forever. That's the whole point.
// ═══════════════════════════════════════════════════════════════════════════

export type CleaningEventStatus = 'recorded' | 'discarded' | 'flagged' | 'approved' | 'rejected';

export interface CleaningEvent {
  id: string;
  propertyId: string;
  date: string;             // 'YYYY-MM-DD' operational date
  roomNumber: string;
  roomType: 'checkout' | 'stayover';
  stayoverDay: 1 | 2 | null; // bucketed: 1=S1 (light), 2=S2 (full), null=checkout
  staffId: string | null;
  staffName: string;
  startedAt: Date;
  completedAt: Date;
  durationMinutes: number;
  status: CleaningEventStatus;
  flagReason: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

// Business-rule thresholds. Mirror the migration's CASE expressions so we
// produce identical status values in TS-side inserts. If you change these,
// re-run the migration to keep historical data consistent.
export const CLEANING_DISCARD_UNDER_MIN = 3;
export const CLEANING_FLAG_OVER_MIN = 60;

// Computes the bucketed S1/S2 cycle from the raw scraper-set stayover_day
// (1, 2, 3, 4, …). Odd → 1 (S1 light), Even → 2 (S2 full). Returns null for
// stayover_day = 0 (arrival day) or non-stayover types.
export function bucketStayoverDay(stayoverDay: number | null | undefined, roomType: string): 1 | 2 | null {
  if (roomType !== 'stayover') return null;
  if (typeof stayoverDay !== 'number' || stayoverDay <= 0) return null;
  return ((stayoverDay - 1) % 2) + 1 as 1 | 2;
}

// Pure function for status classification — easy to unit test.
export function classifyCleaningEvent(durationMinutes: number): { status: CleaningEventStatus; flagReason: string | null } {
  if (durationMinutes < CLEANING_DISCARD_UNDER_MIN) return { status: 'discarded', flagReason: 'under_3min' };
  if (durationMinutes > CLEANING_FLAG_OVER_MIN) return { status: 'flagged', flagReason: 'over_60min' };
  return { status: 'recorded', flagReason: null };
}

function fromCleaningEventRow(r: Record<string, unknown>): CleaningEvent {
  return {
    id: String(r.id),
    propertyId: String(r.property_id),
    date: String(r.date),
    roomNumber: String(r.room_number),
    roomType: r.room_type as 'checkout' | 'stayover',
    stayoverDay: r.stayover_day === 1 ? 1 : r.stayover_day === 2 ? 2 : null,
    staffId: r.staff_id ? String(r.staff_id) : null,
    staffName: String(r.staff_name ?? 'Unknown'),
    startedAt: new Date(String(r.started_at)),
    completedAt: new Date(String(r.completed_at)),
    durationMinutes: Number(r.duration_minutes ?? 0),
    status: r.status as CleaningEventStatus,
    flagReason: r.flag_reason ? String(r.flag_reason) : null,
    reviewedBy: r.reviewed_by ? String(r.reviewed_by) : null,
    reviewedAt: r.reviewed_at ? new Date(String(r.reviewed_at)) : null,
    createdAt: new Date(String(r.created_at)),
  };
}

/**
 * Insert one cleaning event. Called by the housekeeper page when "Done" is
 * tapped. Computes duration, status, and flag_reason from the inputs.
 *
 * Idempotent: re-clicking "Done" with the same started_at/completed_at hits
 * the unique constraint and is silently ignored. Returns null on any error
 * — the caller should NOT block the room update on this insert.
 */
export async function insertCleaningEvent(input: {
  propertyId: string;
  date: string;
  roomNumber: string;
  roomType: 'checkout' | 'stayover';
  stayoverDay: 1 | 2 | null;
  staffId: string | null;
  staffName: string;
  startedAt: Date;
  completedAt: Date;
}): Promise<CleaningEvent | null> {
  const durationMs = input.completedAt.getTime() - input.startedAt.getTime();
  const durationMinutes = Math.max(0, durationMs / 60_000);
  const { status, flagReason } = classifyCleaningEvent(durationMinutes);

  const row = {
    property_id: input.propertyId,
    date: input.date,
    room_number: input.roomNumber,
    room_type: input.roomType,
    stayover_day: input.stayoverDay,
    staff_id: input.staffId,
    staff_name: input.staffName || 'Unknown',
    started_at: input.startedAt.toISOString(),
    completed_at: input.completedAt.toISOString(),
    duration_minutes: Number(durationMinutes.toFixed(2)),
    status,
    flag_reason: flagReason,
  };

  const { data, error } = await supabase
    .from('cleaning_events')
    .upsert(row, {
      onConflict: 'property_id,date,room_number,started_at,completed_at',
      ignoreDuplicates: true,
    })
    .select()
    .maybeSingle();

  if (error) {
    logErr('insertCleaningEvent', error);
    return null;
  }
  return data ? fromCleaningEventRow(data) : null;
}

/**
 * Fetch cleaning events for a property in a date range. Used by the
 * Performance API endpoints. Discarded entries are excluded by default
 * (they're not useful for analytics) — pass includeDiscarded=true for the
 * raw audit dump (e.g., CSV export).
 */
export async function getCleaningEventsForRange(
  pid: string,
  fromDate: string,
  toDate: string,
  options: { includeDiscarded?: boolean } = {},
): Promise<CleaningEvent[]> {
  let q = supabase
    .from('cleaning_events')
    .select('*')
    .eq('property_id', pid)
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('completed_at', { ascending: false });

  if (!options.includeDiscarded) {
    q = q.neq('status', 'discarded');
  }

  const { data, error } = await q;
  if (error) { logErr('getCleaningEventsForRange', error); throw error; }
  return (data ?? []).map(fromCleaningEventRow);
}

/**
 * Get all entries currently waiting on Mario's flag review. Sorted oldest
 * first so the queue feels like a FIFO inbox.
 */
export async function getFlaggedCleaningEvents(pid: string): Promise<CleaningEvent[]> {
  const { data, error } = await supabase
    .from('cleaning_events')
    .select('*')
    .eq('property_id', pid)
    .eq('status', 'flagged')
    .order('created_at', { ascending: true });
  if (error) { logErr('getFlaggedCleaningEvents', error); throw error; }
  return (data ?? []).map(fromCleaningEventRow);
}

/**
 * Mark recent cleaning_events for a (property, date, room, staff) tuple as
 * 'discarded' if they were created within the last N seconds. This is the
 * "oops, wrong room — Done then Reset" undo path.
 *
 * Reeyen's spec: when a housekeeper accidentally hits Done and immediately
 * hits Reset, throw out the audit entry. We use a 60-second window — wide
 * enough to absorb a "walk away, realize mistake, walk back, reset" but
 * narrow enough that a 5-minute-later legit reset (e.g., guest came back
 * mid-clean) doesn't retroactively erase real work.
 *
 * Multiple matches are all marked discarded — covers Done/Reset/Done/Reset
 * thrash. Already-decided entries (approved/rejected) are NOT touched —
 * Mario's call is permanent.
 */
export async function discardRecentCleaningEvent(input: {
  propertyId: string;
  date: string;
  roomNumber: string;
  staffId: string | null;
  withinSeconds?: number;
}): Promise<void> {
  const cutoff = new Date(Date.now() - (input.withinSeconds ?? 60) * 1000).toISOString();
  let q = supabase
    .from('cleaning_events')
    .update({
      status: 'discarded' as CleaningEventStatus,
      flag_reason: 'reset_within_window',
    })
    .eq('property_id', input.propertyId)
    .eq('date', input.date)
    .eq('room_number', input.roomNumber)
    .gte('created_at', cutoff)
    .in('status', ['recorded', 'flagged']);
  if (input.staffId) {
    q = q.eq('staff_id', input.staffId);
  } else {
    q = q.is('staff_id', null);
  }
  const { error } = await q;
  if (error) logErr('discardRecentCleaningEvent', error);
}

/**
 * Mario decides yes/no on a flagged entry. Permanent — once decided, the
 * entry can't be re-reviewed. The .eq('status', 'flagged') guard prevents
 * race conditions where two reviewers click at once.
 */
export async function decideOnFlaggedEvent(
  eventId: string,
  decision: 'approved' | 'rejected',
  reviewerId: string,
): Promise<void> {
  const { error } = await supabase
    .from('cleaning_events')
    .update({
      status: decision,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', eventId)
    .eq('status', 'flagged');
  if (error) { logErr('decideOnFlaggedEvent', error); throw error; }
}

/**
 * Subscribe to cleaning_events for the Live tab. Reuses subscribeTable's
 * visibility-recovery + iOS Safari WebSocket-resurrect logic so the
 * leaderboard stays accurate after Mario backgrounds the tab.
 *
 * Today-only: the live view is "what's happened so far today," so we only
 * fetch rows where date = today. The page caller is responsible for
 * keeping `today` reactive across midnight (already done elsewhere via
 * useTodayStr).
 */
export function subscribeToTodayCleaningEvents(
  pid: string,
  date: string,
  callback: (events: CleaningEvent[]) => void,
): () => void {
  return subscribeTable<CleaningEvent>(
    `cleaning_events:${pid}:${date}`,
    'cleaning_events',
    `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('cleaning_events')
        .select('*')
        .eq('property_id', pid)
        .eq('date', date)
        .order('completed_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromCleaningEventRow);
    },
    callback,
  );
}
