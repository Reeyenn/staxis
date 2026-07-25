/**
 * The findings layer's pure half: the silencer's decision table, the registry's
 * refusal to accept a badly-declared detector, and every detector's own frozen
 * eval cases.
 *
 * These exercise real functions with real inputs — no source-text greps. Each
 * assertion was checked by mutating the implementation and confirming it goes
 * red (the mutation list is in the branch's task summary); an assertion that
 * survives every plausible bug is decoration, not a test.
 *
 * The LEDGER's guarantees (one row per problem, mute, escalation, isolation)
 * are proven against a real Postgres in findings-ledger.integration.test.ts —
 * they are database constraints, and asserting them in memory would prove
 * nothing about the database.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  allDetectors,
  validateDeclaration,
  DetectorDeclarationError,
} from '@/lib/findings/registry';
import {
  capDrafts,
  decideAction,
  dedupeDrafts,
  dedupeKeyFor,
  evidenceMoved,
  shouldEscalate,
  type ExistingFinding,
} from '@/lib/findings/silencer';
import { runAllDetectorEvalCases, runDetectorEvalCases } from '@/lib/findings/evals';
import { isUsablePriceRange, readFeed } from '@/lib/findings/types';
import type {
  AnyDetector,
  DetectorContext,
  DetectorDeclaration,
  DetectorParams,
  FindingDraft,
} from '@/lib/findings/types';

// Registers the three shipped detectors.
import '@/lib/findings/detectors';

// ─── helpers ────────────────────────────────────────────────────────────────

function draft(over: Partial<FindingDraft> = {}): FindingDraft {
  return {
    key: 'room_214:hvac',
    summary: 'Room 214 has had repeated maintenance issues (4 hvac work orders in 30 days).',
    severity: 'attention',
    magnitude: 4,
    evidence: { queryId: 'q', params: {}, values: {}, basis: 'b' },
    ...over,
  };
}

function existing(over: Partial<ExistingFinding> = {}): ExistingFinding {
  return {
    status: 'open',
    magnitude: 4,
    summary: 'Room 214 has had repeated maintenance issues (4 hvac work orders in 30 days).',
    silencedAtMagnitude: null,
    ...over,
  };
}

const BASE_DECLARATION: DetectorDeclaration<DetectorParams> = {
  id: 'probe_detector',
  description: 'probe',
  inputs: ['operational_signals'],
  requires: [{ feed: 'operational_signals', minRecords: 0, because: 'no records' }],
  receiptQueryId: 'q',
  defaultDisposition: 'fyi',
  defaultSeverity: 'attention',
  escalation: { factor: 2, minDelta: 3 },
  maxPerRun: 10,
  staleAfterDays: 7,
  evalCases: [{ name: 'c', feeds: { operational_signals: [] }, expectKeys: [] }],
};

function detectorWith(over: Partial<DetectorDeclaration<DetectorParams>>): AnyDetector {
  return {
    declaration: { ...BASE_DECLARATION, ...over },
    detect: () => [],
  };
}

// ─── identity ───────────────────────────────────────────────────────────────

describe('a problem has one identity, and it is not its size', () => {
  test('the same draft key from two detectors is two different problems', () => {
    assert.notEqual(
      dedupeKeyFor('operational_pattern', 'room_214'),
      dedupeKeyFor('cleaning_plan_health', 'room_214'),
      'without the detector prefix, two detectors would share one row and overwrite each other',
    );
  });

  test('the key is stable across runs for the same problem', () => {
    assert.equal(dedupeKeyFor('a_detector', 'room_214:hvac'), dedupeKeyFor('a_detector', 'room_214:hvac'));
  });

  test('a key that would not fit the column fails loudly instead of truncating', () => {
    assert.throws(
      () => dedupeKeyFor('a_detector', 'x'.repeat(300)),
      /exceeds 200 characters/,
      'truncating would silently merge two different problems into one card',
    );
  });
});

// ─── escalation ─────────────────────────────────────────────────────────────

describe('four known work orders is consent to four, not to nine', () => {
  const policy = { factor: 2, minDelta: 3 };

  test('a detector with no escalation policy never breaks its silence', () => {
    assert.equal(shouldEscalate(null, 4, 1_000_000), false);
  });

  test('creeping from 4 to 5 stays quiet', () => {
    assert.equal(shouldEscalate(policy, 4, 5), false);
  });

  test('4 to 7 stays quiet — proportional growth is not enough on its own', () => {
    assert.equal(shouldEscalate(policy, 4, 7), false);
  });

  test('4 to 9 breaks the silence', () => {
    assert.equal(shouldEscalate(policy, 4, 9), true);
  });

  test('exactly double AND far enough away breaks the silence', () => {
    assert.equal(shouldEscalate(policy, 4, 8), true);
  });

  test('doubling a tiny number does not, because the absolute move is trivial', () => {
    assert.equal(shouldEscalate(policy, 1, 2), false, '1 -> 2 is double but a delta of 1');
  });

  test('a silence with no recorded consent point never escalates', () => {
    assert.equal(
      shouldEscalate(policy, null, 1_000),
      false,
      'guessing the consent point would mean re-nagging a manager who asked for quiet',
    );
  });
});

// ─── the decision table ─────────────────────────────────────────────────────

describe('the silencer decides what a re-found problem does', () => {
  const declaration = BASE_DECLARATION;

  test('nothing on file opens a card', () => {
    assert.deepEqual(decideAction(null, draft(), declaration), { kind: 'open' });
  });

  test('muted is muted, no matter how much worse it got', () => {
    const action = decideAction(
      existing({ status: 'muted', silencedAtMagnitude: 4 }),
      draft({ magnitude: 900 }),
      declaration,
    );
    assert.deepEqual(action, { kind: 'suppress', reason: 'muted' });
  });

  test('a known problem that barely moved stays quiet', () => {
    const action = decideAction(
      existing({ status: 'known_problem', silencedAtMagnitude: 4 }),
      draft({ magnitude: 5, summary: 'now 5' }),
      declaration,
    );
    assert.deepEqual(action, { kind: 'suppress', reason: 'known_problem' });
  });

  test('a known problem that outgrew the silence escalates', () => {
    const action = decideAction(
      existing({ status: 'known_problem', silencedAtMagnitude: 4 }),
      draft({ magnitude: 9, summary: 'now 9' }),
      declaration,
    );
    assert.deepEqual(action, { kind: 'escalate' });
  });

  test('a known problem never escalates when the detector declared no policy', () => {
    const action = decideAction(
      existing({ status: 'known_problem', silencedAtMagnitude: 4 }),
      draft({ magnitude: 900 }),
      { ...declaration, escalation: null },
    );
    assert.deepEqual(action, { kind: 'suppress', reason: 'known_problem' });
  });

  test('an open card whose numbers moved becomes updated', () => {
    const action = decideAction(existing(), draft({ magnitude: 5, summary: 'now 5' }), declaration);
    assert.deepEqual(action, { kind: 'update', status: 'updated' });
  });

  test('an open card whose numbers did not move stays open', () => {
    assert.deepEqual(decideAction(existing(), draft(), declaration), {
      kind: 'update',
      status: 'open',
    });
  });

  test('once updated it stays updated — the manager still has not seen the newer number', () => {
    const action = decideAction(existing({ status: 'updated' }), draft(), declaration);
    assert.deepEqual(action, { kind: 'update', status: 'updated' });
  });

  test('evidence moving is measured on both the number and the sentence', () => {
    assert.equal(evidenceMoved(existing(), draft()), false);
    assert.equal(evidenceMoved(existing(), draft({ magnitude: 5 })), true);
    assert.equal(evidenceMoved(existing(), draft({ summary: 'different words' })), true);
  });
});

// ─── caps ───────────────────────────────────────────────────────────────────

describe('a strange night cannot become a hundred cards', () => {
  const many = Array.from({ length: 40 }, (_, i) => draft({ key: `k${i}`, magnitude: i }));

  test('the cap is applied', () => {
    assert.equal(capDrafts(many, 5).length, 5);
  });

  test('the cap keeps the worst, not the first', () => {
    const kept = capDrafts(many, 3).map((d) => d.magnitude);
    assert.deepEqual(kept, [39, 38, 37]);
  });

  test('the same night always truncates to the same set', () => {
    const shuffled = [...many].reverse();
    assert.deepEqual(
      capDrafts(many, 7).map((d) => d.key),
      capDrafts(shuffled, 7).map((d) => d.key),
      'a cap that depended on input order would make cards appear and vanish for no visible reason',
    );
  });

  test('ties break alphabetically so the order is total', () => {
    const tied = [draft({ key: 'b', magnitude: 1 }), draft({ key: 'a', magnitude: 1 })];
    assert.deepEqual(capDrafts(tied, 2).map((d) => d.key), ['a', 'b']);
  });

  test('a detector that emits the same key twice writes once', () => {
    const dupes = [draft({ key: 'same', magnitude: 4 }), draft({ key: 'same', magnitude: 9 })];
    const out = dedupeDrafts(dupes);
    assert.equal(out.length, 1);
    assert.equal(out[0].magnitude, 4, 'the first sighting wins; the second is a detector bug');
  });
});

// ─── price ──────────────────────────────────────────────────────────────────

describe('a price tag is a range or it is nothing', () => {
  const base = { lowCents: 20_000, highCents: 40_000, currency: 'USD', basis: 'last 3 invoices' };

  test('a real range is usable', () => {
    assert.equal(isUsablePriceRange(base), true);
  });

  test('a point estimate dressed as a range is refused', () => {
    assert.equal(
      isUsablePriceRange({ ...base, highCents: 20_000 }),
      false,
      '"$200-$200" is "$200" with extra steps, which is the thing we decided never to say',
    );
  });

  test('an inverted range is refused', () => {
    assert.equal(isUsablePriceRange({ ...base, lowCents: 50_000 }), false);
  });

  test('a negative low is refused', () => {
    assert.equal(isUsablePriceRange({ ...base, lowCents: -1 }), false);
  });

  test('no price at all is fine — saying nothing beats guessing', () => {
    assert.equal(isUsablePriceRange(null), false);
  });
});

// ─── the registry ───────────────────────────────────────────────────────────

describe('the registry refuses a detector that could misbehave', () => {
  const none = new Set<string>();

  test('a well-formed declaration passes', () => {
    assert.doesNotThrow(() => validateDeclaration(detectorWith({}), none));
  });

  test('two detectors cannot share an id — they would share the one-row slot', () => {
    assert.throws(
      () => validateDeclaration(detectorWith({}), new Set(['probe_detector'])),
      DetectorDeclarationError,
    );
  });

  test('an id that will not survive being a key prefix is refused', () => {
    assert.throws(() => validateDeclaration(detectorWith({ id: 'Bad Id!' }), none), DetectorDeclarationError);
  });

  test('a requirement on a feed the detector never declared is refused', () => {
    assert.throws(
      () =>
        validateDeclaration(
          detectorWith({ requires: [{ feed: 'nudge_drafts', minRecords: 0, because: 'x' }] }),
          none,
        ),
      DetectorDeclarationError,
    );
  });

  test('a feed with no declared minimum is refused — silence must be counted, not assumed', () => {
    assert.throws(
      () =>
        validateDeclaration(
          detectorWith({ inputs: ['operational_signals', 'nudge_drafts'] }),
          none,
        ),
      DetectorDeclarationError,
    );
  });

  test('a detector with no cap is refused', () => {
    assert.throws(() => validateDeclaration(detectorWith({ maxPerRun: 0 }), none), DetectorDeclarationError);
  });

  test('an escalation policy that fires on any re-find is not a silencer', () => {
    assert.throws(
      () => validateDeclaration(detectorWith({ escalation: { factor: 1, minDelta: 1 } }), none),
      DetectorDeclarationError,
    );
    assert.throws(
      () => validateDeclaration(detectorWith({ escalation: { factor: 2, minDelta: 0 } }), none),
      DetectorDeclarationError,
    );
  });

  test('a detector with no eval cases is refused', () => {
    assert.throws(() => validateDeclaration(detectorWith({ evalCases: [] }), none), DetectorDeclarationError);
  });

  test('a finding nobody can re-check is refused', () => {
    assert.throws(
      () => validateDeclaration(detectorWith({ receiptQueryId: '  ' }), none),
      DetectorDeclarationError,
    );
  });
});

// ─── the context is closed ──────────────────────────────────────────────────

describe('a detector can only see what it declared', () => {
  test('reading an undeclared feed throws instead of silently finding nothing', () => {
    const ctx: DetectorContext = {
      propertyId: '00000000-0000-4000-8000-000000000001',
      now: new Date('2026-01-01T00:00:00Z'),
      timezone: null,
      businessDate: '2026-01-01',
      feeds: {},
    };
    assert.throws(() => readFeed(ctx, 'operational_signals'), /without declaring it in inputs/);
  });

  test('a feed that failed to load throws rather than reading as empty', () => {
    const ctx: DetectorContext = {
      propertyId: '00000000-0000-4000-8000-000000000001',
      now: new Date('2026-01-01T00:00:00Z'),
      timezone: null,
      businessDate: '2026-01-01',
      feeds: { operational_signals: { error: 'boom' } },
    };
    assert.throws(() => readFeed(ctx, 'operational_signals'), /failed to load: boom/);
  });
});

// ─── the shipped detectors ──────────────────────────────────────────────────

describe('every shipped detector does what it says it does', () => {
  test('all three ported systems are registered', () => {
    const ids = allDetectors().map((d) => d.declaration.id);
    assert.deepEqual(
      ids,
      ['cleaning_plan_health', 'operational_pattern', 'room_needs_attention'],
      'the three detection systems that existed before this layer all run under the one runner now',
    );
  });

  test('every eval case passes', () => {
    const results = runAllDetectorEvalCases();
    assert.ok(results.length >= 7, `expected the shipped eval cases to run, got ${results.length}`);
    const failures = results.filter((r) => !r.ok);
    assert.deepEqual(
      failures.map((f) => `${f.detectorId}/${f.name}: ${f.detail}`),
      [],
    );
  });

  test('the eval harness itself fails a detector that lies about its output', () => {
    // Guards the guard: if runDetectorEvalCases silently passed everything, the
    // suite above would be worthless.
    const liar: AnyDetector = {
      declaration: {
        ...BASE_DECLARATION,
        evalCases: [
          { name: 'claims nothing fires', feeds: { operational_signals: [] }, expectKeys: [] },
        ],
      },
      detect: () => [draft({ key: 'surprise' })],
    };
    const [result] = runDetectorEvalCases(liar);
    assert.equal(result.ok, false);
    assert.match(result.detail ?? '', /expected keys \[\], got \["surprise"\]/);
  });

  test('the operational-pattern detector keys on the room, not the count', () => {
    const detector = allDetectors().find((d) => d.declaration.id === 'operational_pattern')!;
    const four = detector.declaration.evalCases[0];
    const nine = detector.declaration.evalCases[1];
    assert.deepEqual(
      four.expectKeys,
      nine.expectKeys,
      'four work orders and nine work orders on the same room are one problem',
    );
  });
});
