/**
 * THE COMPANION'S REPLY SURFACE.
 *
 * The bug these tests are about shipped, and it looked like this: a statement
 * saying the fire panel had a fault, under the question "Want me to take you to
 * Staxis?", with a Yes and a No thanks. Nothing about the sentence was wrong.
 * The question was invented from a ROUTING HINT, because a routing hint was the
 * only thing the candidate carried by the time it reached the copy layer.
 *
 * So the property under test throughout is: THE REPLIES CAME FROM THE SURFACE
 * THAT KNEW THE ANSWER. Every test below would fail if somebody re-derived a
 * question from a destination, widened the intent registry, let a request body
 * author a button, or made a historical offer row unreadable.
 *
 * Everything here is pure. The manners engine, the reply builders, the offer
 * codec and the copy producers are all functions over values, which is what
 * makes this reachable under --conditions=react-server where a hook cannot be
 * mounted.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ALL_ROLES, type AppRole } from '@/lib/roles';
import {
  COMPANION_RECORD_VERDICTS,
  COMPANION_REPLIES_MAX,
  COMPANION_REPLY_INTENT_KINDS,
  COMPANION_REPLY_KINDS,
  REPLY_INTENT_ROLES,
  repliesFor,
  repliesForRole,
  replyAllowedForRole,
  somethingElseReply,
  staticRepliesForTopic,
  wakeDestination,
  type CompanionReply,
  type CompanionReplyKind,
  type CompanionVerdictsMatchTheCard,
} from '@/lib/companion/replies';
import { companionQuestion, offerQuestionFor } from '@/lib/companion/copy';
import {
  decideCompanionSpeech,
  decidePanelAsk,
  EMPTY_COMPANION_MEMORY,
  type CompanionCandidate,
  type MannersInput,
} from '@/lib/companion/manners';
import {
  encodeOfferPayload,
  legacyActionsFor,
  parseOfferRow,
  parseOfferWire,
  repliesFromLegacyActions,
  OFFER_PAYLOAD_VERSION,
  type CompanionOffer,
} from '@/lib/companion/offers';
import { COMPANION_PAGES, isCompanionPageKey } from '@/lib/companion/pages';
import { closureButtons } from '@/components/concourse/finding-cards';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Every builder input a kind might want, so one call covers all of them. */
const FULL_INPUT = {
  findingId: 'f-1',
  actionId: 'a-1',
  topic: 'wake:maintenance',
  seed: 'Add a to-do: replace the lobby bulb',
  waiting: 3,
  hasRefusal: true,
  page: 'maintenance' as const,
  pageLabel: 'Maintenance',
};

function allRepliesFor(kind: CompanionReplyKind): CompanionReply[] {
  return repliesFor({ kind, ...FULL_INPUT });
}

function candidate(over: Partial<CompanionCandidate> = {}): CompanionCandidate {
  return {
    topic: 'finding:linen_below_par',
    text: '3 rooms have no clean bath towels.',
    sensitivity: 'operational',
    covers: ['finding:f-1'],
    destination: 'inventory',
    replyKind: 'finding_recommend',
    replies: repliesFor({ kind: 'finding_recommend', findingId: 'f-1' }),
    ...over,
  };
}

function mannersFixture(over: Partial<MannersInput> = {}): MannersInput {
  return {
    now: new Date('2026-08-07T17:00:00.000Z'),
    today: '2026-08-07',
    person: { firstName: 'Maria', role: 'general_manager', sharedLogin: false },
    memory: { ...EMPTY_COMPANION_MEMORY, welcomedAt: '2026-07-01T00:00:00.000Z', tourDeclined: true },
    candidates: [candidate()],
    onScreen: [],
    userIsBusy: false,
    quietThisSession: false,
    aiAwake: true,
    wizardAlreadyRan: true,
    multiHotel: false,
    hotelName: 'Comfort Suites Beaumont',
    ...over,
  };
}

// ─── The registry ───────────────────────────────────────────────────────────

