import type { MessageDTO } from './types';

export const MESSAGE_PAGE_SIZE = 80;

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
