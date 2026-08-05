process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';

import { GET as listPortfolioConversations } from '@/app/api/agent/portfolio/conversations/route';
import { GET as getPortfolioConversation } from '@/app/api/agent/portfolio/conversations/[id]/route';
import {
  commitPortfolioConversationTurn,
  createPortfolioConversation,
} from '@/lib/agent/memory';
import { resolveAuthorizationScope } from '@/lib/authorization/server';
import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import { buildPortfolioFindingNotMountedReceipt } from '@/lib/agent/portfolio-intelligence/pattern-contract';
import { clearPortfolioAccessCache, resolvePortfolioAccessUncached } from '@/lib/company/portfolio';
import { resolvePortfolioQueuePolicy } from '@/lib/company/portfolio-data-policy';
import { stampPortfolioPolicy } from '@/lib/agent/portfolio/conversation';
import { clearPortfolioHotelCache } from '@/lib/agent/portfolio/hotels';
import { supabaseAdmin } from '@/lib/supabase-admin';

import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_MARIA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_A3,
  UID_MARIA,
  UID_VERA,
  seedTwoCompanies,
  setCrossHotelChat,
  type TwoCompanySeed,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;
let seed: TwoCompanySeed;
let signedInAs: string | null = null;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function authorizedRequest(url: string): NextRequest {
  return new NextRequest(url, {
    headers: {
      authorization: 'Bearer portfolio-resume-test-token',
      'x-real-ip': '203.0.113.29',
    },
  });
}

