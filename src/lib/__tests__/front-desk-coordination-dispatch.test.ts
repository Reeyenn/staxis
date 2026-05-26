/**
 * Tests for dispatchSMS — the dry-run safety layer.
 *
 * Most critical guarantee: in 'dry_run' mode the function MUST NOT call
 * Twilio. We verify this two ways:
 *
 *   1. Behavioral: stub globalThis.fetch (sendSms uses fetch) and assert
 *      no Twilio URL was hit when the property is in dry_run mode.
 *   2. Auditing: every dispatch (dry_run + live) writes a
 *      notification_events row before any side-effect, so a future
 *      regression that bypasses the mode check still leaves a trail.
 *
 * Supabase is mocked at the supabaseAdmin.from level with a tiny chainable
 * stub. We're not testing PostgREST — only the dispatch logic above it.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchSMS } from '@/lib/front-desk-coordination';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Twilio-fetch spy ──────────────────────────────────────────────────────

interface FetchCall { url: string; }
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];

const ENV_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'TWILIO_PHONE_NUMBER',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

// ─── Supabase admin mock ───────────────────────────────────────────────────
//
// We mock supabaseAdmin.from('<table>') to return a stub whose chain
// (insert/.select/.single/etc.) returns whatever the per-test config
// says. This is enough surface for the dispatch path's queries:
//   - properties.select(sms_notifications_mode).eq(id).maybeSingle()
//   - notification_events.insert({...}).select('id').single()
//   - notification_events.update({...}).eq('id', ...)

interface MockConfig {
  smsMode: 'dry_run' | 'live';
  /** Capture inserts into notification_events for assertion. */
  inserts: Array<Record<string, unknown>>;
  /** Capture updates so we can verify provider_status flows in live mode. */
  updates: Array<{ where: string; fields: Record<string, unknown> }>;
}

let mockCfg: MockConfig;

function makeFrom(table: string): unknown {
  if (table === 'properties') {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { sms_notifications_mode: mockCfg.smsMode },
            error: null,
          }),
        }),
      }),
    };
  }
  if (table === 'notification_events') {
    return {
      insert: (row: Record<string, unknown>) => {
        mockCfg.inserts.push(row);
        return {
          select: () => ({
            single: async () => ({
              data: { id: `audit-${mockCfg.inserts.length}` },
              error: null,
            }),
          }),
        };
      },
      update: (fields: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          mockCfg.updates.push({ where: id, fields });
          return { error: null };
        },
      }),
    };
  }
  throw new Error(`Unexpected from(${table}) in dispatch-sms test mock`);
}

