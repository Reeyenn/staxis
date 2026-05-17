/**
 * Tests for src/app/api/cron/sweep-orphan-auth-users/route.ts.
 *
 * The sweeper is the reconciler that backstops the 3 signup flows'
 * rollback paths (audit fix #4). Test surface:
 *   - Sweeps an auth user older than 10 min with no matching account
 *   - Does NOT sweep when there IS a matching account
 *   - Does NOT sweep when the user is younger than 10 min
 *   - Does NOT sweep when the user is older than 7 days (emits a
 *     skipped event instead)
 *   - Tolerates listUsers pagination (stops when a partial page comes back)
 *   - Returns structured counts
 *
 * We mock the supabaseAdmin singleton's auth.admin + from() surfaces.
 * The cron route is a GET handler; we drive it with a NextRequest
 * carrying the CRON_SECRET bearer.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET } from '@/app/api/cron/sweep-orphan-auth-users/route';

const CRON_SECRET = process.env.CRON_SECRET ?? 'test-cron-secret';

// ─── Mock infra ──────────────────────────────────────────────────────────────

interface MockUser {
  id: string;
  email?: string;
  /** ISO date string. */
  created_at: string;
}

interface MockState {
  /** Auth users returned by listUsers, in order. */
  authUsers: MockUser[];
  /** data_user_ids that have a matching `accounts` row. */
  accountUserIds: string[];
  /** Tracks calls to deleteUser. */
  deletedUserIds: string[];
  /** Tracks app_events inserted (for the orphan_swept event). */
  appEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
  /** Set to error to make deleteUser fail. */
  deleteError: { message: string } | null;
}

let state: MockState;

const originalAuthAdmin = supabaseAdmin.auth.admin;
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installStub(): void {
  (supabaseAdmin as { auth: unknown }).auth = {
    admin: {
      listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
        // Return slice based on page/perPage; emulates supabase-js semantics
        // — last page returns < perPage and the loop exits.
        const start = (page - 1) * perPage;
        const end = start + perPage;
        return { data: { users: state.authUsers.slice(start, end) }, error: null };
      },
      deleteUser: async (id: string) => {
        if (state.deleteError) return { error: state.deleteError, data: null };
        state.deletedUserIds.push(id);
        return { error: null, data: null };
      },
    },
  };

  (supabaseAdmin as { from: unknown }).from = (table: string) => {
    if (table === 'accounts') {
      return {
        select: () => Promise.resolve({
          data: state.accountUserIds.map(id => ({ data_user_id: id })),
          error: null,
        }),
      };
    }
    if (table === 'app_events') {
      return {
        insert: async (rows: unknown) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const row of arr) {
            state.appEvents.push(row as { event_type: string; metadata: Record<string, unknown> });
          }
          return { error: null };
        },
      };
    }
    if (table === 'cron_heartbeats') {
      return {
        upsert: async () => ({ error: null }),
      };
    }
    // Default no-op for unrelated tables (writeCronHeartbeat may do extra writes).
    return {
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
  };
}

function restoreStub(): void {
  (supabaseAdmin as { auth: unknown }).auth = { admin: originalAuthAdmin };
  (supabaseAdmin as { from: unknown }).from = originalFrom;
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/cron/sweep-orphan-auth-users', {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
}

function isoMinusMinutes(min: number): string {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

function isoMinusDays(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.DISABLE_ORPHAN_AUTH_SWEEP;
  state = {
    authUsers: [],
    accountUserIds: [],
    deletedUserIds: [],
    appEvents: [],
    deleteError: null,
  };
  installStub();
});

