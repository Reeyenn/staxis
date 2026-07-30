/**
 * Which section toggle a commsContext call is gated on.
 *
 * Why this matters in product terms: the /api/knowledge/* routes serve the
 * hotel's SOPs, uploaded documents, folders and its contact directory —
 * including the emergency numbers the front desk taps under pressure. Those
 * used to be gated on the Communications section because that is where their
 * only screen lived. They now also render on the Staxis/Knows tab, so a hotel
 * that switched Communications off would have silently lost all of it from a
 * screen that was still visible and still claimed to work.
 *
 * The bug this guards is not "someone deletes the opt-out" — that is loud. It
 * is someone tidying the resolver into `opts?.sectionGate ?? 'communications'`,
 * which is idiomatic, type-checks, builds clean, and quietly re-gates every
 * knowledge route because `??` treats an explicit null as nullish. That is a
 * data blackout for a paying hotel introduced by a refactor that looks correct.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
  resolveSectionGate,
  KNOWLEDGE_CTX,
  ONE_LIST_CTX,
  type CommsContextOptions,
} from '@/lib/comms/route-helpers';

describe('resolveSectionGate — which section a comms-context call is gated on', () => {
  test('no options at all gates on communications', () => {
    // The messaging routes take this path. Their UI lives in Communications
    // (Messages) and should disappear with it.
    assert.equal(resolveSectionGate(undefined), 'communications');
  });

  test('an empty options object still gates on communications', () => {
    // Passing {} must not be read as "opt out" — a caller that wants no gate
    // has to say so explicitly.
    assert.equal(resolveSectionGate({}), 'communications');
  });

  test('an explicit null means do not gate at all', () => {
    // THE load-bearing case. `?? 'communications'` returns 'communications'
    // here and the test goes red — which is the entire point of this file.
    assert.equal(resolveSectionGate({ sectionGate: null }), null);
  });

  test('KNOWLEDGE_CTX resolves to no gate', () => {
    // The shared constant the six /api/knowledge/* routes pass. If this ever
    // resolves to a section, the hotel's documents and emergency contacts go
    // dark whenever that section is switched off.
    assert.equal(resolveSectionGate(KNOWLEDGE_CTX), null);
  });

  test('an explicit section is honored, so the gate stays reusable', () => {
    // Nothing passes a non-default section today, but the option exists so a
    // future surface can gate on its own section rather than opting out.
    const opts: CommsContextOptions = { sectionGate: 'staxis' };
    assert.equal(resolveSectionGate(opts), 'staxis');
  });

  test('KNOWLEDGE_CTX is not accidentally shared mutable state', () => {
    // It is a module-level object handed to 20 call sites. If anything ever
    // mutated it, every knowledge route would change behavior at once.
    assert.deepEqual(KNOWLEDGE_CTX, { sectionGate: null });
  });

  test('ONE_LIST_CTX resolves to no gate', () => {
    // Same precedent, one section later (2026-07-30). The to-do list and the
    // log book MOVED to the Staxis tab. Left on the default they would keep
    // dying with a Communications section they are no longer part of: a hotel
    // that switched off a messaging tab would lose its whole to-do list and its
    // shift log from a screen that was still on the nav and still loading.
    assert.equal(resolveSectionGate(ONE_LIST_CTX), null);
    assert.deepEqual(ONE_LIST_CTX, { sectionGate: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CORD IS ACTUALLY CUT
//
// A source-text assertion, deliberately, and it is the exception the house rule
// allows: "this route is not gated on that section" is a NO-RUNTIME invariant.
// Proving it by behaviour would mean standing up a session, a hotel with the
// section off, and a database — for a claim that is really about one argument
// at one call site. The resolver above is where the logic is tested; this is
// where the WIRING is, because the wiring is what regressed twice before.
// ─────────────────────────────────────────────────────────────────────────────

const UNGATED_ROUTES = [
  'src/app/api/worklist/route.ts',
  'src/app/api/worklist/complete/route.ts',
  'src/app/api/worklist/assign/route.ts',
  'src/app/api/comms/tasks/route.ts',
  'src/app/api/comms/logbook/route.ts',
  'src/app/api/comms/logbook/replies/route.ts',
  'src/app/api/feed/prefs/route.ts',
] as const;

describe('the Staxis list keeps working when Communications is switched off', () => {
  for (const file of UNGATED_ROUTES) {
    test(`${file} opts out of the section gate`, () => {
      const src = readFileSync(file, 'utf8');
      const contextCalls = src.match(/commsContext\(/g) ?? [];
      const optedOut = src.match(/ONE_LIST_CTX/g) ?? [];
      assert.ok(contextCalls.length > 0, 'expected this route to resolve a comms context');
      // One opt-out per call site, plus the import.
      assert.ok(
        optedOut.length >= contextCalls.length + 1,
        `every commsContext call in ${file} must pass ONE_LIST_CTX`,
      );
      assert.ok(
        !/requireSectionEnabled\([^)]*'communications'/.test(src),
        `${file} must not re-gate on communications inside the handler`,
      );
    });
  }

  test('the recurring spawner no longer stops on a Communications toggle', () => {
    // A skipped local day never comes back: the spawner runs once per property
    // per day, so a section toggle used to cancel that day's standing work
    // permanently rather than pausing it.
    const src = readFileSync('src/lib/recurring-tasks/store.ts', 'utf8');
    assert.ok(!src.includes('isSectionEnabledForProperty'), 'the section check must be gone');
  });
});
