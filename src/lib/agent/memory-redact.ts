// ─── Memory PII redaction ───────────────────────────────────────────────────
// Memory content originates from untrusted user speech/chat. Before we persist
// it, mask contact PII so the copilot's long-term store never becomes a place
// guest phone numbers / emails / card or ID numbers accumulate. This is
// defense-in-depth (the `remember` tool description also tells the model not to
// store guest PII, and hotel-scope writes are management-only) — regex masking
// is imperfect by nature, so it is one layer, not the only one.
//
// Patterns mirror src/lib/sentry-scrub.ts (PHONE_RX / EMAIL_RX) so memory and
// log scrubbing stay consistent, plus card-ish and SSN-ish sequences. We MASK
// rather than reject: a fact like "call the plumber at [phone]" is still useful,
// and vendor contact details belong in the Knowledge hub, not memory.

const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN_RX = /\b\d{3}-\d{2}-\d{4}\b/g;
// 13–19 digit runs (optionally space/dash grouped) — credit-card-ish.
const CARD_RX = /\b(?:\d[ -]?){13,19}\b/g;
// US phone shapes (mirror sentry-scrub.ts PHONE_RX).
const PHONE_RX = /(?:\+1\d{10}|\+1[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{4}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/g;

export interface RedactResult {
  /** The content with contact PII masked. */
  content: string;
  /** True when at least one mask was applied. */
  redacted: boolean;
}

/**
 * Mask contact PII (emails, SSNs, card-ish numbers, phones) in a memory string.
 * Order matters: e-mail and the dashed SSN shape run before the broad card/phone
 * digit matchers so they win their overlaps.
 */
export function redactMemoryContent(input: string): RedactResult {
  let out = input;
  out = out.replace(EMAIL_RX, '[email]');
  out = out.replace(SSN_RX, '[id]');
  out = out.replace(CARD_RX, '[number]');
  out = out.replace(PHONE_RX, '[phone]');
  return { content: out, redacted: out !== input };
}
