/**
 * English-only Knows / Company Rulebook banner safety.
 *
 * The product chrome is intentionally English-only. These assertions preserve
 * the independent safety contract that motivated the original localization
 * suite: server log strings and machine tokens never render directly, every
 * known refusal has friendly product-owned copy, extraction notes remain
 * distinguishable, and success/error severity styling cannot drift.
 */

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import Module from 'node:module';
import type React from 'react';

const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);

type KnowsModule = typeof import('@/components/concourse/KnowsView');
type RulebookModule = typeof import('@/components/concourse/CompanyRulebookPanel');

let knows: KnowsModule;
let rulebook: RulebookModule;

before(async () => {
  // `npm test` uses React's server condition, whose module does not expose
  // createContext. These hookless helpers do not render a hooks-using tree, so
  // a minimal context shim is sufficient for importing their component files.
  const react = nodeRequire('react') as Record<string, unknown>;
  if (typeof react.createContext !== 'function') {
    react.createContext = (defaultValue: unknown) => ({
      Provider: () => null,
      Consumer: () => null,
      _currentValue: defaultValue,
    });
  }
  knows = await import('@/components/concourse/KnowsView');
  rulebook = await import('@/components/concourse/CompanyRulebookPanel');
});

function renderedText(node: React.ReactElement): string {
  const props = node.props as { children?: unknown };
  assert.equal(typeof props.children, 'string', 'banner must render one plain sentence');
  return props.children as string;
}

function renderedClass(node: React.ReactElement): string {
  return String((node.props as { className?: unknown }).className ?? '');
}

const SHARED_CODES = [
  'account_not_found',
  'forbidden',
  'invalid_body',
  'unknown_action',
  'unknown_category',
  'content_required',
  'confirm_failed',
  'fact_gone',
  'remove_failed',
  'save_failed',
  'nothing_to_read',
  'file_no_text',
  'file_unreadable',
  'file_malformed',
  'file_type_unsupported',
  'file_too_big',
  'nothing_readable',
  'ai_disabled',
  'ai_unavailable',
  'ai_budget_exhausted',
  'rate_limited',
  'request_failed',
] as const;

const RULEBOOK_ONLY_CODES = [
  'no_company',
  'company_leadership_only',
  'settings_required',
  'settings_save_failed',
  'merge_failed',
  'idempotency_conflict',
  'upstream_failure',
] as const;

const SERVER_STRINGS = [
  'Account not found',
  'Forbidden',
  'Invalid JSON body',
  'Unknown action',
  'Unknown category',
  'content is required',
  'settings is required',
  'That fact is no longer there',
  'That line is no longer there',
  'Could not confirm that',
  'Could not remove that',
  'Could not save that',
  'Could not combine those',
  'Could not save those choices',
  'Type something or add a file first.',
  'Staxis could not read any text in that file.',
  'Staxis could not read that file.',
  'There was nothing readable in that.',
  'This is turned off right now.',
  'Staxis could not read that just now. Try again.',
  'This hotel is not part of a management company',
  'Only company leadership can change the rulebook',
  'Only company leadership can add to the rulebook',
  'That file type can\'t be read.',
  'That file is too big — keep it under 4MB.',
  'file is malformed',
  'rate_limited',
  'Failed (502)',
] as const;

describe('Knows banner copy', () => {
  test('every known server code resolves to specific friendly English copy', () => {
    const generic = knows.knowsBannerText(undefined, undefined, 'en');
    for (const code of SHARED_CODES) {
      const copy = knows.knowsBannerText(code, undefined, 'en');
      assert.ok(copy.length > 10, `${code}: missing friendly sentence`);
      assert.notEqual(copy, generic, `${code}: fell through to generic copy`);
      assert.ok(!copy.includes(code), `${code}: raw machine token leaked`);
    }
  });

  test('daily AI exhaustion and hourly rate limiting remain distinct', () => {
    assert.notEqual(
      knows.knowsBannerText('ai_budget_exhausted', undefined, 'en'),
      knows.knowsBannerText('rate_limited', undefined, 'en'),
    );
  });
});

