/**
 * Consolidation extraction-parser tests (pure). The nightly engine asks Claude
 * for a strict JSON object; parseExtraction must be robust to prose wrappers,
 * code fences, malformed entries, and never throw — a bad night should learn
 * nothing, not crash the cron.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseExtraction } from '@/lib/agent/memory-consolidate';

describe('parseExtraction', () => {
  test('parses a clean JSON object', () => {
    const r = parseExtraction(
      '{"recap":"Learned the breakfast name.","facts":[{"topic":"breakfast_area_name","content":"The breakfast area is the bistro."}]}',
    );
    assert.equal(r.recap, 'Learned the breakfast name.');
    assert.equal(r.facts.length, 1);
    assert.equal(r.facts[0].topic, 'breakfast_area_name');
  });

  test('parses JSON wrapped in prose / code fences', () => {
    const r = parseExtraction('Sure:\n```json\n{"recap":"x","facts":[{"topic":"a","content":"b"}]}\n```\nDone.');
    assert.equal(r.facts.length, 1);
    assert.equal(r.recap, 'x');
  });

  test('returns empty (no throw) when no JSON is present', () => {
    const r = parseExtraction('Nothing structured here.');
    assert.deepEqual(r.facts, []);
    assert.equal(r.recap, '');
  });

  test('malformed JSON → empty, never throws', () => {
    const r = parseExtraction('{"recap":"x","facts":[{"topic":"a",}');
    assert.deepEqual(r.facts, []);
  });

  test('filters out malformed fact entries', () => {
    const r = parseExtraction('{"facts":[{"topic":"ok","content":"c"},{"topic":123},{"content":"no topic"},null]}');
    assert.equal(r.facts.length, 1);
    assert.equal(r.facts[0].topic, 'ok');
  });

  test('caps at 8 facts', () => {
    const many = Array.from({ length: 20 }, (_v, i) => ({ topic: `t${i}`, content: `c${i}` }));
    const r = parseExtraction(JSON.stringify({ recap: '', facts: many }));
    assert.equal(r.facts.length, 8);
  });

  test('non-array facts → empty', () => {
    const r = parseExtraction('{"recap":"x","facts":"nope"}');
    assert.deepEqual(r.facts, []);
  });
});
