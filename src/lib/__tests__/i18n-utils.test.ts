/**
 * Tests for src/lib/i18n-utils.ts (staff-pages overhaul F9).
 *
 * Run via: npx tsx --test src/lib/__tests__/i18n-utils.test.ts
 *
 * These helpers are extractions of boilerplate duplicated across feature
 * pages (the 8 private tr() copies, inv-i18n/fin-i18n's t()/label getters,
 * dateLocale). The contract under test is behavioral identity with those
 * copies: es → Spanish branch, everything else (en/ht/tl/vi/null/garbage)
 * → English branch, and label lookups fall back lang → EN → raw key.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { tr, narrowLang, makeT, makeLabelFor, dateLocale, type EsKeyParity } from '../i18n-utils';

// ─── tr ─────────────────────────────────────────────────────────────────────

describe('tr', () => {
  test('es picks the Spanish string', () => {
    assert.equal(tr('es', 'Good', 'Bien'), 'Bien');
  });

  test('en picks the English string', () => {
    assert.equal(tr('en', 'Good', 'Bien'), 'Good');
  });

  test('wider locales degrade to English (matches every existing copy)', () => {
    assert.equal(tr('ht', 'Good', 'Bien'), 'Good');
    assert.equal(tr('tl', 'Good', 'Bien'), 'Good');
    assert.equal(tr('vi', 'Good', 'Bien'), 'Good');
  });

  test('null / undefined / garbage degrade to English', () => {
    assert.equal(tr(null, 'Good', 'Bien'), 'Good');
    assert.equal(tr(undefined, 'Good', 'Bien'), 'Good');
    assert.equal(tr('es-ES', 'Good', 'Bien'), 'Good'); // strict === 'es', like the originals
  });
});

// ─── narrowLang ─────────────────────────────────────────────────────────────

describe('narrowLang', () => {
  test('es stays es', () => {
    assert.equal(narrowLang('es'), 'es');
  });

  test('everything else narrows to en', () => {
    assert.equal(narrowLang('en'), 'en');
    assert.equal(narrowLang('ht'), 'en');
    assert.equal(narrowLang('vi'), 'en');
    assert.equal(narrowLang(null), 'en');
    assert.equal(narrowLang(undefined), 'en');
  });
});

// ─── makeT ──────────────────────────────────────────────────────────────────

const STRINGS = {
  en: { pageTitle: 'Inventory', loading: 'Loading…' },
  es: { pageTitle: 'Inventario', loading: 'Cargando…' },
};

describe('makeT', () => {
  const t = makeT(STRINGS);

  test('returns the EN dictionary for en', () => {
    assert.equal(t('en').pageTitle, 'Inventory');
  });

  test('returns the ES dictionary for es', () => {
    assert.equal(t('es').pageTitle, 'Inventario');
    assert.equal(t('es').loading, 'Cargando…');
  });

  test('unknown locales fall back to EN (inv-i18n t() behavior)', () => {
    assert.equal(t('ht').pageTitle, 'Inventory');
    assert.equal(t('xx').loading, 'Loading…');
    assert.equal(t(null).pageTitle, 'Inventory');
    assert.equal(t(undefined).pageTitle, 'Inventory');
  });

  test('extra locales are honored when supplied', () => {
    const t5 = makeT({
      en: { hello: 'Hello' },
      es: { hello: 'Hola' },
      ht: { hello: 'Bonjou' },
    });
    assert.equal(t5('ht').hello, 'Bonjou');
    assert.equal(t5('tl').hello, 'Hello'); // missing locale still falls back
  });
});

// ─── makeLabelFor ───────────────────────────────────────────────────────────

describe('makeLabelFor', () => {
  const statusLabelFor = makeLabelFor({
    en: { good: 'Good', low: 'Low', critical: 'Critical' },
    es: { good: 'Bien', low: 'Bajo', critical: 'Crítico' },
  });

  test('looks up the label in the chosen language', () => {
    assert.equal(statusLabelFor('en', 'low'), 'Low');
    assert.equal(statusLabelFor('es', 'critical'), 'Crítico');
  });

  test('unknown locale falls back to EN', () => {
    assert.equal(statusLabelFor('vi', 'good'), 'Good');
    assert.equal(statusLabelFor(undefined, 'good'), 'Good');
  });

  test('unknown key falls back to the raw key (runtime data safety)', () => {
    // The type system prevents this, but runtime data (DB enums) can drift —
    // matches inv-i18n's `?? s` tail.
    assert.equal(statusLabelFor('en', 'weird' as 'good'), 'weird');
  });
});

// ─── EsKeyParity (compile-time guard) ───────────────────────────────────────

describe('EsKeyParity', () => {
  test('type-checks a parity assignment (compile-time contract)', () => {
    // This mirrors how a local dictionary opts into the guard. If `es` ever
    // dropped a key, this file would stop compiling — which is the test.
    const _esKeyParity: EsKeyParity<typeof STRINGS.en> = STRINGS.es;
    assert.equal(typeof _esKeyParity.pageTitle, 'string');
  });
});

// ─── dateLocale ─────────────────────────────────────────────────────────────

describe('dateLocale', () => {
  test("default pair matches inv-i18n's dateLocale (es-ES / en-US)", () => {
    assert.equal(dateLocale('es'), 'es-ES');
    assert.equal(dateLocale('en'), 'en-US');
    assert.equal(dateLocale('ht'), 'en-US');
    assert.equal(dateLocale(undefined), 'en-US');
  });

  test("financials' inline pair via override (es-US / en-US)", () => {
    assert.equal(dateLocale('es', 'es-US'), 'es-US');
    assert.equal(dateLocale('en', 'es-US'), 'en-US');
  });

  test("bare-tag pair via both overrides (es / en — LogBookCard style)", () => {
    assert.equal(dateLocale('es', 'es', 'en'), 'es');
    assert.equal(dateLocale('en', 'es', 'en'), 'en');
  });
});
