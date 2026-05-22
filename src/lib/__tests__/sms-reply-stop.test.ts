/**
 * Tests for src/lib/sms-reply-keywords.ts — STOP/START/language
 * classification used by /api/sms-reply.
 *
 * Comms-voice audit P1 (2026-05-22). The pre-audit route ack'd STOP with a
 * "Thanks, open your link" reply, which is the bug we're fixing. The
 * regression guards in this file:
 *
 *   1. Single-word STOP keywords (English + Spanish) classify as 'STOP'.
 *   2. Multi-word inputs that contain a STOP keyword (e.g. "PARA MAÑANA"
 *      meaning "for tomorrow" in Spanish) do NOT classify as 'STOP'.
 *      A false-positive here would silently unsubscribe a real housekeeper.
 *   3. Punctuation around the keyword is stripped by normaliseReply()
 *      (matches the route's `normalise()` helper) so "STOP." still hits.
 *   4. The original ENGLISH/ESPAÑOL switch keywords continue to classify
 *      correctly — STOP/START detection must not regress them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReply,
  normaliseReply,
  STOP_SET,
  START_SET,
  ES_SET,
  EN_SET,
} from '@/lib/sms-reply-keywords';

describe('classifyReply — STOP detection', () => {
  test('plain STOP classifies as STOP', () => {
    assert.equal(classifyReply(normaliseReply('STOP')), 'STOP');
  });

  test('lowercase stop with trailing period classifies as STOP', () => {
    // normaliseReply strips `.!?¿¡,;:()"'\`` and uppercases.
    assert.equal(classifyReply(normaliseReply('stop.')), 'STOP');
  });

  test('STOPALL classifies as STOP', () => {
    assert.equal(classifyReply(normaliseReply('STOPALL')), 'STOP');
  });

  test('UNSUBSCRIBE classifies as STOP', () => {
    assert.equal(classifyReply(normaliseReply('unsubscribe')), 'STOP');
  });

  test('CANCEL classifies as STOP', () => {
    assert.equal(classifyReply(normaliseReply('Cancel')), 'STOP');
  });

  test('END classifies as STOP', () => {
    assert.equal(classifyReply(normaliseReply('end')), 'STOP');
  });

  test('QUIT classifies as STOP', () => {
    assert.equal(classifyReply(normaliseReply('Quit!')), 'STOP');
  });

  test('Spanish PARA (single word) classifies as STOP', () => {
    assert.equal(classifyReply(normaliseReply('para')), 'STOP');
  });

  test('Spanish ALTO classifies as STOP', () => {
    assert.equal(classifyReply(normaliseReply('Alto')), 'STOP');
  });

  test('Spanish CANCELAR classifies as STOP', () => {
    assert.equal(classifyReply(normaliseReply('cancelar')), 'STOP');
  });

  // ── THE CRITICAL FALSE-POSITIVE GUARD ──────────────────────────────────
  // If "para mañana" ("for tomorrow") classified as STOP, a Spanish-speaking
  // housekeeper texting back about scheduling would silently opt out.
  test('Spanish "PARA MAÑANA" does NOT classify as STOP (multi-word)', () => {
    assert.equal(classifyReply(normaliseReply('para mañana')), 'other');
  });

  test('English "STOP NOW" does NOT classify as STOP (multi-word)', () => {
    assert.equal(classifyReply(normaliseReply('stop now')), 'other');
  });

  test('English "CANCEL MY SHIFT" does NOT classify as STOP', () => {
    assert.equal(classifyReply(normaliseReply('cancel my shift')), 'other');
  });
});

describe('classifyReply — START detection', () => {
  test('START classifies as START', () => {
    assert.equal(classifyReply(normaliseReply('START')), 'START');
  });

  test('UNSTOP classifies as START', () => {
    assert.equal(classifyReply(normaliseReply('unstop')), 'START');
  });

  test('YES classifies as START', () => {
    assert.equal(classifyReply(normaliseReply('yes')), 'START');
  });

  test('Spanish SI classifies as START', () => {
    assert.equal(classifyReply(normaliseReply('si')), 'START');
  });

  test('Spanish SÍ (with accent) classifies as START', () => {
    assert.equal(classifyReply(normaliseReply('sí')), 'START');
  });

  test('"START WORKING" does NOT classify as START', () => {
    assert.equal(classifyReply(normaliseReply('start working')), 'other');
  });
});

describe('classifyReply — language switch keywords still work', () => {
  test('ENGLISH still classifies as EN', () => {
    assert.equal(classifyReply(normaliseReply('english')), 'EN');
  });

  test('EN still classifies as EN', () => {
    assert.equal(classifyReply(normaliseReply('EN')), 'EN');
  });

  test('ESPAÑOL still classifies as ES', () => {
    assert.equal(classifyReply(normaliseReply('Español')), 'ES');
  });

  test('SPANISH still classifies as ES', () => {
    assert.equal(classifyReply(normaliseReply('spanish')), 'ES');
  });
});

describe('classifyReply — other / unparsed', () => {
  test('arbitrary text classifies as other', () => {
    assert.equal(classifyReply(normaliseReply('thanks!')), 'other');
  });

  test('emoji-only input classifies as other', () => {
    assert.equal(classifyReply(normaliseReply('👍')), 'other');
  });

  test('empty string classifies as unparsed', () => {
    assert.equal(classifyReply(''), 'unparsed');
  });

  test('null classifies as unparsed', () => {
    assert.equal(classifyReply(null), 'unparsed');
  });

  test('undefined classifies as unparsed', () => {
    assert.equal(classifyReply(undefined), 'unparsed');
  });

  test('whitespace-only classifies as unparsed after normalise', () => {
    assert.equal(classifyReply(normaliseReply('   ')), 'unparsed');
  });
});

describe('keyword set integrity (regression catches for accidental edits)', () => {
  test('STOP_SET contains both English and Spanish keywords', () => {
    assert.ok(STOP_SET.has('STOP'));
    assert.ok(STOP_SET.has('PARA'));
    assert.ok(STOP_SET.has('CANCELAR'));
  });

  test('START_SET contains both English and Spanish keywords', () => {
    assert.ok(START_SET.has('START'));
    assert.ok(START_SET.has('SI'));
    assert.ok(START_SET.has('SÍ'));
  });

  test('ES_SET and EN_SET are disjoint from STOP/START', () => {
    for (const k of ES_SET) {
      assert.ok(!STOP_SET.has(k), `ES_SET keyword ${k} also in STOP_SET`);
      assert.ok(!START_SET.has(k), `ES_SET keyword ${k} also in START_SET`);
    }
    for (const k of EN_SET) {
      assert.ok(!STOP_SET.has(k), `EN_SET keyword ${k} also in STOP_SET`);
      assert.ok(!START_SET.has(k), `EN_SET keyword ${k} also in START_SET`);
    }
  });

  test('STOP_SET and START_SET are disjoint', () => {
    for (const k of STOP_SET) {
      assert.ok(!START_SET.has(k), `keyword ${k} in both STOP_SET and START_SET`);
    }
  });
});
