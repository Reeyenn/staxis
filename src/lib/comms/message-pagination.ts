import type { MessageDTO } from './types';

export const MESSAGE_PAGE_SIZE = 80;

export interface MessageCursor {
  before: string;
  beforeId: string;
}

/**
 * Quote a PostgREST filter value. The `.or()` builder receives filter grammar,
 * so ISO timestamps must be quoted before URLSearchParams encodes the request:
 * both `.` and `:` are meaningful to the filter grammar.
 */
function quotePostgrestFilterValue(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/** Build the tie-safe PostgREST boundary used by both message clients. */
export function compositeMessageCursorFilter(cursor: MessageCursor): string {
  const before = quotePostgrestFilterValue(cursor.before);
  return `created_at.lt.${before},and(created_at.eq.${before},id.lt.${cursor.beforeId})`;
}

export interface MessagePaginationDTO {
  hasOlder: boolean;
  nextCursor: MessageCursor | null;
}

export interface MessagesPageDTO {
  messages: MessageDTO[];
  pagination: MessagePaginationDTO;
}

/** The stable fields used to order and page a message row. */
export interface MessageBoundaryRow {
  id: string;
  created_at: string;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Newest first, with the id making equal timestamps deterministic. */
export function compareMessageRowsNewestFirst(
  a: MessageBoundaryRow,
  b: MessageBoundaryRow,
): number {
  const timeOrder = timestampMs(b.created_at) - timestampMs(a.created_at);
  return timeOrder || b.id.localeCompare(a.id);
}

/** Oldest first, with the id making equal timestamps deterministic. */
export function compareMessageRowsOldestFirst(
  a: MessageBoundaryRow,
  b: MessageBoundaryRow,
): number {
  return -compareMessageRowsNewestFirst(a, b);
}

function rowIsBeforeCursor(
  row: MessageBoundaryRow,
  cursor: Partial<MessageCursor>,
): boolean {
  const rowTime = timestampMs(row.created_at);
  const cursorTime = timestampMs(cursor.before ?? '');
  if (rowTime !== cursorTime) return rowTime < cursorTime;
  // A timestamp-only cursor remains supported for compatibility. It cannot
  // safely include a tie, so only the composite cursor advances through ties.
  return typeof cursor.beforeId === 'string' ? row.id.localeCompare(cursor.beforeId) < 0 : false;
}

/**
 * Page an in-memory set using the same composite boundary as the database
 * query. This is also the faithful behavior model used by pagination tests.
 */
export function paginateMessageRows<T extends MessageBoundaryRow>(
  rows: readonly T[],
  cursor: Partial<MessageCursor> | null = null,
  limit = MESSAGE_PAGE_SIZE,
): { rows: T[]; pagination: MessagePaginationDTO } {
  const ordered = [...rows].sort(compareMessageRowsNewestFirst);
  const eligible = cursor?.before
    ? ordered.filter((row) => rowIsBeforeCursor(row, cursor))
    : ordered;
  const page = eligible.slice(0, limit);
  const boundary = page[page.length - 1];
  return {
    rows: page,
    pagination: {
      hasOlder: eligible.length > page.length,
      nextCursor: boundary
        ? { before: boundary.created_at, beforeId: boundary.id }
        : null,
    },
  };
}

/** Build truthful metadata from the bounded base query, before ack expansion. */
export function messagePaginationForBaseRows(
  rows: readonly MessageBoundaryRow[],
  limit = MESSAGE_PAGE_SIZE,
): MessagePaginationDTO {
  const boundary = rows[rows.length - 1];
  return {
    // A full bounded result means the database may have another page. The
    // next request will make the definitive empty-page check.
    hasOlder: rows.length >= limit,
    nextCursor: boundary
      ? { before: boundary.created_at, beforeId: boundary.id }
      : null,
  };
}

/** Merge rows for chronological display while replacing duplicate ids. */
export function mergeMessageRowsChronologically<T extends MessageBoundaryRow>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort(compareMessageRowsOldestFirst);
}

export interface MessageScrollAnchor {
  messageId: string;
  relativeTop: number;
}

function messageElementForId(container: HTMLElement, messageId: string): HTMLElement | null {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
    .find((element) => element.dataset.messageId === messageId) ?? null;
}

/** Capture a visible message identity and its position inside a scroll box. */
export function captureMessageScrollAnchor(container: HTMLElement): MessageScrollAnchor | null {
  const boxTop = container.getBoundingClientRect().top;
  const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
  const element = elements.find((candidate) => candidate.getBoundingClientRect().bottom >= boxTop)
    ?? elements[0];
  const messageId = element?.dataset.messageId;
  if (!element || !messageId) return null;
  return {
    messageId,
    relativeTop: element.getBoundingClientRect().top - boxTop,
  };
}

/** Restore the captured identity's position after older rows are prepended. */
export function restoreMessageScrollAnchor(
  container: HTMLElement,
  anchor: MessageScrollAnchor,
): boolean {
  const element = messageElementForId(container, anchor.messageId);
  if (!element) return false;
  const boxTop = container.getBoundingClientRect().top;
  const currentRelativeTop = element.getBoundingClientRect().top - boxTop;
  container.scrollTop += currentRelativeTop - anchor.relativeTop;
  return true;
}

/** Merge server pages without losing older history or duplicating a message. */
export function mergeMessagesChronologically(
  existing: MessageDTO[],
  incoming: MessageDTO[],
): MessageDTO[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => {
    const timeOrder = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return timeOrder || a.id.localeCompare(b.id);
  });
}
