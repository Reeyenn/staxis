import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  lifecycleApprovalLabel,
  lifecycleOutcomeLabel,
  lifecycleSourceLabel,
  lifecycleSourceSummary,
  lifecycleStateLabel,
  lifecycleStateProgress,
  lifecycleTime,
} from '@/components/concourse/LifecycleProjection';
import type { LifecycleActionProjection } from '@/lib/staxis/lifecycle';
import type { LifecycleResponse } from '@/lib/staxis/lifecycle';

function textOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => textOf(child, out));
    return out;
  }
  const element = node as { props?: Record<string, unknown> };
  if (element.props) textOf(element.props.children, out);
  return out;
}

function findAll(node: unknown, match: (props: Record<string, unknown>) => boolean, out: Record<string, unknown>[] = []) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, match, out));
    return out;
  }
  const element = node as { props?: Record<string, unknown> };
  if (!element.props) return out;
  if (match(element.props)) out.push(element.props);
  findAll(element.props.children, match, out);
  return out;
}

/** Resolve the hook-free function components so this test can inspect the
 * actual card tree without a browser renderer. */
function resolveTree(node: unknown): unknown {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(resolveTree);
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (!element.props) return node;
  if (typeof element.type === 'function') {
    return resolveTree((element.type as (props: Record<string, unknown>) => unknown)(element.props));
  }
  return {
    ...element,
    props: { ...element.props, children: resolveTree(element.props.children) },
  };
}

