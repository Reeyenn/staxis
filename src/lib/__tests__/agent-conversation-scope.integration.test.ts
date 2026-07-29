/**
 * First-class agent conversation scope, against the production migrations.
 *
 * Regression cause: portfolio authority used to ride in prompt_version while
 * the shared property RPC checked only the anchor hotel. That made mode a
 * convention: either route could replay the other route's transcript, and a
 * company authorization change had no durable conversation identity to fail.
 * These tests exercise 0379's scoped conversation functions plus 0399's
 * receipt-bound atomic turn commit, not a JS imitation.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';
import { buildPortfolioFindingNotMountedReceipt } from '@/lib/agent/portfolio-intelligence/pattern-contract';
import {
  PORTFOLIO_ASSISTANT_MESSAGE_MAX_UTF8_BYTES,
  PORTFOLIO_HISTORY_MAX_TURNS,
  PORTFOLIO_HISTORY_MAX_UTF8_BYTES,
  PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES,
  PORTFOLIO_HISTORY_WINDOW_VERSION,
} from '@/lib/agent/portfolio-intelligence/history-window';
import { setupRlsFixture, type PgliteFixture } from '../../../tests/fixtures/pglite-bootstrap';
import {
  ACCOUNT_MARIA,
  ACCOUNT_VERA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_A3,
  UID_MARIA,
  seedTwoCompanies,
  type TwoCompanySeed,
} from '../../../tests/fixtures/pglite-two-company-seed';

interface ScopeReceipt {
  id: string;
  organizationId: string;
  authorizationHash: string;
  scopeHash: string;
  authorizedPropertyIds: string[];
  propertyIds: string[];
}

interface PrepRow {
  ok: boolean;
  reason: string | null;
  history_rows?: Array<Record<string, unknown>>;
  history_meta?: Record<string, unknown>;
}

interface HistoryWindowMeta {
  version: string;
  maxTurns: number;
  maxUtf8Bytes: number;
  turnOverheadUtf8Bytes: number;
  totalTurnCount: number;
  includedTurnCount: number;
  omittedTurnCount: number;
  totalUtf8Bytes: number;
  includedUtf8Bytes: number;
  omittedUtf8Bytes: number;
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function replayBytes(question: string, answer: string): number {
  return Buffer.byteLength(question, 'utf8')
    + Buffer.byteLength(answer, 'utf8')
    + PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES;
}

function historyMeta(row: PrepRow): HistoryWindowMeta {
  assert.notEqual(row.history_meta, undefined, 'successful prep omitted history metadata');
  return jsonValue<HistoryWindowMeta>(row.history_meta);
}

async function resolveReceipt(
  pg: PGlite,
  input: {
    accountId: string;
    organizationId: string;
    selector?: 'all_authorized' | 'property_subset';
    propertyIds?: string[];
  },
): Promise<ScopeReceipt> {
  const result = await pg.query<{ result: unknown }>(
    `select public.staxis_resolve_authorization_scope(
       $1::uuid, $2::uuid, $3::text, null::uuid, $4::jsonb, 300
     ) as result`,
    [
      input.accountId,
      input.organizationId,
      input.selector ?? 'all_authorized',
      input.propertyIds ? JSON.stringify(input.propertyIds) : null,
    ],
  );
  const payload = jsonValue<{ ok: boolean; reason?: string; receipt?: ScopeReceipt }>(
    result.rows[0]?.result,
  );
  assert.equal(payload.ok, true, `scope fixture refused: ${payload.reason ?? 'unknown'}`);
  assert.ok(payload.receipt);
  return payload.receipt;
}

async function createPortfolioConversation(
  pg: PGlite,
  receipt: ScopeReceipt,
  message = 'How are all my hotels doing?',
): Promise<string> {
  const result = await pg.query<{ ok: boolean; reason: string | null; conversation_id: string | null }>(
    `select * from public.staxis_create_portfolio_conversation(
       $1::uuid, $2::uuid, 'general_manager', 'portfolio-prompt-v1',
       'portfolio thread', $3::uuid, $4::text, $5::uuid, $6::text
     )`,
    [ACCOUNT_MARIA, PID_A1, ORG_A, receipt.authorizationHash, receipt.id, message],
  );
  assert.equal(result.rows[0]?.ok, true, `create refused: ${result.rows[0]?.reason}`);
  assert.ok(result.rows[0]?.conversation_id);
  return result.rows[0].conversation_id;
}

async function portfolioPrep(
  pg: PGlite,
  input: {
    conversationId: string;
    accountId?: string;
    organizationId?: string;
    receipt: ScopeReceipt;
    message: string;
  },
): Promise<PrepRow> {
  const result = await pg.query<PrepRow>(
    `select * from public.staxis_lock_load_and_record_portfolio_user_turn(
       $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::text
     )`,
    [
      input.conversationId,
      input.accountId ?? ACCOUNT_MARIA,
      input.organizationId ?? ORG_A,
      input.receipt.authorizationHash,
      input.receipt.id,
      input.message,
    ],
  );
  return result.rows[0];
}

/**
 * Persist the same three-row proof the production route creates: immutable
 * model artifact -> immutable query receipt -> atomic user/assistant commit.
 * A turn is not history until all three exist and the RPC reasserts scope.
 */
