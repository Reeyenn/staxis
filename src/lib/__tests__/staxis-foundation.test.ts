import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_CONTRACT_VERSION,
  SOURCE_FACT_CONTRACT_VERSION,
  admitFinding,
  admitSourceFact,
  type ActionAdmissionContract,
  type ActionScopeDefinition,
  type SourceScopeDefinition,
  validateActionContract,
  validateActionScopeDefinition,
  validateSourceScopeDefinition,
} from '../staxis/foundation';
import { allActions } from '../findings/actions/registry';
import { actionContractErrorsFor, listAllTools } from '../agent/tools';
import '../findings/actions/catalog';
import '../agent/tools/index';

const PID = '20000000-0000-4000-8000-000000000001';
const OTHER_PID = '20000000-0000-4000-8000-000000000002';
const FACT_ID = '30000000-0000-4000-8000-000000000001';
const RECEIPT_ID = '40000000-0000-4000-8000-000000000001';
const DEFINITION_ID = '50000000-0000-4000-8000-000000000001';
const PMS_DEFINITION_ID = '50000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-08-08T10:30:00.000Z');
const HASH = 'a'.repeat(64);

const definition: SourceScopeDefinition = Object.freeze({
  id: DEFINITION_ID,
  propertyId: PID,
  sourceKind: 'app_owned',
  producerKey: 'example-producer',
  category: 'example-record',
  entityKind: 'record',
  claimScope: 'example.claim',
  owner: 'app',
  authority: 7,
  precedence: 3,
  freshnessMaxAgeSeconds: 3_600,
  completenessRequired: 'complete',
  reviewedAt: '2026-08-01T00:00:00.000Z',
});

function fact(overrides: Record<string, unknown> = {}) {
  return {
    id: FACT_ID,
    propertyId: PID,
    entityKind: 'record',
    entityId: 'record-1',
    entityLabel: 'Example record',
    contractVersion: SOURCE_FACT_CONTRACT_VERSION,
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
    authority: 7,
    precedence: 3,
    value: { role: 'front_desk' },
    fingerprint: HASH,
    supersedesId: null,
    ...overrides,
  } as const;
}

function validFinding(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: PID,
    detectorId: 'example.claim.check',
    receiptQueryId: 'example-claim-receipt-v1',
    evidence: {
      queryId: 'example-claim-receipt-v1',
      params: { recordId: 'record-1' },
      values: { state: 'active' },
      basis: 'The example record was read from the app-owned source.',
    },
    minimumData: {
      met: true,
      required: ['recordId', 'state'],
      provided: ['recordId', 'state'],
      missing: [],
    },
    asOf: '2026-08-08T10:00:00.000Z',
    observedAt: '2026-08-08T10:10:00.000Z',
    expiresAt: '2026-08-08T11:00:00.000Z',
    completeness: 'complete',
    freshness: 'fresh',
    freshnessMaxAgeSeconds: 3_600,
    sourceFactIds: [FACT_ID],
    sourceFacts: [fact()],
    sourceDefinitions: [definition],
    ...overrides,
  } as const;
}