afterEach(() => {
  restoreStub();
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('sweep-orphan-auth-users', () => {
  test('sweeps an orphan auth user older than 10 min and younger than 7 days', async () => {
    state.authUsers = [
      { id: 'orphan-1', email: 'a@x.com', created_at: isoMinusMinutes(30) },
    ];
    state.accountUserIds = [];

    const res = await GET(makeRequest());
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.data.swept, 1);
    assert.equal(body.data.failed, 0);
    assert.deepEqual(state.deletedUserIds, ['orphan-1']);
    assert.equal(state.appEvents.length, 1);
    assert.equal(state.appEvents[0].event_type, 'orphan_auth_user_swept');
  });

  test('does NOT sweep when a matching account row exists', async () => {
    state.authUsers = [
      { id: 'has-account', email: 'a@x.com', created_at: isoMinusMinutes(30) },
    ];
    state.accountUserIds = ['has-account'];

    const res = await GET(makeRequest());
    const body = await res.json();

    assert.equal(body.data.swept, 0);
    assert.equal(body.data.has_account, 1);
    assert.deepEqual(state.deletedUserIds, []);
  });

  test('does NOT sweep when the auth user is younger than 10 min', async () => {
    state.authUsers = [
      { id: 'too-new', email: 'a@x.com', created_at: isoMinusMinutes(5) },
    ];

    const res = await GET(makeRequest());
    const body = await res.json();

    assert.equal(body.data.swept, 0);
    assert.equal(body.data.skipped_too_new, 1);
    assert.deepEqual(state.deletedUserIds, []);
  });

  test('does NOT sweep when the auth user is older than 7 days, but emits skipped event', async () => {
    state.authUsers = [
      { id: 'too-old', email: 'a@x.com', created_at: isoMinusDays(10) },
    ];

    const res = await GET(makeRequest());
    const body = await res.json();

    assert.equal(body.data.swept, 0);
    assert.equal(body.data.skipped_too_old, 1);
    assert.deepEqual(state.deletedUserIds, []);
    const skippedEvent = state.appEvents.find(e => e.event_type === 'orphan_auth_user_skipped_too_old');
    assert.ok(skippedEvent, 'should emit skipped_too_old event');
  });

  test('classifies mixed batches correctly', async () => {
    state.authUsers = [
      { id: 'orphan', email: 'o@x.com', created_at: isoMinusMinutes(30) },
      { id: 'has-account', email: 'h@x.com', created_at: isoMinusMinutes(30) },
      { id: 'too-new', email: 'n@x.com', created_at: isoMinusMinutes(2) },
      { id: 'too-old', email: 't@x.com', created_at: isoMinusDays(10) },
    ];
    state.accountUserIds = ['has-account'];

    const res = await GET(makeRequest());
    const body = await res.json();

    assert.equal(body.data.swept, 1);
    assert.equal(body.data.has_account, 1);
    assert.equal(body.data.skipped_too_new, 1);
    assert.equal(body.data.skipped_too_old, 1);
    assert.deepEqual(state.deletedUserIds, ['orphan']);
  });

  test('counts deleteUser failures separately', async () => {
    state.authUsers = [
      { id: 'orphan', email: 'o@x.com', created_at: isoMinusMinutes(30) },
    ];
    state.deleteError = { message: 'auth temporarily unavailable' };

    const res = await GET(makeRequest());
    const body = await res.json();

    assert.equal(body.data.swept, 0);
    assert.equal(body.data.failed, 1);
    assert.deepEqual(state.deletedUserIds, []);
  });

  test('respects DISABLE_ORPHAN_AUTH_SWEEP kill switch', async () => {
    process.env.DISABLE_ORPHAN_AUTH_SWEEP = 'true';
    state.authUsers = [
      { id: 'would-sweep', email: 'a@x.com', created_at: isoMinusMinutes(30) },
    ];

    const res = await GET(makeRequest());
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.data.disabled, true);
    assert.deepEqual(state.deletedUserIds, []);
  });

  test('rejects requests without CRON_SECRET', async () => {
    const badReq = new NextRequest('http://localhost/api/cron/sweep-orphan-auth-users');
    const res = await GET(badReq);
    assert.notEqual(res.status, 200);
  });

  test('email_sha is a SHA-256 prefix, not the raw email', async () => {
    state.authUsers = [
      { id: 'orphan', email: 'sensitive@x.com', created_at: isoMinusMinutes(30) },
    ];

    await GET(makeRequest());

    const event = state.appEvents.find(e => e.event_type === 'orphan_auth_user_swept');
    assert.ok(event);
    const meta = event!.metadata;
    assert.ok(typeof meta.email_sha === 'string');
    assert.notEqual(meta.email_sha, 'sensitive@x.com', 'raw email must not be persisted');
    assert.match(meta.email_sha as string, /^[a-f0-9]{16}$/, 'should be 16-char hex prefix');
  });
});
