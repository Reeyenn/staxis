/**
 * THE COPY RULES FOR EVERYTHING THE FINDINGS ENGINE SAYS OUT LOUD.
 *
 * Founder ruling, 2026-07-28: no em dashes in user-facing copy, in either
 * language, and keep the sentences short and plain. He found two of them on his
 * own pattern cards, which is the surface with the widest reach in the product:
 * `spanishTemplateSentence` alone is shared by the Staxis tab cards, the morning
 * brief, the company queue and the maintenance popup.
 *
 * ─── WHY THIS WALKS PRODUCERS AND NOT SOURCE ──────────────────────────────
 * The obvious version of this test greps the files for a dash. That version
 * passes on the bug that actually shipped, because most of these sentences are
 * ASSEMBLED: the dash arrived through a joiner in one file wrapping a fragment
 * from another, and neither file read wrong on its own. It would also fail on
 * every harmless rename, which is how a guard gets deleted.
 *
 * So this calls the real producers, over a fixture matrix built to reach their
 * branches, in BOTH languages, and reads what comes out. Same shape as the
 * ordering-manager copy block (ordering-manager.test.ts) that came in with the
 * same ruling.
 *
 * ─── SCOPE ────────────────────────────────────────────────────────────────
 * Strings a USER reads: card phrasing, the card's own copy table, closure
 * buttons, liveness and staleness lines, the Spanish template floor, the
 * morning brief, the VP portfolio brief, and the shared-knowledge approval
 * card's status line.
 *
 * Deliberately NOT covered, and this is the same carve-out the ordering block
 * makes: `DetectorDeclaration.description` / `undoDescription` and agent tool
 * descriptions. Those are documentation of a detector for the catalog and the
 * model, never rendered to a manager, and they follow the catalog's own house
 * style.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import Module from 'node:module';
import type React from 'react';

import {
  basisInLang,
  cardEyebrowLabel,
  cardPhrasing,
  closureButtons,
  dataAgeNote,
  declinedExplanation,
  formatShortDate,
  livenessLine,
  occurrenceLine,
  signOffNotice,
  skippedNote,
  type CardAction,
  type CardSignOff,
  type Lang,
  type QueueFinding,
  type QueueRun,
} from '@/components/concourse/finding-cards';
import {
  spanishTemplateSentence,
  templatePriceSentence,
  templateSubject,
  withoutEmDash,
} from '@/lib/findings/template-phrasing';
import { templateJudgment } from '@/lib/findings/judge';
import { buildBrief, type BriefInput } from '@/lib/findings/brief';
import { buildPortfolioBrief, type PortfolioBriefInput } from '@/lib/company/vp-brief';
import type { PortfolioCard } from '@/lib/company/vp-queue';
import { runDetectorEvalCases } from '@/lib/findings/evals';
import { allDetectors } from '@/lib/findings/registry';
// Side-effect import: registers every detector so `allDetectors()` is populated.
import '@/lib/findings/detectors';

const EM_DASH = '—';
const NOW = new Date('2026-07-28T15:00:00.000Z');
const LANGS: readonly Lang[] = ['en', 'es'];

// ─── Collecting ─────────────────────────────────────────────────────────────

/**
 * Every string anywhere inside a producer's return value.
 *
 * Deep rather than shallow on purpose: a ClosureButton carries its label, its
 * hint and a nested confirm prompt, and a guard that only read `.label` would
 * have missed the two sentences most likely to be written carelessly. It also
 * means a new string field added to any of these shapes is covered the day it
 * appears, without anyone remembering to come back here.
 */
