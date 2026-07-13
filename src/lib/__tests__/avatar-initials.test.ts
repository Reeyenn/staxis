// Edge-case tests for the shared avatar initials + hash helpers
// (src/app/_components/ui/Avatar.tsx). Pure logic only — the component
// itself is presentation and is exercised by each area when it migrates.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { initialsOf, hashString31 } from '@/app/_components/ui/Avatar';

describe('initialsOf', () => {
  test('two-word name: first letter of first + last word, uppercased', () => {
    assert.equal(initialsOf('Maria Garcia'), 'MG');
    assert.equal(initialsOf('john smith'), 'JS');
  });

  test('three-plus words: first + LAST word (middle names skipped)', () => {
    assert.equal(initialsOf('Ana Maria Lopez'), 'AL');
  });

  test('single name: first two characters uppercased', () => {
    assert.equal(initialsOf('Cher'), 'CH');
  });

  test('single character name', () => {
    assert.equal(initialsOf('X'), 'X');
  });

  test('empty string returns the default fallback', () => {
    assert.equal(initialsOf(''), '?');
  });

  test('whitespace-only returns the fallback', () => {
    assert.equal(initialsOf('   \t '), '?');
  });

  test('custom fallback (staff area uses "??")', () => {
    assert.equal(initialsOf('', '??'), '??');
    assert.equal(initialsOf('  ', '??'), '??');
  });

  test('null-ish input is tolerated', () => {
    assert.equal(initialsOf(null as unknown as string), '?');
    assert.equal(initialsOf(undefined as unknown as string), '?');
  });

  test('extra internal whitespace is collapsed', () => {
    assert.equal(initialsOf('  Maria   Garcia  '), 'MG');
  });

  test('unicode names uppercase correctly', () => {
    assert.equal(initialsOf('José Álvarez'), 'JÁ');
    assert.equal(initialsOf('émile zola'), 'ÉZ');
    assert.equal(initialsOf('ñandú'), 'ÑA');
  });

  test('non-Latin scripts keep their leading characters', () => {
    assert.equal(initialsOf('田中 太郎'), '田太');
    assert.equal(initialsOf('Иван Петров'), 'ИП');
  });
});

describe('hashString31', () => {
  test('deterministic and non-negative', () => {
    const a = hashString31('some-staff-uuid');
    assert.equal(a, hashString31('some-staff-uuid'));
    assert.ok(a >= 0);
    assert.ok(hashString31('') >= 0);
  });

  test('matches the staff-area recurrence (h*31 + code, |0, abs)', () => {
    // 'ab' → (0*31+97)*31 + 98 = 3105
    assert.equal(hashString31('ab'), 3105);
  });

  test('stable palette assignment for a 6-tone palette', () => {
    const idx = hashString31('maria garcia') % 6;
    assert.ok(idx >= 0 && idx < 6);
    assert.equal(idx, hashString31('maria garcia') % 6);
  });
});
