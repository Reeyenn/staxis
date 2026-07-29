import type { AgentMessage } from '@/lib/agent/llm';

/**
 * Portfolio replay is deliberately smaller than the provider context window.
 * The byte budget is an application cost/latency boundary, not a model limit.
 */
export const PORTFOLIO_HISTORY_WINDOW_VERSION = 'portfolio-history-window.v1' as const;
export const PORTFOLIO_HISTORY_MAX_TURNS = 24;
export const PORTFOLIO_HISTORY_MAX_UTF8_BYTES = 65_536;

/** Conservative allowance for the two role/content envelopes around a turn. */
export const PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES = 128;

/** These limits are repeated in migration 0397 at the durable write boundary. */
export const PORTFOLIO_USER_MESSAGE_MAX_CHARS = 4_000;
export const PORTFOLIO_USER_MESSAGE_MAX_UTF8_BYTES = 16_000;
export const PORTFOLIO_ASSISTANT_MESSAGE_MAX_UTF8_BYTES = 49_000;

export const PORTFOLIO_MAX_COMPLETE_TURN_REPLAY_BYTES =
  PORTFOLIO_USER_MESSAGE_MAX_UTF8_BYTES
  + PORTFOLIO_ASSISTANT_MESSAGE_MAX_UTF8_BYTES
  + PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES;

export interface PortfolioHistoryWindowV1 {
  version: typeof PORTFOLIO_HISTORY_WINDOW_VERSION;
  maxTurns: typeof PORTFOLIO_HISTORY_MAX_TURNS;
  maxUtf8Bytes: typeof PORTFOLIO_HISTORY_MAX_UTF8_BYTES;
  turnOverheadUtf8Bytes: typeof PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES;
  totalTurnCount: number;
  includedTurnCount: number;
  omittedTurnCount: number;
  /** Content UTF-8 bytes plus the fixed per-turn framing allowance. */
  totalUtf8Bytes: number;
  /** Content UTF-8 bytes plus the fixed per-turn framing allowance. */
  includedUtf8Bytes: number;
  /** Content UTF-8 bytes plus the fixed per-turn framing allowance. */
  omittedUtf8Bytes: number;
}

interface PortfolioStoredHistoryRow {
  role: unknown;
  content: unknown;
  tool_call_id: unknown;
  tool_name: unknown;
  tool_args: unknown;
  tool_result: unknown;
  is_summary: unknown;
}

const HISTORY_ROW_KEYS = Object.freeze([
  'role',
  'content',
  'tool_call_id',
  'tool_name',
  'tool_args',
  'tool_result',
  'is_summary',
]);

const HISTORY_META_KEYS = Object.freeze([
  'version',
  'maxTurns',
  'maxUtf8Bytes',
  'turnOverheadUtf8Bytes',
  'totalTurnCount',
  'includedTurnCount',
  'omittedTurnCount',
  'totalUtf8Bytes',
  'includedUtf8Bytes',
  'omittedUtf8Bytes',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('portfolio history window is not valid JSON');
  }
}

function parseHistoryMeta(raw: unknown): PortfolioHistoryWindowV1 {
  const value = parseJsonValue(raw);
  if (!isRecord(value) || !hasExactKeys(value, HISTORY_META_KEYS)) {
    throw new Error('portfolio history window metadata has an invalid shape');
  }
  if (value.version !== PORTFOLIO_HISTORY_WINDOW_VERSION
      || value.maxTurns !== PORTFOLIO_HISTORY_MAX_TURNS
      || value.maxUtf8Bytes !== PORTFOLIO_HISTORY_MAX_UTF8_BYTES
      || value.turnOverheadUtf8Bytes !== PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES) {
    throw new Error('portfolio history window metadata has an unsupported contract');
  }
  for (const key of [
    'totalTurnCount',
    'includedTurnCount',
    'omittedTurnCount',
    'totalUtf8Bytes',
    'includedUtf8Bytes',
    'omittedUtf8Bytes',
  ] as const) {
    if (!safeNonNegativeInteger(value[key])) {
      throw new Error(`portfolio history window metadata has invalid ${key}`);
    }
  }
  const metadata = value as unknown as PortfolioHistoryWindowV1;
  if (metadata.totalTurnCount !== metadata.includedTurnCount + metadata.omittedTurnCount
      || metadata.totalUtf8Bytes !== metadata.includedUtf8Bytes + metadata.omittedUtf8Bytes
      || metadata.includedTurnCount > PORTFOLIO_HISTORY_MAX_TURNS
      || metadata.includedUtf8Bytes > PORTFOLIO_HISTORY_MAX_UTF8_BYTES
      || (metadata.totalTurnCount > 0 && metadata.includedTurnCount === 0)
      || metadata.includedUtf8Bytes
        < metadata.includedTurnCount * PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES
      || metadata.omittedUtf8Bytes
        < metadata.omittedTurnCount * PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES) {
    throw new Error('portfolio history window metadata is internally inconsistent');
  }
  return metadata;
}

/**
 * Revalidate the database-bounded portfolio replay immediately before provider
 * use. This parser accepts only the complete user/assistant pairs emitted by
 * the receipt-backed 0397 RPC; summaries and tool rows are not portfolio
 * replay authority.
 */
export function decodePortfolioHistoryWindow(input: {
  historyRows: unknown;
  historyMeta: unknown;
}): { history: AgentMessage[]; metadata: PortfolioHistoryWindowV1 } {
  const parsedRows = parseJsonValue(input.historyRows);
  if (!Array.isArray(parsedRows)) {
    throw new Error('portfolio history rows are not an array');
  }
  const metadata = parseHistoryMeta(input.historyMeta);
  if (parsedRows.length !== metadata.includedTurnCount * 2) {
    throw new Error('portfolio history row count does not match its window receipt');
  }

  const history: AgentMessage[] = [];
  let replayBytes = 0;
  for (let index = 0; index < parsedRows.length; index += 1) {
    const value = parsedRows[index];
    if (!isRecord(value) || !hasExactKeys(value, HISTORY_ROW_KEYS)) {
      throw new Error('portfolio history contains an invalid row shape');
    }
    const row = value as unknown as PortfolioStoredHistoryRow;
    const expectedRole = index % 2 === 0 ? 'user' : 'assistant';
    if (row.role !== expectedRole
        || typeof row.content !== 'string'
        || row.content.trim().length === 0
        || row.tool_call_id !== null
        || row.tool_name !== null
        || row.tool_args !== null
        || row.tool_result !== null
        || row.is_summary !== false) {
      throw new Error('portfolio history contains a non-canonical complete turn');
    }
    const contentBytes = Buffer.byteLength(row.content, 'utf8');
    if ((expectedRole === 'user'
          && (contentBytes > PORTFOLIO_USER_MESSAGE_MAX_UTF8_BYTES
            || [...row.content].length > PORTFOLIO_USER_MESSAGE_MAX_CHARS))
        || (expectedRole === 'assistant'
          && contentBytes > PORTFOLIO_ASSISTANT_MESSAGE_MAX_UTF8_BYTES)) {
      throw new Error('portfolio history contains an oversized complete turn');
    }
    history.push({ role: expectedRole, content: row.content });
    replayBytes += contentBytes;
    if (expectedRole === 'assistant') {
      replayBytes += PORTFOLIO_HISTORY_TURN_OVERHEAD_UTF8_BYTES;
    }
  }
  if (replayBytes !== metadata.includedUtf8Bytes) {
    throw new Error('portfolio history byte count does not match its window receipt');
  }
  return { history, metadata };
}