describe('Company Rulebook banner copy', () => {
  test('every known server code resolves to specific friendly English copy', () => {
    const generic = rulebook.rulebookBannerText(undefined, undefined, 'en');
    for (const code of [...SHARED_CODES, ...RULEBOOK_ONLY_CODES]) {
      const copy = rulebook.rulebookBannerText(code, undefined, 'en');
      assert.ok(copy.length > 10, `${code}: missing friendly sentence`);
      assert.notEqual(copy, generic, `${code}: fell through to generic copy`);
      assert.ok(!copy.includes(code), `${code}: raw machine token leaked`);
    }
  });

  test('hotel facts and company rulebook lines use context-specific copy', () => {
    assert.notEqual(
      knows.knowsBannerText('fact_gone', undefined, 'en'),
      rulebook.rulebookBannerText('fact_gone', undefined, 'en'),
    );
  });
});

describe('raw server output never becomes banner copy', () => {
  test('unknown codes fall back to product-owned generic sentences', () => {
    const serverSaid = 'Some brand new refusal nobody mapped';
    assert.equal(
      knows.knowsBannerText('future_code', serverSaid, 'en'),
      knows.knowsBannerText(undefined, undefined, 'en'),
    );
    assert.equal(
      rulebook.rulebookBannerText('future_code', serverSaid, 'en'),
      rulebook.rulebookBannerText(undefined, undefined, 'en'),
    );
  });

  test('known raw route strings never echo through either mapper', () => {
    for (const serverString of SERVER_STRINGS) {
      assert.notEqual(knows.knowsBannerText(undefined, serverString, 'en'), serverString);
      assert.notEqual(rulebook.rulebookBannerText(undefined, serverString, 'en'), serverString);
    }
  });

  test('the bare rate-limit token becomes the same friendly sentence as its code', () => {
    const knowsText = knows.knowsBannerText(undefined, 'rate_limited', 'en');
    const rulebookText = rulebook.rulebookBannerText(undefined, 'rate_limited', 'en');
    assert.ok(!knowsText.includes('rate_limited'));
    assert.ok(!rulebookText.includes('rate_limited'));
    assert.equal(knowsText, knows.knowsBannerText('rate_limited', undefined, 'en'));
    assert.equal(rulebookText, rulebook.rulebookBannerText('rate_limited', undefined, 'en'));
  });
});

describe('file extraction notes', () => {
  test('truncation and AI-reading notes are both friendly and distinct', () => {
    for (const textFor of [
      (code: string | null) => knows.knowsReadNoteText(code, 'en'),
      (code: string | null) => rulebook.rulebookReadNoteText(code, 'en'),
    ]) {
      const truncated = textFor('file_truncated');
      const aiRead = textFor('file_read_with_ai');
      assert.ok(truncated.length > 10);
      assert.ok(aiRead.length > 10);
      assert.notEqual(truncated, aiRead);
    }
  });

  test('unknown or absent extraction notes add nothing', () => {
    for (const code of [null, 'future_note']) {
      assert.equal(knows.knowsReadNoteText(code, 'en'), '');
      assert.equal(rulebook.rulebookReadNoteText(code, 'en'), '');
    }
  });

  test('compatibility readNote prose from the server is never rendered verbatim', () => {
    const serverReadNote = 'That file is long — Staxis read the first part of it.';
    assert.notEqual(knows.knowsReadNoteText('file_truncated', 'en'), serverReadNote);
    assert.notEqual(rulebook.rulebookReadNoteText('file_truncated', 'en'), serverReadNote);
  });
});

describe('banner severity and rendered text', () => {
  test('Knows renders failures as bad and owned success copy as good', () => {
    const bad = knows.knowsBannerNote({ kind: 'bad', failure: { code: 'save_failed' } }, 'en');
    assert.equal(renderedText(bad), knows.knowsBannerText('save_failed', undefined, 'en'));
    assert.ok(renderedClass(bad).includes('kn-bad'));

    const good = knows.knowsBannerNote({ kind: 'good', text: '1 fact added below.' }, 'en');
    assert.equal(renderedText(good), '1 fact added below.');
    assert.ok(renderedClass(good).includes('kn-good'));
  });

  test('Rulebook renders failures as bad and owned success copy as good', () => {
    const bad = rulebook.rulebookBannerNote(
      { kind: 'bad', failure: { code: 'company_leadership_only' } },
      'en',
    );
    assert.equal(
      renderedText(bad),
      rulebook.rulebookBannerText('company_leadership_only', undefined, 'en'),
    );
    assert.ok(renderedClass(bad).includes('cr-bad'));

    const good = rulebook.rulebookBannerNote({ kind: 'good', text: 'Saved.' }, 'en');
    assert.equal(renderedText(good), 'Saved.');
    assert.ok(renderedClass(good).includes('cr-good'));
  });
});
