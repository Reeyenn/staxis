/**
 * OFFERS ARE CHAT TURNS — the rules that make that true.
 *
 * The companion used to say things that ceased to exist six seconds later: a
 * pill appeared, a No went into a ledger nobody could see, and there was no
 * way back to any of it. Now every sentence it says first is a message in the
 * thread with a state on it. This file is the machine-readable version of the
 * promises that came with that, and every one of them is a promise that fails
 * SILENTLY if it breaks — a lost offer, a double-counted No, a stale reveal
 * drawn as though it were current. None of those throw.
 *
 * WHAT EACH BLOCK WOULD CATCH. The five marked ✓ were applied to the real
 * source and the suite was watched go red on each, then restored:
 *
 * ✓ ONE LEDGER      `offerCountsAsDecline` returning true for 'expired' —
 *                   silence counted as a No, so topics nobody ever saw get
 *                   dropped for good.
 * ✓ ONCE ONLY       letting `answerOffer` re-answer a resolved offer, which is
 *                   how a double-tap or a replayed request costs two declines
 *                   against a topic that was turned down once.
 * ✓ REVISITABLE     making `offerIsReplayable` false for a declined offer: the
 *                   exact bug this feature was built to fix, and the one that
 *                   looks most like correct behaviour.
 * ✓ THE PILL WAITS  `peekPersists` returning false for a pill with buttons,
 *                   which is the six-second retreat answering No for you.
 * ✓ HINTS           matching on ANY word rather than all of them, which draws
 *                   a confidently wrong diagram the person cannot detect.
 *   ROUND TRIP      dropping a field from the stored payload, or letting the
 *                   payload's own text override the row it sits on.
 *   THE TOOL        widening staxis_show_pattern past the hats the trace
 *                   itself serves, or letting it onto the portfolio surface.
 *
 * What is NOT covered here, and is not pretended to be: the pill's pixels. That
 * the sentence wraps instead of ellipsising is CSS, and the suite runs under
 * --conditions=react-server where no component can mount. What IS asserted is
 * the invariant underneath it — the whole sentence is stored and returned whole
 * — so a truncation that crept back into the DATA would fail here even though
 * one that crept back into the stylesheet would not.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  answerOffer,
  encodeOfferPayload,
  hintMatches,
  newestUnresolved,
  offerCountsAsDecline,
  offerIsReplayable,
  offerIsUnresolved,
  offerStateNote,
  parseOfferRow,
  parseOfferWire,
  sortOffers,
  upsertOffer,
  OFFER_STALE_LINE,
  OFFER_TEXT_MAX,
  type CompanionOffer,
} from '@/lib/companion/offers';
import { peekPersists, shouldAutoPeek } from '@/lib/companion/dock';
import {
  EMPTY_COMPANION_MEMORY,
  rememberDeclined,
  type CompanionMemory,
} from '@/lib/companion/manners';
import { repliesFor } from '@/lib/companion/replies';
import '@/lib/agent/tools/index';
import { getTool, getToolsForRole } from '@/lib/agent/tools';
import { ALL_ROLES, type AppRole } from '@/lib/roles';

const NOW = '2026-08-03T15:00:00.000Z';
const LATER = '2026-08-03T15:04:00.000Z';

/** A real trace offer, in the shape the store hands back. */
function offer(over: Partial<CompanionOffer> = {}): CompanionOffer {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'offer',
    text: 'Three rooms on the second floor have had the same AC fault since June. Mind if I show you?',
    topic: 'trace:maintenance-run:2f-ac',
    page: 'maintenance',
    actions: [{ label: 'Show me', kind: 'show' }, { label: 'Not now', kind: 'no' }],
    replies: repliesFor({ kind: 'trace' }),
    state: 'pending',
    spokenAt: NOW,
    answeredAt: null,
    receipt: null,
    ...over,
  };
}

