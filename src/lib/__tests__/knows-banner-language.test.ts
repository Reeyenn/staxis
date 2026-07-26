/**
 * The Knows screen and the Company Rulebook panel speak two languages. Their
 * ERROR BANNERS did not.
 *
 * Both screens used to render the API route's own `error` string — "Account not
 * found", "That fact is no longer there", "content is required", and around
 * twenty more. Those strings are English and always will be: they are the log
 * line. A manager whose Staxis is in Spanish got a Spanish screen with an
 * English refusal in the middle of it. The rate limiter was worse — it answers
 * with a bare `{ error: 'rate_limited' }` and no envelope code, so the banner
 * printed the literal token `rate_limited` at the person.
 *
 * The fix: the server sends a machine-readable CODE, and each screen owns the
 * sentence in both languages. This suite is the guard on that contract, and
 * every test in it fails on the old behavior:
 *
 *   • every code a route can return resolves to a REAL sentence in each
 *     language — a typo in the lookup silently degrades to the generic line,
 *     and that is a failure here
 *   • an UNRECOGNIZED code (a route grows one, a proxy returns HTML) falls
 *     through to the generic bilingual line and NEVER to the server's English
 *   • the exact English sentences these four routes emit can never come out of
 *     the mapper — which is precisely what the bug was
 *   • the banner ELEMENT the screens render carries the localized sentence
 *
 * Why a new file rather than an extension of an existing one: the two nearby
 * suites (memory-knows.integration, company-rulebook.integration) both stand a
 * real database up and assert on route behavior. This is a pure client-copy
 * contract spanning BOTH components, and it must run with no database.
 */

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import Module from 'node:module';
import type React from 'react';

// ── Why the React shim below ────────────────────────────────────────────────
// `npm test` runs every file in this directory under `--conditions=react-server`,
// and React 19's react-server build does not export createContext. Both
// components import AuthContext / PropertyContext at module load, so the import
// throws before any test runs.
//
// Nothing here renders a hooks-using component — only the HOOKLESS banner
// builders those modules export are called — so a stub context is enough to get
// the module loaded. The stub is installed on the live `react` module object
// (not an esbuild namespace copy), which is why it goes through createRequire.
const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);

type KnowsModule = typeof import('@/components/concourse/KnowsView');
type RulebookModule = typeof import('@/components/concourse/CompanyRulebookPanel');

let knows: KnowsModule;
let rulebook: RulebookModule;

