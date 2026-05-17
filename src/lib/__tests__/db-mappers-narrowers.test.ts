// Tests for the runtime narrowers added to db-mappers.ts.
// These exist to lock in the "wrong-typed input → safe fallback" contract.
// If a future change makes the helpers throw on bad input we want to know.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStringField,
  parseStringFieldOr,
  parseBoolField,
  parseNumberField,
  parseUnionField,
  parseOptionalUnionField,
  parseArrayField,
  parseRecordField,
} from '@/lib/db-mappers';

test('parseStringField: returns string, undefined for non-strings', () => {
  assert.equal(parseStringField('hi'), 'hi');
  assert.equal(parseStringField(''), '');
  assert.equal(parseStringField(null), undefined);
  assert.equal(parseStringField(undefined), undefined);
  assert.equal(parseStringField(123), undefined);
  assert.equal(parseStringField({}), undefined);
  assert.equal(parseStringField([]), undefined);
});

test('parseStringFieldOr: falls back on non-strings', () => {
  assert.equal(parseStringFieldOr('hi', 'fb'), 'hi');
  assert.equal(parseStringFieldOr(null, 'fb'), 'fb');
  assert.equal(parseStringFieldOr(0, 'fb'), 'fb');
});

test('parseBoolField: only true/false; undefined otherwise', () => {
  assert.equal(parseBoolField(true), true);
  assert.equal(parseBoolField(false), false);
  assert.equal(parseBoolField('true'), undefined);
  assert.equal(parseBoolField(1), undefined);
  assert.equal(parseBoolField(null), undefined);
});

test('parseNumberField: finite numbers only', () => {
  assert.equal(parseNumberField(0), 0);
  assert.equal(parseNumberField(3.14), 3.14);
  assert.equal(parseNumberField(-1), -1);
  assert.equal(parseNumberField(NaN), undefined);
  assert.equal(parseNumberField(Infinity), undefined);
  assert.equal(parseNumberField('1'), undefined);
  assert.equal(parseNumberField(null), undefined);
});

test('parseUnionField: returns value when in allowed set, else fallback', () => {
  const allowed = ['a', 'b', 'c'] as const;
  assert.equal(parseUnionField('a', allowed, 'c'), 'a');
  assert.equal(parseUnionField('b', allowed, 'c'), 'b');
  assert.equal(parseUnionField('z', allowed, 'c'), 'c');
  assert.equal(parseUnionField(null, allowed, 'c'), 'c');
  assert.equal(parseUnionField(undefined, allowed, 'c'), 'c');
  assert.equal(parseUnionField(123, allowed, 'c'), 'c');
});

test('parseOptionalUnionField: returns undefined for out-of-set', () => {
  const allowed = ['en', 'es'] as const;
  assert.equal(parseOptionalUnionField('en', allowed), 'en');
  assert.equal(parseOptionalUnionField('es', allowed), 'es');
  assert.equal(parseOptionalUnionField('fr', allowed), undefined);
  assert.equal(parseOptionalUnionField(null, allowed), undefined);
});

test('parseArrayField: filters non-array shapes', () => {
  const coerceStr = (x: unknown) => typeof x === 'string' ? x : undefined;
  assert.deepEqual(parseArrayField(['a', 'b'], coerceStr), ['a', 'b']);
  assert.deepEqual(parseArrayField(['a', 1, 'b'], coerceStr), ['a', 'b']);
  assert.deepEqual(parseArrayField(null, coerceStr), []);
  assert.deepEqual(parseArrayField('a,b', coerceStr), []);
  assert.deepEqual(parseArrayField({ 0: 'a' }, coerceStr), []);
});

test('parseRecordField: undefined for non-object, filters bad values', () => {
  const coerceBool = (x: unknown) => typeof x === 'boolean' ? x : undefined;
  assert.deepEqual(parseRecordField({ a: true, b: false }, coerceBool), { a: true, b: false });
  assert.deepEqual(parseRecordField({ a: true, b: 'nope', c: false }, coerceBool), { a: true, c: false });
  assert.equal(parseRecordField(null, coerceBool), undefined);
  assert.equal(parseRecordField('x', coerceBool), undefined);
  assert.equal(parseRecordField([true, false], coerceBool), undefined);  // arrays are objects but rejected
});
