/**
 * Translation tests for piece B/C locales.
 *
 * Confirms the new languages exist, the fallback path works, and the
 * machine-translated flag is set so the UI can warn the user.
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  t,
  LOCALE_META,
  SUPPORTED_LOCALES,
  toBilingual,
  type HousekeeperLocale,
} from '../translations';

describe('housekeeper-bc translations', () => {
  test('all five locales registered in LOCALE_META and SUPPORTED_LOCALES', () => {
    const expected: HousekeeperLocale[] = ['en', 'es', 'ht', 'tl', 'vi'];
    for (const code of expected) {
      assert.ok(LOCALE_META[code], `LOCALE_META missing ${code}`);
      assert.ok(LOCALE_META[code].nativeName, `${code} missing nativeName`);
    }
    assert.deepEqual([...SUPPORTED_LOCALES].sort(), [...expected].sort());
  });

  test('EN + ES are NOT machine-translated; HT/TL/VI are', () => {
    assert.equal(LOCALE_META.en.machineTranslated, false);
    assert.equal(LOCALE_META.es.machineTranslated, false);
    assert.equal(LOCALE_META.ht.machineTranslated, true);
    assert.equal(LOCALE_META.tl.machineTranslated, true);
    assert.equal(LOCALE_META.vi.machineTranslated, true);
  });

  test('t() returns a string for every housekeeper-facing key in every locale', () => {
    // Spot-check a representative sample of housekeeper-facing strings.
    const keys = [
      'hkActionStart', 'hkActionPause', 'hkActionResume', 'hkActionDone',
      'hkException', 'hkExceptionDnd', 'hkExceptionNsr',
      'hkLunchStart', 'hkLunchEnd',
      'hkNotice', 'hkAddNote', 'hkMarkForInspection',
      'hkIssueAction', 'hkIssueSubmit',
      'langPickerTitle', 'langPickerSearchPlaceholder',
    ] as const;
    for (const code of SUPPORTED_LOCALES) {
      for (const k of keys) {
        const v = t(k, code);
        assert.equal(typeof v, 'string', `${code}/${k} is not a string`);
        assert.ok(v.length > 0, `${code}/${k} is empty`);
      }
    }
  });

  test('missing keys in HT/TL/VI fall back to EN, not the raw key', () => {
    // `dashboard` is a manager-side string only EN+ES carry. Confirm
    // HT/TL/VI return the EN value, not the raw 'dashboard' literal.
    const enValue = t('dashboard', 'en');
    assert.equal(t('dashboard', 'ht'), enValue);
    assert.equal(t('dashboard', 'tl'), enValue);
    assert.equal(t('dashboard', 'vi'), enValue);
  });

  test('search aliases include the language name in its own script', () => {
    assert.ok(LOCALE_META.ht.searchAliases.some((a) => a.toLowerCase().includes('kreyol')));
    assert.ok(LOCALE_META.tl.searchAliases.some((a) => a.toLowerCase().includes('tagalog')));
    assert.ok(LOCALE_META.vi.searchAliases.some((a) => a.toLowerCase().includes('việt') || a.includes('tieng viet')));
  });

  test('toBilingual narrows wider locales to en/es', () => {
    assert.equal(toBilingual('en'), 'en');
    assert.equal(toBilingual('es'), 'es');
    assert.equal(toBilingual('ht'), 'en');
    assert.equal(toBilingual('tl'), 'en');
    assert.equal(toBilingual('vi'), 'en');
    assert.equal(toBilingual(null), 'en');
    assert.equal(toBilingual('xx'), 'en');
  });
});
