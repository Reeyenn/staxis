#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * seed-pms-operational.ts — seed a self-contained operational slice into the
 * pms_* schema (rooms inventory + status log + housekeeping assignments +
 * reservations + a scratch housekeeper), then prove the rooms→pms_* migration
 * end-to-end:
 *
 *   1. AI reads: mergePmsRoomsForDate (the per-room source for the agent's
 *      room/issue tools) + today_property_counts_v1 (the occupancy source)
 *      return the seeded rooms/occupancy; an AI-flagged issue round-trips.
 *   2. Housekeeper workflow: Start → Pause → Resume → Done, plus Exception and
 *      Checklist, driven through the EXACT helpers the routes use
 *      (loadRoomForStaff → transition → writeWorkflowFields / applyRoomUpdate),
 *      with timers + exception + checklist persisted to pms_housekeeping_assignments
 *      and visible again through mergePmsRoomsForStaff.
 *
 * Scratch data is namespaced (room numbers SEED90xx + a dedicated staff row)
 * and fully removed by `reset`. It is seeded under an existing property
 * (Comfort Suites) but NEVER writes a real room number, and the default mode
 * seeds → verifies → resets in one run so nothing persists.
 *
 * Env: needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Run with the
 * .env.local exported, e.g.:
 *   set -a; source .env.local; set +a; npx tsx scripts/seed-pms-operational.ts
 *
 * Usage:
 *   tsx scripts/seed-pms-operational.ts          # seed → verify → reset (default)
 *   tsx scripts/seed-pms-operational.ts seed
 *   tsx scripts/seed-pms-operational.ts verify
 *   tsx scripts/seed-pms-operational.ts reset
 */

import { supabaseAdmin } from '../src/lib/supabase-admin';
import {
  mergePmsRoomsForDate,
  mergePmsRoomsForStaff,
  composeRoomId,
} from '../src/lib/pms-rooms-server';
import { loadRoomForStaff } from '../src/lib/housekeeper-workflow/auth';
import { writeWorkflowFields } from '../src/lib/housekeeper-workflow/workflow-store';
import { transition } from '../src/lib/housekeeper-workflow/state-machine';
import { applyRoomUpdate } from '../src/lib/pms-rooms-writes';
import { todayStr } from '../src/lib/utils';
import type { Room } from '../src/types';

const PROPERTY_ID = '8a041d6e-d881-4f19-83e0-7250f0e36eaa'; // Comfort Suites Beaumont
const STAFF_ID = 'eeee0000-0000-4000-8000-00000000pms1'.replace('pms1', '0001');
const STAFF_NAME = '__PmsSeed Housekeeper__'; // distinctive → unique name resolution
const R_CHECKOUT = 'SEED9001';
const R_STAYOVER = 'SEED9002';
const R_VACANT = 'SEED9003';
const DATE = todayStr();
const NOW = () => new Date().toISOString();