beforeEach(() => {
  fetchCalls = [];
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Default to a fully-configured Twilio env so we can prove dry_run
  // does NOT call it even when it COULD.
  process.env.TWILIO_ACCOUNT_SID = 'AC_test_sid';
  process.env.TWILIO_AUTH_TOKEN = 'auth_token';
  process.env.TWILIO_FROM_NUMBER = '+18445971608';
  delete process.env.TWILIO_PHONE_NUMBER;

  mockCfg = { smsMode: 'dry_run', inserts: [], updates: [] };
  mock.method(supabaseAdmin, 'from', makeFrom);

  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push({ url: String(url) });
    return new Response(
      JSON.stringify({ sid: 'SM_test', status: 'queued' }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  mock.restoreAll();
});

// ─── Dry-run mode ──────────────────────────────────────────────────────────

describe('dispatchSMS — dry_run mode', () => {
  test('writes an audit row but never calls Twilio', async () => {
    mockCfg.smsMode = 'dry_run';
    const result = await dispatchSMS({
      propertyId: '00000000-0000-0000-0000-000000000001',
      eventType: 'room_ready',
      body: 'Room 305 is ready.',
      payload: { room_number: '305' },
      recipients: [
        { staffId: 'staff-1', name: 'Alice', phone: '+15125550100' },
      ],
    });
    assert.equal(result.mode, 'dry_run');
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0].sent, false);
    assert.equal(mockCfg.inserts.length, 1);
    assert.equal(mockCfg.inserts[0].mode, 'dry_run');
    assert.equal(mockCfg.inserts[0].body, 'Room 305 is ready.');
    // The critical guarantee: no Twilio fetch.
    assert.equal(
      fetchCalls.length, 0,
      `dry_run must NOT call Twilio — got ${fetchCalls.length} fetch(s) to: ${fetchCalls.map((c) => c.url).join(', ')}`,
    );
  });

  test('fans out one audit row per recipient', async () => {
    mockCfg.smsMode = 'dry_run';
    await dispatchSMS({
      propertyId: '00000000-0000-0000-0000-000000000001',
      eventType: 'vip_arrival',
      body: 'VIP arriving for room 412.',
      payload: { room_number: '412' },
      recipients: [
        { staffId: 's1', name: 'Alice', phone: '+15125550100' },
        { staffId: 's2', name: 'Bob',   phone: '+15125550200' },
        { staffId: 's3', name: 'Cara',  phone: null }, // no-phone front-desk staff
      ],
    });
    assert.equal(mockCfg.inserts.length, 3);
    assert.equal(fetchCalls.length, 0);
    const names = mockCfg.inserts.map((r) => r.recipient_name);
    assert.deepEqual(names, ['Alice', 'Bob', 'Cara']);
  });

  test('writes a placeholder audit row when no recipients exist', async () => {
    mockCfg.smsMode = 'dry_run';
    await dispatchSMS({
      propertyId: '00000000-0000-0000-0000-000000000001',
      eventType: 'room_ready',
      body: 'Room 100 is ready.',
      payload: { room_number: '100' },
      recipients: [],
    });
    assert.equal(mockCfg.inserts.length, 1);
    assert.equal(mockCfg.inserts[0].recipient_staff_id, null);
    const payload = mockCfg.inserts[0].payload as Record<string, unknown>;
    assert.equal(payload.no_recipients, true);
    assert.equal(fetchCalls.length, 0);
  });

  test('default mode is dry_run when properties row is missing', async () => {
    // Simulate properties row not found by overriding the mock.
    mock.restoreAll();
    const fromOverride = (table: string): unknown => {
      if (table === 'properties') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        };
      }
      return makeFrom(table);
    };
    mock.method(supabaseAdmin, 'from', fromOverride);

    await dispatchSMS({
      propertyId: 'ghost-property',
      eventType: 'room_ready',
      body: 'hi',
      payload: {},
      recipients: [{ staffId: 's1', name: 'Alice', phone: '+15125550100' }],
    });
    assert.equal(mockCfg.inserts.length, 1);
    assert.equal(mockCfg.inserts[0].mode, 'dry_run');
    assert.equal(fetchCalls.length, 0);
  });
});

// ─── Live mode ─────────────────────────────────────────────────────────────

