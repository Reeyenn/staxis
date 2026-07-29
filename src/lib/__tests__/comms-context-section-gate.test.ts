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

import {
  resolveSectionGate,
  KNOWLEDGE_CTX,
  type CommsContextOptions,
} from '@/lib/comms/route-helpers';

describe('resolveSectionGate — which section a comms-context call is gated on', () => {
  test('no options at all gates on communications', () => {
    // Every /api/comms/* and /api/worklist/* route takes this path. Their UI
    // lives in Communications and should disappear with it.
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
});
