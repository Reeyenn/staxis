import {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
  serverTimestamp,
  DocumentReference,
  CollectionReference,
} from 'firebase/firestore';
import { db } from './firebase';
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

// ─── Path helpers ──────────────────────────────────────────────────────────

export const userRef = (uid: string) => doc(db, 'users', uid);
export const propertiesRef = (uid: string) => collection(db, 'users', uid, 'properties');
export const propertyRef = (uid: string, pid: string) => doc(db, 'users', uid, 'properties', pid);
export const staffRef = (uid: string, pid: string) => collection(db, 'users', uid, 'properties', pid, 'staff');
export const staffDocRef = (uid: string, pid: string, sid: string) => doc(db, 'users', uid, 'properties', pid, 'staff', sid);
export const publicAreasRef = (uid: string, pid: string) => collection(db, 'users', uid, 'properties', pid, 'publicAreas');
export const publicAreaDocRef = (uid: string, pid: string, aid: string) => doc(db, 'users', uid, 'properties', pid, 'publicAreas', aid);
export const laundryConfigRef = (uid: string, pid: string) => collection(db, 'users', uid, 'properties', pid, 'laundryConfig');
export const laundryDocRef = (uid: string, pid: string, lid: string) => doc(db, 'users', uid, 'properties', pid, 'laundryConfig', lid);
export const dailyLogsRef = (uid: string, pid: string) => collection(db, 'users', uid, 'properties', pid, 'dailyLogs');
export const dailyLogRef = (uid: string, pid: string, date: string) => doc(db, 'users', uid, 'properties', pid, 'dailyLogs', date);
export const roomsRef = (uid: string, pid: string) => collection(db, 'users', uid, 'properties', pid, 'rooms');
export const roomDocRef = (uid: string, pid: string, rid: string) => doc(db, 'users', uid, 'properties', pid, 'rooms', rid);

// ─── User ──────────────────────────────────────────────────────────────────

export async function createOrUpdateUser(uid: string, data: Partial<UserProfile>) {
  await setDoc(userRef(uid), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

export async function getUser(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(userRef(uid));
  if (!snap.exists()) return null;
  return { uid, ...snap.data() } as UserProfile;
}

// ─── Properties ────────────────────────────────────────────────────────────

export async function getProperties(uid: string): Promise<Property[]> {
  const snap = await getDocs(propertiesRef(uid));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Property));
}

export async function getProperty(uid: string, pid: string): Promise<Property | null> {
  const snap = await getDoc(propertyRef(uid, pid));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Property;
}

export async function createProperty(uid: string, data: Omit<Property, 'id' | 'createdAt'>): Promise<string> {
  const ref = await addDoc(propertiesRef(uid), { ...data, createdAt: serverTimestamp() });
  return ref.id;
}

export async function updateProperty(uid: string, pid: string, data: Partial<Property>) {
  await updateDoc(propertyRef(uid, pid), { ...data, updatedAt: serverTimestamp() });
}

// ─── Staff ─────────────────────────────────────────────────────────────────

export async function getStaff(uid: string, pid: string): Promise<StaffMember[]> {
  const snap = await getDocs(staffRef(uid, pid));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as StaffMember));
}

/** Real-time staff listener - fires immediately with cached data, then again
 *  when the network response arrives. Use this instead of getStaff to avoid
 *  the race where the Firestore cache returns [] before server data resolves. */
export function subscribeToStaff(
  uid: string,
  pid: string,
  callback: (staff: StaffMember[]) => void
): () => void {
  return onSnapshot(staffRef(uid, pid), snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() } as StaffMember)));
  }, error => {
    console.error('[Firestore] Listener error in subscribeToStaff:', error.message);
  });
}

export async function addStaffMember(uid: string, pid: string, data: Omit<StaffMember, 'id'>): Promise<string> {
  try {
    const ref = await addDoc(staffRef(uid, pid), data);
    return ref.id;
  } catch (error: any) {
    console.error('[Firestore] addStaffMember failed:', error.message);
    throw error;
  }
}