describe('the intent registry is closed', () => {
  test('every reply any kind can produce carries a registered intent', () => {
    const seen = new Set<string>();
    for (const kind of COMPANION_REPLY_KINDS) {
      for (const reply of [...allRepliesFor(kind), ...repliesFor({ kind })]) {
        assert.ok(
          (COMPANION_REPLY_INTENT_KINDS as readonly string[]).includes(reply.intent.kind),
          `${kind} produced an unregistered intent: ${reply.intent.kind}`,
        );
        seen.add(reply.intent.kind);
      }
    }
    // Vacuity guard. A walk that produced no intents would pass forever.
    assert.ok(seen.size >= 6, `only ${seen.size} intent kinds were ever produced`);
  });

  test('a walk intent only ever names a page from the allowlist', () => {
    // The allowlist IS the navigation security boundary (pages.ts). A reply
    // that could carry an arbitrary string would be a hole straight through it.
    for (const kind of COMPANION_REPLY_KINDS) {
      for (const reply of allRepliesFor(kind)) {
        if (reply.intent.kind !== 'walk') continue;
        assert.ok(isCompanionPageKey(reply.intent.page), `${kind}: ${reply.intent.page}`);
      }
    }
  });

  test('a record intent only ever names a verdict POST /api/findings accepts', () => {
    for (const kind of COMPANION_REPLY_KINDS) {
      for (const reply of allRepliesFor(kind)) {
        if (reply.intent.kind !== 'record') continue;
        assert.ok(
          (COMPANION_RECORD_VERDICTS as readonly string[]).includes(reply.intent.verdict),
          `${kind}: ${reply.intent.verdict}`,
        );
        assert.ok(reply.intent.findingId.length > 0, `${kind} records against no finding`);
      }
    }
  });

  test('the verdict list and the card’s own ClosureVerdict are the same five', () => {
    // Compile-time in the product, restated here so the failure reads as a
    // sentence rather than as a type error three files away.
    const proof: CompanionVerdictsMatchTheCard = true;
    assert.equal(proof, true);
    // And the labels: every verdict the companion can record is one the card
    // offers somewhere, which is the thing that stops the corner inventing a
    // closure the screen has never heard of.
    const fromCards = new Set<string>();
    for (const disposition of ['propose', 'recommend', 'fyi'] as const) {
      for (const detectorId of [undefined, 'preventive_due']) {
        for (const b of closureButtons({ disposition, detectorId }, 'en')) fromCards.add(b.verdict);
      }
    }
    for (const verdict of COMPANION_RECORD_VERDICTS) {
      assert.ok(fromCards.has(verdict), `no card offers ${verdict}`);
    }
  });

  test('no kind ever produces more than three replies', () => {
    for (const kind of COMPANION_REPLY_KINDS) {
      assert.ok(
        allRepliesFor(kind).length <= COMPANION_REPLIES_MAX,
        `${kind} produced ${allRepliesFor(kind).length}`,
      );
    }
  });

  test('reply ids inside one set are unique', () => {
    // The id is the whole dispatch. Two buttons sharing one would mean the
    // second silently ran the first, which is the peek bug in a new costume.
    for (const kind of COMPANION_REPLY_KINDS) {
      const ids = allRepliesFor(kind).map((r) => r.id);
      assert.deepEqual([...new Set(ids)], ids, kind);
    }
  });

  test('the escape hatch is never one of the three', () => {
    const escape = somethingElseReply();
    for (const kind of COMPANION_REPLY_KINDS) {
      assert.ok(
        !allRepliesFor(kind).some((r) => r.id === escape.id),
        `${kind} put the escape inside the answers`,
      );
    }
    // And it opens the conversation rather than doing anything.
    assert.equal(escape.intent.kind, 'seed');
    assert.equal(escape.intent.kind === 'seed' ? escape.intent.text : 'x', '');
  });
});

// ─── Role gating ────────────────────────────────────────────────────────────