async function insertReceiptAndCommit(input: {
  conversationId: string;
  receipt: AuthorizationScopeReceipt;
  question: string;
  answer: string;
  selector: Record<string, unknown>;
}): Promise<void> {
  const selectedPropertyIds = input.receipt.propertyIds;
  const authorizedPropertyIds = input.receipt.authorizedPropertyIds;
  assert.ok(selectedPropertyIds.length > 0);
  const namesResult = await pg.query<{ id: string; name: string }>(
    `select id::text, name from public.properties where id = any($1::uuid[])`,
    [selectedPropertyIds],
  );
  const names = new Map(namesResult.rows.map((row) => [row.id, row.name]));
  const question = input.question.trim();
  const promptVersion = 'portfolio-synthesis.test.v1';
  const promptHash = sha256('portfolio resume integration prompt');
  const modelCandidate = JSON.stringify({ version: 'portfolio-presentation-plan.v1' });
  const providerRequest = JSON.stringify({
    version: 'portfolio-model-request.v1',
    runtime: 'messages.create',
    attempts: [{
      ordinal: 0,
      provider: 'anthropic',
      requestedModelId: 'test-model-alias',
      request: {
        model: 'test-model-alias',
        max_tokens: 8192,
        system: [],
        messages: [{ role: 'user', content: question }],
      },
      outcome: 'succeeded',
      response: {
        id: 'msg_resume_integration',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: modelCandidate }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: null,
        },
      },
      responseModelId: 'test-model',
      billableUsage: {
        inputTokens: 10,
        uncachedInputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
      },
      failureName: null,
    }],
  });
  const rendererVersion = 'portfolio-deterministic-renderer.test.v1';
  const findingVersions = buildPortfolioFindingNotMountedReceipt({
    organizationId: input.receipt.organizationId,
    scopeReceiptId: input.receipt.id,
    scopeHash: input.receipt.scopeHash,
  });
  const evidence = {
    organizationId: ORG_A,
    organizationName: input.receipt.organizationName,
    scopeHash: input.receipt.scopeHash,
    authorizedPropertyIds,
    selectedPropertyIds,
    facts: selectedPropertyIds.map((propertyId) => ({
      propertyId,
      propertyName: names.get(propertyId) ?? 'Authorized hotel',
    })),
    coverage: {
      authorized: authorizedPropertyIds.length,
      selected: selectedPropertyIds.length,
      reported: selectedPropertyIds.length,
      excluded: 0,
      excludedHotels: [],
    },
  };

  const artifact = await pg.query<{ id: string }>(
    `insert into public.portfolio_model_request_artifacts (
       property_id, organization_id, account_id, conversation_id,
       scope_receipt_id, authorization_hash, scope_hash, artifact_version,
       normalized_question, question_hash, prompt_version, prompt_hash,
       provider_request, provider_request_hash, configured_execution,
       applied_parameters, actual_model_id, actual_model_tier,
       model_candidate_text, model_candidate_hash, renderer_version,
       rendered_answer_text, rendered_answer_hash, authorized_property_ids,
       selected_property_ids, finding_versions
     ) values (
       $1, $2, $3, $4, $5, $6, $7, 'portfolio-model-request.v1',
       $8, $9, $10, $11, $12::jsonb, $13, '{}'::jsonb, '{}'::jsonb,
       'test-model', 'sonnet', $14, $15, $16, $17, $18,
       $19::uuid[], $20::uuid[], $21::jsonb
     ) returning id`,
    [
      selectedPropertyIds[0], ORG_A, ACCOUNT_MARIA, input.conversationId,
      input.receipt.id, input.receipt.authorizationHash, input.receipt.scopeHash,
      question, sha256(question), promptVersion, promptHash,
      providerRequest, sha256(providerRequest), modelCandidate, sha256(modelCandidate),
      rendererVersion, input.answer, sha256(input.answer),
      authorizedPropertyIds, selectedPropertyIds, JSON.stringify(findingVersions),
    ],
  );
  const queryReceipt = await pg.query<{ id: string }>(
    `insert into public.portfolio_query_receipts (
       property_id, organization_id, account_id, conversation_id,
       scope_receipt_id, authorization_hash, scope_hash, question_hash,
       query_plan_version, evidence_version, prompt_version, prompt_hash,
       model_id, model_tier, authorized_property_ids, selected_property_ids,
       metric_versions, source_versions, plan, evidence, answer_hash, status,
       duration_ms, knowledge_versions, finding_versions, request_artifact_id,
       model_candidate_hash, renderer_version
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       'portfolio-query-plan.test.v1', 'portfolio-evidence.test.v1', $9, $10,
       'test-model', 'sonnet', $11::uuid[], $12::uuid[], '{}'::jsonb,
       '[]'::jsonb, $13::jsonb, $14::jsonb, $15, 'completed', 1,
       '{}'::jsonb, $16::jsonb, $17, $18, $19
     ) returning id`,
    [
      selectedPropertyIds[0], ORG_A, ACCOUNT_MARIA, input.conversationId,
      input.receipt.id, input.receipt.authorizationHash, input.receipt.scopeHash,
      sha256(question), promptVersion, promptHash,
      authorizedPropertyIds, selectedPropertyIds,
      JSON.stringify({ selector: input.selector }), JSON.stringify(evidence),
      sha256(input.answer), JSON.stringify(findingVersions), artifact.rows[0].id,
      sha256(modelCandidate), rendererVersion,
    ],
  );
  const committed = await commitPortfolioConversationTurn({
    conversationId: input.conversationId,
    userAccountId: ACCOUNT_MARIA,
    organizationId: ORG_A,
    authorizationHash: input.receipt.authorizationHash,
    scopeReceiptId: input.receipt.id,
    queryReceiptId: queryReceipt.rows[0].id,
    userMessage: input.question,
    assistantText: input.answer,
    tokensIn: 10,
    tokensOut: 5,
    modelUsed: 'sonnet',
    modelId: 'test-model',
    costUsd: 0.001,
    promptVersion,
  });
  assert.equal(committed.ok, true, committed.ok ? undefined : committed.reason);
}