function ok(label: string) { console.log(`  ✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  process.exit(1);
}
function assert(cond: unknown, label: string, detail?: unknown) { cond ? ok(label) : fail(label, detail); }

async function reset() {
  // Delete only the scratch rows. cleaning_events are keyed by room_number too.
  for (const t of ['pms_housekeeping_assignments', 'pms_room_status_log', 'pms_rooms_inventory', 'pms_reservations', 'cleaning_events'] as const) {
    await supabaseAdmin.from(t).delete().eq('property_id', PROPERTY_ID).in('room_number', [R_CHECKOUT, R_STAYOVER, R_VACANT]);
  }
  await supabaseAdmin.from('staff').delete().eq('id', STAFF_ID);
  console.log('reset: scratch rows removed');
}

async function seed() {
  const syncedAt = NOW();
  // Scratch housekeeper.
  await supabaseAdmin.from('staff').upsert(
    { id: STAFF_ID, property_id: PROPERTY_ID, name: STAFF_NAME, is_active: true },
    { onConflict: 'id' },
  );
  // Inventory.
  await supabaseAdmin.from('pms_rooms_inventory').upsert(
    [
      { property_id: PROPERTY_ID, room_number: R_CHECKOUT, room_type: 'King', last_synced_at: syncedAt },
      { property_id: PROPERTY_ID, room_number: R_STAYOVER, room_type: 'Queen', last_synced_at: syncedAt },
      { property_id: PROPERTY_ID, room_number: R_VACANT, room_type: 'King', last_synced_at: syncedAt },
    ],
    { onConflict: 'property_id,room_number' },
  );
  // Status log (latest-per-room).
  await supabaseAdmin.from('pms_room_status_log').insert([
    { property_id: PROPERTY_ID, room_number: R_CHECKOUT, status: 'vacant_dirty', changed_at: syncedAt, source: 'cua', last_synced_at: syncedAt },
    { property_id: PROPERTY_ID, room_number: R_STAYOVER, status: 'occupied_dirty', changed_at: syncedAt, source: 'cua', last_synced_at: syncedAt },
    { property_id: PROPERTY_ID, room_number: R_VACANT, status: 'vacant_clean', changed_at: syncedAt, source: 'cua', last_synced_at: syncedAt },
  ]);
  // Assignments (checkout + stayover assigned to the scratch HK today; vacant unassigned).
  await supabaseAdmin.from('pms_housekeeping_assignments').upsert(
    [
      { property_id: PROPERTY_ID, date: DATE, room_number: R_CHECKOUT, housekeeper_name: STAFF_NAME, cleaning_type: 'departure', status: 'not_started', last_synced_at: syncedAt },
      { property_id: PROPERTY_ID, date: DATE, room_number: R_STAYOVER, housekeeper_name: STAFF_NAME, cleaning_type: 'stayover', status: 'not_started', last_synced_at: syncedAt },
    ],
    { onConflict: 'property_id,date,room_number' },
  );
  // Reservations: a checkout departing today, a stayover spanning today.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await supabaseAdmin.from('pms_reservations').upsert(
    [
      { property_id: PROPERTY_ID, pms_reservation_id: 'SEED-RES-1', room_number: R_CHECKOUT, guest_name: 'Departing Guest', arrival_date: yesterday, departure_date: DATE, status: 'checked_in' },
      { property_id: PROPERTY_ID, pms_reservation_id: 'SEED-RES-2', room_number: R_STAYOVER, guest_name: 'Staying Guest', arrival_date: yesterday, departure_date: tomorrow, status: 'checked_in' },
    ],
    { onConflict: 'property_id,pms_reservation_id' },
  );
  console.log(`seed: scratch slice written under ${PROPERTY_ID} for ${DATE}`);
}

function find(rooms: Room[], num: string): Room {
  const r = rooms.find((x) => x.number === num);
  if (!r) fail(`room ${num} not found in merge`, rooms.map((x) => x.number));
  return r;
}

async function verify() {
  console.log('verify: AI reads (mergePmsRoomsForDate + occupancy)');
  const day = await mergePmsRoomsForDate(PROPERTY_ID, DATE);
  const co = find(day, R_CHECKOUT), so = find(day, R_STAYOVER), va = find(day, R_VACANT);
  assert(co.type === 'checkout' && co.status === 'dirty', 'checkout room reads as dirty checkout', { type: co.type, status: co.status });
  assert(so.type === 'stayover', 'stayover room reads as stayover', so.type);
  assert(va.status === 'clean', 'vacant_clean room reads as clean', va.status);
  assert(co.assignedTo === STAFF_ID, 'checkout room resolves to the scratch housekeeper', co.assignedTo);

  const { data: counts, error: cErr } = await supabaseAdmin.rpc('today_property_counts_v1', { p_property_id: PROPERTY_ID, p_date: DATE });
  if (cErr) fail('today_property_counts_v1 RPC', cErr.message);
  const row = Array.isArray(counts) ? counts[0] : counts;
  assert((row?.checkouts ?? 0) >= 1, 'occupancy counts include the seeded checkout', row);

  // AI flags an issue → round-trips through the merge.
  const coId = composeRoomId(DATE, R_CHECKOUT);
  await applyRoomUpdate(PROPERTY_ID, coId, { issueNote: 'AC not cooling (seed e2e)' });
  const afterIssue = find(await mergePmsRoomsForDate(PROPERTY_ID, DATE), R_CHECKOUT);
  assert(afterIssue.issueNote === 'AC not cooling (seed e2e)', 'AI-flagged issue is readable back', afterIssue.issueNote);

  console.log('verify: housekeeper Start → Pause → Resume → Done (timers intact)');
  const coId2 = composeRoomId(DATE, R_CHECKOUT);
  const ctx = { pid: PROPERTY_ID, staffId: STAFF_ID, roomId: coId2, requestId: 'seed', headers: {} as Record<string, string> };

  // Start
  let load = await loadRoomForStaff(ctx);
  if (!load.ok) fail('loadRoomForStaff (start)');
  let tr = transition(stateOf(load.room), 'start', NOW());
  if (!tr.ok || !tr.next) fail('transition start', tr.reason);
  await writeWorkflowFields(PROPERTY_ID, coId2, { status: tr.next.status, started_at: tr.next.startedAt, completed_at: null, is_paused: false, paused_at: null, total_paused_seconds: 0 });
  let room = find(await mergePmsRoomsForStaff(PROPERTY_ID, STAFF_ID), R_CHECKOUT);
  assert(room.status === 'in_progress' && !!room.startedAt, 'Start → in_progress with startedAt', { status: room.status, startedAt: room.startedAt });

  // Pause (back-date paused_at 60s so the resume accrues measurable paused time)
  load = await loadRoomForStaff(ctx);
  if (!load.ok) fail('loadRoomForStaff (pause)');
  const pausedAt = new Date(Date.now() - 60_000).toISOString();
  tr = transition(stateOf(load.room), 'pause', pausedAt);
  if (!tr.ok || !tr.next) fail('transition pause', tr.reason);
  await writeWorkflowFields(PROPERTY_ID, coId2, { is_paused: true, paused_at: pausedAt });
  room = find(await mergePmsRoomsForStaff(PROPERTY_ID, STAFF_ID), R_CHECKOUT);
  assert(room.isPaused === true, 'Pause → isPaused', room.isPaused);

  // Resume (accumulates paused seconds)
  load = await loadRoomForStaff(ctx);
  if (!load.ok) fail('loadRoomForStaff (resume)');
  tr = transition(stateOf(load.room), 'resume', NOW());
  if (!tr.ok || !tr.next) fail('transition resume', tr.reason);
  await writeWorkflowFields(PROPERTY_ID, coId2, { is_paused: false, paused_at: null, total_paused_seconds: tr.next.totalPausedSeconds });
  room = find(await mergePmsRoomsForStaff(PROPERTY_ID, STAFF_ID), R_CHECKOUT);
  assert(room.isPaused !== true && (room.totalPausedSeconds ?? 0) >= 59, 'Resume → unpaused with accrued paused seconds', { isPaused: room.isPaused, totalPausedSeconds: room.totalPausedSeconds });

  // Done
  load = await loadRoomForStaff(ctx);
  if (!load.ok) fail('loadRoomForStaff (done)');
  tr = transition(stateOf(load.room), 'complete', NOW());
  if (!tr.ok || !tr.next) fail('transition complete', tr.reason);
  await writeWorkflowFields(PROPERTY_ID, coId2, { status: 'clean', started_at: tr.next.startedAt, completed_at: tr.next.completedAt, is_paused: false, paused_at: null, total_paused_seconds: tr.next.totalPausedSeconds });
  room = find(await mergePmsRoomsForStaff(PROPERTY_ID, STAFF_ID), R_CHECKOUT);
  assert(room.status === 'clean' && !!room.completedAt && (room.totalPausedSeconds ?? 0) >= 59, 'Done → clean with completedAt + preserved paused timer', { status: room.status, completedAt: room.completedAt, totalPausedSeconds: room.totalPausedSeconds });

  // Checklist on the checkout room
  await writeWorkflowFields(PROPERTY_ID, coId2, { checklist_template_id: '11111111-1111-4111-8111-111111111111', checklist_progress: ['bathroom', 'linens'] });
  room = find(await mergePmsRoomsForStaff(PROPERTY_ID, STAFF_ID), R_CHECKOUT);
  assert((room.checklistProgress ?? []).length === 2, 'Checklist progress round-trips', room.checklistProgress);

  // Exception on the stayover room (guest DND)
  console.log('verify: exception (DND) on the stayover room');
  const soId = composeRoomId(DATE, R_STAYOVER);
  const loadSo = await loadRoomForStaff({ ...ctx, roomId: soId });
  if (!loadSo.ok) fail('loadRoomForStaff (exception)');
  const trEx = transition(stateOf(loadSo.room), 'exception', NOW(), 'dnd');
  if (!trEx.ok || !trEx.next) fail('transition exception', trEx.reason);
  await writeWorkflowFields(PROPERTY_ID, soId, { exception_type: 'dnd', exception_at: NOW(), is_dnd: true, is_paused: false, paused_at: null });
  room = find(await mergePmsRoomsForStaff(PROPERTY_ID, STAFF_ID), R_STAYOVER);
  assert(room.exceptionType === 'dnd', 'Exception → exceptionType=dnd persisted', room.exceptionType);

  console.log('verify: ALL e2e assertions passed ✓');
}

// Build the state-machine input from a workflow room row (mirrors the routes).
function stateOf(room: {
  status: string | null; is_paused?: boolean | null; exception_type?: string | null;
  started_at?: string | null; paused_at?: string | null; completed_at?: string | null;
  total_paused_seconds?: number | null;
}) {
  return {
    status: (room.status as 'dirty' | 'in_progress' | 'clean' | 'inspected') ?? 'dirty',
    isPaused: !!room.is_paused,
    exceptionType: (room.exception_type as never) ?? null,
    startedAt: room.started_at ?? null,
    pausedAt: room.paused_at ?? null,
    completedAt: room.completed_at ?? null,
    totalPausedSeconds: room.total_paused_seconds ?? 0,
  };
}

async function main() {
  const mode = process.argv[2] ?? 'all';
  try {
    if (mode === 'seed') { await seed(); }
    else if (mode === 'verify') { await verify(); }
    else if (mode === 'reset') { await reset(); }
    else { await reset(); await seed(); await verify(); await reset(); }
    console.log('\nDONE.');
    process.exit(0);
  } catch (e) {
    console.error('seed-pms-operational failed:', e);
    // Best-effort cleanup so a mid-run failure doesn't leave scratch rows.
    try { await reset(); } catch { /* ignore */ }
    process.exit(1);
  }
}

void main();
