// The Home hero can become interactive before the dynamically imported global
// Ask Staxis bar has mounted its event listener. Keep the newest command on the
// window until a subscriber consumes it so a cold chunk load cannot silently
// drop what the user typed. A single slot intentionally coalesces rapid retries
// while the bar is booting instead of starting concurrent agent runs.

export const ASK_EVENT = 'staxis:ask';

/**
 * "Wake up, but do not say anything yet."
 *
 * The companion bubble docks INTO this bar rather than running a second chat,
 * so opening the companion has to be able to open the bar without inventing a
 * first message on the person's behalf. A separate event rather than an empty
 * command: `dispatchAskCommand('')` already means "nothing to send", and
 * overloading it would make an accidental empty submit open the chat.
 */
export const ASK_OPEN_EVENT = 'staxis:ask-open';

const PENDING_ASK_KEY = '__staxisPendingAskCommand';

/**
 * Which surface a queued command came from.
 *
 * Rides alongside the text rather than inside it, and travels no further than
 * the POST body, where it selects the AI Control Center slot that governs the
 * model and carries the cost. It grants nothing: see the `origin` note on the
 * request body in /api/agent/command.
 */
export type AskOrigin = 'companion';

const PENDING_ORIGIN_KEY = '__staxisPendingAskOrigin';

type AskCommandWindow = Window & {
  [PENDING_ASK_KEY]?: string;
  [PENDING_ORIGIN_KEY]?: AskOrigin;
};

function pendingTarget(target: Window): AskCommandWindow {
  return target as AskCommandWindow;
}

export function dispatchAskCommand(
  rawText: string,
  target: Window = window,
  origin?: AskOrigin,
): boolean {
  const text = rawText.trim();
  if (!text) return false;
  const store = pendingTarget(target);
  store[PENDING_ASK_KEY] = text;
  if (origin) store[PENDING_ORIGIN_KEY] = origin;
  else delete store[PENDING_ORIGIN_KEY];
  target.dispatchEvent(new Event(ASK_EVENT));
  return true;
}

/** Open the chat with nothing queued. Used by the companion bubble. */
export function dispatchAskOpen(target: Window = window): void {
  target.dispatchEvent(new Event(ASK_OPEN_EVENT));
}

export function subscribeToAskOpen(onOpen: () => void, target: Window = window): () => void {
  const handler = () => onOpen();
  target.addEventListener(ASK_OPEN_EVENT, handler);
  return () => target.removeEventListener(ASK_OPEN_EVENT, handler);
}

export function subscribeToAskCommands(
  onCommand: (text: string, origin?: AskOrigin) => void,
  target: Window = window,
): () => void {
  const deliverPending = (event?: Event) => {
    const store = pendingTarget(target);
    const detail = event && 'detail' in event
      ? (event as Event & { detail?: { text?: unknown } }).detail
      : undefined;
    const legacyText = typeof detail?.text === 'string'
      ? detail.text.trim()
      : '';
    if (!store[PENDING_ASK_KEY] && legacyText) store[PENDING_ASK_KEY] = legacyText;
    const text = store[PENDING_ASK_KEY];
    if (!text) return;
    const origin = store[PENDING_ORIGIN_KEY];
    delete store[PENDING_ASK_KEY];
    delete store[PENDING_ORIGIN_KEY];
    onCommand(text, origin);
  };

  const onAsk = (event: Event) => deliverPending(event);
  target.addEventListener(ASK_EVENT, onAsk);
  deliverPending();
  return () => target.removeEventListener(ASK_EVENT, onAsk);
}
