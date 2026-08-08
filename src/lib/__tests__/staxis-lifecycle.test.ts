import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACTION_CONTRACT_VERSION,
  LIFECYCLE_CONTRACT_VERSION,
  SOURCE_FACT_CONTRACT_VERSION,
} from '../staxis/foundation';
import { parseLifecycleProjectionRow, type LifecycleState } from '../staxis/lifecycle';

const PID = '10000000-0000-4000-8000-000000000001';
const PROJECTION_ID = '20000000-0000-4000-8000-000000000001';
const SOURCE_ID = '30000000-0000-4000-8000-000000000001';
const SOURCE_B_ID = '30000000-0000-4000-8000-000000000002';
const SOURCE_RECEIPT_ID = '40000000-0000-4000-8000-000000000001';
const SOURCE_B_RECEIPT_ID = '40000000-0000-4000-8000-000000000002';
const SOURCE_DEFINITION_ID = '50000000-0000-4000-8000-000000000001';
const SOURCE_B_DEFINITION_ID = '50000000-0000-4000-8000-000000000002';
const ACTION_ID = '60000000-0000-4000-8000-000000000001';
const PROPOSAL_ID = '70000000-0000-4000-8000-000000000001';
const APPROVAL_ID = '80000000-0000-4000-8000-000000000001';
const EXECUTION_RECEIPT_ID = '90000000-0000-4000-8000-000000000001';
const WORK_ITEM_ID = 'a0000000-0000-4000-8000-000000000001';
const OUTCOME_EVENT_ID = 'b0000000-0000-4000-8000-000000000002';
const HASH = 'a'.repeat(64);

const SOURCE = {
  id: SOURCE_ID,
  kind: 'app_owned',
  label: 'Example source',
  reference: 'example:entity-1',
  contractVersion: SOURCE_FACT_CONTRACT_VERSION,
  sourceDefinitionId: SOURCE_DEFINITION_ID,
  claimScope: 'example.claim',
  receiptId: SOURCE_RECEIPT_ID,
  receiptHash: HASH,
  effectiveAt: '2026-08-08T10:00:00.000Z',
  asOf: '2026-08-08T10:00:00.000Z',
  observedAt: '2026-08-08T10:01:00.000Z',
  receivedAt: '2026-08-08T10:02:00.000Z',
  completeness: 'complete',
  completenessReason: null,
  completenessRequired: 'complete',
  freshness: 'fresh',
  freshnessMaxAgeSeconds: 3_600,
  owner: { kind: 'app', label: 'Example source', role: 'system' },
  authority: 7,
  precedence: 3,
};

const SOURCE_B = {
  ...SOURCE,
  id: SOURCE_B_ID,
  sourceDefinitionId: SOURCE_B_DEFINITION_ID,
  claimScope: 'another.claim',
  receiptId: SOURCE_B_RECEIPT_ID,
  authority: 4,
  precedence: 2,
};

function action(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTION_ID,
    kind: 'create_work_order',
    contractVersion: ACTION_CONTRACT_VERSION,
    effect: {
      domain: 'hotel operations',
      operation: 'create work order',
      targetKind: 'work order',
      boundary: 'in_app_only',
      statement: 'Creates one in-app work order.',
      limit: 'Does not contact a vendor or confirm physical completion.',
    },
    targetId: WORK_ITEM_ID,
    authority: {
      propertyScoped: true,
      roles: ['manager'],
      capability: null,
      surfaces: ['feed'],
    },
    approval: {
      mode: 'explicit_card',
      tier: 'card',
      policyId: 'work-order-approval-v1',
      state: 'required',
    },
    frozenInput: {
      immutable: true,
      fields: ['property_id', 'target_id'],
      fingerprint: 'server_sha256',
      staleInput: 'decline',
      hash: HASH,
    },
    idempotency: {
      scope: 'property_action',
      keyFields: ['property_id', 'target_id'],
      retry: 'first_receipt',
    },
    receipt: {
      contractVersion: ACTION_CONTRACT_VERSION,
      requiredFields: ['id', 'action', 'recorded_at'],
      internalOnly: true,
      physicalCompletionClaim: 'never',
    },
    outcome: {
      observability: 'conditional',
      verificationState: 'pending',
      verificationWindowDays: 7,
      basisRequired: true,
      state: 'pending',
      basis: null,
      observedAt: null,
    },
    ...overrides,
  };
}

