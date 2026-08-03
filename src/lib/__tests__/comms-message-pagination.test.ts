import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { validateIsoTimestamp } from '@/lib/api-validate';
import { channelsVisibleTo, staffInChannel } from '@/lib/comms/core';
import {
  MESSAGE_PAGE_SIZE,
  mergeMessagesChronologically,
} from '@/lib/comms/message-pagination';
import type { MessageDTO } from '@/lib/comms/types';

function message(id: string, createdAt: string, body = id): MessageDTO {
  return {
    id,
    conversationId: 'conversation-1',
    senderStaffId: null,
    senderKind: 'system',
    senderName: 'System',
    body,
    originalBody: body,
    sourceLang: 'en',
    wasTranslated: false,
    msgType: 'text',
    attachmentKind: null,
    attachmentUrl: null,
    voiceDurationMs: null,
    handoffShift: null,
    handoffOutstanding: null,
    meta: {},
    createdAt,
    mine: false,
  };
}

describe('communications message pagination contracts', () => {
  test('accepts ISO cursors and rejects ambiguous or invalid timestamps', () => {
    assert.deepEqual(
      validateIsoTimestamp('2026-08-02T12:34:56.123-05:00', 'before'),
      { value: '2026-08-02T12:34:56.123-05:00' },
    );
    assert.match(validateIsoTimestamp('2026-08-02', 'before').error ?? '', /ISO timestamp/);
    assert.match(validateIsoTimestamp('2026-02-30T00:00:00.000Z', 'before').error ?? '', /real date/);
    assert.match(validateIsoTimestamp('not-a-date', 'before').error ?? '', /ISO timestamp/);
    assert.match(validateIsoTimestamp(null, 'before').error ?? '', /must be a string/);
  });

  test('merges an older page with a poll page in chronological order without duplicates', () => {
    const initial = [
      message('new', '2026-08-02T12:00:00.000Z'),
      message('latest', '2026-08-02T12:05:00.000Z'),
    ];
    const olderPage = [
      message('oldest', '2026-08-02T11:00:00.000Z'),
      message('new', '2026-08-02T12:00:00.000Z', 'refreshed body'),
    ];
    const merged = mergeMessagesChronologically(initial, olderPage);
    assert.deepEqual(merged.map((item) => item.id), ['oldest', 'new', 'latest']);
    assert.equal(merged[1]?.body, 'refreshed body');
    assert.equal(new Set(merged.map((item) => item.id)).size, merged.length);
    assert.equal(MESSAGE_PAGE_SIZE, 80);
  });

  test('staff membership is exactly the channel visibility predicate', () => {
    for (const department of ['front_desk', 'housekeeping', 'maintenance', 'other', null]) {
      for (const isManager of [false, true]) {
        const visible = channelsVisibleTo({ dept: department, isManager });
        for (const channel of ['all_staff', 'front_desk', 'housekeeping', 'maintenance'] as const) {
          assert.equal(
            staffInChannel(channel, { department, isManager }),
            visible.includes(channel),
            `department=${department} manager=${isManager} channel=${channel}`,
          );
        }
      }
    }
    assert.equal(staffInChannel('front_desk', { department: null, isManager: false }), false);
    assert.equal(staffInChannel('front_desk', { department: 'other', isManager: false }), false);
    assert.equal(staffInChannel('front_desk', { department: 'other', isManager: true }), true);
  });
});
