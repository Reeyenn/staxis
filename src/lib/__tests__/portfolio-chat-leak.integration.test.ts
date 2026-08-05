/**
 * CROSS-HOTEL CHAT, AGAINST A REAL POSTGRES HOLDING TWO COMPANIES.
 *
 * The product is one sentence: a VP whose company turned cross-hotel chat on can
 * ask the copilot about their own hotels. Every risk in it is the same sentence
 * read backwards — somebody who is not a VP, a company that did not turn it on,
 * or a hotel that is not theirs.
 *
 * So this file drives the current portfolio route against a two-company
 * fixture, with company B planted louder than company A wherever a
 * cross-company read could leak into an answer.
 *
 * WHAT IS PROVED HERE
 *   1. company A's VP gets company A's numbers, exactly, and never company B's;
 *   2. a property-scope person is refused at the route;
 *   3. a company whose switch is off is refused at the route, from the ABSENCE
 *      of a settings row (the state every company is actually in);
 *   4. a cross-company probe — naming the other company's id — is refused;
 *   5. an org-scoped conversation is read back only while the caller still
 *      passes the gate;
 *   6. the route's deterministic evidence and receipt path never expose
 *      company-B values.
 *
 * NOTE ON RLS: PGlite runs as the table owner, exactly as the service-role key
 * bypasses policies in production. What is under test is app-level scoping.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  clearPortfolioAccessCache,
  resolvePortfolioAccessUncached,
} from '@/lib/company/portfolio';
import { resolveManagementCompanyScopeUncached } from '@/lib/company/authoritative-scope';
import { clearPortfolioHotelCache } from '@/lib/agent/portfolio/hotels';
import { createConversation, createPortfolioConversation } from '@/lib/agent/memory';
import { PROMPT_VERSION } from '@/lib/agent/prompts';
import {
  GET as portfolioProbe,
  POST as portfolioTurn,
  handlePortfolioGet,
  handlePortfolioPost,
  type PortfolioPostDependencies,
} from '@/app/api/agent/portfolio/route';
import {
  assertAuthorizationScopeReceipt,
  loadAuthorizedPropertyMetadata,
  resolveAuthorizationScope,
} from '@/lib/authorization/server';
import { GET as conversationGet } from '@/app/api/agent/conversations/[id]/route';
import { GET as portfolioConversationGet } from '@/app/api/agent/portfolio/conversations/[id]/route';
import { getAiFeatureDefinition } from '@/lib/ai/feature-registry';
import type { AiExecutionPlan } from '@/lib/ai/runtime';
import { businessDate } from '@/lib/business-date';
import {
  loadConfirmedCompanyKnowledge,
  loadConfirmedPortfolioPropertyKnowledge,
  type CompanyKnowledgeOverlayV1,
  type CompanyKnowledgeRecord,
} from '@/lib/agent/portfolio-intelligence/knowledge';
import {
  buildPortfolioKnowledgeClaimCatalog,
  renderPortfolioKnowledgeAnswer,
  selectPortfolioKnowledgeClaims,
} from '@/lib/agent/portfolio-intelligence/knowledge-presentation';
import { PORTFOLIO_PRESENTATION_OUTPUT_CONFIG } from '@/lib/agent/portfolio-intelligence/presentation';
import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import type { PlannerScopeCatalog, PortfolioKnowledgeQuery } from '@/lib/agent/portfolio-intelligence/schemas';
import { portfolioFindingLoader } from '@/lib/agent/portfolio-intelligence/finding-mount';
import type {
  ManagementPatternPortfolioFindingV1,
  ManagementPatternPortfolioLoadReceipt,
} from '@/lib/company/management-patterns/portfolio-findings';
import { stableFingerprint } from '@/lib/company/management-patterns/canonical';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_FRANK,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ACCOUNT_VERA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  PORTFOLIO_LEAK_MARKER,
  seedPortfolioData,
  UID_FRANK,
  UID_GIL,
  UID_ADMIN,
  UID_MARIA,
  UID_VERA,
  seedTwoCompanies,
  setCrossHotelChat,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

let signedInAs: string | null = null;

/** Company B's fingerprints. Any of these in company A's answer is a leak. */
const LEAK_NEEDLES = [PORTFOLIO_LEAK_MARKER, PID_B1, ORG_B, 'b1b1b1b1-', 'bbbb0000-'];

function leaksIn(value: unknown): string[] {
  const text = JSON.stringify(value ?? null) ?? '';
  return LEAK_NEEDLES.filter((needle) => text.includes(needle));
}

function authorizedRequest(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: 'Bearer portfolio-leak-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.11',
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function postTurn(
  authUserId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; error: string | null; details: unknown }> {
  signedInAs = authUserId;
  const response = await portfolioTurn(
    authorizedRequest('https://staxis.test/api/agent/portfolio', { method: 'POST', body }),
  );
  // A refusal is JSON; an ALLOWED turn is an SSE stream and is never driven here
  // (it would call Anthropic). Every case below is expected to refuse.
  const parsed = await response.json().catch(() => ({})) as {
    error?: string; details?: unknown;
  };
  return { status: response.status, error: parsed.error ?? null, details: parsed.details ?? null };
}

async function probe(authUserId: string, organizationId?: string): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  signedInAs = authUserId;
  const url = new URL('https://staxis.test/api/agent/portfolio');
  if (organizationId) url.searchParams.set('organizationId', organizationId);
  const response = await portfolioProbe(authorizedRequest(url.toString()));
  const parsed = await response.json().catch(() => ({})) as { data?: Record<string, unknown> };
  return { status: response.status, data: parsed.data ?? {} };
}

function parseSse(responseText: string): Array<Record<string, unknown>> {
  return responseText
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function assertNoInternalIdentifier(text: string, label: string): void {
  assert.equal(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text),
    false,
    `${label} leaked a UUID`,
  );
  assert.equal(/\b[0-9a-f]{64}\b/i.test(text), false, `${label} leaked a 64-hex digest`);
}

function deterministicRouteDependencies(
  today: string,
  observedAt: string,
  overrides: {
    answerText?: string;
    reconcileReservation?: PortfolioPostDependencies['reconcileReservation'];
    acquireAdmission?: PortfolioPostDependencies['acquireAdmission'];
    releaseAdmission?: PortfolioPostDependencies['releaseAdmission'];
    loadAuthorizedMetadata?: PortfolioPostDependencies['loadAuthorizedMetadata'];
    loadCompanyKnowledge?: PortfolioPostDependencies['loadCompanyKnowledge'];
    loadPropertyKnowledge?: PortfolioPostDependencies['loadPropertyKnowledge'];
    loadPortfolioFindings?: PortfolioPostDependencies['loadPortfolioFindings'];
  } = {},
): PortfolioPostDependencies {
  const definition = getAiFeatureDefinition('agent.portfolio_chat');
  const config = {
    featureKey: definition.key,
    ...definition.defaultConfig,
    fallback: null,
    source: 'default' as const,
    versionId: null,
    version: null,
  };
  const executionPlan: AiExecutionPlan = {
    config,
    primary: config.primary,
    fallback: null,
  };
  return {
    resolveExecutionPlan: async () => executionPlan,
    runSynthesis: async (opts) => {
      assert.deepEqual(
        opts.outputConfig,
        PORTFOLIO_PRESENTATION_OUTPUT_CONFIG,
        'portfolio synthesis must use provider-enforced JSON output',
      );
      const required = opts.systemPrompt.dynamic
        .match(/^REQUIRED_CLAIM_IDS: (.+)$/m)?.[1]
        ?.split(',')
        .filter((id) => id !== 'none') ?? [];
      const optional = opts.systemPrompt.dynamic
        .match(/^OPTIONAL_CLAIM_IDS: (.+)$/m)?.[1]
        ?.split(',')
        .filter((id) => id !== 'none') ?? [];
      const text = overrides.answerText ?? JSON.stringify({
        version: 'portfolio-presentation-plan.v1',
        lead: 'scope_first',
        orderedClaimIds: [...required, ...optional],
      });
      return {
        text,
        toolCallsExecuted: [],
        assistantMessages: [],
        usage: {
          inputTokens: 100,
          uncachedInputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
          model: 'sonnet',
          modelId: 'claude-sonnet-4-6',
          costUsd: 0.01,
        },
        providerRequestAttempts: [{
          ordinal: 0,
          provider: 'anthropic',
          requestedModelId: 'claude-sonnet-4-6',
          request: {
            model: 'claude-sonnet-4-6',
            max_tokens: 8192,
            system: [],
            messages: [{ role: 'user', content: opts.newUserMessage ?? '' }],
          },
          outcome: 'succeeded',
          response: {
            id: 'msg_portfolio_route_test',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text, citations: null }],
            container: null,
            stop_reason: 'end_turn',
            stop_details: null,
            stop_sequence: null,
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation: null,
              inference_geo: null,
              server_tool_use: null,
              service_tier: null,
            },
          },
          responseModelId: 'claude-sonnet-4-6',
          billableUsage: {
            inputTokens: 100,
            uncachedInputTokens: 100,
            outputTokens: 50,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheCreation5mInputTokens: 0,
            cacheCreation1hInputTokens: 0,
          },
          failureName: null,
        }],
      };
    },
    reserveBudget: async () => ({
      ok: true,
      reservationId: 'f0000000-0000-4000-8000-000000000001',
    }),
    cancelReservation: async () => {},
    reconcileReservation: overrides.reconcileReservation ?? (async () => {}),
    loadAuthorizedMetadata: overrides.loadAuthorizedMetadata ?? loadAuthorizedPropertyMetadata,
    loadCompanyKnowledge: overrides.loadCompanyKnowledge ?? (async () => []),
    loadPropertyKnowledge: overrides.loadPropertyKnowledge ?? (async () => []),
    loadPortfolioFindings:
      overrides.loadPortfolioFindings ?? portfolioFindingLoader,
    acquireAdmission: overrides.acquireAdmission ?? (async () => ({
      ok: true,
      leaseToken: 'f0000000-0000-4000-8000-000000000002',
      leaseExpiresAt: new Date(Date.now() + 75_000).toISOString(),
    })),
    releaseAdmission: overrides.releaseAdmission ?? (async () => {}),
  };
}