async function commitPortfolioTurn(
  pg: PGlite,
  input: {
    conversationId: string;
    receipt: ScopeReceipt;
    question: string;
    answer: string;
    selectedPropertyIds?: string[];
  },
): Promise<{ ok: boolean; reason: string; queryReceiptId: string }> {
  const question = input.question.trim();
  const selectedPropertyIds = input.selectedPropertyIds ?? input.receipt.propertyIds;
  assert.ok(selectedPropertyIds.length > 0);
  const promptVersion = 'portfolio-prompt-v1';
  const promptHash = sha256('scope integration test prompt');
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
        id: 'msg_scope_integration',
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
  const rendererVersion = 'portfolio-test-renderer.v1';
  const findingVersions = buildPortfolioFindingNotMountedReceipt({
    organizationId: input.receipt.organizationId,
    scopeReceiptId: input.receipt.id,
    scopeHash: input.receipt.scopeHash,
  });

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
      input.receipt.authorizedPropertyIds, selectedPropertyIds,
      JSON.stringify(findingVersions),
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
       '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $13, 'completed', 1,
       '{}'::jsonb, $14::jsonb, $15, $16, $17
     ) returning id`,
    [
      selectedPropertyIds[0], ORG_A, ACCOUNT_MARIA, input.conversationId,
      input.receipt.id, input.receipt.authorizationHash, input.receipt.scopeHash,
      sha256(question), promptVersion, promptHash,
      input.receipt.authorizedPropertyIds, selectedPropertyIds,
      sha256(input.answer), JSON.stringify(findingVersions), artifact.rows[0].id,
      sha256(modelCandidate), rendererVersion,
    ],
  );
  const committed = await pg.query<{ result: unknown }>(
    `select public.staxis_commit_portfolio_conversation_turn(
       $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::uuid,
       $7::text, $8::text, 10, 5, 'sonnet', 'test-model', 0.001,
       $9::text
     ) as result`,
    [
      input.conversationId, ACCOUNT_MARIA, ORG_A,
      input.receipt.authorizationHash, input.receipt.id, queryReceipt.rows[0].id,
      input.question, input.answer, promptVersion,
    ],
  );
  const result = jsonValue<{ ok: boolean; reason: string }>(committed.rows[0].result);
  return { ...result, queryReceiptId: queryReceipt.rows[0].id };
}

describe('0379/0399 agent conversation mode + atomic authorization isolation', () => {
  let fx: PgliteFixture;
  let pg: PGlite;
  let seed: TwoCompanySeed;

  before(async () => {
    fx = await setupRlsFixture();
    pg = fx.pg;
    const failure = fx.migrationReport.failedAtRuntime.find(
      (entry) => entry.file === '0379_agent_portfolio_conversation_scope.sql',
    );
    assert.equal(failure, undefined, failure?.error);
    assert.ok(
      fx.migrationReport.applied.includes('0379_agent_portfolio_conversation_scope.sql'),
      '0379 did not apply in the production-migration fixture',
    );
    seed = await seedTwoCompanies(pg);
  });

  after(async () => {
    await pg?.close().catch(() => undefined);
  });

  test('property and portfolio RPCs refuse one another before replay or record', async () => {
    const receipt = await resolveReceipt(pg, { accountId: ACCOUNT_MARIA, organizationId: ORG_A });
    const portfolioId = await createPortfolioConversation(pg, receipt);
    const property = await pg.query<{ id: string }>(
      `insert into public.agent_conversations
         (user_id, property_id, role, prompt_version, conversation_kind)
       values ($1, $2, 'general_manager', 'property-prompt-v1', 'property')
       returning id`,
      [ACCOUNT_MARIA, PID_A1],
    );
    const propertyId = property.rows[0].id;
    await pg.query(
      `insert into public.agent_messages (conversation_id, role, content)
       values ($1, 'user', 'one hotel only')`,
      [propertyId],
    );

    const propertyAgainstPortfolio = await pg.query<PrepRow>(
      `select * from public.staxis_lock_load_and_record_user_turn(
         $1::uuid, $2::uuid, $3::uuid, 'wrong mode'
       )`,
      [portfolioId, ACCOUNT_MARIA, PID_A1],
    );
    assert.deepEqual(
      { ok: propertyAgainstPortfolio.rows[0].ok, reason: propertyAgainstPortfolio.rows[0].reason },
      { ok: false, reason: 'wrong_kind' },
    );

    const portfolioAgainstProperty = await portfolioPrep(pg, {
      conversationId: propertyId,
      receipt,
      message: 'wrong mode the other way',
    });
    assert.deepEqual(
      { ok: portfolioAgainstProperty.ok, reason: portfolioAgainstProperty.reason },
      { ok: false, reason: 'wrong_kind' },
    );

    const counts = await pg.query<{ conversation_id: string; count: number }>(
      `select conversation_id, count(*)::int as count
         from public.agent_messages
        where conversation_id = any($1::uuid[])
        group by conversation_id`,
      [[portfolioId, propertyId]],
    );
    assert.deepEqual(
      new Map(counts.rows.map((row) => [row.conversation_id, row.count])),
      new Map([[propertyId, 1]]),
      'a rejected cross-mode call appended a user turn',
    );
  });

  test('failed prep/retry leaves no dangling turn; a different grain reuses only committed history', async () => {
    const allReceipt = await resolveReceipt(pg, {
      accountId: ACCOUNT_MARIA,
      organizationId: ORG_A,
    });
    const subsetReceipt = await resolveReceipt(pg, {
      accountId: ACCOUNT_MARIA,
      organizationId: ORG_A,
      selector: 'property_subset',
      propertyIds: [PID_A2],
    });
    assert.equal(subsetReceipt.authorizationHash, allReceipt.authorizationHash);
    assert.notEqual(subsetReceipt.scopeHash, allReceipt.scopeHash);

    const conversationId = await createPortfolioConversation(pg, allReceipt, 'all hotels');
    const failedAttemptPrep = await portfolioPrep(pg, {
      conversationId,
      receipt: allReceipt,
      message: 'all hotels',
    });
    assert.equal(failedAttemptPrep.ok, true, failedAttemptPrep.reason ?? undefined);
    assert.deepEqual(jsonValue(failedAttemptPrep.history_rows ?? []), []);
    const retryPrep = await portfolioPrep(pg, {
      conversationId,
      receipt: allReceipt,
      message: 'all hotels',
    });
    assert.equal(retryPrep.ok, true, retryPrep.reason ?? undefined);
    assert.deepEqual(jsonValue(retryPrep.history_rows ?? []), []);
    const emptyAfterFailedAttempt = await pg.query<{ messages: number; commits: number }>(
      `select
         (select count(*)::int from public.agent_messages where conversation_id = $1) as messages,
         (select count(*)::int from public.portfolio_query_turn_commits where conversation_id = $1) as commits`,
      [conversationId],
    );
    assert.deepEqual(emptyAfterFailedAttempt.rows[0], { messages: 0, commits: 0 });

    const firstCommit = await commitPortfolioTurn(pg, {
      conversationId,
      receipt: allReceipt,
      question: 'all hotels',
      answer: 'All authorized hotels reported.',
    });
    assert.deepEqual(
      { ok: firstCommit.ok, reason: firstCommit.reason },
      { ok: true, reason: 'committed' },
    );
    const prep = await portfolioPrep(pg, {
      conversationId,
      receipt: subsetReceipt,
      message: 'now compare only Lufkin',
    });
    assert.equal(prep.ok, true, prep.reason ?? undefined);
    const history = jsonValue<Array<{ role: string; content: string }>>(prep.history_rows ?? []);
    assert.deepEqual(history.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'all hotels' },
      { role: 'assistant', content: 'All authorized hotels reported.' },
    ]);

    const committedOnly = await pg.query<{ messages: number; commits: number }>(
      `select
         (select count(*)::int from public.agent_messages where conversation_id = $1) as messages,
         (select count(*)::int from public.portfolio_query_turn_commits where conversation_id = $1) as commits`,
      [conversationId],
    );
    assert.deepEqual(committedOnly.rows[0], { messages: 2, commits: 1 });

    const stored = await pg.query<{
      conversation_kind: string;
      organization_id: string;
      authorization_hash: string;
      scope_receipt_id: string;
    }>(
      `select conversation_kind, organization_id, authorization_hash, scope_receipt_id
         from public.agent_conversations where id = $1`,
      [conversationId],
    );
    assert.deepEqual(stored.rows[0], {
      conversation_kind: 'portfolio',
      organization_id: ORG_A,
      authorization_hash: allReceipt.authorizationHash,
      scope_receipt_id: subsetReceipt.id,
    });
  });

  test('replay selects the newest 24 complete receipted turns before JSON aggregation', async () => {
    const receipt = await resolveReceipt(pg, { accountId: ACCOUNT_MARIA, organizationId: ORG_A });
    const conversationId = await createPortfolioConversation(pg, receipt, 'bounded history');
    const turns = Array.from({ length: 51 }, (_, index) => ({
      question: `bounded-question-${String(index).padStart(2, '0')}`,
      answer: `Bounded answer ${String(index).padStart(2, '0')}.`,
    }));
    for (const turn of turns) {
      const committed = await commitPortfolioTurn(pg, {
        conversationId,
        receipt,
        question: turn.question,
        answer: turn.answer,
      });
      assert.equal(committed.ok, true, `${turn.question}: ${committed.reason}`);
    }

    const prep = await portfolioPrep(pg, {
      conversationId,
      receipt,
      message: 'show the bounded suffix',
    });
    assert.equal(prep.ok, true, prep.reason ?? undefined);
    const meta = historyMeta(prep);
    const expectedTurns = turns.slice(-PORTFOLIO_HISTORY_MAX_TURNS);
    const history = jsonValue<Array<{ role: string; content: string }>>(prep.history_rows ?? []);
    assert.deepEqual(history.map((item) => item.content), expectedTurns.flatMap((turn) => [
      turn.question,
      turn.answer,
    ]));
    const totalBytes = turns.reduce(
      (sum, turn) => sum + replayBytes(turn.question, turn.answer),
      0,
    );
    const includedBytes = expectedTurns.reduce(
      (sum, turn) => sum + replayBytes(turn.question, turn.answer),
      0,
    );
    assert.deepEqual(meta, {
      version: PORTFOLIO_HISTORY_WINDOW_VERSION,
      maxTurns: PORTFOLIO_HISTORY_MAX_TURNS,
      maxUtf8Bytes: PORTFOLIO_HISTORY_MAX_UTF8_BYTES,
      turnOverheadUtf8Bytes: PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES,
      totalTurnCount: 51,
      includedTurnCount: PORTFOLIO_HISTORY_MAX_TURNS,
      omittedTurnCount: 51 - PORTFOLIO_HISTORY_MAX_TURNS,
      totalUtf8Bytes: totalBytes,
      includedUtf8Bytes: includedBytes,
      omittedUtf8Bytes: totalBytes - includedBytes,
    });
  });

  test('UTF-8 budget returns a chronological newest suffix with honest omissions', async () => {
    const receipt = await resolveReceipt(pg, { accountId: ACCOUNT_MARIA, organizationId: ORG_A });
    const conversationId = await createPortfolioConversation(pg, receipt, 'multibyte history');
    const turns = Array.from({ length: 8 }, (_, index) => ({
      question: `multibyte-${index}`,
      answer: `Hôtel-${index}:` + 'é'.repeat(6_000),
    }));
    for (const turn of turns) {
      const committed = await commitPortfolioTurn(pg, {
        conversationId,
        receipt,
        question: turn.question,
        answer: turn.answer,
      });
      assert.equal(committed.ok, true, `${turn.question}: ${committed.reason}`);
    }

    const expectedNewestFirst: typeof turns = [];
    let expectedBytes = 0;
    for (const turn of [...turns].reverse()) {
      const nextBytes = replayBytes(turn.question, turn.answer);
      if (expectedNewestFirst.length >= PORTFOLIO_HISTORY_MAX_TURNS
          || expectedBytes + nextBytes > PORTFOLIO_HISTORY_MAX_UTF8_BYTES) break;
      expectedNewestFirst.push(turn);
      expectedBytes += nextBytes;
    }
    const expectedTurns = expectedNewestFirst.reverse();
    assert.ok(expectedTurns.length > 0 && expectedTurns.length < turns.length);

    const prep = await portfolioPrep(pg, {
      conversationId,
      receipt,
      message: 'show the byte-bounded suffix',
    });
    assert.equal(prep.ok, true, prep.reason ?? undefined);
    const meta = historyMeta(prep);
    const history = jsonValue<Array<{ role: string; content: string }>>(prep.history_rows ?? []);
    assert.deepEqual(history.map((item) => item.content), expectedTurns.flatMap((turn) => [
      turn.question,
      turn.answer,
    ]));
    const totalBytes = turns.reduce(
      (sum, turn) => sum + replayBytes(turn.question, turn.answer),
      0,
    );
    assert.equal(meta.totalTurnCount, turns.length);
    assert.equal(meta.includedTurnCount, expectedTurns.length);
    assert.equal(meta.omittedTurnCount, turns.length - expectedTurns.length);
    assert.equal(meta.totalUtf8Bytes, totalBytes);
    assert.equal(meta.includedUtf8Bytes, expectedBytes);
    assert.equal(meta.omittedUtf8Bytes, totalBytes - expectedBytes);
  });

  test('write limits keep the newest maximum turn replayable and reject oversized text atomically', async () => {
    const receipt = await resolveReceipt(pg, { accountId: ACCOUNT_MARIA, organizationId: ORG_A });
    const conversationId = await createPortfolioConversation(pg, receipt, 'maximum turn');
    const maximumQuestion = '𐀀'.repeat(4_000);
    const maximumAnswer = 'A'.repeat(PORTFOLIO_ASSISTANT_MESSAGE_MAX_UTF8_BYTES);
    const committed = await commitPortfolioTurn(pg, {
      conversationId,
      receipt,
      question: maximumQuestion,
      answer: maximumAnswer,
    });
    assert.deepEqual(
      { ok: committed.ok, reason: committed.reason },
      { ok: true, reason: 'committed' },
    );
    const prep = await portfolioPrep(pg, {
      conversationId,
      receipt,
      message: 'replay the maximum turn',
    });
    assert.equal(prep.ok, true, prep.reason ?? undefined);
    const meta = historyMeta(prep);
    assert.equal(meta.includedTurnCount, 1);
    assert.equal(meta.omittedTurnCount, 0);
    assert.equal(meta.includedUtf8Bytes, replayBytes(maximumQuestion, maximumAnswer));
    assert.ok(meta.includedUtf8Bytes <= PORTFOLIO_HISTORY_MAX_UTF8_BYTES);

    const rejectedConversationId = await createPortfolioConversation(pg, receipt, 'rejected turns');
    const oversizedUser = await commitPortfolioTurn(pg, {
      conversationId: rejectedConversationId,
      receipt,
      question: 'x'.repeat(4_001),
      answer: 'Valid answer.',
    });
    assert.deepEqual(
      { ok: oversizedUser.ok, reason: oversizedUser.reason },
      { ok: false, reason: 'invalid_turn' },
    );
    const oversizedAnswer = await commitPortfolioTurn(pg, {
      conversationId: rejectedConversationId,
      receipt,
      question: 'valid question',
      answer: 'A'.repeat(PORTFOLIO_ASSISTANT_MESSAGE_MAX_UTF8_BYTES + 1),
    });
    assert.deepEqual(
      { ok: oversizedAnswer.ok, reason: oversizedAnswer.reason },
      { ok: false, reason: 'invalid_turn' },
    );
    const stored = await pg.query<{ messages: number; commits: number }>(
      `select
         (select count(*)::int from public.agent_messages where conversation_id = $1) as messages,
         (select count(*)::int from public.portfolio_query_turn_commits where conversation_id = $1) as commits`,
      [rejectedConversationId],
    );
    assert.deepEqual(stored.rows[0], { messages: 0, commits: 0 });
  });

  test('replay counters are trigger-owned and the final service ACL is RPC-only for writes', async () => {
    const privileges = await pg.query<{
      turn_select: boolean;
      turn_insert: boolean;
      turn_update: boolean;
      turn_delete: boolean;
      counter_select: boolean;
      counter_insert: boolean;
      counter_update: boolean;
      counter_delete: boolean;
    }>(
      `select
         has_table_privilege('service_role', 'public.portfolio_query_turn_commits', 'select') as turn_select,
         has_table_privilege('service_role', 'public.portfolio_query_turn_commits', 'insert') as turn_insert,
         has_table_privilege('service_role', 'public.portfolio_query_turn_commits', 'update') as turn_update,
         has_table_privilege('service_role', 'public.portfolio_query_turn_commits', 'delete') as turn_delete,
         has_table_privilege('service_role', 'public.portfolio_conversation_replay_counters', 'select') as counter_select,
         has_table_privilege('service_role', 'public.portfolio_conversation_replay_counters', 'insert') as counter_insert,
         has_table_privilege('service_role', 'public.portfolio_conversation_replay_counters', 'update') as counter_update,
         has_table_privilege('service_role', 'public.portfolio_conversation_replay_counters', 'delete') as counter_delete`,
    );
    assert.deepEqual(privileges.rows[0], {
      turn_select: true,
      turn_insert: false,
      turn_update: false,
      turn_delete: false,
      counter_select: false,
      counter_insert: false,
      counter_update: false,
      counter_delete: false,
    });

    await pg.exec('begin');
    try {
      await pg.exec('set local role service_role');
      await assert.rejects(
        pg.query(
          `insert into public.portfolio_query_turn_commits (
             query_receipt_id, conversation_id, user_message_id,
             assistant_message_id, replay_utf8_bytes
           ) values (
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 129
           )`,
        ),
        /permission denied/i,
      );
    } finally {
      await pg.exec('rollback');
    }
  });

  test('receipt retention purge decrements exact replay totals without scanning orphaned text', async () => {
    const receipt = await resolveReceipt(pg, { accountId: ACCOUNT_MARIA, organizationId: ORG_A });
    const conversationId = await createPortfolioConversation(pg, receipt, 'purge counter');
    const turn = { question: 'purge this receipt', answer: 'A retained answer.' };
    const committed = await commitPortfolioTurn(pg, {
      conversationId,
      receipt,
      ...turn,
    });
    assert.equal(committed.ok, true, committed.reason);
    const before = await pg.query<{
      committed_turn_count: number;
      committed_replay_utf8_bytes: number;
    }>(
      `select committed_turn_count::int, committed_replay_utf8_bytes::int
         from public.portfolio_conversation_replay_counters
        where conversation_id = $1`,
      [conversationId],
    );
    assert.deepEqual(before.rows[0], {
      committed_turn_count: 1,
      committed_replay_utf8_bytes: replayBytes(turn.question, turn.answer),
    });

    await pg.query(`select set_config('staxis.portfolio_purge', 'on', false)`);
    try {
      await pg.query(
        `update public.portfolio_query_receipts
            set generated_at = now() - interval '200 days'
          where id = $1`,
        [committed.queryReceiptId],
      );
      await pg.query(
        `update public.portfolio_model_request_artifacts artifact
            set created_at = now() - interval '200 days'
           from public.portfolio_query_receipts receipt
          where receipt.id = $1
            and artifact.id = receipt.request_artifact_id`,
        [committed.queryReceiptId],
      );
    } finally {
      await pg.query(`select set_config('staxis.portfolio_purge', 'off', false)`);
    }
    const purged = await pg.query<{ receipts_deleted: number }>(
      `select receipts_deleted::int
         from public.staxis_purge_expired_portfolio_records(
           now() - interval '2 days', now() - interval '100 days', 10
         )`,
    );
    assert.equal(purged.rows[0]?.receipts_deleted, 1);
    const after = await pg.query<{
      commits: number;
      counter_turns: number;
      counter_bytes: number;
    }>(
      `select
         (select count(*)::int from public.portfolio_query_turn_commits where conversation_id = $1) as commits,
         (select committed_turn_count::int from public.portfolio_conversation_replay_counters where conversation_id = $1) as counter_turns,
         (select committed_replay_utf8_bytes::int from public.portfolio_conversation_replay_counters where conversation_id = $1) as counter_bytes`,
      [conversationId],
    );
    assert.deepEqual(after.rows[0], { commits: 0, counter_turns: 0, counter_bytes: 0 });
    const prep = await portfolioPrep(pg, {
      conversationId,
      receipt,
      message: 'history after retention',
    });
    assert.equal(prep.ok, true, prep.reason ?? undefined);
    assert.deepEqual(jsonValue(prep.history_rows ?? []), []);
    assert.deepEqual(
      {
        totalTurns: historyMeta(prep).totalTurnCount,
        includedTurns: historyMeta(prep).includedTurnCount,
        totalBytes: historyMeta(prep).totalUtf8Bytes,
      },
      { totalTurns: 0, includedTurns: 0, totalBytes: 0 },
    );
  });

  test('parent conversation cascade removes its replay counter regardless of FK trigger order', async () => {
    const receipt = await resolveReceipt(pg, { accountId: ACCOUNT_MARIA, organizationId: ORG_A });
    const conversationId = await createPortfolioConversation(pg, receipt, 'cascade counter');
    const committed = await commitPortfolioTurn(pg, {
      conversationId,
      receipt,
      question: 'cascade question',
      answer: 'Cascade answer.',
    });
    assert.equal(committed.ok, true, committed.reason);

    await pg.query(
      'alter table public.agent_conversations disable trigger agent_conversations_refuse_portfolio_delete',
    );
    try {
      await pg.query('delete from public.agent_conversations where id = $1', [conversationId]);
    } finally {
      await pg.query(
        'alter table public.agent_conversations enable trigger agent_conversations_refuse_portfolio_delete',
      );
    }
    const remaining = await pg.query<{ conversations: number; commits: number; counters: number }>(
      `select
         (select count(*)::int from public.agent_conversations where id = $1) as conversations,
         (select count(*)::int from public.portfolio_query_turn_commits where conversation_id = $1) as commits,
         (select count(*)::int from public.portfolio_conversation_replay_counters where conversation_id = $1) as counters`,
      [conversationId],
    );
    assert.deepEqual(remaining.rows[0], { conversations: 0, commits: 0, counters: 0 });
  });

  test('wrong owner/company and a changed authorization universe never replay or append', async () => {
    const originalReceipt = await resolveReceipt(pg, {
      accountId: ACCOUNT_MARIA,
      organizationId: ORG_A,
    });
    const conversationId = await createPortfolioConversation(pg, originalReceipt, 'baseline');
    const baseline = await commitPortfolioTurn(pg, {
      conversationId,
      receipt: originalReceipt,
      question: 'baseline',
      answer: 'Baseline answer.',
    });
    assert.equal(baseline.ok, true, baseline.reason);

    const wrongOwner = await portfolioPrep(pg, {
      conversationId,
      accountId: ACCOUNT_VERA,
      receipt: originalReceipt,
      message: 'cross-owner probe',
    });
    assert.deepEqual(
      { ok: wrongOwner.ok, reason: wrongOwner.reason },
      { ok: false, reason: 'wrong_owner' },
    );

    const wrongCompany = await portfolioPrep(pg, {
      conversationId,
      organizationId: ORG_B,
      receipt: originalReceipt,
      message: 'cross-company probe',
    });
    assert.deepEqual(
      { ok: wrongCompany.ok, reason: wrongCompany.reason },
      { ok: false, reason: 'wrong_organization' },
    );

    // Company topology changes while Maria remains authorized. A fresh
    // receipt has a new selector-independent universe hash, so the old thread
    // must reset even though a selected-grain change above did not.
    await seed.attachPropertyToOrganization(pg, ORG_A, PID_A3, 'Port Arthur Hotel');
    const changedReceipt = await resolveReceipt(pg, {
      accountId: ACCOUNT_MARIA,
      organizationId: ORG_A,
    });
    assert.notEqual(changedReceipt.authorizationHash, originalReceipt.authorizationHash);
    const changed = await portfolioPrep(pg, {
      conversationId,
      receipt: changedReceipt,
      message: 'try stale history',
    });
    assert.deepEqual(
      { ok: changed.ok, reason: changed.reason },
      { ok: false, reason: 'scope_changed' },
    );

    const count = await pg.query<{ count: number }>(
      `select count(*)::int as count from public.agent_messages where conversation_id = $1`,
      [conversationId],
    );
    assert.equal(count.rows[0].count, 2, 'a rejected scope change appended a user turn');
  });

  test('question mismatch commits nothing and the exact retry is idempotent', async () => {
    const receipt = await resolveReceipt(pg, { accountId: ACCOUNT_MARIA, organizationId: ORG_A });
    const conversationId = await createPortfolioConversation(pg, receipt, 'expected question');
    const complete = await commitPortfolioTurn(pg, {
      conversationId,
      receipt,
      question: 'expected question',
      answer: 'Receipted answer.',
    });
    assert.equal(complete.ok, true, complete.reason);

    const mismatch = await pg.query<{ result: unknown }>(
      `select public.staxis_commit_portfolio_conversation_turn(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::uuid,
         'tampered question', 'Receipted answer.', 10, 5, 'sonnet',
         'test-model', 0.001, 'portfolio-prompt-v1'
       ) as result`,
      [
        conversationId, ACCOUNT_MARIA, ORG_A, receipt.authorizationHash,
        receipt.id, complete.queryReceiptId,
      ],
    );
    assert.deepEqual(jsonValue(mismatch.rows[0].result), {
      ok: false,
      reason: 'question_mismatch',
    });
    const retry = await pg.query<{ result: unknown }>(
      `select public.staxis_commit_portfolio_conversation_turn(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::uuid,
         'expected question', 'Receipted answer.', 10, 5, 'sonnet',
         'test-model', 0.001, 'portfolio-prompt-v1'
       ) as result`,
      [
        conversationId, ACCOUNT_MARIA, ORG_A, receipt.authorizationHash,
        receipt.id, complete.queryReceiptId,
      ],
    );
    const retryPayload = jsonValue<{ ok: boolean; reason: string }>(retry.rows[0].result);
    assert.deepEqual(
      { ok: retryPayload.ok, reason: retryPayload.reason },
      { ok: true, reason: 'already_committed' },
    );
    const counts = await pg.query<{ messages: number; commits: number }>(
      `select
         (select count(*)::int from public.agent_messages where conversation_id = $1) as messages,
         (select count(*)::int from public.portfolio_query_turn_commits where conversation_id = $1) as commits`,
      [conversationId],
    );
    assert.deepEqual(counts.rows[0], { messages: 2, commits: 1 });
  });

  test('legacy stamps stay unbound and portfolio archive/restore fails closed without provenance loss', async () => {
    const receipt = await resolveReceipt(pg, { accountId: ACCOUNT_MARIA, organizationId: ORG_A });
    const legacy = await pg.query<{
      id: string;
      conversation_kind: string;
      organization_id: string;
      authorization_hash: string | null;
    }>(
      `insert into public.agent_conversations
         (user_id, property_id, role, prompt_version)
       values ($1, $2, 'general_manager', $3)
       returning id, conversation_kind, organization_id, authorization_hash`,
      [ACCOUNT_MARIA, PID_A1, `portfolio-prompt-v0+org:${ORG_A}`],
    );
    assert.deepEqual(
      {
        kind: legacy.rows[0].conversation_kind,
        organizationId: legacy.rows[0].organization_id,
        authorizationHash: legacy.rows[0].authorization_hash,
      },
      { kind: 'portfolio', organizationId: ORG_A, authorizationHash: null },
    );
    const legacyPrep = await portfolioPrep(pg, {
      conversationId: legacy.rows[0].id,
      receipt,
      message: 'unsafe legacy replay',
    });
    assert.deepEqual(
      { ok: legacyPrep.ok, reason: legacyPrep.reason },
      { ok: false, reason: 'scope_changed' },
    );

    const conversationId = await createPortfolioConversation(pg, receipt, 'archive me');
    const committed = await commitPortfolioTurn(pg, {
      conversationId,
      receipt,
      question: 'archive me',
      answer: 'This turn can be archived.',
    });
    assert.equal(committed.ok, true, committed.reason);
    await pg.query(
      `update public.agent_conversations
          set updated_at = now() - interval '2 days'
        where id = $1`,
      [conversationId],
    );
    const archived = await pg.query<{ moved: number }>(
      `select public.staxis_archive_conversation($1::uuid, 1) as moved`,
      [conversationId],
    );
    assert.equal(archived.rows[0].moved, -1);
    const preserved = await pg.query<{
      conversations: number;
      messages: number;
      commits: number;
      receipts: number;
      artifacts: number;
      archived_conversations: number;
    }>(
      `select
         (select count(*)::int from public.agent_conversations where id = $1) as conversations,
         (select count(*)::int from public.agent_messages where conversation_id = $1) as messages,
         (select count(*)::int from public.portfolio_query_turn_commits where conversation_id = $1) as commits,
         (select count(*)::int from public.portfolio_query_receipts where conversation_id = $1) as receipts,
         (select count(*)::int from public.portfolio_model_request_artifacts where conversation_id = $1) as artifacts,
         (select count(*)::int from public.agent_conversations_archived where id = $1) as archived_conversations`,
      [conversationId],
    );
    assert.deepEqual(preserved.rows[0], {
      conversations: 1,
      messages: 2,
      commits: 1,
      receipts: 1,
      artifacts: 1,
      archived_conversations: 0,
    });

    const legacyArchivedId = 'f1000000-0000-4000-8000-000000000001';
    await pg.query(
      `insert into public.agent_conversations_archived (
         id, user_id, property_id, title, role, prompt_version, created_at, updated_at,
         message_count, unsummarized_message_count, last_summarized_at,
         conversation_kind, organization_id, authorization_hash,
         scope_receipt_id, scope_verified_at
       )
       select $2::uuid, user_id, property_id, 'legacy archived portfolio', role,
              prompt_version, created_at, updated_at, 1, 1, last_summarized_at,
              conversation_kind, organization_id, authorization_hash,
              scope_receipt_id, scope_verified_at
         from public.agent_conversations where id = $1`,
      [conversationId, legacyArchivedId],
    );
    await pg.query(
      `insert into public.agent_messages_archived (conversation_id, role, content)
       values ($1, 'user', 'legacy unreceipted archived text')`,
      [legacyArchivedId],
    );
    const refusedRestore = await pg.query<{ moved: number }>(
      `select public.staxis_restore_conversation($1::uuid) as moved`,
      [legacyArchivedId],
    );
    assert.equal(refusedRestore.rows[0].moved, -1);
    const legacyStayedArchived = await pg.query<{
      live: number;
      archived: number;
      archived_messages: number;
    }>(
      `select
         (select count(*)::int from public.agent_conversations where id = $1) as live,
         (select count(*)::int from public.agent_conversations_archived where id = $1) as archived,
         (select count(*)::int from public.agent_messages_archived where conversation_id = $1) as archived_messages`,
      [legacyArchivedId],
    );
    assert.deepEqual(legacyStayedArchived.rows[0], {
      live: 0,
      archived: 1,
      archived_messages: 1,
    });

    const property = await pg.query<{ id: string }>(
      `insert into public.agent_conversations
         (user_id, property_id, role, prompt_version, conversation_kind, updated_at)
       values ($1, $2, 'general_manager', 'property-prompt-v1', 'property',
               now() - interval '2 days')
       returning id`,
      [ACCOUNT_MARIA, PID_A1],
    );
    await pg.query(
      `insert into public.agent_messages (conversation_id, role, content)
       values ($1, 'user', 'property history remains archivable')`,
      [property.rows[0].id],
    );
    // The message-count trigger touches updated_at; age it after insertion.
    await pg.query(
      `update public.agent_conversations set updated_at = now() - interval '2 days' where id = $1`,
      [property.rows[0].id],
    );
    const propertyArchived = await pg.query<{ moved: number }>(
      `select public.staxis_archive_conversation($1::uuid, 1) as moved`,
      [property.rows[0].id],
    );
    assert.equal(propertyArchived.rows[0].moved, 1);
    const propertyRestored = await pg.query<{ moved: number }>(
      `select public.staxis_restore_conversation($1::uuid) as moved`,
      [property.rows[0].id],
    );
    assert.equal(propertyRestored.rows[0].moved, 1);
  });

  test('direct browser history is denied and only fresh-authorized property rows can be deleted', async () => {
    const receipt = await resolveReceipt(pg, {
      accountId: ACCOUNT_MARIA,
      organizationId: ORG_A,
    });
    const portfolioId = await createPortfolioConversation(pg, receipt, 'preserve this replay root');

    await assert.rejects(
      pg.query(`delete from public.agent_conversations where id=$1`, [portfolioId]),
      /receipt-preserving lifecycle/i,
    );
    const portfolioStillExists = await pg.query<{ count: number }>(
      `select count(*)::int as count from public.agent_conversations where id=$1`,
      [portfolioId],
    );
    assert.equal(portfolioStillExists.rows[0].count, 1);

    // Prove the deny-all policies remain a second wall even if a future hosted
    // grant accidentally reopens table SELECT.
    await pg.exec(
      `grant select on public.agent_conversations, public.agent_messages to authenticated`,
    );
    await pg.exec('begin');
    try {
      await pg.exec('set local role authenticated');
      await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [UID_MARIA]);
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
      await pg.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
        sub: UID_MARIA,
        role: 'authenticated',
        mfa_verified: true,
      })]);
      const conversations = await pg.query(
        `select id from public.agent_conversations where id=$1`,
        [portfolioId],
      );
      const messages = await pg.query(
        `select id from public.agent_messages where conversation_id=$1`,
        [portfolioId],
      );
      assert.equal(conversations.rows.length, 0);
      assert.equal(messages.rows.length, 0);
      await pg.exec('commit');
    } catch (error) {
      await pg.exec('rollback').catch(() => undefined);
      throw error;
    }

    const property = await pg.query<{ id: string }>(
      `insert into public.agent_conversations
         (user_id, property_id, role, prompt_version, conversation_kind)
       values ($1,$2,'general_manager','property-prompt-v1','property')
       returning id`,
      [ACCOUNT_MARIA, PID_A1],
    );
    const deleted = await pg.query<{ deleted: boolean }>(
      `select public.staxis_delete_property_conversation($1,$2,$3) as deleted`,
      [property.rows[0].id, ACCOUNT_MARIA, PID_A1],
    );
    assert.equal(deleted.rows[0].deleted, true);

    const revoked = await pg.query<{ id: string }>(
      `insert into public.agent_conversations
         (user_id, property_id, role, prompt_version, conversation_kind)
       values ($1,$2,'general_manager','property-prompt-v1','property')
       returning id`,
      [ACCOUNT_MARIA, PID_A1],
    );
    await pg.query(`update public.accounts set active=false where id=$1`, [ACCOUNT_MARIA]);
    const refused = await pg.query<{ deleted: boolean }>(
      `select public.staxis_delete_property_conversation($1,$2,$3) as deleted`,
      [revoked.rows[0].id, ACCOUNT_MARIA, PID_A1],
    );
    assert.equal(refused.rows[0].deleted, false);
    await pg.query(`update public.accounts set active=true where id=$1`, [ACCOUNT_MARIA]);
  });
});