export async function updateStaffMember(uid: string, pid: string, sid: string, data: Partial<StaffMember>) {
  try {
    await updateDoc(staffDocRef(uid, pid, sid), data);
  } catch (error: any) {
    console.error('[Firestore] updateStaffMember failed:', error.message);
    throw error;
  }
}

export async function deleteStaffMember(uid: string, pid: string, sid: string) {
  try {
    await deleteDoc(staffDocRef(uid, pid, sid));
  } catch (error: any) {
    console.error('[Firestore] deleteStaffMember failed:', error.message);
    throw error;
  }
}

export async function saveStaffFcmToken(uid: string, pid: string, sid: string, fcmToken: string) {
  await updateDoc(staffDocRef(uid, pid, sid), { fcmToken });
}

// ─── Public Areas ──────────────────────────────────────────────────────────

export async function getPublicAreas(uid: string, pid: string): Promise<PublicArea[]> {
  const snap = await getDocs(publicAreasRef(uid, pid));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as PublicArea));
}

export async function setPublicArea(uid: string, pid: string, area: PublicArea) {
  await setDoc(publicAreaDocRef(uid, pid, area.id), area);
}

export async function deletePublicArea(uid: string, pid: string, aid: string) {
  await deleteDoc(publicAreaDocRef(uid, pid, aid));
}

export async function bulkSetPublicAreas(uid: string, pid: string, areas: PublicArea[]) {
  const writes = areas.map(a => setDoc(publicAreaDocRef(uid, pid, a.id), a));
  await Promise.all(writes);
}

// ─── Laundry Config ────────────────────────────────────────────────────────

export async function getLaundryConfig(uid: string, pid: string): Promise<LaundryCategory[]> {
  const snap = await getDocs(laundryConfigRef(uid, pid));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as LaundryCategory));
}

export async function setLaundryCategory(uid: string, pid: string, cat: LaundryCategory) {
  await setDoc(laundryDocRef(uid, pid, cat.id), cat);
}

// ─── Daily Logs ────────────────────────────────────────────────────────────

export async function getDailyLog(uid: string, pid: string, date: string): Promise<DailyLog | null> {
  const snap = await getDoc(dailyLogRef(uid, pid, date));
  if (!snap.exists()) return null;
  return snap.data() as DailyLog;
}

export async function saveDailyLog(uid: string, pid: string, log: DailyLog) {
  try {
    await setDoc(dailyLogRef(uid, pid, log.date), log);
  } catch (error: any) {
    console.error('[Firestore] saveDailyLog failed:', error.message);
    throw error;
  }
}

export async function getRecentDailyLogs(uid: string, pid: string, days = 30): Promise<DailyLog[]> {
  const snap = await getDocs(dailyLogsRef(uid, pid));
  const logs = snap.docs.map(d => d.data() as DailyLog);
  return logs
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, days);
}

// ─── Rooms (real-time) ─────────────────────────────────────────────────────

export function subscribeToRooms(
  uid: string,
  pid: string,
  date: string,
  callback: (rooms: Room[]) => void
) {
  const q = query(roomsRef(uid, pid), where('date', '==', date));
  return onSnapshot(q, snap => {
    const rooms = snap.docs.map(d => ({ id: d.id, ...d.data() } as Room));
    callback(rooms);
  }, error => {
    console.error('[Firestore] Listener error in subscribeToRooms:', error.message);
  });
}

export async function addRoom(uid: string, pid: string, room: Omit<Room, 'id'>): Promise<string> {
  try {
    const ref = await addDoc(roomsRef(uid, pid), room);
    return ref.id;
  } catch (error: any) {
    console.error('[Firestore] addRoom failed:', error.message);
    throw error;
  }
}

