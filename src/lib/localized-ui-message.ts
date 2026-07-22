export type LocalizedMessagePair = readonly [english: string, spanish: string];

// Async UI state often needs to keep a string without making language part of
// the request effect's dependencies. Re-localize only messages the client owns;
// opaque server-provided messages pass through unchanged.
export function localizeKnownMessage(
  message: string,
  lang: string,
  pairs: readonly LocalizedMessagePair[],
): string;
export function localizeKnownMessage(
  message: string | null,
  lang: string,
  pairs: readonly LocalizedMessagePair[],
): string | null;
export function localizeKnownMessage(
  message: string | null,
  lang: string,
  pairs: readonly LocalizedMessagePair[],
): string | null {
  if (!message) return message;
  const pair = pairs.find(([english, spanish]) => message === english || message === spanish);
  if (!pair) return message;
  return lang === 'es' ? pair[1] : pair[0];
}