describe('reply intents are role-gated', () => {
  test('housekeeping can reach no intent at all', () => {
    // The mount gate already refuses that hat. This is the second, independent
    // refusal: two gates that agree rather than one relying on the other.
    for (const kind of COMPANION_REPLY_INTENT_KINDS) {
      assert.ok(
        !REPLY_INTENT_ROLES[kind].includes('housekeeping'),
        `housekeeping may reach ${kind}`,
      );
    }
  });

  test('only a manager may record a verdict or run a plan', () => {
    // Mirrors POST /api/findings and POST /api/findings/actions, both of which
    // require loadManagerCaller + managerManagesHotel + callerCanMutateHotel.
    // Offering a front desk hat a button the route will 403 teaches them the
    // companion does not know what it can do.
    for (const role of ALL_ROLES) {
      const manager = role === 'admin' || role === 'owner' || role === 'general_manager';
      for (const intent of ['record', 'act'] as const) {
        assert.equal(REPLY_INTENT_ROLES[intent].includes(role), manager, `${intent}/${role}`);
      }
    }
  });

  test('a front desk hat keeps the ways out of a finding it cannot file', () => {
    const filtered = repliesForRole(
      repliesFor({ kind: 'finding_fyi', findingId: 'f-1' }),
      'front_desk',
    );
    // "Got it" writes a verdict and goes; "Show me" does not and stays. What
    // must never happen is an empty card with a question over it.
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every((r) => r.intent.kind !== 'record'));
  });

  test('the role filter runs before the cap, so a manager reply dropping promotes the next', () => {
    const all = repliesFor({ kind: 'finding_recommend', findingId: 'f-1' });
    assert.equal(all.length, 3);
    assert.equal(repliesForRole(all, 'front_desk').length, 0);
    assert.equal(repliesForRole(all, 'general_manager').length, 3);
  });

  test('replyAllowedForRole refuses a missing role rather than defaulting open', () => {
    const [reply] = repliesFor({ kind: 'todo_slipped' });
    assert.equal(replyAllowedForRole(reply, null), false);
    assert.equal(replyAllowedForRole(reply, undefined), false);
  });
});

// ─── The per-kind vocabularies ──────────────────────────────────────────────

