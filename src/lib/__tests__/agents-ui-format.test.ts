// Agent Builder UI — presentation helpers (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickBilingual, modeLabel, formatTime12, formatTrigger, actionBadges,
  agentStatusLabel, agentStatusTone, errorToMessage,
} from '@/app/settings/agents/_lib/format';
import { S } from '@/app/settings/agents/_lib/strings';

test('pickBilingual selects by language and handles null', () => {
  assert.equal(pickBilingual({ en: 'Hello', es: 'Hola' }, 'en'), 'Hello');
  assert.equal(pickBilingual({ en: 'Hello', es: 'Hola' }, 'es'), 'Hola');
  assert.equal(pickBilingual(null, 'en'), '');
});

test('modeLabel is localized for all three modes', () => {
  assert.equal(modeLabel('suggest', 'en'), S.modeSuggest.en);
  assert.equal(modeLabel('approve_first', 'es'), S.modeApprove.es);
  assert.equal(modeLabel('auto', 'en'), S.modeAuto.en);
});

test('formatTime12 converts 24h HH:MM to 12h', () => {
  assert.equal(formatTime12('08:00', 'en'), '8:00 AM');
  assert.equal(formatTime12('13:30', 'en'), '1:30 PM');
  assert.equal(formatTime12('00:15', 'en'), '12:15 AM');
  assert.equal(formatTime12('12:00', 'en'), '12:00 PM');
  assert.equal(formatTime12('nope', 'en'), 'nope');
});

test('formatTrigger renders schedule and event triggers', () => {
  assert.equal(formatTrigger({ type: 'schedule', atLocalTime: '08:00' }, 'en'), 'Every day at 8:00 AM');
  assert.ok(formatTrigger({ type: 'schedule', atLocalTime: '08:00', daysOfWeek: [1, 3, 5] }, 'en').includes('Mon'));
  assert.equal(formatTrigger({ type: 'event', eventName: 'room.issue_reported' }, 'en'), 'A room issue is reported');
});

test('actionBadges reflects money/guest flags', () => {
  assert.deepEqual(actionBadges({ spendsMoney: true, contactsGuest: false }), ['money']);
  assert.deepEqual(actionBadges({ spendsMoney: false, contactsGuest: true }), ['guest']);
  assert.deepEqual(actionBadges({ spendsMoney: true, contactsGuest: true }), ['money', 'guest']);
  assert.deepEqual(actionBadges({ spendsMoney: false, contactsGuest: false }), []);
});

test('agent status label + tone', () => {
  assert.equal(agentStatusLabel('active', 'en'), 'Active');
  assert.equal(agentStatusLabel('archived', 'es'), 'Archivado');
  assert.equal(agentStatusTone('active'), 'sage');
  assert.equal(agentStatusTone('archived'), 'red');
});

test('errorToMessage localizes 429 and falls back gracefully', () => {
  assert.equal(errorToMessage({ status: 429, code: 'rate_limited', serverDetail: 'too many: rate_limited' }, 'en'), S.rateLimited.en);
  assert.equal(errorToMessage({ status: 429 }, 'es'), S.rateLimited.es);
  assert.equal(errorToMessage({ status: 500, serverDetail: 'boom' }, 'en'), 'boom');
  assert.equal(errorToMessage(null, 'en'), S.somethingWrong.en);
});
