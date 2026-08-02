import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const hook = source('src/components/agent/useAgentChat.ts');
const commandCenter = source('src/app/property-selector/CommandCenter.tsx');

describe('shared portfolio chat lifecycle contract', () => {
  test('uses the shared hook and carries the server conversation id on follow-ups', () => {
    assert.match(commandCenter, /useAgentChat\(\{\s*mode: 'portfolio',\s*organizationId,/);
    assert.match(
      hook,
      /mode === 'portfolio' \? '\/api\/agent\/portfolio' : '\/api\/agent\/command'/,
    );
    assert.match(
      hook,
      /conversationIdForScope\(\s*conversationCursorRef\.current,\s*requestScopeKey,\s*\)/g,
    );
    assert.match(hook, /organizationId,\s*message,/);
    assert.match(hook, /conversationCursorRef\.current = nextCursor;\s*setConversationId/);
  });

  test('masks and destroys the old thread when mode, hotel, or company changes', () => {
    assert.match(
      hook,
      /return mode === 'portfolio'\s*\? `portfolio:\$\{organizationId \?\? 'none'\}`\s*: `property:\$\{propertyId \?\? 'none'\}`/,
    );
    assert.match(hook, /const visibleScopeMatches = stateScopeKey === scopeKey/);
    assert.match(hook, /messages: visibleScopeMatches \? messages : \[\]/);
    assert.match(hook, /conversationId: visibleScopeMatches \? conversationId : null/);

    const resetStart = hook.indexOf('const resetVisibleConversation');
    const resetEnd = hook.indexOf('useEffect(() => {', resetStart);
    const reset = hook.slice(resetStart, resetEnd);
    assert.match(reset, /generationRef\.current \+= 1/);
    assert.match(reset, /activeRequestRef\.current\?\.cancel\(\)/);
    assert.match(reset, /conversationId: null/);
    assert.match(reset, /setConversations\(\[\]\)/);
    assert.match(reset, /setMessages\(\[\]\)/);
    assert.match(reset, /setScopeDisclosures\(\[\]\)/);
    assert.match(reset, /setPendingActions\(\[\]\)/);
    assert.match(reset, /setActionErrors\(\{\}\)/);
    assert.match(hook, /if \(stateScopeKey === scopeKey\) return;\s*resetVisibleConversation\(scopeKey\)/);
    assert.match(commandCenter, /setQuestion\(''\);\s*\}, \[organizationId\]\)/);
  });

  test('routes portfolio list/detail only through dedicated receipt-asserting endpoints', () => {
    assert.match(
      hook,
      /`\/api\/agent\/portfolio\/conversations\?organizationId=\$\{encodeURIComponent\(organizationId!\)\}`/,
    );
    assert.match(
      hook,
      /`\/api\/agent\/portfolio\/conversations\/\$\{id\}\?organizationId=\$\{encodeURIComponent\(organizationId!\)\}`/,
    );
    assert.match(hook, /mode === 'portfolio'[\s\S]*?: '\/api\/agent\/conversations'/);
    assert.match(hook, /mode === 'portfolio'[\s\S]*?: `\/api\/agent\/conversations\/\$\{id\}`/);
    assert.doesNotMatch(hook, /fetchWithAuth\(`\/api\/agent\/conversations\/\$\{id\}`\)/);
    assert.match(hook, /c\.conversationKind !== 'portfolio' \|\| c\.organizationId !== organizationId/);
    assert.match(hook, /list\.length !== rawList\.length/);
  });

  test('restores receipted scopes and advances the next turn without crossing companies', () => {
    assert.match(hook, /convo\.conversationKind !== 'portfolio'/);
    assert.match(hook, /convo\.organizationId !== organizationId/);
    assert.match(hook, /parsePortfolioScopeDisclosures\(/);
    assert.match(hook, /portfolioTurnRef\.current = userTurnCount/);
    assert.match(hook, /conversationCursorRef\.current = \{ scopeKey, conversationId: null \}/);
    assert.match(hook, /setMessages\(\[\]\);\s*setScopeDisclosures\(\[\]\);\s*setConversationId\(null\)/);
    assert.match(hook, /convo\.messages\.length % 2 !== 0/);
    assert.match(hook, /index % 2 === 0 \? message\.role !== 'user' : message\.role !== 'assistant'/);
    assert.match(hook, /mode === 'portfolio' && rawPendingUnknown\.length !== 0/);
  });
});

describe('visible active-scope disclosure contract', () => {
  test('validates scope identity and exact coverage before showing answer text', () => {
    assert.match(hook, /selectedHotelCount > authorizedHotelCount/);
    assert.match(hook, /total !== selectedHotelCount/);
    assert.match(hook, /reported \+ omitted !== total/);
    assert.match(hook, /parsed\.organizationId !== expectedOrganizationId/);
    assert.match(hook, /const isPortfolio = portfolioTurn !== null/);
    assert.match(hook, /let portfolioScopeVerified = !isPortfolio/);
    assert.match(
      hook,
      /payload\.type === 'text_delta'[\s\S]*?if \(!portfolioScopeVerified\)[\s\S]*?could not verify the scope used for that answer/,
    );
  });

  test('preserves one disclosure per turn across portfolio → hotel → portfolio grain changes', () => {
    assert.match(hook, /portfolioTurnRef\.current\+\+/);
    assert.match(hook, /prev\.filter\(item => item\.turn !== portfolioTurn\)/);
    assert.match(hook, /\{ turn: portfolioTurn, scope: parsed \}/);
    assert.match(commandCenter, /new Map\(disclosures\.map\(item => \[item\.turn, item\.scope\]\)\)/);
    assert.match(commandCenter, /scopeByTurn\.get\(index\) \?\? turn\.scope/);
  });

  test('renders the company, selector, authorization count, and partial coverage for every answer', () => {
    assert.match(commandCenter, /scope\.organizationName/);
    assert.match(commandCenter, /`Scope: \$\{chosenScope\}`/);
    assert.match(
      commandCenter,
      /`\$\{scope\.selectedHotelCount\} of \$\{scope\.authorizedHotelCount\} authorized hotels`/,
    );
    assert.match(
      commandCenter,
      /`\$\{scope\.coverage\.reported\} of \$\{scope\.coverage\.total\} reported`/,
    );
    assert.match(commandCenter, /`\$\{scope\.coverage\.omitted\} omitted`/);
    assert.match(commandCenter, /data-active-scope="true"/);
    assert.match(commandCenter, /formatPortfolioScopeDisclosure\(turn\.scope, lang\)/);
    assert.match(commandCenter, /<AssistantMarkdown text=\{turn\.assistant\} \/>/);
    assert.match(commandCenter, /role="log"/);
    assert.match(commandCenter, /aria-busy=\{streaming \|\| loadingConversations \|\| loadingConversation\}/);
  });

  test('offers one accessible saved-chat selector with honest loading and empty states', () => {
    assert.match(commandCenter, /className="cc-ask-history-select"/);
    assert.match(commandCenter, /htmlFor=\{historySelectId\}/);
    assert.match(commandCenter, /value=\{conversationId \?\? ''\}/);
    assert.match(commandCenter, /void loadConversation\(nextId\)/);
    assert.match(commandCenter, /loadingConversations/);
    assert.match(commandCenter, /loadingConversation/);
    assert.match(commandCenter, /conversationsLoaded && conversations\.length === 0/);
    assert.match(commandCenter, /role="status" aria-live="polite"/);
    assert.doesNotMatch(commandCenter, /portfolio-chat-history-page|PortfolioHistoryPage/);
  });
});
