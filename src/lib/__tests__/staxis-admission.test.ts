import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  persistLifecycleBundle,
  toSourceFactRpcBundle,
  toLifecycleRpcBundle,
  validateLifecycleBundleRpcReceipt,
  validateSourceFactWriteInput,
  validateLifecycleAdmission,
  validateLifecycleAppendEvent,
  type LifecycleAdmissionBundle,
} from '../staxis/admission';
import type { ActionAdmissionContract, ActionScopeDefinition, SourceFactContract, SourceScopeDefinition } from '../staxis/foundation';
import { allActions } from '../findings/actions/registry';
import '../findings/actions/catalog';

const PID = '20000000-0000-4000-8000-000000000011';
const FACT_ID = '30000000-0000-4000-8000-000000000011';
const RECEIPT_ID = '40000000-0000-4000-8000-000000000011';
const DEFINITION_ID = '50000000-0000-4000-8000-000000000011';
const FINDING_ID = '60000000-0000-4000-8000-000000000011';
const ACTION_DEFINITION_ID = '82000000-0000-4000-8000-000000000011';
const HASH = 'b'.repeat(64);
const NOW = new Date('2026-08-08T10:30:00.000Z');

const sourceWrite = {
  propertyId: PID,
  sourceDefinitionId: DEFINITION_ID,
  sourceReference: 'record:record-1',
  externalReceiptId: 'upstream-record-1',
  sourceHash: 'c'.repeat(64),
  asOf: '2026-08-08T10:00:00.000Z',
  observedAt: '2026-08-08T10:10:00.000Z',
  receivedAt: '2026-08-08T10:20:00.000Z',
  completeness: 'complete' as const,
  completenessReason: null,
  entityKind: 'record',
  entityId: 'record-1',
  entityLabel: 'Example record',
  effectiveAt: '2026-08-08T10:00:00.000Z',
  expiresAt: '2026-08-08T11:00:00.000Z',
  value: { state: 'active' },
  supersedesId: null,
};

const definition: SourceScopeDefinition = Object.freeze({
  id: DEFINITION_ID,
  propertyId: PID,
  sourceKind: 'app_owned',
  producerKey: 'example-producer',
  category: 'example-record',
  entityKind: 'record',
  claimScope: 'example.claim',
  owner: 'app',
  authority: 4,
  precedence: 2,
  freshnessMaxAgeSeconds: 3_600,
  completenessRequired: 'complete',
  reviewedAt: '2026-08-01T00:00:00.000Z',
});

const sourceFact: SourceFactContract = {
  id: FACT_ID,
  propertyId: PID,
  entityKind: 'record',
  entityId: 'record-1',
  entityLabel: 'Example record',
  contractVersion: 'staxis-source-fact.v1',
  sourceKind: 'app_owned',
  sourceDefinitionId: DEFINITION_ID,
  claimScope: 'example.claim',
  sourceReference: 'record:record-1',
  receiptId: RECEIPT_ID,
  receiptHash: HASH,
  receivedAt: '2026-08-08T10:20:00.000Z',
  asOf: '2026-08-08T10:00:00.000Z',
  observedAt: '2026-08-08T10:10:00.000Z',
  effectiveAt: '2026-08-08T10:00:00.000Z',
  expiresAt: '2026-08-08T11:00:00.000Z',
  completeness: 'complete',
  completenessReason: null,
  freshness: 'fresh',
  freshnessMaxAgeSeconds: 3_600,
  owner: 'app',
  authority: 4,
  precedence: 2,
  value: { state: 'active' },
  fingerprint: HASH,
  supersedesId: null,
};

function bundle(overrides: Partial<LifecycleAdmissionBundle> = {}): LifecycleAdmissionBundle {
  return {
    propertyId: PID,
    findingId: FINDING_ID,
    sourceDefinitions: [definition],
    actionDefinitions: [],
    sourceFacts: [sourceFact],
    finding: {
      propertyId: PID,
      detectorId: 'example.claim.check',
      receiptQueryId: 'example-claim-receipt-v1',
      evidence: { queryId: 'example-claim-receipt-v1', params: { id: 'record-1' }, values: { state: 'active' }, basis: 'Example source evidence.' },
      minimumData: { met: true, required: ['id'], provided: ['id'], missing: [] },
      asOf: sourceFact.asOf,
      observedAt: sourceFact.observedAt,
      expiresAt: sourceFact.expiresAt,
      completeness: 'complete',
      freshness: 'fresh',
      freshnessMaxAgeSeconds: 3_600,
      sourceFactIds: [FACT_ID],
    },
    lifecycle: {
      entityKind: 'record',
      entityId: FACT_ID,
      entityLabel: 'Example record',
      title: 'Example observation',
      summary: 'An admitted example record observation.',
      owner: { kind: 'app', label: 'Example source', role: 'system' },
      ownerId: null,
      actionFindingId: null,
      pendingActionId: null,
      idempotencyKey: `${FINDING_ID}:record`,
      approvalRequired: false,
      conversationId: null,
      accountId: null,
      conversationSnapshot: {},
      accountSnapshot: {},
      reason: null,
    },
    action: null,
    ...overrides,
  };
}

