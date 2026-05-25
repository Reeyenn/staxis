/**
 * Pure-function classifier for inbound SMS texts that should trigger
 * a sick callout. Extracted from the route handler so it can be
 * unit-tested without standing up Twilio signature validation or
 * staff lookup plumbing.
 *
 * Triggers: SICK, OUT, ENFERMO, ENFERMA, FUERA (case-insensitive,
 * surrounding punctuation stripped). The hotel's Twilio number is
 * shared with shift-confirmation replies (ENGLISH/ESPAÑOL), so this
 * classifier returns 'not_callout' for anything that isn't an
 * unambiguous callout intent — the calling route falls through to
 * the normal shift-reply handler in that case.
 *
 * The Spanish triggers cover the most common ways a Mexican/Latin-
 * American Spanish speaker would text "I'm sick" in a short SMS.
 * "ENFERMO" (m), "ENFERMA" (f), and "FUERA" ("out") are the three
 * we've heard from real housekeepers in the Comfort Suites pilot.
 *
 * Optional reason hints — if the text contains a reason keyword after
 * the trigger ("SICK FAMILY", "OUT PERSONAL"), we capture the reason
 * tag. Anything not in the explicit set becomes 'other' with the raw
 * text preserved in the note. Keep this conservative — false positives
 * here mean a normal "yes I'll work" reply triggers a callout, which
 * is much worse than a missed reason tag.
 */

import type { CalloutReason } from './types';

export type CalloutSmsClass =
  | { kind: 'callout'; reason: CalloutReason | null; note: string | null }
  | { kind: 'not_callout' };

const CALLOUT_TRIGGERS = new Set([
  'SICK',
  'OUT',
  'ENFERMO',
  'ENFERMA',
  'FUERA',
]);

const REASON_KEYWORDS: Record<string, CalloutReason> = {
  SICK: 'sick',
  ENFERMO: 'sick',
  ENFERMA: 'sick',
  FAMILY: 'family',
  FAMILIA: 'family',
  EMERGENCY: 'family',
  EMERGENCIA: 'family',
  PERSONAL: 'personal',
  PERSONA: 'personal',
};

/**
 * Match the housekeeper page normaliser shape (sms-reply/route.ts) so a
 * "SICK." or "Sick !" hits the same lookup. Whitespace is preserved so
 * "SICK FAMILY" can split into tokens for reason extraction.
 */
export function normaliseCalloutText(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[.!?¿¡,;:()"'`]/g, '')
    .trim();
}

export function classifyCalloutSms(rawText: string | null | undefined): CalloutSmsClass {
  if (!rawText) return { kind: 'not_callout' };
  const normalised = normaliseCalloutText(rawText);
  if (!normalised) return { kind: 'not_callout' };

  // Tokenise on whitespace so multi-word messages like "SICK FAMILY"
  // or "FUERA PERSONAL" can carry a reason hint. We deliberately do
  // NOT match triggers inside longer words: "PICKING UP" should not
  // trigger off "PICKING" containing the letters of "SICK".
  const tokens = normalised.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'not_callout' };

  // The first token must be an exact trigger. This prevents a normal
  // confirmation reply ("YES SICK") from accidentally being read as a
  // callout — the housekeeper would have led with "SICK" if they meant
  // to call out.
  const head = tokens[0];
  if (!CALLOUT_TRIGGERS.has(head)) return { kind: 'not_callout' };

  // Reason extraction — first reason-keyword token after the trigger wins.
  // The leading trigger itself counts as a 'sick' reason when it's SICK
  // or ENFERMO/A; otherwise reason is null (caller can promote to 'other').
  let reason: CalloutReason | null = null;
  if (head === 'SICK' || head === 'ENFERMO' || head === 'ENFERMA') {
    reason = 'sick';
  }
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (REASON_KEYWORDS[t]) {
      reason = REASON_KEYWORDS[t];
      break;
    }
  }

  // Preserve any extra text the housekeeper wrote ("SICK FEVER 102")
  // as a note for the manager. Cap at 200 chars so a runaway text
  // can't bloat the audit row.
  const noteRaw = tokens.slice(1).join(' ').slice(0, 200);
  const note = noteRaw.length > 0 ? noteRaw : null;

  return { kind: 'callout', reason, note };
}
