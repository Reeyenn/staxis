/**
 * Tests for the TAMPER-SEAL guard in src/lib/pms/promote-map.ts
 * (fix/cua-draft-resign).
 *
 * Every pms_knowledge_files row is HMAC-signed over its `knowledge` jsonb at
 * learn time and re-signed by the Fly worker on every edit (RECIPE_SIGNING_KEY
 * is Fly-only — the web can NEVER sign). The Coverage Editor's draft edits used
 * to mutate the draft jsonb IN PLACE without re-signing, silently breaking the
 * seal; promoting such a draft made the CUA worker REFUSE it and auto-trigger a
 * fresh ~$25 re-learn. promoteMap now refuses a NULL-signature target up front.
 *
 * These tests pin three contracts:
 *   1. A NULL-signature target is refused with 409 + a founder-readable message
 *      BEFORE anything is mutated (no demote of the current live map).
 *   2. PROMOTE_ALLOW_UNSIGNED='1' (dev/local escape hatch) lets an unsigned row
 *      promote — proving the guard is opt-outable but off by default.
 *   3. A SIGNED draft still promotes exactly as before (behavior untouched).
 *
 * The DB is monkey-patched (supabaseAdmin.from) with a per-operation queue, the
 * same singleton-patch style as pms-save-credentials.test.ts.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { promoteMap } from '@/lib/pms/promote-map';

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

const DRAFT_ID = '11111111-1111-1111-1111-111111111111';
const FAMILY = 'choice_advantage';

// Records every table op so a test can assert whether a mutation (demote/
// promote) was even attempted after a refusal.
interface Op { table: string; kind: 'select' | 'update'; chain: string[] }
let ops: Op[] = [];

// The row the target-precheck maybeSingle() returns. Tests set its `signature`.
let targetRow: Record<string, unknown> | null = null;

/** Build the chainable from() stub. The precheck is a SELECT; the demote +
 *  promote are UPDATEs. We distinguish them by the recorded chain so the mock
 *  can return the right shape for each. */
function installMock() {
  supabaseAdmin.from = ((table: string) => {
    const chain: string[] = [];
    let kind: 'select' | 'update' = 'select';
    const op: Op = { table, kind, chain };
    ops.push(op);
    const builder: Record<string, unknown> = {
      select(...args: unknown[]) { chain.push(`select(${args.join(',')})`); return builder; },
      update(...args: unknown[]) { kind = 'update'; op.kind = 'update'; chain.push(`update(${JSON.stringify(args)})`); return builder; },
      eq(...args: unknown[]) { chain.push(`eq(${args.join(',')})`); return builder; },
      is(...args: unknown[]) { chain.push(`is(${args.join(',')})`); return builder; },
      in(...args: unknown[]) { chain.push(`in(${JSON.stringify(args)})`); return builder; },
      maybeSingle: async () => {
        if (table === 'pms_knowledge_files' && op.kind === 'select') {
          // Target pre-check.
          return { data: targetRow, error: null };
        }
        if (table === 'pms_knowledge_files' && op.kind === 'update') {
          // First UPDATE = demote current active (there is none here → null).
          // Second UPDATE = activate the target → echo a promoted row.
          const isPromote = chain.some((c) => c.startsWith(`eq(id,${DRAFT_ID})`));
          if (isPromote) {
            return {
              data: {
                id: DRAFT_ID, pms_family: FAMILY, version: 3, status: 'active',
                promoted_to_active_at: new Date().toISOString(),
              },
              error: null,
            };
          }
          return { data: null, error: null }; // no current active to demote
        }
        return { data: null, error: null };
      },
      // property_sessions revive is awaited (.select() then resolves via then).
      then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
    };
    return builder;
  }) as unknown as FromFn;
}

beforeEach(() => {
  ops = [];
  targetRow = null;
  delete process.env.PROMOTE_ALLOW_UNSIGNED;
  installMock();
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  delete process.env.PROMOTE_ALLOW_UNSIGNED;
});

describe('promoteMap — tamper-seal guard', () => {
  test('refuses a NULL-signature draft with 409 and a re-save message', async () => {
    targetRow = { id: DRAFT_ID, pms_family: FAMILY, version: 3, status: 'draft', signature: null };

    const res = await promoteMap({ id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft' });

    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.status, 409);
      assert.match(res.message, /tamper seal/i);
      assert.match(res.message, /re-save/i);
    }
    // Crucial: it refused BEFORE mutating — no UPDATE was issued.
    assert.equal(ops.some((o) => o.kind === 'update'), false, 'must not demote/promote on a sealed-less row');
  });

  test('missing signature key (undefined) is treated the same as NULL', async () => {
    // A select that simply omits the column → undefined; must still refuse.
    targetRow = { id: DRAFT_ID, pms_family: FAMILY, version: 3, status: 'draft' };
    const res = await promoteMap({ id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.status, 409);
  });

  test('PROMOTE_ALLOW_UNSIGNED=1 lets an unsigned draft promote (dev escape hatch)', async () => {
    process.env.PROMOTE_ALLOW_UNSIGNED = '1';
    targetRow = { id: DRAFT_ID, pms_family: FAMILY, version: 3, status: 'draft', signature: null };

    const res = await promoteMap({ id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft' });

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.map.id, DRAFT_ID);
      assert.equal(res.map.status, 'active');
    }
    // The escape hatch must NOT fire for any other value than exactly '1'.
    assert.equal(ops.some((o) => o.kind === 'update'), true, 'promotion should proceed to mutation');
  });

  test('a SIGNED draft still promotes (behavior untouched)', async () => {
    // PostgREST returns bytea as a "\x…" hex string — a present, non-null value.
    targetRow = { id: DRAFT_ID, pms_family: FAMILY, version: 3, status: 'draft', signature: '\\xdeadbeef' };

    const res = await promoteMap({ id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft', promotedBy: 'admin:test' });

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.map.id, DRAFT_ID);
      assert.equal(res.map.pms_family, FAMILY);
      assert.equal(res.map.status, 'active');
    }
  });

  test('PROMOTE_ALLOW_UNSIGNED set to something other than "1" does NOT bypass the guard', async () => {
    process.env.PROMOTE_ALLOW_UNSIGNED = 'true'; // not exactly '1'
    targetRow = { id: DRAFT_ID, pms_family: FAMILY, version: 3, status: 'draft', signature: null };
    const res = await promoteMap({ id: DRAFT_ID, expectedVersion: 3, expectedStatus: 'draft' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.status, 409);
  });
});
