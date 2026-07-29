import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { buildPortfolioConversationReplay } from '@/lib/agent/memory';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOTEL_A = '33333333-3333-4333-8333-333333333333';
const HOTEL_B = '44444444-4444-4444-8444-444444444444';
const AUTHORIZATION_HASH = 'a'.repeat(64);
const SCOPE_HASH_ALL = 'b'.repeat(64);
const SCOPE_HASH_ONE = 'c'.repeat(64);
const RECEIPT_ONE = '55555555-5555-4555-8555-555555555555';
const RECEIPT_TWO = '66666666-6666-4666-8666-666666666666';
const USER_ONE = '10000000-0000-4000-8000-000000000001';
const ASSISTANT_ONE = '10000000-0000-4000-8000-000000000002';
const USER_DANGLING = '10000000-0000-4000-8000-000000000003';
const USER_TWO = '10000000-0000-4000-8000-000000000004';
const ASSISTANT_TWO = '10000000-0000-4000-8000-000000000005';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function receipt(input: {
  id: string;
  generatedAt: string;
  question: string;
  answer: string;
  selected: string[];
  scopeHash: string;
  selector: Record<string, unknown>;
  organizationId?: string;
  authorizationHash?: string;
  status?: 'completed' | 'partial' | 'abstained' | 'authorization_changed';
  reported?: number;
}) {
  const names = new Map([
    [HOTEL_A, 'Comfort Suites'],
    [HOTEL_B, 'Lufkin Inn'],
  ]);
  const reported = input.reported ?? input.selected.length;
  return {
    id: input.id,
    account_id: ACCOUNT,
    organization_id: input.organizationId ?? ORG_A,
    conversation_id: CONVERSATION,
    authorization_hash: input.authorizationHash ?? AUTHORIZATION_HASH,
    scope_hash: input.scopeHash,
    question_hash: hash(input.question.trim()),
    answer_hash: hash(input.answer),
    authorized_property_ids: [HOTEL_A, HOTEL_B].sort(),
    selected_property_ids: [...input.selected].sort(),
    plan: { selector: input.selector },
    status: input.status ?? 'completed',
    generated_at: input.generatedAt,
    evidence: {
      organizationId: input.organizationId ?? ORG_A,
      organizationName: 'Gulf Coast Hotels',
      scopeHash: input.scopeHash,
      authorizedPropertyIds: [HOTEL_A, HOTEL_B].sort(),
      selectedPropertyIds: [...input.selected].sort(),
      facts: input.selected.slice(0, reported).map((propertyId) => ({
        propertyId,
        propertyName: names.get(propertyId),
      })),
      coverage: {
        authorized: 2,
        selected: input.selected.length,
        reported,
        excluded: input.selected.length - reported,
        excludedHotels: input.selected.slice(reported).map((propertyId) => ({
          propertyId,
          propertyName: names.get(propertyId),
        })),
      },
    },
  };
}

