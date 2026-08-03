import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createClient } from '@supabase/supabase-js';

import { validateIsoTimestamp } from '@/lib/api-validate';
import {
  channelsVisibleTo,
  managerStaffIdsFromAuthority,
  staffInChannel,
} from '@/lib/comms/core';
import {
  MESSAGE_PAGE_SIZE,
  compositeMessageCursorFilter,
  mergeMessageRowsChronologically,
  mergeMessagesChronologically,
  messagePaginationForBaseRows,
  paginateMessageRows,
} from '@/lib/comms/message-pagination';
import type { MessageCursor } from '@/lib/comms/message-pagination';
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

interface ParsedPostgrestFilter {
  column: string;
  operator: string;
  value: string;
}

/** Split PostgREST's comma-separated filter grammar without splitting quotes. */
function splitPostgrestFilterList(input: string): string[] {
  const body = input.startsWith('(') && input.endsWith(')')
    ? input.slice(1, -1)
    : input;
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }

  assert.equal(quoted, false, 'decoded PostgREST filter must close quoted values');
  assert.equal(depth, 0, 'decoded PostgREST filter must balance parentheses');
  parts.push(body.slice(start));
  return parts;
}

function splitPostgrestFilterPath(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
    } else if (character === '.') {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function parsePostgrestFilter(input: string, requireQuotedValue = false): ParsedPostgrestFilter {
  const path = splitPostgrestFilterPath(input);
  const [column, operator, rawValue] = path;
  assert.ok(column && operator && rawValue, `invalid filter arm: ${input}`);
  assert.equal(path.length, 3);
  const isQuoted = rawValue.startsWith('"') && rawValue.endsWith('"');
  if (requireQuotedValue) assert.ok(isQuoted, 'timestamp value must be quoted');
  return {
    column,
    operator,
    value: isQuoted ? rawValue.slice(1, -1).replace(/\\(["\\])/g, '$1') : rawValue,
  };
}

function parseCompositePostgrestFilter(input: string): {
  older: ParsedPostgrestFilter;
  sameTime: ParsedPostgrestFilter;
  id: ParsedPostgrestFilter;
} {
  const [olderArm, tiedArm] = splitPostgrestFilterList(input);
  assert.ok(olderArm && tiedArm);
  assert.match(tiedArm, /^and\(.+\)$/);
  const [sameTimeArm, idArm] = splitPostgrestFilterList(tiedArm.slice(4, -1));
  assert.ok(sameTimeArm && idArm);
  return {
    older: parsePostgrestFilter(olderArm, true),
    sameTime: parsePostgrestFilter(sameTimeArm, true),
    id: parsePostgrestFilter(idArm),
  };
}

async function decodedCompositeFilterFromQuery(cursor: MessageCursor): Promise<string> {
  const requests: Request[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    return new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createClient('https://placeholder.supabase.co', 'test-anon-key', {
    global: { fetch: fetcher },
  });

  const { error } = await client
    .from('comms_messages')
    .select('id,created_at')
    .or(compositeMessageCursorFilter(cursor))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);
  assert.equal(error, null);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(new URL(request.url).pathname, '/rest/v1/comms_messages');
  const decodedFilter = new URL(request.url).searchParams.get('or');
  assert.ok(decodedFilter);
  return decodedFilter;
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

  test('quotes timestamp operands in the actual Supabase request and crosses tied boundaries', async () => {
    const beforeId = '00000000-0000-0000-0000-000000000080';
    const tiedOlderId = '00000000-0000-0000-0000-00000000007f';
    const tiedNewestId = '00000000-0000-0000-0000-000000000081';
    const cases = [
      '2026-08-02T12:34:56.123Z',
      '2026-08-02T12:34:56.123-05:00',
      '2026-08-02T12:34:56.123+05:30',
    ];

    for (const before of cases) {
      const cursor = { before, beforeId };
      const decodedFilter = await decodedCompositeFilterFromQuery(cursor);
      const parsed = parseCompositePostgrestFilter(decodedFilter);

      assert.deepEqual(parsed, {
        older: { column: 'created_at', operator: 'lt', value: before },
        sameTime: { column: 'created_at', operator: 'eq', value: before },
        id: { column: 'id', operator: 'lt', value: beforeId },
      });

      // Apply the decoded adapter grammar to rows around the boundary. The
      // two rows at the cursor timestamp prove the id arm is traversable;
      // the timestamp arm proves older timestamps still pass the same filter.
      const cursorTime = Date.parse(parsed.sameTime.value);
      const rows = [
        { id: tiedOlderId, created_at: before },
        { id: beforeId, created_at: before },
        { id: tiedNewestId, created_at: before },
        { id: '00000000-0000-0000-0000-000000000001', created_at: before },
        { id: '00000000-0000-0000-0000-000000000090', created_at: new Date(cursorTime + 1_000).toISOString() },
        { id: '00000000-0000-0000-0000-000000000002', created_at: new Date(cursorTime - 1_000).toISOString() },
      ];
      const matchingRows = rows.filter((row) => {
        const rowTime = Date.parse(row.created_at);
        return rowTime < cursorTime || (rowTime === cursorTime && row.id < parsed.id.value);
      });

      assert.deepEqual(matchingRows.map((row) => row.id), [
        tiedOlderId,
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
      ]);
    }
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
