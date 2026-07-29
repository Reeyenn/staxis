/**
 * The rules behind "You've written PTAC in 9 work orders — track it as
 * equipment?" — asserted directly, with no database and no model.
 *
 * WHAT THESE DAYS ARE ACTUALLY PROTECTING
 * The failure mode for this feature is not a crash. It is a hotel being asked,
 * one morning, whether it would like to track "leaking" as a piece of equipment
 * — and then never trusting a Staxis question again. So the negatives here
 * outnumber the positives: a verb, a place, a Spanish verb, a word under the
 * bar, and a term the hotel already tracks all have to produce nothing.
 *
 * The other thing under test is DETERMINISM. The never-ask-twice promise is
 * keyed on `topic`, which is derived from the term — so a term that drifted
 * between two runs (different casing, different tie-break) would be asked again
 * under a new topic while the ledger sat there believing it had been declined.
 * That failure looks exactly like the feature working until somebody complains.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MIN_WORK_ORDERS_MENTIONING,
  countEquipmentTerms,
  equipmentSuggestionCandidates,
  equipmentSuggestionTopic,
  hasMatchingEquipment,
  phraseEquipmentSuggestion,
  tokenize,
  type SuggestionSourceText,
} from '@/lib/equipment/suggest';

/** N work orders whose text is `text`, with distinct ids. */
function tickets(count: number, text: string, prefix = 'wo'): SuggestionSourceText[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, text }));
}

function countOf(sources: SuggestionSourceText[], term: string): number {
  return countEquipmentTerms(sources).find((t) => t.term === term)?.workOrders ?? 0;
}

describe('what counts as a word worth asking about', () => {
  test('a token needs at least three characters and at least one letter', () => {
    // "in" is too short, "214" and "2019" carry no letter, "A"/"C" fall out of
    // the slash. Stopwords are filtered later — tokenize only shapes them.
    assert.deepEqual(tokenize('PTAC in 214 unit A/C 48-2019 boiler'), [
      'PTAC', 'unit', 'boiler',
    ]);
  });

  test('a model number typed on its own is never offered as the name of a machine', () => {
    // Digits alone name nothing. A hotel asked to track "2019" as equipment
    // would conclude, correctly, that nobody was reading what it wrote.
    assert.ok(!tokenize('replaced 48219 on 2019 unit').includes('48219'));
    assert.ok(!tokenize('replaced 48219 on 2019 unit').includes('2019'));
  });

  test('accents survive, so a Spanish hotel is not silently excluded', () => {
    assert.ok(tokenize('falla en climatización otra vez').includes('climatización'));
  });

  test('one verbose ticket is one vote, however many times it says the word', () => {
    // "PTAC in 214 — PTAC fan, PTAC filter" is ONE person describing ONE fault.
    // Counting its three mentions would let a single wordy ticket clear a bar
    // meant to represent five separate occasions.
    const one = [{ id: 'wo-1', text: 'PTAC in 214 — PTAC fan seized, PTAC filter black' }];
    assert.equal(countOf(one, 'ptac'), 1);
  });

  test('the display name is the casing the hotel actually writes', () => {
    const counted = countEquipmentTerms([
      { id: '1', text: 'PTAC in room 214' },
      { id: '2', text: 'PTAC in room 215' },
      { id: '3', text: 'ptac in room 216' },
    ]);
    assert.equal(counted[0].term, 'ptac');
    assert.equal(counted[0].display, 'PTAC');
  });

  test('the same input gives the same answer twice — the never-twice rule depends on it', () => {
    const sources = [
      { id: 'a', text: 'Ptac in room 201' },
      { id: 'b', text: 'PTAC in room 202' },
      { id: 'c', text: 'ptac in room 203' },
      { id: 'd', text: 'boiler in room 204' },
      { id: 'e', text: 'boiler in room 204' },
    ];
    const first = countEquipmentTerms(sources);
    const second = countEquipmentTerms([...sources].reverse());
    // Order of the rows out of a query must not change the term, its display
    // casing or the order they are offered in: all three feed `topic`, and a
    // topic that moved would be asked again under a new name.
    assert.deepEqual(
      first.map((t) => `${t.term}/${t.display}/${t.workOrders}`),
      second.map((t) => `${t.term}/${t.display}/${t.workOrders}`),
    );
  });
});

describe('the stoplist — the words that must never become equipment', () => {
  const NEVER = [
    // the job
    'broken', 'leaking', 'replace', 'check', 'urgent', 'please', 'noise', 'water',
    // the place (already repeat_room_work_orders' territory)
    'room', 'lobby', 'floor', 'hallway',
    // Spanish, because a bilingual board writes in both
    'roto', 'fuga', 'reparar', 'habitacion', 'urgente',
    // structure
    'the', 'and', 'with', 'que', 'para',
  ];

  for (const word of NEVER) {
    test(`"${word}" is never suggested, however often it is written`, () => {
      const sources = tickets(40, `${word} ${word} something ${word}`);
      const offered = equipmentSuggestionCandidates({ sources, equipmentNames: [] });
      assert.ok(
        !offered.some((c) => c.topic === equipmentSuggestionTopic(word)),
        `"${word}" reached a manager's screen as a piece of equipment`,
      );
    });
  }
});

