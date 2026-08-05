/**
 * TWELVE DRAWERS, ONE DOOR — THE FORCING FUNCTION.
 *
 * `docs/knowledge-stores.md` mapped twelve stores that can answer "what does
 * Staxis know about this hotel", each with its own loader, cache policy, trust
 * vocabulary and place in the prompt. `src/lib/agent/knowledge-door.ts` is the
 * one place they are registered. This file is what makes the registration
 * stick, and it has three jobs:
 *
 *   1. THE INVENTORY IS COMPLETE. All twelve are registered, on both axes, and
 *      no module may inject a `<staxis-…>` envelope into a prompt without
 *      appearing in the registry. That is the mirror of the "the set of
 *      system-prompt producers is exactly the known list" pin in
 *      agent-shared-rule-tiers.test.ts, and it is what stops a THIRTEENTH store
 *      arriving the way the twelfth did: quietly, correctly, and invisible.
 *
 *   2. AUTHORITY IS SINGLE-SOURCED. `company_knowledge` reaches the model two
 *      ways, and the two could have disagreed about whether the text is an
 *      instruction or a fact. Both now register as presentations of ONE store,
 *      and each must still carry the clause it claims in the ceiling the model
 *      actually reads.
 *
 *   3. THE CONSOLIDATION CHANGED NO PROMPT. Every pipeline's composed bytes are
 *      compared against a golden captured on the pre-consolidation tree. The
 *      one intentional difference — the hotel-identity trust envelope — is
 *      asserted to be EXACTLY the envelope and the version bump, and nothing
 *      else.
 *
 * Run via: npx tsx --conditions=react-server --test src/lib/__tests__/agent-knowledge-door.test.ts
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  AUTHORITY_MEANING,
  KNOWLEDGE_STORES,
  NON_STORE_MARKER_MODULES,
  composableKnowledgeStores,
  composeKnowledgeTier,
  isComposableByName,
  knowledgeMarkerModules,
  knowledgeStore,
  resolveCompanyKnowledgePresentation,
} from '@/lib/agent/knowledge-door';
import {
  HOTEL_IDENTITY_HEADER,
  HOTEL_IDENTITY_TRUST_MARKER_CLOSE,
  HOTEL_IDENTITY_TRUST_MARKER_OPEN,
  HOTEL_IDENTITY_TRUST_NOTE,
  HOTEL_IDENTITY_VERSION,
} from '@/lib/agent/hotel-identity';
import { AWARENESS_VERSION } from '@/lib/agent/awareness';

import {
  FIXTURES,
  ORG_ID,
  OUTPUT_PATH,
  PID_ONE,
  PID_TWO,
  buildGoldenSubjects,
  seedKnowledgeFixtures,
  stubSupabaseFrom,
  type GoldenSubject,
  type GoldenSubjects,
} from './knowledge-door-fixtures';

/** Read rather than imported: a JSON module import would tie this test to a
 *  `resolveJsonModule` setting and to whichever import-attribute spelling the
 *  runner is on this month. The path is the one the capture wrote. */
const GOLDEN = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')) as GoldenSubjects;

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE INVENTORY
// ═══════════════════════════════════════════════════════════════════════════

