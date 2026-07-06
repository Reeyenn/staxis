/**
 * Tests for the AI-activity review feed — the read side of the approval gate
 * (migration 0300, agent_pending_actions) that powers the manager-only
 * "AI activity" pop-up.
 *
 * Two layers, matching the codebase's split between pure logic and auth-wrapped
 * routes:
 *
 *   1. PURE MAPPING (src/lib/agent/activity.ts) — outcomeForStatus, mapActivityRows,
 *      groupByDay. This is the "rendering-level" coverage: there are no component
 *      tests in this repo (server-only node:test), so we pin the exact view model
 *      the client renders from — bilingual summaries, the status→outcome badge,
 *      error-only-on-failed, and day grouping.
 *
 *   2. ROUTE AUTH + PAGINATION (GET /api/agent/activity) — the three gates:
 *      non-manager → 403, wrong property → 403, and the hasMore/offset paging
 *      contract of fetchActivity. Auth is exercised for real by monkey-patching
 *      supabaseAdmin (the same idiom pms-save-credentials.test.ts uses) so the
 *      request flows through requireSession → validateDeviceTrust →
 *      userHasPropertyAccess → canManageTeam.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  outcomeForStatus,
  mapActivityRows,
  groupByDay,
  fetchActivity,
  type ActivityItem,
} from '@/lib/agent/activity';
import { GET } from '@/app/api/agent/activity/route';

const PID = '22222222-2222-2222-2222-222222222222';
const OTHER_PID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const ACCT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ─── 1. PURE MAPPING ────────────────────────────────────────────────────────

describe('outcomeForStatus', () => {
  test('maps each terminal status to its badge outcome', () => {
    assert.equal(outcomeForStatus('executed'), 'done');
    assert.equal(outcomeForStatus('denied'), 'denied');
    assert.equal(outcomeForStatus('expired'), 'expired');
    assert.equal(outcomeForStatus('failed'), 'failed');
  });
  test('pending / approved / unknown all read as pending', () => {
    assert.equal(outcomeForStatus('pending'), 'pending');
    assert.equal(outcomeForStatus('approved'), 'pending');
    assert.equal(outcomeForStatus('weird'), 'pending');
  });
});

describe('mapActivityRows', () => {
  const nameFor = (id: string) => (id === ACCT_A ? 'Maria Garcia' : id === ACCT_B ? 'Sam Lee' : 'Staxis');

  test('builds bilingual summaries + who + outcome from a row', () => {
    const [item] = mapActivityRows(
      [{
        id: 'r1', account_id: ACCT_A, tool_name: 'send_message',
        tool_args: { recipient: 'Ana', message: 'hola' },
        status: 'executed', error: null, created_at: '2026-07-05T10:00:00.000Z',
      }],
      nameFor,
    );
    assert.equal(item.who, 'Maria Garcia');
    assert.equal(item.outcome, 'done');
    // Real EN/ES from buildActionSummary — not a generic "Run <tool>".
    assert.match(item.summary.en, /Send Ana this message/);
    assert.match(item.summary.es, /Enviar a Ana/);
    assert.equal(item.error, null);
  });

  test('surfaces the error string ONLY for failed rows', () => {
    const rows = mapActivityRows(
      [
        { id: 'f', account_id: ACCT_B, tool_name: 'send_message', tool_args: {}, status: 'failed', error: 'twilio 500', created_at: '2026-07-05T09:00:00.000Z' },
        { id: 'd', account_id: ACCT_B, tool_name: 'send_message', tool_args: {}, status: 'denied', error: 'declined by user', created_at: '2026-07-05T09:00:00.000Z' },
      ],
      nameFor,
    );
    assert.equal(rows[0].error, 'twilio 500');
    // A denied row carries a housekeeping note in .error — it must NOT leak to
    // the manager as an execution error.
    assert.equal(rows[1].error, null);
  });

  test('unknown account falls back to a neutral name (never blank)', () => {
    const [item] = mapActivityRows(
      [{ id: 'r', account_id: 'ghost', tool_name: 'mark_room_clean', tool_args: { roomNumber: '101' }, status: 'executed', error: null, created_at: '2026-07-05T10:00:00.000Z' }],
      nameFor,
    );
    assert.equal(item.who, 'Staxis');
  });
});

describe('groupByDay', () => {
  test('groups newest-first items into Today / Yesterday / dated buckets, preserving order', () => {
    const now = new Date();
    const today = new Date(now.getTime() - 60_000).toISOString();
    const yesterday = new Date(now.getTime() - 26 * 3_600_000).toISOString();
    const older = new Date(now.getTime() - 5 * 86_400_000).toISOString();
    const items: ActivityItem[] = [today, yesterday, older].map((createdAt, i) => ({
      id: `i${i}`, createdAt, who: 'X', toolName: 'send_message',
      outcome: 'done', summary: { en: 'x', es: 'x' }, error: null,
    }));
    const en = groupByDay(items, 'en');
    assert.equal(en.length, 3);
    assert.equal(en[0].label, 'Today');
    assert.equal(en[1].label, 'Yesterday');
    assert.equal(en[0].items[0].id, 'i0'); // order preserved

    const es = groupByDay(items, 'es');
    assert.equal(es[0].label, 'Hoy');
    assert.equal(es[1].label, 'Ayer');
  });

  test('same-day items collapse into one group', () => {
    const base = Date.now();
    const items: ActivityItem[] = [0, 1, 2].map((n) => ({
      id: `i${n}`, createdAt: new Date(base - n * 60_000).toISOString(), who: 'X',
      toolName: 'send_message', outcome: 'done', summary: { en: 'x', es: 'x' }, error: null,
    }));
    const groups = groupByDay(items, 'en');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 3);
  });
});

// ─── 2. fetchActivity — pagination + name resolution ────────────────────────

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

/** Build a supabaseAdmin.from stub over an in-memory activity store + accounts
 *  map, supporting exactly the chains fetchActivity uses:
 *    agent_pending_actions: .select().eq('property_id').order().range(a,b)
 *    accounts:              .select().in('id', ids)
 */
