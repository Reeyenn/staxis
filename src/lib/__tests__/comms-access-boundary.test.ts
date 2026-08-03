import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  canAccessConversation,
  listConversationsForStaff,
  searchComms,
  type ConversationRow,
} from '@/lib/comms/core';
import { supabaseAdmin } from '@/lib/supabase-admin';

const PROPERTY_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_PROPERTY_ID = '22222222-2222-2222-2222-222222222222';
const STAFF_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PARTNER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ANNOUNCEMENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ALL_STAFF_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const HOUSEKEEPING_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const INVISIBLE_CHANNEL_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const DM_ID = '11111111-2222-3333-4444-555555555555';

type Row = Record<string, unknown>;

interface MessageQuery {
  filters: Array<{ column: string; value: unknown }>;
}

interface DatabaseState {
  rows: Record<string, Row[]>;
  messageQueries: MessageQuery[];
}

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function conversationRows(): Row[] {
  return [
    {
      id: ANNOUNCEMENT_ID,
      property_id: PROPERTY_ID,
      kind: 'announcement',
      channel_key: 'announcements',
      dm_key: null,
      title: 'Announcements',
      last_message_at: null,
    },
    {
      id: ALL_STAFF_ID,
      property_id: PROPERTY_ID,
      kind: 'channel',
      channel_key: 'all_staff',
      dm_key: null,
      title: 'All staff',
      last_message_at: null,
    },
    {
      id: HOUSEKEEPING_ID,
      property_id: PROPERTY_ID,
      kind: 'channel',
      channel_key: 'housekeeping',
      dm_key: null,
      title: 'Housekeeping',
      last_message_at: null,
    },
    {
      id: INVISIBLE_CHANNEL_ID,
      property_id: PROPERTY_ID,
      kind: 'channel',
      channel_key: 'front_desk',
      dm_key: null,
      title: 'Front desk',
      last_message_at: '2026-08-01T12:00:00.000Z',
    },
    {
      id: DM_ID,
      property_id: PROPERTY_ID,
      kind: 'dm',
      channel_key: null,
      dm_key: `${STAFF_ID}:${PARTNER_ID}`,
      title: null,
      last_message_at: '2026-08-01T13:00:00.000Z',
    },
  ];
}

