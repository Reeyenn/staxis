/**
 * READING A COMPANY RULE AS STRUCTURE.
 *
 * The thing under test decides who has to sign for money, so the bar is not
 * "does it usually work". It is:
 *
 *   1. A real approval sentence produces the right three numbers.
 *   2. A sentence that is NOT an approval requirement produces nothing —
 *      because a false positive here silently invents a gate on somebody's
 *      purchase order, out of a line that was only describing the business.
 *   3. "$500 or more" and "over $500" are different rules, and a $500.00 order
 *      is exactly where they disagree.
 *
 * Every case below fails if the reader is loosened in a plausible direction:
 * drop the approval-verb requirement and the "unusual for us" case starts
 * producing a rule; drop the approver requirement and "orders over $500 need
 * approval" (nobody named) starts producing one; collapse inclusive/exclusive
 * and the boundary cases flip.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  coerceCompanyCategory,
  contentTokens,
  describeAmbiguousAuthority,
  describeAuthorityRule,
  describeNearDuplicate,
  describePolicyValue,
  findNearDuplicate,
  findSettingContradictions,
  formatCents,
  isCompanyCategory,
  normalizeClockTime,
  readApproverCandidates,
  readAuthority,
  readAuthorityRule,
  readPolicyValue,
  tokenSimilarity,
} from '@/lib/company/rulebook-policy';

describe('reading an approval requirement', () => {
  it('reads the founder\'s own sentence into three numbers', () => {
    const rule = readAuthorityRule('Orders over $500 need VP sign-off.');
    assert.ok(rule, 'the headline example must produce a rule');
    assert.equal(rule.actionKind, 'purchase_order');
    assert.equal(rule.thresholdCents, 50_000);
    assert.equal(rule.thresholdInclusive, false);
    assert.equal(rule.approverRole, 'vp');
  });

  it('keeps cents out of floating point', () => {
    const rule = readAuthorityRule('Any invoice above $1,250.50 requires the controller to approve it.');
    assert.ok(rule);
    assert.equal(rule.thresholdCents, 125_050);
    assert.equal(rule.actionKind, 'invoice');
    assert.equal(rule.approverRole, 'finance');
  });

  it('understands "5k"', () => {
    const rule = readAuthorityRule('Capital projects over $5k need the owner to authorize them.');
    assert.ok(rule);
    assert.equal(rule.thresholdCents, 500_000);
    assert.equal(rule.actionKind, 'capital_project');
    assert.equal(rule.approverRole, 'owner');
  });

  it('"or more" is INCLUSIVE and "over" is not — the two disagree at the boundary', () => {
    const inclusive = readAuthorityRule('Refunds of $200 or more need GM approval.');
    assert.ok(inclusive);
    assert.equal(inclusive.thresholdInclusive, true);
    assert.equal(inclusive.thresholdCents, 20_000);
    assert.equal(inclusive.approverRole, 'general_manager');

    const exclusive = readAuthorityRule('Refunds over $200 need GM approval.');
    assert.ok(exclusive);
    assert.equal(exclusive.thresholdInclusive, false);
    assert.equal(exclusive.thresholdCents, 20_000);
  });

  it('"at least" is inclusive too', () => {
    const rule = readAuthorityRule('Contracts of at least $10,000 require owner approval.');
    assert.ok(rule);
    assert.equal(rule.thresholdInclusive, true);
    assert.equal(rule.thresholdCents, 1_000_000);
    assert.equal(rule.actionKind, 'contract');
  });

  it('a purchase order is not read as a generic "order" with a worse label', () => {
    const rule = readAuthorityRule('Purchase orders over $750 need VP approval.');
    assert.ok(rule);
    assert.equal(rule.actionKind, 'purchase_order');
  });
});

describe('what must NOT become a rule', () => {
  // Each of these is a sentence a real VP might write. Turning any of them into
  // an authority rule would invent a gate nobody asked for.
  const notRules: Array<[string, string]> = [
    ['no approval verb', 'Orders over $500 are unusual for us.'],
    ['no money at all', 'The VP approves all new vendor relationships.'],
    ['no approver named', 'Orders over $500 need approval.'],
    ['no action kind', 'Anything over $500 needs VP approval.'],
    ['a plain vendor fact', 'All our hotels use Ecolab for chemicals.'],
    ['a plain policy', 'Checkout is 11.'],
    ['empty', '   '],
  ];
  for (const [why, sentence] of notRules) {
    it(`returns null — ${why}`, () => {
      assert.equal(readAuthorityRule(sentence), null, `"${sentence}" must not become a rule`);
    });
  }
});

describe('the sentence the confirmer approves', () => {
  it('reads back what will actually be frozen, in both languages', () => {
    const rule = readAuthorityRule('Orders over $500 need VP sign-off.');
    assert.ok(rule);
    assert.equal(describeAuthorityRule(rule, 'en'), 'Any order over $500 needs approval from the VP.');
    assert.equal(
      describeAuthorityRule(rule, 'es'),
      'El supervisor regional debe aprobar cualquier pedido de más de $500.',
    );
    // The Spanish sentence puts the approver first specifically so "de" + "el"
    // never has to contract. If somebody rewrites it as "aprobación de el …",
    // this catches it.
    assert.equal(/\bde el\b/.test(describeAuthorityRule(rule, 'es')), false);
  });

  it('the read-back distinguishes inclusive from exclusive — otherwise it lies', () => {
    const inclusive = readAuthorityRule('Refunds of $200 or more need GM approval.');
    assert.ok(inclusive);
    assert.match(describeAuthorityRule(inclusive, 'en'), /of \$200 or more/);
    assert.equal(/over \$200/.test(describeAuthorityRule(inclusive, 'en')), false);
  });

  it('formats money the way a person writes it', () => {
    assert.equal(formatCents(50_000), '$500');
    assert.equal(formatCents(125_050), '$1,250.50');
    assert.equal(formatCents(0), '$0');
  });
});

describe('reading a comparable setting', () => {
  it('reads a housekeeping start time to 24-hour canonical form', () => {
    const reading = readPolicyValue('Housekeeping starts at 8am at every hotel.');
    assert.deepEqual(reading, { key: 'housekeeping_start_time', value: '08:00' });
  });

  it('handles an explicit clock time with minutes', () => {
    assert.deepEqual(
      readPolicyValue('Housekeeping begins at 7:30 across the group.'),
      { key: 'housekeeping_start_time', value: '07:30' },
    );
  });

  it('reads checkout and stayover clean times', () => {
    assert.deepEqual(
      readPolicyValue('Checkouts get 30 minutes.'),
      { key: 'checkout_clean_minutes', value: '30' },
    );
    assert.deepEqual(
      readPolicyValue('Stayovers get 20 minutes.'),
      { key: 'stayover_clean_minutes', value: '20' },
    );
  });

  it('a guest checkout TIME is not a comparable setting — Staxis does not store one', () => {
    // Deliberate and documented: `checkout_minutes` is how long a checkout
    // CLEAN takes. Reading "checkout is 11" as a 11-minute clean would be a
    // fabricated contradiction on every hotel in the company.
    assert.equal(readPolicyValue('Checkout is 11.'), null);
    assert.equal(readPolicyValue('Guest checkout time is 11am company-wide.'), null);
  });

  it('returns null for prose with no setting in it', () => {
    assert.equal(readPolicyValue('All our hotels use Ecolab.'), null);
    assert.equal(readPolicyValue('Orders over $500 need VP sign-off.'), null);
  });

  it('refuses a nonsense clock rather than storing one', () => {
    assert.equal(normalizeClockTime('25', undefined, undefined), null);
    assert.equal(normalizeClockTime('8', '75', undefined), null);
    assert.equal(normalizeClockTime('13', undefined, 'pm'), null);
    assert.equal(normalizeClockTime('12', '00', 'am'), '00:00');
    assert.equal(normalizeClockTime('12', '00', 'pm'), '12:00');
  });

  it('reads back in both languages', () => {
    const reading = readPolicyValue('Housekeeping starts at 8am.');
    assert.ok(reading);
    assert.match(describePolicyValue(reading, 'en'), /housekeeping start time to 08:00/);
    assert.equal(describePolicyValue(reading, 'es'), 'La empresa fija la hora de inicio de limpieza en 08:00.');
  });
});

describe('settings contradictions', () => {
  const facts = [
    { id: 'f1', policyKey: 'housekeeping_start_time', policyValue: '08:00' },
    { id: 'f2', policyKey: 'checkout_clean_minutes', policyValue: '30' },
    // Prose only — must never contribute a line.
    { id: 'f3', policyKey: null, policyValue: null },
  ];

  it('fires on a real disagreement, and says which hotel', () => {
    const found = findSettingContradictions(facts, [
      {
        propertyId: 'p-lufkin',
        propertyName: 'Lufkin Inn',
        values: { housekeeping_start_time: '07:00', checkout_clean_minutes: '30' },
      },
    ]);
    assert.equal(found.length, 1, 'only the setting that actually differs');
    assert.equal(found[0].key, 'housekeeping_start_time');
    assert.equal(found[0].hotelValue, '07:00');
    assert.equal(found[0].companyValue, '08:00');
    assert.match(found[0].line.en, /Lufkin Inn/);
    assert.match(found[0].line.en, /the company book says 08:00/);
    assert.equal(
      found[0].line.es,
      'En Lufkin Inn, la hora de inicio de limpieza está en 07:00: el libro de la empresa dice 08:00.',
    );
  });

  it('does NOT fire on absence — a hotel that never configured the setting is silent', () => {
    const found = findSettingContradictions(facts, [
      { propertyId: 'p-new', propertyName: 'Port Arthur', values: {} },
    ]);
    assert.deepEqual(found, [], 'an unconfigured hotel is not in violation of anything');
  });

  it('does not fire when the values agree', () => {
    const found = findSettingContradictions(facts, [
      {
        propertyId: 'p-beaumont',
        propertyName: 'Beaumont Suites',
        values: { housekeeping_start_time: '08:00', checkout_clean_minutes: '30' },
      },
    ]);
    assert.deepEqual(found, []);
  });

  it('a fact with no structured reading can never produce a line', () => {
    const found = findSettingContradictions(
      [{ id: 'f3', policyKey: null, policyValue: null }],
      [{ propertyId: 'p1', propertyName: 'A', values: { housekeeping_start_time: '06:00' } }],
    );
    assert.deepEqual(found, [], 'prose is never scanned for disagreement');
  });

  it('an unknown policy key is ignored rather than rendered', () => {
    const found = findSettingContradictions(
      [{ id: 'f9', policyKey: 'wifi_password', policyValue: 'hunter2' }],
      [{ propertyId: 'p1', propertyName: 'A', values: { housekeeping_start_time: '06:00' } }],
    );
    assert.deepEqual(found, []);
  });
});

describe('company categories', () => {
  it('coerces anything unknown to a safe shelf instead of throwing', () => {
    assert.equal(coerceCompanyCategory('money'), 'money');
    assert.equal(coerceCompanyCategory('MONEY'), 'money');
    // The hotel Knows buckets are NOT company buckets.
    assert.equal(coerceCompanyCategory('rooms'), 'standards');
    assert.equal(coerceCompanyCategory(null), 'standards');
    assert.equal(coerceCompanyCategory(42), 'standards');
    assert.equal(isCompanyCategory('rooms'), false);
    assert.equal(isCompanyCategory('vendors'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WHO APPROVES — negation, sentence order, and the refusal to guess.
//
// The live bug this closes was on a real company's screen: the capital-project
// rule read "Any capital project over $5,000 requires owner approval, not VP
// approval." and was STORED and RENDERED BACK as "needs approval from the VP".
// The matcher walked a hardcoded list in which `vp` came before `owner`, and it
// could not see a negation at all.
//
// The worst version of the same bug is not cosmetic: a role named only in a
// negative clause could UNLOCK a card its author meant to lock.
// ═══════════════════════════════════════════════════════════════════════════

describe('the approver a sentence actually names', () => {
  // THE LIVE SENTENCE. Mutation: go back to first-match-wins over
  // APPROVER_PATTERNS. This flips to 'vp' — the exact wrong answer that was in
  // the database.
  it('"requires owner approval, not VP approval" is the OWNER', () => {
    const rule = readAuthorityRule('Any capital project over $5,000 requires owner approval, not VP approval.');
    assert.ok(rule, 'the sentence is a complete rule and must produce one');
    assert.equal(rule.approverRole, 'owner');
    assert.equal(rule.actionKind, 'capital_project');
    assert.equal(rule.thresholdCents, 500_000);
    assert.equal(rule.thresholdInclusive, false);
  });

  // …and it reads back correctly to the person confirming it, which is the whole
  // safety story for the structured reading.
  it('the confirmer is shown the owner, in both languages', () => {
    const rule = readAuthorityRule('Any capital project over $5,000 requires owner approval, not VP approval.')!;
    assert.match(describeAuthorityRule(rule, 'en'), /needs approval from the owner/);
    assert.doesNotMatch(describeAuthorityRule(rule, 'en'), /VP/);
    assert.match(describeAuthorityRule(rule, 'es'), /El propietario debe aprobar/);
  });

  // Mutation: let a negation cross a clause boundary. Both roles get excluded
  // and a complete rule silently becomes prose.
  const negations: Array<[string, string]> = [
    ['not', 'Any expense over $500 needs owner approval, not VP approval.'],
    ['instead of', 'Any expense over $500 needs owner approval instead of VP approval.'],
    ['rather than', 'Any expense over $500 needs owner approval rather than VP approval.'],
    ['never', 'Any expense over $500 needs owner approval; the VP never approves these.'],
    ['no', 'Any expense over $500 needs owner approval. No VP approval is required.'],
  ];
  for (const [cue, sentence] of negations) {
    it(`"${cue}" excludes the role behind it`, () => {
      const rule = readAuthorityRule(sentence);
      assert.ok(rule, `"${sentence}" must still be a rule`);
      assert.equal(rule.approverRole, 'owner', `"${cue}" did not exclude the VP`);
    });
  }

  // THE SHARPEST EDGE. Mutation: add `without` to the negation cues. "Without X"
  // means X is MANDATORY, and treating it as a negation inverts every sentence
  // written that way — including the one on the demo company's own book.
  it('"without" is not a negation — it makes the named role REQUIRED', () => {
    const rule = readAuthorityRule('No purchase over $500 may be made without VP approval.');
    assert.ok(rule);
    assert.equal(rule.approverRole, 'vp');
  });

  // Mutation: pick the FIRST role in the sentence instead of the one bound to
  // the approval word. "the GM handles ordering" would put the signature on the
  // GM and open every $600 order.
  it('the role bound to the approval word wins, not the first one mentioned', () => {
    const rule = readAuthorityRule(
      'The GM handles routine orders. Any order over $500 needs owner approval.',
    );
    assert.ok(rule, 'the sentence is a complete rule');
    assert.equal(rule.approverRole, 'owner');
  });

  it('a role mentioned only negatively never becomes the approver on its own', () => {
    const read = readAuthority('Any expense over $500 does not need VP approval.');
    // Nothing survives → not a rule at all. Silence is the safe answer: an
    // unstored rule gates nothing.
    assert.equal(read.kind, 'none');
    assert.equal(readAuthorityRule('Any expense over $500 does not need VP approval.'), null);
  });

  // Mutation: pick one arbitrarily (whichever the loop reached first). A wrong
  // approver on a money gate is the one outcome this file exists to prevent.
  it('two approvers, equally bound, is AMBIGUOUS and stores nothing', () => {
    const sentence = 'Any expense over $500 needs owner approval or VP approval.';
    const read = readAuthority(sentence);
    assert.equal(read.kind, 'ambiguous');
    if (read.kind !== 'ambiguous') return;
    assert.deepEqual([...read.candidates].sort(), ['owner', 'vp']);
    assert.equal(read.actionKind, 'expense');
    assert.equal(read.thresholdCents, 50_000);
    // The safety property: nothing is frozen.
    assert.equal(readAuthorityRule(sentence), null);
  });

  // Mutation: describe an ambiguous read with the same words a real rule uses.
  // A VP would read "needs approval from the VP" and believe a gate existed.
  it('the ambiguous read-back names BOTH roles and says nothing is enforced', () => {
    const read = readAuthority('Any expense over $500 needs owner approval or VP approval.');
    assert.equal(read.kind, 'ambiguous');
    if (read.kind !== 'ambiguous') return;
    const en = describeAmbiguousAuthority(read, 'en');
    assert.match(en, /the owner/);
    // Mutation: lower-case the labels wholesale. "the vp" was on screen.
    assert.match(en, /the VP/);
    assert.doesNotMatch(en, /the vp\b/);
    assert.match(en, /will not enforce/);
    assert.match(en, /Edit the line to name one/);
    const es = describeAmbiguousAuthority(read, 'es');
    assert.match(es, /no aplicará ninguna regla/);
    assert.notEqual(en, es);
    // Mutation: use an indefinite article. "un factura" and "a order" were both
    // one label away, and the labels come in two genders.
    assert.doesNotMatch(es, /\bun (factura|cortesía)\b/);
    assert.doesNotMatch(es, /nombra a el\b/, 'a + el contracts to al in Spanish');
    assert.match(es, /cualquier gasto/);
    assert.match(en, /any expense/);
  });

  // Mutation: return `ambiguous` for one clean role plus one negated one. The
  // company wrote a perfectly clear rule and would be told Staxis cannot read it.
  it('a clean role plus a negated role is not ambiguous', () => {
    const read = readAuthority('Any capital project over $5,000 requires owner approval, not VP approval.');
    assert.equal(read.kind, 'rule');
  });

  // The candidate reader on its own, so the three rules are separable.
  it('the candidate reader reports what survived and whether it chose', () => {
    const plain = readApproverCandidates('Orders over $500 need VP sign-off.');
    assert.equal(plain.picked, 'vp');
    assert.equal(plain.ambiguous, false);

    const negated = readApproverCandidates('requires owner approval, not VP approval');
    assert.equal(negated.picked, 'owner');
    assert.deepEqual(negated.surviving, ['owner']);

    const none = readApproverCandidates('Orders over $500 need approval.');
    assert.equal(none.picked, null);
    assert.equal(none.ambiguous, false);
    assert.deepEqual(none.surviving, []);
  });

  // Regression net: every sentence the file already promised to read must still
  // read the same way. Mutation: any of the three new rules mis-ordered.
  it('the sentences that already worked still work', () => {
    const cases: Array<[string, string]> = [
      ['Orders over $500 need VP sign-off.', 'vp'],
      ['Contracts of at least $10,000 require owner approval.', 'owner'],
      ['Any refund over $200 needs GM approval.', 'general_manager'],
      ['Invoices over $1,000 need finance approval.', 'finance'],
      ['Any expense over $500 needs approval from the VP.', 'vp'],
    ];
    for (const [sentence, expected] of cases) {
      const rule = readAuthorityRule(sentence);
      assert.ok(rule, `"${sentence}" stopped being a rule`);
      assert.equal(rule.approverRole, expected, `"${sentence}" now reads as ${rule.approverRole}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NEAR-DUPLICATES — the same rule said twice, with two different topic slugs.
//
// Live, on the demo company, both in the book at once:
//   chemical_vendor   (confirmed)  "All our hotels use Ecolab for chemicals."
//   chemical_supplier (unreviewed) "All Gulf Coast properties exclusively use
//                                   Ecolab chemicals."
// ═══════════════════════════════════════════════════════════════════════════

describe('spotting a rule the book already has', () => {
  const confirmed = [
    { id: 'c1', topic: 'chemical_vendor', content: 'All our hotels use Ecolab for chemicals.' },
    { id: 'c2', topic: 'housekeeping_start_time', content: 'Housekeeping starts at 7am at every hotel.' },
    { id: 'c3', topic: 'approvals', content: 'Any expense over $500 needs approval from the VP.' },
  ];

  // THE LIVE PAIR. Mutation: compare only the topic slug, which is what the
  // upsert already does and which these two rows sail straight past.
  it('the Ecolab restatement is matched to the line already in the book', () => {
    const match = findNearDuplicate(
      { id: 'u1', content: 'All Gulf Coast properties exclusively use Ecolab chemicals.' },
      confirmed,
    );
    assert.ok(match, 'the restatement was not spotted');
    assert.equal(match.existing.id, 'c1');
    assert.ok(match.sharedWords.includes('ecolab'));
    assert.ok(match.similarity >= 0.5);
  });

  // Mutation: lower the bar, or drop the shared-substantial-words requirement.
  // Two different housekeeping standards would be offered as duplicates and a
  // real rule could be merged away.
  it('two different rules about the same department are NOT duplicates', () => {
    assert.equal(
      findNearDuplicate(
        { id: 'u2', content: 'Checkout rooms are serviced in 30 minutes at every property.' },
        confirmed,
      ),
      null,
    );
    assert.equal(
      findNearDuplicate(
        { id: 'u3', content: 'Stayover rooms are serviced in 20 minutes at every property.' },
        confirmed,
      ),
      null,
    );
  });

  // Mutation: match on stopwords. "All our hotels …" shares four words with
  // every other line in the book and would match all of them.
  it('a line made of nothing but boilerplate matches nothing', () => {
    assert.equal(
      findNearDuplicate({ id: 'u4', content: 'All our hotels must do this at every property.' }, confirmed),
      null,
    );
  });

  it('a line never matches itself', () => {
    assert.equal(findNearDuplicate({ id: 'c1', content: confirmed[0].content }, confirmed), null);
  });

  it('an empty line matches nothing', () => {
    assert.equal(findNearDuplicate({ id: 'u5', content: '   ' }, confirmed), null);
  });

  // Mutation: quietly merge. The match is a heuristic over English, and one that
  // swallows a genuinely new rule is far worse than one that asks.
  it('the sentence shown to the human quotes the existing line and offers a choice', () => {
    const match = findNearDuplicate(
      { id: 'u1', content: 'All Gulf Coast properties exclusively use Ecolab chemicals.' },
      confirmed,
    )!;
    const en = describeNearDuplicate(match, 'en');
    assert.match(en, /All our hotels use Ecolab for chemicals\./);
    assert.match(en, /or keep both\?/);
    const es = describeNearDuplicate(match, 'es');
    assert.match(es, /conservar las dos\?/);
    assert.notEqual(en, es);
  });

  // Accents must not decide whether two Spanish lines are the same rule.
  it('Spanish matches with or without accents', () => {
    const esBook = [{ id: 'e1', topic: 'quimicos', content: 'Todos nuestros hoteles usan Ecolab para los químicos.' }];
    const match = findNearDuplicate(
      { id: 'e2', content: 'Todas las propiedades usan Ecolab para quimicos exclusivamente.' },
      esBook,
    );
    assert.ok(match, 'accents should not hide a duplicate');
  });

  it('similarity is symmetric and bounded', () => {
    const a = contentTokens('All our hotels use Ecolab for chemicals.');
    const b = contentTokens('All Gulf Coast properties exclusively use Ecolab chemicals.');
    assert.equal(tokenSimilarity(a, b), tokenSimilarity(b, a));
    assert.equal(tokenSimilarity(a, a), 1);
    assert.equal(tokenSimilarity(a, new Set()), 0);
  });
});