function replay(input?: {
  messages?: Array<Record<string, unknown>>;
  receipts?: Array<Record<string, unknown>>;
  commits?: Array<Record<string, unknown>>;
  organizationId?: string;
  authorizationHash?: string;
}) {
  const q1 = 'How are all my hotels doing?';
  const a1 = 'Both authorized hotels reported.';
  const q2 = 'What is happening at Comfort Suites?';
  const a2 = 'Comfort Suites reported 15 rooms booked.';
  return buildPortfolioConversationReplay({
    userAccountId: ACCOUNT,
    conversationId: CONVERSATION,
    organizationId: input?.organizationId ?? ORG_A,
    authorizationHash: input?.authorizationHash ?? AUTHORIZATION_HASH,
    currentAuthorizedPropertyIds: [HOTEL_A, HOTEL_B],
    messageRows: input?.messages ?? [
      { id: USER_ONE, role: 'user', content: q1, is_summary: false },
      { id: ASSISTANT_ONE, role: 'assistant', content: a1, is_summary: false },
      { id: USER_DANGLING, role: 'user', content: 'This interrupted turn has no answer.', is_summary: false },
      { id: USER_TWO, role: 'user', content: q2, is_summary: false },
      { id: ASSISTANT_TWO, role: 'assistant', content: a2, is_summary: false },
      { id: '10000000-0000-4000-8000-000000000006', role: 'assistant', content: 'A model summary is not a browser turn.', is_summary: true },
    ],
    receiptRows: input?.receipts ?? [
      receipt({
        id: RECEIPT_ONE,
        generatedAt: '2026-07-27T10:00:00.000Z',
        question: q1,
        answer: a1,
        selected: [HOTEL_A, HOTEL_B],
        scopeHash: SCOPE_HASH_ALL,
        selector: { kind: 'all_authorized' },
      }),
      receipt({
        id: RECEIPT_TWO,
        generatedAt: '2026-07-27T10:05:00.000Z',
        question: q2,
        answer: a2,
        selected: [HOTEL_A],
        scopeHash: SCOPE_HASH_ONE,
        selector: { kind: 'hotel', propertyId: HOTEL_A },
      }),
    ],
    commitRows: input?.commits ?? [
      {
        query_receipt_id: RECEIPT_ONE,
        conversation_id: CONVERSATION,
        user_message_id: USER_ONE,
        assistant_message_id: ASSISTANT_ONE,
        committed_at: '2026-07-27T10:00:01.000Z',
      },
      {
        query_receipt_id: RECEIPT_TWO,
        conversation_id: CONVERSATION,
        user_message_id: USER_TWO,
        assistant_message_id: ASSISTANT_TWO,
        committed_at: '2026-07-27T10:05:01.000Z',
      },
    ],
  });
}