async function createTwoTurnConversation(): Promise<string> {
  const access = await resolvePortfolioAccessUncached(ACCOUNT_MARIA, ORG_A);
  assert.ok(access.ok, access.ok ? undefined : access.reason);
  const allReceipt = access.access.authorizationReceipt;
  const policy = await resolvePortfolioQueuePolicy(
    { accountId: ACCOUNT_MARIA, role: 'front_desk', propertyAccess: [] },
    ORG_A,
    access.access.propertyIds,
  );
  const created = await createPortfolioConversation({
    userAccountId: ACCOUNT_MARIA,
    propertyAnchorId: PID_A1,
    role: 'general_manager',
    promptVersion: stampPortfolioPolicy(
      'portfolio-synthesis.test.v1',
      policy.fingerprint,
    ),
    title: 'Portfolio then hotel',
    organizationId: ORG_A,
    authorizationHash: allReceipt.authorizationHash,
    scopeReceiptId: allReceipt.id,
    userMessage: 'How are all my hotels doing?',
  });
  assert.ok(created.ok, created.ok ? undefined : created.reason);
  await insertReceiptAndCommit({
    conversationId: created.conversationId,
    receipt: allReceipt,
    question: 'How are all my hotels doing?',
    answer: 'Both currently authorized hotels reported.',
    selector: { kind: 'all_authorized' },
  });

  const subset = await resolveAuthorizationScope({
    accountId: ACCOUNT_MARIA,
    organizationId: ORG_A,
    selector: { type: 'property_subset', propertyIds: [PID_A2] },
  });
  assert.ok(subset.ok, subset.ok ? undefined : subset.reason);
  assert.equal(subset.receipt.authorizationHash, allReceipt.authorizationHash);
  await insertReceiptAndCommit({
    conversationId: created.conversationId,
    receipt: subset.receipt,
    question: 'What is happening at Lufkin Inn?',
    answer: 'Lufkin Inn reported its current hotel status.',
    selector: { kind: 'hotel', propertyId: PID_A2 },
  });
  return created.conversationId;
}

