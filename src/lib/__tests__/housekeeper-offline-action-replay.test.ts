import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  claimOfflineAction,
  completeOfflineActionClaim,
  releaseOfflineActionClaim,
} from '@/lib/housekeeper-workflow/offline-action-replay';
import { supabaseAdmin } from '@/lib/supabase-admin';

interface DbError {
  code: string;
  message: string;
  details: string;
  hint: string;
}

interface QueryResult<T> {
  data: T;
  error: DbError | null;
}

const context = {
  actionId: '11111111-1111-4111-8111-111111111111',
  propertyId: '22222222-2222-4222-8222-222222222222',
  staffId: '33333333-3333-4333-8333-333333333333',
  endpoint: 'add-note',
  requestId: 'request-1',
};

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalConsoleError = console.error;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

let claimResult: QueryResult<{ action_id: string } | null>;
let lookupResult: QueryResult<{ result_payload: unknown } | null>;
let releaseResult: QueryResult<{ action_id: string } | null>;
let completionResults: Array<QueryResult<{ action_id: string } | null> | 'throw'>;
let claimThrows: boolean;
let releaseThrows: boolean;
let lookupCalls: number;
let completionCalls: number;
let insertedRow: Record<string, unknown> | null;
let completionRows: Array<Record<string, unknown>>;
let lookupFilters: Array<[string, unknown]>;
let releaseFilters: Array<[string, unknown]>;
let completionFilters: Array<[string, unknown]>;

function dbError(code: string, message: string): DbError {
  return { code, message, details: '', hint: '' };
}