export async function updateRoom(uid: string, pid: string, rid: string, data: Partial<Room>) {
  // Strip undefined - Firestore rejects undefined field values
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await updateDoc(roomDocRef(uid, pid, rid), clean);
}

export async function deleteRoom(uid: string, pid: string, rid: string) {
  await deleteDoc(roomDocRef(uid, pid, rid));
}

export async function bulkAddRooms(uid: string, pid: string, rooms: Omit<Room, 'id'>[]) {
  try {
    const writes = rooms.map(r => addDoc(roomsRef(uid, pid), r));
    await Promise.all(writes);
  } catch (error: any) {
    console.error('[Firestore] bulkAddRooms failed:', error.message);
    throw error;
  }
}

/** One-time fetch of rooms for a specific date (no real-time listener) */
export async function getRoomsForDate(uid: string, pid: string, date: string): Promise<Room[]> {
  const q = query(roomsRef(uid, pid), where('date', '==', date));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Room));
}

/**
 * Copy yesterday's rooms into today - reset all to 'dirty', clear timestamps & inspection data.
 * Returns the number of rooms carried over.
 */
export async function carryOverRooms(uid: string, pid: string, fromDate: string, toDate: string): Promise<number> {
  const yesterday = await getRoomsForDate(uid, pid, fromDate);
  if (yesterday.length === 0) return 0;
  const writes = yesterday.map(r =>
    addDoc(roomsRef(uid, pid), {
      number:       r.number,
      type:         r.type,
      priority:     r.priority,
      status:       'dirty',
      date:         toDate,
      propertyId:   r.propertyId,
      // intentionally omit: assignedTo, assignedName, startedAt, completedAt, inspectedBy, inspectedAt, issueNote
    })
  );
  await Promise.all(writes);
  return yesterday.length;
}

// ─── Work Orders ────────────────────────────────────────────────────────────

export const workOrdersRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'workOrders');
export const workOrderDocRef = (uid: string, pid: string, wid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'workOrders', wid);

export function subscribeToWorkOrders(
  uid: string,
  pid: string,
  callback: (orders: WorkOrder[]) => void
) {
  const q = query(workOrdersRef(uid, pid), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    const orders = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        createdAt: data.createdAt?.toDate?.() ?? null,
        updatedAt: data.updatedAt?.toDate?.() ?? null,
        resolvedAt: data.resolvedAt?.toDate?.() ?? null,
      } as WorkOrder;
    });
    callback(orders);
  }, error => {
    console.error('[Firestore] Listener error in subscribeToWorkOrders:', error.message);
  });
}