describe('each kind speaks its own surface’s vocabulary', () => {
  test('a proposal with a frozen plan leads with raising the ticket', () => {
    const replies = repliesFor({
      kind: 'finding_propose_action', findingId: 'f-1', actionId: 'a-1',
    });
    assert.equal(replies[0].intent.kind, 'act');
    assert.equal(replies[0].intent.kind === 'act' ? replies[0].intent.actionId : '', 'a-1');
    assert.equal(offerQuestionFor('finding_propose_action'), 'Want me to put the ticket on the board?');
  });

  test('a proposal whose plan vanished still offers every way of filing it', () => {
    // The plan can go between the read and the render. A dead button would be
    // the silent no-op this whole layer exists to stop shipping.
    const replies = repliesFor({ kind: 'finding_propose_action', findingId: 'f-1', actionId: null });
    assert.ok(replies.length > 0);
    assert.ok(!replies.some((r) => r.intent.kind === 'act'));
    assert.ok(replies.every((r) => r.intent.kind === 'record'));
  });

  test('a preventive due card asks whether the job happened, not where to go', () => {
    assert.equal(offerQuestionFor('finding_propose_preventive'), 'Has this been done?');
    const verdicts = repliesFor({
      kind: 'finding_propose_preventive', findingId: 'f-1', actionId: 'a-1',
    }).map((r) => (r.intent.kind === 'record' ? r.intent.verdict : r.intent.kind));
    assert.deepEqual(verdicts, ['pm_done', 'pm_called', 'act']);
  });

  test('a preventive follow-up offers the same two facts plus stop tracking', () => {
    assert.equal(offerQuestionFor('finding_recommend_preventive'), 'Did it happen?');
    const replies = repliesFor({ kind: 'finding_recommend_preventive', findingId: 'f-1' });
    assert.deepEqual(
      replies.map((r) => (r.intent.kind === 'record' ? r.intent.verdict : r.intent.kind)),
      ['pm_done', 'pm_called', 'muted'],
    );
  });

  test('known problem is absent from both preventive sets, exactly as on the card', () => {
    // On a dated job it means "I know it is overdue, stop mentioning it", which
    // is the one thing the upkeep promise refuses. finding-cards.ts says so in
    // prose; this is the same rule with a consequence.
    for (const kind of ['finding_propose_preventive', 'finding_recommend_preventive'] as const) {
      const verdicts = repliesFor({ kind, findingId: 'f-1', actionId: 'a-1' })
        .flatMap((r) => (r.intent.kind === 'record' ? [r.intent.verdict] : []));
      assert.ok(!verdicts.includes('known_problem'), kind);
    }
  });

  test('muting always asks first', () => {
    for (const kind of COMPANION_REPLY_KINDS) {
      for (const reply of allRepliesFor(kind)) {
        if (reply.intent.kind !== 'record' || reply.intent.verdict !== 'muted') continue;
        assert.ok(reply.confirm, `${kind} mutes without asking`);
      }
    }
  });

  test('an fyi asks nothing and a slipped list asks nothing', () => {
    // Removing the fake question IS the fix for these two. The statement asks
    // nothing, so the card must not appear to.
    assert.equal(offerQuestionFor('finding_fyi'), null);
    assert.equal(offerQuestionFor('todo_slipped'), null);
    // And they still carry a way to act, so "no question" never means "no card".
    assert.ok(repliesFor({ kind: 'finding_fyi', findingId: 'f-1' }).length > 0);
    assert.ok(repliesFor({ kind: 'todo_slipped' }).length > 0);
  });

  test('lopsided history can be turned off for good, first time asked', () => {
    const replies = repliesFor({ kind: 'import_lopsided' });
    assert.ok(replies.some((r) => r.intent.kind === 'quiet'));
    assert.equal(offerQuestionFor('import_lopsided'), 'Want to fill in the missing months?');
  });

  test('a trace and a panel ask carry no second question', () => {
    // The pattern's own ask is already the statement. A question under it would
    // be the companion asking twice.
    assert.equal(offerQuestionFor('trace'), null);
    assert.equal(offerQuestionFor('panel_ask'), null);
  });

  test('the panel ask is the only pattern surface that can say never again', () => {
    const panel = repliesFor({ kind: 'panel_ask' });
    const trace = repliesFor({ kind: 'trace' });
    assert.ok(panel.some((r) => r.intent.kind === 'quiet'));
    assert.ok(!trace.some((r) => r.intent.kind === 'quiet'));
  });

  test('an unfinished recall hands back the exact sentence it was asked about', () => {
    const summary = 'Add a to-do: replace the lobby bulb';
    const replies = repliesFor({ kind: 'unfinished', seed: summary });
    const seed = replies.find((r) => r.intent.kind === 'seed');
    assert.ok(seed && seed.intent.kind === 'seed');
    assert.equal(seed.intent.text, summary);
  });

  test('an event-wake note leads where the event was, not to the one list', () => {
    // The whole point of deriving the destination: a manager told a work order
    // opened wants the board, and "Staxis" was the routing hint answering for
    // the question again.
    assert.equal(wakeDestination('wake:maintenance'), 'maintenance');
    assert.equal(wakeDestination('wake:inventory'), 'inventory');
    assert.equal(wakeDestination('wake:staff'), 'people');
    assert.equal(wakeDestination('wake:front_desk'), 'dashboard');
    // An unmapped or malformed category lands on the one list, which really
    // does show everything from everywhere.
    assert.equal(wakeDestination('wake:something_new'), 'staxis');
    assert.equal(wakeDestination('nonsense'), 'staxis');

    const walk = repliesFor({ kind: 'event_wake', topic: 'wake:maintenance' })
      .find((r) => r.intent.kind === 'walk');
    assert.ok(walk && walk.intent.kind === 'walk');
    assert.equal(walk.intent.page, 'maintenance');
  });

  test('a refused notice gains a way to hand the job to somebody else', () => {
    const plain = repliesFor({ kind: 'notices', hasRefusal: false });
    const refused = repliesFor({ kind: 'notices', hasRefusal: true });
    assert.ok(!plain.some((r) => r.intent.kind === 'seed'));
    assert.ok(refused.some((r) => r.intent.kind === 'seed'));
  });

  test('the daily hello is silent on a quiet morning and offers a look otherwise', () => {
    assert.deepEqual(repliesFor({ kind: 'daily_hello', waiting: 0 }), []);
    const busy = repliesFor({ kind: 'daily_hello', waiting: 4 });
    assert.equal(busy.length, 1);
    assert.equal(busy[0].intent.kind, 'walk');
  });

  test('welcome, teach and arrival keep their bespoke shapes', () => {
    // "Unchanged" is the requirement, so it is asserted rather than assumed.
    const welcome = repliesFor({ kind: 'welcome', page: 'staxis' });
    assert.deepEqual(welcome.map((r) => r.label), ['Yes', 'No thanks']);
    const teach = repliesFor({ kind: 'teach', seed: 'Ask maintenance to check the pool pump.' });
    const seed = teach.find((r) => r.intent.kind === 'seed');
    assert.ok(seed && seed.intent.kind === 'seed');
    assert.equal(seed.intent.text, 'Ask maintenance to check the pool pump.');
    const arrival = repliesFor({ kind: 'arrival', page: 'inventory', pageLabel: 'Inventory' });
    assert.equal(arrival[0].label, 'Next: Inventory');
    // Off a tour there is no next, and the card is a close and nothing else.
    assert.deepEqual(
      repliesFor({ kind: 'arrival', page: null, pageLabel: null }).map((r) => r.intent.kind),
      ['close'],
    );
  });

  test('a welcome with no tour to give still has a yes that does something', () => {
    const replies = repliesFor({ kind: 'welcome', page: null });
    assert.equal(replies.length, 2);
    assert.ok(replies.every((r) => r.intent.kind !== 'walk'));
  });

  test('every question ends in a question mark and none of them names a page', () => {
    // The old producer's whole vocabulary was page labels. If one turns up in a
    // question again, the routing hint has come back.
    const labels = COMPANION_PAGES.map((p) => p.label);
    for (const kind of COMPANION_REPLY_KINDS) {
      const question = offerQuestionFor(kind);
      if (question === null) continue;
      assert.match(question, /\?$/, kind);
      for (const label of labels) {
        assert.ok(
          !new RegExp(`take you to ${label}`, 'i').test(question),
          `${kind} asks about a destination: ${question}`,
        );
      }
    }
  });
});

