import type { SupabaseClient } from '@supabase/supabase-js';

export const INVENTORY_AUDIT_ACTIONS = [
  'item.created', 'item.updated', 'item.archived',
  'count.saved', 'delivery.received', 'order_intent.recorded', 'loss.recorded', 'reconciliation.recorded',
  'delivery.corrected', 'delivery.voided', 'opening_adjustment.recorded',
  'month.started', 'month.closed',
  'vendor.created', 'vendor.updated', 'vendor.inactivated',
  'budget.created', 'budget.updated', 'budget.deleted',
  'category.created', 'category.updated', 'category.deleted',
  'budget_section.created', 'budget_section.updated', 'budget_section.deleted',
  'config.updated',
] as const;

export type InventoryAuditAction = typeof INVENTORY_AUDIT_ACTIONS[number];

export type InventoryAuditEntityType =
  | 'item'
  | 'count'
  | 'delivery'
  | 'loss'
  | 'reconciliation'
  | 'delivery_correction'
  | 'opening_adjustment'
  | 'month'
  | 'vendor'
  | 'budget'
  | 'category'
  | 'budget_section'
  | 'config';

export interface InventoryAuditSummary {
  label: string | null;
  secondaryLabel: string | null;
  quantity: number | null;
  unit: string | null;
  itemCount: number | null;
  changedFields: string[];
}

export interface InventoryAuditEvent {
  id: string;
  action: InventoryAuditAction;
  entityType: InventoryAuditEntityType;
  entityId: string | null;
  occurredAt: string;
  actorName: string | null;
  requestId: string | null;
  summary: InventoryAuditSummary;
  details: Record<string, unknown>;
}

export interface InventoryAuditPage {
  events: InventoryAuditEvent[];
  nextCursor: string | null;
}

const ACTIONS = new Set<string>(INVENTORY_AUDIT_ACTIONS);
const ENTITY_TYPES = new Set<string>([
  'item', 'count', 'delivery', 'loss', 'reconciliation', 'delivery_correction',
  'opening_adjustment', 'month', 'vendor', 'budget', 'category', 'budget_section', 'config',
]);
const CURSOR_PREFIX = 'inventory-audit:v1:';
const MAX_BIGINT = BigInt('9223372036854775807');

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Cursor contents are opaque to callers, but deliberately unsigned: the
 * property predicate is independently authorized and enforced on every page. */
export function encodeInventoryAuditCursor(sequence: string): string {
  if (!/^[1-9]\d{0,18}$/.test(sequence) || BigInt(sequence) > MAX_BIGINT) {
    throw new Error('invalid inventory audit sequence');
  }
  return Buffer.from(`${CURSOR_PREFIX}${sequence}`, 'utf8').toString('base64url');
}

export function decodeInventoryAuditCursor(cursor: string | null | undefined): string | null {
  if (cursor == null || cursor === '') return null;
  if (cursor.length > 128 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error('cursor is invalid');
  }
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new Error('cursor is invalid');
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) throw new Error('cursor is invalid');
  const sequence = decoded.slice(CURSOR_PREFIX.length);
  if (!/^[1-9]\d{0,18}$/.test(sequence) || BigInt(sequence) > MAX_BIGINT) {
    throw new Error('cursor is invalid');
  }
  return sequence;
}

export function parseInventoryAuditLimit(raw: string | null | undefined): number {
  if (raw == null || raw === '') return 50;
  if (!/^\d+$/.test(raw)) throw new Error('limit must be an integer from 1 to 100');
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer from 1 to 100');
  }
  return limit;
}

function normalizeSummary(value: unknown): InventoryAuditSummary {
  const row = record(value) ? value : {};
  return {
    label: nullableString(row.label),
    secondaryLabel: nullableString(row.secondaryLabel),
    quantity: nullableNumber(row.quantity),
    unit: nullableString(row.unit),
    itemCount: nullableNumber(row.itemCount),
    changedFields: Array.isArray(row.changedFields)
      ? row.changedFields.filter((field): field is string => typeof field === 'string')
      : [],
  };
}

function normalizeEvent(value: unknown): InventoryAuditEvent {
  if (!record(value)) throw new Error('inventory audit event was invalid');
  const id = nullableString(value.id);
  const action = nullableString(value.action);
  const entityType = nullableString(value.entityType);
  const occurredAt = nullableString(value.occurredAt);
  if (!id || !action || !ACTIONS.has(action) || !entityType || !ENTITY_TYPES.has(entityType) || !occurredAt) {
    throw new Error('inventory audit event was invalid');
  }
  return {
    id,
    action: action as InventoryAuditAction,
    entityType: entityType as InventoryAuditEntityType,
    entityId: nullableString(value.entityId),
    occurredAt,
    actorName: nullableString(value.actorName),
    requestId: nullableString(value.requestId),
    summary: normalizeSummary(value.summary),
    details: record(value.details) ? value.details : {},
  };
}

export async function listInventoryAuditHistory(
  client: SupabaseClient,
  options: {
    propertyId: string;
    cursor?: string | null;
    limit?: number;
    includeFinancials: boolean;
  },
): Promise<InventoryAuditPage> {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer from 1 to 100');
  }
  const beforeSequence = decodeInventoryAuditCursor(options.cursor);
  const { data, error } = await client.rpc('staxis_list_inventory_audit_events', {
    p_property_id: options.propertyId,
    p_before_sequence: beforeSequence,
    p_limit: limit,
    p_include_financials: options.includeFinancials,
  });
  if (error) throw error;
  if (!record(data) || !Array.isArray(data.events)) {
    throw new Error('inventory audit history response was invalid');
  }
  const nextSequence = nullableString(data.nextSequence);
  return {
    events: data.events.map(normalizeEvent),
    nextCursor: nextSequence == null ? null : encodeInventoryAuditCursor(nextSequence),
  };
}
