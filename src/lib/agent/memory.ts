// ─── Agent conversation memory ────────────────────────────────────────────
// Conversation persistence backed by the Supabase tables created in
// migration 0079. Three exports for the lifecycle:
//
//   listConversations(userId)            — sidebar list
//   loadConversation(conversationId, userId) — full history for a session
//   createConversation(...)              — start a new session
//   appendMessage(...)                   — record a turn (user, assistant, tool)
//   deleteConversation(id, userId)       — hard delete
//
// Auth model: every function takes the calling user's account id and checks
// ownership before reading or writing. The endpoints layer doesn't need to
// repeat the check.

import { createHash } from 'node:crypto';

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import type { AgentMessage, AgentToolCall, ModelTier } from './llm';
import { escapeTrustMarkerContent } from './llm';
import {
  conversationSecurityScopeFromRow,
  portfolioPolicyFingerprintFromStamp,
  type ConversationKind,
  type ConversationSecurityScope,
} from './portfolio/conversation';
import {
  decodePortfolioHistoryWindow,
  type PortfolioHistoryWindowV1,
} from './portfolio-intelligence/history-window';
import {
  answerOffer,
  encodeOfferPayload,
  parseOfferRow,
  sortOffers,
  OFFER_TEXT_MAX,
  type CompanionOffer,
  type CompanionOfferAnswer,
  type CompanionOfferKind,
  type CompanionOfferReceipt,
} from '@/lib/companion/offers';
import type { CompanionReply } from '@/lib/companion/replies';

// ─── Public types ──────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  title: string | null;
  role: AppRole;
  conversationKind: ConversationKind;
  propertyId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Cross-hotel chat: the company this conversation answers for, or null for
   * every ordinary per-hotel conversation. Surfaced so a caller can tell the
   * two apart — a portfolio conversation's `propertyId` is only its anchor
   * hotel and must never be read as "this chat is about that hotel".
   */
  organizationId: string | null;
}

export interface ConversationDetail extends ConversationSummary {
  promptVersion: string | null;
  messages: AgentMessage[];
}

/** Browser-safe reconstruction of the exact scope used for a persisted
 * portfolio answer. Internal receipt ids, authorization hashes, property ids,
 * source rows, and query plans deliberately stay server-side. */
export interface PortfolioConversationScopeDisclosure {
  turn: number;
  scope: {
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
  };
}

/** Portfolio browser metadata deliberately omits the relational anchor hotel.
 * The anchor is storage plumbing, never the active portfolio scope. */
export type PortfolioConversationSummary = Omit<ConversationSummary, 'propertyId'>;

export interface PortfolioConversationDetail extends PortfolioConversationSummary {
  promptVersion: string | null;
  messages: AgentMessage[];
  scopeDisclosures: PortfolioConversationScopeDisclosure[];
}

export type LoadPortfolioConversationResult =
  | { ok: true; conversation: PortfolioConversationDetail }
  | { ok: false; reason: 'not_found' | 'scope_changed' };

/** Internal authority metadata. Do not serialize authorizationHash or receipt
 * ids into browser conversation-list/detail responses. */
export interface ConversationScope extends ConversationSecurityScope {
  propertyId: string;
  role: AppRole;
  promptVersion: string | null;
}

export interface SaveMessageOpts {
  conversationId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  /** L8B, 2026-05-13: persisted only for role='tool' rows. true means
   *  the tool handler returned an error (or the request was aborted
   *  before the result landed). Drives the tool-error-rate KPI. */
  isError?: boolean;
  tokensIn?: number;
  tokensOut?: number;
  modelUsed?: ModelTier;
  costUsd?: number;
}

interface StoredHistoryRow {
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_args: Record<string, unknown> | null;
  tool_result: unknown;
  is_summary?: boolean;
}

function decodeStoredHistory(rawRows: readonly StoredHistoryRow[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  let pendingAssistant: { content: string; toolCalls: AgentToolCall[] } | null = null;
  const flushPending = () => {
    if (!pendingAssistant) return;
    messages.push({
      role: 'assistant',
      content: pendingAssistant.content,
      toolCalls: pendingAssistant.toolCalls.length ? pendingAssistant.toolCalls : undefined,
    });
    pendingAssistant = null;
  };

  for (const row of rawRows) {
    if (row.role === 'user') {
      flushPending();
      messages.push({ role: 'user', content: row.content ?? '' });
    } else if (row.role === 'assistant') {
      if (row.is_summary === true) {
        flushPending();
        messages.push({
          role: 'assistant',
          content: `<staxis-summary trust="system-derived-from-untrusted">${escapeTrustMarkerContent(row.content ?? '')}</staxis-summary>`,
        });
      } else {
        if (!pendingAssistant) pendingAssistant = { content: '', toolCalls: [] };
        if (row.tool_name) {
          pendingAssistant.toolCalls.push({
            id: row.tool_call_id ?? '',
            name: row.tool_name,
            args: row.tool_args ?? {},
          });
        } else if (row.content) {
          pendingAssistant.content =
            (pendingAssistant.content ? pendingAssistant.content + '\n' : '') + row.content;
        }
      }
    } else if (row.role === 'tool') {
      flushPending();
      messages.push({
        role: 'tool',
        toolCallId: row.tool_call_id ?? '',
        result: row.tool_result ?? null,
      });
    }
  }
  flushPending();
  return messages;
}

// ─── Conversation CRUD ────────────────────────────────────────────────────

export async function listConversations(
  userAccountId: string,
  limit = 30,
  conversationKind: ConversationKind = 'property',
  /** Current authoritative hotels. Applied before LIMIT to avoid stale rows
   * crowding valid history out of the page. Null is platform-admin/all. */
  authorizedPropertyIds: readonly string[] | null = null,
): Promise<ConversationSummary[]> {
  if (conversationKind === 'property'
    && authorizedPropertyIds !== null
    && authorizedPropertyIds.length === 0) return [];
  let query = supabaseAdmin
    .from('agent_conversations')
    .select('id, title, role, property_id, prompt_version, conversation_kind, organization_id, authorization_hash, scope_receipt_id, scope_verified_at, created_at, updated_at')
    .eq('user_id', userAccountId)
    .eq('conversation_kind', conversationKind);
  if (conversationKind === 'property' && authorizedPropertyIds !== null) {
    query = query.in('property_id', [...authorizedPropertyIds]);
  }
  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).flatMap((row): ConversationSummary[] => {
    const scope = conversationSecurityScopeFromRow(row);
    if (!scope || scope.conversationKind !== conversationKind) return [];
    return [{
      id: row.id as string,
      title: (row.title as string) ?? null,
      role: row.role as AppRole,
      conversationKind: scope.conversationKind,
      propertyId: row.property_id as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      organizationId: scope.organizationId,
    }];
  });
}