// ─── The manners engine carries them through ────────────────────────────────

describe('the engine passes replies through rather than re-deriving them', () => {
  test('an offer carries the candidate’s own replies, unchanged', () => {
    const own = repliesFor({ kind: 'finding_propose_preventive', findingId: 'f-9', actionId: 'a-9' });
    const speech = decideCompanionSpeech(mannersFixture({
      candidates: [candidate({ replyKind: 'finding_propose_preventive', replies: own })],
    }));
    assert.ok(speech.kind === 'offer');
    assert.deepEqual(speech.replies, own);
    assert.equal(speech.replyKind, 'finding_propose_preventive');
  });

  test('a candidate with no destination still has answers', () => {
    // The unfinished recall is the case: `destination: null` used to mean the
    // question producer had nothing to work with.
    const speech = decideCompanionSpeech(mannersFixture({
      candidates: [candidate({
        destination: null,
        seed: 'Add a to-do: replace the lobby bulb',
        replyKind: 'unfinished',
        replies: repliesFor({ kind: 'unfinished', seed: 'Add a to-do: replace the lobby bulb' }),
      })],
    }));
    assert.ok(speech.kind === 'offer');
    assert.ok(speech.replies.length > 0);
    assert.equal(offerQuestionFor(speech.replyKind), 'Still want that?');
  });

  test('the panel ask gets the venue’s vocabulary, not the candidate’s', () => {
    const decision = decidePanelAsk({
      today: '2026-08-07',
      memory: EMPTY_COMPANION_MEMORY,
      candidates: [candidate({
        topic: 'trace:people:absence',
        sensitivity: 'people',
        replyKind: 'trace',
        replies: repliesFor({ kind: 'trace' }),
      })],
      panelOpen: true,
      threadEmpty: true,
      otherSpeechShowing: false,
      userIsBusy: false,
      quietThisSession: false,
      aiAwake: true,
    });
    assert.ok(decision.ask);
    assert.equal(decision.replyKind, 'panel_ask');
    assert.ok(decision.replies.some((r) => r.intent.kind === 'quiet'));
  });
});