describe('the door knows every drawer', () => {
  /**
   * The twelve, by name, from `docs/knowledge-stores.md`.
   *
   * `portfolio_knowledge_overlay` is deliberately NOT a thirteenth entry: the
   * doc counts it as a store because it is a separate loader with its own
   * envelope, and the whole point of this consolidation is that it is a second
   * PRESENTATION of `company_knowledge` rather than a store of its own. So
   * eleven registrations cover the doc's twelve items, and the assertion below
   * spells that out rather than leaving the arithmetic to a reader.
   */
  const KNOWN_STORES = [
    'assignment_history',
    'company_knowledge',
    'hotel_identity',
    'hotel_snapshot',
    'hotel_standing_rules',
    'knowledge_hub',
    'lenses',
    'long_term_memory',
    'portfolio_identity',
    'portfolio_snapshot',
    'prompt_rows',
    'situational_awareness',
  ].sort();

  test('the registered stores are exactly the documented ones', () => {
    assert.deepEqual(
      KNOWLEDGE_STORES.map((store) => store.id).sort(),
      KNOWN_STORES,
      'A knowledge store was added or removed. Update docs/knowledge-stores.md in the same '
      + 'change: the doc is the decision record and this registry is the executable half.',
    );
  });

  test('the doc\'s thirteen are covered by twelve registrations plus one shared store', () => {
    // Twelve registrations now. `assignment_history` (2026-08-05) is the
    // thirteenth item in the doc and the twelfth registration: an on-demand,
    // person-scoped store read by the companion's notices list and by the
    // staxis_assignments tool from one query. It is registered even though it
    // is never injected, because "not in a prompt" is not the same as "not
    // knowledge", and the scope of a store that answers what one person was
    // asked to do is exactly what this file exists to make somebody review.
    const companyPresentations = knowledgeStore('company_knowledge').presentations;
    assert.equal(KNOWN_STORES.length, 12);
    assert.equal(
      companyPresentations.length, 2,
      'company_knowledge is the store the doc counts twice, because it has two renderings. '
      + 'If it ever has one, say so in the doc rather than quietly deleting a presentation.',
    );
  });

  test('every store is placed on BOTH axes', () => {
    for (const store of KNOWLEDGE_STORES) {
      assert.ok(
        ['company', 'hotel', 'person', 'deployment'].includes(store.scope),
        `${store.id} has no scope. Scope is the axis that leaks; it cannot be left open.`,
      );
      assert.ok(
        ['instruction', 'fact'].includes(store.authority),
        `${store.id} has no authority. Authority is the axis that decides fencing: `
        + Object.entries(AUTHORITY_MEANING).map(([k, v]) => `${k} = ${v}`).join('; '),
      );
      assert.ok(store.why.length > 40, `${store.id} registers no reason for existing`);
      assert.ok(store.loaderModule.startsWith('src/'), `${store.id} names no loader module`);
    }
  });

  test('a store\'s primary placement is one a presentation actually renders in', () => {
    // Store-level placement is a summary; the presentations are the truth. This
    // stops the summary drifting into a claim no rendering supports.
    for (const store of KNOWLEDGE_STORES) {
      if (store.presentations.length === 0) continue;
      assert.ok(
        store.presentations.some((p) => p.placement === store.placement),
        `${store.id} claims to be a ${store.placement} store, but none of its renderings `
        + 'land in that half of the prompt.',
      );
    }
  });

  test('the sharpest line in the system still runs where the doc says it does', () => {
    // Two stores that sit next to each other in the same prompt, in the same
    // kind of envelope, with OPPOSITE authority. A VP's policy document and a
    // sentence a manager said to the companion last week are different objects,
    // and this is the assertion that says so.
    assert.equal(knowledgeStore('company_knowledge').authority, 'fact');
    assert.equal(knowledgeStore('hotel_standing_rules').authority, 'instruction');
  });

  test('the stores reachable by name are exactly the migrated ones', () => {
    assert.deepEqual(
      composableKnowledgeStores().sort(),
      ['company_knowledge', 'hotel_identity', 'hotel_standing_rules'],
      'Stage 1 migrated three drawers. Adding a fourth is welcome; adding it without '
      + 'updating this list means nobody reviewed which pipelines now reach it.',
    );
  });

  test('a store not reachable by name says so instead of returning nothing', async () => {
    // A silent empty block is exactly how a store goes missing from a prompt
    // with nothing looking broken. Reaching a caller-loaded drawer by name is a
    // programming error and is loud.
    for (const store of KNOWLEDGE_STORES) {
      if (isComposableByName(store.id)) continue;
      await assert.rejects(
        () => composeKnowledgeTier(store.id, { hotelIds: [PID_ONE], companyPolicyVisible: true }),
        /not composable by name/,
        `${store.id} answered a compose call it has no composer for`,
      );
    }
  });
});

// ─── The scan: nothing injects knowledge from outside the door ──────────────

