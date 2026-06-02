/**
 * Phase 3.0 — write-step value scoping + the wrong-room exact-match guard.
 * Pure-logic tests (no browser needed). The DOM-level row finder is
 * exercised against the mock PMS in Phase 3.1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePayloadValue, findExactMatchIndex } from '../write-steps.js';

test('resolvePayloadValue resolves $payload.<field> values', () => {
  assert.equal(resolvePayloadValue('$payload.room_number', { room_number: '204' }), '204');
  assert.equal(resolvePayloadValue('$payload.target_status', { target_status: 'Clean' }), 'Clean');
});

test('resolvePayloadValue passes literals through unchanged', () => {
  assert.equal(resolvePayloadValue('Clean', {}), 'Clean');
  assert.equal(resolvePayloadValue('Vacant Dirty', { room_number: '1' }), 'Vacant Dirty');
});

test('resolvePayloadValue REFUSES credential placeholders (never leak creds into a write)', () => {
  assert.throws(() => resolvePayloadValue('$username', { username: 'attacker' }), /credential_placeholder_in_write_step/);
  assert.throws(() => resolvePayloadValue('$password', {}), /credential_placeholder_in_write_step/);
});

test('resolvePayloadValue fails CLOSED on an unresolved/empty payload field', () => {
  assert.throws(() => resolvePayloadValue('$payload.missing', { room_number: '204' }), /payload_placeholder_unresolved/);
  assert.throws(() => resolvePayloadValue('$payload.room_number', { room_number: '' }), /payload_placeholder_unresolved/);
});

test('findExactMatchIndex matches EXACTLY — room "10" never matches "110"', () => {
  assert.equal(findExactMatchIndex(['10', '110', '210'], '10'), 0);
  assert.equal(findExactMatchIndex(['10', '110', '210'], '110'), 1);
  assert.equal(findExactMatchIndex(['10', '110', '210'], '210'), 2);
});

test('findExactMatchIndex trims surrounding whitespace', () => {
  assert.equal(findExactMatchIndex(['  204 ', '110'], '204'), 0);
});

test('findExactMatchIndex throws row_not_found when nothing matches', () => {
  assert.throws(() => findExactMatchIndex(['10', '110'], '99'), /row_not_found/);
});

test('findExactMatchIndex refuses to guess on duplicate matches (row_not_unique)', () => {
  assert.throws(() => findExactMatchIndex(['205', '110', '205'], '205'), /row_not_unique/);
});
