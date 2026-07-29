import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  conversationSecurityScopeFromRow,
  orgScopeFromStamp,
} from '@/lib/agent/portfolio/conversation';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HASH = 'a'.repeat(64);
const RECEIPT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0377_agent_portfolio_conversation_scope.sql'),
  'utf8',
);
const atomicTurnMigration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0397_portfolio_model_request_artifacts.sql'),
  'utf8',
);
const archiveBoundaryMigration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0399_portfolio_conversation_archive_boundary.sql'),
  'utf8',
);
const archivalService = readFileSync(
  join(process.cwd(), 'src', 'lib', 'agent', 'archival.ts'),
  'utf8',
);
const commandRoute = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'agent', 'command', 'route.ts'),
  'utf8',
);
const conversationListRoute = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'agent', 'conversations', 'route.ts'),
  'utf8',
);
const conversationDetailRoute = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'agent', 'conversations', '[id]', 'route.ts'),
  'utf8',
);
const memoryService = readFileSync(
  join(process.cwd(), 'src', 'lib', 'agent', 'memory.ts'),
  'utf8',
);

describe('first-class agent conversation security scope', () => {
  test('explicit columns outrank a conflicting legacy prompt stamp', () => {
    assert.deepEqual(
      conversationSecurityScopeFromRow({
        conversation_kind: 'property',
        organization_id: null,
        authorization_hash: null,
        scope_receipt_id: null,
        scope_verified_at: null,
        prompt_version: `hotel-v1+org:${ORG_B}`,
      }),
      {
        conversationKind: 'property',
        organizationId: null,
        authorizationHash: null,
        scopeReceiptId: null,
        scopeVerifiedAt: null,
        legacyPromptStamp: false,
      },
    );

    const explicit = conversationSecurityScopeFromRow({
      conversation_kind: 'portfolio',
      organization_id: ORG_A,
      authorization_hash: HASH,
      scope_receipt_id: RECEIPT,
      scope_verified_at: '2030-01-01T00:00:00.000Z',
      prompt_version: `portfolio-v1+org:${ORG_B}`,
    });
    assert.equal(explicit?.conversationKind, 'portfolio');
    assert.equal(explicit?.organizationId, ORG_A);
    assert.equal(explicit?.authorizationHash, HASH);
    assert.equal(explicit?.legacyPromptStamp, false);
  });

  test('legacy parsing exists only when explicit columns are absent', () => {
    assert.equal(orgScopeFromStamp(`portfolio-v0+org:${ORG_A}`), ORG_A);
    assert.deepEqual(
      conversationSecurityScopeFromRow({ prompt_version: `portfolio-v0+org:${ORG_A}` }),
      {
        conversationKind: 'portfolio',
        organizationId: ORG_A,
        authorizationHash: null,
        scopeReceiptId: null,
        scopeVerifiedAt: null,
        legacyPromptStamp: true,
      },
    );
    assert.equal(
      conversationSecurityScopeFromRow({
        conversation_kind: 'portfolio',
        organization_id: null,
        prompt_version: `portfolio-v0+org:${ORG_A}`,
      }),
      null,
      'corrupt explicit metadata must not be repaired from prompt text',
    );
  });

  test('final migration checks owner, mode, company and authorizationHash before committed history', () => {
    const portfolioPrep = atomicTurnMigration.slice(
      atomicTurnMigration.indexOf('create or replace function public.staxis_lock_load_and_record_portfolio_user_turn'),
      atomicTurnMigration.indexOf('create or replace function public.staxis_commit_portfolio_conversation_turn'),
    );
    const owner = portfolioPrep.indexOf("v_convo.user_id <> p_user_account_id");
    const kind = portfolioPrep.indexOf("v_convo.conversation_kind <> 'portfolio'");
    const organization = portfolioPrep.indexOf('v_convo.organization_id <> p_organization_id');
    const assertion = portfolioPrep.indexOf('staxis_assert_authorization_scope_receipt');
    const hash = portfolioPrep.indexOf('v_convo.authorization_hash <> v_current_hash');
    const candidateTurns = portfolioPrep.indexOf('with candidate_commits as materialized');
    const candidateLimit = portfolioPrep.indexOf('limit 24', candidateTurns);
    const completeTurns = portfolioPrep.indexOf('complete_turns as materialized');
    const rankedTurns = portfolioPrep.indexOf('ranked_turns as materialized');
    const selectedTurns = portfolioPrep.indexOf('selected_turns as materialized');
    const history = portfolioPrep.indexOf('jsonb_agg(');
    assert.ok(owner >= 0 && owner < kind);
    assert.ok(kind < organization && organization < assertion);
    assert.ok(assertion < hash && hash < candidateTurns);
    assert.ok(candidateTurns < candidateLimit && candidateLimit < completeTurns);
    assert.ok(completeTurns < rankedTurns && rankedTurns < selectedTurns && selectedTurns < history);
    assert.match(portfolioPrep, /v_receipt->'authorizedPropertyIds'/);
    assert.doesNotMatch(
      portfolioPrep.slice(hash, history),
      /scopeHash|selectedPropertyIds|->'propertyIds'/,
      'selected grain must not become durable conversation identity',
    );
    assert.match(portfolioPrep, /'scope_changed'/);
    assert.match(portfolioPrep, /portfolio_query_turn_commits/);
    assert.match(portfolioPrep, /portfolio_conversation_replay_counters/);
    assert.match(
      portfolioPrep,
      /row_number\(\) over \(\s*order by committed_at desc, query_receipt_id desc/,
    );
    assert.match(portfolioPrep, /sum\(replay_utf8_bytes\) over/);
    assert.match(portfolioPrep, /newest_rank <= 24/);
    assert.match(portfolioPrep, /cumulative_replay_utf8_bytes <= 65536/);
    assert.match(portfolioPrep, /'version', 'portfolio-history-window\.v1'/);
    assert.match(portfolioPrep, /'omittedTurnCount'/);
    assert.match(portfolioPrep, /'omittedUtf8Bytes'/);
    assert.equal(
      (portfolioPrep.match(/from public\.portfolio_query_turn_commits/g) ?? []).length,
      1,
      'prep must touch the commit table only through the newest bounded candidate CTE',
    );
    assert.doesNotMatch(portfolioPrep, /insert into public\.agent_messages/);

    const commit = atomicTurnMigration.slice(
      atomicTurnMigration.indexOf('create or replace function public.staxis_commit_portfolio_conversation_turn'),
      atomicTurnMigration.indexOf('revoke execute on function public.staxis_create_portfolio_conversation'),
    );
    const questionHash = commit.indexOf("v_receipt.question_hash <> v_question_hash");
    const answerHash = commit.indexOf("v_receipt.answer_hash <> v_answer_hash");
    const userInsert = commit.indexOf("values (p_conversation_id, 'user', p_user_message)");
    const assistantInsert = commit.indexOf('p_model, p_model_id, p_cost_usd, p_prompt_version');
    const linkInsert = commit.indexOf('insert into public.portfolio_query_turn_commits');
    assert.ok(questionHash >= 0 && questionHash < answerHash);
    assert.ok(answerHash < userInsert && userInsert < assistantInsert && assistantInsert < linkInsert);
    assert.match(commit, /char_length\(p_user_message\) > 4000/);
    assert.match(commit, /octet_length\(convert_to\(p_user_message, 'UTF8'\)\) > 16000/);
    assert.match(commit, /octet_length\(convert_to\(p_assistant_text, 'UTF8'\)\) > 49000/);
    assert.match(memoryService, /decodePortfolioHistoryWindow\(\{/);
    assert.ok(
      memoryService.indexOf('decodePortfolioHistoryWindow({')
        < memoryService.indexOf('history: decoded.history'),
      'TypeScript must revalidate the SQL window before returning provider history',
    );

    assert.match(
      atomicTurnMigration,
      /create table public\.portfolio_conversation_replay_counters[\s\S]*revoke all on public\.portfolio_conversation_replay_counters[\s\S]*service_role/,
    );
    assert.match(
      atomicTurnMigration,
      /create trigger portfolio_query_turn_commits_bind_replay_counter\s+before insert or delete/,
    );
  });

  test('property APIs filter mode before pending cleanup, replay and history listing', () => {
    const preflight = commandRoute.indexOf("storedScope.conversationKind !== 'property'");
    const pendingSweep = commandRoute.indexOf('sweepSupersededPending(conversationId', preflight);
    const atomicPrep = commandRoute.indexOf('lockLoadAndRecordUserTurn({', preflight);
    assert.ok(preflight >= 0 && preflight < pendingSweep && pendingSweep < atomicPrep);
    assert.match(commandRoute, /prep\.reason === 'wrong_kind'/);
    assert.match(
      conversationListRoute,
      /listConversations\(\s*account\.id as string,\s*30,\s*'property',\s*authority\.all \? null : authority\.propertyIds,\s*\)/,
    );

    const propertyRpc = migration.slice(
      migration.indexOf('create or replace function public.staxis_lock_load_and_record_user_turn'),
      migration.indexOf('-- ── Portfolio create/prep'),
    );
    assert.ok(
      propertyRpc.indexOf("v_convo.conversation_kind <> 'property'")
        < propertyRpc.indexOf('jsonb_agg('),
    );
    assert.match(propertyRpc, /'wrong_kind'/);
  });

  test('legacy archive shape keeps explicit columns and 0399 refuses portfolio rows before writes', () => {
    for (const column of [
      'conversation_kind',
      'organization_id',
      'authorization_hash',
      'scope_receipt_id',
      'scope_verified_at',
    ]) {
      const occurrences = migration.match(new RegExp(`\\b${column}\\b`, 'g'))?.length ?? 0;
      assert.ok(occurrences >= 8, `${column} is missing from schema/backfill/archive/restore paths`);
    }
    assert.doesNotMatch(migration, /insert into public\.agent_conversations_archived\s+select \*/i);
    assert.doesNotMatch(migration, /insert into public\.agent_conversations\s+select \*/i);

    const archiveGuard = archiveBoundaryMigration.indexOf("v_conversation_kind = 'portfolio'");
    const archiveWrite = archiveBoundaryMigration.indexOf('insert into public.agent_messages_archived');
    const restoreFunction = archiveBoundaryMigration.indexOf(
      'create or replace function public.staxis_restore_conversation',
    );
    const restoreGuard = archiveBoundaryMigration.indexOf(
      "v_conversation_kind = 'portfolio'",
      restoreFunction,
    );
    const restoreWrite = archiveBoundaryMigration.indexOf(
      'insert into public.agent_conversations',
      restoreFunction,
    );
    assert.ok(archiveGuard >= 0 && archiveGuard < archiveWrite);
    assert.ok(restoreFunction >= 0 && restoreGuard < restoreWrite);
    assert.equal(
      archivalService.match(/\.eq\('conversation_kind', 'property'\)/g)?.length,
      2,
      'both the archive batch and backlog probe must exclude portfolio rows before LIMIT',
    );
  });

  test('ordinary browser history and deletion cannot bypass current scope or destroy portfolio replay', () => {
    assert.match(archiveBoundaryMigration, /drop policy if exists "agent_conversations_select_own"/);
    assert.match(archiveBoundaryMigration, /drop policy if exists "agent_messages_select_own"/);
    assert.match(archiveBoundaryMigration, /revoke select on public\.agent_conversations from anon, authenticated/);
    assert.match(archiveBoundaryMigration, /revoke select on public\.agent_messages from anon, authenticated/);
    assert.match(archiveBoundaryMigration, /agent_conversations_deny_browser_select[\s\S]*using \(false\)/);
    assert.match(archiveBoundaryMigration, /agent_messages_deny_browser_select[\s\S]*using \(false\)/);

    const deleteGuard = archiveBoundaryMigration.indexOf(
      'create or replace function public.staxis_refuse_portfolio_conversation_delete',
    );
    const deleteRpc = archiveBoundaryMigration.indexOf(
      'create or replace function public.staxis_delete_property_conversation',
    );
    assert.ok(deleteGuard >= 0 && deleteRpc > deleteGuard);
    assert.match(
      archiveBoundaryMigration.slice(deleteGuard, deleteRpc),
      /old\.conversation_kind = 'portfolio'[\s\S]*raise exception/,
    );
    const propertyDelete = archiveBoundaryMigration.slice(deleteRpc);
    assert.match(propertyDelete, /conversation\.conversation_kind = 'property'/);
    assert.match(propertyDelete, /account\.active is true/);
    assert.match(propertyDelete, /staxis_account_reaches_property\(v_data_user_id, p_property_id\)/);
    assert.match(propertyDelete, /for share of account, state/);

    const routeDelete = conversationDetailRoute.slice(
      conversationDetailRoute.indexOf('export async function DELETE'),
    );
    const activeAccount = routeDelete.indexOf('account.active !== true');
    const scope = routeDelete.indexOf('loadConversationScope(');
    const kind = routeDelete.indexOf("scope.conversationKind !== 'property'");
    const authority = routeDelete.indexOf('listAuthoritativePropertyAccess(');
    const commit = routeDelete.indexOf('deleteConversation(');
    assert.ok(activeAccount >= 0 && activeAccount < scope);
    assert.ok(scope < kind && kind < authority && authority < commit);
    assert.match(memoryService, /rpc\('staxis_delete_property_conversation'/);
    assert.doesNotMatch(memoryService, /\.from\('agent_conversations'\)[\s\S]{0,180}\.delete\(\)/);
  });
});