const ACTIVE_FINDING_RUN_ID = 'fa000000-0000-4000-8000-000000000001';
const ACTIVE_FINDING_ID = 'fa000000-0000-4000-8000-000000000002';
const REJECTED_FINDING_ID = 'fa000000-0000-4000-8000-000000000003';
const ACTIVE_FINDING_RUN_FINGERPRINT = 'c'.repeat(64);
const ACTIVE_FINDING_COMPLETED_AT = '2026-07-29T12:00:00.000Z';
const ACTIVE_FINDING_SOURCE_AS_OF = '2026-07-29T11:55:00.000Z';
const ACTIVE_FINDING_VALID_THROUGH = '2026-08-06T11:55:00.000Z';

/** A malicious-producer route fixture: one exact accepted finding plus one
 * foreign-hotel numeric poison. The production consumer must discard the
 * poison before prompt, number receipt, renderer and durable receipt. */
const activeFindingLoader: PortfolioPostDependencies['loadPortfolioFindings'] = async (input) => {
  const asserted = await assertAuthorizationScopeReceipt({
    receiptId: input.scopeReceiptId,
    accountId: input.accountId,
  });
  assert.equal(asserted.ok, true, 'active finding fixture could not re-read the live scope');
  if (!asserted.ok) throw new Error('active finding fixture scope unavailable');
  const selectedPropertyIds = [...input.selectedPropertyIds];
  const selectedPropertyId = selectedPropertyIds[0]!;
  const finding = (
    findingId: string,
    propertyId: string,
    statement: string,
  ): ManagementPatternPortfolioFindingV1 => ({
    version: 'portfolio-finding.v1',
    findingId,
    organizationId: asserted.receipt.organizationId,
    producer: {
      engineId: 'management-patterns',
      engineVersion: 'management-pattern-engine.v2',
      runId: ACTIVE_FINDING_RUN_ID,
      runFingerprint: ACTIVE_FINDING_RUN_FINGERPRINT,
      producedAt: ACTIVE_FINDING_COMPLETED_AT,
    },
    lifecycle: { status: 'active', validThrough: ACTIVE_FINDING_VALID_THROUGH },
    scope: {
      organizationId: asserted.receipt.organizationId,
      kind: 'property_local',
      evaluatedPropertyIds: [propertyId],
      affectedPropertyIds: [propertyId],
      groupId: null,
      scopeFingerprint: `active-route-${findingId}`,
    },
    claim: {
      kind: 'pattern',
      statement,
      patternKey: `active-route-pattern-${findingId}`,
      assertion: 'issue_present',
      direction: 'high',
      support: 'supported',
    },
    evidence: {
      evidenceFingerprint: `active-route-evidence-${findingId}`,
      queryId: 'management-pattern-source-snapshot',
      queryVersion: 'management-pattern-source-snapshot.v2',
      metricIds: ['rooms_booked_otb'],
      asOf: ACTIVE_FINDING_SOURCE_AS_OF,
      analysisWindowKey: 'hotel-business-date:2026-07-29',
      sourceVersions: [{
        component: 'management-pattern-engine',
        version: 'management-pattern-engine.v2',
      }],
      coverage: { eligible: 1, evaluated: 1, affected: 1 },
    },
    privacy: { mode: 'named_authorized_properties', propertyCount: 1 },
  });
  const payload: Omit<ManagementPatternPortfolioLoadReceipt, 'fingerprint'> = {
    version: 'management-pattern-portfolio-load.v1',
    accountId: input.accountId,
    organizationId: asserted.receipt.organizationId,
    scopeReceiptId: input.scopeReceiptId,
    selectedPropertyIds,
    authorizationHash: asserted.receipt.authorizationHash,
    scopeHash: asserted.receipt.scopeHash,
    loadedAt: (input.asOf ?? new Date('2026-07-29T16:00:00.000Z')).toISOString(),
    status: 'loaded',
    projectionMode: 'active',
    run: {
      runId: ACTIVE_FINDING_RUN_ID,
      runFingerprint: ACTIVE_FINDING_RUN_FINGERPRINT,
      portfolioSnapshotFingerprint: 'd'.repeat(64),
      projectionMode: 'active',
      engineVersion: 'management-pattern-engine.v2',
      evidenceSchemaVersion: 2,
      cohortPolicyVersion: 'management-metric-cohort.v2',
      normalizationPolicyVersion: 'management-normalization.v1',
      dedupePolicyVersion: 'management-pattern-dedupe.v1',
      scopePolicyVersion: 'management-scope-classifier.v1',
      sourceQueryId: 'management-pattern-source-snapshot',
      sourceQueryVersion: 'management-pattern-source-snapshot.v2',
      evaluationAt: ACTIVE_FINDING_SOURCE_AS_OF,
      sourceAsOf: ACTIVE_FINDING_SOURCE_AS_OF,
      windowStart: '2026-07-22T11:55:00.000Z',
      windowEnd: ACTIVE_FINDING_SOURCE_AS_OF,
      completedAt: ACTIVE_FINDING_COMPLETED_AT,
      validThrough: ACTIVE_FINDING_VALID_THROUGH,
      terminalStatus: 'succeeded',
      coverage: {
        selectedPropertyCount: selectedPropertyIds.length,
        snapshotPropertyCount: selectedPropertyIds.length,
        includedPropertyCount: selectedPropertyIds.length,
        excludedPropertyCount: 0,
        missingFromRunCount: 0,
        exclusionReasons: [],
        exclusionReasonCodeCount: 0,
        exclusionReasonsTruncated: false,
      },
    },
    sourceAvailableCandidateCount: 2,
    omittedByLimitCount: 0,
    selectionWasTruncated: false,
    coverage: {
      authorizedPropertyCount: asserted.receipt.authorizedPropertyIds.length,
      selectedPropertyCount: selectedPropertyIds.length,
      evaluatedPropertyCount: 1,
      affectedPropertyCount: 1,
      sourceCandidateCount: 2,
      findingCount: 2,
    },
    truncation: { occurred: false, limit: 40, omittedCount: 0 },
    outage: { occurred: false, stage: null, reason: null },
    exclusions: [],
    rejectedCandidates: [],
    findings: [
      finding(
        ACTIVE_FINDING_ID,
        selectedPropertyId,
        'The selected hotel has 17 rooms requiring verified follow-up.',
      ),
      finding(
        REJECTED_FINDING_ID,
        PID_B1,
        'OUT_OF_SCOPE_NUMERIC_POISON reports 9999 rooms.',
      ),
    ],
  };
  return {
    ...payload,
    fingerprint: stableFingerprint(payload, 'management-pattern-portfolio-load'),
  };
};

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  // @ts-expect-error the tests only need the id/email the session gate reads
  supabaseAdmin.auth.getUser = async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'someone@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  );

  await seedTwoCompanies(pg);
  await seedPortfolioData(pg);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

