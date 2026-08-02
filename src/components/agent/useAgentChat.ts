'use client';

// ─── useAgentChat — shared chat state hook ────────────────────────────────
// Pulls the streaming SSE logic out of the page/panel components so both
// surfaces (the /chat full page and the FloatingChatButton panel) share
// one well-tested implementation. Callers just render the messages array
// and call sendMessage().

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import type { DisplayMessage } from './MessageList';
import type { BiText, PendingAction, PendingAddon, ResultCard } from './approval-types';
import type { AskOrigin } from './ask-command-bridge';

export interface ConversationListItem {
  id: string;
  title: string | null;
  updatedAt: string;
}

export type AgentChatMode = 'property' | 'portfolio';

/**
 * The exact server-resolved scope used for one portfolio answer. This is
 * disclosure metadata only — authorization is re-evaluated by the server on
 * every turn and tool call. Never use this browser value to authorize a read.
 */
export interface PortfolioActiveScope {
  organizationId: string;
  organizationName: string;
  selectorLabel: string;
  selectedHotelCount: number;
  authorizedHotelCount: number;
  hotelNames: string[];
  hotelNamesOmitted: number;
  coverage: {
    reported: number;
    total: number;
    omitted: number;
  };
}

export interface PortfolioScopeDisclosure {
  /** Zero-based user-turn ordinal in the currently visible conversation. */
  turn: number;
  scope: PortfolioActiveScope;
}

export interface UseAgentChatOpts {
  /** Hotel chat is the compatibility default for all existing callers. */
  mode?: AgentChatMode;
  /** The user's active property. Required in property mode. */
  propertyId?: string | null;
  /** The management company. Required in portfolio mode. */
  organizationId?: string | null;
  /** Whether the chat is currently focused / visible (for refetching nudges, etc.). */
  active?: boolean;
  /**
   * The route the user is currently looking at, from `usePathname()`.
   *
   * Posted with each message so the copilot can say "the Inventory screen
   * you're on" instead of asking which screen. The server matches it against an
   * allowlist and prints its own constant — nothing typed here reaches a prompt
   * verbatim.
   */
  pathname?: string | null;
}

export interface UseAgentChatReturn {
  messages: DisplayMessage[];
  conversations: ConversationListItem[];
  conversationId: string | null;
  /** One immutable disclosure per portfolio turn, in turn order. */
  scopeDisclosures: PortfolioScopeDisclosure[];
  loadingConversations: boolean;
  conversationsLoaded: boolean;
  loadingConversation: boolean;
  streaming: boolean;
  error: string | null;
  /** The failed portfolio question retained only for the fresh retry action. */
  portfolioRetryMessage: string | null;
  /**
   * `opts.origin` marks which surface the turn came from. It travels only to
   * the request body, where it selects the AI Control Center slot that governs
   * the model and carries the cost. Absent means the Ask bar.
   */
  sendMessage: (text: string, opts?: { origin?: AskOrigin }) => Promise<void>;
  startNew: () => void;
  loadConversation: (id: string) => Promise<void>;
  reloadConversations: () => Promise<void>;
  /** Approval cards queued for the user's decision (one shown at a time). */
  pendingActions: PendingAction[];
  /** The result-confirmation card currently showing (auto-dismissed on success). */
  resultCard: ResultCard | null;
  /** Approve / deny a pending action. Consumes the resume SSE stream. */
  resolveAction: (
    pendingActionId: string,
    decision: 'approve' | 'deny',
    opts?: { adjustedArgs?: Record<string, unknown>; addons?: string[] },
  ) => Promise<void>;
  /** Dismiss the current result card (used by the failure card's close button). */
  dismissResultCard: () => void;
  /** Per-card inline validation errors (keyed by pendingActionId). Set when an
   *  Adjust edit fails server validation — the card stays up so the user can
   *  fix it. */
  actionErrors: Record<string, string>;
}

interface ServerMessage {
  role: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  result?: unknown;
}

interface ServerConversationDetail {
  id: string;
  title: string | null;
  conversationKind?: string;
  organizationId?: string | null;
  messages?: ServerMessage[];
  scopeDisclosures?: unknown;
}

/** A rehydrated pending card from the conversation-detail load path. Same shape
 *  as the tool_call_pending_approval SSE event (bilingual summary + addons). */
interface ServerPendingAction {
  pendingActionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  tier: 'quick' | 'card';
  summary?: BiText;
  addons?: { en: PendingAddon[]; es?: PendingAddon[] };
}

interface ServerConversationListItem {
  id: string;
  title: string | null;
  updatedAt: string;
  conversationKind?: string;
  organizationId?: string | null;
}

interface SsePayload {
  type: string;
  id?: string;
  delta?: string;
  finalText?: string;
  call?: { id: string; name: string; args: Record<string, unknown> };
  result?: unknown;
  isError?: boolean;
  message?: string;
  // ── approval-flow fields ──
  pendingActionId?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  tier?: 'quick' | 'card';
  summary?: BiText;
  addons?: { en: { id: string; label: string }[]; es?: { id: string; label: string }[] };
  // action_result
  ok?: boolean;
  denied?: boolean;
  resultSummary?: BiText;
  error?: { en: string | null; es?: string | null };
  addonNotes?: string[];
  addonErrors?: string[];
  // pending_actions_superseded
  pendingActionIds?: string[];
  // portfolio turn disclosure
  scope?: unknown;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The portfolio stream used to enforce these limits in PortfolioAsk. Keep
 * them here so the shared client retains the same terminal safety contract
 * without changing the property chat stream.
 */
export const PORTFOLIO_ASK_STREAM_INACTIVITY_MS = 30_000;
export const PORTFOLIO_ASK_ABSOLUTE_MS = 60_000;
export const PORTFOLIO_ASK_MAX_FRAME_CHARS = 128 * 1024;
export const PORTFOLIO_ASK_MAX_ANSWER_CHARS = 64 * 1024;

const PORTFOLIO_CHAT_FAILURE =
  'Staxis could not answer just now. Nothing about your hotels changed.';

interface PortfolioStreamLimits {
  inactivityMs: number;
  absoluteMs: number;
  maxFrameChars: number;
  maxAnswerChars: number;
}

const DEFAULT_PORTFOLIO_STREAM_LIMITS: Readonly<PortfolioStreamLimits> = {
  inactivityMs: PORTFOLIO_ASK_STREAM_INACTIVITY_MS,
  absoluteMs: PORTFOLIO_ASK_ABSOLUTE_MS,
  maxFrameChars: PORTFOLIO_ASK_MAX_FRAME_CHARS,
  maxAnswerChars: PORTFOLIO_ASK_MAX_ANSWER_CHARS,
};

let portfolioStreamLimits: Readonly<PortfolioStreamLimits> = DEFAULT_PORTFOLIO_STREAM_LIMITS;

/** Test-only deadline/size injection; production callers must use defaults. */
export function __setPortfolioStreamLimitsForTesting(
  overrides?: Partial<PortfolioStreamLimits>,
): void {
  if (!overrides) {
    portfolioStreamLimits = DEFAULT_PORTFOLIO_STREAM_LIMITS;
    return;
  }
  const next = { ...DEFAULT_PORTFOLIO_STREAM_LIMITS, ...overrides };
  if (Object.values(next).some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Portfolio stream test limits must be positive finite numbers.');
  }
  portfolioStreamLimits = next;
}

interface ActiveChatRequest {
  controller: AbortController;
  cancel: () => void;
}

interface PortfolioStreamGuard {
  resetInactivity: () => void;
  attachReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void;
  cancel: () => void;
  dispose: () => void;
  timedOut: () => boolean;
}

function createPortfolioStreamGuard(
  controller: AbortController,
  limits: Readonly<PortfolioStreamLimits>,
): PortfolioStreamGuard {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let timedOut = false;

  const cancelReader = () => {
    if (!reader) return;
    void reader.cancel().catch(() => undefined);
  };

  const clearTimers = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (absoluteTimer) clearTimeout(absoluteTimer);
    inactivityTimer = null;
    absoluteTimer = null;
  };

