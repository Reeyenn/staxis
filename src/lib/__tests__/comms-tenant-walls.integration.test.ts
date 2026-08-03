/**
 * Real-handler tenant and channel-wall tests for Communications.
 *
 * These tests deliberately run the route handlers against the production
 * migrations and a PostgREST-shaped client backed by real PGlite queries.
 * The access decisions therefore use the same account authority, property
 * context, staff identities, channel rows, and message rows as production.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
// Local test break-glass: route behavior is the subject of these tests, not
// the trusted-device half of requireSession.
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
process.env.TZ = 'America/Chicago';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { POST as dmPost } from '@/app/api/comms/dm/route';
import { GET as logbookRepliesGet, POST as logbookRepliesPost } from '@/app/api/comms/logbook/replies/route';
import { GET as messagesGet } from '@/app/api/comms/messages/route';
import { GET as pinGet, POST as pinPost } from '@/app/api/comms/pin/route';
import { POST as reactPost } from '@/app/api/comms/react/route';
import { GET as searchGet } from '@/app/api/comms/search/route';
import { POST as sendPost } from '@/app/api/comms/send/route';
import { GET as threadGet } from '@/app/api/comms/thread/route';
import { POST as floorReadPost } from '@/app/api/housekeeper/messages/read/route';
import { POST as floorSendPost } from '@/app/api/housekeeper/messages/send/route';
import { POST as floorThreadPost } from '@/app/api/housekeeper/messages/thread/route';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  createLogEntry,
  createLogReply,
  ensureChannelConversation,
  ensureDmConversation,
  listConversationsForStaff,
  postMessage,
} from '@/lib/comms/core';
import { mintStaffLinkToken } from '@/lib/staff-auth';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  PID_A1,
  PID_B1,
  UID_FRANK,
  UID_GIL,
  UID_MARIA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

let currentUser: string | null = UID_MARIA;

let mariaStaff = '';
let frontDeskStaff = '';
let floorStaff = '';
let hotelBStaff = '';
let floorLinkToken = '';

let allStaffConversation = '';
let frontDeskConversation = '';
let housekeepingConversation = '';
let hotelBConversation = '';
let dmConversation = '';
let authorizedChannelMessage = '';
let hotelBMessage = '';
let hotelBLogEntry = '';
let authorizedLogEntry = '';

const STALE_CHANNEL_NEEDLE = 'STALE_HOUSEKEEPING_NEEDLE';
const CROSS_PROPERTY_NEEDLE = 'CROSS_PROPERTY_NEEDLE';

interface ApiEnvelope<T = unknown> {
  ok: boolean;
  requestId?: string;
  data?: T;
  error?: string;
  code?: string;
}

interface MessageData {
  conversation: { id: string; kind: string; channelKey?: string | null; title?: string | null };
  messages: Array<{ id: string; body: string }>;
}

interface ThreadData {
  parent: { id: string; body: string } | null;
  replies: Array<{ id: string; body: string }>;
}

interface SearchData {
  hits: Array<{ kind: string; conversationId: string | null; snippet: string | null }>;
}

async function one<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await pg.query<T>(sql, params);
  return result.rows[0] ?? null;
}

async function addStaff(
  propertyId: string,
  name: string,
  department: 'housekeeping' | 'front_desk' | 'maintenance' | 'other',
  authUserId: string | null = null,
): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into staff (property_id, name, department, auth_user_id, is_active, language)
     values ($1, $2, $3, $4, true, 'en')
     returning id`,
    [propertyId, name, department, authUserId],
  );
  assert.ok(row?.id, `staff row was not created for ${name}`);
  return row.id;
}

function getReq(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { authorization: 'Bearer comms-tenant-walls-test-token' },
  });
}

function postReq(url: string, body: Record<string, unknown>, bearer = true): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      ...(bearer ? { authorization: 'Bearer comms-tenant-walls-test-token' } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function envelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  return (await response.json()) as ApiEnvelope<T>;
}

function assertRequestId(body: ApiEnvelope): void {
  assert.equal(typeof body.requestId, 'string', 'the standard envelope carries a request id');
}

async function assertError(
  response: Response,
  status: number,
  code: string,
  error: string,
): Promise<ApiEnvelope> {
  const body = await envelope(response);
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.ok, false, JSON.stringify(body));
  assert.equal(body.code, code, JSON.stringify(body));
  assert.equal(body.error, error, JSON.stringify(body));
  assertRequestId(body);
  assert.deepEqual(
    Object.keys(body).sort(),
    ['code', 'error', 'ok', 'requestId'],
    'non-leaking refusals keep the standard error envelope only',
  );
  return body;
}

async function success<T>(response: Response, status = 200): Promise<T> {
  const body = await envelope<T>(response);
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  assertRequestId(body);
  assert.ok(body.data !== undefined, JSON.stringify(body));
  return body.data as T;
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);

  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  supabaseAdmin.auth.getUser = (async () =>
    currentUser
      ? { data: { user: { id: currentUser, email: `${currentUser}@comms.test` } }, error: null }
      : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } }) as unknown as typeof supabaseAdmin.auth.getUser;

  await seedTwoCompanies(pg);

  // Explicit auth_user_id rows make the real account-to-property staff
  // resolver choose these identities rather than creating a fallback row.
  mariaStaff = await addStaff(PID_A1, 'Maria Manager', 'other', UID_MARIA);
  frontDeskStaff = await addStaff(PID_A1, 'Frank Front Desk', 'front_desk', UID_FRANK);
  floorStaff = await addStaff(PID_A1, 'Rosa Housekeeping', 'housekeeping');
  hotelBStaff = await addStaff(PID_B1, 'Gil Tyler Manager', 'other', UID_GIL);

  allStaffConversation = await ensureChannelConversation(PID_A1, 'all_staff');
  frontDeskConversation = await ensureChannelConversation(PID_A1, 'front_desk');
  housekeepingConversation = await ensureChannelConversation(PID_A1, 'housekeeping');
  hotelBConversation = await ensureChannelConversation(PID_B1, 'all_staff');
  dmConversation = await ensureDmConversation(PID_A1, mariaStaff, frontDeskStaff);

  const channelParent = await postMessage(PID_A1, allStaffConversation, {
    senderStaffId: frontDeskStaff,
    body: 'AUTHORIZED_CHANNEL_PARENT',
    sourceLang: 'en',
  });
  authorizedChannelMessage = channelParent.id;
  await postMessage(PID_A1, allStaffConversation, {
    senderStaffId: mariaStaff,
    body: 'AUTHORIZED_CHANNEL_REPLY',
    sourceLang: 'en',
    parentMessageId: channelParent.id,
  });

  await postMessage(PID_A1, dmConversation, {
    senderStaffId: frontDeskStaff,
    body: 'AUTHORIZED_DM_MESSAGE',
    sourceLang: 'en',
  });

  const bParent = await postMessage(PID_B1, hotelBConversation, {
    senderStaffId: hotelBStaff,
    body: 'HOTEL_B_MESSAGE',
    sourceLang: 'en',
  });
  hotelBMessage = bParent.id;
  await postMessage(PID_B1, hotelBConversation, {
    senderStaffId: hotelBStaff,
    body: 'HOTEL_B_REPLY',
    sourceLang: 'en',
    parentMessageId: bParent.id,
  });

  // A stale membership is intentionally planted for a channel the front desk
  // department cannot reach. The real list code must not treat it as a DM.
  await pg.query(
    `insert into comms_members (property_id, conversation_id, staff_id, last_read_at)
     values ($1, $2, $3, '2026-01-01T00:00:00.000Z')`,
    [PID_A1, housekeepingConversation, frontDeskStaff],
  );
  await postMessage(PID_A1, housekeepingConversation, {
    senderStaffId: floorStaff,
    body: STALE_CHANNEL_NEEDLE,
    sourceLang: 'en',
  });

  // The message is attached to an A conversation but carries a B property id.
  // This is the cross-property shape the search property predicate must reject.
  await pg.query(
    `insert into comms_messages
       (property_id, conversation_id, sender_staff_id, sender_kind, body, source_lang, msg_type)
     values ($1, $2, $3, 'staff', $4, 'en', 'text')`,
    [PID_B1, frontDeskConversation, hotelBStaff, CROSS_PROPERTY_NEEDLE],
  );

  const bLog = await createLogEntry(PID_B1, {
    authorStaffId: hotelBStaff,
    title: 'Hotel B recap',
    body: 'Hotel B private recap',
  });
  hotelBLogEntry = bLog.id;
  await createLogReply(PID_B1, hotelBLogEntry, {
    authorStaffId: hotelBStaff,
    body: 'Hotel B private reply',
  });

  const aLog = await createLogEntry(PID_A1, {
    authorStaffId: frontDeskStaff,
    title: 'Hotel A recap',
    body: 'Hotel A authorized recap',
  });
  authorizedLogEntry = aLog.id;
  await createLogReply(PID_A1, authorizedLogEntry, {
    authorStaffId: frontDeskStaff,
    body: 'Hotel A authorized reply',
  });

  // Use the production token minting helper so the public route verifies a
  // real hashed staff-link row, not a mocked auth response.
  floorLinkToken = await mintStaffLinkToken(floorStaff, PID_A1);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

beforeEach(() => {
  currentUser = UID_MARIA;
});

describe('authenticated tenant walls', () => {
  test('hotel A cannot use hotel B conversations or logbook entries', async () => {
    currentUser = UID_MARIA;

    const cases: Array<{ label: string; expectedError?: string; run: () => Promise<Response> }> = [
      {
        label: 'messages GET',
        run: () => messagesGet(getReq(
          `https://staxis.test/api/comms/messages?pid=${PID_A1}&conversationId=${hotelBConversation}`,
        )),
      },
      {
        label: 'thread GET',
        run: () => threadGet(getReq(
          `https://staxis.test/api/comms/thread?pid=${PID_A1}&conversationId=${hotelBConversation}&parentId=${hotelBMessage}`,
        )),
      },
      {
        label: 'send POST',
        run: () => sendPost(postReq('https://staxis.test/api/comms/send', {
          pid: PID_A1,
          conversationId: hotelBConversation,
          body: 'cross-tenant write must not land',
        })),
      },
      {
        label: 'pin GET',
        run: () => pinGet(getReq(
          `https://staxis.test/api/comms/pin?pid=${PID_A1}&conversationId=${hotelBConversation}`,
        )),
      },
      {
        label: 'pin POST',
        run: () => pinPost(postReq('https://staxis.test/api/comms/pin', {
          pid: PID_A1,
          messageId: hotelBMessage,
          pinned: true,
        })),
      },
      {
        label: 'react POST',
        run: () => reactPost(postReq('https://staxis.test/api/comms/react', {
          pid: PID_A1,
          messageId: hotelBMessage,
        })),
      },
      {
        label: 'logbook replies POST',
        expectedError: 'Recap not found',
        run: () => logbookRepliesPost(postReq('https://staxis.test/api/comms/logbook/replies', {
          pid: PID_A1,
          entryId: hotelBLogEntry,
          body: 'cross-tenant reply must not land',
        })),
      },
    ];

    for (const item of cases) {
      const response = await item.run();
      await assertError(response, 404, 'not_found', item.expectedError ?? 'Not found');
    }

    const foreignReplies = await logbookRepliesGet(getReq(
      `https://staxis.test/api/comms/logbook/replies?pid=${PID_A1}&entryId=${hotelBLogEntry}`,
    ));
    const foreignReplyData = await success<{ replies: unknown[] }>(foreignReplies);
    assert.deepEqual(foreignReplyData.replies, [], 'a foreign logbook read is empty and reveals no reply data');
  });

  test('DM open refuses a hotel B staff id and accepts a same-property staff id', async () => {
    currentUser = UID_MARIA;

    const foreign = await dmPost(postReq('https://staxis.test/api/comms/dm', {
      pid: PID_A1,
      otherStaffId: hotelBStaff,
    }));
    await assertError(foreign, 404, 'not_found', 'Not found');

    const local = await dmPost(postReq('https://staxis.test/api/comms/dm', {
      pid: PID_A1,
      otherStaffId: frontDeskStaff,
    }));
    const localData = await success<{ conversationId: string }>(local);
    assert.equal(localData.conversationId, dmConversation);
  });
});

describe('authenticated channel walls', () => {
  test('a front-desk non-manager cannot read housekeeping, including through stale membership', async () => {
    currentUser = UID_FRANK;

    const direct = await messagesGet(getReq(
      `https://staxis.test/api/comms/messages?pid=${PID_A1}&conversationId=${housekeepingConversation}`,
    ));
    await assertError(direct, 403, 'forbidden', 'Forbidden');

    const listed = await listConversationsForStaff(PID_A1, frontDeskStaff, {
      isManager: false,
      dept: 'front_desk',
      floorMode: false,
    });
    assert.equal(
      listed.some((conversation) => conversation.id === housekeepingConversation),
      false,
      'the real conversation list excludes a stale invisible channel',
    );

    assert.equal(
      listed.some((conversation) => conversation.id === frontDeskConversation),
      true,
      `the front-desk channel remains available to its department: ${JSON.stringify(listed)}`,
    );

    const staleMembership = await one<{ id: string }>(
      `select id from comms_members
       where property_id = $1 and conversation_id = $2 and staff_id = $3`,
      [PID_A1, housekeepingConversation, frontDeskStaff],
    );
    assert.ok(staleMembership?.id, 'the stale membership was present in the real database');
  });

  test('search returns no hits or snippets from stale or cross-property channels', async () => {
    currentUser = UID_FRANK;

    const response = await searchGet(getReq(
      `https://staxis.test/api/comms/search?pid=${PID_A1}&q=needle`,
    ));
    const data = await success<SearchData>(response);
    const messageHits = data.hits.filter((hit) => hit.kind === 'message');

    assert.deepEqual(messageHits, [], 'unreachable message bodies do not become search hits');
    assert.equal(
      data.hits.some((hit) => hit.conversationId === housekeepingConversation),
      false,
      'the stale housekeeping channel is absent from search',
    );
    assert.equal(
      data.hits.some((hit) => hit.snippet === STALE_CHANNEL_NEEDLE),
      false,
      'the stale housekeeping snippet is absent from search',
    );
    assert.equal(
      data.hits.some((hit) => hit.snippet === CROSS_PROPERTY_NEEDLE),
      false,
      'the cross-property snippet is absent from search',
    );
  });
});

describe('staff-link floor channel wall', () => {
  test('a valid floor staff link cannot use a supplied channel conversation id', async () => {
    const beforeCount = await one<{ n: number }>(
      `select count(*)::int as n from comms_messages
       where property_id = $1 and conversation_id = $2`,
      [PID_A1, housekeepingConversation],
    );

    const cases: Array<{ label: string; run: () => Promise<Response> }> = [
      {
        label: 'floor thread read',
        run: () => floorThreadPost(postReq('https://staxis.test/api/housekeeper/messages/thread', {
          pid: PID_A1,
          staffId: floorStaff,
          conversationId: housekeepingConversation,
          tok: floorLinkToken,
        }, false)),
      },
      {
        label: 'floor send',
        run: () => floorSendPost(postReq('https://staxis.test/api/housekeeper/messages/send', {
          pid: PID_A1,
          staffId: floorStaff,
          conversationId: housekeepingConversation,
          body: 'floor channel write must be refused',
          tok: floorLinkToken,
        }, false)),
      },
      {
        label: 'floor mark-read',
        run: () => floorReadPost(postReq('https://staxis.test/api/housekeeper/messages/read', {
          pid: PID_A1,
          staffId: floorStaff,
          conversationId: housekeepingConversation,
          tok: floorLinkToken,
        }, false)),
      },
    ];

    for (const item of cases) {
      const response = await item.run();
      await assertError(response, 403, 'forbidden', 'Forbidden');
    }

    const afterCount = await one<{ n: number }>(
      `select count(*)::int as n from comms_messages
       where property_id = $1 and conversation_id = $2`,
      [PID_A1, housekeepingConversation],
    );
    assert.equal(afterCount?.n, beforeCount?.n, 'a refused floor send leaves no message behind');
  });
});

describe('same-property positive controls', () => {
  test('authorized channel reads, threads, writes, pins, and reactions still work', async () => {
    currentUser = UID_MARIA;

    const messages = await messagesGet(getReq(
      `https://staxis.test/api/comms/messages?pid=${PID_A1}&conversationId=${allStaffConversation}`,
    ));
    const messageData = await success<MessageData>(messages);
    assert.equal(messageData.conversation.id, allStaffConversation);
    assert.equal(messageData.messages.some((message) => message.id === authorizedChannelMessage), true);

    const thread = await threadGet(getReq(
      `https://staxis.test/api/comms/thread?pid=${PID_A1}&conversationId=${allStaffConversation}&parentId=${authorizedChannelMessage}`,
    ));
    const threadData = await success<ThreadData>(thread);
    assert.equal(threadData.parent?.id, authorizedChannelMessage);
    assert.equal(threadData.replies.length, 1);

    const sent = await sendPost(postReq('https://staxis.test/api/comms/send', {
      pid: PID_A1,
      conversationId: allStaffConversation,
      body: 'AUTHORIZED_CHANNEL_SEND',
    }));
    const sentData = await success<{ id: string }>(sent, 201);
    assert.ok(sentData.id);

    const pinned = await pinPost(postReq('https://staxis.test/api/comms/pin', {
      pid: PID_A1,
      messageId: authorizedChannelMessage,
      pinned: true,
    }));
    const pinnedData = await success<{ pinned: boolean }>(pinned);
    assert.equal(pinnedData.pinned, true);

    const pinnedList = await pinGet(getReq(
      `https://staxis.test/api/comms/pin?pid=${PID_A1}&conversationId=${allStaffConversation}`,
    ));
    const pinnedListData = await success<{ pinned: Array<{ id: string }> }>(pinnedList);
    assert.equal(pinnedListData.pinned.some((message) => message.id === authorizedChannelMessage), true);

    const reacted = await reactPost(postReq('https://staxis.test/api/comms/react', {
      pid: PID_A1,
      messageId: authorizedChannelMessage,
    }));
    const reactedData = await success<{ acked: boolean; count: number }>(reacted);
    assert.equal(reactedData.acked, true);
    assert.ok(reactedData.count >= 1);
  });

  test('authorized same-property DM and logbook replies still work', async () => {
    currentUser = UID_MARIA;

    const dm = await dmPost(postReq('https://staxis.test/api/comms/dm', {
      pid: PID_A1,
      otherStaffId: frontDeskStaff,
    }));
    const dmData = await success<{ conversationId: string }>(dm);
    assert.equal(dmData.conversationId, dmConversation);

    const dmMessages = await messagesGet(getReq(
      `https://staxis.test/api/comms/messages?pid=${PID_A1}&conversationId=${dmConversation}`,
    ));
    const dmMessageData = await success<MessageData>(dmMessages);
    assert.equal(dmMessageData.messages.some((message) => message.body === 'AUTHORIZED_DM_MESSAGE'), true);

    const replies = await logbookRepliesGet(getReq(
      `https://staxis.test/api/comms/logbook/replies?pid=${PID_A1}&entryId=${authorizedLogEntry}`,
    ));
    const repliesData = await success<{ replies: Array<{ body: string }> }>(replies);
    assert.equal(repliesData.replies.some((reply) => reply.body === 'Hotel A authorized reply'), true);

    const reply = await logbookRepliesPost(postReq('https://staxis.test/api/comms/logbook/replies', {
      pid: PID_A1,
      entryId: authorizedLogEntry,
      body: 'Hotel A second authorized reply',
    }));
    const replyData = await success<{ id: string }>(reply, 201);
    assert.ok(replyData.id);
  });
});

test('all exercised calls compiled through the real PostgREST adapter', () => {
  assert.deepEqual(shim.unsupported, [], `unsupported PostgREST features: ${shim.unsupported.join('; ')}`);
});
