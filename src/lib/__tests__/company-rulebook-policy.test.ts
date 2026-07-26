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
  describeAuthorityRule,
  describePolicyValue,
  findSettingContradictions,
  formatCents,
  isCompanyCategory,
  normalizeClockTime,
  readAuthorityRule,
  readPolicyValue,
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