function baseRow(state: LifecycleState): Record<string, unknown> {
  const executed = state === 'executed' || state === 'outcome_verified' || state === 'not_observable' || state === 'unverifiable';
  const terminal = state === 'outcome_verified' || state === 'not_observable' || state === 'unverifiable';
  const priorStates: LifecycleState[] = state === 'observed'
    ? []
    : state === 'proposed'
      ? ['observed']
      : state === 'approved'
        ? ['observed', 'proposed']
        : state === 'executed'
          ? ['observed', 'proposed', 'approved']
          : ['observed', 'proposed', 'approved', 'executed'];
  const approvalState = state === 'proposed' ? 'required' : state === 'observed' ? 'required' : 'approved';
  const outcomeState = state === 'outcome_verified' ? 'verified' : terminal ? state : executed ? 'pending' : 'pending';
  const evidence = terminal
    ? { basis: state === 'outcome_verified' ? 'The app-owned receipt confirms the in-app record.' : 'The trusted source does not expose completion.', observedAt: '2026-08-08T10:04:00.000Z' }
    : { basis: null, observedAt: null };
  const itemAction = state === 'observed' ? null : action({
    id: PROPOSAL_ID,
    targetId: state === 'proposed' || state === 'approved' ? null : WORK_ITEM_ID,
    approval: { ...action().approval, state: approvalState },
    outcome: { ...action().outcome, verificationState: outcomeState, state: outcomeState, ...evidence },
  });
  const itemOutcome = state === 'observed' || state === 'proposed' || state === 'approved'
    ? null
    : state === 'executed'
      ? { id: null, state: 'pending', basis: null, sourceFactId: null, observed_at: null }
      : { id: OUTCOME_EVENT_ID, state: outcomeState, basis: evidence.basis, sourceFactId: state === 'outcome_verified' ? SOURCE_ID : null, observed_at: evidence.observedAt };
  return {
    contract_version: LIFECYCLE_CONTRACT_VERSION,
    projection_id: PROJECTION_ID,
    property_id: PID,
    entity_kind: 'example_entity',
    entity_id: 'room-214',
    entity_label: 'Ava',
    title: `Example lifecycle ${state}`,
    summary: 'A bounded lifecycle projection.',
    state,
    prior_states: priorStates,
    finding_id: 'c0000000-0000-4000-8000-000000000001',
    proposal_id: state === 'observed' ? null : PROPOSAL_ID,
    approval_id: state === 'approved' || executed ? APPROVAL_ID : null,
    execution_receipt_id: executed ? EXECUTION_RECEIPT_ID : null,
    outcome_evidence_id: terminal ? OUTCOME_EVENT_ID : null,
    source_fact_ids: [SOURCE_ID],
    sources: [SOURCE],
    effective_at: '2026-08-08T10:00:00.000Z',
    as_of: '2026-08-08T10:00:00.000Z',
    observed_at: '2026-08-08T10:01:00.000Z',
    recorded_at: '2026-08-08T10:05:00.000Z',
    freshness: { status: 'fresh', max_age_seconds: 3_600 },
    completeness: { status: 'complete', reason: null },
    authority: { owner: { kind: 'app', label: 'Example source', role: 'system' }, level: 7, precedence: 3, scopes: [{ claimScope: 'example.claim', authority: 7, precedence: 3 }] },
    action: itemAction,
    domain_work_item: executed ? { kind: 'work_order', id: WORK_ITEM_ID, label: 'Inspect example record', href: null, observedAt: '2026-08-08T10:04:00.000Z', owner: { kind: 'human', label: 'Morgan', role: 'GM' } } : null,
    outcome: itemOutcome,
    reason: null,
  };
}

