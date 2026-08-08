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
import { parseLifecycleResponse } from '@/lib/staxis/lifecycle';
import type { LifecycleActionProjection } from '@/lib/staxis/lifecycle';
import type { LifecycleResponse } from '@/lib/staxis/lifecycle';

const PROPERTY_ID = '10000000-0000-4000-8000-000000000001';
const PROJECTION_ID = '20000000-0000-4000-8000-000000000001';
const SOURCE_ID = '30000000-0000-4000-8000-000000000001';
const SOURCE_RECEIPT_ID = '40000000-0000-4000-8000-000000000001';
const SOURCE_DEFINITION_ID = '50000000-0000-4000-8000-000000000001';
const PROPOSAL_ID = '70000000-0000-4000-8000-000000000001';
const APPROVAL_ID = '80000000-0000-4000-8000-000000000001';
const EXECUTION_RECEIPT_ID = '90000000-0000-4000-8000-000000000001';
const DOMAIN_ID = 'a0000000-0000-4000-8000-000000000001';
const OUTCOME_ID = 'b0000000-0000-4000-8000-000000000002';
const HASH = 'a'.repeat(64);

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
          kind: 'pms_report',
          label: 'PMS report',
          reference: 'Daily room status',
          contractVersion: 'staxis-source-fact.v1',
          sourceDefinitionId: 'source-definition-id',
          claimScope: 'example.claim',
          receiptId: 'receipt-id',
          receiptHash: 'hash',
          effectiveAt: '2026-08-08T12:00:00.000Z',
          asOf: '2026-08-08T12:00:00.000Z',
          observedAt: '2026-08-08T12:00:00.000Z',
          receivedAt: '2026-08-08T12:00:00.000Z',
          completeness: 'complete',
          completenessReason: null,
          completenessRequired: 'complete',
          freshness: 'fresh',
          freshnessMaxAgeSeconds: 300,
          owner: { kind: 'pms', label: 'PMS', role: null },
          authority: 1,
          precedence: 1,
        }],
        ['fact-id'],
      ),
      'PMS report · pms_report · Daily room status · 1 source fact recorded · 1 source receipt recorded',
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

  test('fails closed for legacy or malformed successful lifecycle payloads', async () => {
    const { LifecycleProjection } = await import('@/components/concourse/LifecycleProjection');

    const legacyTree = resolveTree(LifecycleProjection({ payload: {} as LifecycleResponse }));
    const legacyText = textOf(legacyTree).join(' ');
    assert.match(legacyText, /complete lifecycle projection/);
    assert.doesNotMatch(legacyText, /No lifecycle records are available/);

    const malformedTree = resolveTree(LifecycleProjection({
      payload: {
        contractVersion: 'staxis-lifecycle.v1',
        generatedAt: '2026-08-08T12:00:00.000Z',
        coverage: { returned: 1, limit: 100, truncated: false },
        items: [{}],
      } as unknown as LifecycleResponse,
    }));
    const malformedText = textOf(malformedTree).join(' ');
    assert.match(malformedText, /complete lifecycle projection/);
    assert.doesNotMatch(malformedText, /No lifecycle records are available/);
  });

  test('renders the safe projection fields in one read-only card', async () => {
    const { LifecycleProjection } = await import('@/components/concourse/LifecycleProjection');
    const payload = {
      contractVersion: 'staxis-lifecycle.v1',
      generatedAt: '2026-08-08T12:00:00.000Z',
      coverage: { returned: 1, limit: 100, truncated: false },
      items: [{
        contractVersion: 'staxis-lifecycle.v1',
        id: PROJECTION_ID,
        propertyId: PROPERTY_ID,
        entity: { kind: 'room', id: 'room-214', label: 'Room 214' },
        title: 'Inspection proposed',
        summary: 'A room needs an inspection.',
        state: 'not_observable' as const,
        priorStates: ['observed', 'proposed', 'approved', 'executed'] as const,
        findingId: '60000000-0000-4000-8000-000000000001',
        proposalId: PROPOSAL_ID,
        approvalId: APPROVAL_ID,
        executionReceiptId: EXECUTION_RECEIPT_ID,
        sourceFactIds: [SOURCE_ID],
        sources: [{
          id: SOURCE_ID,
          kind: 'pms_report',
          label: 'PMS report',
          reference: 'Daily room status',
          contractVersion: 'staxis-source-fact.v1',
          sourceDefinitionId: SOURCE_DEFINITION_ID,
          claimScope: 'example.claim',
          receiptId: SOURCE_RECEIPT_ID,
          receiptHash: HASH,
          effectiveAt: '2026-08-08T11:00:00.000Z',
          asOf: '2026-08-08T11:00:00.000Z',
          observedAt: '2026-08-08T11:05:00.000Z',
          receivedAt: '2026-08-08T11:06:00.000Z',
          completeness: 'complete' as const,
          completenessReason: null,
          completenessRequired: 'complete',
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
        authority: { owner: { kind: 'human' as const, label: 'Morgan', role: 'GM' }, level: 1, precedence: 1, scopes: [{ claimScope: 'example.claim', authority: 1, precedence: 1 }] },
        action: {
          id: PROPOSAL_ID,
          kind: 'create_work_order',
          contractVersion: 'staxis-action.v1',
          effect: {
            domain: 'hotel operations',
            operation: 'create work order',
            targetKind: 'work order',
            boundary: 'in_app_only' as const,
            statement: 'Creates one in-app work order.',
            limit: 'Does not contact a vendor or confirm physical completion.',
          },
          authority: { propertyScoped: true, roles: ['manager'], capability: null, surfaces: ['feed'] },
          targetId: DOMAIN_ID,
          approval: { mode: 'explicit_card' as const, tier: 'card' as const, policyId: 'policy', state: 'approved' as const },
          frozenInput: { immutable: true as const, fields: ['propertyId'], fingerprint: 'server_sha256' as const, staleInput: 'decline' as const, hash: HASH },
          idempotency: { scope: 'property_action' as const, keyFields: ['propertyId'], retry: 'first_receipt' as const },
          receipt: { contractVersion: 'staxis-action.v1', requiredFields: ['id'], internalOnly: true as const, physicalCompletionClaim: 'never' as const },
          outcome: {
            observability: 'not_observable' as const,
            verificationState: 'not_observable' as const,
            verificationWindowDays: 1,
            basisRequired: true as const,
            state: 'not_observable' as const,
            basis: 'The source does not expose completion.',
            observedAt: '2026-08-08T11:06:00.000Z',
          },
        },
        domainWorkItem: { kind: 'work_order', id: DOMAIN_ID, label: 'Room 214 inspection', href: null, observedAt: '2026-08-08T11:06:00.000Z', owner: { kind: 'human' as const, label: 'Morgan', role: 'GM' } },
        outcome: { state: 'not_observable' as const, basis: 'The source does not expose completion.', sourceFactId: null, observedAt: '2026-08-08T11:06:00.000Z' },
        outcomeEvidenceId: OUTCOME_ID,
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
    assert.match(rendered, /Outcome evidence recorded/);
    const completedSteps = findAll(tree, (props) => props.className === 'fx-life-state fx-life-state-on');
    assert.equal(completedSteps.length, 4);
    assert.equal(findAll(tree, (props) => props.className === 'fx-life-state fx-life-state-terminal').length, 1);

    const truncatedPayload = {
      ...payload,
      coverage: { returned: 100, limit: 100 as const, truncated: true },
      items: Array.from({ length: 100 }, (_, index) => ({
        ...payload.items[0],
        id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      })),
    } satisfies LifecycleResponse;
    const truncatedTree = resolveTree(LifecycleProjection({ payload: truncatedPayload }));
    assert.match(textOf(truncatedTree).join(' '), /Showing the latest 100 lifecycle records; older records are not included in this view\./);

    assert.ok(parseLifecycleResponse(payload));
    assert.equal(parseLifecycleResponse({ ...payload, generatedAt: 'not-a-date' }), null);
    assert.equal(parseLifecycleResponse({ ...payload, coverage: { returned: 0, limit: 100, truncated: false } }), null);
    assert.equal(parseLifecycleResponse({ ...payload, items: [{ ...payload.items[0], proposalId: 'not-a-uuid' }] }), null);
    assert.equal(parseLifecycleResponse({ ...payload, items: [{ ...payload.items[0], sources: [{ ...payload.items[0].sources[0], observedAt: 'not-a-date' }] }] }), null);
    assert.equal(parseLifecycleResponse({
      ...payload,
      items: [{
        ...payload.items[0],
        action: {
          ...payload.items[0].action!,
          effect: { ...payload.items[0].action!.effect, boundary: 'external_side_effect' as never },
        },
      }],
    }), null);
    assert.equal(parseLifecycleResponse({
      ...payload,
      items: [{
        ...payload.items[0],
        action: { ...payload.items[0].action!, approval: { ...payload.items[0].action!.approval, state: 'unknown' as never } },
      }],
    }), null);
    assert.equal(parseLifecycleResponse({
      ...payload,
      items: [{
        ...payload.items[0],
        action: { ...payload.items[0].action!, outcome: { ...payload.items[0].action!.outcome, state: 'success' as never, verificationState: 'success' as never } },
      }],
    }), null);
    assert.equal(parseLifecycleResponse({
      ...payload,
      items: [{
        ...payload.items[0],
        domainWorkItem: { ...payload.items[0].domainWorkItem!, href: 'https://outside.example' as never },
      }],
    }), null);
    assert.equal(parseLifecycleResponse({
      ...payload,
      coverage: { returned: 2, limit: 100, truncated: false },
      items: [payload.items[0], { ...payload.items[0] }],
    }), null);
  });
});