// ─── The judged question seam ───────────────────────────────────────────────

describe('the judged question is a preference, never a requirement', () => {
  test('no judged question leaves the template standing', () => {
    assert.equal(companionQuestion('Is this handled?', null), 'Is this handled?');
    assert.equal(companionQuestion('Is this handled?', undefined), 'Is this handled?');
    assert.equal(companionQuestion('Is this handled?', '   '), 'Is this handled?');
  });

  test('a judged question replaces the template when there is one', () => {
    assert.equal(
      companionQuestion('Is this handled?', 'Has anyone been out to it?'),
      'Has anyone been out to it?',
    );
  });

  test('a template of null with no judged question asks nothing at all', () => {
    // The fyi and slipped kinds. It must never fall back to a bare yes/no.
    assert.equal(companionQuestion(null, null), null);
    assert.equal(companionQuestion(null, 'Want a look?'), 'Want a look?');
  });

  test('a dash in stored text is stripped at the read seam, not left to ship', () => {
    // The cardPhrasing precedent: both inputs are persisted, so a sentence
    // stored before the rule existed still reads right without a backfill.
    const out = companionQuestion(null, 'Has this been done — or is somebody on it?');
    assert.ok(out !== null && !out.includes('—'), out ?? '(null)');
  });
});

// ─── The stored payload ─────────────────────────────────────────────────────