export async function addWorkOrder(
  uid: string,
  pid: string,
  order: Omit<WorkOrder, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  try {
    // Firestore rejects undefined values - strip them before writing
    const clean = Object.fromEntries(
      Object.entries(order).filter(([, v]) => v !== undefined)
    );
    const ref = await addDoc(workOrdersRef(uid, pid), {
      ...clean,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (error: any) {
    console.error('[Firestore] addWorkOrder failed:', error.message);
    throw error;
  }
}

export async function updateWorkOrder(
  uid: string,
  pid: string,
  wid: string,
  data: Partial<WorkOrder>
) {
  try {
    await updateDoc(workOrderDocRef(uid, pid, wid), {
      ...data,
      updatedAt: serverTimestamp(),
    });
  } catch (error: any) {
    console.error('[Firestore] updateWorkOrder failed:', error.message);
    throw error;
  }
}

export async function deleteWorkOrder(uid: string, pid: string, wid: string) {
  await deleteDoc(workOrderDocRef(uid, pid, wid));
}

// ─── Preventive Maintenance Tasks ──────────────────────────────────────────

export const preventiveTasksRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'preventiveTasks');
export const preventiveTaskDocRef = (uid: string, pid: string, tid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'preventiveTasks', tid);

export function subscribeToPreventiveTasks(
  uid: string,
  pid: string,
  callback: (tasks: PreventiveTask[]) => void
) {
  return onSnapshot(preventiveTasksRef(uid, pid), snap => {
    const tasks = snap.docs.map(d => ({ id: d.id, ...d.data() } as PreventiveTask));
    callback(tasks);
  }, error => {
    console.error('[Firestore] Listener error in subscribeToPreventiveTasks:', error.message);
  });
}

export async function addPreventiveTask(
  uid: string,
  pid: string,
  task: Omit<PreventiveTask, 'id' | 'createdAt'>
): Promise<string> {
  const clean = Object.fromEntries(Object.entries(task).filter(([, v]) => v !== undefined));
  const ref = await addDoc(preventiveTasksRef(uid, pid), { ...clean, createdAt: serverTimestamp() });
  return ref.id;
}

export async function updatePreventiveTask(
  uid: string,
  pid: string,
  tid: string,
  data: Partial<PreventiveTask>
) {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await updateDoc(preventiveTaskDocRef(uid, pid, tid), clean);
}

export async function deletePreventiveTask(uid: string, pid: string, tid: string) {
  await deleteDoc(preventiveTaskDocRef(uid, pid, tid));
}

// ─── Landscaping Tasks ────────────────────────────────────────────────────

export const landscapingTasksRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'landscapingTasks');
export const landscapingTaskDocRef = (uid: string, pid: string, tid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'landscapingTasks', tid);

export function subscribeToLandscapingTasks(
  uid: string,
  pid: string,
  callback: (tasks: LandscapingTask[]) => void
) {
  return onSnapshot(landscapingTasksRef(uid, pid), snap => {
    const tasks = snap.docs.map(d => ({ id: d.id, ...d.data() } as LandscapingTask));
    callback(tasks);
  }, error => {
    console.error('[Firestore] Listener error in subscribeToLandscapingTasks:', error.message);
  });
}

export async function addLandscapingTask(
  uid: string,
  pid: string,
  task: Omit<LandscapingTask, 'id' | 'createdAt'>
): Promise<string> {
  const clean = Object.fromEntries(Object.entries(task).filter(([, v]) => v !== undefined));
  const ref = await addDoc(landscapingTasksRef(uid, pid), { ...clean, createdAt: serverTimestamp() });
  return ref.id;
}

export async function updateLandscapingTask(
  uid: string,
  pid: string,
  tid: string,
  data: Partial<LandscapingTask>
) {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await updateDoc(landscapingTaskDocRef(uid, pid, tid), clean);
}

export async function deleteLandscapingTask(uid: string, pid: string, tid: string) {
  await deleteDoc(landscapingTaskDocRef(uid, pid, tid));
}

// ─── Inventory / Supply Tracking ───────────────────────────────────────────

export const inventoryRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'inventory');
export const inventoryDocRef = (uid: string, pid: string, iid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'inventory', iid);

export function subscribeToInventory(
  uid: string, pid: string,
  callback: (items: InventoryItem[]) => void
) {
  return onSnapshot(inventoryRef(uid, pid), snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryItem)));
  }, error => {
    console.error('[Firestore] Listener error in subscribeToInventory:', error.message);
  });
}

export async function addInventoryItem(
  uid: string, pid: string,
  item: Omit<InventoryItem, 'id' | 'updatedAt'>
): Promise<string> {
  const clean = Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
  const ref = await addDoc(inventoryRef(uid, pid), { ...clean, updatedAt: serverTimestamp() });
  return ref.id;
}

export async function updateInventoryItem(
  uid: string, pid: string, iid: string,
  data: Partial<InventoryItem>
) {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await updateDoc(inventoryDocRef(uid, pid, iid), { ...clean, updatedAt: serverTimestamp() });
}

export async function deleteInventoryItem(uid: string, pid: string, iid: string) {
  await deleteDoc(inventoryDocRef(uid, pid, iid));
}

// ─── Inspections ──────────────────────────────────────────────────────────

export const inspectionsRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'inspections');
export const inspectionDocRef = (uid: string, pid: string, iid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'inspections', iid);

