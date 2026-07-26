/**
 * Three small decisions on the Staxis shell that a regression review caught
 * being made wrongly. Each is exercised directly rather than through a
 * renderer: the suite runs under `--conditions=react-server`, where
 * react-dom/server refuses to load, so the house pattern is a pure function or
 * a hook-free component whose element tree can be walked.
 *
 *   1. WHO ASKS FOR THE DECISIONS BADGE. The pill bar renders for every
 *      signed-in person and /api/findings/badge is manager-only, so a
 *      housekeeper's shell produced a 403 on every mount, tab refocus and
 *      navigation off the feed. QueueView states the invariant this breaks:
 *      "a 403 in the logs always means something real."
 *
 *   2. WHAT AN UNCHECKED HOTEL'S QUEUE SAYS. It said nothing at all — a title
 *      over blank space, which reads as an all-clear on a hotel nobody has
 *      looked at.
 *
 *   3. WHAT LANGUAGE THE RECEIPT'S FALLBACK LINE IS IN. A finding with no
 *      numbered rows falls back to its basis sentence, and that fallback read
 *      the English field directly — printing English into a Spanish receipt
 *      for exactly the findings that have nothing else to show.
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type React from 'react';

import { shouldReadDecisionBadge } from '@/components/concourse/queue-count';
import type { QueueFinding } from '@/components/concourse/finding-cards';
import type { AppRole } from '@/lib/roles';

// ── Why the React shim ──────────────────────────────────────────────────────
// `npm test` runs this directory under `--conditions=react-server`, and React
// 19's react-server build exports no createContext. FindingCards imports
// AuthContext / PropertyContext at module load, so a plain top-level import
// throws before any test runs. Nothing here mounts a hooks-using component —
// only the exported pure decision and the hook-free `Receipt` are called — so
// a stub context is enough to get the module loaded. Installed on the LIVE
// `react` module object (not an esbuild namespace copy), hence createRequire.
// Same shim, same reasons, as knows-banner-language.test.ts.
//
// The badge gate is imported normally: it lives in queue-count.ts, which is
// where the pill's pure decisions live precisely so they load without a
// browser. ConcourseBar itself cannot be imported here at all — something in
// its tree pulls a stylesheet through the CJS loader.
const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);

type CardsModule = typeof import('@/components/concourse/FindingCards');

let cards: CardsModule;
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
  cards = await import('@/components/concourse/FindingCards');
});

const HOTEL = 'aaaaaaaa-0000-4000-8000-000000000001';

// ─── 1. the badge fetch gate ────────────────────────────────────────────────

describe('who the shell asks for a decisions count', () => {
  const managers: AppRole[] = ['admin', 'owner', 'general_manager'];
  const staff: AppRole[] = ['front_desk', 'housekeeping', 'maintenance'];

  test('a manager standing in a hotel asks', () => {
    for (const role of managers) {
      assert.equal(shouldReadDecisionBadge({ role }, HOTEL), true, role);
    }
  });

  test('somebody who would be REFUSED the count never asks for it', () => {
    // This is the whole fix: the route answers 403 for these roles, so asking
    // produces a refusal with nothing wrong behind it, over and over.
    for (const role of staff) {
      assert.equal(shouldReadDecisionBadge({ role }, HOTEL), false, role);
    }
  });

  test('signed out, or standing in no hotel, nobody asks', () => {
    assert.equal(shouldReadDecisionBadge(null, HOTEL), false);
    assert.equal(shouldReadDecisionBadge(undefined, HOTEL), false);
    assert.equal(shouldReadDecisionBadge({ role: 'general_manager' }, null), false);
  });
});

// ─── 2. the never-checked queue ─────────────────────────────────────────────

describe('what the queue says when it has nothing at all', () => {
  const blank = { readFailed: false, livenessText: '', visibleCount: 0 };

  test('a hotel nobody has checked gets the caller\'s honest sentence, not silence', () => {
    const out = cards.blankQueueOutcome({ ...blank, emptyNote: 'Staxis has not started checking yet.' });
    assert.equal(out.kind, 'note');
    assert.equal(out.kind === 'note' && out.note, 'Staxis has not started checking yet.');
  });

  test('a caller that writes its own empty copy still gets silence', () => {
    // The portfolio queue distinguishes "we looked and nothing reached you"
    // from "nothing has been checked" itself, and two sentences saying nearly
    // the same thing under each other reads as a bug.
    assert.equal(cards.blankQueueOutcome(blank).kind, 'silent');
    assert.equal(cards.blankQueueOutcome({ ...blank, emptyNote: '   ' }).kind, 'silent');
  });

  test('having cards, or a run to describe, is not blank', () => {
    assert.equal(cards.blankQueueOutcome({ ...blank, visibleCount: 1, emptyNote: 'x' }).kind, 'cards');
    assert.equal(
      cards.blankQueueOutcome({ ...blank, livenessText: 'Checked 34 things last night', emptyNote: 'x' }).kind,
      'cards',
    );
  });

  test('a FAILED read is never dressed as an unchecked hotel', () => {
    // The error note owns that screen. "Nothing has been checked here" over a
    // read that fell over is a claim we have not earned.
    assert.equal(cards.blankQueueOutcome({ ...blank, readFailed: true, emptyNote: 'x' }).kind, 'cards');
  });
});

// ─── 3. the receipt's fallback line ─────────────────────────────────────────

type ElementProps = Record<string, unknown> & { children?: React.ReactNode };

/** Every string anywhere in an element tree. */
function textOf(node: React.ReactNode, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => textOf(child, out));
    return out;
  }
  if (R.isValidElement<ElementProps>(node)) textOf(node.props.children, out);
  return out;
}