describe('strict lifecycle projection parser', () => {
  test('accepts every legal state and preserves the lifecycle history', () => {
    const states: LifecycleState[] = ['observed', 'proposed', 'approved', 'executed', 'outcome_verified', 'not_observable', 'unverifiable'];
    for (const state of states) {
      const parsed = parseLifecycleProjectionRow(baseRow(state));
      assert.ok(parsed, state);
      assert.equal(parsed?.state, state);
      if (state === 'not_observable' || state === 'unverifiable') {
        assert.deepEqual(parsed?.priorStates, ['observed', 'proposed', 'approved', 'executed']);
      }
    }
  });

  test('accepts an observed projection without an action', () => {
    const parsed = parseLifecycleProjectionRow(baseRow('observed'));
    assert.equal(parsed?.action, null);
    assert.equal(parsed?.outcome, null);
  });

  test('accepts an executed projection and a verified outcome', () => {
    const executed = parseLifecycleProjectionRow(baseRow('executed'));
    const verified = parseLifecycleProjectionRow(baseRow('outcome_verified'));
    assert.equal(executed?.executionReceiptId, EXECUTION_RECEIPT_ID);
    assert.equal(executed?.action?.outcome.state, 'pending');
    assert.equal(executed?.outcome?.state, 'pending');
    assert.equal(verified?.action?.outcome.state, 'verified');
    assert.equal(verified?.outcome?.state, 'verified');
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('executed'), outcome: null }), null);
  });

  test('rejects malformed dates and chronology', () => {
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), recorded_at: 'not-a-date' }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), source_fact_ids: [], sources: [] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), finding_id: null }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), as_of: null }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, asOf: '2026-08-08T10:03:00.000Z' }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, receivedAt: '2026-08-08T10:06:00.000Z' }] }), null);
    assert.ok(parseLifecycleProjectionRow({
      ...baseRow('observed'),
      entity_id: 'room-214',
      effective_at: '2026-08-08T12:00:00.000Z',
      sources: [{ ...SOURCE, effectiveAt: '2026-08-08T12:00:00.000Z' }],
    }));
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), entity_id: 214 }), null);
  });

  test('rejects invalid, duplicate, or mismatched source identity sets', () => {
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), source_fact_ids: ['not-a-uuid'] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), source_fact_ids: [SOURCE_ID, SOURCE_ID] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, id: 'd0000000-0000-4000-8000-000000000001' }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [SOURCE, { ...SOURCE, id: 'd0000000-0000-4000-8000-000000000001' }] }), null);
  });

  test('requires durable source receipts, registered class, and explicit owners', () => {
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, receiptId: null }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, receiptHash: 'short' }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, receiptHash: HASH.toUpperCase() }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, kind: 'unknown' }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, owner: null }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, completenessRequired: 'yes' }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, completeness: 'partial' }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, reference: 'storage/raw/report.json' }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [{ ...SOURCE, freshness: 'unknown' }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), freshness: { status: 'stale', max_age_seconds: 3_600 } }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), completeness: { status: 'partial', reason: 'incorrect aggregate' } }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), authority: { owner: { kind: 'human', label: null, role: null }, level: 1, precedence: 1, scopes: [{ claimScope: 'example.claim', authority: 7, precedence: 3 }] } }), null);
    assert.ok(parseLifecycleProjectionRow({
      ...baseRow('observed'),
      source_fact_ids: [SOURCE_ID, SOURCE_B_ID],
      sources: [SOURCE, SOURCE_B],
      authority: {
        owner: { kind: 'unknown', label: null, role: null },
        level: null,
        precedence: null,
        scopes: [
          { claimScope: 'example.claim', authority: 7, precedence: 3 },
          { claimScope: 'another.claim', authority: 4, precedence: 2 },
        ],
      },
    }));
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), authority: { owner: { kind: 'app', label: 'Example source', role: 'system' }, level: -1, precedence: 3, scopes: [{ claimScope: 'example.claim', authority: 7, precedence: 3 }] } }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), authority: { owner: { kind: 'app', label: 'Example source', role: 'system' }, level: 101, precedence: 3, scopes: [{ claimScope: 'example.claim', authority: 101, precedence: 3 }] } }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), authority: { owner: { kind: 'app', label: 'Example source', role: 'system' }, level: 4, precedence: 2, scopes: [{ claimScope: 'another.claim', authority: 4, precedence: 2 }] } }), null);
  });

  test('rejects malformed action contracts instead of casting them into success', () => {
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('proposed'), action: action({ effect: { ...action().effect, boundary: 'external_side_effect' } }) }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('proposed'), action: action({ approval: { ...action().approval, state: 'maybe' } }) }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('proposed'), action: action({ frozenInput: { ...action().frozenInput, hash: 'not-a-hash' } }) }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('proposed'), action: action({ receipt: { ...action().receipt, contractVersion: 'wrong' } }) }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('proposed'), action: action({ outcome: { ...action().outcome, verificationState: 'success', state: 'success' } }) }), null);
  });

  test('rejects unknown states, silently filtered elements, and illegal history', () => {
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), state: 'healthy' }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), sources: [SOURCE, { ...SOURCE, id: 'not-a-uuid' }] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('approved'), prior_states: ['observed', 'unknown'] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('not_observable'), prior_states: [] }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('executed'), prior_states: ['observed', 'proposed'] }), null);
  });

  test('rejects lifecycle rows whose links do not match the state chain', () => {
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('observed'), proposal_id: PROPOSAL_ID }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('proposed'), proposal_id: null }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('proposed'), action: action({ id: ACTION_ID }) }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('proposed'), domain_work_item: { kind: 'work_order', id: WORK_ITEM_ID, label: 'Unexpected', href: null, observedAt: '2026-08-08T10:04:00.000Z', owner: { kind: 'human', label: 'Morgan', role: 'GM' } } }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('approved'), approval_id: null }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('approved'), action: action({ targetId: WORK_ITEM_ID }) }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('executed'), domain_work_item: null }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('executed'), action: action({ targetId: 'a1000000-0000-4000-8000-000000000001' }) }), null);
  });

  test('requires outcome evidence for verified and uncertainty terminals', () => {
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('outcome_verified'), outcome: { state: 'verified', basis: null, observed_at: null } }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('unverifiable'), outcome: { state: 'unverifiable', basis: 'No receipt', observed_at: null } }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('not_observable'), action: action({ approval: { ...action().approval, state: 'approved' }, outcome: { ...action().outcome, verificationState: 'pending', state: 'pending' } }) }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('outcome_verified'), outcome_evidence_id: null }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('outcome_verified'), outcome: { ...baseRow('outcome_verified').outcome as Record<string, unknown>, sourceFactId: null } }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('outcome_verified'), outcome: { ...baseRow('outcome_verified').outcome as Record<string, unknown>, sourceFactId: 'd0000000-0000-4000-8000-000000000001' } }), null);
    assert.equal(parseLifecycleProjectionRow({ ...baseRow('not_observable'), outcome: { ...baseRow('not_observable').outcome as Record<string, unknown>, sourceFactId: SOURCE_ID } }), null);
  });

  test('requires a timestamp for domain custody snapshots', () => {
    const row = baseRow('executed');
    const domain = row.domain_work_item;
    assert.ok(domain && typeof domain === 'object');
    if (domain && typeof domain === 'object') {
      const withoutObservedAt = {
        ...row,
        domain_work_item: Object.fromEntries(Object.entries(domain).filter(([key]) => key !== 'observedAt')),
      };
      assert.equal(parseLifecycleProjectionRow(withoutObservedAt), null);
      assert.equal(parseLifecycleProjectionRow({ ...row, domain_work_item: { ...domain, observedAt: '2026-08-08T10:06:00.000Z' } }), null);
    }
  });
});
