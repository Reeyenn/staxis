import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decodeInventoryAuditCursor,
  encodeInventoryAuditCursor,
  listInventoryAuditHistory,
  parseInventoryAuditLimit,
} from '@/lib/inventory-audit-history';

test('inventory audit cursors round-trip as opaque bigint tokens', () => {
  const encoded = encodeInventoryAuditCursor('9223372036854775807');
  assert.doesNotMatch(encoded, /9223372036854775807/);
  assert.equal(decodeInventoryAuditCursor(encoded), '9223372036854775807');
  assert.equal(decodeInventoryAuditCursor(null), null);
});

test('inventory audit cursors and limits reject malformed/unbounded input', () => {
  assert.throws(() => decodeInventoryAuditCursor('not-a-real-cursor'), /cursor is invalid/i);
  assert.throws(() => encodeInventoryAuditCursor('0'), /invalid inventory audit sequence/i);
  assert.throws(() => encodeInventoryAuditCursor('9223372036854775808'), /invalid inventory audit sequence/i);
  assert.equal(parseInventoryAuditLimit(null), 50);
  assert.equal(parseInventoryAuditLimit('100'), 100);
  assert.throws(() => parseInventoryAuditLimit('0'), /1 to 100/i);
  assert.throws(() => parseInventoryAuditLimit('2.5'), /1 to 100/i);
  assert.throws(() => parseInventoryAuditLimit('101'), /1 to 100/i);
});

test('history helper forwards tenant/capability/cursor and returns the stable UI contract', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        error: null,
        data: {
          events: [{
            id: 'event-1',
            action: 'delivery.received',
            entityType: 'delivery',
            entityId: 'delivery-1',
            occurredAt: '2026-07-20T12:00:00.000Z',
            actorName: 'Hotel Manager',
            requestId: 'request-1',
            summary: {
              label: 'Bath Towels', secondaryLabel: 'Vendor A', quantity: 12,
              unit: 'each', itemCount: null, changedFields: [],
            },
            details: { quantity: 12, totalCost: 30 },
          }],
          nextSequence: '41',
        },
      };
    },
  } as unknown as SupabaseClient;

  const cursor = encodeInventoryAuditCursor('42');
  const page = await listInventoryAuditHistory(client, {
    propertyId: 'property-a', cursor, limit: 25, includeFinancials: true,
  });
  assert.deepEqual(calls, [{
    name: 'staxis_list_inventory_audit_events',
    args: {
      p_property_id: 'property-a',
      p_before_sequence: '42',
      p_limit: 25,
      p_include_financials: true,
    },
  }]);
  assert.deepEqual(page.events[0], {
    id: 'event-1',
    action: 'delivery.received',
    entityType: 'delivery',
    entityId: 'delivery-1',
    occurredAt: '2026-07-20T12:00:00.000Z',
    actorName: 'Hotel Manager',
    requestId: 'request-1',
    summary: {
      label: 'Bath Towels', secondaryLabel: 'Vendor A', quantity: 12,
      unit: 'each', itemCount: null, changedFields: [],
    },
    details: { quantity: 12, totalCost: 30 },
  });
  assert.equal(decodeInventoryAuditCursor(page.nextCursor), '41');
});