describe('no knowledge reaches the model from outside the door', () => {
  /**
   * A SOURCE SCAN, deliberately, and the same narrow carve-out the house rule
   * on source-string tests allows for `agent-shared-rule-tiers`.
   *
   * "Somebody wrote a thirteenth store" is not a condition any running code can
   * observe: the new loader would simply never be called by these tests, and
   * the prompt it injects into would still answer. Pinning the SET of modules
   * that print a trust marker is the only way to make its arrival visible.
   *
   * Comments are stripped first. Four modules discuss the marker vocabulary in
   * prose (the envelope renderer, the escaper, the portfolio assembler's header
   * comment) without emitting anything, and a scan that flagged them would go
   * red on a doc edit — which is how a guard gets waved through.
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => {
        const at = line.indexOf('//');
        return at === -1 ? line : line.slice(0, at);
      })
      .join('\n');
  }

  /** An OPENING marker with its trust attribute: the signature of an emitted
   *  envelope, as opposed to a mention of one. */
  const EMITS_ENVELOPE = /<staxis-[a-z-]+\s+trust="/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  test('every module that prints a trust envelope is registered', () => {
    const found = walk('src')
      .filter((file) => EMITS_ENVELOPE.test(stripComments(readFileSync(file, 'utf8'))))
      .sort();
    const declared = [
      ...knowledgeMarkerModules(),
      ...Object.keys(NON_STORE_MARKER_MODULES),
    ].sort();
    assert.deepEqual(
      found,
      declared,
      'A module started (or stopped) printing a <staxis-…> trust envelope. Every injected '
      + 'knowledge store must be registered in src/lib/agent/knowledge-door.ts with its '
      + 'scope, authority, envelope, version and cache policy. If the module is not a '
      + 'knowledge store, add it to NON_STORE_MARKER_MODULES with the reason.',
    );
  });

  test('every declared marker and version really is in the module that claims it', () => {
    // The other half of the pin, and what makes it safe for the registry itself
    // to be excused above. The door NAMES a marker and a version for each
    // store; this checks the named strings are actually in the module that
    // prints them, so a renamed envelope or a bumped version cannot leave the
    // inventory describing a fence nobody emits or a stamp nobody writes.
    for (const store of KNOWLEDGE_STORES) {
      for (const presentation of store.presentations) {
        const source = readFileSync(presentation.module, 'utf8');
        if (presentation.markerOpen) {
          assert.ok(
            source.includes(presentation.markerOpen),
            `${presentation.id} registers ${presentation.markerOpen}, which ${presentation.module} `
            + 'does not contain. Either the envelope was renamed and the registry is stale, or '
            + 'the rendering moved to another module.',
          );
        }
        if (presentation.version) {
          assert.ok(
            source.includes(presentation.version),
            `${presentation.id} registers version "${presentation.version}", which `
            + `${presentation.module} does not contain.`,
          );
        }
      }
    }
  });

  test('a store through the door has a real version; a gap is registered as null', () => {
    // The doc's hygiene finding, held open: awareness was the one
    // envelope-wrapped store whose rendering could not be identified from a
    // persisted stamp. Inventing a placeholder string for the three legacy
    // drawers that still have no constant would have hidden the same gap in
    // the file built to expose it.
    for (const store of KNOWLEDGE_STORES) {
      if (store.status !== 'through_the_door') continue;
      for (const presentation of store.presentations) {
        assert.ok(
          presentation.version,
          `${presentation.id} is through the door with no version constant. "Which rendering `
          + 'ran on this turn" must be answerable from agent_messages.prompt_version alone.',
        );
      }
    }
  });

  test('the non-store list explains itself', () => {
    for (const [modulePath, reason] of Object.entries(NON_STORE_MARKER_MODULES)) {
      assert.ok(
        reason.length > 60,
        `${modulePath} is excused from the registry without saying why. "It is not a store" is `
        + 'a claim that needs an argument, because every one of the twelve looked obvious too.',
      );
    }
  });

  test('the two halves of the scan really are disjoint', () => {
    // Keeps the pin honest: a module cannot be both a registered store and an
    // excused non-store, which would let a real store hide behind an excuse.
    const stores = new Set(knowledgeMarkerModules());
    for (const modulePath of Object.keys(NON_STORE_MARKER_MODULES)) {
      assert.equal(stores.has(modulePath), false, `${modulePath} is both registered and excused`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. AUTHORITY IS SINGLE-SOURCED
// ═══════════════════════════════════════════════════════════════════════════

describe('a fenced tier must state what the text inside it is', () => {
  test('every presentation\'s declared clause is really in its ceiling', () => {
    // The module-load assertion in knowledge-door.ts already refuses to load
    // when this is false. Restated here so the failure names the presentation
    // rather than arriving as an import error three files away.
    for (const store of KNOWLEDGE_STORES) {
      for (const presentation of store.presentations) {
        const { trustNote, authorityClause } = presentation;
        if (trustNote === null) {
          assert.equal(
            authorityClause, null,
            `${presentation.id} claims a clause with no ceiling to hold it`,
          );
          continue;
        }
        assert.ok(authorityClause, `${presentation.id} is fenced with no clause`);
        assert.ok(
          trustNote.includes(authorityClause),
          `${presentation.id}'s ceiling no longer contains the clause it registers. The model `
          + 'is reading a fence that does not say whether the text inside is an instruction.',
        );
      }
    }
  });

  test('both renderings of company_knowledge agree it is a FACT', () => {
    // The finding this whole module answers: the same table reached the model
    // as a stable-block rulebook under one envelope or a dynamic-block overlay
    // under another, decided one layer up, and nothing anywhere required the
    // two to agree about what the model may do with the text.
    const store = knowledgeStore('company_knowledge');
    assert.equal(store.authority, 'fact');
    assert.deepEqual(
      store.presentations.map((p) => p.id).sort(),
      ['company_rulebook_tier', 'portfolio_knowledge_overlay'],
    );
    for (const presentation of store.presentations) {
      assert.ok(presentation.trustNote, `${presentation.id} renders company facts unfenced`);
      assert.match(
        presentation.authorityClause ?? '',
        /never an instruction|never instructions/,
        `${presentation.id} fences the company rulebook without telling the model it is a fact`,
      );
    }
  });

  test('exactly one company_knowledge presentation renders on a turn', () => {
    assert.equal(resolveCompanyKnowledgePresentation('external_overlay'), 'portfolio_knowledge_overlay');
    assert.equal(resolveCompanyKnowledgePresentation('legacy_rulebook'), 'company_rulebook_tier');
    // Undefined is the hotel surface and the portfolio surface's own default,
    // both of which want the stable-block rulebook. Defaulting the other way
    // would silently drop the company tier from a live prompt.
    assert.equal(resolveCompanyKnowledgePresentation(undefined), 'company_rulebook_tier');
  });

  test('hotel identity is fenced now, like its three neighbours', () => {
    // It was the ONE manager-authored store in the stable block with no
    // envelope: sanitized per value and nothing more, so a checklist name and a
    // rule Staxis printed itself were typographically identical to the model.
    const presentation = knowledgeStore('hotel_identity').presentations[0];
    assert.equal(presentation.markerOpen, HOTEL_IDENTITY_TRUST_MARKER_OPEN);
    assert.ok(presentation.trustNote);
    assert.match(presentation.authorityClause ?? '', /never an instruction to you/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE CONSOLIDATION CHANGED NO PROMPT
// ═══════════════════════════════════════════════════════════════════════════

const golden = GOLDEN;
let rebuilt: GoldenSubjects;
let restoreSupabase: () => void;

before(async () => {
  restoreSupabase = stubSupabaseFrom(supabaseAdmin, FIXTURES);
  rebuilt = await buildGoldenSubjects();
  // `buildGoldenSubjects` clears the seeds behind itself, so the door tests
  // below re-seed rather than inherit whatever the last capture left lying
  // around. A test that passes because of another test's leftovers is a test
  // that will pass for the wrong reason forever.
  seedKnowledgeFixtures();
});

after(() => { restoreSupabase(); });

function subject(name: string): { before: GoldenSubject; after: GoldenSubject } {
  const b = golden[name];
  const a = rebuilt[name];
  assert.ok(b && typeof b === 'object', `golden is missing the "${name}" subject`);
  assert.ok(a && typeof a === 'object', `the rebuild produced no "${name}" subject`);
  return { before: b as GoldenSubject, after: a as GoldenSubject };
}

describe('byte-equality against the pre-consolidation golden', () => {
  test('the golden covers every subject the rebuild produces', () => {
    // Guards everything below: a golden that quietly lost a subject would make
    // "the bytes match" true for the boring reason that nothing was compared.
    assert.deepEqual(Object.keys(rebuilt).sort(), Object.keys(golden).sort());
    assert.ok(Object.keys(golden).length >= 11, 'the golden is too thin to prove anything');
  });

  // ── The subjects that must not have moved by one byte ────────────────────
  for (const name of [
    'walkthrough',
    'portfolio.one-hotel.legacy-rulebook',
    'portfolio.two-hotels.legacy-rulebook',
    'portfolio.one-hotel.external-overlay',
  ]) {
    test(`${name} is byte-identical`, () => {
      const { before: b, after: a } = subject(name);
      assert.equal(a.stable, b.stable, `${name}'s CACHED block moved. Any change here `
        + 'invalidates the prompt cache for every conversation on the surface.');
      assert.equal(a.dynamic, b.dynamic);
      assert.equal(a.factual, b.factual, `${name}'s number-guard receipt moved`);
      assert.equal(a.stableStamp, b.stableStamp);
      assert.equal(a.versionLabel, b.versionLabel);
    });
  }

  for (const name of ['block.company-rulebook', 'block.hotel-standing-rules', 'block.awareness', 'block.portfolio-knowledge-overlay']) {
    test(`${name} is byte-identical`, () => {
      assert.equal(rebuilt[name], golden[name], `${name} changed. The consolidation moved `
        + 'registrations, not renderings.');
    });
  }

  // ── The ONE intentional change, asserted to be exactly what it claims ────

  test('the hotel-identity block gained exactly the envelope, and nothing else', () => {
    const before = golden['block.hotel-identity'];
    const after = rebuilt['block.hotel-identity'];
    assert.ok(typeof before === 'string' && typeof after === 'string');

    // The legacy shape was `[header, ...bodyLines]`. Reconstructing it from the
    // NEW block and asserting it equals the golden proves the delta is the
    // envelope alone: every body line survived, in order, unedited.
    const lines = (after as string).split('\n');
    assert.equal(lines[0], HOTEL_IDENTITY_HEADER, 'the header must still lead the block');
    const noteLines = HOTEL_IDENTITY_TRUST_NOTE.split('\n');
    assert.deepEqual(
      lines.slice(1, 1 + noteLines.length), noteLines,
      'the ceiling must sit directly under the header, above the fence',
    );
    assert.equal(lines[1 + noteLines.length], '', 'a blank line separates ceiling from fence');
    assert.equal(lines[2 + noteLines.length], HOTEL_IDENTITY_TRUST_MARKER_OPEN);
    assert.equal(lines[lines.length - 1], HOTEL_IDENTITY_TRUST_MARKER_CLOSE);

    const body = lines.slice(3 + noteLines.length, -1);
    assert.deepEqual(
      [HOTEL_IDENTITY_HEADER, ...body].join('\n'), before,
      'the identity BODY changed. The only intentional difference in this consolidation is '
      + 'the envelope around it; a body edit is a separate decision and needs its own reason.',
    );
  });

  test('the hotel-chat prompts differ from the golden by exactly that envelope', () => {
    for (const name of ['hotel-chat.general_manager', 'hotel-chat.housekeeping']) {
      const { before: b, after: a } = subject(name);
      const legacyIdentity = golden['block.hotel-identity'] as string;
      const fencedIdentity = rebuilt['block.hotel-identity'] as string;

      // Replay the golden forward: swap the un-fenced identity block for the
      // fenced one and bump the version stamp. If the result is the new bytes,
      // then nothing else in the assembler moved.
      const expectedStable = b.stable
        .replace(legacyIdentity, fencedIdentity)
        .replace('hotel-identity-v1', HOTEL_IDENTITY_VERSION);
      assert.equal(a.stable, expectedStable, `${name}'s stable block changed by more than `
        + 'the hotel-identity envelope.');
      assert.equal(a.dynamic, b.dynamic, `${name}'s per-turn block must not have moved at all`);
      assert.equal(
        a.factual,
        b.factual.replace(legacyIdentity, fencedIdentity).replace('hotel-identity-v1', HOTEL_IDENTITY_VERSION),
        `${name}'s number-guard receipt changed by more than the envelope`,
      );
      assert.equal(a.stableStamp, b.stableStamp.replace('hotel-identity-v1', HOTEL_IDENTITY_VERSION));
    }
  });

  test('the awareness version reaches the persisted receipt and NOT the printed stamp', () => {
    // The hygiene item: awareness was the one envelope-wrapped store with no
    // version constant, so "which awareness rendering ran on this turn" was
    // unanswerable from agent_messages.prompt_version. It must land in the
    // receipt only — printing anything per-turn into the cached half rewrites
    // the cached prefix on every single turn.
    const { before: b, after: a } = subject('hotel-chat.general_manager');
    assert.equal(
      b.versionLabel.includes(AWARENESS_VERSION), false,
      'the golden already carried an awareness version, so this test proves nothing',
    );
    assert.ok(a.versionLabel.includes(AWARENESS_VERSION));
    assert.equal(a.stableStamp.includes(AWARENESS_VERSION), false,
      'the awareness version was printed into the CACHED block');
    assert.equal(a.stable.includes(AWARENESS_VERSION), false);

    // And absent when the block is: a stamp claiming a rendering that did not
    // happen is worse than no stamp.
    const noAwareness = subject('hotel-chat.housekeeping').after;
    assert.equal(noAwareness.versionLabel.includes(AWARENESS_VERSION), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PURITY INVARIANT, NOW ENFORCED IN ONE PLACE
// ═══════════════════════════════════════════════════════════════════════════

describe('the door refuses rather than defaults', () => {
  test('a reader without company-policy visibility gets no rulebook', async () => {
    const composed = await composeKnowledgeTier('company_knowledge', {
      hotelIds: [PID_ONE],
      organizationId: ORG_ID,
      companyPolicyVisible: false,
    });
    assert.equal(composed, null,
      'the company rulebook holds approval thresholds, vendor contracts and what a GM may '
      + 'spend. A line role receiving it is a policy leak with no screen behind it.');
  });

  test('a multi-hotel turn gets no hotel-scoped knowledge at all', async () => {
    const turn = { hotelIds: [PID_ONE, PID_TWO], companyPolicyVisible: true };
    assert.equal(await composeKnowledgeTier('hotel_standing_rules', turn), null);
    assert.equal(await composeKnowledgeTier('hotel_identity', turn), null);
  });

  test('a turn about no hotel gets none either', async () => {
    const turn = { hotelIds: [], companyPolicyVisible: true };
    assert.equal(await composeKnowledgeTier('hotel_standing_rules', turn), null);
    assert.equal(await composeKnowledgeTier('hotel_identity', turn), null);
  });

  test('a store that renders always stamps the version it registered', async () => {
    const turn = { hotelIds: [PID_ONE], organizationId: ORG_ID, companyPolicyVisible: true };
    for (const id of ['company_knowledge', 'hotel_identity', 'hotel_standing_rules'] as const) {
      const composed = await composeKnowledgeTier(id, turn);
      assert.ok(composed, `${id} rendered nothing against the seeded fixtures`);
      assert.equal(
        composed!.version,
        knowledgeStore(id).presentations[0].version,
        `${id} stamped a version its registration does not know about`,
      );
      assert.ok(composed!.block.length > 0, `${id} returned an empty block instead of null`);
    }
  });
});