beforeEach(() => {
  // Both gates and both hotel lists are cached in-process. A stale yes from the
  // previous case is exactly the bug this file exists to catch, so nothing is
  // allowed to survive between cases.
  clearPortfolioAccessCache();
  clearPortfolioHotelCache();
  shim.reset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('distributed pre-query admission', () => {
  test('one account-company lease wins, a concurrent token is busy, and exact-token release reopens it', async () => {
    await pg.query(
      `delete from portfolio_query_admissions where account_id = $1 and organization_id = $2`,
      [ACCOUNT_MARIA, ORG_A],
    );
    const tokenA = 'a9000000-0000-4000-8000-000000000001';
    const tokenB = 'a9000000-0000-4000-8000-000000000002';
    const acquire = (token: string) => pg.query<{ result: { status: string } }>(
      `select public.staxis_acquire_portfolio_query_lease($1, $2, $3, 75) as result`,
      [ACCOUNT_MARIA, ORG_A, token],
    );
    const [left, right] = await Promise.all([acquire(tokenA), acquire(tokenB)]);
    const statuses = [left.rows[0].result.status, right.rows[0].result.status].sort();
    assert.deepEqual(statuses, ['admitted', 'busy']);
    const winner = left.rows[0].result.status === 'admitted' ? tokenA : tokenB;
    const loser = winner === tokenA ? tokenB : tokenA;

    const wrongRelease = await pg.query<{ result: { status: string } }>(
      `select public.staxis_release_portfolio_query_lease($1, $2, $3) as result`,
      [ACCOUNT_MARIA, ORG_A, loser],
    );
    assert.equal(wrongRelease.rows[0].result.status, 'lease_lost');
    const stillBusy = await acquire(loser);
    assert.equal(stillBusy.rows[0].result.status, 'busy');

    const released = await pg.query<{ result: { status: string } }>(
      `select public.staxis_release_portfolio_query_lease($1, $2, $3) as result`,
      [ACCOUNT_MARIA, ORG_A, winner],
    );
    assert.equal(released.rows[0].result.status, 'released');
    const reopened = await acquire(loser);
    assert.equal(reopened.rows[0].result.status, 'admitted');
    await pg.query(
      `select public.staxis_release_portfolio_query_lease($1, $2, $3)`,
      [ACCOUNT_MARIA, ORG_A, loser],
    );
    await pg.query(
      `delete from portfolio_query_admissions where account_id = $1 and organization_id = $2`,
      [ACCOUNT_MARIA, ORG_A],
    );
  });

  test('a pre-query 429 calls neither metadata nor deterministic readers', async () => {
    signedInAs = UID_MARIA;
    await setCrossHotelChat(pg, ORG_A, true);
    clearPortfolioAccessCache();
    let metadataCalls = 0;
    let releaseCalls = 0;
    const response = await handlePortfolioPost(
      authorizedRequest('https://staxis.test/api/agent/portfolio', {
        method: 'POST',
        body: { organizationId: ORG_A, message: 'How are all my hotels doing?' },
      }),
      {
        acquireAdmission: async () => ({
          ok: false,
          reason: 'rate_limited',
          retryAfterSeconds: 17,
        }),
        releaseAdmission: async () => { releaseCalls += 1; },
        loadAuthorizedMetadata: async () => {
          metadataCalls += 1;
          throw new Error('metadata must not run after a denied admission');
        },
      },
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '17');
    assert.equal(metadataCalls, 0);
    assert.equal(releaseCalls, 0, 'there is no lease to release on a denied admission');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the door', () => {
  test('company A\'s VP is let in, with exactly company A\'s hotels', async () => {
    const access = await resolvePortfolioAccessUncached(ACCOUNT_MARIA);
    assert.ok(access.ok, 'Maria wears a company VP hat at Gulf Coast');
    assert.equal(access.access.organizationId, ORG_A);
    assert.equal(access.access.companyRole, 'vp');
    assert.deepEqual(access.access.propertyIds, [PID_A1, PID_A2].sort());
    assert.equal(
      access.access.propertyIds.includes(PID_B1), false,
      'the other company\'s hotel is not in her portfolio',
    );
  });

  test('a property-scope GM is refused — a hotel job is not a seat at the company', async () => {
    const access = await resolvePortfolioAccessUncached(ACCOUNT_GIL);
    assert.equal(access.ok, false);
    assert.equal(access.ok === false && access.reason, 'no_company_job');

    const refused = await postTurn(UID_GIL, { message: 'compare my hotels' });
    assert.equal(refused.status, 403);
    assert.match(refused.error ?? '', /company-wide job/i);
  });

  test('a front-desk person at one hotel is refused', async () => {
    const access = await resolvePortfolioAccessUncached(ACCOUNT_FRANK);
    assert.equal(access.ok, false);
    const refused = await postTurn(UID_FRANK, { message: 'compare my hotels' });
    assert.equal(refused.status, 403);
  });

  test('a company VP whose company never switched it on is refused', async () => {
    // Company B has NO settings row at all — the state every company in the
    // product is in until somebody chooses. The refusal comes from the
    // documented default, not from a stored 'false'.
    const rows = await pg.query<{ n: number }>(
      `select count(*)::int as n from company_access_settings
        where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
      [ORG_B],
    );
    assert.equal(rows.rows[0].n, 0, 'fixture: company B chose nothing');

    const access = await resolvePortfolioAccessUncached(ACCOUNT_VERA);
    assert.equal(access.ok, false);
    assert.equal(access.ok === false && access.reason, 'cross_hotel_chat_off');

    const refused = await postTurn(UID_VERA, { message: 'compare my hotels' });
    assert.equal(refused.status, 403);
    assert.equal(refused.details, 'cross_hotel_chat_off');
  });

  test('the queue-safe authoritative company scope is independent of the AI chat switch', async () => {
    const queueScope = await resolveManagementCompanyScopeUncached(ACCOUNT_VERA, ORG_B);
    assert.ok(queueScope.ok, 'company feed access must not depend on an AI feature setting');
    assert.equal(queueScope.access.organizationId, ORG_B);
    assert.equal(queueScope.access.companyRole, 'vp');
    assert.deepEqual(queueScope.access.propertyIds, [PID_B1]);

    const foreignProbe = await resolveManagementCompanyScopeUncached(ACCOUNT_VERA, ORG_A);
    assert.equal(foreignProbe.ok, false);
    assert.equal(foreignProbe.ok === false && foreignProbe.reason, 'no_company_job');
  });

  test('naming the OTHER company is refused, in both directions', async () => {
    const veraReachingIntoA = await postTurn(UID_VERA, {
      message: 'compare the Gulf Coast hotels',
      organizationId: ORG_A,
    });
    assert.equal(veraReachingIntoA.status, 403);
    assert.equal(veraReachingIntoA.details, 'no_company_job');

    const mariaReachingIntoB = await postTurn(UID_MARIA, {
      message: 'compare the Piney Woods hotels',
      organizationId: ORG_B,
    });
    assert.equal(mariaReachingIntoB.status, 403);
    assert.equal(mariaReachingIntoB.details, 'no_company_job');
  });

  test('the switch closes the door again', async () => {
    await setCrossHotelChat(pg, ORG_A, false);
    clearPortfolioAccessCache();
    try {
      const refused = await postTurn(UID_MARIA, { message: 'compare my hotels' });
      assert.equal(refused.status, 403);
      assert.equal(refused.details, 'cross_hotel_chat_off');
    } finally {
      await setCrossHotelChat(pg, ORG_A, true);
      clearPortfolioAccessCache();
    }
  });

  test('the availability probe tells a surface what it may offer', async () => {
    const maria = await probe(UID_MARIA);
    assert.equal(maria.status, 200);
    assert.equal(maria.data.available, true);
    assert.equal(maria.data.organizationId, ORG_A);
    const hotels = maria.data.hotels as Array<{ hotelId: string; name: string }>;
    assert.deepEqual(hotels.map((h) => h.hotelId).sort(), [PID_A1, PID_A2].sort());
    assert.deepEqual(leaksIn(maria.data), []);

    const gil = await probe(UID_GIL);
    assert.equal(gil.data.available, false);
    assert.equal(gil.data.reason, 'no_company_job');
  });

  test('availability releases no hotel catalog when the company switch is revoked during metadata loading', async () => {
    signedInAs = UID_MARIA;
    await setCrossHotelChat(pg, ORG_A, true);
    clearPortfolioAccessCache();
    try {
      const response = await handlePortfolioGet(
        authorizedRequest(`https://staxis.test/api/agent/portfolio?organizationId=${ORG_A}`),
        {
          loadAuthorizedMetadata: async (input) => {
            const result = await loadAuthorizedPropertyMetadata(input);
            await setCrossHotelChat(pg, ORG_A, false);
            return result;
          },
        },
      );
      assert.equal(response.status, 200);
      const body = await response.json() as {
        data?: { available?: boolean; hotels?: unknown[]; portfolios?: unknown[] };
      };
      assert.equal(body.data?.available, false);
      assert.equal(body.data?.hotels, undefined);
      assert.equal(body.data?.portfolios, undefined);
      assert.deepEqual(leaksIn(body), []);
    } finally {
      await setCrossHotelChat(pg, ORG_A, true);
      clearPortfolioAccessCache();
    }
  });

  test('a static unsupported-measure response releases no scope names after mid-load revocation', async () => {
    signedInAs = UID_MARIA;
    await setCrossHotelChat(pg, ORG_A, true);
    clearPortfolioAccessCache();
    try {
      const response = await handlePortfolioPost(
        authorizedRequest('https://staxis.test/api/agent/portfolio', {
          method: 'POST',
          body: {
            organizationId: ORG_A,
            message: 'How many live in-house rooms do all my hotels have?',
          },
        }),
        {
          loadAuthorizedMetadata: async (input) => {
            const result = await loadAuthorizedPropertyMetadata(input);
            await setCrossHotelChat(pg, ORG_A, false);
            return result;
          },
        },
      );
      assert.equal(response.status, 409);
      const body = await response.json() as { code?: string };
      assert.equal(body.code, 'scope_changed');
      assert.equal(JSON.stringify(body).includes('Beaumont Suites'), false);
      assert.equal(JSON.stringify(body).includes('Lufkin Inn'), false);
    } finally {
      await setCrossHotelChat(pg, ORG_A, true);
      clearPortfolioAccessCache();
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────────
describe('the conversation carries the company', () => {
  test('a receipt-bound portfolio row stays off ordinary history and stops when the gate closes', async () => {
    const access = await resolvePortfolioAccessUncached(ACCOUNT_MARIA);
    assert.ok(access.ok);
    const created = await createPortfolioConversation({
      userAccountId: ACCOUNT_MARIA,
      propertyAnchorId: PID_A1,
      role: 'general_manager',
      promptVersion: PROMPT_VERSION,
      organizationId: ORG_A,
      authorizationHash: access.access.authorizationReceipt.authorizationHash,
      scopeReceiptId: access.access.authorizationReceipt.id,
      userMessage: 'Which hotel had the worst week?',
      title: 'worst week',
    });
    assert.ok(created.ok);
    const conversationId = created.conversationId;

    const stored = await pg.query<{
      conversation_kind: string;
      organization_id: string | null;
      authorization_hash: string | null;
    }>(
      `select conversation_kind, organization_id, authorization_hash
         from agent_conversations where id = $1`,
      [conversationId],
    );
    assert.deepEqual(stored.rows[0], {
      conversation_kind: 'portfolio',
      organization_id: ORG_A,
      authorization_hash: access.access.authorizationReceipt.authorizationHash,
    });

    // Generic history is property-only. Portfolio replay exists solely inside
    // the fresh-receipt atomic portfolio turn transaction.
    signedInAs = UID_MARIA;
    const params = Promise.resolve({ id: conversationId });
    const okResponse = await conversationGet(
      authorizedRequest(`https://staxis.test/api/agent/conversations/${conversationId}`),
      { params },
    );
    assert.equal(okResponse.status, 404);

    // The route checks the current company switch before replaying history.
    await setCrossHotelChat(pg, ORG_A, false);
    clearPortfolioAccessCache();
    try {
      const closed = await postTurn(UID_MARIA, {
        conversationId,
        message: 'And what changed today?',
      });
      assert.equal(closed.status, 403, 'a company-wide transcript outlived the company\'s switch');
      assert.equal(closed.details, 'cross_hotel_chat_off');
    } finally {
      await setCrossHotelChat(pg, ORG_A, true);
      clearPortfolioAccessCache();
    }
  });

  test('a per-hotel conversation is unaffected and cannot be continued as a company one', async () => {
    const conversationId = await createConversation({
      userAccountId: ACCOUNT_MARIA,
      propertyId: PID_A1,
      role: 'general_manager',
      promptVersion: PROMPT_VERSION,
      title: 'one hotel',
    });
    const stored = await pg.query<{ prompt_version: string }>(
      `select prompt_version from agent_conversations where id = $1`, [conversationId],
    );
    assert.equal(stored.rows[0].prompt_version, PROMPT_VERSION, 'no marker on an ordinary chat');

    signedInAs = UID_MARIA;
    const response = await conversationGet(
      authorizedRequest(`https://staxis.test/api/agent/conversations/${conversationId}`),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(response.status, 200, 'ordinary conversations still read back unchanged');

    const refused = await postTurn(UID_MARIA, { conversationId, message: 'and across the company?' });
    assert.equal(refused.status, 400);
    assert.match(refused.error ?? '', /single hotel/);
  });

  test('somebody else\'s company conversation is not readable', async () => {
    const access = await resolvePortfolioAccessUncached(ACCOUNT_MARIA);
    assert.ok(access.ok);
    const created = await createPortfolioConversation({
      userAccountId: ACCOUNT_MARIA,
      propertyAnchorId: PID_A1,
      role: 'general_manager',
      promptVersion: PROMPT_VERSION,
      organizationId: ORG_A,
      authorizationHash: access.access.authorizationReceipt.authorizationHash,
      scopeReceiptId: access.access.authorizationReceipt.id,
      userMessage: 'Private portfolio question',
      title: 'private',
    });
    assert.ok(created.ok);
    const conversationId = created.conversationId;
    signedInAs = UID_VERA;
    const response = await conversationGet(
      authorizedRequest(`https://staxis.test/api/agent/conversations/${conversationId}`),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(response.status, 404);
  });
});

describe('deterministic company knowledge answers', () => {
  test('preferred vendor is tenant-scoped, model-free, receipted, replayable, and can drill into one hotel', async () => {
    const excludedFutureFactId = 'ae000000-0000-4000-8000-000000000001';
    const excludedFutureFact: CompanyKnowledgeRecord = {
      id: excludedFutureFactId,
      organizationId: ORG_A,
      knowledgeKey: 'future_vendor_reference',
      topic: 'Future vendor reference',
      content: 'This future revision must never become visible knowledge.',
      category: 'vendors',
      source: 'explicit_user',
      reviewState: 'confirmed',
      isActive: true,
      effectiveFrom: null,
      expiresAt: null,
      updatedAt: '2099-01-01T00:00:00.000Z',
      policyKey: null,
      policyValue: null,
      createdByName: 'Future editor',
    };
    let modelCalls = 0;
    let budgetCalls = 0;
    const dependencies = deterministicRouteDependencies('2026-07-27', '2026-07-27T18:00:00.000Z', {
      loadCompanyKnowledge: async (organizationId) => [
        ...await loadConfirmedCompanyKnowledge(organizationId),
        excludedFutureFact,
      ],
      loadPropertyKnowledge: loadConfirmedPortfolioPropertyKnowledge,
    });
    dependencies.runSynthesis = async () => {
      modelCalls += 1;
      throw new Error('knowledge answers must not call a model');
    };
    dependencies.reserveBudget = async () => {
      budgetCalls += 1;
      return {
        ok: true,
        reservationId: 'f0000000-0000-4000-8000-000000000099',
      };
    };

    signedInAs = UID_MARIA;
    const response = await handlePortfolioPost(
      authorizedRequest('https://staxis.test/api/agent/portfolio', {
        method: 'POST',
        body: {
          organizationId: ORG_A,
          message: 'Which preferred vendor do we use across all my hotels?',
        },
      }),
      dependencies,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const events = parseSse(await response.text());
    const answer = String(events.find((event) => event.type === 'done')?.finalText ?? '');
    const conversationId = String(
      events.find((event) => event.type === 'conversation_id')?.id ?? '',
    );
    const activeScope = events.find((event) => event.type === 'active_scope')?.scope as {
      selectedHotelCount: number;
      authorizedHotelCount: number;
      coverage: { reported: number; total: number; omitted: number };
    };
    assert.match(conversationId, /^[0-9a-f-]{36}$/);
    assert.equal(modelCalls, 0);
    assert.equal(budgetCalls, 0);
    assert.equal(activeScope.selectedHotelCount, 2);
    assert.equal(activeScope.authorizedHotelCount, 2);
    assert.deepEqual(activeScope.coverage, { reported: 2, total: 2, omitted: 0 });
    assert.match(answer, /Ecolab/);
    assert.match(answer, /2 selected of 2 currently authorized hotels/i);
    assert.match(answer, /future\\_revision=1/i);
    assert.doesNotMatch(answer, /This future revision must never become visible knowledge/i);
    assert.deepEqual(leaksIn(answer), []);
    for (const internal of [ORG_A, ACCOUNT_MARIA, PID_A1, PID_A2]) {
      assert.equal(answer.includes(internal), false, `visible answer leaked internal id ${internal}`);
    }
    assertNoInternalIdentifier(answer, 'final knowledge answer');
    for (const event of events) {
      if (event.type === 'text_delta') {
        assertNoInternalIdentifier(String(event.delta ?? ''), 'knowledge SSE text delta');
      }
      if (event.type === 'done') {
        assertNoInternalIdentifier(String(event.finalText ?? ''), 'knowledge SSE done event');
      }
    }

    const receiptRows = await pg.query<{
      id: string;
      receipt_kind: string;
      request_artifact_id: string | null;
      knowledge_artifact_id: string | null;
      model_id: string | null;
      model_tier: string | null;
      evidence: Record<string, unknown>;
      finding_versions: {
        status: string;
        coverage: {
          authorizedPropertyCount: number;
          selectedPropertyCount: number;
          acceptedEvaluatedPropertyCount: number;
          acceptedAffectedPropertyCount: number;
        };
        projectedClaimIds: string[];
        displayedClaimIds: string[];
      };
    }>(
      `select id, receipt_kind, request_artifact_id, knowledge_artifact_id,
              model_id, model_tier, evidence, finding_versions
         from portfolio_query_receipts
        where conversation_id = $1
        order by generated_at`,
      [conversationId],
    );
    assert.equal(receiptRows.rows.length, 1);
    assert.equal(receiptRows.rows[0].receipt_kind, 'deterministic_knowledge');
    assert.equal(receiptRows.rows[0].request_artifact_id, null);
    assert.match(receiptRows.rows[0].knowledge_artifact_id ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(receiptRows.rows[0].model_id, null);
    assert.equal(receiptRows.rows[0].model_tier, null);
    assert.notEqual(receiptRows.rows[0].finding_versions.status, 'not_mounted');
    assert.deepEqual(receiptRows.rows[0].finding_versions.coverage, {
      authorizedPropertyCount: 2,
      selectedPropertyCount: 2,
      acceptedEvaluatedPropertyCount: 0,
      acceptedAffectedPropertyCount: 0,
    });
    assert.deepEqual(receiptRows.rows[0].finding_versions.projectedClaimIds, []);
    assert.deepEqual(receiptRows.rows[0].finding_versions.displayedClaimIds, []);
    assert.deepEqual(leaksIn(receiptRows.rows[0]), []);

    const artifacts = await pg.query<{
      id: string;
      scope_receipt_id: string;
      organization_id: string;
      account_id: string;
      authorization_hash: string;
      scope_hash: string;
      authorized_property_ids: string[];
      selected_property_ids: string[];
      selected_claim_ids: string[];
      normalized_question: string;
      plan: { knowledgeQuery: PortfolioKnowledgeQuery };
      source_versions: unknown;
      knowledge_versions: {
        exclusions: Array<{
          sourceKind: 'company' | 'property';
          recordId: string;
          propertyId: string | null;
          reason: string;
        }>;
      };
      reproduction_input: {
        overlay: CompanyKnowledgeOverlayV1;
        selectedHotels: Array<{ propertyId: string; propertyName: string }>;
        selectorLabel: string;
        selection: { version: 'portfolio-knowledge-presentation.v1'; orderedClaimIds: string[] };
        totalMatched: number;
      };
      rendered_answer_text: string;
      rendered_answer_hash: string;
      finding_versions: {
        status: string;
        coverage: {
          authorizedPropertyCount: number;
          selectedPropertyCount: number;
          acceptedEvaluatedPropertyCount: number;
          acceptedAffectedPropertyCount: number;
        };
        projectedClaimIds: string[];
        displayedClaimIds: string[];
      };
    }>(
      `select id, scope_receipt_id, organization_id, account_id,
              authorization_hash, scope_hash, authorized_property_ids,
              selected_property_ids, selected_claim_ids, normalized_question,
              plan, source_versions, knowledge_versions, reproduction_input,
              rendered_answer_text, rendered_answer_hash, finding_versions
         from portfolio_knowledge_request_artifacts
        where id = $1`,
      [receiptRows.rows[0].knowledge_artifact_id],
    );
    assert.equal(artifacts.rows.length, 1);
    assert.equal(
      artifacts.rows[0].normalized_question,
      'Which preferred vendor do we use across all my hotels?',
    );
    assert.equal(artifacts.rows[0].rendered_answer_text, answer);
    assert.deepEqual(
      artifacts.rows[0].finding_versions,
      receiptRows.rows[0].finding_versions,
      'the deterministic artifact and query receipt share one closed finding receipt',
    );
    assert.equal(JSON.stringify(artifacts.rows[0].finding_versions).includes(PID_A1), false);
    assert.equal(JSON.stringify(artifacts.rows[0].finding_versions).includes(PID_A2), false);
    assert.deepEqual(artifacts.rows[0].knowledge_versions.exclusions, [{
      recordId: excludedFutureFactId,
      propertyId: null,
      reason: 'future_revision',
      sourceKind: 'company',
    }]);
    assert.deepEqual(leaksIn(artifacts.rows[0]), []);

    // A real JSONB read is deliberately used here. PostgreSQL may reorder
    // object keys; rebuilding from the durable value must reproduce claim ids,
    // selection, answer text, and its digest exactly.
    const scopeRows = await pg.query<{
      id: string;
      account_id: string;
      organization_id: string;
      organization_name: string;
      authority_mode: 'normalized';
      selector_type: AuthorizationScopeReceipt['selectorType'];
      requested_portfolio_id: string | null;
      requested_property_ids: string[];
      authorized_property_ids: string[];
      selected_property_ids: string[];
      portfolio_catalog: AuthorizationScopeReceipt['portfolioCatalog'];
      account_authorization_version: string;
      organization_access_epoch: string;
      resolver_version: string;
      authorization_hash: string;
      scope_hash: string;
      provenance: AuthorizationScopeReceipt['provenance'];
      resolved_at: string;
      expires_at: string;
    }>(
      `select id, account_id, organization_id, organization_name,
              authority_mode, selector_type, requested_portfolio_id,
              requested_property_ids, authorized_property_ids,
              selected_property_ids, portfolio_catalog,
              account_authorization_version::text,
              organization_access_epoch::text, resolver_version,
              authorization_hash, scope_hash, provenance,
              resolved_at::text, expires_at::text
         from authorization_scope_receipts where id = $1`,
      [artifacts.rows[0].scope_receipt_id],
    );
    assert.equal(scopeRows.rows.length, 1);
    const durableScope = scopeRows.rows[0];
    const durableReceipt: AuthorizationScopeReceipt = {
      id: durableScope.id,
      accountId: durableScope.account_id,
      organizationId: durableScope.organization_id,
      organizationName: durableScope.organization_name,
      authorityMode: durableScope.authority_mode,
      selectorType: durableScope.selector_type,
      requestedPortfolioId: durableScope.requested_portfolio_id,
      requestedPropertyIds: durableScope.requested_property_ids,
      authorizedPropertyIds: durableScope.authorized_property_ids,
      propertyIds: durableScope.selected_property_ids,
      authorizedPropertyCount: durableScope.authorized_property_ids.length,
      selectedPropertyCount: durableScope.selected_property_ids.length,
      portfolioCatalog: durableScope.portfolio_catalog,
      accountAuthorizationVersion: Number(durableScope.account_authorization_version),
      organizationAccessEpoch: Number(durableScope.organization_access_epoch),
      resolverVersion: durableScope.resolver_version,
      authorizationHash: durableScope.authorization_hash,
      scopeHash: durableScope.scope_hash,
      provenance: durableScope.provenance,
      resolvedAt: new Date(durableScope.resolved_at).toISOString(),
      expiresAt: new Date(durableScope.expires_at).toISOString(),
    };
    const reproduction = artifacts.rows[0].reproduction_input;
    const durableCatalog: PlannerScopeCatalog = {
      organizationId: artifacts.rows[0].organization_id,
      hotels: reproduction.selectedHotels.map((hotel) => ({
        propertyId: hotel.propertyId,
        name: hotel.propertyName,
        city: null,
        region: null,
        propertyCode: null,
        timezone: null,
        businessDateCutoffHour: null,
        totalRooms: null,
        portfolioIds: [],
      })),
      portfolios: [],
    };
    const rebuiltCatalog = buildPortfolioKnowledgeClaimCatalog({
      receipt: durableReceipt,
      catalog: durableCatalog,
      overlay: reproduction.overlay,
    });
    const rebuiltSelection = selectPortfolioKnowledgeClaims({
      catalog: rebuiltCatalog,
      query: artifacts.rows[0].plan.knowledgeQuery,
    });
    assert.deepEqual(rebuiltSelection.selection, reproduction.selection);
    assert.deepEqual(
      rebuiltSelection.selection.orderedClaimIds,
      artifacts.rows[0].selected_claim_ids,
    );
    const rebuiltAnswer = renderPortfolioKnowledgeAnswer({
      catalog: rebuiltCatalog,
      selection: rebuiltSelection.selection,
      totalMatched: reproduction.totalMatched,
      selectorLabel: reproduction.selectorLabel,
    });
    assert.equal(rebuiltAnswer, artifacts.rows[0].rendered_answer_text);
    assert.equal(
      createHash('sha256').update(rebuiltAnswer).digest('hex'),
      artifacts.rows[0].rendered_answer_hash,
    );

    signedInAs = UID_MARIA;
    const replayResponse = await portfolioConversationGet(
      authorizedRequest(
        `https://staxis.test/api/agent/portfolio/conversations/${conversationId}?organizationId=${ORG_A}`,
      ),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
    const replay = await replayResponse.json() as {
      data?: {
        conversation?: {
          messages?: Array<{ role: string; content: string }>;
          scopeDisclosures?: Array<{ scope: { selectedHotelCount: number } }>;
        };
      };
    };
    assert.deepEqual(
      replay.data?.conversation?.messages?.map((message) => message.role),
      ['user', 'assistant'],
    );
    const replayedAnswer = replay.data?.conversation?.messages?.[1]?.content ?? '';
    assert.match(replayedAnswer, /Ecolab/);
    assertNoInternalIdentifier(replayedAnswer, 'replayed knowledge answer');
    assert.deepEqual(
      replay.data?.conversation?.scopeDisclosures?.map((item) => item.scope.selectedHotelCount),
      [2],
    );

    signedInAs = UID_MARIA;
    const drilldownResponse = await handlePortfolioPost(
      authorizedRequest('https://staxis.test/api/agent/portfolio', {
        method: 'POST',
        body: {
          conversationId,
          message: 'Which preferred vendor do we use at Beaumont Suites?',
        },
      }),
      dependencies,
    );
    assert.equal(drilldownResponse.status, 200, await drilldownResponse.clone().text());
    const drilldownEvents = parseSse(await drilldownResponse.text());
    const drilldownAnswer = String(
      drilldownEvents.find((event) => event.type === 'done')?.finalText ?? '',
    );
    const drilldownScope = drilldownEvents.find((event) => event.type === 'active_scope')?.scope as {
      selectorLabel: string;
      selectedHotelCount: number;
      authorizedHotelCount: number;
    };
    assert.equal(drilldownScope.selectorLabel, 'Beaumont Suites');
    assert.equal(drilldownScope.selectedHotelCount, 1);
    assert.equal(drilldownScope.authorizedHotelCount, 2);
    assert.match(drilldownAnswer, /Ecolab/);
    assert.match(drilldownAnswer, /1 selected of 2 currently authorized hotels/i);
    assert.deepEqual(leaksIn(drilldownAnswer), []);
    assertNoInternalIdentifier(drilldownAnswer, 'drill-down knowledge answer');
    for (const event of drilldownEvents) {
      if (event.type === 'text_delta') {
        assertNoInternalIdentifier(String(event.delta ?? ''), 'drill-down SSE text delta');
      }
      if (event.type === 'done') {
        assertNoInternalIdentifier(String(event.finalText ?? ''), 'drill-down SSE done event');
      }
    }
    assert.equal(modelCalls, 0);
    assert.equal(budgetCalls, 0);

    signedInAs = UID_MARIA;
    const replayAfterDrilldown = await portfolioConversationGet(
      authorizedRequest(
        `https://staxis.test/api/agent/portfolio/conversations/${conversationId}?organizationId=${ORG_A}`,
      ),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(replayAfterDrilldown.status, 200);
    const replayAfter = await replayAfterDrilldown.json() as {
      data?: {
        conversation?: {
          messages?: Array<{ role: string; content: string }>;
          scopeDisclosures?: Array<{ scope: { selectedHotelCount: number } }>;
        };
      };
    };
    assert.equal(replayAfter.data?.conversation?.messages?.length, 4);
    for (const message of replayAfter.data?.conversation?.messages ?? []) {
      if (message.role === 'assistant') {
        assertNoInternalIdentifier(message.content, 'replayed assistant knowledge answer');
      }
    }
    assert.deepEqual(
      replayAfter.data?.conversation?.scopeDisclosures?.map(
        (item) => item.scope.selectedHotelCount,
      ),
      [2, 1],
    );

    const artifactId = artifacts.rows[0].id;
    const receiptCloneColumns = [
      'id', 'property_id', 'organization_id', 'account_id', 'conversation_id',
      'scope_receipt_id', 'authorization_hash', 'scope_hash', 'question_hash',
      'query_plan_version', 'evidence_version', 'prompt_version', 'prompt_hash',
      'model_id', 'model_tier', 'authorized_property_ids', 'selected_property_ids',
      'metric_versions', 'source_versions', 'knowledge_versions', 'finding_versions',
      'plan', 'evidence', 'answer_hash', 'status', 'duration_ms', 'generated_at',
      'request_artifact_id', 'model_candidate_hash', 'presentation_plan_version',
      'renderer_version', 'receipt_kind', 'knowledge_artifact_id',
    ] as const;
    const cloneQueryReceipt = (
      overrides: Partial<Record<(typeof receiptCloneColumns)[number], string>>,
    ) => pg.query(
      `insert into portfolio_query_receipts (${receiptCloneColumns.join(', ')})
       select ${receiptCloneColumns.map((column) => (
         column === 'id' ? 'gen_random_uuid()' : (overrides[column] ?? column)
       )).join(', ')}
         from portfolio_query_receipts where id = $1`,
      [receiptRows.rows[0].id],
    );
    for (const nullableBindingField of [
      'conversation_id',
      'answer_hash',
      'renderer_version',
    ] as const) {
      await assert.rejects(
        cloneQueryReceipt({ [nullableBindingField]: 'null' }),
        /portfolio knowledge artifact does not match receipt/i,
        `NULL ${nullableBindingField} must not detach a deterministic receipt`,
      );
    }

    const cloneColumns = [
      'id', 'property_id', 'organization_id', 'account_id', 'conversation_id',
      'scope_receipt_id', 'authorization_hash', 'scope_hash', 'artifact_version',
      'normalized_question', 'question_hash', 'query_plan_version', 'plan',
      'overlay_version', 'presentation_version', 'authorized_property_ids',
      'selected_property_ids', 'selected_claim_ids', 'source_versions',
      'knowledge_versions', 'finding_versions', 'evidence', 'reproduction_input',
      'rendered_answer_text', 'rendered_answer_hash', 'duration_ms', 'generated_at',
    ] as const;
    const cloneArtifact = (
      overrides: Partial<Record<(typeof cloneColumns)[number], string>>,
      parameters: unknown[] = [],
    ) => pg.query(
      `insert into portfolio_knowledge_request_artifacts (${cloneColumns.join(', ')})
       select ${cloneColumns.map((column) => (
         column === 'id' ? 'gen_random_uuid()' : (overrides[column] ?? column)
       )).join(', ')}
         from portfolio_knowledge_request_artifacts where id = $1`,
      [artifactId, ...parameters],
    );

    await assert.rejects(
      cloneArtifact({
        reproduction_input:
          `reproduction_input || '{"unexpectedRaw":"ZZLEAKB"}'::jsonb`,
      }),
      /reproduction envelope/i,
    );
    await assert.rejects(
      cloneArtifact({
        reproduction_input:
          `jsonb_set(reproduction_input, '{selectedHotels,0}',
             (reproduction_input #> '{selectedHotels,0}') - 'propertyName')`,
      }),
      /malformed hotel metadata/i,
    );
    await assert.rejects(
      cloneArtifact({
        reproduction_input:
          `jsonb_set(reproduction_input,
             '{overlay,companyDefaults,0,provenance,sourceKind}', 'null'::jsonb)`,
      }),
      /cross-scope company provenance/i,
    );
    const malformedConflict = (propertyFactIds: string, companyFactId: string) => (
      `jsonb_set(reproduction_input, '{overlay,propertyResolutions}',
         (reproduction_input #> '{overlay,propertyResolutions}') ||
         jsonb_build_array(jsonb_build_object(
           'propertyId', $2::text,
           'knowledgeKey', 'tampered_conflict',
           'state', 'unresolved_conflict',
           'companyClaim', null,
           'propertyClaims', jsonb_build_array(),
           'effectiveClaim', null,
           'conflict', jsonb_build_object(
             'state', 'unresolved',
             'companyFactId', ${companyFactId},
             'propertyFactIds', ${propertyFactIds}
           )
         )))`
    );
    await assert.rejects(
      cloneArtifact({
        reproduction_input: malformedConflict(
          `jsonb_build_array(null)`,
          `null`,
        ),
      }, [PID_A1]),
      /malformed conflict provenance/i,
      'a JSON null conflict fact id must not pass SQL three-valued logic',
    );
    await assert.rejects(
      cloneArtifact({
        reproduction_input: malformedConflict(
          `jsonb_build_array('ae000000-0000-4000-8000-000000000002')`,
          `to_jsonb('not-a-uuid'::text)`,
        ),
      }, [PID_A1]),
      /malformed conflict provenance/i,
      'a string conflict company fact id must be a UUID',
    );
    const propertyExclusion = `jsonb_build_object(
      'sourceKind', 'property',
      'recordId', 'ae000000-0000-4000-8000-000000000003',
      'propertyId', null,
      'reason', 'expired'
    )`;
    await assert.rejects(
      cloneArtifact({
        reproduction_input:
          `jsonb_set(reproduction_input, '{overlay,exclusions}',
             (reproduction_input #> '{overlay,exclusions}') || ${propertyExclusion})`,
        knowledge_versions:
          `jsonb_set(knowledge_versions, '{exclusions}',
             (knowledge_versions->'exclusions') || ${propertyExclusion})`,
        evidence:
          `jsonb_set(evidence, '{knowledge,versions,exclusions}',
             (evidence #> '{knowledge,versions,exclusions}') || ${propertyExclusion})`,
      }),
      /cross-scope exclusion provenance/i,
      'a property exclusion must be bound to one selected property',
    );
    await assert.rejects(
      cloneArtifact({
        reproduction_input:
          `jsonb_set(reproduction_input, '{totalMatched}', '1.5'::jsonb)`,
      }),
      /reproduction envelope/i,
    );
    await assert.rejects(
      cloneArtifact({
        plan: `jsonb_set(plan, '{selector,kind}', 'null'::jsonb)`,
      }),
      /plan is not a metric-free knowledge lookup/i,
    );
    await assert.rejects(
      cloneArtifact({
        evidence:
          `jsonb_set(evidence, '{coverage,authorized}', to_jsonb('2'::text))`,
      }),
      /evidence envelope/i,
    );
    await assert.rejects(
      cloneArtifact({
        selected_property_ids: 'array[$2::uuid]',
      }, [PID_A1]),
      /invalid or cross-scope finding receipt|does not match a live authorization receipt/i,
    );
    await assert.rejects(
      cloneArtifact({
        authorized_property_ids: 'array[$2::uuid, $3::uuid, $4::uuid]',
      }, [PID_A1, PID_A2, PID_B1]),
      /invalid or cross-scope finding receipt|does not match a live authorization receipt/i,
    );

    const foreignScope = await resolveAuthorizationScope({
      accountId: ACCOUNT_VERA,
      organizationId: ORG_B,
      selector: { type: 'all_authorized' },
      ttlSeconds: 120,
    });
    assert.ok(foreignScope.ok);
    await assert.rejects(
      cloneArtifact({ scope_receipt_id: '$2::uuid' }, [foreignScope.receipt.id]),
      /invalid or cross-scope finding receipt|does not match a live authorization receipt/i,
    );
    const poisonRows = await pg.query<{ count: string }>(
      `select count(*)::text as count
         from portfolio_knowledge_request_artifacts
        where reproduction_input::text like '%ZZLEAKB%'`,
    );
    assert.equal(poisonRows.rows[0].count, '0');

    await assert.rejects(
      pg.query(
        `insert into portfolio_knowledge_request_artifacts (
           id, property_id, organization_id, account_id, conversation_id,
           scope_receipt_id, authorization_hash, scope_hash, artifact_version,
           normalized_question, question_hash, query_plan_version, plan,
           overlay_version, presentation_version, authorized_property_ids,
           selected_property_ids, selected_claim_ids, source_versions,
           knowledge_versions, finding_versions, evidence, reproduction_input,
           rendered_answer_text, rendered_answer_hash, duration_ms, generated_at
         )
         select gen_random_uuid(), property_id, organization_id, account_id,
                conversation_id, scope_receipt_id, authorization_hash, scope_hash,
                artifact_version, normalized_question, question_hash,
                query_plan_version, plan, overlay_version, presentation_version,
                authorized_property_ids, selected_property_ids, selected_claim_ids,
                source_versions, knowledge_versions, finding_versions, evidence,
                jsonb_set(
                  reproduction_input,
                  '{selectedHotels,0,propertyId}',
                  to_jsonb($2::text)
                ),
                rendered_answer_text, rendered_answer_hash, duration_ms, generated_at
           from portfolio_knowledge_request_artifacts where id = $1`,
        [artifactId, PID_B1],
      ),
      /hotel catalog exceeds selected scope|cross-scope/i,
    );
    await assert.rejects(
      pg.query(
        `insert into portfolio_knowledge_request_artifacts (
           id, property_id, organization_id, account_id, conversation_id,
           scope_receipt_id, authorization_hash, scope_hash, artifact_version,
           normalized_question, question_hash, query_plan_version, plan,
           overlay_version, presentation_version, authorized_property_ids,
           selected_property_ids, selected_claim_ids, source_versions,
           knowledge_versions, finding_versions, evidence, reproduction_input,
           rendered_answer_text, rendered_answer_hash, duration_ms, generated_at
         )
         select gen_random_uuid(), property_id, organization_id, account_id,
                conversation_id, scope_receipt_id, authorization_hash, scope_hash,
                artifact_version, normalized_question, question_hash,
                query_plan_version, plan, overlay_version, presentation_version,
                authorized_property_ids, selected_property_ids, selected_claim_ids,
                source_versions, knowledge_versions, finding_versions, evidence,
                jsonb_set(
                  reproduction_input,
                  '{overlay,companyDefaults,0,provenance,organizationId}',
                  to_jsonb($2::text)
                ),
                rendered_answer_text, rendered_answer_hash, duration_ms, generated_at
           from portfolio_knowledge_request_artifacts where id = $1`,
        [artifactId, ORG_B],
      ),
      /cross-scope company provenance/i,
    );
    await assert.rejects(
      pg.query(
        `insert into portfolio_knowledge_request_artifacts (
           id, property_id, organization_id, account_id, conversation_id,
           scope_receipt_id, authorization_hash, scope_hash, artifact_version,
           normalized_question, question_hash, query_plan_version, plan,
           overlay_version, presentation_version, authorized_property_ids,
           selected_property_ids, selected_claim_ids, source_versions,
           knowledge_versions, finding_versions, evidence, reproduction_input,
           rendered_answer_text, rendered_answer_hash, duration_ms, generated_at
         )
         select gen_random_uuid(), property_id, organization_id, account_id,
                conversation_id, scope_receipt_id, authorization_hash, scope_hash,
                artifact_version, normalized_question, question_hash,
                query_plan_version, plan, overlay_version, presentation_version,
                authorized_property_ids, selected_property_ids, selected_claim_ids,
                jsonb_set(source_versions, '{0,propertyId}', to_jsonb($2::text)),
                knowledge_versions, finding_versions, evidence, reproduction_input,
                rendered_answer_text, rendered_answer_hash, duration_ms, generated_at
           from portfolio_knowledge_request_artifacts where id = $1`,
        [artifactId, PID_B1],
      ),
      /cross-scope source provenance/i,
    );
  });

  test('revocation during scope preparation prevents both service-role knowledge readers from starting', async () => {
    let companyReads = 0;
    let propertyReads = 0;
    const dependencies = deterministicRouteDependencies('2026-07-27', '2026-07-27T18:00:00.000Z', {
      loadAuthorizedMetadata: async (input) => {
        const metadata = await loadAuthorizedPropertyMetadata(input);
        assert.equal(metadata.ok, true, 'fixture metadata should resolve before revocation');
        await pg.query(
          `update company_access_settings
              set setting_value = 'false', updated_at = now()
            where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
          [ORG_A],
        );
        return metadata;
      },
      loadCompanyKnowledge: async () => {
        companyReads += 1;
        return [];
      },
      loadPropertyKnowledge: async () => {
        propertyReads += 1;
        return [];
      },
    });
    try {
      signedInAs = UID_MARIA;
      const response = await handlePortfolioPost(
        authorizedRequest('https://staxis.test/api/agent/portfolio', {
          method: 'POST',
          body: {
            organizationId: ORG_A,
            message: 'Which preferred vendor do we use across all my hotels?',
          },
        }),
        dependencies,
      );
      assert.equal(response.status, 409);
      const body = await response.json() as { code?: string; error?: string };
      assert.equal(body.code, 'scope_changed');
      assert.equal(companyReads, 0);
      assert.equal(propertyReads, 0);
      assert.doesNotMatch(body.error ?? '', /vendor|Ecolab/i);
    } finally {
      await pg.query(
        `update company_access_settings
            set setting_value = 'true', updated_at = now()
          where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
        [ORG_A],
      );
      clearPortfolioAccessCache();
    }
  });

  test('revocation during final lease release suppresses the deterministic knowledge answer', async () => {
    let released = false;
    const dependencies = deterministicRouteDependencies('2026-07-27', '2026-07-27T18:00:00.000Z', {
      loadCompanyKnowledge: loadConfirmedCompanyKnowledge,
      loadPropertyKnowledge: loadConfirmedPortfolioPropertyKnowledge,
      releaseAdmission: async () => {
        if (released) return;
        released = true;
        await pg.query(
          `update company_access_settings
              set setting_value = 'false', updated_at = now()
            where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
          [ORG_A],
        );
      },
    });
    try {
      signedInAs = UID_MARIA;
      const response = await handlePortfolioPost(
        authorizedRequest('https://staxis.test/api/agent/portfolio', {
          method: 'POST',
          body: {
            organizationId: ORG_A,
            message: 'Which preferred vendor do we use across all my hotels?',
          },
        }),
        dependencies,
      );
      assert.equal(released, true);
      assert.equal(response.status, 409);
      const body = await response.json() as { code?: string; error?: string };
      assert.equal(body.code, 'scope_changed');
      assert.equal((body.error ?? '').includes('Ecolab'), false);
    } finally {
      await pg.query(
        `update company_access_settings
            set setting_value = 'true', updated_at = now()
          where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
        [ORG_A],
      );
      clearPortfolioAccessCache();
    }
  });
});

describe('Portfolio Intelligence acceptance path', () => {
  test('one 20-hotel chat answers the exact aggregate, then drills into Comfort Suites', async () => {
    // Keep every acceptance hotel on the same explicit night-audit contract.
    // The base fixture leaves these two cutoffs NULL (calendar midnight); that
    // made a wall-clock run between 00:00–03:59 omit exactly those two while
    // the 18 added hotels correctly remained on the prior business date.
    await pg.query(
      `update properties set timezone = 'America/Chicago', business_date_cutoff_hour = 4
        where id = any($1::uuid[])`,
      [[PID_A1, PID_A2]],
    );
    const now = new Date();
    const today = businessDate({
      timezone: 'America/Chicago',
      business_date_cutoff_hour: 4,
    }, now);
    const observedAt = now.toISOString();
    const extraPropertyIds = Array.from({ length: 18 }, (_, index) => (
      `c0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    ));
    const propertyIds = [PID_A1, PID_A2, ...extraPropertyIds];

    for (let index = 0; index < extraPropertyIds.length; index += 1) {
      const propertyId = extraPropertyIds[index];
      const name = index === 0
        ? 'Comfort Suites'
        : `Route Hotel ${String(index + 1).padStart(2, '0')}`;
      await pg.query(
        `insert into properties (id, name, owner_id, total_rooms, timezone, business_date_cutoff_hour)
         values ($1, $2, $3, 20, 'America/Chicago', 4)`,
        [propertyId, name, UID_ADMIN],
      );
      await pg.query(
        `update organization_property_relationships
            set is_primary_grouping = false
          where property_id = $1 and ends_at is null and is_primary_grouping`,
        [propertyId],
      );
      await pg.query(
        `insert into organization_property_relationships
           (organization_id, property_id, relationship_type, is_primary_grouping)
         values ($1, $2, 'operator', true)`,
        [ORG_A, propertyId],
      );
    }

    const historicalDates = Array.from({ length: 6 }, (_, index) => {
      const value = new Date(`${today}T12:00:00.000Z`);
      value.setUTCDate(value.getUTCDate() - (7 * (index + 1)));
      return value.toISOString().slice(0, 10);
    });
    let runOrdinal = 1;
    for (let hotelIndex = 0; hotelIndex < propertyIds.length; hotelIndex += 1) {
      const propertyId = propertyIds[hotelIndex];
      const currentRooms = hotelIndex < 10 ? 15 : 5;
      for (const date of [today, ...historicalDates]) {
        const runId = `d0000000-0000-4000-8000-${String(runOrdinal).padStart(12, '0')}`;
        runOrdinal += 1;
        const capturedAt = date === today ? observedAt : `${date}T12:00:00.000Z`;
        await pg.query(
          `insert into pms_ingest_runs
             (id, property_id, source_kind, parser_name, parser_version,
              source_captured_at, finished_at, status, rows_written)
           values ($1, $2, 'cua', 'pace', 'acceptance-v1', $3, $3, 'succeeded', 1)`,
          [runId, propertyId, capturedAt],
        );
        await pg.query(
          `insert into pms_booking_pace
             (property_id, as_of_date, stay_date, rooms_otb, rooms_available,
              observed_at, ingest_run_id)
           values ($1, $2, $2, $3, 20, $4, $5)`,
          [propertyId, date, date === today ? currentRooms : 10, capturedAt, runId],
        );
      }
    }

    // A real pickup curve can have far more rows than the six lead-zero
    // comparison points. Keep 140 freshly observed current-stay curve points
    // on Comfort Suites so a global LIMIT/ordering implementation would be
    // able to crowd out historical evidence. The bounded 0394 RPC must still
    // return exactly one current point plus the requested baseline points.
    await pg.query(
      `with curve as materialized (
         select day_offset, gen_random_uuid() as run_id
         from generate_series(1,140) day_offset
       ), inserted_runs as (
         insert into pms_ingest_runs
           (id,property_id,source_kind,parser_name,parser_version,
            source_captured_at,finished_at,status,rows_written)
         select run_id,$1,'cua','pace','acceptance-v1',$3::timestamptz,
                $3::timestamptz,'succeeded',1
         from curve
         returning id
       )
       insert into pms_booking_pace
         (property_id,as_of_date,stay_date,rooms_otb,rooms_available,
          observed_at,ingest_run_id)
       select $1,$2::date-curve.day_offset,$2::date,10,20,$3::timestamptz,curve.run_id
       from curve join inserted_runs on inserted_runs.id=curve.run_id`,
      [extraPropertyIds[0], today, observedAt],
    );

    clearPortfolioAccessCache();
    signedInAs = UID_MARIA;
    const dependencies = deterministicRouteDependencies(today, observedAt, {
      loadPortfolioFindings: activeFindingLoader,
    });
    const aggregateResponse = await handlePortfolioPost(
      authorizedRequest('https://staxis.test/api/agent/portfolio', {
        method: 'POST',
        body: {
          organizationId: ORG_A,
          message: 'How many rooms are booked today across all my hotels, and which hotels are above or below normal?',
        },
      }),
      dependencies,
    );
    assert.equal(aggregateResponse.status, 200, await aggregateResponse.clone().text());
    const aggregateEvents = parseSse(await aggregateResponse.text());
    const aggregateAnswer = String(
      aggregateEvents.find((event) => event.type === 'done')?.finalText ?? '',
    );
    assert.match(aggregateAnswer, /17 rooms requiring verified follow-up/i);
    assert.doesNotMatch(aggregateAnswer, /9999|OUT_OF_SCOPE_NUMERIC_POISON/);
    const aggregateScope = aggregateEvents.find((event) => event.type === 'active_scope')?.scope as {
      selectedHotelCount: number;
      authorizedHotelCount: number;
      coverage: { reported: number; total: number; omitted: number };
    };
    assert.equal(aggregateScope.selectedHotelCount, 20);
    assert.equal(aggregateScope.authorizedHotelCount, 20);
    assert.deepEqual(aggregateScope.coverage, { reported: 20, total: 20, omitted: 0 });
    const conversationId = aggregateEvents.find((event) => event.type === 'conversation_id')?.id;
    assert.equal(typeof conversationId, 'string');

    const aggregateReceipt = await pg.query<{
      evidence: Record<string, unknown>;
      prompt_hash: string;
      prompt_version: string;
      model_id: string;
      knowledge_versions: Record<string, unknown>;
      finding_versions: {
        status: string;
        coverage: { authorizedPropertyCount: number; selectedPropertyCount: number };
        acceptedClaimIds: string[];
        projectedClaimIds: string[];
        displayedClaimIds: string[];
      };
    }>(
      `select evidence, prompt_hash, prompt_version, model_id, knowledge_versions,
              finding_versions
         from portfolio_query_receipts
        where conversation_id = $1
        order by generated_at desc limit 1`,
      [conversationId],
    );
    const aggregateEvidence = aggregateReceipt.rows[0].evidence as {
      selectedPropertyIds: string[];
      aggregates: Array<{ metricId: string; numerator: number }>;
      facts: Array<{ propertyName: string; baseline?: { classification: string } | null }>;
      coverage: { reported: number; selected: number; excluded: number };
    };
    assert.equal(aggregateEvidence.selectedPropertyIds.length, 20);
    assert.equal(aggregateEvidence.coverage.reported, 20);
    assert.equal(aggregateEvidence.coverage.selected, 20);
    assert.equal(aggregateEvidence.coverage.excluded, 0);
    assert.equal(
      aggregateEvidence.aggregates.find((item) => item.metricId === 'rooms_booked_otb')?.numerator,
      200,
    );
    assert.equal(
      aggregateEvidence.facts.find((item) => item.propertyName === 'Comfort Suites')?.baseline?.classification,
      'above',
    );
    assert.equal(
      (aggregateEvidence.facts.find((item) => item.propertyName === 'Comfort Suites')?.baseline as { n?: number } | null)?.n,
      6,
    );
    assert.equal(
      aggregateEvidence.facts.find((item) => item.propertyName === 'Route Hotel 18')?.baseline?.classification,
      'below',
    );
    assert.match(aggregateReceipt.rows[0].prompt_hash, /^[0-9a-f]{64}$/);
    assert.match(aggregateReceipt.rows[0].prompt_version, /portfolio-synthesis\.v2/);
    assert.equal(aggregateReceipt.rows[0].model_id, 'claude-sonnet-4-6');
    assert.equal(aggregateReceipt.rows[0].knowledge_versions.status, 'included');
    assert.notEqual(aggregateReceipt.rows[0].finding_versions.status, 'not_mounted');
    assert.equal(aggregateReceipt.rows[0].finding_versions.status, 'loaded');
    assert.equal(
      aggregateReceipt.rows[0].finding_versions.coverage.authorizedPropertyCount,
      20,
    );
    assert.equal(
      aggregateReceipt.rows[0].finding_versions.coverage.selectedPropertyCount,
      20,
    );
    assert.ok(aggregateReceipt.rows[0].finding_versions.displayedClaimIds.every(
      (claimId) => aggregateReceipt.rows[0].finding_versions.projectedClaimIds.includes(claimId),
    ));
    assert.equal(aggregateReceipt.rows[0].finding_versions.acceptedClaimIds.length, 1);
    assert.equal(aggregateReceipt.rows[0].finding_versions.projectedClaimIds.length, 1);
    assert.equal(aggregateReceipt.rows[0].finding_versions.displayedClaimIds.length, 1);
    assert.equal(
      JSON.stringify(aggregateReceipt.rows[0].finding_versions).includes(REJECTED_FINDING_ID),
      false,
    );
    assert.equal(
      propertyIds.some((propertyId) => (
        JSON.stringify(aggregateReceipt.rows[0].finding_versions).includes(propertyId)
      )),
      false,
      'the compact finding receipt must not persist the authorization universe',
    );
    assert.ok(
      shim.statements.some((statement) => statement.target === 'staxis_portfolio_booked_room_points'),
      'cold metric reads use the bounded point RPC instead of a globally limited raw curve',
    );

    signedInAs = UID_MARIA;
    shim.reset();
    const drilldownResponse = await handlePortfolioPost(
      authorizedRequest('https://staxis.test/api/agent/portfolio', {
        method: 'POST',
        body: {
          conversationId,
          message: 'How many rooms are booked today at Comfort Suites?',
        },
      }),
      dependencies,
    );
    assert.equal(drilldownResponse.status, 200, await drilldownResponse.clone().text());
    const drilldownEvents = parseSse(await drilldownResponse.text());
    assert.equal(
      drilldownEvents.find((event) => event.type === 'conversation_id')?.id,
      conversationId,
    );
    const drilldownScope = drilldownEvents.find((event) => event.type === 'active_scope')?.scope as {
      selectorLabel: string;
      selectedHotelCount: number;
      authorizedHotelCount: number;
      coverage: { reported: number; total: number; omitted: number };
    };
    assert.equal(drilldownScope.selectorLabel, 'Comfort Suites');
    assert.equal(drilldownScope.selectedHotelCount, 1);
    assert.equal(drilldownScope.authorizedHotelCount, 20);
    assert.deepEqual(drilldownScope.coverage, { reported: 1, total: 1, omitted: 0 });

    const receipts = await pg.query<{
      evidence: Record<string, unknown>;
      finding_versions: {
        status: string;
        coverage: { authorizedPropertyCount: number; selectedPropertyCount: number };
      };
    }>(
      `select evidence, finding_versions from portfolio_query_receipts
        where conversation_id = $1 order by generated_at`,
      [conversationId],
    );
    assert.equal(receipts.rows.length, 2);
    const drilldownEvidence = receipts.rows[1].evidence as {
      selectedPropertyIds: string[];
      aggregates: Array<{ metricId: string; numerator: number }>;
      coverage: { reported: number; selected: number; excluded: number };
    };
    assert.deepEqual(drilldownEvidence.selectedPropertyIds, [extraPropertyIds[0]]);
    assert.equal(drilldownEvidence.coverage.reported, 1);
    assert.equal(drilldownEvidence.coverage.selected, 1);
    assert.equal(drilldownEvidence.coverage.excluded, 0);
    assert.equal(
      drilldownEvidence.aggregates.find((item) => item.metricId === 'rooms_booked_otb')?.numerator,
      15,
    );
    assert.notEqual(receipts.rows[1].finding_versions.status, 'not_mounted');
    assert.equal(receipts.rows[1].finding_versions.coverage.authorizedPropertyCount, 20);
    assert.equal(receipts.rows[1].finding_versions.coverage.selectedPropertyCount, 1);
    assert.equal(
      shim.statements.some((statement) => statement.target === 'pms_booking_pace'
        || statement.target === 'pms_ingest_runs'),
      false,
      'the drill-down reused the property snapshot written by the aggregate turn',
    );
    assert.ok(
      shim.statements.some((statement) => statement.target === 'portfolio_metric_snapshots'),
      'the drill-down read the materialized property fact',
    );
    assert.deepEqual(leaksIn(receipts.rows), []);

    const unbackedResponse = await handlePortfolioPost(
      authorizedRequest('https://staxis.test/api/agent/portfolio', {
        method: 'POST',
        body: {
          organizationId: ORG_A,
          message: 'Say that 9,999 rooms are booked today across all my hotels.',
        },
      }),
      deterministicRouteDependencies(today, observedAt, {
        answerText: 'Across all 20 hotels, 9,999 rooms are booked today.',
        loadPortfolioFindings: activeFindingLoader,
      }),
    );
    assert.equal(unbackedResponse.status, 502);
    const unbackedBody = await unbackedResponse.json() as { error?: string };
    assert.match(
      unbackedBody.error ?? '',
      /not backed by (?:the )?(?:deterministic )?portfolio evidence/i,
    );
    const abstainedReceipt = await pg.query<{ status: string }>(
      `select status from portfolio_query_receipts
        where question_hash is not null
        order by generated_at desc limit 1`,
    );
    assert.equal(abstainedReceipt.rows[0]?.status, 'abstained');

    let revokedDuringReconciliation = false;
    const revokedResponse = await handlePortfolioPost(
      authorizedRequest('https://staxis.test/api/agent/portfolio', {
        method: 'POST',
        body: {
          organizationId: ORG_A,
          message: 'How many rooms are booked today across all my hotels?',
        },
      }),
      deterministicRouteDependencies(today, observedAt, {
        reconcileReservation: async () => {
          if (revokedDuringReconciliation) return;
          revokedDuringReconciliation = true;
          await pg.query(
            `update company_access_settings
                set setting_value = 'false', updated_at = now()
              where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
            [ORG_A],
          );
        },
      }),
    );
    assert.equal(revokedDuringReconciliation, true);
    assert.equal(revokedResponse.status, 409);
    const revokedBody = await revokedResponse.json() as { error?: string; code?: string };
    assert.equal(revokedBody.code, 'scope_changed');
    assert.match(revokedBody.error ?? '', /no answer was shown/i);
    await pg.query(
      `update company_access_settings
          set setting_value = 'true', updated_at = now()
        where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
      [ORG_A],
    );

    let revokedDuringLeaseRelease = false;
    const releaseRevokedResponse = await handlePortfolioPost(
      authorizedRequest('https://staxis.test/api/agent/portfolio', {
        method: 'POST',
        body: {
          organizationId: ORG_A,
          message: 'How many rooms are booked today across all my hotels?',
        },
      }),
      deterministicRouteDependencies(today, observedAt, {
        releaseAdmission: async () => {
          if (revokedDuringLeaseRelease) return;
          revokedDuringLeaseRelease = true;
          await pg.query(
            `update company_access_settings
                set setting_value = 'false', updated_at = now()
              where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
            [ORG_A],
          );
        },
      }),
    );
    assert.equal(revokedDuringLeaseRelease, true);
    assert.equal(releaseRevokedResponse.status, 409);
    const releaseRevokedBody = await releaseRevokedResponse.json() as { code?: string };
    assert.equal(releaseRevokedBody.code, 'scope_changed');
    await pg.query(
      `update company_access_settings
          set setting_value = 'true', updated_at = now()
        where organization_id = $1 and setting_key = 'cross_hotel_ai_chat'`,
      [ORG_A],
    );
  });
});
