/**
 * Tests for src/lib/rules-engine/detection.ts.
 *
 * Detection is keyword-matching against free-text PMS fields. False
 * positives create spurious tasks (e.g. detecting "celebrate" as
 * anniversary); false negatives drop tasks the housekeeper expects.
 * These tests pin the current keyword set.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectAnniversary,
  detectBabyCot,
  detectEarlyCheckinRequest,
  detectEcoStay,
  detectExtraBed,
  detectHasPet,
  detectHoneymoon,
  detectIsVip,
  detectLanguage,
  detectLoyaltyTier,
} from '@/lib/rules-engine/detection';

describe('detectIsVip', () => {
  test('Platinum loyalty tier ⇒ true', () => {
    assert.equal(detectIsVip({ loyalty_tier: 'Platinum' }), true);
  });

  test('VIP keyword in notes ⇒ true', () => {
    assert.equal(detectIsVip({ notes: 'VIP guest, GM hold' }), true);
  });

  test('Bronze tier alone is NOT a VIP', () => {
    assert.equal(detectIsVip({ loyalty_tier: 'Bronze' }), false);
  });

  test('no signals ⇒ false', () => {
    assert.equal(detectIsVip({ notes: 'regular guest' }), false);
  });
});

describe('detectHasPet', () => {
  test('"pet" in special_requests ⇒ true', () => {
    assert.equal(detectHasPet({ special_requests: 'travelling with pet' }), true);
  });

  test('"service animal" ⇒ true', () => {
    assert.equal(detectHasPet({ notes: 'guest requires service animal' }), true);
  });

  test('"celebrate" alone ⇒ false (no pet keyword overlap)', () => {
    assert.equal(detectHasPet({ notes: 'birthday — celebrate quietly' }), false);
  });

  // Regression: bare substring 'pet' used to match 'carpet' (and 'dog'
  // 'watchdog'), spawning phantom pet-clean tasks. Now word-boundary matched.
  test('"carpet" does NOT trip pet detection', () => {
    assert.equal(detectHasPet({ notes: 'deep clean the carpet, please' }), false);
  });

  test('"watchdog" / "trumpet" do NOT trip pet detection', () => {
    assert.equal(detectHasPet({ special_requests: 'left a trumpet in the room' }), false);
    assert.equal(detectHasPet({ notes: 'neighborhood watchdog program flyer' }), false);
  });

  // 'esa' (Spanish for "that") was dropped so bilingual notes don't false-fire.
  test('Spanish "esa" does NOT trip pet detection', () => {
    assert.equal(detectHasPet({ special_requests: 'limpiar esa habitación primero' }), false);
  });

  test('"dog" as a whole word still ⇒ true', () => {
    assert.equal(detectHasPet({ notes: 'guest has a small dog' }), true);
  });
});

describe('detectEcoStay', () => {
  test('"eco-stay" ⇒ true', () => {
    assert.equal(detectEcoStay({ notes: 'opted into eco-stay program' }), true);
  });

  test('"no daily clean" ⇒ true', () => {
    assert.equal(detectEcoStay({ special_requests: 'guest wants no daily clean' }), true);
  });

  test('"green choice" ⇒ true', () => {
    assert.equal(detectEcoStay({ notes: 'green choice opt-in' }), true);
  });

  test('"eco hotel awards" ⇒ false (no opt-in phrase)', () => {
    assert.equal(detectEcoStay({ notes: 'mentioned eco hotel awards' }), false);
  });

  // Regression: bare 'no service' used to flip eco-stay (which downgrades a
  // room to a 5-min visual check) on any incidental mention. Now requires a
  // specific housekeeping opt-out phrase.
  test('incidental "no service" does NOT flip eco-stay', () => {
    assert.equal(detectEcoStay({ notes: 'guest says cell has no service in 210' }), false);
    assert.equal(detectEcoStay({ special_requests: 'ice machine no service on 2nd floor' }), false);
  });

  test('explicit "no housekeeping" / "decline service" ⇒ true', () => {
    assert.equal(detectEcoStay({ special_requests: 'guest requested no housekeeping' }), true);
    assert.equal(detectEcoStay({ notes: 'will decline service for the stay' }), true);
  });
});

describe('detectHoneymoon / detectAnniversary', () => {
  test('honeymoon detected in package_name', () => {
    assert.equal(detectHoneymoon({ package_name: 'Honeymoon Suite Package' }), true);
    assert.equal(detectAnniversary({ package_name: 'Honeymoon Suite Package' }), false);
  });

  test('anniversary detected in notes', () => {
    assert.equal(detectAnniversary({ notes: '25th anniversary trip' }), true);
    assert.equal(detectHoneymoon({ notes: '25th anniversary trip' }), false);
  });

  test('"just married" ⇒ honeymoon', () => {
    assert.equal(detectHoneymoon({ special_requests: 'just married, celebrating' }), true);
  });
});

describe('detectLanguage', () => {
  test('"prefers Spanish" ⇒ Spanish-speaking', () => {
    assert.equal(
      detectLanguage({ notes: 'guest prefers Spanish' }),
      'Spanish-speaking',
    );
  });

  test('"Spanish-speaking" ⇒ Spanish-speaking', () => {
    assert.equal(
      detectLanguage({ notes: 'VIP Platinum, Spanish-speaking' }),
      'Spanish-speaking',
    );
  });

  test('"habla espanol" ⇒ Spanish-speaking', () => {
    assert.equal(
      detectLanguage({ special_requests: 'guest habla espanol' }),
      'Spanish-speaking',
    );
  });

  test('no language signal ⇒ null', () => {
    assert.equal(detectLanguage({ notes: 'regular note' }), null);
  });
});

describe('detectLoyaltyTier', () => {
  test('"Platinum" in notes ⇒ Platinum', () => {
    assert.equal(detectLoyaltyTier({ notes: 'VIP Platinum, Spanish-speaking' }), 'Platinum');
  });

  test('"Gold" in special_requests ⇒ Gold', () => {
    assert.equal(detectLoyaltyTier({ special_requests: 'Gold member' }), 'Gold');
  });

  test('multiple tiers: most-specific wins (Platinum > Gold)', () => {
    assert.equal(
      detectLoyaltyTier({ notes: 'Was Gold, now Platinum' }),
      'Platinum',
    );
  });

  test('no tier ⇒ null', () => {
    assert.equal(detectLoyaltyTier({ notes: 'regular guest' }), null);
  });
});

describe('detectEarlyCheckinRequest / detectBabyCot / detectExtraBed', () => {
  test('early check-in flag', () => {
    assert.equal(
      detectEarlyCheckinRequest({ special_requests: 'early check-in please' }),
      true,
    );
  });

  test('crib request ⇒ baby cot', () => {
    assert.equal(detectBabyCot({ special_requests: 'crib needed' }), true);
  });

  test('rollaway ⇒ extra bed', () => {
    assert.equal(detectExtraBed({ notes: 'request a rollaway' }), true);
  });
});
