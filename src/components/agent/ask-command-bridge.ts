// The Home hero can become interactive before the dynamically imported global
// Ask Staxis bar has mounted its event listener. Keep the newest command on the
// window until a subscriber consumes it so a cold chunk load cannot silently
// drop what the user typed. A single slot intentionally coalesces rapid retries
// while the bar is booting instead of starting concurrent agent runs.

export const ASK_EVENT = 'staxis:ask';

const PENDING_ASK_KEY = '__staxisPendingAskCommand';

type AskCommandWindow = Window & {
  [PENDING_ASK_KEY]?: string;
};

function pendingTarget(target: Window): AskCommandWindow {
  return target as AskCommandWindow;
}

export function dispatchAskCommand(rawText: string, target: Window = window): boolean {
  const text = rawText.trim();
  if (!text) return false;
  pendingTarget(target)[PENDING_ASK_KEY] = text;
  target.dispatchEvent(new Event(ASK_EVENT));
  return true;
}

export function subscribeToAskCommands(
  onCommand: (text: string) => void,
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
    delete store[PENDING_ASK_KEY];
    onCommand(text);
  };

  const onAsk = (event: Event) => deliverPending(event);
  target.addEventListener(ASK_EVENT, onAsk);
  deliverPending();
  return () => target.removeEventListener(ASK_EVENT, onAsk);
}