function seedRows(): Record<string, Row[]> {
  return {
    comms_conversations: conversationRows(),
    comms_members: [
      { property_id: PROPERTY_ID, conversation_id: ANNOUNCEMENT_ID, staff_id: STAFF_ID, last_read_at: '2026-08-01T00:00:00.000Z' },
      // This is the stale membership that must not make the channel look like a DM.
      { property_id: PROPERTY_ID, conversation_id: INVISIBLE_CHANNEL_ID, staff_id: STAFF_ID, last_read_at: '2026-08-01T00:00:00.000Z' },
      { property_id: PROPERTY_ID, conversation_id: DM_ID, staff_id: STAFF_ID, last_read_at: '2026-08-01T00:00:00.000Z' },
    ],
    comms_messages: [
      {
        id: '99999999-aaaa-bbbb-cccc-dddddddddddd',
        property_id: PROPERTY_ID,
        conversation_id: INVISIBLE_CHANNEL_ID,
        sender_staff_id: PARTNER_ID,
        sender_kind: 'staff',
        body: 'stale channel secret needle',
        msg_type: 'text',
        created_at: '2026-08-01T12:00:00.000Z',
        parent_message_id: null,
      },
      {
        id: '88888888-aaaa-bbbb-cccc-dddddddddddd',
        property_id: PROPERTY_ID,
        conversation_id: DM_ID,
        sender_staff_id: PARTNER_ID,
        sender_kind: 'staff',
        body: 'visible DM needle',
        msg_type: 'text',
        created_at: '2026-08-01T13:00:00.000Z',
        parent_message_id: null,
      },
      {
        id: '77777777-aaaa-bbbb-cccc-dddddddddddd',
        property_id: OTHER_PROPERTY_ID,
        conversation_id: DM_ID,
        sender_staff_id: PARTNER_ID,
        sender_kind: 'staff',
        body: 'foreign property needle',
        msg_type: 'text',
        created_at: '2025-01-01T00:00:00.000Z',
        parent_message_id: null,
      },
    ],
    staff: [
      {
        id: STAFF_ID,
        property_id: PROPERTY_ID,
        name: 'Housekeeper',
        department: 'housekeeping',
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: PARTNER_ID,
        property_id: PROPERTY_ID,
        name: 'Front Desk Partner',
        department: 'front_desk',
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    comms_acknowledgements: [],
  };
}

function installDatabase(): DatabaseState {
  const state: DatabaseState = { rows: seedRows(), messageQueries: [] };

  supabaseAdmin.from = ((table: string) => {
    const filters: Array<{ column: string; value: unknown }> = [];
    const inFilters: Array<{ column: string; values: unknown[] }> = [];
    const isFilters: Array<{ column: string; value: unknown }> = [];
    const gteFilters: Array<{ column: string; value: unknown }> = [];
    const gtFilters: Array<{ column: string; value: unknown }> = [];
    const ilikeFilters: Array<{ column: string; value: string }> = [];
    const orFilters: string[] = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let selectedColumns: string[] | null = null;
    let limit: number | null = null;
    let head = false;

    const evaluate = (): { data: Row[]; count: number; error: null } => {
      let rows = [...(state.rows[table] ?? [])];
      for (const filter of filters) rows = rows.filter((row) => row[filter.column] === filter.value);
      for (const filter of inFilters) rows = rows.filter((row) => filter.values.includes(row[filter.column]));
      for (const filter of isFilters) {
        rows = rows.filter((row) => filter.value === null ? row[filter.column] == null : row[filter.column] === filter.value);
      }
      for (const filter of gteFilters) {
        rows = rows.filter((row) => String(row[filter.column] ?? '') >= String(filter.value));
      }
      for (const filter of gtFilters) {
        rows = rows.filter((row) => String(row[filter.column] ?? '') > String(filter.value));
      }
      for (const filter of ilikeFilters) {
        const needle = filter.value.replace(/^%|%$/g, '').toLowerCase();
        rows = rows.filter((row) => String(row[filter.column] ?? '').toLowerCase().includes(needle));
      }
      for (const expression of orFilters) {
        const match = /^sender_staff_id\.is\.null,sender_staff_id\.neq\.(.+)$/.exec(expression);
        if (match) rows = rows.filter((row) => row.sender_staff_id == null || row.sender_staff_id !== match[1]);
      }
      for (const order of [...orders].reverse()) {
        rows.sort((a, b) => {
          const left = String(a[order.column] ?? '');
          const right = String(b[order.column] ?? '');
          return (order.ascending ? 1 : -1) * left.localeCompare(right);
        });
      }
      const count = rows.length;
      if (limit != null) rows = rows.slice(0, limit);
      if (selectedColumns) {
        rows = rows.map((row) => Object.fromEntries(selectedColumns!.map((column) => [column, row[column]])));
      }
      return { data: rows, count, error: null };
    };

    const builder: Record<string, unknown> = {};
    builder.select = (columns?: string, options?: { head?: boolean }) => {
      selectedColumns = columns?.split(',').map((column) => column.trim()).filter(Boolean) ?? null;
      head = options?.head === true;
      return builder;
    };
    builder.eq = (column: string, value: unknown) => {
      filters.push({ column, value });
      return builder;
    };
    builder.in = (column: string, values: unknown[]) => {
      inFilters.push({ column, values });
      return builder;
    };
    builder.is = (column: string, value: unknown) => {
      isFilters.push({ column, value });
      return builder;
    };
    builder.gte = (column: string, value: unknown) => {
      gteFilters.push({ column, value });
      return builder;
    };
    builder.gt = (column: string, value: unknown) => {
      gtFilters.push({ column, value });
      return builder;
    };
    builder.ilike = (column: string, value: string) => {
      ilikeFilters.push({ column, value });
      return builder;
    };
    builder.or = (expression: string) => {
      orFilters.push(expression);
      return builder;
    };
    builder.order = (column: string, options?: { ascending?: boolean }) => {
      orders.push({ column, ascending: options?.ascending !== false });
      return builder;
    };
    builder.limit = (value: number) => {
      limit = value;
      return builder;
    };
    builder.maybeSingle = async () => {
      const result = evaluate();
      return { data: result.data[0] ?? null, error: null };
    };
    builder.insert = (payload: Row | Row[]) => {
      const incoming = Array.isArray(payload) ? payload : [payload];
      state.rows[table] ??= [];
      state.rows[table].push(...incoming);
      return builder;
    };
    builder.upsert = (payload: Row | Row[]) => {
      const incoming = Array.isArray(payload) ? payload : [payload];
      state.rows[table] ??= [];
      for (const row of incoming) {
        const existing = state.rows[table].find((current) => (
          current.conversation_id === row.conversation_id && current.staff_id === row.staff_id
        ));
        if (existing) Object.assign(existing, row);
        else state.rows[table].push(row);
      }
      return builder;
    };
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => {
      const result = evaluate();
      if (table === 'comms_messages') {
        state.messageQueries.push({ filters: [...filters] });
      }
      return Promise.resolve(head ? { data: null, count: result.count, error: null } : result).then(resolve, reject);
    };
    return builder;
  }) as unknown as typeof supabaseAdmin.from;

  return state;
}

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

function channel(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: HOUSEKEEPING_ID,
    property_id: PROPERTY_ID,
    kind: 'channel',
    channel_key: 'housekeeping',
    dm_key: null,
    title: 'Housekeeping',
    last_message_at: null,
    ...overrides,
  };
}

describe('communications conversation access boundaries', () => {
  test('floor mode denies channels while preserving announcement and DM access', async () => {
    assert.equal(await canAccessConversation(PROPERTY_ID, STAFF_ID, channel(), { isManager: false, dept: 'housekeeping' }), true);
    assert.equal(await canAccessConversation(PROPERTY_ID, STAFF_ID, channel(), { isManager: false, dept: 'housekeeping', floorMode: true }), false);
    assert.equal(await canAccessConversation(PROPERTY_ID, STAFF_ID, {
      ...channel({ id: DM_ID, kind: 'dm', channel_key: null, dm_key: `${STAFF_ID}:${PARTNER_ID}` }),
    }, { isManager: false, dept: 'housekeeping', floorMode: true }), true);
    assert.equal(await canAccessConversation(PROPERTY_ID, STAFF_ID, {
      ...channel({ id: ANNOUNCEMENT_ID, kind: 'announcement', channel_key: 'announcements' }),
    }, { isManager: false, dept: 'housekeeping', floorMode: true }), true);
  });

  test('stale invisible channel membership is filtered before preview and unread work', async () => {
    const state = installDatabase();
    const conversations = await listConversationsForStaff(PROPERTY_ID, STAFF_ID, {
      isManager: false,
      dept: 'housekeeping',
      floorMode: false,
    });

    assert.equal(conversations.some((conversation) => conversation.id === INVISIBLE_CHANNEL_ID), false);
    assert.equal(conversations.some((conversation) => conversation.id === HOUSEKEEPING_ID), true);
    assert.equal(conversations.some((conversation) => conversation.id === DM_ID), true);
    assert.equal(
      state.messageQueries.some((query) => query.filters.some((filter) => filter.value === INVISIBLE_CHANNEL_ID)),
      false,
      'the filtered channel must not reach preview or unread queries',
    );
  });

  test('search double-keys message bodies by property and keeps stale channels unreachable', async () => {
    installDatabase();
    const hits = await searchComms(PROPERTY_ID, STAFF_ID, 'needle', {
      isManager: false,
      dept: 'housekeeping',
    });
    const messageHits = hits.filter((hit) => hit.kind === 'message');

    assert.deepEqual(messageHits.map((hit) => hit.snippet), ['visible DM needle']);
    assert.equal(hits.some((hit) => hit.conversationId === INVISIBLE_CHANNEL_ID), false);
    assert.equal(hits.some((hit) => hit.snippet === 'foreign property needle'), false);
  });
});