beforeEach(() => {
  claimResult = {
    data: { action_id: context.actionId },
    error: null,
  };
  lookupResult = {
    data: { result_payload: { saved: true } },
    error: null,
  };
  releaseResult = {
    data: { action_id: context.actionId },
    error: null,
  };
  completionResults = [{
    data: { action_id: context.actionId },
    error: null,
  }];
  claimThrows = false;
  releaseThrows = false;
  lookupCalls = 0;
  completionCalls = 0;
  insertedRow = null;
  completionRows = [];
  lookupFilters = [];
  releaseFilters = [];
  completionFilters = [];

  console.error = (() => undefined) as typeof console.error;
  console.log = (() => undefined) as typeof console.log;
  console.warn = (() => undefined) as typeof console.warn;

  // @ts-expect-error Test-only replacement of the Supabase query builder.
  supabaseAdmin.from = (table: string) => {
    assert.equal(table, 'offline_action_replays');

    return {
      insert: (row: Record<string, unknown>) => {
        insertedRow = row;
        return {
          select: () => ({
            maybeSingle: async () => {
              if (claimThrows) throw new Error('claim connection lost');
              return claimResult;
            },
          }),
        };
      },
      select: () => {
        const chain = {
          eq: (column: string, value: unknown) => {
            lookupFilters.push([column, value]);
            return chain;
          },
          maybeSingle: async () => {
            lookupCalls += 1;
            return lookupResult;
          },
        };
        return chain;
      },
      delete: () => {
        const chain = {
          eq: (column: string, value: unknown) => {
            releaseFilters.push([column, value]);
            return chain;
          },
          select: () => ({
            maybeSingle: async () => {
              if (releaseThrows) throw new Error('release connection lost');
              return releaseResult;
            },
          }),
        };
        return chain;
      },
      update: (row: Record<string, unknown>) => {
        completionRows.push(row);
        const chain = {
          eq: (column: string, value: unknown) => {
            completionFilters.push([column, value]);
            return chain;
          },
          select: () => ({
            maybeSingle: async () => {
              completionCalls += 1;
              const result = completionResults.shift() ?? {
                data: { action_id: context.actionId },
                error: null,
              };
              if (result === 'throw') throw new Error('completion connection lost');
              return result;
            },
          }),
        };
        return chain;
      },
    };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
});

describe('claimOfflineAction', () => {
  test('returns a new claim only after a successful insert', async () => {
    assert.deepEqual(await claimOfflineAction(context), {
      ok: true,
      duplicate: false,
    });
    assert.deepEqual(insertedRow, {
      action_id: context.actionId,
      property_id: context.propertyId,
      staff_id: context.staffId,
      endpoint: context.endpoint,
      result_payload: {},
    });
    assert.equal(lookupCalls, 0);
  });

  test('treats SQLSTATE 23505 as an existing claim and returns its payload', async () => {
    claimResult = {
      data: null,
      error: dbError('23505', 'duplicate key value violates unique constraint'),
    };

    assert.deepEqual(await claimOfflineAction(context), {
      ok: true,
      duplicate: true,
      resultPayload: { saved: true },
    });
    assert.equal(lookupCalls, 1);
    assert.deepEqual(lookupFilters, [
      ['action_id', context.actionId],
      ['property_id', context.propertyId],
      ['staff_id', context.staffId],
      ['endpoint', context.endpoint],
    ]);
  });

  test('does not misclassify a non-23505 insert error as a replay', async () => {
    claimResult = {
      data: null,
      error: dbError('42501', 'permission denied'),
    };

    assert.deepEqual(await claimOfflineAction(context), {
      ok: false,
      reason: 'error',
    });
    assert.equal(lookupCalls, 0);
  });

  test('fails when an insert returns neither a row nor an error', async () => {
    claimResult = { data: null, error: null };

    assert.deepEqual(await claimOfflineAction(context), {
      ok: false,
      reason: 'error',
    });
    assert.equal(lookupCalls, 0);
  });

  test('fails when the duplicate payload lookup errors', async () => {
    claimResult = {
      data: null,
      error: dbError('23505', 'duplicate key value violates unique constraint'),
    };
    lookupResult = {
      data: null,
      error: dbError('08006', 'connection failure'),
    };

    assert.deepEqual(await claimOfflineAction(context), {
      ok: false,
      reason: 'error',
    });
  });

  test('reports a concurrent claim with an empty payload as pending', async () => {
    claimResult = {
      data: null,
      error: dbError('23505', 'duplicate key value violates unique constraint'),
    };
    lookupResult = {
      data: { result_payload: {} },
      error: null,
    };

    assert.deepEqual(await claimOfflineAction(context), {
      ok: false,
      reason: 'pending',
    });
  });

  test('fails when the insert throws', async () => {
    claimThrows = true;

    assert.deepEqual(await claimOfflineAction(context), {
      ok: false,
      reason: 'error',
    });
    assert.equal(lookupCalls, 0);
  });
});

describe('releaseOfflineActionClaim', () => {
  test('deletes only the claim owned by the same action context', async () => {
    assert.equal(await releaseOfflineActionClaim(context), true);
    assert.deepEqual(releaseFilters, [
      ['action_id', context.actionId],
      ['property_id', context.propertyId],
      ['staff_id', context.staffId],
      ['endpoint', context.endpoint],
    ]);
  });

  test('surfaces a returned delete error', async () => {
    releaseResult = {
      data: null,
      error: dbError('42501', 'permission denied'),
    };

    assert.equal(await releaseOfflineActionClaim(context), false);
  });

  test('surfaces a thrown delete error', async () => {
    releaseThrows = true;

    assert.equal(await releaseOfflineActionClaim(context), false);
  });

  test('surfaces a no-error delete that matched no claim', async () => {
    releaseResult = { data: null, error: null };

    assert.equal(await releaseOfflineActionClaim(context), false);
  });
});

describe('completeOfflineActionClaim', () => {
  const resultPayload = { saved: true, itemId: 'item-1' };

  test('persists the result only on the claim owned by the same context', async () => {
    assert.equal(
      await completeOfflineActionClaim(context, resultPayload),
      true,
    );
    assert.deepEqual(completionRows, [{ result_payload: resultPayload }]);
    assert.deepEqual(completionFilters, [
      ['action_id', context.actionId],
      ['property_id', context.propertyId],
      ['staff_id', context.staffId],
      ['endpoint', context.endpoint],
    ]);
  });

  test('retries a returned PostgREST error and succeeds', async () => {
    completionResults = [
      { data: null, error: dbError('08006', 'connection failure') },
      { data: { action_id: context.actionId }, error: null },
    ];

    assert.equal(
      await completeOfflineActionClaim(context, resultPayload),
      true,
    );
    assert.equal(completionCalls, 2);
  });

  test('retries a thrown update error and succeeds', async () => {
    completionResults = [
      'throw',
      { data: { action_id: context.actionId }, error: null },
    ];

    assert.equal(
      await completeOfflineActionClaim(context, resultPayload),
      true,
    );
    assert.equal(completionCalls, 2);
  });

  test('surfaces failure after both completion attempts fail', async () => {
    completionResults = [
      { data: null, error: dbError('08006', 'connection failure') },
      { data: null, error: dbError('08006', 'connection failure') },
    ];

    assert.equal(
      await completeOfflineActionClaim(context, resultPayload),
      false,
    );
    assert.equal(completionCalls, 2);
  });

  test('does not accept a no-error update that matched no claim', async () => {
    completionResults = [
      { data: null, error: null },
      { data: null, error: null },
    ];

    assert.equal(
      await completeOfflineActionClaim(context, resultPayload),
      false,
    );
    assert.equal(completionCalls, 2);
  });
});

describe('housekeeper replay route integration', () => {
  const routeFiles = [
    'add-note',
    'mark-for-inspection',
    'structured-issue',
    'report-found-item',
  ];

  for (const route of routeFiles) {
    test(`${route} uses the guarded claim and release helpers`, () => {
      const source = readFileSync(
        join(process.cwd(), 'src', 'app', 'api', 'housekeeper', route, 'route.ts'),
        'utf8',
      );

      assert.match(source, /claimOfflineAction\(replayContext\)/);
      assert.match(source, /releaseOfflineActionClaim\(replayContext\)/);
      assert.match(source, /completeOfflineActionClaim\(replayContext, result\)/);
      assert.match(source, /const replayCompleted = await completeOfflineActionClaim/);
      assert.match(source, /if \(!replayCompleted\)/);
      assert.match(source, /committed mutation has a pending replay result/);
      assert.doesNotMatch(source, /!\(await completeOfflineActionClaim/);
      assert.match(source, /claim\.reason === ['"]pending['"]/);
      assert.match(source, /status:\s*pending \? 503 : 500/);

      const releaseCalls = source.match(/await releaseClaim\(\)/g) ?? [];
      const checkedReleaseCalls = source.match(
        /!\(await releaseClaim\(\)\)/g,
      ) ?? [];
      assert.equal(
        checkedReleaseCalls.length,
        releaseCalls.length,
        'every release failure must be turned into a retryable response',
      );
      assert.match(source, /let businessMutationCommitted = false/);
      assert.match(
        source,
        /!businessMutationCommitted && !\(await releaseClaim\(\)\)/,
      );

      assert.doesNotMatch(
        source,
        /from\(['"]offline_action_replays['"]\)[\s\S]{0,100}\.insert\(/,
      );
      assert.doesNotMatch(
        source,
        /from\(['"]offline_action_replays['"]\)[\s\S]{0,120}\.update\(/,
      );
    });
  }
});