function collect(value: unknown, label: string, out: Array<[string, string]>): void {
  if (typeof value === 'string') {
    out.push([label, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collect(item, `${label}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) collect(inner, `${label}.${key}`, out);
  }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function finding(over: Partial<QueueFinding> & { id: string }): QueueFinding {
  return {
    detectorId: 'det_a',
    dedupeKey: `det_a:${over.id}`,
    summary: 'Room 214 has had 4 work orders in the last 30 days. 2 are still open.',
    phrasedEn: null,
    phrasedEs: null,
    severity: 'attention',
    disposition: 'recommend',
    status: 'open',
    magnitude: 4,
    price: null,
    evidence: { queryId: 'q', params: {}, values: {}, basis: 'your last 3 plumber invoices' },
    asOf: null,
    weakestInputAgeDays: null,
    firstSeenAt: '2026-07-12T06:00:00.000Z',
    lastSeenAt: '2026-07-28T06:00:00.000Z',
    occurrenceCount: 1,
    ...over,
  };
}

const PRICE = { lowCents: 75_000, highCents: 175_000, currency: 'USD', basis: 'your last 3 invoices' };

/**
 * The matrix. Each row turns on a different branch in the producers below:
 * severity and disposition drive the eyebrow and the closure buttons, a price
 * drives the money sentence, a named subject drives the Spanish floor, a
 * repeat count drives the occurrence line, and a stale input drives the age
 * note. A single fixture would have exercised roughly a third of this copy.
 */
const FINDINGS: QueueFinding[] = [
  finding({ id: 'f_plain' }),
  finding({ id: 'f_critical', severity: 'critical', disposition: 'propose', price: PRICE }),
  finding({ id: 'f_info', severity: 'info', disposition: 'fyi' }),
  finding({
    id: 'f_room',
    evidence: { queryId: 'q', params: { target_kind: 'room', target_value: '204' }, values: {}, basis: 'the work order log' },
    price: PRICE,
  }),
  finding({
    id: 'f_task',
    severity: 'critical',
    evidence: { queryId: 'q', params: { task_name: 'Grease trap service' }, values: {}, basis: 'the upkeep schedule' },
  }),
  finding({ id: 'f_repeat', occurrenceCount: 6, firstSeenAt: '2026-06-01T06:00:00.000Z' }),
  finding({ id: 'f_stale', weakestInputAgeDays: 9, asOf: '2026-07-19T06:00:00.000Z' }),
  // The one that matters most: prose PERSISTED before the ruling, still on
  // screen today. `cardPhrasing` is the seam that has to clean it on read.
  finding({
    id: 'f_stored_dash',
    summary: `Room 231 has had 4 work orders ${EM_DASH} 2 are still open.`,
    phrasedEn: `Attention ${EM_DASH} Room 231 needs a look.`,
    phrasedEs: `Atención ${EM_DASH} la habitación 231 necesita una revisión.`,
  }),
];

const RUNS: Array<QueueRun | null> = [
  null,
  { runAt: '2026-07-28T06:00:00.000Z', detectorsChecked: 34, detectorsSkipped: 3, detectorsFailed: 0 },
  { runAt: '2026-07-28T06:00:00.000Z', detectorsChecked: 1, detectorsSkipped: 1, detectorsFailed: 0 },
  // Four days old: the staleness band, which has its own sentence per language.
  { runAt: '2026-07-24T06:00:00.000Z', detectorsChecked: 20, detectorsSkipped: 0, detectorsFailed: 1 },
  { runAt: '2026-07-27T06:00:00.000Z', detectorsChecked: 12, detectorsSkipped: 0, detectorsFailed: 0 },
];

const SIGN_OFFS: CardSignOff[] = [
  { approverRole: 'vp', approverNames: ['Maria Garcia'], thresholdCents: 100_000, callerMayApprove: false },
  { approverRole: 'finance', approverNames: ['Maria', 'Ana', 'Bo'], thresholdCents: 250_000, callerMayApprove: false },
  { approverRole: 'owner', approverNames: [], thresholdCents: 500_000, callerMayApprove: true },
];

function action(over: Partial<CardAction> = {}): CardAction {
  return {
    id: 'a1',
    kind: 'create_work_order',
    state: 'declined_changed',
    offerEn: 'Create a work order for a full inspection of Room 214?',
    offerEs: '¿Crear una orden de trabajo para una inspección completa de la habitación 214?',
    labelEn: 'Create the work order',
    labelEs: 'Crear la orden de trabajo',
    receiptEn: null,
    receiptEs: null,
    changed: { field: 'open_work_orders', was: 3, now: 1, subject: 'Room 214' },
    failureReason: null,
    ...over,
  };
}

const ACTIONS: CardAction[] = [
  action(),
  action({ changed: { field: 'reorder_at', was: 12, now: 30, subject: 'Bath towels' } }),
  action({ changed: { field: 'item', was: null, now: null, subject: 'Bath towels' } }),
  action({ changed: { field: 'preventive_last_done', was: '2026-01-01', now: '2026-07-01', subject: 'Grease trap' } }),
  // An unrecognised field falls through to the generic sentence, which is the
  // branch nobody edits and therefore the one that rots.
  action({ changed: { field: 'something_new_nobody_mapped', was: 1, now: 2, subject: 'Room 9' } }),
];

// ─── The corpus ─────────────────────────────────────────────────────────────

/** Every string the findings surfaces can produce, over the matrix, per language. */
function everyProducedString(): Array<[string, string]> {
  const out: Array<[string, string]> = [];

  // The fixed copy table this surface renders from. Both languages live in it
  // side by side, so it is collected once rather than per language.
  collect(cardCopy, 'cardCopy', out);

  for (const lang of LANGS) {
    for (const f of FINDINGS) {
      collect(cardPhrasing(f, lang), `${lang}.cardPhrasing(${f.id})`, out);
      collect(cardEyebrowLabel(f, lang), `${lang}.cardEyebrowLabel(${f.id})`, out);
      collect(closureButtons(f, lang), `${lang}.closureButtons(${f.id})`, out);
      collect(occurrenceLine(f, lang, NOW), `${lang}.occurrenceLine(${f.id})`, out);
      collect(dataAgeNote(f, lang), `${lang}.dataAgeNote(${f.id})`, out);
      collect(formatShortDate(f.lastSeenAt, lang, NOW), `${lang}.formatShortDate(${f.id})`, out);
      collect(
        basisInLang(f.evidence.basis, f.evidence.basisEs ?? null, lang),
        `${lang}.basisInLang(${f.id})`,
        out,
      );
      collect(
        spanishTemplateSentence({ severity: f.severity, evidence: f.evidence, price: f.price }),
        `${lang}.spanishTemplateSentence(${f.id})`,
        out,
      );
      collect(templateSubject(f.evidence, lang), `${lang}.templateSubject(${f.id})`, out);
      collect(templatePriceSentence(f.price, lang), `${lang}.templatePriceSentence(${f.id})`, out);
    }

    for (const [i, run] of RUNS.entries()) {
      collect(livenessLine(run, 2, lang, NOW), `${lang}.livenessLine(run${i})`, out);
      collect(skippedNote(run, lang, NOW), `${lang}.skippedNote(run${i})`, out);
    }

    for (const [i, s] of SIGN_OFFS.entries()) {
      collect(signOffNotice(s, lang), `${lang}.signOffNotice(${i})`, out);
    }

    for (const [i, a] of ACTIONS.entries()) {
      collect(declinedExplanation(a, lang), `${lang}.declinedExplanation(${a.changed?.field ?? i})`, out);
    }
  }

  // The judge's deterministic floor writes BOTH languages in one call, so it is
  // walked once rather than per language.
  for (const f of FINDINGS) {
    collect(
      templateJudgment({
        id: f.id,
        detectorId: f.detectorId,
        summary: f.summary,
        severity: f.severity,
        disposition: f.disposition,
        magnitude: f.magnitude,
        evidence: f.evidence,
        price: f.price,
        asOf: f.asOf,
        weakestInputAgeDays: f.weakestInputAgeDays,
        judgedInputHash: null,
      } as Parameters<typeof templateJudgment>[0]),
      `templateJudgment(${f.id})`,
      out,
    );
  }

  return out;
}

// ─── Briefs ─────────────────────────────────────────────────────────────────

function briefInput(over: Partial<BriefInput> = {}): BriefInput {
  return {
    propertyId: 'p1',
    localDate: '2026-07-28',
    run: RUNS[1],
    cards: FINDINGS.filter((f) => f.disposition !== 'fyi'),
    cleared: [finding({ id: 'f_cleared' })],
    windowStart: new Date('2026-07-27T22:00:00.000Z'),
    now: NOW,
    ...over,
  };
}

function portfolioCard(f: QueueFinding, hotel: string | null): PortfolioCard {
  return {
    ...f,
    hotel: hotel ? { propertyId: `pid_${hotel}`, name: hotel } : null,
    climbReason: 'big_dollar',
    daysOpen: 6,
  } as PortfolioCard;
}

function portfolioInput(over: Partial<PortfolioBriefInput> = {}): PortfolioBriefInput {
  return {
    organizationId: 'org1',
    localDate: '2026-07-28',
    hotelCount: 12,
    cards: [
      portfolioCard(FINDINGS[1], 'Lufkin'),
      portfolioCard(FINDINGS[3], 'Comfort Suites Beaumont'),
      // A company-scope card carries no hotel: the no-prefix branch.
      portfolioCard(FINDINGS[7], null),
    ],
    run: { thingsChecked: 384, hotelsChecked: 11, hotelsTotal: 12, lastRunAt: '2026-07-28T06:00:00.000Z' },
    now: NOW,
    busyHotelIds: ['pid_Lufkin'],
    ...over,
  };
}

function briefLines(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [i, input] of [briefInput(), briefInput({ cards: [], cleared: [] }), briefInput({ run: RUNS[3] })].entries()) {
    const brief = buildBrief(input);
    if (brief) brief.lines.forEach((l, j) => out.push([`morningBrief[${i}][${j}]`, l.text]));
  }
  for (const [i, input] of [portfolioInput(), portfolioInput({ cards: [] })].entries()) {
    const brief = buildPortfolioBrief(input);
    if (brief) brief.lines.forEach((l, j) => out.push([`vpBrief[${i}][${j}]`, l.text]));
  }
  return out;
}

// ─── Detector templates ─────────────────────────────────────────────────────

/**
 * Every string the hotel itself supplied to a detector, longest first.
 *
 * THE DISTINCTION THIS DRAWS IS THE WHOLE POINT OF THE DETECTOR ARM. The copy
 * ruling governs the words STAXIS writes. It does not govern what a hotel typed
 * into its own equipment list, and one of the shipped fixtures is an asset
 * genuinely named "PTAC units — rooms 201-240".
 *
 * Passing a hotel's own label through untouched is a deliberate, documented
 * rule (template-phrasing.ts): a name is a name, and rewriting one is how you
 * end up telling somebody about a room that does not exist. So a dash that
 * arrived inside hotel data is not an offence, and a guard that called it one
 * would be pressure to start editing customer data to please a style rule.
 */
function hotelSuppliedStrings(feeds: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.length >= 3) found.push(value);
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(feeds);
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

/** The sentence with every hotel-supplied label removed: Staxis's words only. */
function staxisWordsOnly(text: string, hotelWords: readonly string[]): string {
  let residue = text;
  for (const word of hotelWords) {
    if (word.includes(EM_DASH)) residue = residue.split(word).join(' ');
  }
  return residue;
}

/**
 * The prose every detector writes, from the detector's OWN eval fixtures.
 *
 * This arm exists because the render seam HIDES the problem it looks for.
 * `cardPhrasing` strips a dash out of a stored summary, so a detector template
 * that still contained one would never appear in the card assertions above, and
 * the dash would sit in `findings.summary` forever, feeding everything that
 * reads the column without going through a card.
 *
 * Every detector already ships fixture feeds that make it fire, so this reuses
 * those rather than inventing a second set that would drift away from them.
 *
 * Returns [label, what it said, Staxis's words only].
 */
function detectorProse(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const detector of allDetectors()) {
    const cases = detector.declaration.evalCases;
    runDetectorEvalCases(detector).forEach((result, caseIndex) => {
      const hotelWords = hotelSuppliedStrings(cases[caseIndex]?.feeds);
      for (const draft of result.drafts) {
        const at = `${result.detectorId}/${draft.key}`;
        const fields: Array<[string, string | null | undefined]> = [
          [`${at}.summary`, draft.summary],
          [`${at}.evidence.basis`, draft.evidence?.basis],
          [`${at}.price.basis`, draft.price?.basis],
        ];
        for (const [label, text] of fields) {
          if (typeof text === 'string' && text.length > 0) {
            out.push([label, text, staxisWordsOnly(text, hotelWords)]);
          }
        }
      }
    });
  }
  return out;
}

// ─── The approval card ──────────────────────────────────────────────────────
//
// Same React shim, and the same reasons, as promotion-card-readability.test.ts:
// `npm test` runs under --conditions=react-server where react-dom/server will
// not load, so the hook-free PromotionSummary is called as a plain function and
// the element tree it returns is walked.

const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);
type QueueModule = typeof import('@/app/admin/_components/studio/surfaces/PromotionQueue');
type PromotionView = QueueModule['PromotionSummary'] extends (p: { p: infer V; live?: boolean }) => unknown
  ? V
  : never;

let queue: QueueModule;
let R: typeof import('react');
/** FindingCards' copy table. Imported dynamically for the same reason as the
 *  approval card: its module chain reaches AuthContext, so the shim has to be
 *  in place before it loads. */
let cardCopy: Record<string, unknown> = {};

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
  queue = await import('@/app/admin/_components/studio/surfaces/PromotionQueue');
  cardCopy = (await import('@/components/concourse/FindingCards')).S as unknown as Record<string, unknown>;
});

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function visibleText(node: React.ReactNode, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => visibleText(child, out));
    return out;
  }
  if (R.isValidElement<AnyProps>(node)) {
    if (typeof node.type === 'function') {
      visibleText((node.type as (p: AnyProps) => React.ReactNode)(node.props), out);
    } else {
      visibleText(node.props.children, out);
    }
  }
  return out;
}

function promotionView(over: Partial<PromotionView> = {}): PromotionView {
  return {
    id: 'p1',
    topic: 'base_prompt_pms_context_clause',
    claim: 'A claim.',
    evidenceSummary: 'Because of a thing.',
    proposedContent: 'PMS CONTEXT\n…',
    liveContent: null,
    status: 'pending',
    origin: 'authored',
    headline: "The hotel's own information wins.",
    headlineTruncated: false,
    originLabel: 'WRITTEN BY HAND',
    journey: { from: 'This hotel', to: 'Every hotel' },
    lockReason: 'Two other hotels still have to agree.',
    audience: 'Every hotel',
    cameFrom: 'Written by hand during a build (0338)',
    evidence: 'Written by hand',
    supportingHotels: 0,
    observations: 0,
    isAggregate: false,
    barReason: '',
    blockedReasons: [],
    expired: false,
    daysLeft: null,
    reconfirmCount: 0,
    approvedAt: null,
    decidedAt: null,
    decisionNote: null,
    changesBehaviour: true,
    blastRadius: { count: 12, hotels: [] },
    ...over,
  } as PromotionView;
}

/** The four status branches, which all run through the one StatusLine joiner. */
function approvalCardFaces(): Array<[string, string]> {
  const cases: Array<[string, PromotionView, boolean]> = [
    ['yourCall', promotionView(), false],
    ['locked', promotionView({ blockedReasons: ['Two other hotels still have to agree.'] } as Partial<PromotionView>), false],
    ['live', promotionView({ daysLeft: 3 } as Partial<PromotionView>), true],
    ['needsALook', promotionView({ expired: true } as Partial<PromotionView>), true],
    // A headline STORED before the ruling. Same problem as a finding's summary.
    ['storedDash', promotionView({ headline: `Shared notes lose ${EM_DASH} the hotel's own wins.` } as Partial<PromotionView>), false],
  ];
  return cases.map(([name, p, live]) => [
    `approvalCard.${name}`,
    visibleText(queue.PromotionSummary({ p, live })).join('').replace(/\s+/g, ' ').trim(),
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════

describe('findings copy rules', () => {
  test('the corpus is actually populated', () => {
    // A guard whose walk silently returns nothing passes forever. This is the
    // assertion that makes every test below mean something.
    const corpus = everyProducedString();
    assert.ok(corpus.length > 200, `expected a broad corpus, walked only ${corpus.length} strings`);
    assert.ok(
      corpus.some(([k]) => k.startsWith('es.')) && corpus.some(([k]) => k.startsWith('en.')),
      'both languages must be walked',
    );
    assert.ok(briefLines().length > 5, 'the briefs produced no lines to check');
    assert.ok(approvalCardFaces().every(([, face]) => face.length > 0), 'an approval card rendered blank');
    const prose = detectorProse();
    assert.ok(prose.length > 20, `expected detector prose, walked only ${prose.length} strings`);
    assert.ok(
      new Set(prose.map(([k]) => k.split('/')[0])).size >= 6,
      'too few detectors fired to call this coverage',
    );
  });

  test('no detector writes an em dash into the prose it stores', () => {
    // Held separately from the card assertions because the render seam would
    // mask it: a dash here never reaches a screen, it just sits in the row.
    // Judged on Staxis's own words, so a hotel's own label keeps its dash.
    const offenders = detectorProse()
      .filter(([, , staxisWords]) => staxisWords.includes(EM_DASH))
      .map(([key, said]) => `${key}: ${said}`);
    assert.deepEqual(
      offenders,
      [],
      `Detector templates writing an em dash into stored prose:\n${offenders.join('\n')}`,
    );
  });

  test('a hotel\'s own label keeps its punctuation, dash and all', () => {
    // The counterweight to the test above. One shipped fixture names an asset
    // "PTAC units — rooms 201-240", and the detector must quote that name
    // exactly. If this ever starts failing because the dash is gone, something
    // has begun rewriting customer data to satisfy a style rule.
    const quoted = detectorProse().filter(([, said]) => said.includes(`PTAC units ${EM_DASH} rooms 201-240`));
    assert.ok(quoted.length > 0, 'the hotel-named-asset fixture no longer reaches any prose');
    for (const [key, , staxisWords] of quoted) {
      assert.ok(!staxisWords.includes(EM_DASH), `${key}: a dash survived outside the hotel's own label`);
    }
  });

  test('no user-facing string contains an em dash, in either language', () => {
    const offenders = everyProducedString()
      .filter(([, value]) => value.includes(EM_DASH))
      .map(([key, value]) => `${key}: ${value}`);
    assert.deepEqual(
      offenders,
      [],
      'Em dashes are not used in Staxis copy. Use a full stop, a comma or a new line.\n'
      + offenders.join('\n'),
    );
  });

  test('neither brief carries an em dash', () => {
    const offenders = briefLines()
      .filter(([, value]) => value.includes(EM_DASH))
      .map(([key, value]) => `${key}: ${value}`);
    assert.deepEqual(offenders, [], `Brief lines with an em dash:\n${offenders.join('\n')}`);
  });

  test('the shared-knowledge approval card carries no em dash in any status', () => {
    const offenders = approvalCardFaces()
      .filter(([, face]) => face.includes(EM_DASH))
      .map(([key, face]) => `${key}: ${face}`);
    assert.deepEqual(offenders, [], `Approval card faces with an em dash:\n${offenders.join('\n')}`);
  });

  test('no user-facing string uses filler or marketing words', () => {
    // Same list the ordering block bans. Each makes a sentence longer without
    // making it truer, and "just"/"simply" quietly tell a manager that whatever
    // went wrong was easy.
    const BANNED = /\b(simply|seamless(ly)?|effortless(ly)?|powerful|robust|leverage|unlock|delight(ful)?|revolutionary|cutting[- ]edge|best[- ]in[- ]class)\b/i;
    const offenders = [...everyProducedString(), ...briefLines()]
      .filter(([, value]) => BANNED.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    assert.deepEqual(offenders, [], `Filler or marketing words found:\n${offenders.join('\n')}`);
  });

  // ─── The render seam ──────────────────────────────────────────────────────
  //
  // Findings prose is PERSISTED: `summary` at detection time, `judged_summary_*`
  // by the judge. Cleaning the templates only helps rows written from now on, so
  // these hold the read-side strip that makes old rows render correctly.

  test('prose stored with an em dash is cleaned on the way to a card', () => {
    const stored = FINDINGS.find((f) => f.id === 'f_stored_dash');
    assert.ok(stored, 'fixture missing');
    for (const lang of LANGS) {
      const shown = cardPhrasing(stored, lang);
      assert.ok(!shown.includes(EM_DASH), `${lang}: a stored dash reached the card: ${shown}`);
      assert.ok(shown.length > 0, `${lang}: cleaning emptied the sentence`);
    }
    // And the English fallback path, where `summary` is used directly.
    const noJudgement = finding({ id: 'x', summary: `Room 9 is late ${EM_DASH} nobody has been.` });
    assert.ok(!cardPhrasing(noJudgement, 'en').includes(EM_DASH));
  });

  test('withoutEmDash makes whole sentences, not fragments', () => {
    assert.equal(
      withoutEmDash(`Room 231 has had 4 work orders ${EM_DASH} 2 are still open.`),
      'Room 231 has had 4 work orders. 2 are still open.',
    );
    // Capitalises what follows, so the result reads as a sentence.
    assert.equal(
      withoutEmDash(`Last checked 1 day ago ${EM_DASH} this may not be up to date.`),
      'Last checked 1 day ago. This may not be up to date.',
    );
    // Does not stack a second stop onto a clause that already closed itself.
    assert.equal(withoutEmDash(`Room 231: ${EM_DASH} 4 work orders`), 'Room 231: 4 work orders');
    // Accented Spanish capitalises correctly rather than being dropped.
    assert.equal(
      withoutEmDash(`Atención ${EM_DASH} única revisión pendiente.`),
      'Atención. Única revisión pendiente.',
    );
    // A trailing dash carried no information and leaves nothing behind.
    assert.equal(withoutEmDash(`Room 231 is late ${EM_DASH}`), 'Room 231 is late');
    // Text with no dash is returned untouched, including its own punctuation.
    assert.equal(withoutEmDash('Room 231 is late. 2 open.'), 'Room 231 is late. 2 open.');
  });

  test('the Spanish floor names its subject in Spanish and stays plain', () => {
    const withSubject = spanishTemplateSentence({
      severity: 'attention',
      evidence: { params: { target_kind: 'room', target_value: '204' } },
      price: null,
    });
    assert.match(withSubject, /^Atención: Habitación 204\./, `got: ${withSubject}`);
    assert.ok(!withSubject.includes(EM_DASH));

    const withoutSubject = spanishTemplateSentence({ severity: 'critical', evidence: null, price: null });
    assert.match(withoutSubject, /^Crítico: /, `got: ${withoutSubject}`);
    assert.ok(!withoutSubject.includes(EM_DASH));
  });
});
