/**
 * The Maintenance tab's patterns popup.
 *
 * Four things are worth a standing test here, and they are the four that would
 * fail silently:
 *
 *   1. COMPLETENESS. The maintenance/not-maintenance split is a hand-kept list,
 *      because a detector carries no domain. A new detector added six months
 *      from now would simply never appear on this screen, with a green build
 *      and a green suite. So the first test walks the real registry and fails
 *      until somebody has decided which side the new check is on.
 *   2. THE CONDITIONAL PAIR. `operational_pattern` and
 *      `expected_activity_stopped` each cover several subjects; a wrong
 *      predicate puts an inventory-counting gap under a maintenance heading.
 *   3. SEEN IS NOT HANDLED. `known_problem` must never render as "Marked
 *      handled": that would be Staxis telling an owner a problem was fixed on
 *      the strength of somebody dismissing a card.
 *   4. THE TENANT WALL. Trails are grouped by `dedupe_key`, which is unique
 *      only WITHIN a hotel. Two hotels with the same repeat problem carry the
 *      same key by design, so a leak here merges their dates into one line.
 *   5. HOUSE STYLE. No em dashes in any string a manager reads, in either
 *      language; each beat is its own short sentence. Section 8 asks the
 *      string producers directly, so new copy is covered without anybody
 *      remembering to extend a regex.
 */