  const abortForTimeout = () => {
    if (disposed || timedOut) return;
    timedOut = true;
    controller.abort();
    cancelReader();
    clearTimers();
  };

  const resetInactivity = () => {
    if (disposed || timedOut) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(abortForTimeout, limits.inactivityMs);
  };

  absoluteTimer = setTimeout(abortForTimeout, limits.absoluteMs);
  resetInactivity();

  return {
    resetInactivity,
    attachReader: nextReader => {
      reader = nextReader;
      if (controller.signal.aborted) cancelReader();
    },
    cancel: () => {
      if (!controller.signal.aborted) controller.abort();
      cancelReader();
      clearTimers();
    },
    dispose: () => {
      disposed = true;
      clearTimers();
      reader = null;
    },
    timedOut: () => timedOut,
  };
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Strictly parse the browser-safe subset of an `active_scope` SSE event.
 * Returning null is fail-closed: the UI does not invent or partially render a
 * scope statement from malformed data.
 */
export function parsePortfolioActiveScope(value: unknown): PortfolioActiveScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const organizationId = typeof raw.organizationId === 'string' ? raw.organizationId : '';
  const organizationName = typeof raw.organizationName === 'string'
    ? raw.organizationName.trim()
    : '';
  const selectorLabel = typeof raw.selectorLabel === 'string'
    ? raw.selectorLabel.trim()
    : '';
  const selectedHotelCount = finiteCount(raw.selectedHotelCount);
  const authorizedHotelCount = finiteCount(raw.authorizedHotelCount);
  const hotelNamesOmitted = finiteCount(raw.hotelNamesOmitted);
  if (!UUID_RX.test(organizationId)
    || !organizationName
    || organizationName.length > 200
    || !selectorLabel
    || selectorLabel.length > 240
    || selectedHotelCount === null
    || authorizedHotelCount === null
    || hotelNamesOmitted === null
    || selectedHotelCount > authorizedHotelCount
  ) {
    return null;
  }

  if (!Array.isArray(raw.hotelNames) || raw.hotelNames.length > selectedHotelCount) return null;
  const hotelNames: string[] = [];
  for (const value of raw.hotelNames) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    if (!name || name.length > 200) return null;
    hotelNames.push(name);
  }
  if (hotelNames.length + hotelNamesOmitted !== selectedHotelCount) return null;

  const coverageRaw = raw.coverage;
  if (!coverageRaw || typeof coverageRaw !== 'object' || Array.isArray(coverageRaw)) return null;
  const coverage = coverageRaw as Record<string, unknown>;
  const reported = finiteCount(coverage.reported);
  const total = finiteCount(coverage.total);
  const omitted = finiteCount(coverage.omitted);
  if (reported === null
    || total === null
    || omitted === null
    || total !== selectedHotelCount
    || reported + omitted !== total
  ) {
    return null;
  }

  return {
    organizationId,
    organizationName,
    selectorLabel,
    selectedHotelCount,
    authorizedHotelCount,
    hotelNames,
    hotelNamesOmitted,
    coverage: { reported, total, omitted },
  };
}

/** Strictly validate receipt-backed disclosures returned by portfolio history. */
export function parsePortfolioScopeDisclosures(
  value: unknown,
  expectedOrganizationId: string,
  expectedTurnCount: number,
): PortfolioScopeDisclosure[] | null {
  if (!Array.isArray(value) || value.length !== expectedTurnCount) return null;
  const disclosures: PortfolioScopeDisclosure[] = [];
  const seen = new Set<number>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.turn !== 'number'
      || !Number.isSafeInteger(candidate.turn)
      || candidate.turn < 0
      || candidate.turn >= expectedTurnCount
      || seen.has(candidate.turn)) return null;
    const scope = parsePortfolioActiveScope(candidate.scope);
    if (!scope || scope.organizationId !== expectedOrganizationId) return null;
    seen.add(candidate.turn);
    disclosures.push({ turn: candidate.turn, scope });
  }
  disclosures.sort((left, right) => left.turn - right.turn);
  return disclosures.every((item, index) => item.turn === index) ? disclosures : null;
}

export function agentChatScopeKey({
  mode = 'property',
  propertyId = null,
  organizationId = null,
}: Pick<UseAgentChatOpts, 'mode' | 'propertyId' | 'organizationId'>): string {
  return mode === 'portfolio'
    ? `portfolio:${organizationId ?? 'none'}`
    : `property:${propertyId ?? 'none'}`;
}

export interface ScopedConversationCursor {
  scopeKey: string;
  conversationId: string | null;
}