before(async () => {
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The text a banner element actually puts on screen. */
function renderedText(node: React.ReactElement): string {
  const props = node.props as { children?: unknown };
  assert.equal(typeof props.children, 'string', 'a banner must render one plain sentence');
  return props.children as string;
}

function renderedClass(node: React.ReactElement): string {
  const props = node.props as { className?: unknown };
  return String(props.className ?? '');
}

/** Codes both routes can answer with. */
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
  // Not an envelope code — arrives in the error slot. See api-ratelimit.ts.
  'rate_limited',
  // Minted by the components when the request never left the browser.
  'request_failed',
] as const;

/** Codes only the company rulebook routes can answer with. */
const RULEBOOK_ONLY_CODES = [
  'no_company',
  'company_leadership_only',
  'settings_required',
  'settings_save_failed',
  'merge_failed',
] as const;

/**
 * The literal English the four routes hand back today. None of it may ever
 * reach a Spanish banner — before the fix, ALL of it did.
 */
const SERVER_ENGLISH = [
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
  // The rate limiter's bare token, which the banner used to print verbatim.
  'rate_limited',
  // An unparseable body: readEnvelope's own last resort.
  'Failed (502)',
] as const;

// ─── Every code says something, in both languages ───────────────────────────

describe('every server code the Knows screen can get has its own sentence', () => {
  test('EN and ES both exist, differ, and are not the generic fallback', () => {
    const generic = { en: knows.knowsBannerText(undefined, undefined, 'en'), es: knows.knowsBannerText(undefined, undefined, 'es') };

    for (const code of SHARED_CODES) {
      const en = knows.knowsBannerText(code, undefined, 'en');
      const es = knows.knowsBannerText(code, undefined, 'es');

      assert.ok(en.length > 0, `${code}: no English sentence`);
      assert.ok(es.length > 0, `${code}: no Spanish sentence`);
      assert.notEqual(es, en, `${code}: the Spanish is just the English`);
      // A code missing from the lookup silently degrades to the generic line.
      // That is a bug, not a fallback, for a code the routes actually return.
      assert.notEqual(en, generic.en, `${code}: not mapped — fell through to the generic line`);
      assert.notEqual(es, generic.es, `${code}: not mapped — fell through to the generic line`);
    }
  });

  test('the daily AI cap and the hourly rate limit are different answers', () => {
    // "come back in a minute" and "come back tomorrow" must not be one sentence.
    assert.notEqual(
      knows.knowsBannerText('ai_budget_exhausted', undefined, 'es'),
      knows.knowsBannerText('rate_limited', undefined, 'es'),
    );
  });
});

describe('every server code the Company Rulebook panel can get has its own sentence', () => {
  test('EN and ES both exist, differ, and are not the generic fallback', () => {
    const generic = {
      en: rulebook.rulebookBannerText(undefined, undefined, 'en'),
      es: rulebook.rulebookBannerText(undefined, undefined, 'es'),
    };

    for (const code of [...SHARED_CODES, ...RULEBOOK_ONLY_CODES]) {
      const en = rulebook.rulebookBannerText(code, undefined, 'en');
      const es = rulebook.rulebookBannerText(code, undefined, 'es');

      assert.ok(en.length > 0, `${code}: no English sentence`);
      assert.ok(es.length > 0, `${code}: no Spanish sentence`);
      assert.notEqual(es, en, `${code}: the Spanish is just the English`);
      assert.notEqual(en, generic.en, `${code}: not mapped — fell through to the generic line`);
      assert.notEqual(es, generic.es, `${code}: not mapped — fell through to the generic line`);
    }
  });

  test('one code, two screens, two sentences — a hotel fact is not a rulebook line', () => {
    // The whole point of moving the wording to the client: the same server code
    // says "that fact" on the hotel screen and "that line" in the company book.
    assert.notEqual(
      knows.knowsBannerText('fact_gone', undefined, 'es'),
      rulebook.rulebookBannerText('fact_gone', undefined, 'es'),
    );
  });
});

// ─── The bug itself: English must never reach a Spanish banner ──────────────

describe('an unknown code falls back to the generic line, never to the server English', () => {
  test('Knows: an unrecognized code is the generic bilingual line', () => {
    const serverSaid = 'Some brand new refusal nobody has translated';
    const es = knows.knowsBannerText('a_code_this_build_has_never_heard_of', serverSaid, 'es');
    const en = knows.knowsBannerText('a_code_this_build_has_never_heard_of', serverSaid, 'en');

    assert.equal(es, knows.knowsBannerText(undefined, undefined, 'es'));
    assert.notEqual(es, en, 'the generic line itself must be bilingual');
    assert.ok(!es.includes(serverSaid), 'the server string leaked into a Spanish banner');
  });

  test('Rulebook: an unrecognized code is the generic bilingual line', () => {
    const serverSaid = 'Some brand new refusal nobody has translated';
    const es = rulebook.rulebookBannerText('a_code_this_build_has_never_heard_of', serverSaid, 'es');
    const en = rulebook.rulebookBannerText('a_code_this_build_has_never_heard_of', serverSaid, 'en');

    assert.equal(es, rulebook.rulebookBannerText(undefined, undefined, 'es'));
    assert.notEqual(es, en, 'the generic line itself must be bilingual');
    assert.ok(!es.includes(serverSaid), 'the server string leaked into a Spanish banner');
  });

  test('no English sentence these routes emit can come back out of either mapper', () => {
    for (const english of SERVER_ENGLISH) {
      for (const lang of ['en', 'es'] as const) {
        // Passed with no code at all — the worst case, and the one the rate
        // limiter actually produces.
        const fromKnows = knows.knowsBannerText(undefined, english, lang);
        const fromRulebook = rulebook.rulebookBannerText(undefined, english, lang);
        assert.notEqual(fromKnows, english, `Knows banner rendered the server string: ${english}`);
        assert.notEqual(fromRulebook, english, `Rulebook banner rendered the server string: ${english}`);
      }
    }
  });

  test('the rate limiter\'s bare token becomes a sentence, not the word "rate_limited"', () => {
    // api-ratelimit.ts answers { error: 'rate_limited' } with no envelope and
    // no code, so the token arrives in the error slot with nothing beside it.
    for (const es of [
      knows.knowsBannerText(undefined, 'rate_limited', 'es'),
      rulebook.rulebookBannerText(undefined, 'rate_limited', 'es'),
    ]) {
      assert.ok(!es.includes('rate_limited'), 'the raw token reached the screen');
      assert.ok(es.length > 10, 'the token was not turned into a sentence');
    }
    assert.notEqual(
      knows.knowsBannerText(undefined, 'rate_limited', 'es'),
      knows.knowsBannerText(undefined, 'rate_limited', 'en'),
    );
    // …and it is the SAME sentence the envelope code would produce, so a route
    // that later starts answering properly does not change what people read.
    assert.equal(
      knows.knowsBannerText(undefined, 'rate_limited', 'es'),
      knows.knowsBannerText('rate_limited', undefined, 'es'),
    );
  });
});

// ─── The success path's "how the file got read" note ────────────────────────

describe('the note about how a file got read is bilingual too', () => {
  test('both notes exist in both languages and differ from each other', () => {
    for (const mod of [
      (c: string | null, l: 'en' | 'es') => knows.knowsReadNoteText(c, l),
      (c: string | null, l: 'en' | 'es') => rulebook.rulebookReadNoteText(c, l),
    ]) {
      const truncEn = mod('file_truncated', 'en');
      const truncEs = mod('file_truncated', 'es');
      const visionEn = mod('file_read_with_ai', 'en');
      const visionEs = mod('file_read_with_ai', 'es');

      assert.ok(truncEn.length > 0 && truncEs.length > 0);
      assert.ok(visionEn.length > 0 && visionEs.length > 0);
      assert.notEqual(truncEs, truncEn, '"we read the first part" is not translated');
      assert.notEqual(visionEs, visionEn, '"we read it with AI" is not translated');
      assert.notEqual(truncEs, visionEs, 'truncation and AI-transcription say the same thing');
    }
  });

  test('no note, or a note this build does not know, adds nothing to the banner', () => {
    for (const value of [null, undefined, 'some_future_note']) {
      assert.equal(knows.knowsReadNoteText(value, 'es'), '');
      assert.equal(rulebook.rulebookReadNoteText(value, 'es'), '');
    }
  });

  test('the English readNote the server still sends is never what gets rendered', () => {
    // The server keeps sending `readNote` for compatibility. It is English, and
    // it used to be pasted onto the end of a localized headline.
    const serverReadNote = 'That file is long — Staxis read the first part of it.';
    assert.notEqual(knows.knowsReadNoteText('file_truncated', 'es'), serverReadNote);
    assert.notEqual(rulebook.rulebookReadNoteText('file_truncated', 'es'), serverReadNote);
  });
});

// ─── What the screen actually renders ───────────────────────────────────────

describe('the banner element the screens render carries the localized sentence', () => {
  test('Knows: a server refusal renders the Spanish sentence, styled as an error', () => {
    const node = knows.knowsBannerNote({ kind: 'bad', failure: { code: 'save_failed' } }, 'es');
    assert.equal(renderedText(node), knows.knowsBannerText('save_failed', undefined, 'es'));
    assert.notEqual(renderedText(node), knows.knowsBannerText('save_failed', undefined, 'en'));
    assert.ok(renderedClass(node).includes('kn-bad'));
  });

  test('Knows: an unrecognized refusal renders the generic line, not the server English', () => {
    const serverSaid = 'Could not save that';
    const node = knows.knowsBannerNote(
      { kind: 'bad', failure: { code: 'brand_new_code', serverError: serverSaid } },
      'es',
    );
    assert.ok(!renderedText(node).includes(serverSaid));
    assert.equal(renderedText(node), knows.knowsBannerText(undefined, undefined, 'es'));
  });

  test('Knows: a sentence the screen owns renders as-is, styled as good news', () => {
    const node = knows.knowsBannerNote({ kind: 'good', text: '1 dato agregado abajo' }, 'es');
    assert.equal(renderedText(node), '1 dato agregado abajo');
    assert.ok(renderedClass(node).includes('kn-good'));
  });

  test('Rulebook: a server refusal renders the Spanish sentence, styled as an error', () => {
    const node = rulebook.rulebookBannerNote(
      { kind: 'bad', failure: { code: 'company_leadership_only' } },
      'es',
    );
    assert.equal(renderedText(node), rulebook.rulebookBannerText('company_leadership_only', undefined, 'es'));
    assert.notEqual(renderedText(node), rulebook.rulebookBannerText('company_leadership_only', undefined, 'en'));
    assert.ok(renderedClass(node).includes('cr-bad'));
  });

  test('Rulebook: an unrecognized refusal renders the generic line, not the server English', () => {
    const serverSaid = 'Only company leadership can change the rulebook';
    const node = rulebook.rulebookBannerNote(
      { kind: 'bad', failure: { code: 'brand_new_code', serverError: serverSaid } },
      'es',
    );
    assert.ok(!renderedText(node).includes(serverSaid));
    assert.equal(renderedText(node), rulebook.rulebookBannerText(undefined, undefined, 'es'));
  });

  test('Rulebook: "Saved." renders as-is, styled as good news', () => {
    const node = rulebook.rulebookBannerNote({ kind: 'good', text: 'Guardado.' }, 'es');
    assert.equal(renderedText(node), 'Guardado.');
    assert.ok(renderedClass(node).includes('cr-good'));
  });
});
