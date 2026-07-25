/**
 * Precision corpus for the fake-success guard.
 *
 * The hermetic eval bank proves the guard is WIRED (a real agent turn, real
 * dispatch, real correction reaching the user). It can only afford a handful of
 * phrasings. This file is the cheap half: the detector as a pure function over
 * many sentences, weighted toward the sentences that must NOT fire.
 *
 * That weighting is the point. The failure mode that would get this guard
 * ripped out is not missing a fake success — it is contradicting the assistant
 * in the middle of an ordinary answer. Every MUST-NOT-FIRE line below is a
 * sentence a real manager or housekeeper could plausibly see.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { detectUnbackedCompletionClaim } from '@/lib/agent/fake-success-guard';

/** [sentence, anyToolRan] — anyToolRan mirrors "did a read tool run this turn". */
type Sample = [string, boolean];

const MUST_FIRE: Sample[] = [
  // First-person agency — unambiguous claims of own action.
  ["I've marked room 302 clean.", false],
  ['I marked room 302 as clean.', false],
  ['I just assigned room 415 to Carlos.', false],
  ['We have already updated the schedule for tomorrow.', false],
  ["I've sent the message to Maria.", false],
  ["I've added it to the inventory.", false],
  // …still a claim even when a READ tool ran first. Reading is not doing.
  ["I checked the board and I've marked room 302 clean.", true],

  // Completion markers with nothing behind them.
  ['Done.', false],
  ['Done!', false],
  ['✅ Done', false],
  ['Done — room 302 is marked clean.', false],
  ['All set — the order has been placed.', false],

  // Spanish.
  ['Listo.', false],
  ['Listo, ya marqué la habitación 302 como limpia.', false],
  ['Ya envié el mensaje al personal.', false],
  ['He asignado la habitación 415 a Carlos.', false],
  // Accents dropped, as models routinely do.
  ['Ya marque la habitacion 302 como limpia.', false],
];

const MUST_NOT_FIRE: Sample[] = [
  // The canonical false positive: explaining HOW to do the thing.
  ['How do I mark a room clean? To mark a room clean, tap it on the board.', false],
  ['You can mark room 302 clean from the Housekeeping board.', false],
  ['To mark a room clean, open Housekeeping and choose Clean.', false],

  // Offers, questions, futures, conditionals, negations.
  ['I can mark room 302 clean for you — want me to?', false],
  ['Would you like me to mark room 302 clean?', false],
  ["I'll mark room 302 clean once you confirm.", false],
  ["I haven't marked room 302 clean yet.", false],
  ['I have not marked room 302 clean.', false],
  ["I would have marked room 302 clean, but it is still occupied.", false],
  ['Should I mark room 302 clean?', false],

  // True status read-outs. A read tool ran; the sentence describes the world,
  // it does not claim the assistant changed it.
  ['Room 302 has been marked clean by Maria at 9:04am.', true],
  ['Room 302 is marked clean and ready for arrival.', true],
  ['Three rooms were assigned to Carlos this morning.', true],

  // Ordinary answers that merely start with, or contain, a completion word.
  ["Done — here's a breakdown of this month's spend by department.", false],
  ['Done. Here are the rooms that are still dirty right now.', false],
  ['Here are today’s 12 arrivals and 8 departures.', true],
  ["I've reviewed the numbers for room 302 and nothing looks off.", true],
  ['Thanks! Let me know if you need anything else.', false],

  // Spanish equivalents.
  ['¿Quieres que marque la habitación 302 como limpia?', false],
  ['Para marcar una habitación como limpia, abre el tablero.', false],
  ['No pude marcar la habitación 302 porque sigue ocupada.', false],
  ['La habitación 302 fue marcada como limpia por María a las 9:04.', true],
];

describe('fake-success guard — detector precision', () => {
  for (const [text, anyToolRan] of MUST_FIRE) {
    test(`fires: ${text}`, () => {
      const claim = detectUnbackedCompletionClaim(text, { anyToolRan });
      assert.ok(
        claim,
        `an unbacked claim of completed work went undetected: "${text}"`,
      );
    });
  }

  for (const [text, anyToolRan] of MUST_NOT_FIRE) {
    test(`silent: ${text}`, () => {
      const claim = detectUnbackedCompletionClaim(text, { anyToolRan });
      assert.equal(
        claim,
        null,
        `guard fired on ordinary conversation (rule=${claim?.rule}): "${text}"`,
      );
    });
  }

  test('the correction is offered in the language the claim was made in', () => {
    const en = detectUnbackedCompletionClaim("I've marked room 302 clean.", { anyToolRan: false });
    const es = detectUnbackedCompletionClaim('Ya marqué la habitación 302 como limpia.', { anyToolRan: false });
    assert.equal(en?.lang, 'en');
    assert.equal(es?.lang, 'es');
  });

  test('a read-out that would be flagged with no tools is spared once a read tool ran', () => {
    // The same sentence, both ways. This is the whole `anyToolRan` tier: with
    // nothing run, "Done — room 302 is marked clean" is a fabrication; with a
    // read tool run, the model may be quoting what it just read.
    const text = 'Done — room 302 is marked clean.';
    assert.ok(detectUnbackedCompletionClaim(text, { anyToolRan: false }));
    assert.equal(detectUnbackedCompletionClaim(text, { anyToolRan: true }), null);
  });

  test('empty and whitespace text never fires', () => {
    assert.equal(detectUnbackedCompletionClaim('', { anyToolRan: false }), null);
    assert.equal(detectUnbackedCompletionClaim('   \n  ', { anyToolRan: false }), null);
  });
});
