/**
 * STOP/START/language classification for inbound Twilio SMS replies.
 *
 * Comms-voice audit P1 (2026-05-22). Extracted from route.ts so the
 * classification can be unit-tested in isolation without standing up the
 * full webhook plumbing (signature verification, dedup, rate limit, staff
 * lookup).
 *
 * Behavior expected by the route:
 *
 *   - normalise() (in route.ts) already trims, uppercases, and strips
 *     punctuation `[.!?¿¡,;:()"'\`]`. It does NOT strip whitespace, so
 *     multi-word replies like "PARA MAÑANA" survive intact and do not
 *     match the single-word STOP set.
 *
 *   - classifyReply() returns 'STOP' / 'START' / 'EN' / 'ES' / 'other' /
 *     'unparsed' on exact-set equality against the normalised input.
 *
 *   - On 'STOP' / 'START', the route logs the event and returns an empty
 *     TwiML body — we do NOT send any further outbound SMS for that
 *     webhook. Twilio's carrier-side processor handles future blocking
 *     (terminal code 21610) for managed numbers.
 *
 * English STOP keywords are listed for defense-in-depth: Twilio's
 * carrier-side processor consumes them on managed numbers before they
 * reach our webhook in most cases, but unverified toll-free flows and
 * Spanish keywords (PARA / ALTO / CANCELAR) pass through unfiltered.
 */

export const ES_SET = new Set(['ESPANOL', 'ESPAÑOL', 'SPANISH', 'ESP']);
export const EN_SET = new Set(['ENGLISH', 'INGLES', 'INGLÉS', 'EN']);

export const STOP_SET = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
  'PARA', 'ALTO', 'CANCELAR',
]);

export const START_SET = new Set(['START', 'UNSTOP', 'YES', 'SI', 'SÍ']);

export type ReplyClass = 'STOP' | 'START' | 'EN' | 'ES' | 'other' | 'unparsed';

export function classifyReply(normalised: string | null | undefined): ReplyClass {
  if (!normalised) return 'unparsed';
  if (STOP_SET.has(normalised)) return 'STOP';
  if (START_SET.has(normalised)) return 'START';
  if (EN_SET.has(normalised)) return 'EN';
  if (ES_SET.has(normalised)) return 'ES';
  return 'other';
}

/**
 * Same string normalisation the route uses to prepare a reply for
 * classification. Exposed here so tests can chain `classifyReply(normaliseReply(raw))`
 * without duplicating the regex.
 */
export function normaliseReply(text: string): string {
  return text.trim().toUpperCase().replace(/[.!?¿¡,;:()"'`]/g, '').trim();
}
