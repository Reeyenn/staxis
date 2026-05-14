/**
 * Regression tests for ml-misconfigured-events (Codex follow-up #2).
 *
 * These pin:
 *   - the app_events insert payload shape (event_type, metadata.field,
 *     metadata.layer, etc.)
 *   - the parser that turns ML-service error strings into field/value
 *   - the contract that insert failures NEVER throw (the orchestrating
 *     cron must keep moving on a bad event write)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  emitPropertyMisconfiguredEvent,
  parsePropertyMisconfiguredError,
  type AppEventsClient,
} from '../ml-misconfigured-events';

interface CapturedInsert {
  table: string;
  row: Record<string, unknown>;
}

/**
 * Build a stub AppEventsClient that records the insert and returns the
 * given result. We inject this via the helper's optional client param —
 * the prod supabaseAdmin singleton stays untouched.
 */
function mockClient(insertResult: { error: unknown } = { error: null }) {
  const captured: { value: CapturedInsert | null } = { value: null };
  const client: AppEventsClient = {
    from: (table) => ({
      insert: (row: Record<string, unknown>) => {
        captured.value = { table, row };
        return Promise.resolve(insertResult);
      },
    }),
  };
  return { client, captured };
}

async function captureEmit(
  input: Parameters<typeof emitPropertyMisconfiguredEvent>[0],
  insertResult: { error: unknown } = { error: null },
): Promise<CapturedInsert | null> {
  const { client, captured } = mockClient(insertResult);
  await emitPropertyMisconfiguredEvent(input, client);
  return captured.value;
}

describe('emitPropertyMisconfiguredEvent (Codex #2)', () => {
  it('writes a row to app_events with event_type property_misconfigured', async () => {
    const captured = await captureEmit({
      requestId: 'req-1',
      propertyId: '11111111-1111-1111-1111-111111111111',
      field: 'timezone',
      value: null,
    });
    assert.ok(captured, 'insert was never called');
    assert.equal(captured.table, 'app_events');
    assert.equal(captured.row.event_type, 'property_misconfigured');
    assert.equal(captured.row.property_id, '11111111-1111-1111-1111-111111111111');
    assert.equal(captured.row.user_id, null);
    assert.equal(captured.row.user_role, 'system');
  });

  it('includes layer, field, value, request_id in metadata', async () => {
    const captured = await captureEmit({
      requestId: 'req-2',
      propertyId: '22222222-2222-2222-2222-222222222222',
      layer: 'demand',
      field: 'total_rooms',
      value: 0,
    });
    assert.ok(captured);
    const md = captured.row.metadata as Record<string, unknown>;
    assert.equal(md.layer, 'demand');
    assert.equal(md.field, 'total_rooms');
    assert.equal(md.value, '0');
    assert.equal(md.request_id, 'req-2');
  });

  it('defaults layer to "orchestrator" when not specified', async () => {
    const captured = await captureEmit({
      propertyId: '33333333-3333-3333-3333-333333333333',
      field: 'timezone',
      value: null,
    });
    assert.ok(captured);
    const md = captured.row.metadata as Record<string, unknown>;
    assert.equal(md.layer, 'orchestrator');
    assert.equal(md.request_id, null);
  });

  it('stringifies non-null values, preserves null', async () => {
    const c1 = await captureEmit({
      propertyId: '44444444-4444-4444-4444-444444444444',
      field: 'timezone',
      value: null,
    });
    assert.equal((c1?.row.metadata as Record<string, unknown>).value, null);

    const c2 = await captureEmit({
      propertyId: '44444444-4444-4444-4444-444444444444',
      field: 'total_rooms',
      value: 60,
    });
    assert.equal((c2?.row.metadata as Record<string, unknown>).value, '60');

    const c3 = await captureEmit({
      propertyId: '44444444-4444-4444-4444-444444444444',
      field: 'timezone',
      value: undefined,
    });
    assert.equal((c3?.row.metadata as Record<string, unknown>).value, null);
  });

  it('does NOT throw when the supabase insert errors', async () => {
    // If this throws, the orchestrating cron breaks on a bad event write.
    await assert.doesNotReject(async () => {
      await captureEmit(
        {
          propertyId: '55555555-5555-5555-5555-555555555555',
          field: 'timezone',
          value: null,
        },
        { error: new Error('PostgrestError: bad RLS') },
      );
    });
  });
});