function installActivityStore(rows: Array<Record<string, unknown>>, accounts: Record<string, { display_name: string | null; username: string | null }>) {
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    if (table === 'agent_pending_actions') {
      let pid: string | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => { if (col === 'property_id') pid = val as string; return builder; },
        order: () => builder,
        range: async (from: number, to: number) => {
          const filtered = rows
            .filter((r) => r.property_id === pid)
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
          return { data: filtered.slice(from, to + 1), error: null };
        },
      };
      return builder;
    }
    if (table === 'accounts') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: async (_col: string, ids: string[]) => ({
          data: ids.filter((id) => accounts[id]).map((id) => ({ id, ...accounts[id] })),
          error: null,
        }),
      };
      return builder;
    }
    throw new Error(`unexpected table ${table}`);
  };
}

describe('fetchActivity pagination', () => {
  afterEach(() => { supabaseAdmin.from = originalFrom; });

  function makeRows(n: number, propertyId = PID) {
    return Array.from({ length: n }, (_, i) => ({
      id: `pa-${i}`,
      account_id: i % 2 === 0 ? ACCT_A : ACCT_B,
      tool_name: 'send_message',
      tool_args: { recipient: 'Ana', message: `m${i}` },
      status: 'executed',
      error: null,
      // Descending timestamps so index 0 is newest.
      created_at: new Date(Date.UTC(2026, 6, 5, 12, 0, 0) - i * 60_000).toISOString(),
      property_id: propertyId,
    }));
  }

  test('hasMore=true when more than a page exists; page is capped at limit', async () => {
    installActivityStore(makeRows(60), {
      [ACCT_A]: { display_name: 'Maria Garcia', username: 'maria' },
      [ACCT_B]: { display_name: 'Sam Lee', username: 'sam' },
    });
    const page = await fetchActivity({ propertyId: PID, limit: 50, offset: 0 });
    assert.equal(page.items.length, 50, 'returns exactly one page');
    assert.equal(page.hasMore, true, 'a 60th row means there is more');
    // Newest first + names resolved.
    assert.equal(page.items[0].id, 'pa-0');
    assert.equal(page.items[0].who, 'Maria Garcia');
  });

  test('hasMore=false on the last page; offset advances into the tail', async () => {
    installActivityStore(makeRows(60), {
      [ACCT_A]: { display_name: 'Maria Garcia', username: 'maria' },
      [ACCT_B]: { display_name: 'Sam Lee', username: 'sam' },
    });
    const tail = await fetchActivity({ propertyId: PID, limit: 50, offset: 50 });
    assert.equal(tail.items.length, 10, 'the remaining 10 rows');
    assert.equal(tail.hasMore, false, 'no further page after the tail');
    assert.equal(tail.items[0].id, 'pa-50');
  });

  test('scopes strictly to the property (never leaks another hotel)', async () => {
    installActivityStore(
      [...makeRows(3, PID), ...makeRows(3, OTHER_PID)],
      { [ACCT_A]: { display_name: 'Maria Garcia', username: 'maria' }, [ACCT_B]: { display_name: 'Sam Lee', username: 'sam' } },
    );
    const page = await fetchActivity({ propertyId: PID, limit: 50, offset: 0 });
    assert.equal(page.items.length, 3);
    assert.equal(page.hasMore, false);
  });
});

