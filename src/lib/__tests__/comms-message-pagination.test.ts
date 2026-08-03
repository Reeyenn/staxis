import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { validateIsoTimestamp } from '@/lib/api-validate';
import {
  channelsVisibleTo,
  managerStaffIdsFromAuthority,
  staffInChannel,
} from '@/lib/comms/core';
import {
  MESSAGE_PAGE_SIZE,
  mergeMessageRowsChronologically,
  mergeMessagesChronologically,
  messagePaginationForBaseRows,
  paginateMessageRows,
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

  test('reaches every tied timestamp exactly once with the composite cursor', () => {
    const timestamp = '2026-08-02T12:00:00.000Z';
    const rows = Array.from({ length: 161 }, (_, index) => ({
      id: `message-${String(index).padStart(3, '0')}`,
      created_at: timestamp,
    }));
    const seen: string[] = [];
    let cursor: { before: string; beforeId: string } | null = null;
    let pages = 0;
    while (true) {
      const page: {
        rows: { id: string; created_at: string }[];
        pagination: { hasOlder: boolean; nextCursor: { before: string; beforeId: string } | null };
      } = paginateMessageRows<{ id: string; created_at: string }>(rows, cursor);
      pages += 1;
      seen.push(...page.rows.map((row) => row.id));
      if (!page.pagination.hasOlder) break;
      assert.ok(page.pagination.nextCursor);
      cursor = page.pagination.nextCursor;
    }

    assert.equal(pages, 3);
    assert.equal(seen.length, rows.length);
    assert.equal(new Set(seen).size, rows.length);
    assert.deepEqual(new Set(seen), new Set(rows.map((row) => row.id)));
  });

  test('base-page metadata keeps intermediate history reachable around required-ack expansion', () => {
    const rows = Array.from({ length: 161 }, (_, index) => ({
      id: `message-${String(index).padStart(3, '0')}`,
      created_at: new Date(Date.UTC(2026, 7, 2, 12, index)).toISOString(),
    }));
    const basePage = paginateMessageRows(rows);
    const requiredAckRow = rows[0]!;
    const displayed = mergeMessageRowsChronologically(basePage.rows, [requiredAckRow]);
    const serverMetadata = messagePaginationForBaseRows(basePage.rows);

    // The displayed first row is the mandatory-ack expansion, but the next
    // cursor must remain the boundary of the bounded base query.
    assert.equal(displayed[0]?.id, requiredAckRow.id);
    assert.deepEqual(serverMetadata.nextCursor, basePage.pagination.nextCursor);
    assert.notEqual(serverMetadata.nextCursor?.beforeId, displayed[0]?.id);

    let allDisplayed = displayed;
    let cursor = serverMetadata.nextCursor;
    while (serverMetadata.hasOlder || cursor) {
      if (!cursor) break;
      const page = paginateMessageRows<{ id: string; created_at: string }>(rows, cursor);
      allDisplayed = mergeMessageRowsChronologically(allDisplayed, page.rows);
      cursor = page.pagination.nextCursor;
      if (!page.pagination.hasOlder) break;
    }

    assert.equal(allDisplayed.length, rows.length);
    assert.equal(new Set(allDisplayed.map((row) => row.id)).size, rows.length);
    assert.deepEqual(new Set(allDisplayed.map((row) => row.id)), new Set(rows.map((row) => row.id)));
    assert.ok(allDisplayed.some((row) => row.id === 'message-080'));
  });

  test('legacy manager pointers are accepted only with current property authority', () => {
    const propertyId = 'property-1';
    const managers = managerStaffIdsFromAuthority({
      pid: propertyId,
      linkedRows: [
        { accountId: 'normalized-manager', staffId: 'staff-normalized', propertyId, isActive: true },
        { accountId: 'normalized-staff', staffId: 'staff-property-manager', propertyId, isActive: true },
      ],
      legacyRows: [
        { accountId: 'legacy-allowed', staffId: 'staff-allowed' },
        { accountId: 'legacy-stale', staffId: 'staff-stale' },
      ],
      accounts: [
        { id: 'normalized-manager', role: 'general_manager', active: true },
        { id: 'normalized-staff', role: 'staff', active: true },
        { id: 'legacy-allowed', role: 'general_manager', active: true },
        { id: 'legacy-stale', role: 'general_manager', active: true },
      ],
      authorityByAccount: new Map([
        ['normalized-staff', { propertyId, operationalRole: 'general_manager' }],
        ['legacy-allowed', { propertyId, operationalRole: 'general_manager' }],
        ['legacy-stale', { propertyId: 'property-2', operationalRole: 'general_manager' }],
      ]),
    });

    assert.ok(managers.has('staff-normalized'));
    assert.ok(managers.has('staff-property-manager'));
    assert.ok(managers.has('staff-allowed'));
    assert.equal(managers.has('staff-stale'), false);
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