describe('parsePropertyMisconfiguredError', () => {
  it('parses well-formed messages with allowlisted fields', () => {
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: total_rooms=0"),
      { field: 'total_rooms', value: '0' },
    );
  });

  it('normalizes Python None sentinel to null (C2)', () => {
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone=None"),
      { field: 'timezone', value: null },
    );
  });

  it('normalizes empty-string repr to null (C2)', () => {
    // Python's repr('') is "''" — also a "missing" signal.
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone=''"),
      { field: 'timezone', value: null },
    );
  });

  it('normalizes JS null/undefined sentinels too (C2)', () => {
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone=null"),
      { field: 'timezone', value: null },
    );
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone=undefined"),
      { field: 'timezone', value: null },
    );
  });

  it('preserves non-sentinel values verbatim', () => {
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone=America/New_York"),
      { field: 'timezone', value: 'America/New_York' },
    );
  });

  it('strips surrounding single-quotes (D3 — defense against legacy repr)', () => {
    // Older Python error messages used `f"{value!r}"` which wrapped
    // strings in single quotes. The Python side was fixed in errors.py
    // to use printable_value, but this stripper guards against in-flight
    // crons that haven't picked up the new code yet.
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone='America/New_York'"),
      { field: 'timezone', value: 'America/New_York' },
    );
  });

  it('strips surrounding double-quotes (D3)', () => {
    assert.deepEqual(
      parsePropertyMisconfiguredError('property_misconfigured: timezone="America/New_York"'),
      { field: 'timezone', value: 'America/New_York' },
    );
  });

  it('does not strip mismatched or non-paired quotes (D3 defensive)', () => {
    // A value that legitimately contains a quote but isn't fully quoted
    // (e.g. operator typo) should be preserved verbatim — not silently
    // mangled.
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone=America/'New_York"),
      { field: 'timezone', value: "America/'New_York" },
    );
  });

  it('round-trips actual Python printable_value output (E5)', () => {
    // Codex round-3 review 2026-05-13 (E5): pin against the literal
    // strings the Python service produces today after the D3 fix.
    // ml-service/src/errors.py:36-40:
    //   if isinstance(value, str): self.printable_value = value
    //   else: self.printable_value = repr(value)
    //
    // Format from Python's emit sites:
    //   f"property_misconfigured: {exc.field}={exc.printable_value}"
    //
    // Below: 4 representative cases from the actual Python code path.

    // 1. timezone=None (Python None, repr → 'None')
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone=None"),
      { field: 'timezone', value: null },
    );

    // 2. total_rooms=0 (Python int, repr → '0')
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: total_rooms=0"),
      { field: 'total_rooms', value: '0' },
    );

    // 3. timezone='' (Python empty string — printable_value is '' bare)
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone="),
      { field: 'timezone', value: null },
    );

    // 4. timezone=Mars/Olympus (Python valid string — printable_value is
    //    bare value, no quotes)
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: timezone=Mars/Olympus"),
      { field: 'timezone', value: 'Mars/Olympus' },
    );
  });

  it('remaps unknown fields to unknown_field with original preserved (C4)', () => {
    // Typo on Python side: should NOT propagate uselessly to the doctor.
    assert.deepEqual(
      parsePropertyMisconfiguredError("property_misconfigured: total_roomz=0"),
      { field: 'unknown_field', originalField: 'total_roomz', value: '0' },
    );
  });

  it('returns null when the prefix is missing', () => {
    assert.equal(parsePropertyMisconfiguredError('something else'), null);
    assert.equal(parsePropertyMisconfiguredError(''), null);
  });

  it('returns null when there is no =', () => {
    assert.equal(
      parsePropertyMisconfiguredError('property_misconfigured: missing'),
      null,
    );
  });

  it('returns null when the field is empty', () => {
    assert.equal(
      parsePropertyMisconfiguredError('property_misconfigured: =0'),
      null,
    );
  });
});