// ─── 3. ROUTE AUTH — 403s ───────────────────────────────────────────────────

type GetUserFn = typeof supabaseAdmin.auth.getUser;
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

// Test-tunable account state read by validateDeviceTrust + userHasPropertyAccess
// + loadAgentUserCtx.
let acctRole = 'general_manager';
let acctAccess: string[] = [PID];

/** from() stub for the ROUTE path: satisfies the 2FA gate (accounts +
 *  trusted_devices), userHasPropertyAccess (accounts), loadAgentUserCtx
 *  (accounts + staff), and the activity read (empty). */
function installRouteFrom() {
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      in: async () => ({ data: [], error: null }),
      order: () => builder,
      range: async () => ({ data: [], error: null }),
      maybeSingle: async () => {
        if (table === 'accounts') {
          return { data: { id: ACCT_A, username: 'gm', display_name: 'GM', skip_2fa: false, role: acctRole, property_access: acctAccess, data_user_id: USER_ID }, error: null };
        }
        if (table === 'trusted_devices') {
          return { data: { id: 'dev', expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), absolute_expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString() }, error: null };
        }
        if (table === 'staff') {
          return { data: { id: 'staff-1', department: null }, error: null };
        }
        return { data: null, error: null };
      },
    };
    return builder;
  };
}

function makeRequest(qs: string): NextRequest {
  const headers = new Headers({ authorization: 'Bearer test-jwt', 'content-type': 'application/json' });
  const cookies = new Map<string, { value: string }>([['staxis_device', { value: 'a'.repeat(64) }]]);
  return {
    url: `https://staxis.test/api/agent/activity${qs}`,
    method: 'GET',
    headers,
    cookies: { get: (name: string) => cookies.get(name) ?? undefined },
    json: async () => ({}),
    signal: undefined,
  } as unknown as NextRequest;
}

describe('GET /api/agent/activity — auth gates', () => {
  beforeEach(() => {
    acctRole = 'general_manager';
    acctAccess = [PID];
    supabaseAdmin.auth.getUser = (async () => ({ data: { user: { id: USER_ID, email: 'gm@hotel.test' } }, error: null })) as unknown as GetUserFn;
    installRouteFrom();
  });
  afterEach(() => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.auth.getUser = originalGetUser;
  });

  test('a non-manager role is refused with 403', async () => {
    acctRole = 'housekeeping'; // has property access, but not manager-tier
    const res = await GET(makeRequest(`?pid=${PID}`));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'forbidden');
  });

  test('a manager without access to THIS property is refused with 403', async () => {
    acctRole = 'owner';
    acctAccess = [OTHER_PID]; // owner, but not of the requested property
    const res = await GET(makeRequest(`?pid=${PID}`));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'forbidden');
  });

  test('a missing / malformed pid is a 400 (not a 500)', async () => {
    const res = await GET(makeRequest(''));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'validation_failed');
  });

  test('a manager of the property is allowed (200 + envelope)', async () => {
    const res = await GET(makeRequest(`?pid=${PID}`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.data.items));
    assert.equal(body.data.hasMore, false);
  });
});