function actionBundle(overrides: Partial<LifecycleAdmissionBundle> = {}): LifecycleAdmissionBundle {
  const contract = allActions()[0]?.actionContract as ActionAdmissionContract;
  const actionDefinition: ActionScopeDefinition = {
    id: ACTION_DEFINITION_ID,
    propertyId: PID,
    category: 'example-action',
    actionKind: 'create_work_order',
    contract,
    reviewedAt: '2026-08-01T00:00:00.000Z',
  };
  return bundle({
    lifecycle: { ...bundle().lifecycle, approvalRequired: true },
    actionDefinitions: [actionDefinition],
    action: {
      id: null,
      actionDefinitionId: ACTION_DEFINITION_ID,
      propertyId: PID,
      findingId: FINDING_ID,
      proposalId: '81000000-0000-4000-8000-000000000011',
      kind: 'create_work_order',
      contract,
      params: { location: 'Example record' },
      verify: { baseline: 1 },
      idempotencyKey: 'example-proposal',
    },
    ...overrides,
  });
}

describe('opt-in lifecycle bundle admission', () => {
  test('accepts a complete source/finding bundle and derives custody server-side', async () => {
    const admitted = validateLifecycleAdmission(bundle(), NOW);
    assert.equal(admitted.admissible, true, admitted.reasons.join('; '));
    let writes = 0;
    const result = await persistLifecycleBundle(bundle(), async () => { writes += 1; }, NOW);
    assert.equal(result.admissible, true);
    assert.equal(writes, 1);
  });

  test('rejects cross-property facts before invoking the writer', async () => {
    let writes = 0;
    const result = await persistLifecycleBundle(bundle({ sourceFacts: [{ ...sourceFact, propertyId: '20000000-0000-4000-8000-000000000012' }] }), async () => { writes += 1; }, NOW);
    assert.equal(result.admissible, false);
    assert.equal(writes, 0);
  });

  test('turns custody-writer failure into an explicit failed admission', async () => {
    const result = await persistLifecycleBundle(bundle(), async () => { throw new Error('custody unavailable'); }, NOW);
    assert.equal(result.admissible, false);
    assert.match(result.reasons.join(' '), /custody unavailable/);
  });

  test('does not treat an ambiguous writer receipt as a successful custody write', async () => {
    const writer = (async () => ({ admitted: false })) as unknown as Parameters<typeof persistLifecycleBundle>[1];
    const result = await persistLifecycleBundle(bundle(), writer, NOW);
    assert.equal(result.admissible, false);
    assert.match(result.reasons.join(' '), /ambiguous receipt/);
  });

  test('rejects an action bundle with missing safety metadata before custody writes', () => {
    const result = validateLifecycleAdmission(bundle({
      action: {
        id: '80000000-0000-4000-8000-000000000011',
        actionDefinitionId: ACTION_DEFINITION_ID,
        propertyId: PID,
        findingId: FINDING_ID,
        proposalId: '81000000-0000-4000-8000-000000000011',
        kind: 'example_action',
        contract: {} as never,
        params: {},
        verify: {},
        idempotencyKey: 'example',
      },
    }), NOW);
    assert.equal(result.admissible, false);
    assert.ok(result.reasons.some((reason) => /action contract/.test(reason)));
  });

  test('requires explicit approval for an admitted action proposal', () => {
    const result = validateLifecycleAdmission(actionBundle({ lifecycle: { ...bundle().lifecycle, approvalRequired: false } }), NOW);
    assert.ok(result.reasons.some((reason) => /explicit approval/.test(reason)));
  });

  test('requires a reviewed same-property action definition and exact contract match', () => {
    assert.equal(validateLifecycleAdmission(actionBundle(), NOW).admissible, true);
    assert.equal(validateLifecycleAdmission(actionBundle({ actionDefinitions: [] }), NOW).admissible, false);
    assert.equal(validateLifecycleAdmission(actionBundle({ actionDefinitions: [{ ...actionBundle().actionDefinitions[0], propertyId: '20000000-0000-4000-8000-000000000012' }] }), NOW).admissible, false);
    const definition = actionBundle().actionDefinitions[0];
    assert.ok(definition);
    assert.equal(validateLifecycleAdmission(actionBundle({ actionDefinitions: [{ ...definition, contract: { ...definition.contract, effect: { ...definition.contract.effect, limit: 'changed' } } }] }), NOW).admissible, false);
  });

  test('maps only the explicit RPC envelope and preserves the property boundary', () => {
    const mapped = toLifecycleRpcBundle(bundle());
    assert.equal(mapped.propertyId, PID);
    assert.equal(mapped.findingId, FINDING_ID);
    assert.equal(mapped.contractVersion, 'staxis-source-fact.v1');
    assert.deepEqual(mapped.sourceFactIds, [FACT_ID]);
    assert.equal(mapped.minimumDataMet, true);
    assert.equal(mapped.lifecycle.entityKind, 'record');
    assert.equal(mapped.lifecycle.actionContract, null);
    assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'sourceFacts'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'sourceDefinitions'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'custodyLinks'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(mapped.lifecycle, 'custodyLinks'), false);
  });

  test('requires a complete lifecycle RPC receipt and exact source-fact replay set', () => {
    const receipt = {
      admitted: true,
      replayed: false,
      admissionId: '91000000-0000-4000-8000-000000000011',
      lifecycleId: FINDING_ID,
      proposalId: null,
      frozenInputHash: null,
      sourceFactIds: [FACT_ID],
    };
    assert.deepEqual(validateLifecycleBundleRpcReceipt(receipt, bundle()), []);
    assert.ok(validateLifecycleBundleRpcReceipt({ ...receipt, replayed: 'false' }, bundle()).some((reason) => /replay flag/.test(reason)));
    assert.ok(validateLifecycleBundleRpcReceipt({ ...receipt, sourceFactIds: [FACT_ID, FACT_ID] }, bundle()).some((reason) => /duplicated/.test(reason)));
    assert.ok(validateLifecycleBundleRpcReceipt({ ...receipt, sourceFactIds: [] }, bundle()).some((reason) => /do not match/.test(reason)));
    const action = actionBundle();
    assert.deepEqual(validateLifecycleBundleRpcReceipt({ ...receipt, proposalId: action.action?.proposalId, frozenInputHash: 'a'.repeat(64) }, action), []);
    assert.ok(validateLifecycleBundleRpcReceipt({ ...receipt, proposalId: null, frozenInputHash: null }, action).some((reason) => /proposal hash/.test(reason)));
  });

  test('custody owner/domain updates are same-state and cannot imply execution', () => {
    const event = {
      lifecycleId: FINDING_ID,
      eventKind: 'custody_updated' as const,
      fromState: 'executed' as const,
      toState: 'executed' as const,
      actorAccountId: '70000000-0000-4000-8000-000000000011',
      actorSnapshot: { role: 'general_manager', authority: 'hotel-manager' },
      ownerSnapshot: { kind: 'unassigned' as const, label: null, role: null },
      domainReference: { kind: 'record', id: FACT_ID, label: 'Example record', href: null },
      idempotencyKey: `${FINDING_ID}:owner:1`,
    };
    assert.deepEqual(validateLifecycleAppendEvent(event), []);
    assert.ok(validateLifecycleAppendEvent({ ...event, toState: 'outcome_verified' as const }).some((reason) => /cannot advance/.test(reason)));
    assert.ok(validateLifecycleAppendEvent({ ...event, executionReceipt: {} as never }).some((reason) => /execution/.test(reason)));
  });

  test('approval/execution transitions require an authenticated authority snapshot', () => {
    const event = {
      lifecycleId: FINDING_ID,
      eventKind: 'state_transition' as const,
      fromState: 'proposed' as const,
      toState: 'approved' as const,
      actorAccountId: null,
      actorSnapshot: {},
      ownerSnapshot: { kind: 'app' as const, label: 'Example source', role: 'system' },
      domainReference: null,
      idempotencyKey: `${FINDING_ID}:approval:1`,
    };
    const reasons = validateLifecycleAppendEvent(event);
    assert.ok(reasons.some((reason) => /authenticated actor/.test(reason)));
    assert.ok(reasons.some((reason) => /authority actor snapshot/.test(reason)));
  });

  test('execution receipts cannot cross the scoped property boundary', () => {
    const event = {
      lifecycleId: FINDING_ID,
      eventKind: 'state_transition' as const,
      fromState: 'approved' as const,
      toState: 'executed' as const,
      actorAccountId: '70000000-0000-4000-8000-000000000011',
      actorSnapshot: { role: 'general_manager', authority: 'hotel-manager' },
      ownerSnapshot: { kind: 'app' as const, label: 'Example source', role: 'system' },
      domainReference: { kind: 'record', id: FACT_ID, label: 'Example record', href: null },
      executionReceipt: { propertyId: '20000000-0000-4000-8000-000000000012' } as never,
      idempotencyKey: `${FINDING_ID}:execute:property-boundary`,
    };
    assert.ok(validateLifecycleAppendEvent(event, PID).some((reason) => /scoped writer/.test(reason)));
  });
});

describe('source fact write envelope', () => {
  test('maps raw source content without caller-owned durable IDs or hashes', () => {
    assert.deepEqual(validateSourceFactWriteInput(sourceWrite, NOW), []);
    const mapped = toSourceFactRpcBundle(sourceWrite);
    assert.equal(mapped.propertyId, PID);
    assert.equal((mapped as { sourceDefinitionId: string }).sourceDefinitionId, DEFINITION_ID);
    assert.equal((mapped as { receipt: { sourceHash: string } }).receipt.sourceHash, 'c'.repeat(64));
    assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'receiptHash'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'fingerprint'), false);
  });

  test('rejects unsafe references and caller-generated future receipt clocks', () => {
    assert.ok(validateSourceFactWriteInput({ ...sourceWrite, sourceReference: 'storage/private/report.pdf' }, NOW).some((reason) => /private path/.test(reason)));
    assert.ok(validateSourceFactWriteInput({ ...sourceWrite, receivedAt: '2026-08-08T11:00:01.000Z' }, NOW).some((reason) => /future/.test(reason)));
  });
});