describe('source-backed fact admission', () => {
  test('requires an explicitly loaded scoped definition and durable receipt', () => {
    assert.equal(admitSourceFact(fact(), NOW).admissible, false);
    assert.equal(admitSourceFact(fact({ receiptId: null }), NOW, definition).admissible, false);
    assert.equal(admitSourceFact(fact(), NOW, definition).admissible, true);
  });

  test('does not trust caller freshness or hierarchy values', () => {
    const staleClaim = admitSourceFact(fact({ freshness: 'stale' }), NOW, definition);
    assert.equal(staleClaim.admissible, false);
    assert.match(staleClaim.reasons.join(' '), /freshness/);
    assert.equal(admitSourceFact(fact({ authority: 999 }), NOW, definition).admissible, false);
    assert.equal(admitSourceFact(fact({ sourceKind: 'pms_report', claimScope: 'example.claim' }), NOW, definition).admissible, false);
  });

  test('rejects unowned or negative scoped definitions before they can admit a fact', () => {
    assert.ok(validateSourceScopeDefinition({ ...definition, owner: 'unknown' }).length > 0);
    assert.ok(validateSourceScopeDefinition({ ...definition, precedence: -1 }).length > 0);
    assert.equal(validateSourceScopeDefinition({ ...definition, owner: 'human' }).length, 0);
    assert.ok(validateSourceScopeDefinition({ ...definition, reviewedAt: '2026-08-08T10:36:00.000Z' }, NOW).some((reason) => /future/.test(reason)));
  });

  test('keeps as-of, observed, and receipt time distinct and ordered', () => {
    const invalid = admitSourceFact(fact({ observedAt: '2026-08-08T10:25:00.000Z', receivedAt: '2026-08-08T10:00:00.000Z' }), NOW, definition);
    assert.equal(invalid.admissible, false);
    assert.match(invalid.reasons.join(' '), /receipt time/);
  });

  test('admits a reviewed property-scoped PMS report only under the PMS owner', () => {
    const pmsDefinition: SourceScopeDefinition = {
      ...definition,
      id: PMS_DEFINITION_ID,
      sourceKind: 'pms_report',
      owner: 'pms',
      claimScope: 'example.pms.claim',
    };
    const pmsFact = fact({ sourceKind: 'pms_report', sourceDefinitionId: PMS_DEFINITION_ID, claimScope: 'example.pms.claim', owner: 'pms' });
    assert.equal(admitSourceFact(pmsFact, NOW, pmsDefinition).admissible, true);
    assert.equal(admitSourceFact({ ...pmsFact, owner: 'app' }, NOW, pmsDefinition).admissible, false);
    assert.equal(validateSourceScopeDefinition({ ...pmsDefinition, reviewedAt: '' }).length > 0, true);
    assert.equal(admitSourceFact(pmsFact, NOW, { ...pmsDefinition, propertyId: OTHER_PID }).admissible, false);
  });
});

describe('finding admission', () => {
  test('requires minimum-data set inclusion and an exact same-property fact set', () => {
    assert.equal(admitFinding(validFinding(), NOW).admissible, true);
    assert.equal(admitFinding(validFinding({ minimumData: { met: true, required: ['recordId', 'state'], provided: ['recordId'], missing: [] } }), NOW).admissible, false);
    assert.equal(admitFinding(validFinding({ sourceFacts: [fact({ propertyId: OTHER_PID })] }), NOW).admissible, false);
    assert.equal(admitFinding(validFinding({ sourceDefinitions: [] }), NOW).admissible, false);
    assert.equal(admitFinding(validFinding({ sourceFacts: [fact({ owner: 'human' })] }), NOW).admissible, false);
    assert.equal(admitFinding(validFinding({ sourceFacts: [fact(), fact({ id: '30000000-0000-4000-8000-000000000009' })], sourceFactIds: [FACT_ID, '30000000-0000-4000-8000-000000000009'] }), NOW).admissible, false);
  });

  test('recomputes source freshness at finding admission', () => {
    const oldAsOf = fact({ asOf: '2026-08-08T08:00:00.000Z', freshness: 'fresh', receivedAt: '2026-08-08T10:20:00.000Z' });
    const finding = validFinding({ sourceFacts: [oldAsOf], sourceFactIds: [FACT_ID], freshness: 'fresh' });
    const result = admitFinding(finding, NOW);
    assert.equal(result.admissible, false);
    assert.match(result.reasons.join(' '), /freshness/);
  });

  test('derives finding clocks from the linked source facts', () => {
    const result = admitFinding(validFinding({ asOf: '2026-08-08T09:59:00.000Z' }), NOW);
    assert.equal(result.admissible, false);
    assert.match(result.reasons.join(' '), /as-of/);
    const futureReceipt = validFinding({ sourceFacts: [fact({ receivedAt: '2026-08-08T11:00:01.000Z' })] });
    assert.equal(admitFinding(futureReceipt, NOW).admissible, false);
    assert.equal(admitFinding(validFinding({ sourceFacts: [fact({ expiresAt: null })] }), NOW).admissible, true);
  });

  test('cannot outlive the earliest linked evidence horizon', () => {
    const result = admitFinding(validFinding({ expiresAt: '2026-08-08T12:00:00.000Z' }), NOW);
    assert.equal(result.admissible, false);
    assert.match(result.reasons.join(' '), /expiry exceeds/);
    const noExplicitFactExpiry = admitFinding(validFinding({
      expiresAt: '2026-08-08T11:30:00.000Z',
      sourceFacts: [fact({ expiresAt: null })],
    }), NOW);
    assert.equal(noExplicitFactExpiry.admissible, false);
    assert.match(noExplicitFactExpiry.reasons.join(' '), /expiry exceeds/);
  });

  test('admits a reviewed partial observation but never a partial action proof', () => {
    const partialDefinition = { ...definition, completenessRequired: 'partial' as const };
    const partialFact = fact({ completeness: 'partial', completenessReason: 'One optional field was unavailable.' });
    const partialFinding = validFinding({
      completeness: 'partial',
      sourceFacts: [partialFact],
      sourceDefinitions: [partialDefinition],
      minimumData: { met: true, required: ['recordId'], provided: ['recordId'], missing: [], reason: 'One optional field was unavailable.' },
    });
    assert.equal(admitFinding(partialFinding, NOW).admissible, true);
  });
});