/**
 * Load PROPERTY history only. Portfolio history is never available through
 * this compatibility API: it must go through receipt-asserted portfolio prep.
 */
export async function loadConversation(
  conversationId: string,
  userAccountId: string,
): Promise<ConversationDetail | null> {
  // Ownership check + metadata fetch in one query.
  const { data: convo, error: convoErr } = await supabaseAdmin
    .from('agent_conversations')
    .select('id, title, role, property_id, prompt_version, conversation_kind, organization_id, authorization_hash, scope_receipt_id, scope_verified_at, created_at, updated_at, user_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (convoErr) throw convoErr;
  if (!convo) return null;
  if (convo.user_id !== userAccountId) return null;
  const scope = conversationSecurityScopeFromRow(convo);
  if (!scope || scope.conversationKind !== 'property') return null;

  // Pull messages in chronological order. L4 (2026-05-13): filter out
  // is_summarized=true rows so the model never sees pre-summary
  // messages on replay. The summary row itself (is_summarized=false,
  // is_summary=true) IS included and appears at the position of the
  // batch it replaced (its created_at is the moment of summarization,
  // which is AFTER all the rows it summarized).
  const { data: rows, error: msgErr } = await supabaseAdmin
    .from('agent_messages')
    .select('role, content, tool_call_id, tool_name, tool_args, tool_result, is_summary, created_at')
    .eq('conversation_id', conversationId)
    .eq('is_summarized', false)
    .order('created_at', { ascending: true });
  if (msgErr) throw msgErr;

  const messages = decodeStoredHistory((rows ?? []) as StoredHistoryRow[]);

  return {
    id: convo.id as string,
    title: (convo.title as string) ?? null,
    role: convo.role as AppRole,
    conversationKind: 'property',
    propertyId: convo.property_id as string,
    promptVersion: (convo.prompt_version as string) ?? null,
    organizationId: null,
    createdAt: convo.created_at as string,
    updatedAt: convo.updated_at as string,
    messages,
  };
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RX = /^[0-9a-f]{64}$/;
const PORTFOLIO_REPLAY_TURN_LIMIT = 200;
const PORTFOLIO_DISCLOSURE_NAME_LIMIT = 25;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sortedUniqueUuidArray(value: unknown): string[] | null {
  if (!Array.isArray(value)
    || !value.every((item): item is string => typeof item === 'string' && UUID_RX.test(item))
    || new Set(value).size !== value.length) return null;
  return [...value].sort();
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeDisclosureText(value: unknown, fallback: string, max = 200): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .replace(/[<>\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return cleaned || fallback;
}

interface PortfolioReplayMessageRow {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  is_summary?: unknown;
  created_at?: unknown;
}

interface PortfolioReplayCommitRow {
  query_receipt_id?: unknown;
  conversation_id?: unknown;
  user_message_id?: unknown;
  assistant_message_id?: unknown;
  committed_at?: unknown;
}

interface PortfolioReplayReceiptRow {
  id?: unknown;
  account_id?: unknown;
  organization_id?: unknown;
  conversation_id?: unknown;
  authorization_hash?: unknown;
  scope_hash?: unknown;
  question_hash?: unknown;
  answer_hash?: unknown;
  authorized_property_ids?: unknown;
  selected_property_ids?: unknown;
  plan?: unknown;
  evidence?: unknown;
  status?: unknown;
  generated_at?: unknown;
}

interface ParsedPortfolioReplayReceipt {
  id: string;
  generatedAt: string;
  questionHash: string;
  answerHash: string;
  scope: Omit<PortfolioConversationScopeDisclosure, 'turn'>['scope'];
}

function selectorLabelFromReceipt(input: {
  plan: Record<string, unknown>;
  selectedPropertyIds: string[];
  hotelNames: Map<string, string>;
}): string | null {
  const selector = input.plan.selector;
  if (!isRecord(selector)) return null;
  if (selector.kind === 'all_authorized') return 'All authorized hotels';
  if (selector.kind === 'hotel') {
    if (input.selectedPropertyIds.length !== 1
      || typeof selector.propertyId !== 'string'
      || selector.propertyId !== input.selectedPropertyIds[0]) return null;
    return input.hotelNames.get(selector.propertyId) ?? 'One authorized hotel';
  }
  if (selector.kind === 'explicit_subset') {
    const selectorIds = sortedUniqueUuidArray(selector.propertyIds);
    if (!selectorIds || !sameStringArray(selectorIds, input.selectedPropertyIds)) return null;
    return `${selectorIds.length} selected authorized hotels`;
  }
  if (selector.kind === 'portfolio') {
    if (typeof selector.portfolioId !== 'string' || !UUID_RX.test(selector.portfolioId)) return null;
    return 'Selected portfolio or region';
  }
  return null;
}

/**
 * Parse only the disclosure projection needed by the browser. The exact
 * authorized set and all receipt/evidence correlation fields must agree before
 * even hotel names are released. Raw evidence is never returned.
 */
function parsePortfolioReplayReceipt(input: {
  row: PortfolioReplayReceiptRow;
  userAccountId: string;
  conversationId: string;
  organizationId: string;
  authorizationHash: string;
  currentAuthorizedPropertyIds: readonly string[];
}): ParsedPortfolioReplayReceipt | null {
  const row = input.row;
  if (typeof row.id !== 'string' || !UUID_RX.test(row.id)
    || row.account_id !== input.userAccountId
    || row.conversation_id !== input.conversationId
    || row.organization_id !== input.organizationId
    || row.authorization_hash !== input.authorizationHash
    || typeof row.scope_hash !== 'string' || !SHA256_RX.test(row.scope_hash)
    || typeof row.question_hash !== 'string' || !SHA256_RX.test(row.question_hash)
    || typeof row.answer_hash !== 'string' || !SHA256_RX.test(row.answer_hash)
    || (row.status !== 'completed' && row.status !== 'partial' && row.status !== 'abstained')
    || typeof row.generated_at !== 'string' || !Number.isFinite(Date.parse(row.generated_at))
    || !isRecord(row.plan)
    || !isRecord(row.evidence)) return null;

  const currentAuthorized = [...input.currentAuthorizedPropertyIds].sort();
  const authorizedPropertyIds = sortedUniqueUuidArray(row.authorized_property_ids);
  const selectedPropertyIds = sortedUniqueUuidArray(row.selected_property_ids);
  if (!authorizedPropertyIds
    || !selectedPropertyIds
    || selectedPropertyIds.length === 0
    || !sameStringArray(authorizedPropertyIds, currentAuthorized)
    || selectedPropertyIds.some((propertyId) => !authorizedPropertyIds.includes(propertyId))) {
    return null;
  }

  const evidence = row.evidence;
  const evidenceAuthorized = sortedUniqueUuidArray(evidence.authorizedPropertyIds);
  const evidenceSelected = sortedUniqueUuidArray(evidence.selectedPropertyIds);
  if (evidence.organizationId !== input.organizationId
    || evidence.scopeHash !== row.scope_hash
    || !evidenceAuthorized
    || !evidenceSelected
    || !sameStringArray(evidenceAuthorized, authorizedPropertyIds)
    || !sameStringArray(evidenceSelected, selectedPropertyIds)
    || !isRecord(evidence.coverage)) return null;

  const coverageAuthorized = finiteNonNegativeInteger(evidence.coverage.authorized);
  const coverageSelected = finiteNonNegativeInteger(evidence.coverage.selected);
  const coverageReported = finiteNonNegativeInteger(evidence.coverage.reported);
  const coverageExcluded = finiteNonNegativeInteger(evidence.coverage.excluded);
  if (coverageAuthorized !== authorizedPropertyIds.length
    || coverageSelected !== selectedPropertyIds.length
    || coverageReported === null
    || coverageExcluded === null
    || coverageReported + coverageExcluded !== coverageSelected) return null;

  const selectedSet = new Set(selectedPropertyIds);
  const hotelNames = new Map<string, string>();
  if (!Array.isArray(evidence.facts) || !Array.isArray(evidence.coverage.excludedHotels)) return null;
  for (const rawFact of evidence.facts) {
    if (!isRecord(rawFact)
      || typeof rawFact.propertyId !== 'string'
      || !selectedSet.has(rawFact.propertyId)) return null;
    hotelNames.set(
      rawFact.propertyId,
      safeDisclosureText(rawFact.propertyName, 'Authorized hotel'),
    );
  }
  for (const rawExcluded of evidence.coverage.excludedHotels) {
    if (!isRecord(rawExcluded)
      || typeof rawExcluded.propertyId !== 'string'
      || !selectedSet.has(rawExcluded.propertyId)) return null;
    hotelNames.set(
      rawExcluded.propertyId,
      safeDisclosureText(rawExcluded.propertyName, 'Authorized hotel'),
    );
  }
  const selectorLabel = selectorLabelFromReceipt({
    plan: row.plan,
    selectedPropertyIds,
    hotelNames,
  });
  if (!selectorLabel) return null;

  const shownNames = selectedPropertyIds
    .slice(0, PORTFOLIO_DISCLOSURE_NAME_LIMIT)
    .map((propertyId, index) => hotelNames.get(propertyId) ?? `Authorized hotel ${index + 1}`);
  return {
    id: row.id,
    generatedAt: row.generated_at,
    questionHash: row.question_hash,
    answerHash: row.answer_hash,
    scope: {
      organizationId: input.organizationId,
      organizationName: safeDisclosureText(
        evidence.organizationName,
        'Management company',
      ),
      selectorLabel: safeDisclosureText(selectorLabel, 'Authorized portfolio scope', 240),
      selectedHotelCount: selectedPropertyIds.length,
      authorizedHotelCount: authorizedPropertyIds.length,
      hotelNames: shownNames,
      hotelNamesOmitted: Math.max(0, selectedPropertyIds.length - shownNames.length),
      coverage: {
        reported: coverageReported,
        total: coverageSelected,
        omitted: coverageExcluded,
      },
    },
  };
}

/**
 * Reconstruct only fully receipted portfolio turns. Question AND answer hashes
 * have to match the immutable receipt, so interrupted, withheld, summarized,
 * or otherwise unreceipted rows cannot acquire a scope badge by position.
 */
export function buildPortfolioConversationReplay(input: {
  userAccountId: string;
  conversationId: string;
  organizationId: string;
  authorizationHash: string;
  currentAuthorizedPropertyIds: readonly string[];
  messageRows: readonly PortfolioReplayMessageRow[];
  receiptRows: readonly PortfolioReplayReceiptRow[];
  commitRows: readonly PortfolioReplayCommitRow[];
}): Pick<PortfolioConversationDetail, 'messages' | 'scopeDisclosures'> {
  const receipts = input.receiptRows
    .map((row) => parsePortfolioReplayReceipt({ ...input, row }))
    .filter((receipt): receipt is ParsedPortfolioReplayReceipt => receipt !== null);
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const messageById = new Map<string, PortfolioReplayMessageRow>();
  for (const row of input.messageRows) {
    if (typeof row.id === 'string' && UUID_RX.test(row.id) && !messageById.has(row.id)) {
      messageById.set(row.id, row);
    }
  }
  const commits = input.commitRows.flatMap((row): Array<{
    queryReceiptId: string;
    userMessageId: string;
    assistantMessageId: string;
    committedAt: string;
  }> => {
    if (row.conversation_id !== input.conversationId
      || typeof row.query_receipt_id !== 'string' || !UUID_RX.test(row.query_receipt_id)
      || typeof row.user_message_id !== 'string' || !UUID_RX.test(row.user_message_id)
      || typeof row.assistant_message_id !== 'string' || !UUID_RX.test(row.assistant_message_id)
      || row.user_message_id === row.assistant_message_id
      || typeof row.committed_at !== 'string'
      || !Number.isFinite(Date.parse(row.committed_at))) return [];
    return [{
      queryReceiptId: row.query_receipt_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
      committedAt: row.committed_at,
    }];
  }).sort((left, right) => left.committedAt.localeCompare(right.committedAt)
    || left.queryReceiptId.localeCompare(right.queryReceiptId));

  const messages: AgentMessage[] = [];
  const scopeDisclosures: PortfolioConversationScopeDisclosure[] = [];
  const usedMessageIds = new Set<string>();
  const usedReceiptIds = new Set<string>();
  for (const commit of commits) {
    if (usedReceiptIds.has(commit.queryReceiptId)
      || usedMessageIds.has(commit.userMessageId)
      || usedMessageIds.has(commit.assistantMessageId)) continue;
    const receipt = receiptById.get(commit.queryReceiptId);
    const user = messageById.get(commit.userMessageId);
    const assistant = messageById.get(commit.assistantMessageId);
    if (!receipt
      || !user
      || !assistant
      || user.role !== 'user'
      || assistant.role !== 'assistant'
      || user.is_summary === true
      || assistant.is_summary === true
      || typeof user.content !== 'string'
      || !user.content.trim()
      || typeof assistant.content !== 'string'
      || !assistant.content.trim()
      || sha256(user.content.trim()) !== receipt.questionHash
      || sha256(assistant.content) !== receipt.answerHash) continue;
    usedReceiptIds.add(commit.queryReceiptId);
    usedMessageIds.add(commit.userMessageId);
    usedMessageIds.add(commit.assistantMessageId);
    const turn = scopeDisclosures.length;
    messages.push(
      { role: 'user', content: user.content },
      { role: 'assistant', content: assistant.content },
    );
    scopeDisclosures.push({ turn, scope: receipt.scope });
  }
  return { messages, scopeDisclosures };
}

/** List only conversations bound to this exact current authorization universe. */
export async function listPortfolioConversationsForAuthorization(opts: {
  userAccountId: string;
  organizationId: string;
  authorizationHash: string;
  policyFingerprint: string;
  limit?: number;
}): Promise<PortfolioConversationSummary[]> {
  if (!UUID_RX.test(opts.userAccountId)
    || !UUID_RX.test(opts.organizationId)
    || !SHA256_RX.test(opts.authorizationHash)) return [];
  const limit = Math.max(1, Math.min(50, opts.limit ?? 30));
  const { data, error } = await supabaseAdmin
    .from('agent_conversations')
    .select('id, title, role, property_id, prompt_version, conversation_kind, organization_id, authorization_hash, scope_receipt_id, scope_verified_at, created_at, updated_at')
    .eq('user_id', opts.userAccountId)
    .eq('conversation_kind', 'portfolio')
    .eq('organization_id', opts.organizationId)
    .eq('authorization_hash', opts.authorizationHash)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).flatMap((row): PortfolioConversationSummary[] => {
    const scope = conversationSecurityScopeFromRow(row);
    if (!scope
      || scope.conversationKind !== 'portfolio'
      || scope.organizationId !== opts.organizationId
      || scope.authorizationHash !== opts.authorizationHash
      || portfolioPolicyFingerprintFromStamp(row.prompt_version as string | null)
        !== opts.policyFingerprint) return [];
    return [{
      id: row.id as string,
      title: (row.title as string) ?? null,
      role: row.role as AppRole,
      conversationKind: 'portfolio',
      organizationId: opts.organizationId,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }];
  });
}

/**
 * Load an owned portfolio conversation only under the exact authorization hash
 * it was created with. The route re-resolves once more after this function;
 * this function's job is to keep every data read bound to the supplied proof.
 */
export async function loadPortfolioConversationForAuthorization(opts: {
  conversationId: string;
  userAccountId: string;
  organizationId: string;
  authorizationHash: string;
  policyFingerprint: string;
  currentAuthorizedPropertyIds: readonly string[];
}): Promise<LoadPortfolioConversationResult> {
  if (!UUID_RX.test(opts.conversationId)
    || !UUID_RX.test(opts.userAccountId)
    || !UUID_RX.test(opts.organizationId)
    || !SHA256_RX.test(opts.authorizationHash)) return { ok: false, reason: 'not_found' };
  const currentAuthorized = sortedUniqueUuidArray(opts.currentAuthorizedPropertyIds);
  if (!currentAuthorized || currentAuthorized.length === 0) {
    return { ok: false, reason: 'scope_changed' };
  }

  const { data: convo, error: convoError } = await supabaseAdmin
    .from('agent_conversations')
    .select('id, title, role, property_id, prompt_version, conversation_kind, organization_id, authorization_hash, scope_receipt_id, scope_verified_at, created_at, updated_at, user_id')
    .eq('id', opts.conversationId)
    .maybeSingle();
  if (convoError) throw convoError;
  if (!convo || convo.user_id !== opts.userAccountId) return { ok: false, reason: 'not_found' };
  const scope = conversationSecurityScopeFromRow(convo);
  if (!scope
    || scope.conversationKind !== 'portfolio'
    || scope.organizationId !== opts.organizationId) return { ok: false, reason: 'not_found' };
  if (scope.authorizationHash !== opts.authorizationHash) {
    return { ok: false, reason: 'scope_changed' };
  }
  if (portfolioPolicyFingerprintFromStamp(convo.prompt_version as string | null)
      !== opts.policyFingerprint) {
    return { ok: false, reason: 'scope_changed' };
  }

  const commitsResult = await supabaseAdmin
    .from('portfolio_query_turn_commits')
    .select('query_receipt_id, conversation_id, user_message_id, assistant_message_id, committed_at')
    .eq('conversation_id', opts.conversationId)
    .order('committed_at', { ascending: false })
    .limit(PORTFOLIO_REPLAY_TURN_LIMIT);
  if (commitsResult.error) throw commitsResult.error;
  const commitRows = [...(commitsResult.data ?? [])].reverse();
  if (commitRows.length === 0) {
    return {
      ok: true,
      conversation: {
        id: convo.id as string,
        title: (convo.title as string) ?? null,
        role: convo.role as AppRole,
        conversationKind: 'portfolio',
        promptVersion: (convo.prompt_version as string) ?? null,
        organizationId: opts.organizationId,
        createdAt: convo.created_at as string,
        updatedAt: convo.updated_at as string,
        messages: [],
        scopeDisclosures: [],
      },
    };
  }
  const messageIds = commitRows.flatMap((row) => [row.user_message_id, row.assistant_message_id]);
  const receiptIds = commitRows.map((row) => row.query_receipt_id);
  if (!messageIds.every((id) => typeof id === 'string' && UUID_RX.test(id))
    || !receiptIds.every((id) => typeof id === 'string' && UUID_RX.test(id))) {
    throw new Error('portfolio turn commit projection is malformed');
  }

  const [messagesResult, receiptsResult] = await Promise.all([
    supabaseAdmin
      .from('agent_messages')
      .select('id, role, content, is_summary, created_at')
      .eq('conversation_id', opts.conversationId)
      .in('id', messageIds as string[]),
    supabaseAdmin
      .from('portfolio_query_receipts')
      .select('id, account_id, organization_id, conversation_id, authorization_hash, scope_hash, question_hash, answer_hash, authorized_property_ids, selected_property_ids, plan, evidence, status, generated_at')
      .eq('conversation_id', opts.conversationId)
      .eq('account_id', opts.userAccountId)
      .eq('organization_id', opts.organizationId)
      .eq('authorization_hash', opts.authorizationHash)
      .in('status', ['completed', 'partial', 'abstained'])
      .in('id', receiptIds as string[]),
  ]);
  if (messagesResult.error) throw messagesResult.error;
  if (receiptsResult.error) throw receiptsResult.error;

  const replay = buildPortfolioConversationReplay({
    ...opts,
    currentAuthorizedPropertyIds: currentAuthorized,
    messageRows: messagesResult.data ?? [],
    receiptRows: receiptsResult.data ?? [],
    commitRows,
  });
  return {
    ok: true,
    conversation: {
      id: convo.id as string,
      title: (convo.title as string) ?? null,
      role: convo.role as AppRole,
      conversationKind: 'portfolio',
      promptVersion: (convo.prompt_version as string) ?? null,
      organizationId: opts.organizationId,
      createdAt: convo.created_at as string,
      updatedAt: convo.updated_at as string,
      messages: replay.messages,
      scopeDisclosures: replay.scopeDisclosures,
    },
  };
}

export async function createConversation(opts: {
  userAccountId: string;
  propertyId: string;
  role: AppRole;
  promptVersion?: string;
  title?: string;
  /**
   * Rolling-code compatibility only. Portfolio callers must use
   * createPortfolioConversation so a fresh receipt is asserted atomically.
   * Supplying a company here fails closed instead of creating an unbound row.
   */
  organizationId?: string | null;
}): Promise<string> {
  if (opts.organizationId) {
    throw new Error(
      'Portfolio conversations require createPortfolioConversation and a fresh scope receipt',
    );
  }
  const { data, error } = await supabaseAdmin
    .from('agent_conversations')
    .insert({
      user_id: opts.userAccountId,
      property_id: opts.propertyId,
      role: opts.role,
      prompt_version: opts.promptVersion ?? null,
      title: opts.title ?? null,
      conversation_kind: 'property',
      organization_id: null,
      authorization_hash: null,
      scope_receipt_id: null,
      scope_verified_at: null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export type PortfolioConversationPrepFailureReason =
  | 'not_found'
  | 'wrong_owner'
  | 'wrong_kind'
  | 'wrong_organization'
  | 'scope_changed'
  | 'invalid_scope_receipt'
  | 'scope_unavailable';

export type PortfolioConversationCreateFailureReason = Extract<
  PortfolioConversationPrepFailureReason,
  'scope_changed' | 'invalid_scope_receipt' | 'scope_unavailable'
>;

export type CreatePortfolioConversationResult =
  | { ok: true; conversationId: string }
  | { ok: false; reason: PortfolioConversationCreateFailureReason };

function normalizePortfolioPrepReason(
  value: unknown,
  fallback: PortfolioConversationPrepFailureReason,
): PortfolioConversationPrepFailureReason {
  switch (value) {
    case 'not_found':
    case 'wrong_owner':
    case 'wrong_kind':
    case 'wrong_organization':
    case 'scope_changed':
    case 'invalid_scope_receipt':
    case 'scope_unavailable':
      return value;
    default:
      return fallback;
  }
}

/**
 * Create an empty portfolio conversation under a freshly asserted receipt.
 * The question stays an RPC validation input only; 0399 persists user and
 * assistant rows together after the immutable query receipt exists.
 */
export async function createPortfolioConversation(opts: {
  userAccountId: string;
  propertyAnchorId: string;
  role: AppRole;
  promptVersion?: string;
  title?: string;
  organizationId: string;
  authorizationHash: string;
  scopeReceiptId: string;
  userMessage: string;
}): Promise<CreatePortfolioConversationResult> {
  const { data, error } = await supabaseAdmin.rpc('staxis_create_portfolio_conversation', {
    p_user_account_id: opts.userAccountId,
    p_property_anchor_id: opts.propertyAnchorId,
    p_role: opts.role,
    p_prompt_version: opts.promptVersion ?? null,
    p_title: opts.title ?? null,
    p_organization_id: opts.organizationId,
    p_authorization_hash: opts.authorizationHash,
    p_scope_receipt_id: opts.scopeReceiptId,
    p_user_message: opts.userMessage,
  });
  if (error) throw new Error(`createPortfolioConversation RPC failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('createPortfolioConversation returned no row');
  if (row.ok === true && typeof row.conversation_id === 'string') {
    return { ok: true, conversationId: row.conversation_id };
  }
  const reason = normalizePortfolioPrepReason(row.reason, 'invalid_scope_receipt');
  return {
    ok: false,
    reason: reason === 'scope_changed' || reason === 'scope_unavailable'
      ? reason
      : 'invalid_scope_receipt',
  };
}

/**
 * The company a conversation belongs to, plus the hotel it is anchored to —
 * both read from the stored row, never recomputed.
 *
 * Ownership is checked here so the caller cannot learn that somebody ELSE's
 * conversation is org-scoped: a row that is not yours is `null`, exactly as a
 * row that does not exist is.
 */
export async function loadConversationScope(
  conversationId: string,
  userAccountId: string,
): Promise<ConversationScope | null> {
  const { data, error } = await supabaseAdmin
    .from('agent_conversations')
    .select('id, user_id, property_id, role, prompt_version, conversation_kind, organization_id, authorization_hash, scope_receipt_id, scope_verified_at')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.user_id !== userAccountId) return null;
  const scope = conversationSecurityScopeFromRow(data);
  if (!scope) return null;
  return {
    ...scope,
    propertyId: data.property_id as string,
    role: data.role as AppRole,
    promptVersion: typeof data.prompt_version === 'string' ? data.prompt_version : null,
  };
}

export async function deleteConversation(
  conversationId: string,
  userAccountId: string,
  propertyId: string,
): Promise<boolean> {
  // The database re-checks ownership, active account state, current
  // authoritative property reach and conversation kind in the same statement.
  // Portfolio conversations are immutable through this ordinary hotel-chat
  // lifecycle so their receipt/turn-commit replay graph cannot be cascaded.
  const { data, error } = await supabaseAdmin.rpc('staxis_delete_property_conversation', {
    p_conversation_id: conversationId,
    p_user_account_id: userAccountId,
    p_property_id: propertyId,
  });
  if (error) throw error;
  return data === true;
}

export async function setConversationTitle(
  conversationId: string,
  userAccountId: string,
  title: string,
): Promise<boolean> {
  const { data: row } = await supabaseAdmin
    .from('agent_conversations')
    .select('user_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!row || row.user_id !== userAccountId) return false;
  const { error } = await supabaseAdmin
    .from('agent_conversations')
    .update({ title: title.slice(0, 200) })
    .eq('id', conversationId);
  if (error) throw error;
  return true;
}

// ─── Message persistence ──────────────────────────────────────────────────

export async function appendMessage(opts: SaveMessageOpts): Promise<void> {
  const { error } = await supabaseAdmin.from('agent_messages').insert({
    conversation_id: opts.conversationId,
    role: opts.role,
    content: opts.content ?? null,
    tool_call_id: opts.toolCallId ?? null,
    tool_name: opts.toolName ?? null,
    tool_args: opts.toolArgs ?? null,
    tool_result: opts.toolResult === undefined ? null : opts.toolResult,
    is_error: opts.isError ?? null,
    tokens_in: opts.tokensIn ?? null,
    tokens_out: opts.tokensOut ?? null,
    model_used: opts.modelUsed ?? null,
    cost_usd: opts.costUsd ?? null,
  });
  if (error) throw error;
}

/** Helper: write a user turn. Convenience wrapper. */
export function recordUserTurn(conversationId: string, content: string): Promise<void> {
  return appendMessage({ conversationId, role: 'user', content });
}

// ─── Companion offers ─────────────────────────────────────────────────────
//
// The companion's own turns — the daily hello, an offer, the receipt after a
// yes — stored as `role = 'system'` rows in the SAME conversation the panel
// shows. They live here rather than in a module of their own for one reason:
// this file is the only thing in the codebase that inserts into
// `agent_messages`, and that is worth more than the tidiness of a separate
// file. Everything else about them (the shape, the state machine, the codec)
// is pure and lives in src/lib/companion/offers.ts.
//
// WHY 'system' AND NOT 'assistant': the Messages API requires the first message
// in a conversation to be `user`, and the companion speaks before anybody has
// typed. `decodeStoredHistory` above has no branch for 'system', so these rows
// are invisible to the model replay by construction — not by a filter someone
// has to maintain. See the offers.ts header.

/**
 * The conversation the companion should speak into, creating one if needed.
 *
 * Prefers the conversation the panel already has open, so an offer lands in the
 * thread the person is looking at rather than starting a second one beside it.
 * `preferredId` is only honoured when it really belongs to this person at this
 * hotel — it arrives from a browser, so it is a request, not a fact.
 */
export async function ensureCompanionConversation(opts: {
  userAccountId: string;
  propertyId: string;
  role: AppRole;
  preferredId?: string | null;
  title?: string;
}): Promise<string | null> {
  if (opts.preferredId && UUID_RX.test(opts.preferredId)) {
    const { data } = await supabaseAdmin
      .from('agent_conversations')
      .select('id, user_id, property_id, conversation_kind')
      .eq('id', opts.preferredId)
      .maybeSingle();
    if (data
      && data.user_id === opts.userAccountId
      && data.property_id === opts.propertyId
      && data.conversation_kind === 'property') {
      return data.id as string;
    }
    // A conversation that is not theirs is not an error worth surfacing: the
    // companion simply opens its own rather than writing into somebody else's.
  }
  try {
    return await createConversation({
      userAccountId: opts.userAccountId,
      propertyId: opts.propertyId,
      role: opts.role,
      title: opts.title,
    });
  } catch {
    // An offer is a greeting, not a dependency. Failing to open a thread means
    // the sentence is not written down; it does not mean the companion breaks.
    return null;
  }
}

const OFFER_ROW_COLUMNS = 'id, content, tool_args, created_at';

/**
 * Write one companion turn into a conversation.
 *
 * `tool_name` is deliberately left NULL — the AI metrics route counts every row
 * with a non-null tool_name as a tool call, and these are sentences, not calls.
 */
export async function appendCompanionOffer(opts: {
  conversationId: string;
  text: string;
  kind: CompanionOfferKind;
  topic: string | null;
  page: string | null;
  /** Code-owned, built by whatever built the sentence. See replies.ts. The
   *  legacy `actions` list is derived from this inside encodeOfferPayload, so
   *  there is no second list here for the two to disagree through. */
  replies: readonly CompanionReply[];
  receipt?: CompanionOfferReceipt | null;
  now: Date;
}): Promise<CompanionOffer | null> {
  const spokenAt = opts.now.toISOString();
  const payload = encodeOfferPayload({
    kind: opts.kind,
    topic: opts.topic,
    page: opts.page,
    replies: opts.replies,
    // A receipt is a statement, not a question, so it is born resolved.
    state: opts.kind === 'receipt' ? 'accepted' : 'pending',
    spokenAt,
    answeredAt: opts.kind === 'receipt' ? spokenAt : null,
    receipt: opts.receipt ?? null,
  });
  const { data, error } = await supabaseAdmin
    .from('agent_messages')
    .insert({
      conversation_id: opts.conversationId,
      role: 'system',
      content: opts.text.slice(0, OFFER_TEXT_MAX),
      tool_name: null,
      tool_args: payload,
    })
    .select(OFFER_ROW_COLUMNS)
    .single();
  if (error) throw error;
  return parseOfferRow(data as Record<string, unknown>);
}

/** Every companion turn in a conversation, oldest first. */
export async function listCompanionOffers(conversationId: string): Promise<CompanionOffer[]> {
  const { data, error } = await supabaseAdmin
    .from('agent_messages')
    .select(OFFER_ROW_COLUMNS)
    .eq('conversation_id', conversationId)
    .eq('role', 'system')
    // Deliberately NOT filtered on `is_summarized`. The summarizer folds old
    // rows away from the model; an offer is for the PERSON, and "revisitable
    // forever" has to survive a conversation getting long.
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return sortOffers(
    (data ?? [])
      .map((row) => parseOfferRow(row as Record<string, unknown>))
      .filter((o): o is CompanionOffer => o !== null),
  );
}

/**
 * Stamp an answer onto one offer, or refuse.
 *
 * Returns null when the row is not this person's, is not an offer, or has
 * already been answered. The caller treats null as "do not touch the manners
 * ledger either", which is what makes a double-tap cost exactly one decline.
 */
export async function stampCompanionOffer(opts: {
  offerId: string;
  userAccountId: string;
  propertyId: string;
  answer: CompanionOfferAnswer;
  now: Date;
  receipt?: CompanionOfferReceipt | null;
}): Promise<CompanionOffer | null> {
  if (!UUID_RX.test(opts.offerId)) return null;
  const { data: row } = await supabaseAdmin
    .from('agent_messages')
    .select(`${OFFER_ROW_COLUMNS}, role, conversation_id, agent_conversations!inner(user_id, property_id)`)
    .eq('id', opts.offerId)
    .maybeSingle();
  if (!row || row.role !== 'system') return null;

  // The join is the ownership check: an offer id from a browser is only ever
  // stamped when the conversation under it belongs to this person at this hotel.
  const parent = row.agent_conversations as unknown as
    { user_id?: string; property_id?: string } | { user_id?: string; property_id?: string }[] | null;
  const owner = Array.isArray(parent) ? parent[0] : parent;
  if (!owner || owner.user_id !== opts.userAccountId || owner.property_id !== opts.propertyId) {
    return null;
  }

  const current = parseOfferRow(row as Record<string, unknown>);
  if (!current) return null;
  const next = answerOffer(current, opts.answer, opts.now.toISOString());
  if (!next) return null;

  const withReceipt: CompanionOffer = opts.receipt
    ? { ...next, receipt: opts.receipt }
    : next;

  const { error } = await supabaseAdmin
    .from('agent_messages')
    .update({
      tool_args: encodeOfferPayload({
        kind: withReceipt.kind,
        topic: withReceipt.topic,
        page: withReceipt.page,
        replies: withReceipt.replies,
        state: withReceipt.state,
        spokenAt: withReceipt.spokenAt,
        answeredAt: withReceipt.answeredAt,
        receipt: withReceipt.receipt,
      }),
    })
    .eq('id', opts.offerId)
    .eq('role', 'system')
    // The pending check again, in the WHERE clause this time.
    //
    // `answerOffer` above already refused a resolved offer, but that is a
    // read-then-write: two tabs, or a tap and its own retry, can both read
    // 'pending' and both proceed. Repeating the condition here moves the race
    // into Postgres, where exactly one UPDATE matches. Without it a single No
    // could be counted twice against a topic — and two is the number that
    // drops a topic for good, so the cost of losing this is a subject the
    // companion silently never raises again.
    .filter('tool_args->>state', 'eq', 'pending')
    .select('id');
  if (error) throw error;
  return withReceipt;
}

/** Helper: write an assistant turn (text + optional tool calls) atomically.
 *
 * Codex review fix #2 (2026-05-13): the previous implementation did
 * sequential `appendMessage` calls — if the text row succeeded but a
 * tool_use row failed, the conversation got orphan tool_results on the
 * next iteration. Now we call `staxis_record_assistant_turn` which writes
 * all rows in a single transaction. Throws on failure (no swallow) — the
 * caller MUST abort the stream and cancel the cost reservation if this
 * throws, otherwise tool_result rows will be persisted without their
 * matching tool_use and the conversation is corrupted.
 *
 * Defense-in-depth backlog cleanup, 2026-05-13: `modelId` (exact Anthropic
 * snapshot ID, e.g. 'claude-sonnet-4-6-20260427') is now persisted on
 * the assistant text row so individual turns can be correlated to model
 * snapshot releases — closes the audit-trail gap where agent_costs had
 * model_id but agent_messages only had the tier.
 */
export async function recordAssistantTurn(
  conversationId: string,
  text: string,
  toolCalls: AgentToolCall[] | undefined,
  telemetry: {
    tokensIn: number;
    tokensOut: number;
    modelUsed: ModelTier;
    modelId: string | null;
    costUsd: number;
    /** PROMPT_VERSION captured at the moment this turn was produced.
     *  Longevity L2a, 2026-05-13: persisted per-row so we can correlate
     *  quality regressions to specific prompt versions. */
    promptVersion: string;
  },
): Promise<void> {
  const { error } = await supabaseAdmin.rpc('staxis_record_assistant_turn', {
    p_conversation_id: conversationId,
    p_text: text ?? '',
    p_tool_calls: (toolCalls ?? []).map(c => ({
      id: c.id,
      name: c.name,
      args: c.args ?? {},
    })),
    p_tokens_in: telemetry.tokensIn,
    p_tokens_out: telemetry.tokensOut,
    p_model: telemetry.modelUsed,
    p_model_id: telemetry.modelId,
    p_cost_usd: telemetry.costUsd,
    p_prompt_version: telemetry.promptVersion,
  });
  if (error) {
    // Throw — caller is expected to catch, cancel the cost reservation,
    // and abort the stream rather than continuing into tool execution.
    throw new Error(`recordAssistantTurn failed: ${error.message}`);
  }
}

/** Helper: write a tool result row. L8B (2026-05-13): isError persisted
 *  so the metrics route can compute per-tool error rate. */
export function recordToolResult(
  conversationId: string,
  toolCallId: string,
  result: unknown,
  isError: boolean,
): Promise<void> {
  return appendMessage({
    conversationId,
    role: 'tool',
    toolCallId,
    toolResult: result,
    isError,
  });
}

/**
 * Insert a synthetic tool_result row for a tool_call_id that didn't get
 * a normal result before the stream aborted. Round-8 fix B7, 2026-05-13:
 * post-migration 0094 there's a partial unique index on
 * (conversation_id, tool_call_id) for role='tool' rows. If the normal
 * `recordToolResult` already landed earlier in the stream but the
 * route's finally still has the id in `pendingToolCallIds` (race),
 * a plain insert would throw a unique-violation. The route catches
 * and logs, producing noisy errors in prod for every abort path.
 *
 * Use ON CONFLICT DO NOTHING via supabase-js upsert so an existing row
 * is left untouched silently. Idempotent and cleaner in logs.
 */
export async function recordSyntheticAbortToolResult(
  conversationId: string,
  toolCallId: string,
  result: unknown,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('agent_messages')
    .upsert(
      {
        conversation_id: conversationId,
        role: 'tool',
        tool_call_id: toolCallId,
        tool_result: result ?? null,
        // L8B (2026-05-13): the synthetic abort is always an error case
        // (we never know what the tool would have returned, and the
        // user sees an abort message). Counts toward tool error rate.
        is_error: true,
      },
      {
        onConflict: 'conversation_id,tool_call_id',
        ignoreDuplicates: true,
      },
    );
  if (error) {
    throw new Error(`recordSyntheticAbortToolResult failed: ${error.message}`);
  }
}

/**
 * Atomic prep for /api/agent/command: acquire per-conversation lock,
 * verify ownership + property scope, load history, and record the user
 * turn — all in ONE RPC transaction.
 *
 * Codex round-7 fix F2: replaces the prior two-step pattern (call
 * staxis_lock_conversation, then loadConversation + recordUserTurn in
 * JS) which had a race window because supabase-js wraps each .rpc() in
 * its own transaction. The lock from the first call released BEFORE
 * the JS prep ran. This RPC does everything under one tx + lock.
 */
export interface LockedPrepResult {
  ok: boolean;
  reason: 'not_found' | 'wrong_owner' | 'wrong_property' | 'wrong_kind' | null;
  history: AgentMessage[];
}

export async function lockLoadAndRecordUserTurn(opts: {
  conversationId: string;
  userAccountId: string;
  propertyId: string;
  userMessage: string;
}): Promise<LockedPrepResult> {
  const { data, error } = await supabaseAdmin.rpc('staxis_lock_load_and_record_user_turn', {
    p_conversation_id: opts.conversationId,
    p_user_account_id: opts.userAccountId,
    p_property_id: opts.propertyId,
    p_user_message: opts.userMessage,
  });
  if (error) throw new Error(`lockLoadAndRecordUserTurn RPC failed: ${error.message}`);

  // RPC returns table(ok, reason, history_rows) — supabase-js gives an array.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('lockLoadAndRecordUserTurn returned no row');

  if (!row.ok) {
    const reason = row.reason === 'not_found'
      || row.reason === 'wrong_owner'
      || row.reason === 'wrong_property'
      || row.reason === 'wrong_kind'
      ? row.reason
      : null;
    return {
      ok: false,
      reason,
      history: [],
    };
  }

  return {
    ok: true,
    reason: null,
    history: decodeStoredHistory((row.history_rows ?? []) as StoredHistoryRow[]),
  };
}

export interface PortfolioLockedPrepResult {
  ok: boolean;
  reason: PortfolioConversationPrepFailureReason | null;
  history: AgentMessage[];
  historyWindow: PortfolioHistoryWindowV1 | null;
}

/**
 * Atomic portfolio continuation. The DB asserts the fresh receipt and compares
 * its current selector-independent authorizationHash to the immutable hash on
 * the conversation before committed history is selected. The prep RPC performs
 * no message write: a failed provider/receipt/authorization step leaves no row
 * that could enter a later model replay. A different selected subset/portfolio
 * is allowed because scopeHash is not a conversation identity field.
 */
export async function lockLoadAndRecordPortfolioUserTurn(opts: {
  conversationId: string;
  userAccountId: string;
  organizationId: string;
  authorizationHash: string;
  scopeReceiptId: string;
  userMessage: string;
}): Promise<PortfolioLockedPrepResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_lock_load_and_record_portfolio_user_turn',
    {
      p_conversation_id: opts.conversationId,
      p_user_account_id: opts.userAccountId,
      p_organization_id: opts.organizationId,
      p_authorization_hash: opts.authorizationHash,
      p_scope_receipt_id: opts.scopeReceiptId,
      p_user_message: opts.userMessage,
    },
  );
  if (error) {
    throw new Error(`lockLoadAndRecordPortfolioUserTurn RPC failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('lockLoadAndRecordPortfolioUserTurn returned no row');
  if (row.ok !== true) {
    return {
      ok: false,
      reason: normalizePortfolioPrepReason(row.reason, 'scope_unavailable'),
      history: [],
      historyWindow: null,
    };
  }
  const decoded = decodePortfolioHistoryWindow({
    historyRows: row.history_rows,
    historyMeta: row.history_meta,
  });
  return {
    ok: true,
    reason: null,
    history: decoded.history,
    historyWindow: decoded.metadata,
  };
}

export type PortfolioConversationCommitFailureReason =
  | 'not_found'
  | 'scope_changed'
  | 'scope_unavailable'
  | 'invalid_receipt'
  | 'question_mismatch'
  | 'answer_mismatch'
  | 'invalid_turn'
  | 'idempotency_conflict';

export type CommitPortfolioConversationTurnResult =
  | {
      ok: true;
      reason: 'committed' | 'already_committed';
      userMessageId: string;
      assistantMessageId: string;
    }
  | { ok: false; reason: PortfolioConversationCommitFailureReason };

function portfolioCommitFailureReason(value: unknown): PortfolioConversationCommitFailureReason {
  switch (value) {
    case 'not_found':
    case 'scope_changed':
    case 'scope_unavailable':
    case 'invalid_receipt':
    case 'question_mismatch':
    case 'answer_mismatch':
    case 'invalid_turn':
    case 'idempotency_conflict':
      return value;
    default:
      return 'invalid_receipt';
  }
}

/**
 * The only portfolio message writer after 0399. PostgreSQL reasserts current
 * account/company scope, binds the exact completed/partial/abstained query receipt, then
 * inserts user + assistant + commit link atomically. A retry with the same
 * receipt/text is idempotent; different content fails closed.
 */
export async function commitPortfolioConversationTurn(opts: {
  conversationId: string;
  userAccountId: string;
  organizationId: string;
  authorizationHash: string;
  scopeReceiptId: string;
  queryReceiptId: string;
  userMessage: string;
  assistantText: string;
  tokensIn: number;
  tokensOut: number;
  modelUsed: ModelTier | 'deterministic';
  modelId: string | null;
  costUsd: number;
  promptVersion: string;
}): Promise<CommitPortfolioConversationTurnResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_commit_portfolio_conversation_turn',
    {
      p_conversation_id: opts.conversationId,
      p_user_account_id: opts.userAccountId,
      p_organization_id: opts.organizationId,
      p_authorization_hash: opts.authorizationHash,
      p_scope_receipt_id: opts.scopeReceiptId,
      p_query_receipt_id: opts.queryReceiptId,
      p_user_message: opts.userMessage,
      p_assistant_text: opts.assistantText,
      p_tokens_in: opts.tokensIn,
      p_tokens_out: opts.tokensOut,
      p_model: opts.modelUsed,
      p_model_id: opts.modelId,
      p_cost_usd: opts.costUsd,
      p_prompt_version: opts.promptVersion,
    },
  );
  if (error) throw new Error(`commitPortfolioConversationTurn RPC failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)) throw new Error('commitPortfolioConversationTurn returned no result');
  if (row.ok === true
    && (row.reason === 'committed' || row.reason === 'already_committed')
    && typeof row.userMessageId === 'string'
    && UUID_RX.test(row.userMessageId)
    && typeof row.assistantMessageId === 'string'
    && UUID_RX.test(row.assistantMessageId)) {
    return {
      ok: true,
      reason: row.reason,
      userMessageId: row.userMessageId,
      assistantMessageId: row.assistantMessageId,
    };
  }
  return { ok: false, reason: portfolioCommitFailureReason(row.reason) };
}