describe('the bar', () => {
  test('the bar is FIVE, pinned as a number rather than read from the constant', () => {
    // Written this way on purpose. Every other assertion in this file that
    // touches the threshold used to say `MIN_WORK_ORDERS_MENTIONING - 1`, which
    // means the test MOVED whenever the constant did — a mutation from 5 to 4
    // passed the whole suite. The bar is a product decision about how often
    // Staxis is allowed to interrupt a manager, so changing it should cost a
    // deliberate edit here and a sentence about why.
    assert.equal(MIN_WORK_ORDERS_MENTIONING, 5);
  });

  test('five separate work orders is the bar, and four is under it', () => {
    const under = equipmentSuggestionCandidates({
      sources: tickets(4, 'PTAC failure'),
      equipmentNames: [],
    });
    assert.deepEqual(under, []);

    const at = equipmentSuggestionCandidates({
      sources: tickets(5, 'PTAC failure'),
      equipmentNames: [],
    });
    assert.equal(at.length, 1);
    assert.equal(at[0].topic, 'equipment:ptac');
    assert.equal(at[0].category, 'equipment');
    assert.equal(at[0].suggestedEquipmentName, 'PTAC');
  });

  test('a hotel with no work orders at all is asked nothing', () => {
    assert.deepEqual(equipmentSuggestionCandidates({ sources: [], equipmentNames: [] }), []);
  });

  test('the most-written word is offered first', () => {
    const sources = [
      ...tickets(9, 'PTAC failure', 'p'),
      ...tickets(6, 'boiler failure', 'b'),
    ];
    const offered = equipmentSuggestionCandidates({ sources, equipmentNames: [] });
    assert.deepEqual(offered.map((c) => c.suggestedEquipmentName), ['PTAC', 'boiler']);
  });
});

describe('never ask about something they already track', () => {
  test('an entry whose name contains the term suppresses the question', () => {
    const sources = tickets(9, 'PTAC failure');
    // The registry entry is longer than the word staff type — which is the
    // normal case, and the reason matching is containment rather than equality.
    const offered = equipmentSuggestionCandidates({
      sources,
      equipmentNames: ['PTAC units — rooms 201-240'],
    });
    assert.deepEqual(offered, []);
  });

  test('matching is case-insensitive and works in both directions', () => {
    assert.ok(hasMatchingEquipment('ptac', ['PTAC units — rooms 201-240']));
    assert.ok(hasMatchingEquipment('elevator', ['elevator']));
    // The term is longer than the entry: "elevator" is tracked, so a ticket
    // word of "elevators" must not produce a second entry beside it.
    assert.ok(hasMatchingEquipment('elevators', ['Elevator']));
    assert.ok(!hasMatchingEquipment('boiler', ['PTAC units', 'Ice machine']));
  });

  test('an unrelated registry does not suppress a real suggestion', () => {
    const offered = equipmentSuggestionCandidates({
      sources: tickets(9, 'PTAC failure'),
      equipmentNames: ['Ice machine', 'Pool pump'],
    });
    assert.equal(offered.length, 1);
  });
});

describe('the question a manager reads', () => {
  const candidate = phraseEquipmentSuggestion({ term: 'ptac', display: 'PTAC', workOrders: 9 });

  test('the English says what was counted and what one tap does', () => {
    assert.equal(
      candidate.en,
      'You\'ve written "PTAC" in 9 work orders. Want to track it as equipment?',
    );
  });

  test('the Spanish is Spanish, and the hotel\'s own word is left alone', () => {
    assert.equal(
      candidate.es,
      'Han escrito "PTAC" en 9 órdenes de trabajo. ¿Quieren registrarlo como equipo?',
    );
    // Translating the TERM would create an entry nobody at the hotel recognises:
    // every ticket says PTAC, so the asset has to say PTAC.
    assert.ok(candidate.es.includes('"PTAC"'));
  });

  test('both languages are always present — never English wearing a Spanish label', () => {
    for (const counted of [
      { term: 'ptac', display: 'PTAC', workOrders: 5 },
      { term: 'climatización', display: 'climatización', workOrders: 12 },
    ]) {
      const phrased = phraseEquipmentSuggestion(counted);
      assert.ok(phrased.en.length > 0 && phrased.es.length > 0);
      assert.notEqual(phrased.en, phrased.es);
    }
  });

  test('the question fits the columns that store it', () => {
    const long = phraseEquipmentSuggestion({
      term: 'a'.repeat(24),
      display: 'A'.repeat(24),
      workOrders: 99,
    });
    assert.ok(long.topic.length <= 80);
    assert.ok(long.en.length <= 300);
    assert.ok(long.es.length <= 300);
    assert.ok(long.fact.length <= 500);
    assert.ok((long.suggestedEquipmentName ?? '').length <= 120);
  });

  test('a suggestion carries no finding — it came from the hotel\'s own typing', () => {
    assert.equal(candidate.findingId, null);
  });
});
