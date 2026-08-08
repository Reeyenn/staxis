/**
 * "Today" for an assistant tool is the HOTEL's day, never the server's.
 *
 * THE BUG: get_room_assignments — the tool behind "who has which rooms today",
 * "how many rooms does Maria have", "is anyone overloaded" — defaulted its date
 * to `new Date().toISOString().slice(0, 10)`. Production runs on UTC. So from
 * 7pm local onward, a manager in Beaumont asking about today was answered about
 * TOMORROW, whose housekeeping plan has no rows yet: the copilot reported an
 * empty split, or one housekeeper short, for a hotel in the middle of a shift.
 * Its sibling tools (get_schedule, the PMS feed tools) already read
 * properties.timezone through getPropertyToday; this one did not.
 *
 * `now` is a parameter rather than an ambient clock precisely so the evening
 * window — the only window where the two answers differ — is testable.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { getPropertyToday } from '@/lib/agent/tools/queries';
import type { ScopedDb } from '@/lib/agent/scoped-db';

/** The only call getPropertyToday makes: properties → select timezone. */
function dbWithTimezone(timezone: string | null): ScopedDb {
  return {
    from: () => ({
      select: () => ({
        maybeSingle: async () => ({ data: timezone === null ? null : { timezone }, error: null }),
      }),
    }),
  } as unknown as ScopedDb;
}

/** A db whose read blows up — the honesty question is what it falls back to. */
function dbThatFails(): ScopedDb {
  return {
    from: () => ({
      select: () => ({
        maybeSingle: async () => { throw new Error('PostgREST is down'); },
      }),
    }),
  } as unknown as ScopedDb;
}

// 2026-07-17 01:00 UTC. Chicago is on CDT (UTC-5), so it is 8pm on July 16 at
// the hotel. This is the window the bug lived in: five hours every evening.
const EVENING = new Date('2026-07-17T01:00:00.000Z');

describe('getPropertyToday — the evening window', () => {
  test('a Central hotel at 8pm is still on its own day, not the server\'s tomorrow', async () => {
    assert.equal(await getPropertyToday(dbWithTimezone('America/Chicago'), EVENING), '2026-07-16');
    // What the raw server clock would have said, and did.
    assert.equal(EVENING.toISOString().slice(0, 10), '2026-07-17');
  });

  test('an Eastern hotel at 9pm agrees with its own calendar too', async () => {
    assert.equal(await getPropertyToday(dbWithTimezone('America/New_York'), EVENING), '2026-07-16');
  });

  test('a Hawaii hotel is even further behind the server', async () => {
    // 3pm July 16 in Honolulu.
    assert.equal(await getPropertyToday(dbWithTimezone('Pacific/Honolulu'), EVENING), '2026-07-16');
  });

  test('a hotel east of UTC can be on the NEXT day before the server is', async () => {
    // 2026-07-16 22:00 UTC is 8am July 17 in Auckland.
    const morning = new Date('2026-07-16T20:00:00.000Z');
    assert.equal(await getPropertyToday(dbWithTimezone('Pacific/Auckland'), morning), '2026-07-17');
    assert.equal(morning.toISOString().slice(0, 10), '2026-07-16');
  });

  test('mid-afternoon local, every zone and the server agree', async () => {
    const midday = new Date('2026-07-16T17:00:00.000Z'); // noon Chicago
    assert.equal(await getPropertyToday(dbWithTimezone('America/Chicago'), midday), '2026-07-16');
    assert.equal(await getPropertyToday(dbWithTimezone('America/New_York'), midday), '2026-07-16');
  });
});

describe('getPropertyToday — degradation', () => {
  test('a hotel with no timezone set falls back to the server day', async () => {
    assert.equal(await getPropertyToday(dbWithTimezone(null), EVENING), '2026-07-17');
  });

  test('an unknown IANA zone falls back rather than throwing', async () => {
    assert.equal(await getPropertyToday(dbWithTimezone('Mars/Olympus_Mons'), EVENING), '2026-07-17');
  });

  test('a failed property read falls back rather than taking the tool down', async () => {
    assert.equal(await getPropertyToday(dbThatFails(), EVENING), '2026-07-17');
  });
});