/** Pure cursor transition used by the hook and lifecycle regression tests. */
export function scopeConversationCursor(
  cursor: ScopedConversationCursor,
  nextScopeKey: string,
): ScopedConversationCursor {
  return cursor.scopeKey === nextScopeKey
    ? cursor
    : { scopeKey: nextScopeKey, conversationId: null };
}

export function recordScopedConversationId(
  cursor: ScopedConversationCursor,
  requestScopeKey: string,
  conversationId: string,
): ScopedConversationCursor {
  if (cursor.scopeKey !== requestScopeKey || !UUID_RX.test(conversationId)) return cursor;
  return { ...cursor, conversationId };
}

export function conversationIdForScope(
  cursor: ScopedConversationCursor,
  requestScopeKey: string,
): string | null {
  return cursor.scopeKey === requestScopeKey ? cursor.conversationId : null;
}

export function useAgentChat({
  mode = 'property',
  propertyId = null,
  organizationId = null,
  active = true,
  pathname,
}: UseAgentChatOpts): UseAgentChatReturn {
  const { lang } = useLang();
  const scopeKey = agentChatScopeKey({ mode, propertyId, organizationId });
  // ── The current route, as a REF rather than a useCallback dependency ──
  //
  // `sendMessage` is memoized, and the Ask bar is mounted ONCE at the app shell
  // and survives every client-side navigation. So closing over `pathname`
  // directly would post whichever route the bar first rendered on — which on
  // this app is very often '/home', because that is where people land. Adding
  // it to the dependency array fixes the staleness but re-creates `sendMessage`
  // on every navigation, and that identity is subscribed to by the ask-command
  // bridge. A ref updated on render gives the fresh value with a stable
  // callback identity, which is what both callers need.
  const pathnameRef = useRef<string | null | undefined>(pathname);
  pathnameRef.current = pathname;
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [scopeDisclosures, setScopeDisclosures] = useState<PortfolioScopeDisclosure[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portfolioRetryMessage, setPortfolioRetryMessage] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [resultCard, setResultCard] = useState<ResultCard | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  // Mask old state synchronously when React renders a different hotel/company.
  // The effect below clears it after commit, but this key prevents even one
  // paint of company A's conversation under company B's heading.
  const [stateScopeKey, setStateScopeKey] = useState(scopeKey);

  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const generationRef = useRef(0);
  const activeRequestRef = useRef<ActiveChatRequest | null>(null);
  const conversationCursorRef = useRef<ScopedConversationCursor>({
    scopeKey,
    conversationId: null,
  });
  const portfolioTurnRef = useRef(0);
  const portfolioMessageRef = useRef<string | null>(null);

  // Language in a ref so the SSE closure resolves bilingual payloads with the
  // current language without re-creating sendMessage on every language change.
  const langRef = useRef(lang);
  langRef.current = lang;

  // Index of the assistant bubble we're appending text deltas into. -1 means
  // start a new bubble on the next delta. Kept in a ref so the streaming
  // closure doesn't capture stale state.
  const assistantIndexRef = useRef<number>(-1);

  // ── Streamed-text flush buffer (perf) ──────────────────────────────────
  // Naively calling setMessages per text_delta clones the whole messages array
  // on every token → O(n²) re-renders on a long reply. We buffer incoming
  // deltas in a ref and flush at most once per animation frame, so a burst of
  // tokens becomes ONE state update. flushDeltaBuffer must run before any other
  // event that reads/mutates messages, and once more at stream end.
  const deltaBufRef = useRef<string>('');
  const deltaOwnerGenerationRef = useRef<number>(-1);
  const rafRef = useRef<number | null>(null);

  const flushDeltaBuffer = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const chunk = deltaBufRef.current;
    if (!chunk) return;
    deltaBufRef.current = '';
    const ownerGeneration = deltaOwnerGenerationRef.current;
    deltaOwnerGenerationRef.current = -1;
    // A hotel/company switch or New Chat invalidates every queued token. This
    // guard closes the small window between aborting fetch and a scheduled
    // animation-frame flush.
    if (ownerGeneration !== generationRef.current) return;
    setMessages(prev => {
      const next = [...prev];
      if (assistantIndexRef.current >= 0 && next[assistantIndexRef.current]?.role === 'assistant') {
        next[assistantIndexRef.current] = {
          ...next[assistantIndexRef.current],
          text: next[assistantIndexRef.current].text + chunk,
        };
      } else {
        assistantIndexRef.current = next.length;
        next.push({ role: 'assistant', text: chunk });
      }
      return next;
    });
  }, []);

  const enqueueDelta = useCallback((delta: string, generation: number) => {
    if (generation !== generationRef.current) return;
    if (deltaOwnerGenerationRef.current !== -1
      && deltaOwnerGenerationRef.current !== generation
    ) {
      deltaBufRef.current = '';
    }
    deltaOwnerGenerationRef.current = generation;
    deltaBufRef.current += delta;
    if (rafRef.current === null && typeof requestAnimationFrame !== 'undefined') {
      rafRef.current = requestAnimationFrame(() => { rafRef.current = null; flushDeltaBuffer(); });
    } else if (typeof requestAnimationFrame === 'undefined') {
      // Non-browser (SSR / test) — flush synchronously.
      flushDeltaBuffer();
    }
  }, [flushDeltaBuffer]);

  const clearDeltaBuffer = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    deltaBufRef.current = '';
    deltaOwnerGenerationRef.current = -1;
  }, []);

  useEffect(() => () => clearDeltaBuffer(), [clearDeltaBuffer]);

  // Auto-dismiss timer for the success result card.
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearResultTimer = useCallback(() => {
    if (resultTimerRef.current) { clearTimeout(resultTimerRef.current); resultTimerRef.current = null; }
  }, []);
  const dismissResultCard = useCallback(() => {
    clearResultTimer();
    setResultCard(null);
  }, [clearResultTimer]);
  useEffect(() => () => clearResultTimer(), [clearResultTimer]);

  const pick = useCallback((b: BiText | undefined): string => {
    if (!b) return '';
    return b.en || b.es || '';
  }, []);

  const resetVisibleConversation = useCallback((nextScopeKey: string) => {
    generationRef.current += 1;
    activeRequestRef.current?.cancel();
    activeRequestRef.current = null;
    clearDeltaBuffer();
    clearResultTimer();
    portfolioMessageRef.current = null;
    conversationCursorRef.current = {
      ...scopeConversationCursor(conversationCursorRef.current, nextScopeKey),
      conversationId: null,
    };
    portfolioTurnRef.current = 0;
    assistantIndexRef.current = -1;
    setConversations([]);
    setConversationId(null);
    setMessages([]);
    setScopeDisclosures([]);
    setLoadingConversations(false);
    setConversationsLoaded(false);
    setLoadingConversation(false);
    setStreaming(false);
    setError(null);
    setPortfolioRetryMessage(null);
    setPendingActions([]);
    setResultCard(null);
    setActionErrors({});
    setStateScopeKey(nextScopeKey);
  }, [clearDeltaBuffer, clearResultTimer]);

  useEffect(() => {
    if (stateScopeKey === scopeKey) return;
    resetVisibleConversation(scopeKey);
  }, [scopeKey, stateScopeKey, resetVisibleConversation]);

  useEffect(() => {
    if (mode === 'portfolio' && !active) resetVisibleConversation(scopeKey);
  }, [active, mode, resetVisibleConversation, scopeKey]);

  useEffect(() => () => {
    generationRef.current += 1;
    activeRequestRef.current?.cancel();
  }, []);

  const reloadConversations = useCallback(async () => {
    if (mode === 'portfolio' && !organizationId) return;
    const generation = generationRef.current;
    if (scopeKeyRef.current === scopeKey) {
      setLoadingConversations(true);
      setConversationsLoaded(false);
      if (mode === 'portfolio') setConversations([]);
    }
    try {
      const endpoint = mode === 'portfolio'
        ? `/api/agent/portfolio/conversations?organizationId=${encodeURIComponent(organizationId!)}`
        : '/api/agent/conversations';
      const res = await fetchWithAuth(endpoint);
      if (generation !== generationRef.current || scopeKeyRef.current !== scopeKey) return;
      if (!res.ok) {
        if (mode === 'portfolio' && res.status === 409) {
          setConversations([]);
          setMessages([]);
          setScopeDisclosures([]);
          setConversationId(null);
          conversationCursorRef.current = { scopeKey, conversationId: null };
          portfolioTurnRef.current = 0;
          setError('Your hotel access changed. Start a new portfolio chat.');
        } else if (mode === 'portfolio') {
          setError('Saved portfolio chats could not be loaded.');
        }
        return;
      }
      const body = await res.json();
      if (generation !== generationRef.current || scopeKeyRef.current !== scopeKey) return;
      const rawList: unknown = body.data?.conversations;
      if (!Array.isArray(rawList)) {
        if (mode === 'portfolio') setError('Saved portfolio chats could not be verified.');
        return;
      }
      const list: ConversationListItem[] = rawList.flatMap((value): ConversationListItem[] => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const c = value as Partial<ServerConversationListItem>;
        if (typeof c.id !== 'string'
          || !UUID_RX.test(c.id)
          || !(c.title === null || typeof c.title === 'string')
          || typeof c.updatedAt !== 'string'
          || !Number.isFinite(Date.parse(c.updatedAt))
          || (mode === 'portfolio'
            && (c.conversationKind !== 'portfolio' || c.organizationId !== organizationId))) return [];
        return [{ id: c.id, title: c.title, updatedAt: c.updatedAt }];
      });
      if (mode === 'portfolio' && list.length !== rawList.length) {
        setError('Saved portfolio chats could not be verified.');
        return;
      }
      setConversations(list);
      setConversationsLoaded(true);
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress
      console.error('reloadConversations failed', e);
      if (mode === 'portfolio'
        && generation === generationRef.current
        && scopeKeyRef.current === scopeKey) {
        setError('Saved portfolio chats could not be loaded.');
      }
    } finally {
      if (generation === generationRef.current && scopeKeyRef.current === scopeKey) {
        setLoadingConversations(false);
      }
    }
  }, [mode, organizationId, scopeKey]);

  useEffect(() => {
    if (!active) return;
    void reloadConversations();
  }, [active, reloadConversations]);

  const loadConversation = useCallback(async (id: string) => {
    if (!UUID_RX.test(id) || (mode === 'portfolio' && !organizationId)) return;
    const generation = generationRef.current;
    setError(null);
    setPendingActions([]);
    setActionErrors({});
    dismissResultCard();
    setLoadingConversation(true);
    if (mode === 'portfolio') {
      // Hide the previous company conversation before awaiting. The endpoint
      // may return scope_changed/not-found and stale text must not remain under
      // the newly selected history title while that decision is made.
      setMessages([]);
      setScopeDisclosures([]);
      setConversationId(null);
      conversationCursorRef.current = { scopeKey, conversationId: null };
      portfolioTurnRef.current = 0;
    }
    try {
      const endpoint = mode === 'portfolio'
        ? `/api/agent/portfolio/conversations/${id}?organizationId=${encodeURIComponent(organizationId!)}`
        : `/api/agent/conversations/${id}`;
      const res = await fetchWithAuth(endpoint);
      if (generation !== generationRef.current || scopeKeyRef.current !== scopeKey) return;
      if (!res.ok) {
        setError(mode === 'portfolio'
          ? res.status === 409
            ? 'Your hotel access changed. Start a new portfolio chat.'
            : 'Saved portfolio chats could not be loaded.'
          : `Failed to load conversation: ${res.status}`);
        return;
      }
      const body = await res.json();
      if (generation !== generationRef.current || scopeKeyRef.current !== scopeKey) return;
      const convo: ServerConversationDetail | undefined = body.data?.conversation;
      if (!convo || typeof convo !== 'object' || Array.isArray(convo)) {
        if (mode === 'portfolio') setError('Failed to verify that portfolio conversation.');
        return;
      }

      if (mode === 'portfolio'
        && (convo.id !== id
          || convo.conversationKind !== 'portfolio'
          || convo.organizationId !== organizationId
          || !Array.isArray(convo.messages)
          || convo.messages.length % 2 !== 0
          || convo.messages.some((message, index) => (
            !message
            || typeof message !== 'object'
            || (index % 2 === 0 ? message.role !== 'user' : message.role !== 'assistant')
            || typeof message.content !== 'string'
            || !message.content.trim()
          )))) {
        setError('Failed to verify that portfolio conversation.');
        return;
      }

      const display: DisplayMessage[] = [];
      for (const m of convo.messages ?? []) {
        if (m.role === 'user') {
          display.push({ role: 'user', text: m.content ?? '' });
        } else if (m.role === 'assistant') {
          if (m.content) display.push({ role: 'assistant', text: m.content });
        } else if (m.role === 'tool') {
          display.push({ role: 'tool', text: '', toolResult: m.result });
        }
      }
      const userTurnCount = display.filter(message => message.role === 'user').length;
      const restoredDisclosures = mode === 'portfolio'
        ? parsePortfolioScopeDisclosures(
            convo.scopeDisclosures,
            organizationId!,
            userTurnCount,
          )
        : [];
      if (mode === 'portfolio' && !restoredDisclosures) {
        setError('Staxis could not verify the saved scope for that conversation.');
        return;
      }

      // Rehydrate approval cards still awaiting a decision. The DB pending rows
      // outlive React state — without this a reload / conversation switch loses
      // the card while the turn hangs until the 10-min TTL. Language-resolve the
      // addon list here (same as the SSE path) so the card renders identically.
      const rawPendingUnknown: unknown = body.data?.pendingActions ?? [];
      if (!Array.isArray(rawPendingUnknown)
        || (mode === 'portfolio' && rawPendingUnknown.length !== 0)) {
        setError(mode === 'portfolio'
          ? 'Portfolio conversations cannot restore pending actions.'
          : 'Failed to verify pending actions.');
        return;
      }
      const rawPending = rawPendingUnknown as ServerPendingAction[];
      const rehydrated: PendingAction[] = rawPending.map((p) => ({
        pendingActionId: p.pendingActionId,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.args ?? {},
        tier: p.tier === 'quick' ? 'quick' : 'card',
        summary: p.summary ?? { en: '', },
        addons: (p.addons ? (p.addons.en) : []) ?? [],
      }));
      setPendingActions(rehydrated);
      const nextCursor = recordScopedConversationId(
        conversationCursorRef.current,
        scopeKey,
        id,
      );
      if (nextCursor.conversationId !== id) {
        setError('Failed to verify that conversation.');
        return;
      }
      conversationCursorRef.current = nextCursor;
      setMessages(display);
      if (mode === 'portfolio') {
        setScopeDisclosures(restoredDisclosures!);
        portfolioTurnRef.current = userTurnCount;
      }
      setConversationId(id);
    } catch (e) {
      if (e instanceof SessionEndedError) return;  // redirect in progress
      setError(mode === 'portfolio'
        ? 'Saved portfolio chats could not be loaded.'
        : e instanceof Error ? e.message : String(e));
    } finally {
      if (generation === generationRef.current && scopeKeyRef.current === scopeKey) {
        setLoadingConversation(false);
      }
    }
  }, [dismissResultCard, mode, organizationId, scopeKey]);

  const startNew = useCallback(() => {
    generationRef.current += 1;
    activeRequestRef.current?.cancel();
    activeRequestRef.current = null;
    clearDeltaBuffer();
    clearResultTimer();
    portfolioMessageRef.current = null;
    conversationCursorRef.current = { scopeKey, conversationId: null };
    portfolioTurnRef.current = 0;
    assistantIndexRef.current = -1;
    setConversationId(null);
    setMessages([]);
    setScopeDisclosures([]);
    setLoadingConversations(false);
    setLoadingConversation(false);
    setStreaming(false);
    setError(null);
    setPortfolioRetryMessage(null);
    setPendingActions([]);
    setResultCard(null);
    setActionErrors({});
  }, [clearDeltaBuffer, clearResultTimer, scopeKey]);

  const failPortfolioTurn = useCallback((
    requestScopeKey: string,
    requestGeneration: number,
    portfolioTurn: number,
  ) => {
    if (scopeKeyRef.current !== requestScopeKey || generationRef.current !== requestGeneration) return;
    clearDeltaBuffer();
    assistantIndexRef.current = -1;
    // Remove the failed user/assistant turn from the visible history. The
    // question itself lives in portfolioMessageRef only long enough for the
    // bounded Try again action to start a genuinely fresh conversation.
    setMessages(prev => {
      let lastUserIndex = -1;
      for (let index = prev.length - 1; index >= 0; index -= 1) {
        if (prev[index]?.role === 'user') {
          lastUserIndex = index;
          break;
        }
      }
      return lastUserIndex >= 0 ? prev.slice(0, lastUserIndex) : [];
    });
    setConversationId(null);
    conversationCursorRef.current = { scopeKey: requestScopeKey, conversationId: null };
    setScopeDisclosures(prev => prev.filter(item => item.turn !== portfolioTurn));
    setPortfolioRetryMessage(portfolioMessageRef.current);
    setError(PORTFOLIO_CHAT_FAILURE);
  }, [clearDeltaBuffer]);

  // ── Shared SSE consumer ────────────────────────────────────────────────
  // Reads an SSE Response from either /api/agent/command (a fresh turn) or
  // .../resolve-action (an approval resume). Handles every event type the two
  // routes emit, including the approval-flow additions.
  const consumeStream = useCallback(async (
    res: Response,
    requestScopeKey: string,
    requestGeneration: number,
    portfolioTurn: number | null = null,
    portfolioGuard: PortfolioStreamGuard | null = null,
  ): Promise<void> => {
    const current = () =>
      scopeKeyRef.current === requestScopeKey
      && generationRef.current === requestGeneration;
    const isPortfolio = portfolioTurn !== null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let terminal: 'open' | 'done' | 'failed' = 'open';
    let portfolioScopeVerified = !isPortfolio;
    let answerChars = 0;
    let sawText = false;

    const dispatchSideChannel = (payload: SsePayload) => {
      if (typeof window !== 'undefined' && payload.type !== 'active_scope') {
        window.dispatchEvent(
          new CustomEvent(`agent:${payload.type.replace(/_/g, '-')}`, {
            detail: payload,
          }),
        );
      }
    };

    // The 429 cap-hit / rate-limit / validation responses are JSON, not SSE.
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || !ct.includes('text/event-stream') || !res.body) {
      if (isPortfolio) {
        failPortfolioTurn(requestScopeKey, requestGeneration, portfolioTurn!);
        return;
      }
      const errBody = await res.json().catch(() => null);
      if (!current()) return;
      const friendly = errBody?.code === 'auth_unavailable'
        ? 'Sign-in service is temporarily unavailable. Try again in a moment.'
        : (errBody?.error ?? `Request failed: ${res.status}`);
      setError(friendly);
      return;
    }

    try {
      reader = res.body.getReader();
      portfolioGuard?.attachReader(reader);
      const decoder = new TextDecoder();
      let buf = '';

      const failPortfolioFrame = () => {
        terminal = 'failed';
        failPortfolioTurn(requestScopeKey, requestGeneration, portfolioTurn!);
        portfolioGuard?.cancel();
      };

      streamLoop: while (terminal === 'open') {
        const { value, done: readDone } = await reader.read();
        if (readDone) break;
        if (!current()) {
          await reader.cancel().catch(() => undefined);
          clearDeltaBuffer();
          return;
        }
        const decoded = decoder.decode(value, { stream: true });
        buf += decoded;
        if (isPortfolio && buf.length > portfolioStreamLimits.maxFrameChars) {
          failPortfolioFrame();
          break;
        }

        const events = buf.split(/\r?\n\r?\n/);
        buf = events.pop() ?? '';
        for (const ev of events) {
          if (!ev) continue;
          if (isPortfolio && terminal === 'done') {
            failPortfolioFrame();
            break streamLoop;
          }
          if (isPortfolio && ev.length > portfolioStreamLimits.maxFrameChars) {
            failPortfolioFrame();
            break streamLoop;
          }
          const dataLines = ev
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim());
          if (dataLines.length === 0) {
            if (isPortfolio) failPortfolioFrame();
            continue;
          }
          let parsedPayload: unknown;
          try {
            parsedPayload = JSON.parse(dataLines.join('\n'));
          } catch {
            if (isPortfolio) failPortfolioFrame();
            continue;
          }
          if (!parsedPayload
            || typeof parsedPayload !== 'object'
            || Array.isArray(parsedPayload)
            || typeof (parsedPayload as { type?: unknown }).type !== 'string'
          ) {
            if (isPortfolio) failPortfolioFrame();
            continue;
          }
          const payload = parsedPayload as SsePayload;
          if (!current()) {
            await reader.cancel().catch(() => undefined);
            clearDeltaBuffer();
            return;
          }

          if (isPortfolio) {
            // Portfolio streams are deliberately fail-closed. The route emits
            // one verified scope, optional text deltas, and one terminal done.
            if (payload.type !== 'text_delta') flushDeltaBuffer();
            if (payload.type === 'conversation_id') {
              if (typeof payload.id !== 'string' || !UUID_RX.test(payload.id)) {
                failPortfolioFrame();
                break streamLoop;
              }
              const nextCursor = recordScopedConversationId(
                conversationCursorRef.current,
                requestScopeKey,
                payload.id,
              );
              if (nextCursor.conversationId !== payload.id) {
                failPortfolioFrame();
                break streamLoop;
              }
              conversationCursorRef.current = nextCursor;
              setConversationId(nextCursor.conversationId);
              void reloadConversations();
              portfolioGuard?.resetInactivity();
              dispatchSideChannel(payload);
            } else if (payload.type === 'active_scope') {
              const parsed = parsePortfolioActiveScope(payload.scope);
              const expectedOrganizationId = requestScopeKey.startsWith('portfolio:')
                ? requestScopeKey.slice('portfolio:'.length)
                : null;
              if (!parsed || parsed.organizationId !== expectedOrganizationId) {
                failPortfolioFrame();
                break streamLoop;
              }
              setScopeDisclosures(prev => {
                const withoutCurrentTurn = prev.filter(item => item.turn !== portfolioTurn);
                return [...withoutCurrentTurn, { turn: portfolioTurn, scope: parsed }]
                  .sort((a, b) => a.turn - b.turn);
              });
              portfolioScopeVerified = true;
              portfolioGuard?.resetInactivity();
            } else if (payload.type === 'text_delta') {
              if (!portfolioScopeVerified
                || typeof payload.delta !== 'string'
                || payload.delta.length === 0
                || answerChars + payload.delta.length > portfolioStreamLimits.maxAnswerChars
              ) {
                failPortfolioFrame();
                break streamLoop;
              }
              answerChars += payload.delta.length;
              sawText = true;
              enqueueDelta(payload.delta, requestGeneration);
              portfolioGuard?.resetInactivity();
              dispatchSideChannel(payload);
            } else if (payload.type === 'done') {
              if (!portfolioScopeVerified
                || typeof payload.finalText !== 'string'
                || !payload.finalText.trim()
                || payload.finalText.length > portfolioStreamLimits.maxAnswerChars
              ) {
                failPortfolioFrame();
                break streamLoop;
              }
              // finalText is required even when the stream already delivered
              // deltas. Only enqueue it when no deltas were sent, so the answer
              // is never duplicated in the visible bubble.
              if (!sawText) {
                answerChars = payload.finalText.length;
                enqueueDelta(payload.finalText, requestGeneration);
              }
              terminal = 'done';
              portfolioGuard?.resetInactivity();
              dispatchSideChannel(payload);
            } else {
              // Errors, unknown events, and traffic after the known contract
              // are not safe to present as a completed portfolio answer.
              failPortfolioFrame();
              break streamLoop;
            }
            continue;
          }

          // Side channel for non-chat observers (walkthrough overlay, voice TTS).
          // Each SSE event is mirrored as a window CustomEvent so components
          // mounted outside the hook can listen without forking the stream.
          // NOTE: mutation tools no longer emit tool_call_started inline (they go
          // through the approval flow), so the walkthrough overlay's
          // agent:tool-call-started listener only ever fires for read-only tools
          // like walk_user_through — exactly what it wants.
          dispatchSideChannel(payload);

          // Any event OTHER than a text delta reads or resets the message list /
          // assistant-bubble index, so flush buffered deltas first — otherwise
          // tokens could land in the wrong bubble (or after an index reset).
          if (payload.type !== 'text_delta') flushDeltaBuffer();

          if (payload.type === 'conversation_id' && typeof payload.id === 'string') {
            const nextCursor = recordScopedConversationId(
              conversationCursorRef.current,
              requestScopeKey,
              payload.id,
            );
            if (nextCursor.conversationId !== payload.id) {
              await reader.cancel().catch(() => undefined);
              clearDeltaBuffer();
              setError('Staxis could not verify that conversation.');
              return;
            }
            conversationCursorRef.current = nextCursor;
            setConversationId(nextCursor.conversationId);
            void reloadConversations();
          } else if (payload.type === 'active_scope') {
            // Portfolio scope comes from the current-turn authoritative resolver.
            // It must name the same company as this request; a mismatch is
            // treated as a security-domain failure and no answer text is shown.
            const parsed = parsePortfolioActiveScope(payload.scope);
            const expectedOrganizationId = requestScopeKey.startsWith('portfolio:')
              ? requestScopeKey.slice('portfolio:'.length)
              : null;
            if (portfolioTurn === null
              || !parsed
              || parsed.organizationId !== expectedOrganizationId
            ) {
              await reader.cancel().catch(() => undefined);
              clearDeltaBuffer();
              setError('Staxis could not verify the scope used for that answer.');
              return;
            }
            setScopeDisclosures(prev => {
              const withoutCurrentTurn = prev.filter(item => item.turn !== portfolioTurn);
              return [...withoutCurrentTurn, { turn: portfolioTurn, scope: parsed }]
                .sort((a, b) => a.turn - b.turn);
            });
            portfolioScopeVerified = true;
          } else if (payload.type === 'text_delta' && typeof payload.delta === 'string') {
            if (!portfolioScopeVerified) {
              await reader.cancel().catch(() => undefined);
              clearDeltaBuffer();
              setError('Staxis could not verify the scope used for that answer.');
              return;
            }
            // Buffered — coalesced into ~one setMessages per animation frame.
            enqueueDelta(payload.delta, requestGeneration);
          } else if (payload.type === 'done'
            && typeof payload.finalText === 'string'
            && payload.finalText
            && assistantIndexRef.current < 0
          ) {
            if (!portfolioScopeVerified) {
              await reader.cancel().catch(() => undefined);
              clearDeltaBuffer();
              setError('Staxis could not verify the scope used for that answer.');
              return;
            }
            // Clarifications and deterministic refusals may complete without
            // model token deltas. Render their final text exactly once.
            enqueueDelta(payload.finalText, requestGeneration);
          } else if (payload.type === 'tool_call_started' && payload.call) {
            const call = payload.call;
            setMessages(prev => [
              ...prev,
              { role: 'assistant', text: '', toolName: call.name, toolArgs: call.args },
            ]);
            assistantIndexRef.current = -1;
          } else if (payload.type === 'tool_call_finished') {
            setMessages(prev => [
              ...prev,
              { role: 'tool', text: '', toolResult: payload.result, isError: Boolean(payload.isError) },
            ]);
            assistantIndexRef.current = -1;
          } else if (payload.type === 'tool_call_pending_approval' && payload.pendingActionId) {
            // A proposed mutation — queue an approval card.
            const addonList = payload.addons ? (payload.addons.en) : [];
            const card: PendingAction = {
              pendingActionId: payload.pendingActionId,
              toolCallId: payload.toolCallId ?? '',
              toolName: payload.toolName ?? '',
              args: payload.args ?? {},
              tier: payload.tier === 'quick' ? 'quick' : 'card',
              summary: payload.summary ?? { en: '', },
              addons: addonList ?? [],
            };
            setPendingActions(prev => (prev.some(p => p.pendingActionId === card.pendingActionId) ? prev : [...prev, card]));
            assistantIndexRef.current = -1;
          } else if (payload.type === 'pending_actions_superseded') {
            // A new user message abandoned earlier proposals — the server expired
            // them. Drop any still-displayed cards for them so the user can't
            // approve a stale action.
            const dropped = new Set(payload.pendingActionIds ?? []);
            if (dropped.size > 0) {
              setPendingActions(prev => prev.filter(p => !dropped.has(p.pendingActionId)));
            }
          } else if (payload.type === 'action_result' && payload.pendingActionId) {
            // A decision resolved — show the result confirmation card.
            const denied = payload.denied === true;
            const okResult = payload.ok === true;
            const card: ResultCard = {
              pendingActionId: payload.pendingActionId,
              toolName: payload.toolName ?? '',
              ok: okResult,
              denied,
              summary: pick(payload.resultSummary),
              error: payload.error ? pick({ en: payload.error.en ?? '', }) : null,
              addonNotes: payload.addonNotes ?? [],
            };
            clearResultTimer();
            setResultCard(card);
            // Success (and denials) auto-dismiss; failures stay until dismissed.
            if (okResult) {
              resultTimerRef.current = setTimeout(() => setResultCard(null), 2500);
            }
            assistantIndexRef.current = -1;
          } else if (payload.type === 'error' && typeof payload.message === 'string') {
            setError(payload.message);
          }
        }
        if (terminal !== 'open') break streamLoop;
      }

      if (current()) {
        if (isPortfolio) {
          if (terminal === 'done') {
            portfolioMessageRef.current = null;
            setPortfolioRetryMessage(null);
            flushDeltaBuffer();
          } else if (terminal === 'open') {
            failPortfolioTurn(requestScopeKey, requestGeneration, portfolioTurn!);
          }
        } else {
          flushDeltaBuffer();
        }
      } else {
        clearDeltaBuffer();
      }
    } catch (error) {
      if (!current()) {
        clearDeltaBuffer();
        return;
      }
      if (isPortfolio) {
        failPortfolioTurn(requestScopeKey, requestGeneration, portfolioTurn!);
        return;
      }
      throw error;
    } finally {
      if (reader) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }, [
    reloadConversations,
    pick,
    clearResultTimer,
    enqueueDelta,
    flushDeltaBuffer,
    clearDeltaBuffer,
    failPortfolioTurn,
  ]);

  const sendMessage = useCallback(async (text: string, opts?: { origin?: AskOrigin }) => {
    const message = text.trim();
    const hasRequiredScope = mode === 'portfolio'
      ? Boolean(organizationId)
      : Boolean(propertyId);
    if (!message
      || streaming
      || !hasRequiredScope
      || stateScopeKey !== scopeKey
      || (mode === 'portfolio' && !active)
    ) return;

    const requestGeneration = generationRef.current;
    const requestScopeKey = scopeKey;
    const portfolioTurn = mode === 'portfolio' ? portfolioTurnRef.current++ : null;
    portfolioMessageRef.current = mode === 'portfolio' ? message : null;
    if (mode === 'portfolio') setPortfolioRetryMessage(null);
    const controller = new AbortController();
    const portfolioGuard = mode === 'portfolio'
      ? createPortfolioStreamGuard(controller, portfolioStreamLimits)
      : null;
    const scopedConversationId = conversationIdForScope(
      conversationCursorRef.current,
      requestScopeKey,
    );
    const request: ActiveChatRequest = {
      controller,
      cancel: () => {
        portfolioGuard?.cancel();
        portfolioGuard?.dispose();
        if (!controller.signal.aborted) controller.abort();
      },
    };
    activeRequestRef.current?.cancel();
    activeRequestRef.current = request;
    setError(null);
    setStreaming(true);
    assistantIndexRef.current = -1;

    setMessages(prev => [...prev, { role: 'user', text: message }]);

    try {
      const res = await fetchWithAuth(
        mode === 'portfolio' ? '/api/agent/portfolio' : '/api/agent/command',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          ...(mode === 'portfolio' ? { timeoutMs: null } : {}),
          body: JSON.stringify(
            mode === 'portfolio'
              ? {
                  ...(scopedConversationId ? { conversationId: scopedConversationId } : {}),
                  organizationId,
                  message,
                }
              : {
                  conversationId: scopedConversationId,
                  propertyId,
                  message,
                  // Read off the ref, never a closed-over value. This keeps the
                  // stable callback while giving hotel awareness the live page.
                  ...(pathnameRef.current ? { pathname: pathnameRef.current } : {}),
                  ...(opts?.origin ? { origin: opts.origin } : {}),
                },
          ),
        },
      );
      await consumeStream(
        res,
        requestScopeKey,
        requestGeneration,
        portfolioTurn,
        portfolioGuard,
      );
    } catch (e) {
      if (mode === 'portfolio'
        && portfolioGuard?.timedOut()
        && requestGeneration === generationRef.current
        && requestScopeKey === scopeKeyRef.current
      ) {
        failPortfolioTurn(requestScopeKey, requestGeneration, portfolioTurn!);
        return;
      }
      if (controller.signal.aborted
        || requestGeneration !== generationRef.current
        || requestScopeKey !== scopeKeyRef.current
      ) {
        return;
      }
      if (e instanceof SessionEndedError) return;  // redirect in progress; suppress error pill
      if (mode === 'portfolio') {
        failPortfolioTurn(requestScopeKey, requestGeneration, portfolioTurn!);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      portfolioGuard?.dispose();
      if (activeRequestRef.current === request) activeRequestRef.current = null;
      if (requestGeneration === generationRef.current
        && requestScopeKey === scopeKeyRef.current
      ) {
        setStreaming(false);
      }
    }
  }, [
    mode,
    organizationId,
    propertyId,
    active,
    streaming,
    stateScopeKey,
    scopeKey,
    consumeStream,
    failPortfolioTurn,
  ]);

  // ── Approve / deny a pending action ────────────────────────────────────
  const resolveAction = useCallback(async (
    pendingActionId: string,
    decision: 'approve' | 'deny',
    opts?: { adjustedArgs?: Record<string, unknown>; addons?: string[] },
  ) => {
    // Portfolio chat is read-only and has no approval endpoint.
    if (mode !== 'property' || !propertyId || stateScopeKey !== scopeKey) return;
    const requestGeneration = generationRef.current;
    const requestScopeKey = scopeKey;
    const controller = new AbortController();
    const request: ActiveChatRequest = {
      controller,
      cancel: () => controller.abort(),
    };
    activeRequestRef.current?.cancel();
    activeRequestRef.current = request;
    setError(null);
    setStreaming(true);
    assistantIndexRef.current = -1;
    try {
      const res = await fetchWithAuth('/api/agent/command/resolve-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          pid: propertyId,
          pendingActionId,
          decision,
          adjustedArgs: opts?.adjustedArgs,
          addons: opts?.addons,
        }),
      });

      // An invalid Adjust edit comes back as a 400 JSON (code 'invalid_edit')
      // WITHOUT consuming the pending row — the card stays up. Surface the field
      // error inline on that card and keep it displayed so the user can fix it.
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 400 && ct.includes('application/json')) {
        const errBody = await res.json().catch(() => null);
        if (errBody?.code === 'invalid_edit') {
          setActionErrors(prev => ({ ...prev, [pendingActionId]: errBody.error ?? 'That edit isn\'t valid.' }));
          return;
        }
        // Any other 400 — fall through to the shared error handling.
        setError(errBody?.error ?? `Request failed: ${res.status}`);
        setPendingActions(prev => prev.filter(p => p.pendingActionId !== pendingActionId));
        return;
      }

      // Valid decision — the row is committed server-side. Remove the card (and
      // clear any stale inline error) so the user can't double-tap, then consume
      // the resume stream.
      setPendingActions(prev => prev.filter(p => p.pendingActionId !== pendingActionId));
      setActionErrors(prev => {
        if (!(pendingActionId in prev)) return prev;
        const next = { ...prev }; delete next[pendingActionId]; return next;
      });
      await consumeStream(res, requestScopeKey, requestGeneration);
    } catch (e) {
      if (controller.signal.aborted
        || requestGeneration !== generationRef.current
        || requestScopeKey !== scopeKeyRef.current
      ) {
        return;
      }
      if (e instanceof SessionEndedError) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (activeRequestRef.current === request) activeRequestRef.current = null;
      if (requestGeneration === generationRef.current
        && requestScopeKey === scopeKeyRef.current
      ) {
        setStreaming(false);
      }
    }
  }, [mode, propertyId, stateScopeKey, scopeKey, consumeStream]);

  const visibleScopeMatches = stateScopeKey === scopeKey;
  return {
    messages: visibleScopeMatches ? messages : [],
    conversations: visibleScopeMatches ? conversations : [],
    conversationId: visibleScopeMatches ? conversationId : null,
    scopeDisclosures: visibleScopeMatches ? scopeDisclosures : [],
    loadingConversations: visibleScopeMatches ? loadingConversations : false,
    conversationsLoaded: visibleScopeMatches ? conversationsLoaded : false,
    loadingConversation: visibleScopeMatches ? loadingConversation : false,
    streaming: visibleScopeMatches ? streaming : false,
    error: visibleScopeMatches ? error : null,
    portfolioRetryMessage: visibleScopeMatches ? portfolioRetryMessage : null,
    sendMessage,
    startNew,
    loadConversation,
    reloadConversations,
    pendingActions: visibleScopeMatches ? pendingActions : [],
    resultCard: visibleScopeMatches ? resultCard : null,
    resolveAction,
    dismissResultCard,
    actionErrors: visibleScopeMatches ? actionErrors : {},
  };
}