before(async () => {
  const migrated = await applyMigrationsToPgliteThrough('0425');
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error install the PGlite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error install the PGlite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  // @ts-expect-error the route only consumes the user identity from this seam
  supabaseAdmin.auth.getUser = async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'resume@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  );
  seed = await seedTwoCompanies(pg);
  await setCrossHotelChat(pg, ORG_A, true);
  await setCrossHotelChat(pg, ORG_B, true);
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

beforeEach(async () => {
  signedInAs = null;
  clearPortfolioAccessCache();
  clearPortfolioHotelCache();
  shim.reset();
  await pg.query(`update public.accounts set active = true where id = $1`, [ACCOUNT_MARIA]);
  await setCrossHotelChat(pg, ORG_A, true);
  await setCrossHotelChat(pg, ORG_B, true);
});

describe('dedicated portfolio conversation resume routes', () => {
  test('list/detail replay only committed receipt-backed turns with visible grain and no anchor ids', async () => {
    const conversationId = await createTwoTurnConversation();
    signedInAs = UID_MARIA;

    const listResponse = await listPortfolioConversations(
      authorizedRequest(`https://staxis.test/api/agent/portfolio/conversations?organizationId=${ORG_A}`),
    );
    assert.equal(listResponse.status, 200, await listResponse.clone().text());
    assert.equal(listResponse.headers.get('cache-control'), 'private, no-store, max-age=0');
    const listBody = await listResponse.json() as {
      data?: { conversations?: Array<Record<string, unknown>> };
    };
    const listed = listBody.data?.conversations?.find((row) => row.id === conversationId);
    assert.ok(listed);
    assert.equal(listed.conversationKind, 'portfolio');
    assert.equal(listed.organizationId, ORG_A);
    assert.equal('propertyId' in listed, false, 'the relational anchor is not browser scope');
    assert.equal('authorizationHash' in listed, false);
    assert.equal('scopeReceiptId' in listed, false);

    const detailResponse = await getPortfolioConversation(
      authorizedRequest(
        `https://staxis.test/api/agent/portfolio/conversations/${conversationId}?organizationId=${ORG_A}`,
      ),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
    const detailBody = await detailResponse.json() as {
      data?: { conversation?: Record<string, unknown>; pendingActions?: unknown[] };
    };
    const conversation = detailBody.data?.conversation as {
      messages: Array<{ role: string; content: string }>;
      scopeDisclosures: Array<{
        turn: number;
        scope: {
          organizationId: string;
          selectorLabel: string;
          selectedHotelCount: number;
          authorizedHotelCount: number;
        };
      }>;
      [key: string]: unknown;
    };
    assert.deepEqual(conversation.messages, [
      { role: 'user', content: 'How are all my hotels doing?' },
      { role: 'assistant', content: 'Both currently authorized hotels reported.' },
      { role: 'user', content: 'What is happening at Lufkin Inn?' },
      { role: 'assistant', content: 'Lufkin Inn reported its current hotel status.' },
    ]);
    assert.deepEqual(
      conversation.scopeDisclosures.map((item) => ({
        turn: item.turn,
        organizationId: item.scope.organizationId,
        label: item.scope.selectorLabel,
        selected: item.scope.selectedHotelCount,
        authorized: item.scope.authorizedHotelCount,
      })),
      [
        { turn: 0, organizationId: ORG_A, label: 'All authorized hotels', selected: 2, authorized: 2 },
        { turn: 1, organizationId: ORG_A, label: 'Lufkin Inn', selected: 1, authorized: 2 },
      ],
    );
    assert.deepEqual(detailBody.data?.pendingActions, []);
    assert.equal('propertyId' in conversation, false);
    assert.doesNotMatch(
      JSON.stringify(conversation),
      /authorizationHash|scopeHash|scopeReceiptId|queryReceiptId/,
    );
  });

  test('a newly acquired hotel invalidates old history before any transcript leaves the server', async () => {
    const conversationId = await createTwoTurnConversation();
    await seed.attachPropertyToOrganization(pg, ORG_A, PID_A3, 'Newly Acquired Hotel');
    clearPortfolioAccessCache();
    clearPortfolioHotelCache();
    signedInAs = UID_MARIA;

    const response = await getPortfolioConversation(
      authorizedRequest(
        `https://staxis.test/api/agent/portfolio/conversations/${conversationId}?organizationId=${ORG_A}`,
      ),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(response.status, 409);
    const body = await response.json() as { code?: string; data?: unknown };
    assert.equal(body.code, 'scope_changed');
    assert.equal(body.data, undefined);
  });

  test('foreign-company direct ids, feature revocation, and inactive accounts fail generically', async () => {
    const conversationId = await createTwoTurnConversation();

    signedInAs = UID_VERA;
    const foreign = await getPortfolioConversation(
      authorizedRequest(
        `https://staxis.test/api/agent/portfolio/conversations/${conversationId}?organizationId=${ORG_B}`,
      ),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(foreign.status, 404);
    assert.doesNotMatch(await foreign.text(), /Gulf Coast|Lufkin|currently authorized/i);

    signedInAs = UID_MARIA;
    await setCrossHotelChat(pg, ORG_A, false);
    clearPortfolioAccessCache();
    const revoked = await getPortfolioConversation(
      authorizedRequest(
        `https://staxis.test/api/agent/portfolio/conversations/${conversationId}?organizationId=${ORG_A}`,
      ),
      { params: Promise.resolve({ id: conversationId }) },
    );
    assert.equal(revoked.status, 404);
    assert.doesNotMatch(await revoked.text(), /Gulf Coast|Lufkin|currently authorized/i);

    await setCrossHotelChat(pg, ORG_A, true);
    await pg.query(`update public.accounts set active = false where id = $1`, [ACCOUNT_MARIA]);
    clearPortfolioAccessCache();
    const inactive = await listPortfolioConversations(
      authorizedRequest(`https://staxis.test/api/agent/portfolio/conversations?organizationId=${ORG_A}`),
    );
    assert.equal(inactive.status, 404);
    assert.doesNotMatch(await inactive.text(), /Gulf Coast|Lufkin|currently authorized/i);
  });
});
