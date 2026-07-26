/**
 * The hands, with no database in the way: what gets FROZEN, what the catalog
 * refuses, when a card is allowed to grow a button, and what a manager reads
 * when Staxis declines.
 *
 * Everything here is a pure function over plain data, which is the point — the
 * decisions that make a one-tap fix safe (does this plan contain the
 * measurement? can this action ever lower a threshold? does a downgraded card
 * still carry a button?) are decisions, and a decision asserted through a
 * rendered component is a decision nobody can see fail.
 *
 * The transactional half — re-verification, the write, the undo, the double-tap
 * guarantee — is proved against a real Postgres in
 * findings-actions.integration.test.ts. Neither file duplicates the other.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createWorkOrderAction,
  createWorkOrderParams,
} from '@/lib/findings/actions/catalog/create-work-order';
import {
  MIN_REORDER_INCREASE,
  raiseReorderPointAction,
  raiseReorderPointParams,
} from '@/lib/findings/actions/catalog/raise-reorder-point';
import {
  DB_ACTION_KINDS,
  allActions,
  getAction,
  validateActionDefinition,
} from '@/lib/findings/actions/registry';
import type { ActionReceipt, AnyActionDefinition } from '@/lib/findings/actions/types';
import { validateDeclaration } from '@/lib/findings/registry';
import { parseJudgeReplyStrict } from '@/lib/findings/judge';
import {
  MIN_WORK_ORDERS,
  WINDOW_DAYS,
  detectRepeatRoomWorkOrders,
  repeatRoomWorkOrdersDetector,
  roomTargetFor,
  workOrderActionFor,
} from '@/lib/findings/detectors/repeat-room-work-orders';
import { reorderPointActionFor } from '@/lib/findings/detectors/inventory-usage-baseline';
import type {
  AnyDetector,
  DetectorContext,
  FindingDraft,
  RoomWorkOrderHistory,
} from '@/lib/findings/types';
import {
  declinedExplanation,
  offersApproval,
  offersUndo,
  type CardAction,
  type QueueFinding,
} from '@/components/concourse/finding-cards';

// ─── helpers ────────────────────────────────────────────────────────────────

function historyContext(history: Partial<RoomWorkOrderHistory>): DetectorContext {
  const value: RoomWorkOrderHistory = {
    locations: [],
    repairCostCentsSamples: [],
    coverageStartDate: '2026-06-25',
    // The window the LOADER counts locations over. It used to say 98 here while
    // the card printed 30 and the execute transaction re-checked 30; the fixture
    // is now the one number all three agree on.
    windowDays: WINDOW_DAYS,
    ...history,
  };
  return {
    propertyId: 'aaaaaaaa-0000-4000-8000-000000000001',
    now: new Date('2026-07-25T12:00:00Z'),
    timezone: 'America/Chicago',
    businessDate: '2026-07-25',
    feeds: {
      room_work_order_history: {
        value,
        recordCount: value.locations.reduce((n, l) => n + l.total, 0),
        asOf: new Date('2026-07-25T12:00:00Z'),
        weakestInputAgeDays: 0,
      },
    },
  };
}

function cardAction(over: Partial<CardAction> = {}): CardAction {
  return {
    id: 'cccccccc-0000-4000-8000-000000000001',
    kind: 'create_work_order',
    state: 'proposed',
    offerEn: 'Create a work order?',
    offerEs: '¿Crear una orden de trabajo?',
    labelEn: 'Create the work order',
    labelEs: 'Crear la orden de trabajo',
    receiptEn: null,
    receiptEs: null,
    changed: null,
    failureReason: null,
    ...over,
  };
}

function card(over: Partial<QueueFinding> = {}): QueueFinding {
  return {
    id: 'dddddddd-0000-4000-8000-000000000001',
    detectorId: 'repeat_room_work_orders',
    dedupeKey: 'repeat_room_work_orders:location:Room 214',
    summary: 'Room 214 has had 4 work orders in the last 30 days — 2 still open.',
    severity: 'attention',
    disposition: 'propose',
    status: 'open',
    magnitude: 4,
    price: null,
    evidence: { queryId: 'q', params: {}, values: {}, basis: '' },
    asOf: null,
    weakestInputAgeDays: null,
    firstSeenAt: '2026-07-20T00:00:00Z',
    lastSeenAt: '2026-07-25T00:00:00Z',
    occurrenceCount: 3,
    action: cardAction(),
    ...over,
  };
}

const ITEM = 'a1b2c3d4-0000-4000-8000-000000000001';

// ═══════════════════════════════════════════════════════════════════════════
describe('the catalog refuses an action that could not be offered safely', () => {
  test('an entry with no undo is refused — every action must come back', () => {
    const bad = {
      ...(createWorkOrderAction as unknown as AnyActionDefinition),
      undoDescription: '   ',
    };
    assert.throws(
      () => validateActionDefinition(bad, new Set()),
      /does not say how it comes back/i,
      'an action whose author cannot write down the reversal is one nobody can promise is reversible',
    );
  });

  test('an entry with no outcome window is refused', () => {
    const bad = {
      ...(createWorkOrderAction as unknown as AnyActionDefinition),
      outcomeCheckDays: 0,
    };
    assert.throws(() => validateActionDefinition(bad, new Set()), /outcomeCheckDays/);
  });

  test('a kind the DATABASE does not accept is refused before it can be frozen', () => {
    const bad = {
      ...(createWorkOrderAction as unknown as AnyActionDefinition),
      kind: 'delete_the_hotel' as never,
    };
    assert.throws(
      () => validateActionDefinition(bad, new Set()),
      /migration 0363 accepts/i,
      'the CHECK constraint and the catalog must agree, or the runner freezes a plan no branch can run',
    );
  });

  test('two entries cannot share a kind', () => {
    assert.throws(
      () =>
        validateActionDefinition(
          createWorkOrderAction as unknown as AnyActionDefinition,
          new Set(['create_work_order']),
        ),
      /already registered/i,
    );
  });

  test('the shipped catalog is exactly the kinds the schema allows, and no more', () => {
    assert.deepEqual(
      allActions().map((a) => a.kind).sort(),
      [...DB_ACTION_KINDS].sort(),
      'a catalog entry with no database branch is a button that fails; a database kind with no ' +
        'catalog entry is a row nothing can render',
    );
  });

  test('every shipped action declares a real undo and a real outcome window', () => {
    for (const action of allActions()) {
      assert.ok(action.undoDescription.trim().length > 20, `${action.kind} undo is not a sentence`);
      assert.ok(action.outcomeCheckDays >= 1, `${action.kind} never checks its outcome`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('what gets frozen: the plan carries no measurement', () => {
  test('the work-order plan is identical whether the location has 4 faults or 40', () => {
    // THE POINT: `params` is the identity of the PLAN. If the count leaked into
    // it, tomorrow's fifth work order would produce a different fingerprint, the
    // one-live-offer-per-finding index would supersede last night's offer, and
    // the ledger would churn a fresh proposal every single night — the exact
    // stacking the whole layer exists to prevent.
    const four = createWorkOrderParams('Room 214');
    const forty = createWorkOrderParams('Room 214');
    assert.deepEqual(four, forty);
    assert.ok(
      !/\d+\s+work orders/i.test(String(four.description)),
      'the frozen description must not contain the count',
    );
  });

  test('the plan names the location the card names, verbatim', () => {
    assert.equal(createWorkOrderParams('  Hall 2F  ').location, 'Hall 2F');
    assert.equal(createWorkOrderParams('Hall 2F').description.includes('Hall 2F'), true);
  });

  test('the reorder plan is arithmetic on the hotel own two numbers', () => {
    const plan = raiseReorderPointParams({
      itemId: ITEM,
      itemName: 'Bath towels',
      unit: 'each',
      currentReorderAt: 20,
      leadDays: 3,
      ratePerDay: 12.4,
    });
    assert.ok(plan);
    // ceil(12.4 × 3) = 38. Not a percentage, not a benchmark, not a round-up
    // anybody chose — the rate the hotel's own counts measured times the lead
    // time the hotel itself typed in.
    assert.equal(plan.to_reorder_at, 38);
    assert.equal(plan.from_reorder_at, 20);
  });

  test('no lead time on file means no offer at all', () => {
    assert.equal(
      raiseReorderPointParams({
        itemId: ITEM,
        itemName: 'Bath towels',
        unit: 'each',
        currentReorderAt: 20,
        leadDays: null,
        ratePerDay: 12.4,
      }),
      null,
      'a reorder point set from a guessed lead time is worse than one that is merely old',
    );
  });

  test('an item with no reorder point set gets no offer — a first one is a policy call', () => {
    assert.equal(
      raiseReorderPointParams({
        itemId: ITEM,
        itemName: 'Bath towels',
        unit: 'each',
        currentReorderAt: null,
        leadDays: 3,
        ratePerDay: 12.4,
      }),
      null,
    );
  });

  test('a rounding-error increase is not an offer', () => {
    // covering = ceil(7 × 3) = 21, current 20 → +1, below MIN_REORDER_INCREASE.
    assert.equal(
      raiseReorderPointParams({
        itemId: ITEM,
        itemName: 'Bath towels',
        unit: 'each',
        currentReorderAt: 20,
        leadDays: 3,
        ratePerDay: 7,
      }),
      null,
    );
    assert.ok(MIN_REORDER_INCREASE >= 2);
  });

  test('the reorder action can NEVER lower a threshold, even if handed one', () => {
    // A hand-built plan that goes downward is refused by the catalog's own
    // validation, so it can never be frozen — an action able to relax an alert a
    // manager tightened deliberately is not a safe action.
    const lowering = {
      item_id: ITEM,
      item_name: 'Bath towels',
      unit: 'each',
      from_reorder_at: 40,
      to_reorder_at: 12,
      rate_per_day: 4,
      lead_days: 3,
      outcome_check_days: 21,
    };
    assert.match(
      String(raiseReorderPointAction.validate(lowering)),
      /only ever raises/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the post-condition catches the executor and the catalog drifting apart', () => {
  const params = createWorkOrderParams('Room 214');

  test('a receipt that matches the plan passes', () => {
    const receipt: ActionReceipt = {
      table: 'work_orders',
      id: 'eeeeeeee-0000-4000-8000-000000000001',
      kind: 'created',
      label: params.description,
      where: 'Room 214',
    };
    assert.deepEqual(createWorkOrderAction.postCondition(receipt, params), { ok: true });
  });

  test('a work order that landed on the wrong location is caught', () => {
    const receipt: ActionReceipt = {
      table: 'work_orders',
      id: 'eeeeeeee-0000-4000-8000-000000000001',
      kind: 'created',
      label: params.description,
      where: 'Room 999',
    };
    const result = createWorkOrderAction.postCondition(receipt, params);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.because : '', /Room 999/);
  });

  test('a reorder receipt that recorded a different number is caught', () => {
    const plan = raiseReorderPointParams({
      itemId: ITEM,
      itemName: 'Bath towels',
      unit: 'each',
      currentReorderAt: 20,
      leadDays: 3,
      ratePerDay: 12.4,
    })!;
    const receipt: ActionReceipt = {
      table: 'inventory',
      id: ITEM,
      kind: 'changed',
      label: 'Bath towels',
      column: 'reorder_at',
      from: 20,
      to: 18,
    };
    const result = raiseReorderPointAction.postCondition(receipt, plan);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.because : '', /the plan said 38/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a detector may only attach an action to something it calls a proposal', () => {
  test('an action template on a recommend-by-default detector is refused at registration', () => {
    const bad = {
      declaration: {
        ...repeatRoomWorkOrdersDetector.declaration,
        id: 'probe_quiet_but_armed',
        defaultDisposition: 'recommend' as const,
      },
      detect: () => [],
    } as unknown as AnyDetector;
    assert.throws(
      () => validateDeclaration(bad, new Set()),
      /needs no decision/i,
      'a button on an FYI card is a card that says it needs no decision while asking for one',
    );
  });

  test('the shipped detector that has hands declares itself a proposal', () => {
    assert.equal(repeatRoomWorkOrdersDetector.declaration.defaultDisposition, 'propose');
    assert.ok(repeatRoomWorkOrdersDetector.declaration.actionTemplate);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the repeat-location detector, and the fix it attaches', () => {
  test('three work orders at one place is a finding keyed on the place', () => {
    const drafts = detectRepeatRoomWorkOrders(
      historyContext({
        locations: [{ location: 'Room 214', total: 4, stillOpen: 2, lastDate: '2026-07-24' }],
      }),
    );
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].key, 'location:Room 214');
    assert.equal(drafts[0].magnitude, 4);
    assert.equal(drafts[0].disposition, 'propose');
  });

  test('two is a bad fortnight, not a pattern', () => {
    const drafts = detectRepeatRoomWorkOrders(
      historyContext({
        locations: [{ location: 'Room 214', total: 2, stillOpen: 2, lastDate: '2026-07-24' }],
      }),
    );
    assert.deepEqual(drafts, []);
    assert.equal(MIN_WORK_ORDERS, 3);
  });

  test('a location where everything was closed is a recommendation, not an offer', () => {
    const drafts = detectRepeatRoomWorkOrders(
      historyContext({
        locations: [{ location: 'Lobby', total: 3, stillOpen: 0, lastDate: '2026-07-20' }],
      }),
    );
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].disposition, 'recommend');
    assert.equal(
      workOrderActionFor(drafts[0]),
      null,
      'an offer on a location with nothing open could never honestly decline, because a count ' +
        'cannot fall below zero — so it must never be offered',
    );
  });

  test('the attached plan freezes the location and the count that must still hold', () => {
    const drafts = detectRepeatRoomWorkOrders(
      historyContext({
        locations: [{ location: 'Room 214', total: 4, stillOpen: 2, lastDate: '2026-07-24' }],
      }),
    );
    const plan = workOrderActionFor(drafts[0]);
    assert.ok(plan);
    assert.equal(plan.kind, 'create_work_order');
    assert.equal(plan.params.location, 'Room 214');
    assert.deepEqual(plan.verify, {
      location: 'Room 214',
      window_days: 30,
      open_work_orders: 2,
    });
    assert.equal(createWorkOrderAction.validate(plan.params), null);
  });

  test('a price is a range built from this hotel own repair costs, or there is none', () => {
    const priced = detectRepeatRoomWorkOrders(
      historyContext({
        locations: [{ location: 'Room 214', total: 4, stillOpen: 2, lastDate: '2026-07-24' }],
        repairCostCentsSamples: [12_000, 15_000, 22_000],
      }),
    );
    assert.ok(priced[0].price, 'three recorded repair costs is enough for an honest spread');
    assert.ok(priced[0].price!.highCents > priced[0].price!.lowCents);

    const unpriced = detectRepeatRoomWorkOrders(
      historyContext({
        locations: [{ location: 'Room 214', total: 4, stillOpen: 2, lastDate: '2026-07-24' }],
        repairCostCentsSamples: [12_000],
      }),
    );
    assert.equal(unpriced[0].price, null);
    assert.match(
      String(unpriced[0].evidence.values.price_basis),
      /not enough/i,
      'no dollar figure has to explain itself, or it reads as an oversight',
    );
  });

  test('only a location that says it is a room gets a room target', () => {
    assert.deepEqual(roomTargetFor('Room 214'), { kind: 'room', value: '214' });
    assert.deepEqual(roomTargetFor('room 0214'), { kind: 'room', value: '214' });
    assert.equal(roomTargetFor('Lobby'), null);
    assert.equal(
      roomTargetFor('Hall 2F'),
      null,
      'a chip on "Hall 2F" would land on whichever room happened to share the digits',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the reorder template reads only the card', () => {
  function usageDraft(over: {
    reorderAt?: number | null;
    leadDays?: number | null;
    rate?: number;
  }): FindingDraft {
    return {
      key: `item_usage:${ITEM}`,
      summary: 'Bath towels are going out at about 12.4 each a day.',
      severity: 'attention',
      magnitude: 30,
      evidence: {
        queryId: 'inventory_item_usage_baseline',
        params: {
          item_id: ITEM,
          interval_end: '2026-07-24',
          interval_days: 3,
          reorder_at: over.reorderAt === undefined ? 20 : over.reorderAt,
          reorder_lead_days: over.leadDays === undefined ? 3 : over.leadDays,
        },
        values: {
          item_name: 'Bath towels',
          unit: 'each',
          current_rate_per_day: over.rate ?? 12.4,
        },
        basis: 'counted',
      },
      price: null,
    };
  }

  test('it freezes the raise, and the value that must still be there at the tap', () => {
    const plan = reorderPointActionFor(usageDraft({}));
    assert.ok(plan);
    assert.equal(plan.kind, 'raise_inventory_reorder_point');
    assert.equal(plan.params.to_reorder_at, 38);
    assert.deepEqual(plan.verify, {
      item_id: ITEM,
      item_name: 'Bath towels',
      reorder_at: 20,
    });
  });

  test('a hotel that never set a lead time gets a card with no button', () => {
    assert.equal(reorderPointActionFor(usageDraft({ leadDays: null })), null);
  });

  test('a hotel that never set a reorder point gets a card with no button', () => {
    assert.equal(reorderPointActionFor(usageDraft({ reorderAt: null })), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('when a card is allowed to carry a button', () => {
  test('a proposal with a proposed action shows the approve', () => {
    assert.equal(offersApproval(card()), true);
  });

  test('a card the judge sorted down to an FYI loses the button', () => {
    // The judge may quieten a proposal. Doing so has to take the button with
    // it, or a card that says it needs no decision would be asking for one.
    assert.equal(offersApproval(card({ disposition: 'fyi' })), false);
    assert.equal(offersApproval(card({ disposition: 'recommend' })), false);
  });

  test('a superseded offer never renders a button', () => {
    assert.equal(
      offersApproval(card({ action: cardAction({ state: 'superseded' }) })),
      false,
      'a superseded plan is not the plan on the card, and running it would be running something ' +
        'the manager was never shown',
    );
  });

  test('a card with no action shows no button', () => {
    assert.equal(offersApproval(card({ action: null })), false);
  });

  test('undo survives a downgrade — something really happened at the hotel', () => {
    const executed = card({
      disposition: 'fyi',
      action: cardAction({ state: 'executed', receiptEn: 'Work order created for Room 214.' }),
    });
    assert.equal(offersApproval(executed), false);
    assert.equal(
      offersUndo(executed),
      true,
      'the ability to reverse a real change cannot depend on how a later pass sorted the card',
    );
  });

  test('an undone action offers nothing further', () => {
    const undone = card({ action: cardAction({ state: 'undone' }) });
    assert.equal(offersApproval(undone), false);
    assert.equal(offersUndo(undone), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('when Staxis declines, the card says what moved — in both languages', () => {
  const declined = (field: string, was: unknown, now: unknown, subject: string) =>
    cardAction({
      state: 'declined_changed',
      changed: { field, was, now, subject },
    });

  test('work orders closed since the offer', () => {
    const en = declinedExplanation(declined('open_work_orders', 4, 1, 'Room 214'), 'en');
    assert.match(en, /Room 214/);
    assert.match(en, /\b4\b/);
    assert.match(en, /\b1\b/);
    assert.match(en, /already on it/i);

    const es = declinedExplanation(declined('open_work_orders', 4, 1, 'Room 214'), 'es');
    assert.match(es, /Room 214/);
    assert.notEqual(es, en, 'a Spanish speaker must not be handed the English sentence');
  });

  test('a reorder point somebody already changed', () => {
    const en = declinedExplanation(declined('reorder_at', 20, 45, 'Bath towels'), 'en');
    assert.match(en, /Bath towels/);
    assert.match(en, /already changed/i);
  });

  test('an item that left the list', () => {
    const en = declinedExplanation(declined('item', 'Bath towels', null, 'Bath towels'), 'en');
    assert.match(en, /no longer on this hotel/i);
  });

  test('an unrecognised field still names both numbers rather than going blank', () => {
    const en = declinedExplanation(declined('something_new', 9, 2, 'Room 3'), 'en');
    assert.match(en, /\b9\b/);
    assert.match(en, /\b2\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the judge cannot reach an action', () => {
  const ids = new Set(['dddddddd-0000-4000-8000-000000000001']);
  const item = (extra: string) =>
    `{"items":[{"id":"dddddddd-0000-4000-8000-000000000001","d":"propose","en":"x","es":"y","why":"z"${extra}}]}`;

  test('a reply naming an action refuses the WHOLE reply', () => {
    assert.throws(
      () => parseJudgeReplyStrict(item(',"action":"create_work_order"'), ids),
      /not part of the output contract/i,
      'the only way for a model to author an action is to emit a field for one, and there is none',
    );
  });

  test('a reply carrying action parameters refuses the whole reply too', () => {
    assert.throws(
      () => parseJudgeReplyStrict(item(',"params":{"location":"Room 999"}'), ids),
      /not part of the output contract/i,
    );
  });

  test('the contract still accepts the four things the judge IS allowed to author', () => {
    const parsed = parseJudgeReplyStrict(item(''), ids);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].disposition, 'propose');
  });

  test('the judge module has no handle on the actions table at all', async () => {
    // Structural, not stylistic: `finding_actions` is written by exactly two
    // SQL functions and by the runner's propose path. If the judge ever grew a
    // reference to it, the ITEM_KEYS closure above would stop being the only
    // thing standing between a model and a real work order.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/findings/judge.ts', 'utf8'),
    );
    const writes = source
      .split('\n')
      .filter((line) => /\.from\(['"]finding_actions|staxis_(execute|undo)_finding_action\(/.test(line))
      .filter((line) => !line.trim().startsWith('//'));
    assert.deepEqual(writes, [], 'the judge reached the actions table');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the catalog is reachable by the kinds the runner will actually freeze', () => {
  test('both shipped detectors name a kind the catalog has', () => {
    for (const kind of DB_ACTION_KINDS) {
      assert.ok(getAction(kind), `no catalog entry for ${kind}`);
    }
  });
});