import { before, beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { listFindings } from '@/lib/findings/store';
import { allDetectors } from '@/lib/findings/registry';
import '@/lib/findings/detectors';
import type { Finding, FindingStatus } from '@/lib/findings/types';
import {
  CONDITIONAL_MAINTENANCE_DETECTORS,
  MAINTENANCE_DETECTORS,
  MAINTENANCE_LENS_DETECTOR_IDS,
  NON_MAINTENANCE_DETECTORS,
  buildPatternHistory,
  historyLine,
  isMaintenanceFinding,
  spanishHistoryTitle,
  timesCaughtLabel,
} from '@/lib/findings/maintenance-lens';

const HOTEL = '11111111-1111-4111-8111-111111111111';
const OTHER_HOTEL = '22222222-2222-4222-8222-222222222222';

let seq = 0;
function finding(over: Partial<Finding> = {}): Finding {
  seq += 1;
  return {
    id: `f${seq}`,
    propertyId: HOTEL,
    detectorId: 'repeat_room_work_orders',
    dedupeKey: 'room:204',
    summary: 'Room 204 keeps producing work orders.',
    severity: 'attention',
    disposition: 'propose',
    status: 'open',
    receiptQueryId: 'q',
    evidence: { queryId: 'q', params: {}, values: {}, basis: 'b' },
    asOf: null,
    weakestInputAgeDays: null,
    magnitude: 3,
    price: null,
    firstSeenAt: '2026-07-12T10:00:00.000Z',
    lastSeenAt: '2026-07-12T10:00:00.000Z',
    occurrenceCount: 1,
    statusChangedAt: '2026-07-12T10:00:00.000Z',
    resolvedAt: null,
    silencedAtMagnitude: null,
    escalatedAt: null,
    shownCount: 0,
    actedCount: 0,
    ignoredCount: 0,
    judgedDisposition: null,
    judgedSummaryEn: null,
    judgedSummaryEs: null,
    judgedRationale: null,
    judgedRank: null,
    judgedSource: null,
    judgedAt: null,
    judgedModel: null,
    judgedGuardRejected: false,
    ...over,
  };
}

/** Trivial phrasing, so the trail tests are about dates and outcomes only. */
const phrase = (f: Finding) => ({ en: f.summary, es: `ES:${f.summary}` });

const trail = (rows: Finding[]) => buildPatternHistory(HOTEL, rows, phrase);
const lineFor = (rows: Finding[], lang: 'en' | 'es' = 'en') =>
  historyLine(trail(rows)[0], lang, { timeZone: 'UTC' });

// ═══════════════════════════════════════════════════════════════════════════
// 1. Every check is classified — a new detector cannot slip past this screen
// ═══════════════════════════════════════════════════════════════════════════

describe('the maintenance lens covers the whole detector registry', () => {
  test('every registered detector is on exactly one list', () => {
    const registered = allDetectors().map((d) => d.declaration.id);
    assert.ok(registered.length >= 8, `registry looks empty (${registered.length})`);

    const conditional = Object.keys(CONDITIONAL_MAINTENANCE_DETECTORS);
    for (const id of registered) {
      const homes = [
        MAINTENANCE_DETECTORS.includes(id) && 'maintenance',
        conditional.includes(id) && 'conditional',
        NON_MAINTENANCE_DETECTORS.includes(id) && 'not-maintenance',
      ].filter(Boolean);
      assert.equal(
        homes.length,
        1,
        `detector "${id}" is on ${homes.length} lists (${homes.join(', ')}). ` +
        'Every check must be classified exactly once in maintenance-lens.ts — ' +
        'decide whether the Maintenance patterns popup should show it.',
      );
    }
  });

  test('no list names a detector that does not exist', () => {
    const registered = new Set(allDetectors().map((d) => d.declaration.id));
    const claimed = [
      ...MAINTENANCE_DETECTORS,
      ...Object.keys(CONDITIONAL_MAINTENANCE_DETECTORS),
      ...NON_MAINTENANCE_DETECTORS,
    ];
    for (const id of claimed) {
      assert.ok(registered.has(id), `"${id}" is classified but no longer registered — renamed?`);
    }
  });

  test('the database filter asks for the maintenance ids and no others', () => {
    const expected = [
      ...MAINTENANCE_DETECTORS,
      ...Object.keys(CONDITIONAL_MAINTENANCE_DETECTORS),
    ].sort();
    assert.deepEqual([...MAINTENANCE_LENS_DETECTOR_IDS], expected);
    for (const id of NON_MAINTENANCE_DETECTORS) {
      assert.ok(!MAINTENANCE_LENS_DETECTOR_IDS.includes(id), `${id} must not be read`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Which rows are about the building
// ═══════════════════════════════════════════════════════════════════════════

describe('picking the maintenance findings out of the queue', () => {
  test('the always-maintenance checks are in', () => {
    for (const detectorId of MAINTENANCE_DETECTORS) {
      assert.equal(isMaintenanceFinding(finding({ detectorId })), true, detectorId);
    }
  });

  test('housekeeping, inventory and supply checks stay out', () => {
    for (const detectorId of NON_MAINTENANCE_DETECTORS) {
      assert.equal(isMaintenanceFinding(finding({ detectorId })), false, detectorId);
    }
  });

  test('a repeated-complaint pattern is in only when it is the maintenance kind', () => {
    const withCategory = (category: string) => finding({
      detectorId: 'operational_pattern',
      evidence: { queryId: 'q', params: {}, values: { category }, basis: 'b' },
    });
    assert.equal(isMaintenanceFinding(withCategory('maintenance')), true);
    assert.equal(isMaintenanceFinding(withCategory('cleaning')), false);
    assert.equal(isMaintenanceFinding(withCategory('complaint')), false);
    assert.equal(isMaintenanceFinding(withCategory('noise')), false);
  });

  test('a stopped-rhythm check is in only for the work-order stream', () => {
    const forStream = (stream: string) => finding({
      detectorId: 'expected_activity_stopped',
      evidence: { queryId: 'q', params: { stream }, values: {}, basis: 'b' },
    });
    assert.equal(isMaintenanceFinding(forStream('work_order_flow')), true);
    assert.equal(isMaintenanceFinding(forStream('inventory_counts')), false);
    assert.equal(isMaintenanceFinding(forStream('daily_log_closings')), false);
  });

  test('a conditional row with no evidence to judge by is left out, not guessed at', () => {
    const bare = finding({
      detectorId: 'operational_pattern',
      evidence: { queryId: 'q', params: {}, values: {}, basis: 'b' },
    });
    assert.equal(isMaintenanceFinding(bare), false);
  });

  test('an unknown detector id is not shown', () => {
    assert.equal(isMaintenanceFinding(finding({ detectorId: 'something_new' })), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The paper trail
// ═══════════════════════════════════════════════════════════════════════════

describe('assembling one pattern’s history', () => {
  test('a hotel with nothing caught has no trail at all', () => {
    assert.deepEqual(trail([]), []);
  });

  test('a single open sighting reads as still open, and has not come back', () => {
    const [p] = trail([finding()]);
    assert.equal(p.episodes.length, 1);
    assert.equal(p.standingNow, true);
    assert.equal(p.cameBack, false);
    assert.equal(timesCaughtLabel(p, 'en'), null, 'one sighting needs no count chip');
    assert.equal(lineFor([finding()]), 'Caught Jul 12. Still open.');
  });

  test('caught, handled, then back again: the founder’s line', () => {
    const rows = [
      finding({
        status: 'resolved',
        firstSeenAt: '2026-07-12T10:00:00.000Z',
        resolvedAt: '2026-07-14T09:00:00.000Z',
        statusChangedAt: '2026-07-14T09:00:00.000Z',
      }),
      finding({ status: 'open', firstSeenAt: '2026-07-26T10:00:00.000Z' }),
    ];
    assert.equal(
      lineFor(rows),
      'Caught Jul 12. Marked handled Jul 14. Came back Jul 26. Still open.',
    );
    const [p] = trail(rows);
    assert.equal(p.cameBack, true);
    assert.equal(p.standingNow, true);
    assert.equal(timesCaughtLabel(p, 'en'), 'Caught 2 times');
  });

  test('a problem that stopped on its own says so, and does not claim credit', () => {
    const line = lineFor([finding({
      status: 'expired',
      statusChangedAt: '2026-07-20T10:00:00.000Z',
    })]);
    assert.equal(line, 'Caught Jul 12. Cleared on its own Jul 20.');
    assert.ok(!line.includes('handled'));
  });

  test('SEEN IS NOT HANDLED: a silenced card never reads as fixed', () => {
    const line = lineFor([finding({
      status: 'known_problem',
      statusChangedAt: '2026-07-15T10:00:00.000Z',
    })]);
    assert.equal(line, 'Caught Jul 12. Marked a known problem Jul 15.');
    assert.ok(!line.includes('Marked handled'), 'a known problem must never read as handled');
    assert.ok(!line.includes('Cleared'), 'nor as having cleared');
  });

  test('a muted card reads as the manager’s refusal, not as an outcome', () => {
    const line = lineFor([finding({
      status: 'muted',
      statusChangedAt: '2026-07-16T10:00:00.000Z',
    })]);
    assert.equal(line, 'Caught Jul 12. Hidden Jul 16.');
    assert.ok(!line.includes('handled'));
  });

  test('the handled date comes from resolved_at, which only resolution writes', () => {
    const [p] = trail([finding({
      status: 'resolved',
      resolvedAt: '2026-07-14T09:00:00.000Z',
      // A later status touch must not move the date the manager sees.
      statusChangedAt: '2026-07-30T09:00:00.000Z',
    })]);
    assert.equal(p.episodes[0].outcomeAt, '2026-07-14T09:00:00.000Z');
  });

  test('every other closed state falls back to the status clock', () => {
    const [p] = trail([finding({
      status: 'expired',
      resolvedAt: null,
      statusChangedAt: '2026-07-20T10:00:00.000Z',
    })]);
    assert.equal(p.episodes[0].outcomeAt, '2026-07-20T10:00:00.000Z');
  });

  test('episodes run oldest first however the rows arrive', () => {
    const [p] = trail([
      finding({ status: 'open', firstSeenAt: '2026-07-26T10:00:00.000Z' }),
      finding({ status: 'resolved', firstSeenAt: '2026-07-12T10:00:00.000Z', resolvedAt: '2026-07-14T09:00:00.000Z' }),
    ]);
    assert.deepEqual(
      p.episodes.map((e) => e.outcome),
      ['handled', 'standing'],
    );
  });

  test('separate problems stay separate, most recently active first', () => {
    const out = trail([
      finding({ dedupeKey: 'room:204', lastSeenAt: '2026-07-12T10:00:00.000Z', statusChangedAt: '2026-07-12T10:00:00.000Z' }),
      finding({ dedupeKey: 'equipment:boiler', firstSeenAt: '2026-07-25T10:00:00.000Z', lastSeenAt: '2026-07-27T10:00:00.000Z', statusChangedAt: '2026-07-25T10:00:00.000Z' }),
    ]);
    assert.deepEqual(out.map((p) => p.dedupeKey), ['equipment:boiler', 'room:204']);
  });

  test('non-maintenance rows never reach the trail even if handed in', () => {
    const out = trail([
      finding({ detectorId: 'room_needs_attention', dedupeKey: 'room:301' }),
      finding({ detectorId: 'preventive_due', dedupeKey: 'pm:flush' }),
    ]);
    assert.deepEqual(out.map((p) => p.dedupeKey), ['pm:flush']);
  });

  test('the title is the newest sighting’s wording', () => {
    const [p] = trail([
      finding({ status: 'resolved', firstSeenAt: '2026-07-12T10:00:00.000Z', summary: 'old wording' }),
      finding({ status: 'open', firstSeenAt: '2026-07-26T10:00:00.000Z', summary: 'new wording' }),
    ]);
    assert.equal(p.titleEn, 'new wording');
    assert.equal(p.titleEs, 'ES:new wording');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The tenant wall
// ═══════════════════════════════════════════════════════════════════════════

describe('cross-tenant probe: one hotel’s trail is only its own', () => {
  test('another hotel’s row with the SAME dedupe key never joins the trail', () => {
    const rows = [
      finding({ propertyId: HOTEL, dedupeKey: 'room:204', firstSeenAt: '2026-07-12T10:00:00.000Z' }),
      // Same problem, same key, different hotel — the exact shape that would
      // merge two hotels' dates into one line.
      finding({
        propertyId: OTHER_HOTEL,
        dedupeKey: 'room:204',
        status: 'resolved',
        firstSeenAt: '2026-07-01T10:00:00.000Z',
        resolvedAt: '2026-07-03T09:00:00.000Z',
      }),
    ];
    const out = buildPatternHistory(HOTEL, rows, phrase);
    assert.equal(out.length, 1);
    assert.equal(out[0].episodes.length, 1, 'the other hotel’s sighting leaked in');
    assert.equal(out[0].cameBack, false, 'the other hotel’s history invented a recurrence');
    assert.equal(
      historyLine(out[0], 'en', { timeZone: 'UTC' }),
      'Caught Jul 12. Still open.',
    );
  });

  test('asking for a hotel with no rows of its own returns nothing', () => {
    const out = buildPatternHistory(OTHER_HOTEL, [finding({ propertyId: HOTEL })], phrase);
    assert.deepEqual(out, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Both languages
// ═══════════════════════════════════════════════════════════════════════════

describe('the trail reads in the manager’s own language', () => {
  const rows = () => [
    finding({
      status: 'resolved',
      firstSeenAt: '2026-07-12T10:00:00.000Z',
      resolvedAt: '2026-07-14T09:00:00.000Z',
    }),
    finding({ status: 'open', firstSeenAt: '2026-07-26T10:00:00.000Z' }),
  ];

  test('Spanish carries no English outcome words', () => {
    const es = lineFor(rows(), 'es');
    assert.equal(
      es,
      'Detectado 12 jul. Marcado como resuelto 14 jul. Volvió 26 jul. Sigue abierto.',
    );
    for (const english of ['Caught', 'Marked handled', 'Came back', 'Still open']) {
      assert.ok(!es.includes(english), `Spanish line leaked "${english}"`);
    }
  });

  test('English carries no Spanish', () => {
    const en = lineFor(rows(), 'en');
    for (const spanish of ['Detectado', 'resuelto', 'Volvió', 'Sigue']) {
      assert.ok(!en.includes(spanish), `English line leaked "${spanish}"`);
    }
  });

  test('both languages describe the same number of beats', () => {
    assert.equal(
      lineFor(rows(), 'en').split('. ').length,
      lineFor(rows(), 'es').split('. ').length,
    );
  });

  test('every outcome has a Spanish rendering', () => {
    const statuses: FindingStatus[] = ['open', 'resolved', 'known_problem', 'muted', 'expired'];
    for (const status of statuses) {
      const es = lineFor([finding({ status, resolvedAt: '2026-07-14T09:00:00.000Z' })], 'es');
      assert.ok(es.startsWith('Detectado 12 jul. '), status);
      assert.ok(es.length > 'Detectado 12 jul. '.length, `${status} rendered an empty outcome`);
    }
  });

  test('a Spanish history title prefers the judge, then the row’s own basis', () => {
    assert.equal(
      spanishHistoryTitle('Frase del juez', 'base en español', 'plantilla'),
      'Frase del juez',
    );
    assert.equal(
      spanishHistoryTitle(null, 'base en español', 'plantilla'),
      'base en español',
      'an unphrased row should be named by its own numbers, not a template',
    );
    assert.equal(spanishHistoryTitle(null, null, 'plantilla'), 'plantilla');
    assert.equal(spanishHistoryTitle('   ', '  ', 'plantilla'), 'plantilla',
      'whitespace is not phrasing');
  });

  test('two unphrased Spanish patterns do not collapse into the same title', () => {
    // The bug this guards: cardPhrasing's Spanish fallback is one generic
    // sentence, so every unphrased pattern got an identical title and the
    // list became unreadable in Spanish.
    const a = spanishHistoryTitle(null, '4 órdenes en la habitación 204', 'Atención: Staxis tiene algo abierto.');
    const b = spanishHistoryTitle(null, '5 órdenes en la caldera 2', 'Atención: Staxis tiene algo abierto.');
    assert.notEqual(a, b);
  });

  test('the count chip is bilingual', () => {
    const [p] = trail(rows());
    assert.equal(timesCaughtLabel(p, 'en'), 'Caught 2 times');
    assert.equal(timesCaughtLabel(p, 'es'), 'Detectado 2 veces');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The read is hotel-scoped and asks only for maintenance checks
// ═══════════════════════════════════════════════════════════════════════════

describe('the database read behind the popup', () => {
  interface RecordedQuery { table: string; filters: Array<[string, unknown]> }
  let recorded: RecordedQuery[] = [];
  const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

  beforeEach(() => {
    recorded = [];
    // @ts-expect-error monkey-patch the singleton for the test
    supabaseAdmin.from = (table: string) => {
      const query: RecordedQuery = { table, filters: [] };
      recorded.push(query);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { query.filters.push([`eq:${c}`, v]); return chain; },
        gte: (c: string, v: unknown) => { query.filters.push([`gte:${c}`, v]); return chain; },
        in: (c: string, v: unknown) => { query.filters.push([`in:${c}`, v]); return chain; },
        order: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return chain;
    };
  });

  afterEach(() => { supabaseAdmin.from = originalFrom; });

  test('a set of detector ids becomes one IN filter, not a scan of everything', async () => {
    await listFindings(HOTEL, {
      statuses: ['open', 'resolved'],
      detectorId: MAINTENANCE_LENS_DETECTOR_IDS,
    });
    const q = recorded.find((r) => r.table === 'findings');
    assert.ok(q, 'findings was never read');
    const byDetector = q.filters.find(([c]) => c === 'in:detector_id');
    assert.ok(byDetector, 'the detector set was dropped — the popup would read every check');
    assert.deepEqual(byDetector[1], [...MAINTENANCE_LENS_DETECTOR_IDS]);
  });

  test('the read carries this hotel and no other', async () => {
    await listFindings(HOTEL, { detectorId: MAINTENANCE_LENS_DETECTOR_IDS });
    const q = recorded.find((r) => r.table === 'findings')!;
    const scope = q.filters.find(([c]) => c === 'eq:property_id');
    assert.ok(scope, 'the read escaped its hotel');
    assert.equal(scope[1], HOTEL);
    assert.ok(
      !q.filters.some(([, v]) => v === OTHER_HOTEL),
      'a read carried the wrong hotel id',
    );
  });

  test('a single detector id still uses an equality filter', async () => {
    await listFindings(HOTEL, { detectorId: 'preventive_due' });
    const q = recorded.find((r) => r.table === 'findings')!;
    const byDetector = q.filters.find(([c]) => c === 'eq:detector_id');
    assert.ok(byDetector, 'the runner’s single-detector re-arm read broke');
    assert.equal(byDetector[1], 'preventive_due');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. What the popup actually draws
// ═══════════════════════════════════════════════════════════════════════════

const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);

type PanelModule = typeof import('@/app/maintenance/_components/PatternsPanel');
let panel: PanelModule;
let R: typeof import('react');

before(async () => {
  const react = nodeRequire('react') as Record<string, unknown>;
  if (typeof react.createContext !== 'function') {
    react.createContext = (defaultValue: unknown) => ({
      Provider: () => null,
      Consumer: () => null,
      _currentValue: defaultValue,
    });
  }
  R = react as unknown as typeof import('react');
  panel = await import('@/app/maintenance/_components/PatternsPanel');
});

type ElementProps = Record<string, unknown> & { children?: React.ReactNode };

/** Every string in an element tree, descending through plain wrappers. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => textOf(child, out));
    return out;
  }
  if (R.isValidElement<ElementProps>(node)) {
    const type = node.type;
    // Hook-free local helpers are invoked so their text is visible; imported
    // components (FindingCardsView, Modal) are left as elements and inspected
    // by prop instead — calling them outside React would throw on useState.
    if (typeof type === 'function' && LOCAL_HELPERS.has(type.name)) {
      return textOf((type as (p: ElementProps) => unknown)(node.props), out);
    }
    textOf(node.props.children, out);
  }
  return out;
}

const LOCAL_HELPERS = new Set(['Note', 'SectionLabel', 'Chip', 'HistoryRow']);

/** The first element of the named component type anywhere in the tree. */
function findByName(node: unknown, name: string): { props: ElementProps } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByName(child, name);
      if (hit) return hit;
    }
    return null;
  }
  if (!R.isValidElement<ElementProps>(node)) return null;
  const type = node.type as { name?: string } | string;
  if (typeof type !== 'string' && type?.name === name) {
    return { props: node.props };
  }
  return findByName(node.props.children, name);
}

describe('what the popup says', () => {
  const payload = (over: Partial<{ findings: unknown[]; history: unknown[] }> = {}) => ({
    findings: [],
    history: [],
    run: null,
    cap: 1,
    ...over,
  });

  test('a hotel with nothing caught gets one calm line, not a warning', () => {
    const text = textOf(panel.MaintenancePatternsBody({
      state: 'ready',
      payload: payload() as never,
      lang: 'en',
    })).join(' ');
    assert.match(text, /hasn’t caught any repeat maintenance problems here yet/);
    // The runner is switched off fleet-wide, so this is the COMMON case. It
    // must not read as broken.
    for (const alarming of ['error', 'failed', 'not running', 'off', 'unavailable']) {
      assert.ok(!text.toLowerCase().includes(alarming), `empty state sounded alarming: "${alarming}"`);
    }
  });

  test('the empty line is bilingual', () => {
    const es = textOf(panel.MaintenancePatternsBody({
      state: 'ready',
      payload: payload() as never,
      lang: 'es',
    })).join(' ');
    assert.match(es, /Staxis todavía no ha detectado/);
    assert.ok(!es.includes('hasn’t caught'));
  });

  test('A FAILED READ IS NEVER DRAWN AS AN EMPTY ONE', () => {
    const text = textOf(panel.MaintenancePatternsBody({
      state: 'failed',
      payload: null,
      lang: 'en',
    })).join(' ');
    assert.match(text, /Couldn’t check just now/);
    assert.ok(
      !text.includes('hasn’t caught any'),
      'a broken read claimed the building is clean',
    );
  });

  test('history lines render with their trail and their chips', () => {
    const rows = [
      finding({
        status: 'resolved',
        firstSeenAt: '2026-07-12T10:00:00.000Z',
        resolvedAt: '2026-07-14T09:00:00.000Z',
      }),
      finding({ status: 'open', firstSeenAt: '2026-07-26T10:00:00.000Z' }),
    ];
    const text = textOf(panel.MaintenancePatternsBody({
      state: 'ready',
      payload: payload({ history: trail(rows) }) as never,
      lang: 'en',
    })).join(' ');
    assert.match(text, /Room 204 keeps producing work orders/);
    assert.match(text, /Caught Jul 12\. Marked handled Jul 14\. Came back Jul 26\. Still open\./);
    assert.match(text, /Came back/, 'the recurrence chip is missing');
    assert.match(text, /Caught 2 times/);
  });

  test('with history but nothing open, it says so rather than showing an empty card slot', () => {
    const text = textOf(panel.MaintenancePatternsBody({
      state: 'ready',
      payload: payload({ history: trail([finding({ status: 'resolved', resolvedAt: '2026-07-14T09:00:00.000Z' })]) }) as never,
      lang: 'en',
    })).join(' ');
    assert.match(text, /Nothing open right now/);
  });

  test('the standing cards are drawn read-only, with no way to decide from here', () => {
    const tree = panel.MaintenancePatternsBody({
      state: 'ready',
      payload: payload({ findings: [{ id: 'x' }] }) as never,
      lang: 'en',
    });
    const cards = findByName(tree, 'FindingCardsView');
    assert.ok(cards, 'the queue card component was not used — cards were re-implemented');
    assert.equal(cards.props.readOnly, true, 'the popup offered verdict buttons');
    assert.equal(cards.props.onAction, undefined, 'the popup offered to run a fix');
    assert.equal(cards.props.hideLiveness, true, 'the whole-hotel run line would mislead here');
  });

  test('it points the manager at the one place decisions happen', () => {
    const text = textOf(panel.MaintenancePatternsBody({
      state: 'ready',
      payload: payload({ findings: [{ id: 'x' }] }) as never,
      lang: 'en',
    })).join(' ');
    assert.match(text, /Staxis tab/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. House style: no em dashes, anywhere a manager can read
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A founder ruling that binds every user-facing string in this feature: no em
 * dashes, in either language. Short plain sentences with full stops instead,
 * because a manager scanning a list should not have to parse punctuation
 * before they can read a date.
 *
 * These tests ask the string PRODUCERS rather than grepping the source, so a
 * beat or a copy key added later is covered without anybody remembering to
 * extend a regex — and so the em dashes in this file's own COMMENTS (which no
 * manager ever sees) do not produce a false failure.
 *
 * Built with fromCharCode rather than a literal: an escape sequence written
 * into a source file by a tool becomes the character itself, and a test whose
 * subject can be silently rewritten proves nothing.
 */
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ARROW = String.fromCharCode(0x2192);
const LANGS: Array<'en' | 'es'> = ['en', 'es'];

describe('no em dashes in anything the manager reads', () => {
  test('the character this rule is about really is the em dash', () => {
    assert.equal(EM_DASH.length, 1);
    assert.equal(EM_DASH.charCodeAt(0), 8212);
  });

  test('every popup string, both languages, is clean', () => {
    assert.ok(panel.PANEL_TEXT_KEYS.length >= 10, 'the copy deck looks empty');
    for (const key of panel.PANEL_TEXT_KEYS) {
      for (const lang of LANGS) {
        const text = panel.panelText(key, lang);
        assert.ok(text.length > 0, `${key}/${lang} is empty`);
        assert.ok(!text.includes(EM_DASH), `${key}/${lang} contains an em dash: "${text}"`);
        assert.ok(!text.includes(ARROW), `${key}/${lang} contains an arrow: "${text}"`);
      }
    }
  });

  test('every history line, every outcome, both languages, is clean', () => {
    const statuses: FindingStatus[] = ['open', 'updated', 'resolved', 'known_problem', 'muted', 'expired'];
    for (const status of statuses) {
      for (const lang of LANGS) {
        // Single sighting, and a recurrence, so the "came back" beat is covered too.
        for (const rows of [
          [finding({ status, resolvedAt: '2026-07-14T09:00:00.000Z' })],
          [
            finding({ status: 'resolved', firstSeenAt: '2026-07-12T10:00:00.000Z', resolvedAt: '2026-07-14T09:00:00.000Z' }),
            finding({ status, firstSeenAt: '2026-07-26T10:00:00.000Z', resolvedAt: '2026-07-28T09:00:00.000Z' }),
          ],
        ]) {
          const line = lineFor(rows, lang);
          assert.ok(!line.includes(EM_DASH), `${status}/${lang}: "${line}"`);
          assert.ok(!line.includes(EN_DASH), `${status}/${lang}: "${line}"`);
          assert.ok(!line.includes(ARROW), `${status}/${lang}: "${line}"`);
        }
      }
    }
  });

  test('the count chip is clean in both languages', () => {
    const [p] = trail([
      finding({ status: 'resolved', firstSeenAt: '2026-07-12T10:00:00.000Z', resolvedAt: '2026-07-14T09:00:00.000Z' }),
      finding({ status: 'open', firstSeenAt: '2026-07-26T10:00:00.000Z' }),
    ]);
    for (const lang of LANGS) {
      const chip = timesCaughtLabel(p, lang)!;
      assert.ok(chip && !chip.includes(EM_DASH), `${lang}: "${chip}"`);
    }
  });

  test('every beat is its own sentence, ending in a full stop', () => {
    const line = lineFor([
      finding({ status: 'resolved', firstSeenAt: '2026-07-12T10:00:00.000Z', resolvedAt: '2026-07-14T09:00:00.000Z' }),
      finding({ status: 'open', firstSeenAt: '2026-07-26T10:00:00.000Z' }),
    ], 'en');
    assert.ok(line.endsWith('.'), `no closing stop: "${line}"`);
    assert.ok(!line.includes('..'), `doubled stop: "${line}"`);
    assert.equal(line.split('. ').length, 4, `expected four beats, got "${line}"`);
    for (const beat of line.slice(0, -1).split('. ')) {
      assert.ok(beat.length > 0, 'an empty beat');
      assert.match(beat[0], /[A-ZÁÉÍÓÚÑ]/, `beat does not start a sentence: "${beat}"`);
    }
  });
});