export function subscribeToInspections(
  uid: string, pid: string,
  callback: (items: Inspection[]) => void
) {
  return onSnapshot(inspectionsRef(uid, pid), snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() } as Inspection)));
  }, error => {
    console.error('[Firestore] Listener error in subscribeToInspections:', error.message);
  });
}

export async function addInspection(
  uid: string, pid: string,
  item: Omit<Inspection, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const clean = Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
  const ref = await addDoc(inspectionsRef(uid, pid), { ...clean, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return ref.id;
}

export async function updateInspection(
  uid: string, pid: string, iid: string,
  data: Partial<Inspection>
) {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await updateDoc(inspectionDocRef(uid, pid, iid), { ...clean, updatedAt: serverTimestamp() });
}

export async function deleteInspection(uid: string, pid: string, iid: string) {
  await deleteDoc(inspectionDocRef(uid, pid, iid));
}

// ─── Shift Handoff Log ─────────────────────────────────────────────────────

export const handoffRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'handoffLogs');
export const handoffDocRef = (uid: string, pid: string, hid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'handoffLogs', hid);

export function subscribeToHandoffLogs(
  uid: string, pid: string,
  callback: (entries: HandoffEntry[]) => void
) {
  const q = query(handoffRef(uid, pid), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() } as HandoffEntry)));
  }, error => {
    console.error('[Firestore] Listener error in subscribeToHandoffLogs:', error.message);
  });
}

export async function addHandoffEntry(
  uid: string, pid: string,
  entry: Omit<HandoffEntry, 'id' | 'createdAt'>
): Promise<string> {
  const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
  const ref = await addDoc(handoffRef(uid, pid), { ...clean, createdAt: serverTimestamp() });
  return ref.id;
}

export async function acknowledgeHandoffEntry(
  uid: string, pid: string, hid: string, by: string
) {
  await updateDoc(handoffDocRef(uid, pid, hid), {
    acknowledged: true,
    acknowledgedBy: by,
    acknowledgedAt: serverTimestamp(),
  });
}

// ─── Guest Requests ────────────────────────────────────────────────────────

export const guestRequestsRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'guestRequests');
export const guestRequestDocRef = (uid: string, pid: string, gid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'guestRequests', gid);

export function subscribeToGuestRequests(
  uid: string, pid: string,
  callback: (requests: GuestRequest[]) => void
) {
  const q = query(guestRequestsRef(uid, pid), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() } as GuestRequest)));
  }, error => {
    console.error('[Firestore] Listener error in subscribeToGuestRequests:', error.message);
  });
}

export async function addGuestRequest(
  uid: string, pid: string,
  req: Omit<GuestRequest, 'id' | 'createdAt'>
): Promise<string> {
  const clean = Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined));
  const ref = await addDoc(guestRequestsRef(uid, pid), { ...clean, createdAt: serverTimestamp() });
  return ref.id;
}

export async function updateGuestRequest(
  uid: string, pid: string, gid: string,
  data: Partial<GuestRequest>
) {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await updateDoc(guestRequestDocRef(uid, pid, gid), clean);
}

export async function deleteGuestRequest(uid: string, pid: string, gid: string) {
  await deleteDoc(guestRequestDocRef(uid, pid, gid));
}

// ─── Shift Confirmations ────────────────────────────────────────────────────

export const shiftConfirmationsRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'shiftConfirmations');
export const shiftConfirmationDocRef = (uid: string, pid: string, token: string) =>
  doc(db, 'users', uid, 'properties', pid, 'shiftConfirmations', token);

export function subscribeToShiftConfirmations(
  uid: string,
  pid: string,
  shiftDate: string,
  callback: (confirmations: ShiftConfirmation[]) => void
) {
  const q = query(shiftConfirmationsRef(uid, pid), where('shiftDate', '==', shiftDate));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        sentAt: data.sentAt?.toDate?.() ?? null,
        respondedAt: data.respondedAt?.toDate?.() ?? null,
      } as ShiftConfirmation;
    }));
  }, error => {
    console.error('[Firestore] Listener error in subscribeToShiftConfirmations:', error.message);
  });
}

