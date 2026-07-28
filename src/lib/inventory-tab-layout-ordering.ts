import type { InventoryTabLayout } from '@/types';

export interface InventoryTabLayoutState {
  tabLayout: InventoryTabLayout;
  revision: number;
}

export interface InventoryTabLayoutOperationReceipt {
  operationId: string;
  expectedRevision: number;
  appliedRevision: number;
  tabLayout: InventoryTabLayout;
  budgetMode: 'total' | 'sections' | null;
  actorMatches: boolean;
}

export interface InventoryTabLayoutReconciliation extends InventoryTabLayoutState {
  operation: InventoryTabLayoutOperationReceipt | null;
}

export type InventoryTabLayoutWriteStatus =
  | 'applied'
  | 'replayed'
  | 'revision_conflict'
  | 'operation_conflict'
  | 'not_found';

export interface InventoryTabLayoutWriteResult extends InventoryTabLayoutState {
  status: InventoryTabLayoutWriteStatus;
  operationId?: string;
  operationRevision?: number;
}

export const EMPTY_INVENTORY_TAB_LAYOUT: InventoryTabLayout = {
  order: [],
  hidden: [],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Parse only the layout's public contract. Database-owned revision/operation
 * metadata is deliberately discarded here so it can never leak into a UI
 * property model or get echoed back as caller-controlled state.
 */
export function parseInventoryTabLayout(raw: unknown): InventoryTabLayout | null {
  const candidate = asRecord(raw);
  if (!candidate) return null;
  if (!Array.isArray(candidate.order) || !candidate.order.every((key) => typeof key === 'string')) {
    return null;
  }
  if (!Array.isArray(candidate.hidden) || !candidate.hidden.every((key) => typeof key === 'string')) {
    return null;
  }
  return {
    order: [...candidate.order] as string[],
    hidden: [...candidate.hidden] as string[],
  };
}

function safeRevision(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : null;
}

/** Parse a properties.inventory_tab_layout value, including private revision. */
export function inventoryTabLayoutStateFromStored(raw: unknown): InventoryTabLayoutState {
  const record = asRecord(raw);
  const metadata = asRecord(record?._staxis);
  return {
    tabLayout: parseInventoryTabLayout(raw) ?? EMPTY_INVENTORY_TAB_LAYOUT,
    revision: safeRevision(metadata?.revision) ?? 0,
  };
}

/** Strictly parse the management API's GET reconciliation data. */
export function parseInventoryTabLayoutReconciliation(
  raw: unknown,
): InventoryTabLayoutReconciliation | null {
  const record = asRecord(raw);
  const tabLayout = parseInventoryTabLayout(record?.tabLayout);
  const revision = safeRevision(record?.revision);
  if (!record || !tabLayout || revision === null) return null;

  if (record.operation === null || record.operation === undefined) {
    return { tabLayout, revision, operation: null };
  }
  const operation = asRecord(record.operation);
  const operationLayout = parseInventoryTabLayout(operation?.tabLayout);
  const operationId = typeof operation?.operationId === 'string' ? operation.operationId : null;
  const expectedRevision = safeRevision(operation?.expectedRevision);
  const appliedRevision = safeRevision(operation?.appliedRevision);
  const budgetMode = operation?.budgetMode === null
    || operation?.budgetMode === 'total'
    || operation?.budgetMode === 'sections'
    ? operation.budgetMode
    : undefined;
  const actorMatches = typeof operation?.actorMatches === 'boolean'
    ? operation.actorMatches
    : null;
  if (
    !operation
    || !operationLayout
    || !operationId
    || expectedRevision === null
    || appliedRevision === null
    || budgetMode === undefined
    || actorMatches === null
  ) return null;

  return {
    tabLayout,
    revision,
    operation: {
      operationId,
      expectedRevision,
      appliedRevision,
      tabLayout: operationLayout,
      budgetMode,
      actorMatches,
    },
  };
}

/** Strictly parse the ordered-write RPC/API data contract. */
export function parseInventoryTabLayoutWriteResult(
  raw: unknown,
): InventoryTabLayoutWriteResult | null {
  const record = asRecord(raw);
  if (!record) return null;

  const status = record.status;
  if (
    status !== 'applied'
    && status !== 'replayed'
    && status !== 'revision_conflict'
    && status !== 'operation_conflict'
    && status !== 'not_found'
  ) return null;

  if (status === 'not_found') {
    return {
      status,
      tabLayout: EMPTY_INVENTORY_TAB_LAYOUT,
      revision: 0,
    };
  }

  const tabLayout = parseInventoryTabLayout(record.tabLayout);
  const revision = safeRevision(record.revision);
  if (!tabLayout || revision === null) return null;

  const operationId = typeof record.operationId === 'string' ? record.operationId : undefined;
  const operationRevision = safeRevision(record.operationRevision);
  return {
    status,
    tabLayout,
    revision,
    ...(operationId ? { operationId } : {}),
    ...(operationRevision !== null ? { operationRevision } : {}),
  };
}
