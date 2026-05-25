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
const insertErrors: { message?: string } | null = null;

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
  if (table === 'staxis_voice_issues') {
    return {
      insert: (row: Record<string, unknown>) => ({
        select: (_cols: string) => ({
          single: async () => {
            if (insertErrors) return { data: null, error: insertErrors };
            insertedIssues.push(row);
            return { data: { id: 'issue-id-stub' }, error: null };
          },
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

  test('defaults severity to MINOR when omitted', async () => {
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink' },
      makeCtx(),
    );
    assert.equal(r.ok, true);
    assert.equal(insertedIssues.length, 1);
    assert.equal(insertedIssues[0]!.severity, 'MINOR');
  });

  test('caps a runaway note at 300 chars', async () => {
    const longNote = 'x'.repeat(5000);
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', note: longNote },
      makeCtx(),
    );
    assert.equal(r.ok, true);
    const stored = insertedIssues[0]!.note as string;
    assert.equal(stored.length, 300);
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

  test('no room found in DB — still inserts the ticket with the raw room number', async () => {
    // findRoomByNumber returns []
    roomRow = null;
    const r = await executeTool(
      'createMaintenanceWorkOrder',
      { action: 'REPAIR', item: 'sink', room_number: '999' },
      makeCtx({ currentRoomNumber: null }),
    );
    assert.equal(r.ok, true);
    assert.equal(insertedIssues[0]!.room_number, '999');
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