describe('portfolio conversation replay', () => {
  test('restores only complete hash-matched turns with their immutable active scopes', () => {
    const result = replay();
    assert.deepEqual(result.messages, [
      { role: 'user', content: 'How are all my hotels doing?' },
      { role: 'assistant', content: 'Both authorized hotels reported.' },
      { role: 'user', content: 'What is happening at Comfort Suites?' },
      { role: 'assistant', content: 'Comfort Suites reported 15 rooms booked.' },
    ]);
    assert.equal(result.scopeDisclosures.length, 2);
    assert.deepEqual(
      result.scopeDisclosures.map((item) => ({
        turn: item.turn,
        label: item.scope.selectorLabel,
        selected: item.scope.selectedHotelCount,
        authorized: item.scope.authorizedHotelCount,
        names: item.scope.hotelNames,
      })),
      [
        {
          turn: 0,
          label: 'All authorized hotels',
          selected: 2,
          authorized: 2,
          names: ['Comfort Suites', 'Lufkin Inn'],
        },
        {
          turn: 1,
          label: 'Comfort Suites',
          selected: 1,
          authorized: 2,
          names: ['Comfort Suites'],
        },
      ],
    );
    assert.doesNotMatch(JSON.stringify(result), /authorizationHash|scopeHash|propertyId/i);
  });

  test('restores a receipted abstained turn as an honest zero-coverage answer', () => {
    const question = 'Which hotels reported today?';
    const answer = 'None of the selected hotels reported current data.';
    const abstained = receipt({
      id: RECEIPT_ONE,
      generatedAt: '2026-07-27T10:00:00.000Z',
      question,
      answer,
      selected: [HOTEL_A, HOTEL_B],
      scopeHash: SCOPE_HASH_ALL,
      selector: { kind: 'all_authorized' },
      status: 'abstained',
      reported: 0,
    });
    const result = replay({
      messages: [
        { id: USER_ONE, role: 'user', content: question, is_summary: false },
        { id: ASSISTANT_ONE, role: 'assistant', content: answer, is_summary: false },
      ],
      receipts: [abstained],
      commits: [{
        query_receipt_id: RECEIPT_ONE,
        conversation_id: CONVERSATION,
        user_message_id: USER_ONE,
        assistant_message_id: ASSISTANT_ONE,
        committed_at: '2026-07-27T10:00:01.000Z',
      }],
    });
    assert.deepEqual(result.messages, [
      { role: 'user', content: question },
      { role: 'assistant', content: answer },
    ]);
    assert.deepEqual(result.scopeDisclosures[0]?.scope.coverage, {
      reported: 0,
      total: 2,
      omitted: 2,
    });
  });

  test('refuses cross-company, stale-authorization, and tampered evidence receipts', () => {
    assert.deepEqual(replay({ organizationId: ORG_B }), { messages: [], scopeDisclosures: [] });
    assert.deepEqual(replay({ authorizationHash: 'd'.repeat(64) }), {
      messages: [],
      scopeDisclosures: [],
    });

    const q = 'How are all my hotels doing?';
    const a = 'Both authorized hotels reported.';
    const tampered = receipt({
      id: '77777777-7777-4777-8777-777777777777',
      generatedAt: '2026-07-27T10:00:00.000Z',
      question: q,
      answer: a,
      selected: [HOTEL_A],
      scopeHash: SCOPE_HASH_ALL,
      selector: { kind: 'hotel', propertyId: HOTEL_B },
    });
    assert.deepEqual(replay({
      messages: [
        { id: USER_ONE, role: 'user', content: q, is_summary: false },
        { id: ASSISTANT_ONE, role: 'assistant', content: a, is_summary: false },
      ],
      receipts: [tampered],
      commits: [{
        query_receipt_id: tampered.id,
        conversation_id: CONVERSATION,
        user_message_id: USER_ONE,
        assistant_message_id: ASSISTANT_ONE,
        committed_at: '2026-07-27T10:00:01.000Z',
      }],
    }), { messages: [], scopeDisclosures: [] });
  });

  test('uses receipt chronology when identical wording was asked at different grains', () => {
    const question = 'Status?';
    const answer = 'No material exception.';
    const result = replay({
      messages: [
        { id: USER_ONE, role: 'user', content: question, is_summary: false },
        { id: ASSISTANT_ONE, role: 'assistant', content: answer, is_summary: false },
        { id: USER_TWO, role: 'user', content: question, is_summary: false },
        { id: ASSISTANT_TWO, role: 'assistant', content: answer, is_summary: false },
      ],
      receipts: [
        receipt({
          id: '88888888-8888-4888-8888-888888888888',
          generatedAt: '2026-07-27T11:00:00.000Z',
          question,
          answer,
          selected: [HOTEL_A, HOTEL_B],
          scopeHash: SCOPE_HASH_ALL,
          selector: { kind: 'all_authorized' },
        }),
        receipt({
          id: '99999999-9999-4999-8999-999999999999',
          generatedAt: '2026-07-27T11:01:00.000Z',
          question,
          answer,
          selected: [HOTEL_A],
          scopeHash: SCOPE_HASH_ONE,
          selector: { kind: 'hotel', propertyId: HOTEL_A },
        }),
      ],
      commits: [
        {
          query_receipt_id: '88888888-8888-4888-8888-888888888888',
          conversation_id: CONVERSATION,
          user_message_id: USER_ONE,
          assistant_message_id: ASSISTANT_ONE,
          committed_at: '2026-07-27T11:00:01.000Z',
        },
        {
          query_receipt_id: '99999999-9999-4999-8999-999999999999',
          conversation_id: CONVERSATION,
          user_message_id: USER_TWO,
          assistant_message_id: ASSISTANT_TWO,
          committed_at: '2026-07-27T11:01:01.000Z',
        },
      ],
    });
    assert.deepEqual(
      result.scopeDisclosures.map((item) => item.scope.selectedHotelCount),
      [2, 1],
    );
  });
});