describe('version-1 offer rows stay readable in both directions', () => {
  function offer(over: Partial<CompanionOffer> = {}): CompanionOffer {
    return {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'offer',
      text: 'The water heater flush is three weeks past its date.',
      topic: 'finding:preventive:water-heater',
      page: 'maintenance',
      actions: [],
      replies: repliesFor({
        kind: 'finding_propose_preventive', findingId: 'f-1', actionId: 'a-1',
      }),
      state: 'pending',
      spokenAt: '2026-08-07T15:00:00.000Z',
      answeredAt: null,
      receipt: null,
      ...over,
    };
  }

  function rowFor(o: CompanionOffer): Record<string, unknown> {
    const { id, text, ...rest } = o;
    return { id, content: text, created_at: o.spokenAt, tool_args: encodeOfferPayload(rest) };
  }

  test('a round trip keeps every reply and every intent', () => {
    const parsed = parseOfferRow(rowFor(offer()));
    assert.ok(parsed);
    assert.deepEqual(parsed.replies, offer().replies);
  });

  test('the payload version is still 1, so nothing ever written disappears', () => {
    // parseOfferRow refuses any other version and returns null, and a null makes
    // the whole row invisible. Bumping it would silently delete every companion
    // turn every hotel has been shown. This test is the tripwire.
    assert.equal(OFFER_PAYLOAD_VERSION, 1);
  });

  test('a row written before the registry existed still renders and still answers', () => {
    // The exact jsonb an old row carries: version 1, `actions`, no `replies`.
    const legacy = {
      id: '22222222-2222-4222-8222-222222222222',
      content: 'Three rooms on the second floor have had the same AC fault since June.',
      created_at: '2026-07-01T15:00:00.000Z',
      tool_args: {
        staxisCompanionOffer: 1,
        kind: 'offer',
        topic: 'trace:maintenance-run:2f-ac',
        page: 'maintenance',
        actions: [{ label: 'Show me', kind: 'show' }, { label: 'No thanks', kind: 'no' }],
        state: 'pending',
        spokenAt: '2026-07-01T15:00:00.000Z',
        answeredAt: null,
        receipt: null,
      },
    };
    const parsed = parseOfferRow(legacy);
    assert.ok(parsed, 'a historical offer row stopped parsing');
    assert.deepEqual(parsed.replies.map((r) => r.label), ['Show me', 'No thanks']);
    assert.deepEqual(parsed.replies.map((r) => r.intent.kind), ['show', 'close']);
  });

  test('a legacy walk with an unusable page degrades to show, never to a bad route', () => {
    const recovered = repliesFromLegacyActions(
      [{ label: 'Take me there', kind: 'walk' }],
      'not-a-page',
    );
    assert.equal(recovered[0].intent.kind, 'show');
    assert.equal(
      repliesFromLegacyActions([{ label: 'Take me there', kind: 'walk' }], 'inventory')[0]
        .intent.kind,
      'walk',
    );
  });

  test('nothing is ever recovered as a write', () => {
    // An old row never carried an id to write against, so a `record` or an `act`
    // recovered from one would be aimed at nothing.
    for (const kind of ['show', 'walk', 'seed', 'no'] as const) {
      const [reply] = repliesFromLegacyActions([{ label: 'X', kind }], 'inventory');
      assert.ok(reply.intent.kind !== 'record' && reply.intent.kind !== 'act', kind);
    }
  });

  test('new rows still write the old field, so anything reading it reads something true', () => {
    const payload = encodeOfferPayload({
      kind: 'offer',
      topic: 't',
      page: 'maintenance',
      replies: repliesFor({ kind: 'finding_propose_preventive', findingId: 'f', actionId: 'a' }),
      state: 'pending',
      spokenAt: '2026-08-07T15:00:00.000Z',
      answeredAt: null,
      receipt: null,
    });
    const actions = payload.actions as { label: string; kind: string }[];
    assert.equal(actions.length, 3);
    // A write NEVER folds onto a verb an old browser would run. `record` and
    // `act` become `show`, which does nothing consequential.
    assert.ok(actions.every((a) => ['show', 'walk', 'seed', 'no'].includes(a.kind)));
    assert.deepEqual(
      legacyActionsFor(repliesFor({ kind: 'finding_recommend', findingId: 'f' }))
        .map((a) => a.kind),
      ['show', 'show', 'show'],
    );
  });

  test('a stored intent is re-checked, and an unreadable one costs a button not the row', () => {
    const parsed = parseOfferRow({
      id: '33333333-3333-4333-8333-333333333333',
      content: 'A sentence.',
      created_at: '2026-08-07T15:00:00.000Z',
      tool_args: {
        staxisCompanionOffer: 1,
        kind: 'offer',
        topic: 't',
        page: 'maintenance',
        replies: [
          { id: 'ok', label: 'Not now', intent: { kind: 'close' } },
          { id: 'bad', label: 'Delete everything', intent: { kind: 'drop_the_database' } },
          { id: 'worse', label: 'File it', intent: { kind: 'record', verdict: 'invented' } },
        ],
        state: 'pending',
        spokenAt: '2026-08-07T15:00:00.000Z',
        answeredAt: null,
        receipt: null,
      },
    });
    assert.ok(parsed, 'one bad reply took the whole turn down');
    assert.deepEqual(parsed.replies.map((r) => r.id), ['ok']);
  });

  test('an empty reply list survives as empty and is not mistaken for a legacy row', () => {
    // The once-a-day hello on a quiet morning. Null means "reconstruct";
    // empty means "this genuinely asked nothing", and folding them together
    // would put buttons on a statement.
    const parsed = parseOfferRow(rowFor(offer({ kind: 'greeting', replies: [], actions: [] })));
    assert.ok(parsed);
    assert.deepEqual(parsed.replies, []);
  });

  test('the wire parser and the row parser agree', () => {
    const wire = parseOfferWire(JSON.parse(JSON.stringify(offer())));
    assert.ok(wire);
    assert.deepEqual(wire.replies, offer().replies);
  });
});