describe('Staxis lifecycle projection copy', () => {
  test('keeps every lifecycle state distinct, including terminal uncertainty', () => {
    assert.deepEqual(
      [
        'observed',
        'proposed',
        'approved',
        'executed',
        'outcome_verified',
        'not_observable',
        'unverifiable',
      ].map((state) => lifecycleStateLabel(state as Parameters<typeof lifecycleStateLabel>[0])),
      ['Observed', 'Proposed', 'Approved', 'Executed', 'Outcome verified', 'Not observable', 'Unverifiable'],
    );
  });

  test('names trusted source summaries without exposing source identifiers', () => {
    assert.equal(lifecycleSourceLabel([]), '0 source facts recorded');
    assert.equal(lifecycleSourceLabel(['fact-a']), '1 source fact recorded');
    assert.equal(lifecycleSourceLabel(['fact-a', 'fact-b']), '2 source facts recorded');
    assert.equal(
      lifecycleSourceSummary(
        [{
          id: 'unsafe-id',
          kind: 'pms',
          label: 'PMS report',
          reference: 'Daily room status',
          receiptId: 'receipt-id',
          receiptHash: 'hash',
          effectiveAt: '2026-08-08T12:00:00.000Z',
          asOf: '2026-08-08T12:00:00.000Z',
          observedAt: '2026-08-08T12:00:00.000Z',
          receivedAt: '2026-08-08T12:00:00.000Z',
          completeness: 'complete',
          completenessReason: null,
          freshness: 'fresh',
          freshnessMaxAgeSeconds: 300,
          owner: { kind: 'pms', label: 'PMS', role: null },
          authority: 1,
          precedence: 1,
        }],
        ['fact-id'],
      ),
      'PMS report · pms · Daily room status · 1 source fact recorded · 1 source receipt recorded',
    );
  });

  test('terminal outcomes retain the executed history in the state rail', () => {
    assert.equal(lifecycleStateProgress('observed'), 0);
    assert.equal(lifecycleStateProgress('executed'), 3);
    assert.equal(lifecycleStateProgress('not_observable'), 3);
    assert.equal(lifecycleStateProgress('unverifiable'), 3);
  });

  test('does not collapse approval uncertainty into approval', () => {
    const approval = (state: LifecycleActionProjection['approval']['state']) => ({
      mode: 'explicit_card' as const,
      tier: 'card' as const,
      policyId: 'policy',
      state,
    });
    assert.equal(lifecycleApprovalLabel(approval('required')), 'Approval required');
    assert.equal(lifecycleApprovalLabel(approval('approved')), 'Approval approved');
    assert.equal(lifecycleApprovalLabel(approval('rejected')), 'Approval rejected');
    assert.equal(lifecycleApprovalLabel(approval('not_required')), 'Approval not required');
  });

  test('keeps outcome verification terminals truthful', () => {
    const outcome = (state: LifecycleActionProjection['outcome']['state'], basis?: string) => ({
      observability: 'conditional' as const,
      verificationState: state,
      verificationWindowDays: 1,
      basisRequired: true as const,
      state,
      basis: basis ?? null,
      observedAt: null,
    });
    assert.equal(lifecycleOutcomeLabel(outcome('verified')), 'Verified');
    assert.equal(lifecycleOutcomeLabel(outcome('not_observable', 'The source does not expose completion')), 'Not observable — The source does not expose completion');
    assert.equal(lifecycleOutcomeLabel(outcome('unverifiable', 'No trusted receipt')), 'Unverifiable — No trusted receipt');
    assert.equal(lifecycleOutcomeLabel(outcome('reverted')), 'Reverted');
  });

  test('returns no timestamp for malformed source clocks instead of inventing freshness', () => {
    assert.equal(lifecycleTime(null), null);
    assert.equal(lifecycleTime('not-a-date'), null);
    assert.match(lifecycleTime('2026-08-08T12:00:00.000Z') ?? '', /Aug 8/);
  });

  test('renders the safe projection fields in one read-only card', async () => {
    const { LifecycleProjection } = await import('@/components/concourse/LifecycleProjection');
    const payload = {
      contractVersion: 'staxis-lifecycle.v1',
      generatedAt: '2026-08-08T12:00:00.000Z',
      items: [{
        contractVersion: 'staxis-lifecycle.v1',
        id: 'projection-id',
        propertyId: 'property-id',
        entity: { kind: 'room', id: 'room-id', label: 'Room 214' },
        title: 'Inspection proposed',
        summary: 'A room needs an inspection.',
        state: 'not_observable' as const,
        priorStates: ['observed', 'proposed', 'approved', 'executed'] as const,
        findingId: null,
        proposalId: 'proposal-id',
        approvalId: 'approval-id',
        executionReceiptId: 'execution-receipt-id',
        sourceFactIds: ['source-id'],
        sources: [{
          id: 'source-id',
          kind: 'pms',
          label: 'PMS report',
          reference: 'Daily room status',
          receiptId: 'source-receipt-id',
          receiptHash: 'source-hash',
          effectiveAt: '2026-08-08T11:00:00.000Z',
          asOf: '2026-08-08T11:00:00.000Z',
          observedAt: '2026-08-08T11:05:00.000Z',
          receivedAt: '2026-08-08T11:06:00.000Z',
          completeness: 'complete' as const,
          completenessReason: null,
          freshness: 'fresh' as const,
          freshnessMaxAgeSeconds: 300,
          owner: { kind: 'pms' as const, label: 'PMS', role: null },
          authority: 1,
          precedence: 1,
        }],
        effectiveAt: '2026-08-08T11:00:00.000Z',
        asOf: '2026-08-08T11:00:00.000Z',
        observedAt: '2026-08-08T11:05:00.000Z',
        recordedAt: '2026-08-08T11:06:00.000Z',
        freshness: { status: 'fresh' as const, maxAgeSeconds: 300 },
        completeness: { status: 'complete' as const, reason: null },
        authority: { owner: { kind: 'human' as const, label: 'Morgan', role: 'GM' }, level: 2, precedence: 1 },
        action: {
          id: 'action-id',
          kind: 'create_work_order',
          effect: {
            domain: 'hotel operations',
            operation: 'create work order',
            targetKind: 'work order',
            boundary: 'in_app_only' as const,
            statement: 'Creates one in-app work order.',
            limit: 'Does not contact a vendor or confirm physical completion.',
          },
          targetId: 'target-id',
          approval: { mode: 'explicit_card' as const, tier: 'card' as const, policyId: 'policy', state: 'approved' as const },
          frozenInput: { immutable: true as const, fields: ['propertyId'], fingerprint: 'server_sha256' as const, staleInput: 'decline' as const, hash: 'hash' },
          idempotency: { scope: 'property_action' as const, keyFields: ['propertyId'], retry: 'first_receipt' as const },
          receipt: { contractVersion: 'staxis-action.v1', requiredFields: ['id'], internalOnly: true as const, physicalCompletionClaim: 'never' as const },
          outcome: {
            observability: 'not_observable' as const,
            verificationState: 'not_observable' as const,
            verificationWindowDays: 1,
            basisRequired: true as const,
            state: 'not_observable' as const,
            basis: 'The source does not expose completion.',
            observedAt: null,
          },
        },
        domainWorkItem: { kind: 'work_order', id: 'work-id', label: 'Room 214 inspection', href: null, observedAt: '2026-08-08T11:06:00.000Z', owner: { kind: 'human' as const, label: 'Morgan', role: 'GM' } },
        outcome: { state: 'not_observable' as const, basis: 'The source does not expose completion.', observedAt: null },
        reason: 'No trusted completion signal is available.',
      }],
    } satisfies LifecycleResponse;
    const tree = resolveTree(LifecycleProjection({ payload }));
    const rendered = textOf(tree).join(' ');
    assert.match(rendered, /PMS report.*pms.*Daily room status/);
    assert.match(rendered, /Creates one in-app work order/);
    assert.match(rendered, /Does not contact a vendor/);
    assert.match(rendered, /Approval approved/);
    assert.match(rendered, /Execution receipt recorded/);
    assert.match(rendered, /Owner at last verified update: Morgan \(GM\)/);
    assert.match(rendered, /Room 214 inspection reference recorded/);
    assert.match(rendered, /Not observable/);
    const completedSteps = findAll(tree, (props) => props.className === 'fx-life-state fx-life-state-on');
    assert.equal(completedSteps.length, 4);
    assert.equal(findAll(tree, (props) => props.className === 'fx-life-state fx-life-state-terminal').length, 1);
  });
});
