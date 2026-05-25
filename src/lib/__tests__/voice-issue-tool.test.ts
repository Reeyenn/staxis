/**
 * Tests for src/lib/agent/tools/voice-issue.ts — the createMaintenanceWorkOrder
 * tool that powers the housekeeper voice issue button (feature #11).
 *
 * What we pin here:
 *
 *   1. **Validation refuses garbage.** `action` is a closed enum, `item` is
 *      required, severity defaults to MINOR when the agent omits it.
 *
 *   2. **Room hint fallback.** When the agent omits `room_number`, the tool
 *      falls back to `ctx.currentRoomNumber` (the UI hint set on session
 *      mint). This lets the housekeeper tap the mic on room 305 and just
 *      say "the sink is broken" without restating the room number.
 *
 *   3. **Mode + surface gate.** The tool only runs under
 *      surface='voice' + voiceMode='housekeeper_issue'. Chat callers and
 *      general voice callers see "not available on this surface / mode."
 *      Belt-and-braces against a tool-list leak into the wrong context.
 *
 *   4. **Floor-role scope.** A housekeeper assigned to a different room
 *      can't file an issue for the wrong room. Mirrors flag_issue.
 *
 * Strategy: stub `supabaseAdmin.from` per-table — exactly the pattern used
 * in voice-session.test.ts, so the test never hits a real Supabase.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { executeTool, type ToolContext } from '@/lib/agent/tools';
// Side-effect: register all tools (including createMaintenanceWorkOrder).
import '@/lib/agent/tools/index';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Fixtures ────────────────────────────────────────────────────────────

const STAFF_ID = '00000000-0000-0000-0000-000000000010';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000011';
const PROPERTY_ID = '00000000-0000-0000-0000-000000000012';
const ROOM_ID = '00000000-0000-0000-0000-000000000013';

interface RoomRow {
  id: string;
  property_id: string;
  number: string;
  status: string;
  date: string | null;
  assigned_to: string | null;
  is_dnd: boolean;
  dnd_note: string | null;
  issue_note: string | null;
  help_requested: boolean;
  started_at: string | null;
  completed_at: string | null;
  type: 'checkout' | 'stayover' | 'vacant' | null;
}

let roomRow: RoomRow | null = null;
const insertedIssues: Array<Record<string, unknown>> = [];
// Used by the idempotency test to simulate a 23505 unique_violation on
// the partial unique index on staxis_voice_issues.voice_session_id.
let nextInsertError: { code?: string; message?: string } | null = null;
// Used by the idempotency test as the row returned by the post-conflict
// SELECT — i.e. the already-stored ticket for this voice session.
// Widened: the idempotent-retry test hydrates response fields from the
// stored row, so the lookup may return room_number + voice_metadata too.
let existingIssueRow: Record<string, unknown> | null = null;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

beforeEach(() => {
  // Default: room 305 unassigned, dirty.
  roomRow = {
    id: ROOM_ID,
    property_id: PROPERTY_ID,
    number: '305',
    status: 'dirty',
    date: '2026-05-24',
    assigned_to: null,
    is_dnd: false,
    dnd_note: null,
    issue_note: null,
    help_requested: false,
    started_at: null,
    completed_at: null,
    type: 'checkout',
  };
  insertedIssues.length = 0;
  nextInsertError = null;
  existingIssueRow = null;

  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => buildTableStub(table);
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

function buildTableStub(table: string) {
  if (table === 'rooms') {
    // findRoomByNumber: select … from rooms where property=? and number=? order by date desc limit 1
    return {
      select: (_cols: string) => ({
        eq: (_col1: string, _v1: string) => ({
          eq: (_col2: string, _v2: string) => ({
            order: (_col3: string, _opts: unknown) => ({
              limit: async (_n: number) => ({
                data: roomRow ? [roomRow] : [],
                error: null,
              }),
            }),
          }),
        }),
      }),
      // The mirror update onto rooms.issue_note — no-op stub.
      update: (_patch: Record<string, unknown>) => ({
        eq: async (_col: string, _v: string) => ({ data: null, error: null }),
      }),
    };
  }
  if (table === 'pms_work_orders_v2') {
    // Migration 0225 unified the voice-issue write path into
    // pms_work_orders_v2. The tool inserts a row with source='housekeeper_voice'
    // and a voice_metadata jsonb blob; the post-conflict lookup queries by
    // voice_session_id (partial unique index).
    return {
      insert: (row: Record<string, unknown>) => ({
        select: (_cols: string) => ({
          single: async () => {
            if (nextInsertError) {
              const err = nextInsertError;
              nextInsertError = null; // one-shot
              return { data: null, error: err };
            }
            insertedIssues.push(row);
            return { data: { id: 'issue-id-stub' }, error: null };
          },
        }),
      }),
      select: (_cols: string) => ({
        eq: (_col: string, _v: string) => ({
          maybeSingle: async () => ({ data: existingIssueRow, error: null }),
        }),
      }),
    };
  }
  throw new Error(`unexpected table in stub: ${table}`);
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    user: {
      uid: '00000000-0000-0000-0000-000000000020',
      accountId: ACCOUNT_ID,
      username: 'maria',
      displayName: 'Maria',
      role: 'housekeeping',
      propertyAccess: [PROPERTY_ID],
    },
    propertyId: PROPERTY_ID,
    staffId: STAFF_ID,
    requestId: 'test-request',
    surface: 'voice',
    voiceMode: 'housekeeper_issue',
    currentRoomNumber: '305',
    voiceSessionId: '00000000-0000-0000-0000-000000000099',
    ...overrides,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────

describe('createMaintenanceWorkOrder — validation', () => {
  test('refuses an unknown action', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'EXPLODE', item: 'sink' },
      makeCtx(),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /action must be one of/);
  });

  test('requires item', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: '   ' },
      makeCtx(),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /item is required/);
  });

  test('defaults severity to MINOR (priority=low) when omitted', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx(),
    );
    assert.equal(r.ok, true);
    assert.equal(insertedIssues.length, 1);
    // Severity lives inside voice_metadata since migration 0225.
    const row = insertedIssues[0]!;
    const meta = row.voice_metadata as { severity?: string };
    assert.equal(meta.severity, 'MINOR');
    // Mapped onto pms_work_orders_v2.priority — MINOR → low.
    assert.equal(row.priority, 'low');
    assert.equal(row.source, 'housekeeper_voice');
  });

  test('severity URGENT maps to priority=urgent', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', severity: 'URGENT' },
      makeCtx(),
    );
    assert.equal(r.ok, true);
    assert.equal(insertedIssues[0]!.priority, 'urgent');
  });

  test('severity MAJOR maps to priority=high (broken equipment must reach critical reports)', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', severity: 'MAJOR' },
      makeCtx(),
    );
    assert.equal(r.ok, true);
    // Codex 2026-05-25 MAJOR fix: MAJOR previously mapped to 'medium'
    // which fell outside src/lib/reports/aggregate.ts's critical filter
    // (urgent + high only) — broken in-room equipment disappeared from
    // the dashboard's critical-pending count.
    assert.equal(insertedIssues[0]!.priority, 'high');
  });

  test('caps a runaway note at 300 chars (note lives in voice_metadata)', async () => {
    const longNote = 'x'.repeat(5000);
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', note: longNote },
      makeCtx(),
    );
    assert.equal(r.ok, true);
    const meta = insertedIssues[0]!.voice_metadata as { note?: string };
    assert.equal((meta.note ?? '').length, 300);
  });

  test('writes a deterministic pms_work_order_id derived from voice_session_id (idempotency anchor)', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx({ voiceSessionId: '00000000-0000-0000-0000-000000000099' }),
    );
    assert.equal(r.ok, true);
    assert.equal(
      insertedIssues[0]!.pms_work_order_id,
      'staxis-voice-00000000-0000-0000-0000-000000000099',
    );
  });

  test('packs forensic fields into voice_metadata', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      {
        action: 'REPAIR',
        item: 'sink',
        location_detail: 'bathroom',
        severity: 'URGENT',
        note: 'water leaking',
        original_language: 'tl',
        original_transcription: 'Ang lababo ay sira sa banyo',
      },
      makeCtx(),
    );
    assert.equal(r.ok, true);
    const meta = insertedIssues[0]!.voice_metadata as {
      action?: string;
      item?: string;
      location_detail?: string;
      severity?: string;
      note?: string;
      original_language?: string;
      original_transcription?: string;
    };
    assert.equal(meta.action, 'REPAIR');
    assert.equal(meta.item, 'sink');
    assert.equal(meta.location_detail, 'bathroom');
    assert.equal(meta.severity, 'URGENT');
    assert.equal(meta.note, 'water leaking');
    assert.equal(meta.original_language, 'tl');
    assert.equal(meta.original_transcription, 'Ang lababo ay sira sa banyo');
    // Description is the human-readable summary.
    assert.match(insertedIssues[0]!.description as string, /REPAIR sink \(bathroom\) — water leaking/);
  });
});

// ─── Room hint fallback ──────────────────────────────────────────────────

describe('createMaintenanceWorkOrder — room hint fallback', () => {
  test('uses ctx.currentRoomNumber when the agent omits room_number', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx({ currentRoomNumber: '305' }),
    );
    assert.equal(r.ok, true);
    assert.equal(insertedIssues[0]!.room_number, '305');
  });

  test('arg room_number wins over the hint when both are present', async () => {
    // Stub the rooms table for the explicit room number — same fixture
    // works since findRoomByNumber returns whatever roomRow we set.
    roomRow!.number = '410';
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', room_number: '410' },
      makeCtx({ currentRoomNumber: '305' }),
    );
    assert.equal(r.ok, true);
    assert.equal(insertedIssues[0]!.room_number, '410');
  });

  test('floor role + room not found in DB → refused (Codex 2026-05-25 MAJOR fix)', async () => {
    // findRoomByNumber returns []; the housekeeper can't file against a
    // room that isn't on their assignment list.
    roomRow = null;
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', room_number: '999' },
      makeCtx({ currentRoomNumber: null }),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /assignment list/);
    assert.equal(insertedIssues.length, 0);
  });

  test('manager-tier role + room not found → still inserts the ticket', async () => {
    roomRow = null;
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', room_number: '999' },
      makeCtx({
        currentRoomNumber: null,
        user: {
          uid: '00000000-0000-0000-0000-000000000020',
          accountId: ACCOUNT_ID,
          username: 'gm',
          displayName: 'GM',
          role: 'general_manager',
          propertyAccess: [PROPERTY_ID],
        },
      }),
    );
    assert.equal(r.ok, true);
    assert.equal(insertedIssues[0]!.room_number, '999');
  });

  test('floor role with no room number and no UI hint → refused', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx({ currentRoomNumber: null }),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /confirm which room/);
    assert.equal(insertedIssues.length, 0);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────

describe('createMaintenanceWorkOrder — idempotency (Codex 2026-05-25 MAJOR fix)', () => {
  test('a unique-violation on voice_session_id returns the existing ticket instead of erroring', async () => {
    // Simulate the partial unique index on (voice_session_id) catching a
    // duplicate insert and Postgres throwing 23505. The tool must swallow
    // the error and SELECT the already-stored row.
    nextInsertError = { code: '23505', message: 'unique_violation' };
    existingIssueRow = { id: 'pre-existing-issue-id' };

    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx(),
    );
    assert.equal(r.ok, true);
    const data = r.data as { issue_id: string; idempotent: boolean };
    assert.equal(data.issue_id, 'pre-existing-issue-id');
    assert.equal(data.idempotent, true);
    // No new row should have been inserted on the conflict path.
    assert.equal(insertedIssues.length, 0);
  });

  test('idempotent retry returns the STORED ticket fields, not the retry\'s caller-supplied ones', async () => {
    // Codex 2026-05-25 adversarial gate (MAJOR fix): a retried call with
    // different fields used to get a response describing its own fields,
    // not what was actually saved. Now the response is hydrated from the
    // stored row's voice_metadata + room_number.
    nextInsertError = { code: '23505', message: 'unique_violation' };
    existingIssueRow = {
      id: 'pre-existing-issue-id',
      room_number: '410',
      voice_metadata: {
        action: 'REPLACE',
        item: 'TV',
        location_detail: 'above the bed',
        severity: 'URGENT',
        note: 'cracked screen',
        original_language: 'es',
      },
    };

    // Retry passes DIFFERENT fields — the response must echo the STORED
    // ones (410 / REPLACE / TV / URGENT / "cracked screen"), not the
    // retry's (305 / REPAIR / sink / MINOR / null).
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', severity: 'MINOR' },
      makeCtx({ currentRoomNumber: '305' }),
    );
    assert.equal(r.ok, true);
    const data = r.data as {
      idempotent: boolean;
      room_number: string;
      action: string;
      item: string;
      severity: string;
      note: string | null;
    };
    assert.equal(data.idempotent, true);
    assert.equal(data.room_number, '410');
    assert.equal(data.action, 'REPLACE');
    assert.equal(data.item, 'TV');
    assert.equal(data.severity, 'URGENT');
    assert.equal(data.note, 'cracked screen');
  });

  test('a generic insert error is still surfaced as a hard failure', async () => {
    nextInsertError = { code: '99999', message: 'transient' };
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx(),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /transient|maintenance ticket/);
  });
});

// ─── Issue-note mirror — non-clobber ─────────────────────────────────────

describe('createMaintenanceWorkOrder — rooms.issue_note mirror', () => {
  test('skips the mirror update when the room already has an issue_note (Codex MAJOR fix)', async () => {
    // Track update calls on the rooms table.
    const roomUpdates: Array<Record<string, unknown>> = [];
    const orig = supabaseAdmin.from.bind(supabaseAdmin);
    // @ts-expect-error monkey-patch
    supabaseAdmin.from = (table: string) => {
      if (table === 'rooms') {
        return {
          select: (_cols: string) => ({
            eq: (_c1: string, _v1: string) => ({
              eq: (_c2: string, _v2: string) => ({
                order: (_c3: string, _o: unknown) => ({
                  limit: async (_n: number) => ({
                    data: [{ ...roomRow!, issue_note: 'previous issue still pending' }],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async (_col: string, _v: string) => {
              roomUpdates.push(patch);
              return { data: null, error: null };
            },
          }),
        };
      }
      // Fall through to the default stub for the other tables.
      return buildTableStub(table);
    };

    try {
      const r = await executeTool(
        'createMaintenanceWorkOrder',
        { action: 'REPAIR', item: 'sink' },
        makeCtx(),
      );
      assert.equal(r.ok, true);
      assert.equal(roomUpdates.length, 0, 'must not overwrite a non-empty issue_note');
    } finally {
      supabaseAdmin.from = orig;
    }
  });
});

// ─── Surface + mode gate ─────────────────────────────────────────────────

describe('createMaintenanceWorkOrder — surface/mode gate', () => {
  test('rejected from the chat surface', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx({ surface: 'chat', voiceMode: undefined }),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /not available on the chat surface/);
  });

  test('rejected in general voice mode', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx({ voiceMode: 'general' }),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /not available in this voice mode/);
  });

  test('allowed in housekeeper_issue voice mode', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx({ voiceMode: 'housekeeper_issue' }),
    );
    assert.equal(r.ok, true);
  });
});

// ─── Floor-role scope ────────────────────────────────────────────────────

describe('createMaintenanceWorkOrder — floor-role scope', () => {
  test('housekeeper assigned to another room cannot file for THIS room', async () => {
    // Room 305 is assigned to a DIFFERENT staff member.
    roomRow!.assigned_to = '00000000-0000-0000-0000-0000000000FF';
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', room_number: '305' },
      makeCtx(),
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /assigned to a different/);
  });

  test('manager-tier role bypasses the floor-role check', async () => {
    roomRow!.assigned_to = '00000000-0000-0000-0000-0000000000FF';
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', room_number: '305' },
      makeCtx({
        user: {
          uid: '00000000-0000-0000-0000-000000000020',
          accountId: ACCOUNT_ID,
          username: 'gm',
          displayName: 'GM',
          role: 'general_manager',
          propertyAccess: [PROPERTY_ID],
        },
      }),
    );
    assert.equal(r.ok, true);
  });
});

// ─── Dry-run gate ────────────────────────────────────────────────────────

describe('createMaintenanceWorkOrder — dry-run', () => {
  test('dryRun=true returns synthetic success and writes nothing', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPLACE', item: 'lamp', severity: 'MINOR' },
      makeCtx({ dryRun: true }),
    );
    assert.equal(r.ok, true);
    assert.equal(insertedIssues.length, 0, 'dryRun must not insert');
    const data = r.data as { dryRun: boolean; room_number: string; action: string };
    assert.equal(data.dryRun, true);
    assert.equal(data.room_number, '305');
    assert.equal(data.action, 'REPLACE');
  });
});