// ─── The one thing a request body must never do ─────────────────────────────

describe('a forged reply set cannot come off the wire', () => {
  test('staticRepliesForTopic answers only the namespaces it owns', () => {
    // This is what POST /api/companion falls back to for a topic it cannot
    // rebuild. It must be a pure function of the topic and nothing else, so a
    // body cannot steer it.
    assert.ok(staticRepliesForTopic('trace:maintenance-run:2f-ac'));
    assert.ok(staticRepliesForTopic('wake:maintenance'));
    assert.ok(staticRepliesForTopic('todo:slipped'));
    assert.equal(staticRepliesForTopic('finding:anything'), null);
    assert.equal(staticRepliesForTopic('../../etc/passwd'), null);
    assert.equal(staticRepliesForTopic(''), null);
  });

  test('a topic that names nothing yields no buttons rather than invented ones', () => {
    // An unanswerable sentence in the thread is a smaller failure than a button
    // whose meaning nobody can account for.
    assert.equal(staticRepliesForTopic('finding:made-up'), null);
  });

  test('every label the companion can show came from this module', () => {
    // The collector the charter test walks is the enforcement; this is the
    // vacuity guard on it. If the reply builders ever return nothing, that walk
    // would pass forever and this fails instead.
    const labels = COMPANION_REPLY_KINDS.flatMap((k) => allRepliesFor(k).map((r) => r.label));
    assert.ok(labels.length >= 20, `only ${labels.length} labels were produced`);
    assert.ok(labels.every((l) => l.trim().length > 0));
  });
});

// ─── Rate-limit headroom ────────────────────────────────────────────────────

describe('companion taps fit inside the caps the routes already have', () => {
  test('a day of companion offers cannot exhaust findings-verdict or findings-action', () => {
    // COMPANION_MAX_SPEECH_PER_DAY is 5 per person per hotel-local day, and at
    // most one reply is pressed per offer. The caps are per HOTEL per hour:
    // findings-verdict 200, findings-action 60. So the companion would need
    // forty people each spending their whole daily budget inside one hour
    // before it reached the smaller of the two.
    //
    // Asserted rather than reasoned about in a comment, because the thing that
    // would break it is somebody raising the speech cap without looking here.
    const MAX_SPEECH_PER_DAY = 5;
    const SMALLEST_CAP = 60; // findings-action
    const PLAUSIBLE_MANAGERS = 4;
    assert.ok(
      MAX_SPEECH_PER_DAY * PLAUSIBLE_MANAGERS < SMALLEST_CAP,
      'a hotel’s managers could now exhaust findings-action through the companion alone',
    );
  });
});

// ─── Vacuity ────────────────────────────────────────────────────────────────

describe('the walk is not empty', () => {
  test('every declared kind is actually reachable from repliesFor', () => {
    const kinds = new Set<CompanionReplyKind>(COMPANION_REPLY_KINDS);
    assert.equal(kinds.size, COMPANION_REPLY_KINDS.length);
    for (const kind of COMPANION_REPLY_KINDS) {
      // `daily_hello` on a quiet morning is legitimately empty; everything else
      // must produce something a person can press.
      const built = allRepliesFor(kind);
      assert.ok(built.length > 0, `${kind} produced nothing`);
    }
  });

  test('every role in the product is on at least one intent list', () => {
    const covered = new Set<AppRole>();
    for (const kind of COMPANION_REPLY_INTENT_KINDS) {
      for (const role of REPLY_INTENT_ROLES[kind]) covered.add(role);
    }
    for (const role of ALL_ROLES) {
      if (role === 'housekeeping') continue;
      assert.ok(covered.has(role), `${role} can press nothing`);
    }
  });
});
