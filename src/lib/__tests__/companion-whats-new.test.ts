/**
 * "Want to see what is new?" — versioning, and the two memories that stop it
 * being a nag.
 *
 * ─── THE THING THE FOUNDER REJECTED, AND WHY THIS IS NOT IT ────────────────
 *
 * A periodic capability hint in the daily hello was rejected outright. The
 * honest need underneath it is not a reminder on a timer, it is that something
 * CHANGED and the people who already learned the old shape have no way to find
 * out. So the trigger here is a fact with a date on it, not a schedule, and an
 * empty registry produces total silence. That last property is the one worth
 * a test on a day nothing shipped, which is most days.
 *
 * The plausible bugs are all about the two cursors:
 *   • a new hire meeting six months of backlog on their second day
 *   • an entry re-offered after somebody declined it, because a NEWER one
 *     arrived and moved the high-water mark
 *   • a GM being offered a change to a screen their hotel switched off
 *   • a front desk hire being walked through a manager-only control
 * Each has a test.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AppRole } from '@/lib/roles';
import type { EnabledSections } from '@/lib/sections/registry';
import { EMPTY_COMPANION_MEMORY, rememberWhatsNewSeen, type CompanionMemory } from '@/lib/companion/manners';
import type { TourContext, TourStop } from '@/lib/companion/tour';
import {
  decideWhatsNew,
  WHATS_NEW,
  whatsNewHighWater,
  whatsNewTopic,
  type WhatsNewEntry,
} from '@/lib/companion/whats-new';
import { offerQuestionFor, whatsNewQuestion, whatsNewSentence } from '@/lib/companion/copy';
import { repliesFor } from '@/lib/companion/replies';

function ctx(
  role: AppRole | null,
  over: { canManage?: boolean; seesMoney?: boolean; enabledSections?: EnabledSections } = {},
): TourContext {
  const enabledSections = over.enabledSections ?? null;
  return {
    role,
    enabledSections,
    standing: {
      canManage: over.canManage ?? true,
      seesMoney: over.seesMoney ?? true,
      enabledSections,
    },
  };
}

function welcomed(over: Partial<CompanionMemory> = {}): CompanionMemory {
  return {
    ...EMPTY_COMPANION_MEMORY,
    taught: {},
    topics: {},
    welcomedAt: '2026-06-01T09:00:00.000Z',
    ...over,
  };
}

const MANAGER_STOP: TourStop = {
  key: 'wn-settings', page: 'settings', anchor: null, kind: 'watch', managerOnly: true,
  say: 'Shifts now live here.',
};
const INVENTORY_STOP: TourStop = {
  key: 'wn-inventory', page: 'inventory', anchor: 'nav-inventory', kind: 'watch',
  say: 'The stockroom got a new rail.',
};
const EVERYONE_STOP: TourStop = {
  key: 'wn-list', page: 'staxis', anchor: 'todo-composer', kind: 'watch',
  say: 'The box at the top takes a date now.',
};

const JUNE: WhatsNewEntry = {
  id: 'june-thing', shippedOn: '2026-06-10', headline: 'The list got a composer.', stops: [EVERYONE_STOP],
};
const JULY: WhatsNewEntry = {
  id: 'july-thing', shippedOn: '2026-07-20', headline: 'The stockroom rail moved.', stops: [INVENTORY_STOP],
};
const AUGUST_MANAGER: WhatsNewEntry = {
  id: 'august-thing', shippedOn: '2026-08-01', headline: 'Shifts moved into Settings.', stops: [MANAGER_STOP],
};
const REGISTRY = [JUNE, JULY, AUGUST_MANAGER];

describe('an empty registry says nothing at all', () => {
  test('the shipped registry is quiet until somebody writes an entry', () => {
    // Not a placeholder test. "Nothing shipped, so nothing is said" is the
    // behaviour on most days, and a registry that grew a row per release would
    // become the changelog nobody wanted.
    const d = decideWhatsNew(ctx('general_manager'), welcomed(), WHATS_NEW);
    assert.equal(d.show, false);
    assert.equal(d.show === false && d.refusal, 'nothing_shipped');
  });

  test('the default argument really is the shipped registry', () => {
    assert.deepEqual(decideWhatsNew(ctx('general_manager'), welcomed()), {
      show: false, refusal: 'nothing_shipped',
    });
  });

  test('the high-water mark of nothing is nothing', () => {
    assert.equal(whatsNewHighWater([]), null);
  });
});

describe('the catch-up cursor', () => {
  test('a person caught up through August hears about nothing older', () => {
    const d = decideWhatsNew(ctx('general_manager'), welcomed({ whatsNewThrough: '2026-08-01' }), REGISTRY);
    assert.equal(d.show, false);
    assert.equal(d.show === false && d.refusal, 'all_caught_up');
  });

  test('a person caught up through July hears about August and nothing before it', () => {
    const d = decideWhatsNew(ctx('general_manager'), welcomed({ whatsNewThrough: '2026-07-20' }), REGISTRY);
    assert.equal(d.show, true);
    assert.equal(d.show && d.entry.id, 'august-thing');
  });

  test('somebody owed two changes meets them oldest first', () => {
    // Backwards would be a person reading the sequel before the book.
    const d = decideWhatsNew(ctx('general_manager'), welcomed({ whatsNewThrough: '2026-06-30' }), REGISTRY);
    assert.equal(d.show && d.entry.id, 'july-thing');
  });

  test('a null cursor owes everything, which is what a stamp at welcome prevents', () => {
    const d = decideWhatsNew(ctx('general_manager'), welcomed(), REGISTRY);
    assert.equal(d.show && d.entry.id, 'june-thing');
  });

  test('the high-water mark is the newest entry, not the one just shown', () => {
    // A person shown the newest change is caught up on everything older too.
    // Advancing only as far as the entry they saw would re-offer the next one
    // on the very next page load.
    assert.equal(whatsNewHighWater(REGISTRY), '2026-08-01');
  });

  test('the cursor is monotonic: a stale tab cannot drag it backwards', () => {
    const at = welcomed({ whatsNewThrough: '2026-08-01' });
    assert.equal(rememberWhatsNewSeen(at, '2026-06-10').whatsNewThrough, '2026-08-01');
    assert.equal(rememberWhatsNewSeen(at, '2026-09-09').whatsNewThrough, '2026-09-09');
  });

  test('a malformed day is ignored rather than written', () => {
    const at = welcomed({ whatsNewThrough: '2026-07-20' });
    assert.equal(rememberWhatsNewSeen(at, 'yesterday').whatsNewThrough, '2026-07-20');
    assert.equal(rememberWhatsNewSeen(at, '').whatsNewThrough, '2026-07-20');
  });
});

describe('once per entry, per person', () => {
  test('a dropped entry is skipped and the next one is offered instead', () => {
    const memory = welcomed({
      topics: { [whatsNewTopic('june-thing')]: { declines: 2, dropped: true, lastOfferedDay: '2026-06-11' } },
    });
    const d = decideWhatsNew(ctx('general_manager'), memory, REGISTRY);
    assert.equal(d.show && d.entry.id, 'july-thing');
  });

  test('every entry answered means nothing to offer', () => {
    const topics = Object.fromEntries(
      REGISTRY.map((e) => [whatsNewTopic(e.id), { declines: 2, dropped: true, lastOfferedDay: '2026-08-02' }]),
    );
    const d = decideWhatsNew(ctx('general_manager'), welcomed({ topics }), REGISTRY);
    assert.equal(d.show, false);
    assert.equal(d.show === false && d.refusal, 'nothing_for_this_person');
  });

  test('the topic is namespaced so it cannot collide with a finding', () => {
    assert.equal(whatsNewTopic('june-thing'), 'whatsnew:june-thing');
  });

  test('never before the welcome', () => {
    const d = decideWhatsNew(
      ctx('general_manager'),
      { ...EMPTY_COMPANION_MEMORY, taught: {}, topics: {} },
      REGISTRY,
    );
    assert.equal(d.show, false);
    assert.equal(d.show === false && d.refusal, 'never_welcomed');
  });
});

describe('role and section awareness, adversarially', () => {
  test('a front desk hire is never offered a manager-only change', () => {
    const d = decideWhatsNew(
      ctx('front_desk', { canManage: false, seesMoney: false }),
      welcomed({ whatsNewThrough: '2026-07-20' }),
      REGISTRY,
    );
    assert.equal(d.show, false, 'the desk was offered a walk through Settings');
    assert.equal(d.show === false && d.refusal, 'nothing_for_this_person');
  });

  test('a hotel with Inventory off is never offered the Inventory change', () => {
    const d = decideWhatsNew(
      ctx('general_manager', { enabledSections: { inventory: false } }),
      welcomed({ whatsNewThrough: '2026-06-30' }),
      [JULY],
    );
    assert.equal(d.show, false);
  });

  test('an entry survives when at least one of its stops does', () => {
    // Partial survival is the right behaviour: a change that touched two
    // screens and one of them is off is still a change worth showing, minus
    // the stop nobody could see.
    const mixed: WhatsNewEntry = {
      id: 'mixed', shippedOn: '2026-08-05', headline: 'Two screens changed.',
      stops: [MANAGER_STOP, EVERYONE_STOP],
    };
    const d = decideWhatsNew(
      ctx('front_desk', { canManage: false, seesMoney: false }),
      welcomed(),
      [mixed],
    );
    assert.equal(d.show, true);
    assert.deepEqual(d.show && d.stops.map((s) => s.key), ['wn-list']);
  });

  test('the stops handed back are the filtered ones, never the raw entry', () => {
    // The mini tour runs on what comes back from here. Handing back the entry's
    // own stops would walk a front desk hire into a manager screen the moment
    // they said yes, past every gate that had just refused it.
    const mixed: WhatsNewEntry = {
      id: 'mixed2', shippedOn: '2026-08-05', headline: 'Two screens changed.',
      stops: [MANAGER_STOP, EVERYONE_STOP],
    };
    const d = decideWhatsNew(ctx('front_desk', { canManage: false }), welcomed(), [mixed]);
    if (!d.show) throw new Error('expected an offer');
    assert.notEqual(d.stops.length, mixed.stops.length);
    assert.ok(!d.stops.some((s) => s.managerOnly));
  });

  test('a null role is offered nothing', () => {
    const d = decideWhatsNew(ctx(null), welcomed(), REGISTRY);
    assert.equal(d.show, false);
  });
});

describe('the words', () => {
  test('the question is one plain question with no dash and no shouting', () => {
    const q = whatsNewQuestion();
    assert.ok(q.endsWith('?'), q);
    assert.ok(!q.includes('—'));
    assert.ok(!q.includes('!'));
    assert.ok(!/\bAI\b/.test(q));
    assert.ok(!/\bnew!\b/i.test(q));
  });

  test('its replies are a show and a close, and neither writes anything', () => {
    // A `show`, not a `walk`: the mini tour draws on the screen the person is
    // standing on and takes itself wherever it needs to go, so navigating them
    // first would be the companion moving somebody in order to move them.
    const replies = repliesFor({ kind: 'whats_new' });
    assert.deepEqual(replies.map((r) => r.intent.kind), ['show', 'close']);
    assert.deepEqual(replies.map((r) => r.label), ['Show me', 'Not now']);
  });

  test('the question is drawn from the kind, so the card is answerable', () => {
    // The charter's rule: a card either asks a real question with real answers
    // under it, or asks nothing at all. This one asks.
    const question = offerQuestionFor('whats_new');
    assert.equal(question, whatsNewQuestion());
    assert.match(question ?? '', /\?$/);
    assert.ok(repliesFor({ kind: 'whats_new' }).length > 0);
  });

  test('there is deliberately no permanent opt-out button', () => {
    // The topic is dropped the moment the offer is SHOWN, so the entry is
    // already once-ever. A "never tell me about changes" button would be one
    // card making a promise about every future change.
    assert.ok(!repliesFor({ kind: 'whats_new' }).some((r) => r.intent.kind === 'quiet'));
  });

  test('the headline is folded but never rewritten', () => {
    // The sentence is the entry's own. A producer that paraphrased it would be
    // a second description of the same change, free to drift from the first.
    assert.equal(whatsNewSentence('  The stockroom   rail moved. '), 'The stockroom rail moved.');
  });

  test('every shipped entry obeys the copy rules', () => {
    for (const entry of WHATS_NEW) {
      assert.ok(!entry.headline.includes('—'), `${entry.id} has an em dash`);
      assert.ok(!/\bAI\b/.test(entry.headline), `${entry.id} says AI out loud`);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(entry.shippedOn), `${entry.id} has a bad date`);
      assert.ok(entry.stops.length >= 1 && entry.stops.length <= 3, `${entry.id} is not a mini tour`);
    }
  });

  test('no two shipped entries share an id', () => {
    const ids = WHATS_NEW.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
