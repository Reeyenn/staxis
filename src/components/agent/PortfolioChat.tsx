'use client';

import React from 'react';

import { AssistantMarkdown } from './AssistantMarkdown';
import {
  useAgentChat,
  type PortfolioActiveScope,
  type PortfolioScopeDisclosure,
} from './useAgentChat';
import type { DisplayMessage } from './MessageList';
import styles from '@/components/portfolio/PortfolioUI.module.css';

interface PortfolioChatProps {
  organizationId: string;
  organizationName: string;
  available: boolean;
  unavailableReason?: string | null;
}

interface PortfolioChatTurn {
  user: string;
  assistant: string;
  scope: PortfolioActiveScope | null;
}

function unavailableCopy(reason: string | null | undefined, organizationName: string): string {
  if (reason === 'company_setting_off') {
    return `Ask Staxis is turned off for ${organizationName}. A company owner can enable it in My Portfolio.`;
  }
  if (reason === 'no_hotels') {
    return `Ask Staxis will be available after ${organizationName} has an authorized hotel.`;
  }
  if (reason === 'settings_unavailable' || reason === 'invalid_company_setting') {
    return 'Ask Staxis could not verify the company setting just now. No hotel information was sent.';
  }
  return `Ask Staxis is not available for ${organizationName}.`;
}

function formatScopeDisclosure(scope: PortfolioActiveScope): string {
  const selectedScope = scope.hotelNames.length === 1
    ? scope.hotelNames[0]
    : scope.selectorLabel;
  return [
    scope.organizationName,
    `Scope: ${selectedScope}`,
    `${scope.selectedHotelCount} of ${scope.authorizedHotelCount} authorized hotels`,
    `${scope.coverage.reported} of ${scope.coverage.total} reported`,
    ...(scope.hotelNamesOmitted > 0
      ? [`${scope.hotelNames.length} names shown; ${scope.hotelNamesOmitted} more in scope`]
      : []),
    ...(scope.coverage.omitted > 0 ? [`${scope.coverage.omitted} omitted`] : []),
  ].join(' · ');
}

function buildTurns(
  messages: readonly DisplayMessage[],
  disclosures: readonly PortfolioScopeDisclosure[],
): PortfolioChatTurn[] {
  const scopeByTurn = new Map(disclosures.map((item) => [item.turn, item.scope]));
  const turns: PortfolioChatTurn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({
        user: message.text,
        assistant: '',
        scope: scopeByTurn.get(turns.length) ?? null,
      });
      continue;
    }
    if (message.role !== 'assistant' || message.toolName || !message.text || turns.length === 0) {
      continue;
    }
    const turn = turns[turns.length - 1];
    turn.assistant = turn.assistant ? `${turn.assistant}\n${message.text}` : message.text;
  }
  return turns.map((turn, index) => ({
    ...turn,
    scope: scopeByTurn.get(index) ?? turn.scope,
  }));
}

export function PortfolioChat({
  organizationId,
  organizationName,
  available,
  unavailableReason,
}: PortfolioChatProps) {
  const [question, setQuestion] = React.useState('');
  const threadRef = React.useRef<HTMLDivElement>(null);
  const historySelectId = React.useId();
  const {
    messages,
    conversations,
    conversationId,
    scopeDisclosures,
    loadingConversations,
    conversationsLoaded,
    loadingConversation,
    streaming,
    error,
    portfolioRetryMessage,
    sendMessage,
    startNew,
    loadConversation,
    reloadConversations,
  } = useAgentChat({
    mode: 'portfolio',
    organizationId,
    propertyId: null,
    active: available,
  });
  const turns = buildTurns(messages, scopeDisclosures);

  React.useEffect(() => {
    setQuestion('');
  }, [organizationId]);

  React.useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages, scopeDisclosures, streaming]);

  const send = React.useCallback(async () => {
    const text = question.trim();
    if (!text || streaming) return;
    setQuestion('');
    await sendMessage(text);
  }, [question, sendMessage, streaming]);

  const lastTurn = turns[turns.length - 1];
  const retryMessage = error && !streaming && portfolioRetryMessage
    ? portfolioRetryMessage
    : null;
  const retry = () => {
    if (retryMessage) {
      startNew();
      void sendMessage(retryMessage);
      return;
    }
    void reloadConversations();
  };

  if (!available) {
    return (
      <div className={styles.chatRoot}>
        <div className={styles.chatUnavailable} role="status">
          {unavailableCopy(unavailableReason, organizationName)}
        </div>
      </div>
    );
  }

  const busy = streaming || loadingConversations || loadingConversation;
  return (
    <div
      className={styles.chatRoot}
      aria-label={`Ask Staxis across ${organizationName}`}
      aria-busy={busy}
    >
      <div className={styles.chatHeader}>
        <span className={styles.chatSpark} aria-hidden="true">✦</span>
        <span className={styles.chatTitle}>Ask Staxis across your hotels</span>
        {turns.length > 0 && !streaming ? (
          <button type="button" className={styles.chatNew} onClick={startNew}>
            New chat
          </button>
        ) : null}
      </div>

      <div className={styles.chatHistory}>
        <label className={styles.chatHistoryLabel} htmlFor={historySelectId}>
          Saved portfolio chats
        </label>
        <select
          id={historySelectId}
          className={styles.chatHistorySelect}
          value={conversationId ?? ''}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value) void loadConversation(event.target.value);
            else startNew();
          }}
        >
          <option value="">Open a saved chat</option>
          {conversations.map((conversation) => (
            <option value={conversation.id} key={conversation.id}>
              {conversation.title?.trim() || 'Portfolio conversation'}
            </option>
          ))}
        </select>
      </div>

      {(loadingConversations || loadingConversation
        || (conversationsLoaded && conversations.length === 0)) ? (
        <div className={styles.chatHistoryStatus} role="status" aria-live="polite">
          {loadingConversation
            ? 'Restoring this chat and its scopes…'
            : loadingConversations
              ? 'Loading saved chats…'
              : 'No saved portfolio chats yet.'}
        </div>
      ) : null}

      {turns.length > 0 ? (
        <div
          ref={threadRef}
          className={styles.chatThread}
          role="log"
          aria-label="Portfolio conversation"
        >
          {turns.map((turn, index) => {
            const latest = index === turns.length - 1;
            return (
              <article className={styles.chatTurn} key={`${index}-${turn.user}`}>
                <div className={styles.chatUser}>{turn.user}</div>
                {turn.scope ? (
                  <div className={styles.chatScope} data-active-scope="true">
                    {formatScopeDisclosure(turn.scope)}
                  </div>
                ) : null}
                <div className={styles.chatAnswer}>
                  {turn.assistant
                    ? <AssistantMarkdown text={turn.assistant} />
                    : latest && streaming
                      ? <span role="status" aria-live="polite">Reading your hotels…</span>
                      : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {error ? (
        <div className={styles.chatError} role="alert">
          <span>{error}</span>
          <button type="button" onClick={retry}>Try again</button>
        </div>
      ) : null}

      <form
        className={styles.chatComposer}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <span className={styles.chatComposerSpark} aria-hidden="true">✦</span>
        <input
          className={styles.chatInput}
          value={question}
          maxLength={4000}
          aria-label={`Ask Staxis about ${organizationName}`}
          placeholder="Ask across your hotels…"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          disabled={busy}
        />
        <button
          type="submit"
          className={styles.chatSend}
          disabled={busy || question.trim().length === 0}
        >
          {streaming ? 'Reading…' : 'Ask'}
        </button>
      </form>
    </div>
  );
}
