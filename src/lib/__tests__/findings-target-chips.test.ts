/**
 * The rules behind "Staxis sees a pattern here →", asserted directly.
 *
 * Three things are being protected here, and each one is a specific way the
 * feature could go wrong in a manager's hands:
 *
 *   1. A chip on the WRONG thing. Room 215 borrowing room 214's pattern, or an
 *      "Ice machine 3" work order claiming to be room 3. One wrong signpost
 *      costs more trust than a hundred missing ones.
 *   2. A chip pointing at a card that is not in the queue — a silenced finding,
 *      a question, a dropped one. A signpost to nothing is a dead end.
 *   3. A chip that has quietly become a second card: a summary, a price, a
 *      button. The founder's rule is one card, in one place.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  findingsForTarget,
  normalizeTargetValue,
  resolveFindingTarget,
  isFindingTargetKind,
  type TargetableFinding,
} from '@/lib/findings/targeting';
import {
  chipFor,
  patternChipUrl,
  queueFocusHref,
  roomNumberFromLocation,
} from '@/components/concourse/target-chip';
import { draftsFromNudges } from '@/lib/findings/detectors/room-attention';
import { detectInventoryUsageBaseline, usageFixture } from '@/lib/findings/detectors/inventory-usage-baseline';
import type { DetectorContext, NudgeDraftFeed } from '@/lib/findings/types';

// ─── Helpers ────────────────────────────────────────────────────────────────

let seq = 0;
function finding(over: Partial<TargetableFinding> = {}): TargetableFinding {
  seq += 1;
  return {
    id: `f-${seq}`,
    dedupeKey: `det:key-${seq}`,
    severity: 'attention',
    status: 'open',
    disposition: 'recommend',
    judgedDisposition: null,
    evidence: { params: {}, target: null },
    ...over,
  };
}

function roomFinding(room: string, over: Partial<TargetableFinding> = {}): TargetableFinding {
  return finding({ evidence: { params: {}, target: { kind: 'room', value: room } }, ...over });
}

// ─── Reading the target off a finding ───────────────────────────────────────

describe('what a finding is about', () => {
  test('the structured target is read as written', () => {
    assert.deepEqual(
      resolveFindingTarget({ target: { kind: 'room', value: '214' } }),
      { kind: 'room', value: '214' },
    );
    assert.deepEqual(
      resolveFindingTarget({ target: { kind: 'inventory_item', value: 'AB-99' } }),
      { kind: 'inventory_item', value: 'ab-99' },
    );
  });

  test('a hotel-wide finding has no target, and that is an answer rather than a gap', () => {
    assert.equal(resolveFindingTarget({ params: { window_days: 7 } }), null);
    assert.equal(resolveFindingTarget({}), null);
    assert.equal(resolveFindingTarget(null), null);
    assert.equal(resolveFindingTarget(undefined), null);
  });

  test('rows written before the target field are read from NAMED params, not from the key', () => {
    // room_needs_attention's own receipt shape.
    assert.deepEqual(
      resolveFindingTarget({ params: { business_date: '2026-07-25', room_number: '214', alert_type: 'overdue_room' } }),
      { kind: 'room', value: '214' },
    );
    // The `[QA seed]` rows sitting on Test Hotel right now.
    assert.deepEqual(
      resolveFindingTarget({ params: { room: '214', qa_seed: '[QA seed]', category: 'hvac' } }),
      { kind: 'room', value: '214' },
    );
    assert.deepEqual(
      resolveFindingTarget({ params: { item_id: 'a1b2c3d4-0000-4000-8000-000000000001' } }),
      { kind: 'inventory_item', value: 'a1b2c3d4-0000-4000-8000-000000000001' },
    );
  });

  test('a placeholder in a legacy param is not a thing', () => {
    // room_needs_attention writes `room_number: "unknown"` when the nudge named
    // no room. Read as a room, every roomless alert at every hotel would pile
    // onto one shared phantom room.
    for (const placeholder of ['unknown', 'UNKNOWN', 'n/a', '-', 'null']) {
      assert.equal(resolveFindingTarget({ params: { room_number: placeholder } }), null, placeholder);
    }
  });

  test('a param that merely SOUNDS like a target is not one', () => {
    // The allowlist is closed. "location" and "equipment" are real evidence
    // params on other findings and must not be read as rooms.
    assert.equal(resolveFindingTarget({ params: { location: '214' } }), null);
    assert.equal(resolveFindingTarget({ params: { equipment: 'Ice machine — 3rd floor' } }), null);
    assert.equal(resolveFindingTarget({ params: { item: 'Bar soap' } }), null);
  });

  test('"target: null" is a detector SAYING no thing, and is not overruled by params', () => {
    // Presence, not truthiness. A detector that explicitly declined to name a
    // thing has answered; recovering a different answer from its receipt params
    // would be the screen overruling the detector about its own finding.
    assert.equal(
      resolveFindingTarget({ target: null, params: { room_number: '214' } }),
      null,
    );
    assert.equal(
      resolveFindingTarget({ target: null, params: { item_id: 'a1b2c3d4-0000-4000-8000-000000000001' } }),
      null,
    );
  });

  test('a declared-but-broken target yields nothing, never a guess from elsewhere', () => {
    // The detector said what this is about. If it said it wrong, the honest
    // outcome is no chip — not a different room recovered from the params.
    assert.equal(
      resolveFindingTarget({ target: { kind: 'floor', value: '2' }, params: { room_number: '214' } }),
      null,
    );
    assert.equal(
      resolveFindingTarget({ target: { kind: 'room', value: '   ' }, params: { room_number: '214' } }),
      null,
    );
  });

  test('identities compare trimmed and case-folded', () => {
    assert.equal(normalizeTargetValue('  214 '), '214');
    assert.equal(normalizeTargetValue('AB-99'), 'ab-99');
    assert.equal(normalizeTargetValue(214), '214');
    assert.equal(normalizeTargetValue(''), null);
    assert.equal(normalizeTargetValue('   '), null);
    assert.equal(normalizeTargetValue(null), null);
    assert.equal(normalizeTargetValue('x'.repeat(121)), null);
  });

  test('only kinds a screen can actually render are kinds', () => {
    assert.equal(isFindingTargetKind('room'), true);
    assert.equal(isFindingTargetKind('inventory_item'), true);
    assert.equal(isFindingTargetKind('preventive_task'), true);
    // `equipment` used to be the counter-example here — the kind nothing could
    // render. It became a real kind when the asset registry grew a detail sheet
    // (0368), which is exactly the event that should make somebody edit this
    // line deliberately. The counter-examples are now things Staxis still has no
    // screen for on their own.
    assert.equal(isFindingTargetKind('equipment'), true);
    assert.equal(isFindingTargetKind('staff'), false);
    assert.equal(isFindingTargetKind('vendor'), false);
    assert.equal(isFindingTargetKind(''), false);
    assert.equal(isFindingTargetKind(null), false);
  });
});

// ─── Matching a finding to a thing ──────────────────────────────────────────

describe('matching findings to one thing', () => {
  test('214 matches 214 and 215 gets nothing', () => {
    const rows = [roomFinding('214'), roomFinding('216')];
    assert.deepEqual(findingsForTarget(rows, 'room', '214').map((f) => f.id), [rows[0].id]);
    assert.deepEqual(findingsForTarget(rows, 'room', '215'), []);
    assert.deepEqual(findingsForTarget(rows, 'room', '216').map((f) => f.id), [rows[1].id]);
  });

  test('a room number is not an item id — kinds do not cross', () => {
    const rows = [
      roomFinding('214'),
      finding({ evidence: { params: {}, target: { kind: 'inventory_item', value: '214' } } }),
    ];
    assert.deepEqual(findingsForTarget(rows, 'room', '214').map((f) => f.id), [rows[0].id]);
    assert.deepEqual(findingsForTarget(rows, 'inventory_item', '214').map((f) => f.id), [rows[1].id]);
  });

  test('item-level matching works the same way, on the id', () => {
    const a = 'a1b2c3d4-0000-4000-8000-000000000001';
    const b = 'a1b2c3d4-0000-4000-8000-000000000002';
    const rows = [finding({ evidence: { params: { item_id: a } } })];
    assert.equal(findingsForTarget(rows, 'inventory_item', a).length, 1);
    assert.equal(findingsForTarget(rows, 'inventory_item', b).length, 0);
    // Case is not identity for a uuid.
    assert.equal(findingsForTarget(rows, 'inventory_item', a.toUpperCase()).length, 1);
  });

  test('only open and updated findings put a chip on anything', () => {
    for (const status of ['open', 'updated'] as const) {
      assert.equal(findingsForTarget([roomFinding('214', { status })], 'room', '214').length, 1, status);
    }
    // known_problem and muted are silences a MANAGER armed. A chip on the room
    // itself would be the same nag wearing a different hat.
    for (const status of ['known_problem', 'muted', 'resolved', 'expired'] as const) {
      assert.equal(findingsForTarget([roomFinding('214', { status })], 'room', '214').length, 0, status);
    }
  });

  test('questions and dropped findings get no chip — there is no card to open', () => {
    for (const disposition of ['ask', 'drop'] as const) {
      assert.equal(
        findingsForTarget([roomFinding('214', { disposition })], 'room', '214').length,
        0,
        disposition,
      );
    }
    for (const disposition of ['propose', 'recommend', 'fyi'] as const) {
      assert.equal(
        findingsForTarget([roomFinding('214', { disposition })], 'room', '214').length,
        1,
        disposition,
      );
    }
  });

  test("the judge's verdict governs, exactly as it does in the queue", () => {
    // Detector default says card; the judge sorted it into the question pipe.
    // Reading the detector's value here would put a chip on a room whose card
    // is a drip question — a signpost to a card that is not in the queue.
    assert.equal(
      findingsForTarget(
        [roomFinding('214', { disposition: 'recommend', judgedDisposition: 'ask' })],
        'room', '214',
      ).length,
      0,
    );
    // And the other way: the judge promoted a detector default of `ask`.
    assert.equal(
      findingsForTarget(
        [roomFinding('214', { disposition: 'ask', judgedDisposition: 'recommend' })],
        'room', '214',
      ).length,
      1,
    );
  });

  test('two patterns on one thing come back worst first, and stably', () => {
    const info = roomFinding('214', { severity: 'info', dedupeKey: 'a:aaa' });
    const critical = roomFinding('214', { severity: 'critical', dedupeKey: 'z:zzz' });
    const attention = roomFinding('214', { severity: 'attention', dedupeKey: 'm:mmm' });
    const ordered = findingsForTarget([info, critical, attention], 'room', '214');
    assert.deepEqual(ordered.map((f) => f.severity), ['critical', 'attention', 'info']);
    // Same inputs, same order — a list that reshuffles teaches a manager that
    // position means nothing.
    assert.deepEqual(
      findingsForTarget([attention, info, critical], 'room', '214').map((f) => f.id),
      ordered.map((f) => f.id),
    );
  });

  test('an empty or blank lookup value matches nothing rather than everything', () => {
    const rows = [roomFinding('214'), roomFinding('216')];
    assert.deepEqual(findingsForTarget(rows, 'room', ''), []);
    assert.deepEqual(findingsForTarget(rows, 'room', '   '), []);
  });
});

// ─── The detectors now say what they are about ──────────────────────────────

describe('detectors declare their target', () => {
  test('the room detector names the room, so its finding lands on that room', () => {
    const drafts = draftsFromNudges(
      [{
        severity: 'warning',
        payload: {
          summary: 'Room 214 has been in progress for 120 min.',
          type: 'overdue_room',
          roomNumber: '214',
          minutesElapsed: 120,
        },
        dedupeKey: 'overdue_room:pid:2026-07-25:214',
      }] as unknown as NudgeDraftFeed,
      '2026-07-25',
    );
    assert.deepEqual(drafts[0].evidence.target, { kind: 'room', value: '214' });
    assert.deepEqual(resolveFindingTarget(drafts[0].evidence), { kind: 'room', value: '214' });
  });

  test('a nudge that names no room produces no target rather than a room called "unknown"', () => {
    const drafts = draftsFromNudges(
      [{
        severity: 'warning',
        payload: { summary: 'Something happened', type: 'help_request' },
        dedupeKey: 'help:pid',
      }] as unknown as NudgeDraftFeed,
      '2026-07-25',
    );
    assert.equal(drafts[0].evidence.target, null);
    assert.equal(resolveFindingTarget(drafts[0].evidence), null);
  });

  test('the inventory detector names the item id, not the item name', () => {
    const itemId = 'a1b2c3d4-0000-4000-8000-000000000001';
    const ctx = {
      propertyId: 'p',
      now: new Date('2026-07-25T12:00:00Z'),
      timezone: 'America/Chicago',
      businessDate: '2026-07-25',
      feeds: {
        inventory_usage_history: {
          value: usageFixture(itemId, [4, 4.3, 3.8, 4.1, 4.4, 3.9, 4.2, 4, 4.5, 3.7, 4.1, 18], {
            itemName: 'Bar soap',
          }),
          recordCount: 12,
          asOf: null,
          weakestInputAgeDays: null,
        },
      },
    } as unknown as DetectorContext;

    const drafts = detectInventoryUsageBaseline(ctx);
    assert.equal(drafts.length, 1, 'the fixture that used to produce a finding stopped producing one');
    assert.deepEqual(drafts[0].evidence.target, { kind: 'inventory_item', value: itemId });
    // The NAME is deliberately not the identity: two items can share one, and a
    // rename would move the chip to the wrong shelf.
    assert.equal(findingsForTarget(
      [{ ...finding(), evidence: drafts[0].evidence }],
      'inventory_item',
      'Bar soap',
    ).length, 0);
  });
});

// ─── The chip itself ────────────────────────────────────────────────────────

describe('the chip', () => {
  test('nothing to point at renders nothing at all', () => {
    assert.equal(chipFor([], 'en'), null);
    assert.equal(chipFor([], 'es'), null);
    assert.equal(chipFor([''], 'en'), null);
  });

  test('one pattern uses the English product sentence for legacy language input', () => {
    assert.equal(chipFor(['f1'], 'en')!.text, 'Staxis sees a pattern here →');
    assert.equal(chipFor(['f1'], 'es')!.text, 'Staxis sees a pattern here →');
  });

  test('two patterns say two — the count is never rounded down to "a"', () => {
    assert.equal(chipFor(['f1', 'f2'], 'en')!.text, 'Staxis sees 2 patterns here →');
    assert.equal(chipFor(['f1', 'f2'], 'es')!.text, 'Staxis sees 2 patterns here →');
    assert.equal(chipFor(['f1', 'f2', 'f3'], 'en')!.count, 3);
  });

  test('the link carries the right finding id, into the queue', () => {
    assert.equal(chipFor(['abc-123'], 'en')!.href, '/feed?focus=abc-123');
    // The worst one leads, matching the order findingsForTarget hands back.
    assert.equal(chipFor(['first', 'second'], 'en')!.href, '/feed?focus=first');
    assert.equal(queueFocusHref('a b/c'), '/feed?focus=a%20b%2Fc');
  });

  test('with no specific thing, the chip does not even ask', () => {
    // This is the client half of "on the thing, not the tab". A chip mounted
    // anywhere that is not about ONE room or ONE item makes no request at all,
    // so there is nothing for it to render and nothing to render it from.
    assert.equal(patternChipUrl(null, 'room', '214'), null);
    assert.equal(patternChipUrl('', 'room', '214'), null);
    assert.equal(patternChipUrl('pid-1', 'room', null), null);
    assert.equal(patternChipUrl('pid-1', 'room', ''), null);
    assert.equal(patternChipUrl('pid-1', 'room', '   '), null);
    assert.equal(patternChipUrl('pid-1', '', '214'), null);
  });

  test('with a thing, it asks for that thing only', () => {
    assert.equal(
      patternChipUrl('pid-1', 'room', '214'),
      '/api/findings/for-target?propertyId=pid-1&kind=room&value=214',
    );
    // Everything that reaches the query string is encoded — a room number is
    // user-entered text and has no business steering a URL.
    assert.equal(
      patternChipUrl('pid&1', 'inventory_item', 'a b&c'),
      '/api/findings/for-target?propertyId=pid%261&kind=inventory_item&value=a%20b%26c',
    );
  });

  test('the chip carries a link and a sentence — and no card state', () => {
    const chip = chipFor(['f1'], 'en')!;
    // If this ever grows a summary, a price, a severity or a verdict, the chip
    // has become a second card and the one-card rule is gone.
    assert.deepEqual(Object.keys(chip).sort(), ['count', 'href', 'text']);
  });
});

// ─── Reading a room off a work order ────────────────────────────────────────

describe('the room a work order is about', () => {
  test('the forms people actually type', () => {
    for (const [input, expected] of [
      ['214', '214'],
      [' 214 ', '214'],
      ['Room 214', '214'],
      ['room 214', '214'],
      ['Rm 214', '214'],
      ['Rm. 214', '214'],
      ['Room #214', '214'],
      ['Room 214 - bathroom', '214'],
      ['Habitación 214', '214'],
      ['Habitacion 214', '214'],
      ['Hab 214', '214'],
    ] as const) {
      assert.equal(roomNumberFromLocation(input), expected, `"${input}"`);
    }
  });

  test('things that are not rooms get no chip', () => {
    // "Ice machine 3" is not room 3. A chip on the wrong thing costs more trust
    // than a missing chip on the right one.
    for (const input of [
      'Lobby', 'Pool pump', 'Ice machine 3', 'Breakfast area', 'Elevator 2',
      'Floor 2 hallway', '', '   ', 'Roomba', 'Room', 'Boiler room',
    ]) {
      assert.equal(roomNumberFromLocation(input), null, `"${input}"`);
    }
    assert.equal(roomNumberFromLocation(null), null);
    assert.equal(roomNumberFromLocation(undefined), null);
  });
});
