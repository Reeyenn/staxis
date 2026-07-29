import type { InventoryTabLayout } from '@/types';
import {
  parseInventoryTabLayoutReconciliation,
  parseInventoryTabLayoutWriteResult,
  type InventoryTabLayoutState,
} from '@/lib/inventory-tab-layout-ordering';

export type InventoryConfigRequest = (
  input: string,
  init?: RequestInit & { timeoutMs?: number | null },
) => Promise<Response>;

export type OrderedInventoryTabLayoutSaveOutcome =
  | { kind: 'saved'; state: InventoryTabLayoutState }
  | { kind: 'conflict'; state: InventoryTabLayoutState }
  | { kind: 'failed'; state: InventoryTabLayoutState | null }
  | { kind: 'unconfirmed'; state: InventoryTabLayoutState | null };

interface SaveInput {
  request: InventoryConfigRequest;
  propertyId: string;
  tabLayout: InventoryTabLayout;
  baselineLayout: InventoryTabLayout;
  expectedRevision: number | null;
  operationId: string;
  timeoutMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameLayout(a: InventoryTabLayout, b: InventoryTabLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function readReconciliation(
  input: Pick<SaveInput, 'request' | 'propertyId'>,
  operationId?: string,
): Promise<ReturnType<typeof parseInventoryTabLayoutReconciliation>> {
  const query = new URLSearchParams({ pid: input.propertyId });
  if (operationId) query.set('operationId', operationId);
  const response = await input.request(`/api/inventory/property-config?${query.toString()}`);
  const body = asRecord(await response.json().catch(() => null));
  if (!response.ok || body?.ok !== true) return null;
  return parseInventoryTabLayoutReconciliation(body.data);
}

/**
 * Persist one whole-layout edit through the ordered API contract.
 *
 * A thrown/5xx response is potentially ambiguous, so the exact operation is
 * retried once. If that still has no response, the final GET requests the
 * operation receipt as well as current state; equality of layout alone is not
 * treated as proof that this operation committed.
 */
export async function saveOrderedInventoryTabLayout(
  input: SaveInput,
): Promise<OrderedInventoryTabLayoutSaveOutcome> {
  let expectedRevision = input.expectedRevision;
  let baselineState: InventoryTabLayoutState | null = expectedRevision === null
    ? null
    : { tabLayout: input.baselineLayout, revision: expectedRevision };

  if (expectedRevision === null) {
    try {
      const state = await readReconciliation(input);
      if (!state) return { kind: 'failed', state: null };
      baselineState = { tabLayout: state.tabLayout, revision: state.revision };
      expectedRevision = state.revision;
      // PropertyContext intentionally exposes no private revision metadata.
      // If its public layout was stale too, do not overwrite the newer server
      // document merely because this was the first edit in the mounted shell.
      if (!sameLayout(state.tabLayout, input.baselineLayout)) {
        return { kind: 'conflict', state: baselineState };
      }
    } catch {
      return { kind: 'failed', state: null };
    }
  }

  const requestBody = JSON.stringify({
    pid: input.propertyId,
    tabLayout: input.tabLayout,
    operationId: input.operationId,
    expectedRevision,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await input.request('/api/inventory/property-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        timeoutMs: input.timeoutMs,
      });
      const envelope = asRecord(await response.json().catch(() => null));
      const parsed = parseInventoryTabLayoutWriteResult(
        envelope?.ok === true ? envelope.data : envelope?.details,
      );

      if (parsed) {
        const state = { tabLayout: parsed.tabLayout, revision: parsed.revision };
        if (parsed.status === 'revision_conflict' || parsed.status === 'operation_conflict') {
          return { kind: 'conflict', state };
        }
        if (parsed.status === 'not_found') return { kind: 'failed', state: null };
        if (parsed.operationId !== input.operationId) {
          // A success response must identify the frozen operation it is
          // acknowledging. Treat a missing/mismatched ID as ambiguous and use
          // the exact receipt reconciliation below, never layout equality.
          continue;
        }
        // A replay can be older than the current authoritative revision. It is
        // only a current success when the authoritative layout is still the
        // exact desired document.
        return sameLayout(parsed.tabLayout, input.tabLayout)
          ? { kind: 'saved', state }
          : { kind: 'conflict', state };
      }

      // A definitive caller/auth/not-found response did not apply a write and
      // is not made safer by repeating it.
      if (response.status >= 400 && response.status < 500) {
        return { kind: 'failed', state: baselineState };
      }
      // 5xx/invalid envelopes are ambiguous and take the exact safe retry.
    } catch {
      // Network and deadline failures are ambiguous; retry this exact frozen
      // operation once, never a newly generated operation.
    }
  }

  try {
    const reconciled = await readReconciliation(input, input.operationId);
    if (!reconciled) return { kind: 'unconfirmed', state: null };
    const state = { tabLayout: reconciled.tabLayout, revision: reconciled.revision };
    const receipt = reconciled.operation;
    if (
      receipt
      && receipt.operationId === input.operationId
      && receipt.expectedRevision === expectedRevision
      && sameLayout(receipt.tabLayout, input.tabLayout)
      && receipt.budgetMode === null
      && receipt.actorMatches
    ) {
      return sameLayout(reconciled.tabLayout, input.tabLayout)
        ? { kind: 'saved', state }
        : { kind: 'conflict', state };
    }
    // The read is authoritative for this instant, but an earlier HTTP request
    // may still be upstream of the bounded RPC. Call this unconfirmed—not
    // failed—while adopting the revision so any later edit is CAS-fenced.
    return { kind: 'unconfirmed', state };
  } catch {
    return { kind: 'unconfirmed', state: null };
  }
}