describe('action admission', () => {
  test('rejects unsupported external effects and incomplete guarantees', () => {
    const contract = allActions()[0]?.actionContract as ActionAdmissionContract;
    assert.equal(validateActionContract(contract).length, 0);
    assert.ok(validateActionContract({
      ...contract,
      effect: { ...contract.effect, boundary: 'external_side_effect' as never },
    }).some((reason) => /boundary/.test(reason)));
    assert.ok(validateActionContract({
      ...contract,
      frozenInput: { ...contract.frozenInput, fields: [] },
    }).length > 0);
    assert.ok(validateActionContract({
      ...contract,
      authority: { ...contract.authority, capability: 'unverified.capability' },
    }).some((reason) => /capability/.test(reason)));
    const dynamicContract: ActionAdmissionContract = {
      ...contract,
      outcome: { ...contract.outcome, verificationState: 'verified' as const },
    };
    assert.equal(validateActionContract(dynamicContract).length, 0);
    const definition: ActionScopeDefinition = {
      id: '51000000-0000-4000-8000-000000000001',
      propertyId: PID,
      category: 'example-action',
      actionKind: 'example_action',
      contract: dynamicContract,
      reviewedAt: '2026-08-01T00:00:00.000Z',
    };
    assert.ok(validateActionScopeDefinition(definition, NOW).some((reason) => /start pending/.test(reason)));
    const notObservablePending: ActionAdmissionContract = {
      ...contract,
      outcome: { ...contract.outcome, observability: 'not_observable', verificationState: 'pending' },
    };
    assert.equal(validateActionContract(notObservablePending).length, 0);
    assert.equal(validateActionScopeDefinition({ ...definition, contract: notObservablePending }, NOW).length, 0);
    const notObservableTerminal: ActionAdmissionContract = {
      ...notObservablePending,
      outcome: { ...notObservablePending.outcome, verificationState: 'verified' },
    };
    assert.equal(validateActionContract(notObservableTerminal).length, 0);
    assert.ok(validateActionScopeDefinition({ ...definition, contract: notObservableTerminal }, NOW).some((reason) => /start pending/.test(reason)));
  });

  test('central mutating tools remain callable but are not lifecycle-admitted without explicit metadata', () => {
    const mutations = listAllTools().filter((tool) => tool.mutates === true);
    assert.ok(mutations.length > 0);
    for (const tool of mutations) {
      const errors = actionContractErrorsFor(tool.name);
      if (!tool.actionContract) assert.ok(errors.includes('action contract is missing'), tool.name);
      else assert.equal(errors.length, 0, `${tool.name}: ${errors.join('; ')}`);
    }
  });

  test('finding action idempotency metadata matches the effective 0369 rearm key', () => {
    for (const action of allActions()) {
      assert.deepEqual(action.actionContract?.idempotency.keyFields, ['propertyId', 'findingId', 'paramsFingerprint', 'verifyFingerprint'], action.kind);
    }
  });
});