export async function getShiftConfirmationsForDate(
  uid: string, pid: string, shiftDate: string
): Promise<ShiftConfirmation[]> {
  const q = query(shiftConfirmationsRef(uid, pid), where('shiftDate', '==', shiftDate));
  const snap = await getDocs(q);
  return snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      sentAt: data.sentAt?.toDate?.() ?? null,
      respondedAt: data.respondedAt?.toDate?.() ?? null,
    } as ShiftConfirmation;
  });
}

// ─── Manager Notifications ──────────────────────────────────────────────────

export const managerNotificationsRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'managerNotifications');
export const managerNotificationDocRef = (uid: string, pid: string, nid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'managerNotifications', nid);

export function subscribeToManagerNotifications(
  uid: string,
  pid: string,
  callback: (notifications: ManagerNotification[]) => void
) {
  const q = query(managerNotificationsRef(uid, pid), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        createdAt: data.createdAt?.toDate?.() ?? null,
      } as ManagerNotification;
    }));
  }, error => {
    console.error('[Firestore] Listener error in subscribeToManagerNotifications:', error.message);
  });
}

export async function markNotificationRead(uid: string, pid: string, nid: string) {
  await updateDoc(managerNotificationDocRef(uid, pid, nid), { read: true });
}

export async function markAllNotificationsRead(uid: string, pid: string) {
  const snap = await getDocs(
    query(managerNotificationsRef(uid, pid), where('read', '==', false))
  );
  await Promise.all(snap.docs.map(d => updateDoc(d.ref, { read: true })));
}

// ─── Deep Cleaning Config & Records ───────────────────────────────────────

export const deepCleanConfigRef = (uid: string, pid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'config', 'deepClean');

export const deepCleanRecordsRef = (uid: string, pid: string) =>
  collection(db, 'users', uid, 'properties', pid, 'deepCleanRecords');

export const deepCleanRecordDocRef = (uid: string, pid: string, rid: string) =>
  doc(db, 'users', uid, 'properties', pid, 'deepCleanRecords', rid);

const DEFAULT_DEEP_CLEAN_CONFIG: DeepCleanConfig = {
  frequencyDays: 90,
  minutesPerRoom: 60,
  targetPerWeek: 5,
};

export async function getDeepCleanConfig(uid: string, pid: string): Promise<DeepCleanConfig> {
  const snap = await getDoc(deepCleanConfigRef(uid, pid));
  if (!snap.exists()) return { ...DEFAULT_DEEP_CLEAN_CONFIG };
  return snap.data() as DeepCleanConfig;
}

export async function setDeepCleanConfig(uid: string, pid: string, config: DeepCleanConfig) {
  await setDoc(deepCleanConfigRef(uid, pid), config);
}

export async function getDeepCleanRecords(uid: string, pid: string): Promise<DeepCleanRecord[]> {
  const snap = await getDocs(deepCleanRecordsRef(uid, pid));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as DeepCleanRecord));
}

export async function setDeepCleanRecord(uid: string, pid: string, record: DeepCleanRecord) {
  await setDoc(deepCleanRecordDocRef(uid, pid, record.id), record);
}

export async function markRoomDeepCleaned(
  uid: string, pid: string, roomNumber: string, cleanedBy?: string, notes?: string
) {
  const today = new Date().toLocaleDateString('en-CA');
  const record: DeepCleanRecord = {
    id: roomNumber,
    roomNumber,
    lastDeepClean: today,
    ...(cleanedBy ? { cleanedBy } : {}),
    ...(notes ? { notes } : {}),
  };
  await setDoc(deepCleanRecordDocRef(uid, pid, roomNumber), record);
}
