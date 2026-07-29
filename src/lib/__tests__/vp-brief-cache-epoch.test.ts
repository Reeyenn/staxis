import { afterEach, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { invalidateEmployeeSwitchCache } from '@/lib/ai/employee-switches';
import {
  getPortfolioBrief,
  portfolioBriefCacheKey,
  type PortfolioBriefAuthorizationEpoch,
} from '@/lib/company/vp-brief-server';
import type { PortfolioBriefInput } from '@/lib/company/vp-brief';
import { supabaseAdmin } from '@/lib/supabase-admin';

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = 'brief.epoch.reader';
const LOCAL_DATE = '2026-07-29';
const AUTHORIZATION_A = 'a'.repeat(64);
const AUTHORIZATION_B = 'b'.repeat(64);
const SCOPE_A = 'c'.repeat(64);
const SCOPE_B = 'd'.repeat(64);

const EPOCH_A: PortfolioBriefAuthorizationEpoch = {
  authorizationHash: AUTHORIZATION_A,
  scopeHash: SCOPE_A,
};

interface StoredCacheRow {
  route: string;
  response: Record<string, unknown>;
  status_code: number;
  expires_at: string | null;
}

function input(hotelCount: number, thingsChecked = hotelCount * 10): PortfolioBriefInput {
  return {
    organizationId: ORGANIZATION_ID,
    localDate: LOCAL_DATE,
    hotelCount,
    cards: [],
    run: {
      thingsChecked,
      hotelsChecked: hotelCount,
      hotelsTotal: hotelCount,
      lastRunAt: '2026-07-29T10:00:00.000Z',
    },
    now: new Date('2026-07-29T12:00:00.000Z'),
    busyHotelIds: [],
  };
}

/** Minimal service-client fake for the three operations used by the brief. */
function installCacheStore(
  context: TestContext,
): Map<string, StoredCacheRow> {
  const rows = new Map<string, StoredCacheRow>();
  const admin = supabaseAdmin as unknown as {
    from: (table: string) => unknown;
    rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };

  context.mock.method(admin, 'from', (table: string) => {
    if (table === 'ai_employee_switches') {
      return {
        select: async () => ({ data: [], error: null }),
      };
    }
    assert.equal(table, 'idempotency_log');
    return {
      select: () => {
        const filters = new Map<string, unknown>();
        const query = {
          eq(column: string, value: unknown) {
            filters.set(column, value);
            return query;
          },
          async maybeSingle() {
            const row = rows.get(String(filters.get('key')));
            if (!row || row.route !== filters.get('route')) return { data: null, error: null };
            return {
              data: { response: row.response, expires_at: row.expires_at },
              error: null,
            };
          },
        };
        return query;
      },
      update: (patch: Partial<StoredCacheRow>) => {
        const filters = new Map<string, unknown>();
        const query = {
          eq(column: string, value: unknown) {
            filters.set(column, value);
            return query;
          },
          then<TResult1 = { error: null }, TResult2 = never>(
            onfulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ): Promise<TResult1 | TResult2> {
            const key = String(filters.get('key'));
            const current = rows.get(key);
            if (current && current.route === filters.get('route')) {
              rows.set(key, { ...current, ...patch });
            }
            return Promise.resolve({ error: null }).then(onfulfilled, onrejected);
          },
        };
        return query;
      },
    };
  });

  context.mock.method(admin, 'rpc', async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, 'claim_idempotency_key');
    const key = String(args.p_key);
    const route = String(args.p_route);
    const existing = rows.get(key);
    if (existing && (!existing.expires_at || new Date(existing.expires_at).getTime() > Date.now())) {
      return { data: [{ claimed: false }], error: null };
    }
    rows.set(key, {
      route,
      response: { __pending__: true },
      status_code: 0,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    return { data: [{ claimed: true }], error: null };
  });

  return rows;
}

afterEach(() => {
  invalidateEmployeeSwitchCache();
});

describe('portfolio brief authorization epoch cache', () => {
  test('keeps one person/day stable only inside the same exact receipt epoch', () => {
    const same = portfolioBriefCacheKey(ORGANIZATION_ID, ACCOUNT_ID, LOCAL_DATE, EPOCH_A);
    assert.equal(
      portfolioBriefCacheKey(ORGANIZATION_ID, ACCOUNT_ID, LOCAL_DATE, { ...EPOCH_A }),
      same,
    );
    assert.notEqual(
      portfolioBriefCacheKey(ORGANIZATION_ID, ACCOUNT_ID, LOCAL_DATE, {
        authorizationHash: AUTHORIZATION_B,
        scopeHash: SCOPE_A,
      }),
      same,
    );
    assert.notEqual(
      portfolioBriefCacheKey(ORGANIZATION_ID, ACCOUNT_ID, LOCAL_DATE, {
        authorizationHash: AUTHORIZATION_A,
        scopeHash: SCOPE_B,
      }),
      same,
    );
  });

  test('a transfer/revocation epoch cannot read the old brief or a poisoned envelope', async (context) => {
    invalidateEmployeeSwitchCache();
    const rows = installCacheStore(context);

    const first = await getPortfolioBrief({
      accountId: ACCOUNT_ID,
      authorizationEpoch: EPOCH_A,
      input: input(2),
    });
    assert.equal(first.cached, false);
    assert.match(first.brief?.lines[0]?.text ?? '', /Across your 2 hotels/);

    // Daily stability remains: changing live inputs alone does not rewrite a
    // brief while the validated authorization/property epoch is unchanged.
    const stable = await getPortfolioBrief({
      accountId: ACCOUNT_ID,
      authorizationEpoch: EPOCH_A,
      input: input(9),
    });
    assert.equal(stable.cached, true);
    assert.deepEqual(stable.brief, first.brief);

    // A property-set change (for example, a hotel transfer) gets a distinct
    // slot and therefore cannot recover the old two-hotel statement.
    const transferredEpoch = { authorizationHash: AUTHORIZATION_A, scopeHash: SCOPE_B };
    const transferred = await getPortfolioBrief({
      accountId: ACCOUNT_ID,
      authorizationEpoch: transferredEpoch,
      input: input(3),
    });
    assert.equal(transferred.cached, false);
    assert.match(transferred.brief?.lines[0]?.text ?? '', /Across your 3 hotels/);

    // A grant revocation/role change can leave the selected property set the
    // same while changing the authorization universe. That hash independently
    // starts a new slot as well.
    const revokedEpoch = { authorizationHash: AUTHORIZATION_B, scopeHash: SCOPE_B };
    const revoked = await getPortfolioBrief({
      accountId: ACCOUNT_ID,
      authorizationEpoch: revokedEpoch,
      input: input(4),
    });
    assert.equal(revoked.cached, false);
    assert.match(revoked.brief?.lines[0]?.text ?? '', /Across your 4 hotels/);

    // Even a row planted under the correct key is refused if its envelope does
    // not carry the exact current hashes. This is the read-side guard in
    // addition to key partitioning.
    const key = portfolioBriefCacheKey(
      ORGANIZATION_ID,
      ACCOUNT_ID,
      LOCAL_DATE,
      revokedEpoch,
    );
    const poisoned = rows.get(key);
    assert.ok(poisoned);
    poisoned.response.scopeHash = SCOPE_A;

    const afterPoison = await getPortfolioBrief({
      accountId: ACCOUNT_ID,
      authorizationEpoch: revokedEpoch,
      input: input(5),
    });
    assert.equal(afterPoison.cached, false);
    assert.match(afterPoison.brief?.lines[0]?.text ?? '', /Across your 5 hotels/);
  });
});