describe('dispatchSMS — live mode', () => {
  test('calls Twilio AND writes the audit row', async () => {
    mockCfg.smsMode = 'live';
    const result = await dispatchSMS({
      propertyId: '00000000-0000-0000-0000-000000000001',
      eventType: 'room_ready',
      body: 'Room 305 is ready.',
      payload: { room_number: '305' },
      recipients: [
        { staffId: 's1', name: 'Alice', phone: '+15125550100' },
      ],
    });
    assert.equal(result.mode, 'live');
    assert.equal(result.outcomes[0].sent, true);
    assert.equal(mockCfg.inserts.length, 1);
    assert.equal(mockCfg.inserts[0].mode, 'live');
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /api\.twilio\.com\/.*\/Messages\.json$/);
    // The audit row gets updated to 'sent' on success.
    const sentUpdate = mockCfg.updates.find((u) => u.fields.provider_status === 'sent');
    assert.ok(sentUpdate, 'expected provider_status=sent update on live success');
  });

  test('skips Twilio (and records error) for a recipient without a phone', async () => {
    mockCfg.smsMode = 'live';
    const result = await dispatchSMS({
      propertyId: '00000000-0000-0000-0000-000000000001',
      eventType: 'room_ready',
      body: 'Room 305 is ready.',
      payload: {},
      recipients: [{ staffId: 's1', name: 'Alice', phone: null }],
    });
    assert.equal(fetchCalls.length, 0);
    assert.equal(result.outcomes[0].sent, false);
    assert.equal(result.outcomes[0].errorText, 'recipient_missing_phone');
  });

  test('still writes the audit row + records error_text when Twilio fails', async () => {
    mockCfg.smsMode = 'live';
    // Override fetch to fail.
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ message: 'Twilio rejected', code: 30007 }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch;

    const result = await dispatchSMS({
      propertyId: '00000000-0000-0000-0000-000000000001',
      eventType: 'walk_in',
      body: 'walk-in routed.',
      payload: {},
      recipients: [{ staffId: 's1', name: 'Alice', phone: '+15125550100' }],
    });
    assert.equal(result.outcomes[0].sent, false);
    assert.ok(
      result.outcomes[0].errorText && result.outcomes[0].errorText.length > 0,
      'expected errorText to surface the Twilio failure',
    );
    assert.equal(mockCfg.inserts.length, 1);
    const failedUpdate = mockCfg.updates.find((u) => u.fields.provider_status === 'failed');
    assert.ok(failedUpdate, 'expected provider_status=failed update on live failure');
  });

  // ── Codex adversarial regression tests ──────────────────────────────────

  test('Codex Critical fix: audit insert failure in live mode does NOT call Twilio', async () => {
    mockCfg.smsMode = 'live';
    // Override the audit insert to return an error so insertAudit() → null.
    mock.restoreAll();
    const fromBroken = (table: string): unknown => {
      if (table === 'properties') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { sms_notifications_mode: 'live' }, error: null }) }),
          }),
        };
      }
      if (table === 'notification_events') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: null, error: { message: 'DB write failed' } }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      throw new Error(`Unexpected from(${table})`);
    };
    mock.method(supabaseAdmin, 'from', fromBroken);

    const result = await dispatchSMS({
      propertyId: '00000000-0000-0000-0000-000000000001',
      eventType: 'room_ready',
      body: 'Room 305 is ready.',
      payload: {},
      recipients: [{ staffId: 's1', name: 'Alice', phone: '+15125550100' }],
    });
    assert.equal(result.outcomes[0].sent, false);
    assert.equal(result.outcomes[0].errorText, 'audit_insert_failed');
    assert.equal(
      fetchCalls.length, 0,
      'live mode + audit insert failure must NOT fire Twilio',
    );
  });

  test('Codex Major fix: property flipped to dry_run mid-send cancels the Twilio call', async () => {
    // First mode read returns 'live', second read (right before send)
    // returns 'dry_run'. We expect: audit row written with mode='live'
    // (snapshot), Twilio NOT called, audit patched with cancelled status.
    let propertyReads = 0;
    mock.restoreAll();
    const fromFlipping = (table: string): unknown => {
      if (table === 'properties') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                propertyReads += 1;
                return {
                  data: { sms_notifications_mode: propertyReads === 1 ? 'live' : 'dry_run' },
                  error: null,
                };
              },
            }),
          }),
        };
      }
      if (table === 'notification_events') {
        return {
          insert: (row: Record<string, unknown>) => {
            mockCfg.inserts.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: { id: `audit-${mockCfg.inserts.length}` },
                  error: null,
                }),
              }),
            };
          },
          update: (fields: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              mockCfg.updates.push({ where: id, fields });
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`Unexpected from(${table})`);
    };
    mock.method(supabaseAdmin, 'from', fromFlipping);

    await dispatchSMS({
      propertyId: '00000000-0000-0000-0000-000000000001',
      eventType: 'vip_arrival',
      body: 'VIP arriving.',
      payload: {},
      recipients: [{ staffId: 's1', name: 'Alice', phone: '+15125550100' }],
    });
    assert.equal(fetchCalls.length, 0, 'mode-flip mid-send must cancel the Twilio call');
    const cancelledUpdate = mockCfg.updates.find(
      (u) => u.fields.provider_status === 'cancelled',
    );
    assert.ok(cancelledUpdate, 'expected provider_status=cancelled patch on the audit row');
    // The audit row's snapshotted mode is still 'live' (intentional —
    // historical record of what the route believed at dispatch time).
    assert.equal(mockCfg.inserts[0].mode, 'live');
  });
});
