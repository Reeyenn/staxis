// Queue-count broadcast — the pill-bar badge listens for this event so it
// always mirrors what the Staxis approval queue actually shows.

export const QUEUE_COUNT_EVENT = 'staxis:queue-count';

export function broadcastQueueCount(pending: number) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(QUEUE_COUNT_EVENT, { detail: { pending } }));
}
