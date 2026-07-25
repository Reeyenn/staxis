/**
 * The stable system block must stay byte-identical turn to turn.
 *
 * Anthropic caches the prompt prefix up to the cache_control breakpoint, which
 * llm.ts puts on the STABLE block only. The data-age RULE is constant per
 * deploy and belongs there; the as-of VALUE changes every turn and belongs in
 * the dynamic snapshot block.
 *
 * The plausible bug: someone appends the as-of line to `stableParts` to "make
 * sure the model sees it". Nothing visible breaks — the copilot still answers
 * correctly — but every single turn misses the prompt cache, silently
 * multiplying the input-token bill for as long as it goes unnoticed. That is
 * exactly the kind of regression a human reviewer does not catch by reading a
 * diff, so it is pinned here.
 *
 * Also pinned: the deleted "refresh the page" lie must not come back in
 * either block, and the version label must record which freshness rule ran.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt } from '@/lib/agent/prompts';
import type { HotelSnapshot } from '@/lib/agent/context';
import { supabaseAdmin } from '@/lib/supabase-admin';

// REAL now, on purpose. `buildSystemPrompt` renders the snapshot through
// `formatSnapshotForPrompt`, which computes the age against the wall clock and
// is not given an injectable one at that call site. So a capture time has to be
// a real offset from the present: pinned to a calendar date, `agedBy(5)` stops
// meaning "five minutes ago" the moment the date rolls over, the age renders in
// days, and the assertion below stops matching. That is exactly what happened —
// the date was pinned to 2026-07-24 and the test went red at midnight.
//
// Nothing about the assertions relies on a fixed date: they check that the
// rendered clock and age appear in the DYNAMIC block and never in the stable
// one, which is true at any hour.
const NOW = new Date();

// Every buildSystemPrompt call below passes NOW explicitly. Without that, the
// fixture's capture time is pinned but its AGE is measured against the wall
// clock, so the rendered wording drifts as real time passes and the assertions
// slowly come to mean something else. This suite passed all day on 2026-07-24
// and went red overnight on unchanged code, once agedBy(5) aged past a day and
// started rendering as days rather than "5 min ago".

function agedBy(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function snapshot(capturedAt: string): HotelSnapshot {
  return {
    today: NOW.toISOString().slice(0, 10),
    property: {
      id: '00000000-0000-0000-0000-0000000000e1',
      name: 'Comfort Suites',
      timezone: 'America/Chicago',
    },
    rooms: {
      total: 88, dirty: 12, in_progress: 0, clean: 14, dnd: 0, issuesFlagged: 0,
      helpRequested: 0, checkouts: 9, stayovers: 21, inHouse: 62, outOfOrder: 0,
      seedingGap: 0,
    },
    staff: { activeToday: 4, assignedHousekeepers: 3 },
    pmsDataSource: 'snapshot_capture',
    pmsDataCapturedAt: capturedAt,
  };
}

// buildSystemPrompt resolves prompts from the DB with a fail-soft fallback to
// the constants. Stub the read so the test never depends on the network.
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

before(() => {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  };
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = () => chain;
});
after(() => {
  supabaseAdmin.from = originalFrom;
});

describe('prompt cache purity', () => {
  it('two snapshots 40 minutes apart produce byte-identical stable blocks', async () => {
    const a = await buildSystemPrompt('general_manager', snapshot(agedBy(5)), 'conv-1', undefined, undefined, NOW);
    const b = await buildSystemPrompt('general_manager', snapshot(agedBy(45)), 'conv-1', undefined, undefined, NOW);
    assert.equal(a.stable, b.stable);
    // …and the dynamic blocks genuinely differ, or the assertion above would
    // be vacuously true for a build that dropped the as-of line entirely.
    assert.notEqual(a.dynamic, b.dynamic);
  });

  it('the stable block carries the RULE but never a clock or an age', async () => {
    const { stable, dynamic } = await buildSystemPrompt(
      'general_manager',
      snapshot(agedBy(5)),
      'conv-1',
      undefined,
      undefined,
      NOW,
    );
    assert.match(stable, /How old the numbers are/);
    assert.match(stable, /snapshot is NOT live/);

    // The rendered per-turn values must appear only in the dynamic block.
    const captured = /PMS data as of ([^(]+) \(/.exec(dynamic)?.[1]?.trim();
    const age = /, (\d+ min ago|just now|\d+ hr[^—.]*ago)/.exec(dynamic)?.[1];
    assert.ok(captured && captured.length > 0, 'dynamic block renders a clock time');
    assert.ok(age && age.length > 0, 'dynamic block renders an age');
    assert.equal(stable.includes(captured), false, `stable block leaked the clock "${captured}"`);
    assert.equal(stable.includes(age), false, `stable block leaked the age "${age}"`);
    // "min ago" / "hr ago" wording is inherently per-turn — it has no business
    // in a constant rule regardless of the values above.
    assert.equal(/\b(min|hr|days?) ago\b/i.test(stable), false);
  });

  it('applies to every role, including one without the inventory addendum', async () => {
    const a = await buildSystemPrompt('housekeeping', snapshot(agedBy(5)), 'conv-2', undefined, undefined, NOW);
    const b = await buildSystemPrompt('housekeeping', snapshot(agedBy(45)), 'conv-2', undefined, undefined, NOW);
    assert.equal(a.stable, b.stable);
    assert.match(a.stable, /How old the numbers are/);
  });
});

describe('the refresh-the-page lie is gone', () => {
  it('appears in neither block', async () => {
    const { stable, dynamic } = await buildSystemPrompt(
      'general_manager',
      snapshot(agedBy(5)),
      'conv-1',
      undefined,
      undefined,
      NOW,
    );
    // The deleted sentence, both halves of it.
    assert.equal(/suggest they refresh the page/i.test(stable + dynamic), false);
    assert.equal(/rebuilt every turn from live data/i.test(stable + dynamic), false);
    // The dynamic snapshot block must not mention refreshing at all — the
    // only surviving mention anywhere is the stable rule FORBIDDING it.
    assert.equal(/refresh/i.test(dynamic), false);
  });

  it('the stable rule explicitly forbids it instead', async () => {
    const { stable } = await buildSystemPrompt('owner', snapshot(agedBy(5)), 'conv-1', undefined, undefined, NOW);
    assert.match(stable, /NEVER tell the user to refresh/i);
  });
});

describe('version label', () => {
  it('records the freshness rule so the behaviour change is auditable', async () => {
    const gm = await buildSystemPrompt('general_manager', snapshot(agedBy(5)), 'conv-1', undefined, undefined, NOW);
    assert.match(gm.versionLabel, /data-freshness-v1/);
    // A3 split the stamp in two: `stableStamp` is what gets PRINTED (constant
    // for the conversation), `versionLabel` is what gets PERSISTED and carries
    // the per-turn memory receipt. Printing the persisted one would break the
    // prompt cache every turn — see agent-prompt-tiers.test.ts.
    assert.ok(gm.stable.includes(`Prompt version: ${gm.stableStamp}`));
    // Every role gets the rule, so every role's label carries the version.
    const hk = await buildSystemPrompt('housekeeping', snapshot(agedBy(5)), 'conv-1', undefined, undefined, NOW);
    assert.match(hk.versionLabel, /data-freshness-v1/);
    // The pre-existing inventory routing version is not displaced by it.
    assert.match(gm.versionLabel, /inventory-accounting-v1/);
    assert.equal(/inventory-accounting-v1/.test(hk.versionLabel), false);
  });
});