function findingWith(evidence: QueueFinding['evidence']): QueueFinding {
  return {
    id: 'f1',
    detectorId: 'preventive_due',
    dedupeKey: 'preventive_due:task:1',
    summary: 'something',
    phrasedEn: null,
    phrasedEs: null,
    severity: 'attention',
    disposition: 'recommend',
    status: 'open',
    magnitude: 1,
    price: null,
    evidence,
    asOf: null,
    weakestInputAgeDays: 0,
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    lastSeenAt: '2026-07-25T00:00:00.000Z',
    occurrenceCount: 1,
    action: null,
  } as QueueFinding;
}

describe('a receipt with no numbered rows', () => {
  const bilingual = {
    queryId: 'preventive_tasks_due',
    params: {},
    values: {},
    basis: 'Water heater flush was last done 210 days ago',
    basisEs: 'Vaciado del calentador: se hizo por última vez hace 210 días',
  };

  test('falls back to the basis line in the reader\'s language', () => {
    const es = textOf(cards.Receipt({ finding: findingWith(bilingual), lang: 'es' }));
    assert.ok(es.some((t) => t.includes('se hizo por última vez')));
    assert.ok(!es.some((t) => t.includes('was last done')));
  });

  test('an English reader still gets the English one', () => {
    const en = textOf(cards.Receipt({ finding: findingWith(bilingual), lang: 'en' }));
    assert.ok(en.some((t) => t.includes('was last done')));
  });

  test('with no Spanish written, English is shown rather than nothing', () => {
    // A missing translation must cost the language, never the receipt.
    const es = textOf(
      cards.Receipt({ finding: findingWith({ ...bilingual, basisEs: null }), lang: 'es' }),
    );
    assert.ok(es.some((t) => t.includes('was last done')));
  });

  test('when there ARE numbered rows the basis line is not the fallback', () => {
    const withRows = textOf(
      cards.Receipt({
        finding: findingWith({ ...bilingual, values: { days_overdue: 25 } }),
        lang: 'es',
      }),
    );
    assert.ok(withRows.some((t) => t.includes('days overdue')));
    assert.ok(!withRows.some((t) => t.includes('se hizo por última vez')));
  });
});