/** The row as it actually sits in agent_messages. */
function rowFor(o: CompanionOffer): Record<string, unknown> {
  return {
    id: o.id,
    content: o.text,
    created_at: o.spokenAt,
    tool_args: encodeOfferPayload({
      kind: o.kind,
      topic: o.topic,
      page: o.page,
      replies: o.replies,
      state: o.state,
      spokenAt: o.spokenAt,
      answeredAt: o.answeredAt,
      receipt: o.receipt,
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ONE DECLINE LEDGER, AND THE MESSAGE STATE IS NOT IT
// ═══════════════════════════════════════════════════════════════════════════

describe('there is still exactly one place a No is counted', () => {
  test('stamping a message state does not touch the manners memory', () => {
    // The mutation this is aimed at: somebody "helpfully" makes the offer state
    // machine also maintain a count, and now two ledgers drift and the
    // never-nag guarantee quietly depends on which one you read.
    const memory: CompanionMemory = rememberDeclined(
      EMPTY_COMPANION_MEMORY, 'trace:maintenance-run:2f-ac', '2026-08-01',
    );
    const before = JSON.stringify(memory);

    const declined = answerOffer(offer(), 'declined', LATER);
    const dismissed = answerOffer(offer(), 'dismissed', LATER);
    const accepted = answerOffer(offer(), 'accepted', LATER);

    assert.equal(declined?.state, 'declined');
    assert.equal(dismissed?.state, 'dismissed');
    assert.equal(accepted?.state, 'accepted');
    // The whole point: none of that changed the count of anything.
    assert.equal(JSON.stringify(memory), before);
    assert.equal(memory.topics['trace:maintenance-run:2f-ac'].declines, 1);
  });

  test('a dismissal is a decline and silence is not', () => {
    // From the person's side a No and a wave-away are the same act, which is
    // the rule the manners ledger was built on. An offer that simply expired
    // was never answered, and counting it would drop topics nobody ever saw.
    assert.equal(offerCountsAsDecline('declined'), true);
    assert.equal(offerCountsAsDecline('dismissed'), true);
    assert.equal(offerCountsAsDecline('expired'), false);
    assert.equal(offerCountsAsDecline('accepted'), false);
  });

  test('a dismissal is rendered as one, not as a No they never said', () => {
    assert.equal(offerStateNote('dismissed'), '(dismissed)');
    assert.notEqual(offerStateNote('dismissed'), offerStateNote('declined'));
    assert.equal(offerStateNote('pending'), null);
    assert.equal(offerStateNote('accepted'), null);
  });

  test('one offer answered twice costs exactly one decline', () => {
    // The double-tap, the replayed request, the second tab. The state machine
    // refuses, the route reads that refusal as "do not touch the ledger
    // either", and the count stays at one.
    const first = answerOffer(offer(), 'declined', LATER);
    assert.ok(first);
    assert.equal(answerOffer(first, 'declined', LATER), null);
    assert.equal(answerOffer(first, 'dismissed', LATER), null);
    assert.equal(answerOffer(first, 'accepted', LATER), null);

    let memory: CompanionMemory = EMPTY_COMPANION_MEMORY;
    for (const attempt of ['declined', 'declined', 'dismissed'] as const) {
      const next = answerOffer(first, attempt, LATER);
      if (next) memory = rememberDeclined(memory, first.topic!, '2026-08-03');
    }
    assert.equal(memory.topics[first.topic!], undefined);
  });

  test('a receipt is a statement and cannot be answered', () => {
    const receipt = offer({ kind: 'receipt', state: 'accepted' });
    assert.equal(answerOffer(receipt, 'declined', LATER), null);
    assert.equal(offerIsUnresolved(receipt), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. REVISITABLE FOREVER
// ═══════════════════════════════════════════════════════════════════════════

describe('an offer can be gone back to, whatever answer it got', () => {
  test('a declined trace offer is still replayable', () => {
    // The bug this whole feature exists to fix, and the one that looks most
    // like correct behaviour: a No is permission to stop RAISING it, not an
    // instruction to hide it when somebody asks for it by name.
    for (const state of ['pending', 'declined', 'dismissed', 'accepted', 'expired'] as const) {
      assert.equal(offerIsReplayable(offer({ state })), true, `state ${state}`);
    }
  });

  test('a greeting and a receipt have nothing to replay', () => {
    assert.equal(offerIsReplayable(offer({ kind: 'greeting', topic: null })), false);
    assert.equal(offerIsReplayable(offer({ kind: 'receipt' })), false);
    // No pattern key means nothing to ask the server for by name.
    assert.equal(offerIsReplayable(offer({ topic: null })), false);
  });

  test('the honest answer when it no longer computes says so', () => {
    assert.match(OFFER_STALE_LINE, /handled already/);
    // No em dash — founder ruling, and this string is rendered verbatim.
    assert.equal(OFFER_STALE_LINE.includes('—'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ONE AT A TIME, AND THE PILL WAITS FOR AN ANSWER
// ═══════════════════════════════════════════════════════════════════════════

describe('the corner asks one thing and then waits', () => {
  test('only one unresolved offer is ever the live one', () => {
    const older = offer({ id: 'a'.repeat(8), spokenAt: '2026-08-03T09:00:00.000Z' });
    const newer = offer({ id: 'b'.repeat(8), spokenAt: '2026-08-03T14:00:00.000Z' });
    const answered = offer({ id: 'c'.repeat(8), state: 'declined', spokenAt: NOW });
    const live = newestUnresolved([older, answered, newer]);
    assert.equal(live?.id, newer.id);
    assert.equal(newestUnresolved([answered]), null);
    assert.equal(newestUnresolved([]), null);
  });

  test('a pill with buttons does not retreat; a statement still does', () => {
    // Six seconds and gone was the app answering No on the person's behalf.
    assert.equal(peekPersists({ hasActions: true }), true);
    // The hello asks nothing, so it says its piece and goes, as it always has.
    assert.equal(peekPersists({ hasActions: false }), false);
  });

  test('it still never speaks over somebody who is typing', () => {
    // Persisting is about how long it lingers ONCE SHOWN. Whether it may appear
    // at all is untouched, and the never-while-typing floor is the one rule
    // that would be most tempting to lose in this rework.
    const base = { key: 'k', shown: new Set<string>(), open: false, dragging: false };
    assert.equal(shouldAutoPeek({ ...base, busy: true }), false);
    assert.equal(shouldAutoPeek({ ...base, open: true, busy: false }), false);
    assert.equal(shouldAutoPeek({ ...base, dragging: true, busy: false }), false);
    assert.equal(shouldAutoPeek({ ...base, busy: false }), true);
    assert.equal(
      shouldAutoPeek({ ...base, shown: new Set(['k']), busy: false }), false,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. IT SURVIVES THE PANEL CLOSING, WHICH IS THE WHOLE FEATURE
// ═══════════════════════════════════════════════════════════════════════════

describe('a turn written down comes back exactly as it was said', () => {
  test('a full round trip through the stored row loses nothing', () => {
    const spoken = offer({
      state: 'accepted',
      answeredAt: LATER,
      receipt: { table: 'work_orders', id: 'wo-1', label: 'Look at the 2nd floor AC run', where: 'Room 214' },
    });
    const back = parseOfferRow(rowFor(spoken));
    assert.deepEqual(back, spoken);
  });

  test('the sentence is stored whole, not clipped to a pill', () => {
    // The pill used to ellipsise a long offer at whatever fitted on one line,
    // which cut most of them off exactly where the reason lived.
    const long = `${'Three rooms on the second floor have had the same fault since June. '.repeat(3)}Mind if I show you?`;
    assert.ok(long.length > 140 && long.length <= OFFER_TEXT_MAX);
    const back = parseOfferRow(rowFor(offer({ text: long })));
    assert.equal(back?.text, long.replace(/\s+/g, ' ').trim());
  });

  test('the same shape survives the trip over the wire to the browser', () => {
    const spoken = offer({ state: 'dismissed', answeredAt: LATER });
    assert.deepEqual(parseOfferWire(JSON.parse(JSON.stringify(spoken))), spoken);
  });

  test('a row we cannot read renders as nothing rather than as a mangled quote', () => {
    // Half-rendering a sentence in the companion's voice is worse than showing
    // none of it: nobody can tell which half they are reading.
    assert.equal(parseOfferRow({ id: 'x', content: 'hi', tool_args: null }), null);
    assert.equal(parseOfferRow({ id: 'x', content: 'hi', tool_args: { staxisCompanionOffer: 99 } }), null);
    assert.equal(parseOfferRow({ ...rowFor(offer()), id: undefined }), null);
    assert.equal(parseOfferRow({ ...rowFor(offer()), content: '   ' }), null);
    assert.equal(parseOfferWire('nope'), null);
  });

  test('the payload cannot rename the row it is sitting on', () => {
    // `content` and `id` are read off the row's own columns. A payload that
    // disagreed with them would be a way to put different words in the
    // companion's mouth than the ones that were actually said.
    const row = rowFor(offer());
    (row.tool_args as Record<string, unknown>).text = 'something else entirely';
    (row.tool_args as Record<string, unknown>).id = 'someone-elses-id';
    const back = parseOfferRow(row);
    assert.equal(back?.text, offer().text);
    assert.equal(back?.id, offer().id);
  });

  test('an unknown button kind is dropped rather than rendered as a dead control', () => {
    const row = rowFor(offer());
    (row.tool_args as Record<string, unknown>).actions = [
      { label: 'Show me', kind: 'show' },
      { label: 'Delete everything', kind: 'nuke' },
      { label: '', kind: 'no' },
    ];
    assert.deepEqual(parseOfferRow(row)?.actions, [{ label: 'Show me', kind: 'show' }]);
  });

  test('reopening the thread puts them back in the order they were said', () => {
    const a = offer({ id: 'a'.repeat(8), spokenAt: '2026-08-03T09:00:00.000Z' });
    const b = offer({ id: 'b'.repeat(8), spokenAt: '2026-08-03T11:00:00.000Z' });
    const c = offer({ id: 'c'.repeat(8), spokenAt: '2026-08-03T13:00:00.000Z' });
    assert.deepEqual(sortOffers([c, a, b]).map((o) => o.id), [a.id, b.id, c.id]);
    // The optimistic copy and the server's answer are the same turn, once.
    const merged = upsertOffer([a, b], { ...b, state: 'accepted' });
    assert.equal(merged.length, 2);
    assert.equal(merged[1].state, 'accepted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. "SHOW ME THAT AC THING"
// ═══════════════════════════════════════════════════════════════════════════

describe('resolving a phrase to a pattern', () => {
  const ac = 'Three rooms on the second floor have had the same AC fault since June';
  const towels = 'Bath towels are down to eleven days of cover at the current burn';

  test('a hint lands on the thing it is actually about', () => {
    assert.equal(hintMatches('that AC thing', ac), true);
    assert.equal(hintMatches('the second floor', ac), true);
    assert.equal(hintMatches('towels', towels), true);
  });

  test('every meaningful word has to land, not just one', () => {
    // The mutation this catches: matching on ANY word. "the AC thing" then
    // matches the towel pattern through "the", and the person gets a confident
    // diagram of the wrong thing with no way to tell it guessed.
    assert.equal(hintMatches('that AC thing', towels), false);
    assert.equal(hintMatches('second floor towels', ac), false);
  });

  test('a hint with nothing in it points at nothing', () => {
    // "show me that one" names no pattern. Matching it to whatever is nearest
    // is how the wrong reveal gets drawn confidently.
    assert.equal(hintMatches('show me that one again', ac), false);
    assert.equal(hintMatches('   ', ac), false);
  });

  test('a prefix counts and an accident does not', () => {
    assert.equal(hintMatches('cool', 'the unit cooling stopped'), true);
    // 'ac' must not find 'backlog'.
    assert.equal(hintMatches('ac', 'the backlog is long'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE CHAT TOOL, GATED WHERE THE TRACE IS GATED
// ═══════════════════════════════════════════════════════════════════════════

describe('staxis_show_pattern is offered exactly where the trace is', () => {
  const names = (role: AppRole, surface: 'chat' | 'portfolio' | 'walkthrough' = 'chat') =>
    getToolsForRole(role, surface).map((t) => t.name);

  test('the hats the trace serves have it', () => {
    for (const role of ['admin', 'owner', 'general_manager', 'maintenance', 'staff'] as AppRole[]) {
      assert.ok(names(role).includes('staxis_show_pattern'), `${role} should have it`);
    }
  });

  test('a housekeeper never sees it, because they have no companion at all', () => {
    assert.deepEqual(names('housekeeping'), []);
  });

  test('the front desk does not get it, like every other staxis tool', () => {
    assert.equal(names('front_desk').includes('staxis_show_pattern'), false);
  });

  test('it never reaches the cross-hotel surface', () => {
    // A reveal is drawn against rows on ONE hotel's screen. The portfolio
    // catalog is disjoint by construction (no `surfaces` declared means chat
    // only), and this asserts the construction rather than trusting it.
    for (const role of ALL_ROLES) {
      assert.equal(names(role, 'portfolio').includes('staxis_show_pattern'), false);
      assert.equal(names(role, 'walkthrough').includes('staxis_show_pattern'), false);
    }
  });

  test('it changes nothing, so it needs no approval card', () => {
    const tool = getTool('staxis_show_pattern');
    assert.ok(tool);
    // A mutating tool would never reach the browser at all: mutations go
    // through the approval card and never emit tool_call_started inline, which
    // is the event the reveal listens for. Read-only is load-bearing here, not
    // incidental.
    assert.notEqual(tool!.mutates, true);
    assert.equal(tool!.approval, undefined);
  });

  test('it refuses an empty hint instead of drawing something arbitrary', async () => {
    const tool = getTool('staxis_show_pattern');
    const ctx = {
      user: {
        uid: 'u', accountId: '00000000-0000-0000-0000-000000000001', username: 'u',
        displayName: 'U', role: 'general_manager' as AppRole, propertyAccess: [],
      },
      propertyId: '11111111-1111-4111-8111-111111111111',
      staffId: null,
      requestId: 'r',
      surface: 'chat' as const,
    };
    const empty = await tool!.handler({ hint: '  ' }, { ...ctx, db: {} } as never);
    assert.equal(empty.ok, false);
    const good = await tool!.handler({ hint: 'the AC run' }, { ...ctx, db: {} } as never);
    assert.equal(good.ok, true);
    assert.deepEqual(good.data, { showing: true, hint: 'the AC run' });
  });
});
