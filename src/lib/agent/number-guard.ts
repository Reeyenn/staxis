// ─── The number-honesty guard (chat) ─────────────────────────────────────────
//
// A manager trusts a chat answer exactly as much as they trust a card. Until
// this file, only the card had earned it.
//
// WHY THIS EXISTS
// Three number paths reach a manager, and two of them were already sealed:
//
//   • CARDS      — `findings/prose-guard.ts`. The model cannot type a digit at
//                  all: it writes `{work_orders}` and code substitutes the
//                  value of that field. Slot mode. Physically unfakeable.
//   • PORTFOLIO  — derived metrics (totals, outliers, per-hotel shares) are
//                  computed in code and handed to the model as finished
//                  strings, so the model quotes rather than calculates.
//   • CHAT       — free prose. The model reads tool results and writes
//                  sentences. It can misquote a count, invent a derived figure
//                  ("that's about 30% of your budget"), or average something
//                  wrong, and nothing looked. This file is the something.
//
// WHY NOT SLOTS
// Slots work on a card because a card IS one templated sentence. A conversation
// is not templatable — "answer the question the manager actually asked" has no
// slot skeleton — so the guard here has to be a CHECK ON THE ANSWER rather than
// a cage around the phrasing. That is a weaker instrument and this file says so
// out loud rather than implying parity with the card path.
//
// ═══ THE CONTRACT ═══════════════════════════════════════════════════════════
//
//   A number in the answer must have been PUT IN FRONT OF THE MODEL — by the
//   runtime (the system prompt, which carries the hotel snapshot, this hotel's
//   confirmed facts and its company rulebook), by a tool (this turn's results,
//   or an earlier turn's, which are code-produced data), or by the USER
//   (anything they typed). A number that first appears in the model's own words
//   has no receipt.
//
// The exclusion that makes it mean something: PRIOR ASSISTANT TEXT IS NOT A
// RECEIPT. If it were, a fabricated "30%" on turn one would back itself forever
// after — the model would launder its own invention into evidence by repeating
// it. Everything the model has ever said is exactly the thing under test.
//
// ═══ WHAT THIS CANNOT DO — read before trusting it ══════════════════════════
//
// PRESENCE, NOT BINDING. This is the same hole `prose-guard.ts` documents at
// length and then closes with slots: "every numeral appears somewhere in what
// the model was shown" is strictly weaker than "this numeral is the value of
// the quantity it claims to describe". A payload holding `{dirty: 12, clean:
// 60}` backs "60 dirty rooms". Chat cannot close it the way a card does,
// because closing it is what slots are, and slots need a template.
//
// So be precise about the win. What this catches is the class the founder named
// and the class presence-checking is actually good at: the number that exists
// NOWHERE — the invented percentage, the invented dollar figure, the average
// the model computed in its head. What it does not catch is the number that is
// real but attached to the wrong noun. If a live miss of that shape is ever
// observed, the fix is per-tool noun binding on the specific tool that produced
// it, not a rewrite of this file.
//
// TRUNCATION. Tool results are truncated (`MAX_TOOL_RESULT_CHARS`) before the
// model sees them; the receipt is built from the FULL payload. The receipt is
// therefore marginally more permissive than what the model was actually shown.
// That is the safe direction under this file's doctrine (below) and it is not
// an accident.
//
// DESCRIPTIVE CLAIMS. "mostly HVAC issues", "the worst room in the hotel" carry
// no number and are not checked. Noted, deliberately unbuilt.
//
// ═══ PRECISION OVER COVERAGE — the doctrine, inherited ══════════════════════
//
// `prose-guard.ts` states it and this file obeys it: a guard that fires on
// honest answers gets switched off within a week, and then nothing is checked
// at all. Free dialogue is a far noisier substrate than a card's single
// sentence, so the chat guard gives up MORE coverage than the card guard does,
// on purpose, and names every thing it gave up:
//
//   1. NO DAY OR MONTH NAMES. The card guard checks them. Here a day name is as
//      often a plan ("I'll look Monday") or a pleasantry as a factual claim,
//      and the role prompts' own examples ("Every Monday deep-clean the lobby")
//      would back half of them anyway. A guard that fires on "check back
//      Friday" is a guard someone switches off. Numbers are where the harm is:
//      a manager acts on "$1,240" and "62%".
//
//   2. NUMBERED LIST MARKERS ARE STRIPPED. A model answering with "1. … 2. …
//      3. …" has typed three digits that assert nothing. Stripped before the
//      scan, at line starts only.
//
//   3. SMALL ORDINALS STAY EXEMPT, bounded at 31 exactly as on a card — "the
//      3rd invoice" is positional, and the bound stops "the 400th" using the
//      exemption to smuggle a count.
//
//   4. CONVERSATIONAL HEDGES ARE DROPPED FROM THE WORD LIST. See
//      `CHAT_EXEMPT_NUMBER_WORDS` — each one named with its reason.
//
//   5. THE PROMPT BACKS NUMBERS — but only the half of it that states facts
//      about this hotel. The system prompt HAS to be a receipt: a front-desk
//      agent being told the hotel's own confirmed pet fee is the most honest
//      answer this product gives, and that fee lives in the prompt, not in a
//      tool result. But the ROLE PROMPTS are full of worked examples — "mark
//      10+ rooms at once", "never return more than 5 tool calls", "7am–3pm",
//      "40 rolls of toilet paper", rooms 302 / 305 / 207 — and measured against
//      the real base + manager prompt those contribute 12 stray numbers that
//      between them back almost every small count. So the guard reads
//      `systemPrompt.factual`, the same block minus the instruction tiers,
//      built by subtraction in prompts.ts so a new section fails permissive.
//
// ═══ WHAT HAPPENS ON A VIOLATION, AND WHY THIS SHAPE ════════════════════════
//
// The answer has ALREADY STREAMED to the browser token by token. Three designs
// were available; this is the one that shipped and the reasons the other two
// did not:
//
//   REJECTED — buffer the whole answer, check, then release. Honest, and it
//     turns every chat reply into a 4–8 second blank screen on a phone at the
//     front desk. The streaming path exists precisely because first-token
//     latency is the product. Paying that on 100% of turns to catch the <1%
//     that violate is the wrong trade.
//
//   REJECTED — stream, then regenerate with the violation named. Doubles model
//     cost and latency on the violating turn, and the user watches a complete
//     answer get retracted and replaced — which is worse to read than a
//     correction, not better. The regenerated answer can also violate again,
//     so it needs a bound, and a bounded retry that gives up still has to fall
//     back to... appending a correction.
//
//   SHIPPED — append a named correction as a real text_delta, exactly as
//     `fake-success-guard.ts` does, and for the same stated reason: swapping
//     one confident sentence for another is just a lie of a different shape.
//     The user sees BOTH the figure and the retraction, and the retraction says
//     WHICH figures are unbacked so they know precisely what to distrust. Zero
//     added latency on honest turns (the check is a regex scan over one
//     answer), no second model call, and the SSE contract is untouched — it is
//     one more `text_delta` followed by the `done` the client already expects.
//
// The correction is baked into the PERSISTED text, like the fake-success one,
// so the next turn replays the retraction and the model cannot build on a
// figure that was already withdrawn.
//
// Every firing is reported (Sentry, via llm.ts) and emitted as a countable
// `number_guard_blocked` event. A guard whose firing leaves no trace is
// indistinguishable from a guard that never fires.

import {
  addNumber,
  containsWord,
  foldForProseMatch,
  normalizeNumber,
  MAX_EXEMPT_ORDINAL,
  NUMBER_WORDS,
  ORDINAL_SUFFIX_RE,
} from '@/lib/findings/prose-guard';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Words dropped from the shared `NUMBER_WORDS` map for CHAT only.
 *
 * Each is a word that names a quantity on a card — where the whole text is one
 * factual sentence — and does not reliably name one in free dialogue. Dropping
 * them is coverage deliberately given up; the numeral form of every one of them
 * is still checked, so "100" and "1,000" are caught even though "a hundred" and
 * "a thousand"… well, `thousand` is KEPT. Read on.
 */
export const CHAT_EXEMPT_NUMBER_WORDS: ReadonlySet<string> = new Set([
  // Spanish eleven — and one of the most common adverbs in English. "Once
  // you've marked it clean" would fire on every bilingual conversation.
  'once',
  // Conversational hedges. "a couple of options", "half an hour", "the first
  // half of the month". Worse than merely noisy: when they ARE about hotel data
  // ("half the rooms are clean") they are usually a TRUE derivation of a
  // payload number, which presence mode cannot verify — so the guard would be
  // firing on a correct sentence, which is the failure mode that gets guards
  // switched off.
  'couple', 'half', 'medio',
  'dozen', 'dozens', 'docena', 'docenas',
  // "a hundred percent" / "cien por ciento" is idiomatic agreement in both
  // languages, not a count. The numeral 100 is still checked.
  'hundred', 'hundreds', 'cien', 'ciento', 'cientos',
  // Spanish thousands, but it folds onto the English distance word and chat
  // prose is not a card's one sentence. `mil` is kept — it has no collision.
  'miles',
]);

/**
 * The chat number-word list: the shared vocabulary MINUS the hedges above.
 *
 * Built by subtraction, at module load, from the one canonical map — so a
 * Spanish number word added for cards is automatically checked in chat too, and
 * the only way a word escapes the chat guard is by being named above with a
 * reason. `thousand`/`million`/`billion`/`mil`/`millón` are deliberately KEPT:
 * "that'll run into the thousands" is a fabricated cost estimate, and a
 * fabricated cost estimate is the thing a manager actually acts on.
 */
const CHAT_NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(NUMBER_WORDS).filter(([word]) => !CHAT_EXEMPT_NUMBER_WORDS.has(word)),
  ),
);

// ─── The receipt ─────────────────────────────────────────────────────────────

/** What the model was shown this turn, reduced to the numbers it may print. */
export interface AnswerReceipt {
  /** Every number the model was shown, plus the honest roundings of each. */
  numbers: ReadonlySet<number>;
  /** Folded text of everything shown — kept for diagnostics and future rules. */
  text: string;
}

/**
 * One conversation row, structurally.
 *
 * Deliberately NOT `AgentMessage` from `llm.ts`: llm.ts imports THIS file, and
 * a type import back the other way is a cycle waiting to bite the first person
 * who adds a value import. `AgentMessage` satisfies this shape.
 */
export interface ReceiptMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  result?: unknown;
}

export interface AnswerReceiptInput {
  /**
   * The system blocks. `factual` is preferred over `stable` when present: it is
   * the same cached block with the INSTRUCTION tiers removed, so the role
   * prompts' illustrative numbers ("mark 10+ rooms at once", "room 302", "40
   * rolls of toilet paper") do not back a sentence. Measured on the real base +
   * manager prompt, that is the difference between 12 stray numbers and 0 —
   * and those 12 covered nearly every small count, which is precisely where a
   * misquoted count lives. See `INSTRUCTIONAL_STABLE_TIERS` in prompts.ts.
   *
   * When a caller hand-rolls its blocks and omits `factual`, `stable` is used
   * and the guard is merely more permissive. Never the other way round.
   */
  systemPrompt: { stable: string; dynamic: string; factual?: string };
  /** Prior conversation. USER rows and TOOL rows count; ASSISTANT rows never
   *  do — see the header's laundering note. */
  history: readonly ReceiptMessage[];
  /** The user's new turn, or null on a post-approval resume. */
  newUserMessage: string | null;
  /** Payloads of the tools that ran THIS turn, in order. */
  toolPayloads: readonly unknown[];
}

/** Pull every number out of a string, commas stripped. */
function harvestString(value: string, into: Set<number>): void {
  for (const raw of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    addNumber(into, Number(raw[0].replace(/,/g, '')));
  }
}

/**
 * Walk an arbitrary tool payload, collecting numbers and text.
 *
 * KEY-AWARE, for exactly one reason: money in this codebase is stored in cents
 * and spoken in dollars. A payload field named `budgetCents: 175000` licenses
 * the model saying "$1,750", so a key ending in `cents` contributes its value
 * AND its value/100. Without this the guard would fire on every correct money
 * answer produced from a raw-cents tool — the loudest possible false positive,
 * on the most consequential kind of number.
 */
function harvestJson(
  value: unknown,
  key: string | null,
  numbers: Set<number>,
  text: string[],
  depth = 0,
): void {
  if (value === null || value === undefined || depth > 8) return;
  if (typeof value === 'number') {
    addNumber(numbers, value);
    if (key && /cents$/i.test(key)) addNumber(numbers, value / 100);
    text.push(String(value));
    return;
  }
  if (typeof value === 'boolean') return;
  if (typeof value === 'string') {
    harvestString(value, numbers);
    text.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestJson(item, key, numbers, text, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [k, item] of Object.entries(value as Record<string, unknown>)) {
    text.push(k);
    harvestJson(item, k, numbers, text, depth + 1);
  }
}

/**
 * Build the turn's receipt.
 *
 * The one place the contract in the header becomes code. Read the four `push`
 * sites as the definition of "what the model was shown" — and note the absence
 * of any assistant row.
 */
export function buildAnswerReceipt(input: AnswerReceiptInput): AnswerReceipt {
  const numbers = new Set<number>();
  const textParts: string[] = [];

  // 1. The runtime's own words about this hotel: the snapshot, its memory, its
  //    confirmed identity, its company rulebook. All of it was placed in front
  //    of the model by code — but only the FACTUAL half of the stable block,
  //    so a role prompt's worked example cannot back a count.
  const stableForReceipt = input.systemPrompt.factual ?? input.systemPrompt.stable;
  for (const block of [stableForReceipt, input.systemPrompt.dynamic]) {
    if (!block) continue;
    harvestString(block, numbers);
    textParts.push(block);
  }

  // 2. The conversation so far — the user's numbers and earlier tools' data.
  //    An assistant row is skipped ON PURPOSE and this is the load-bearing
  //    line of the whole file: without it the model backs its own inventions.
  for (const message of input.history) {
    if (message.role === 'assistant') continue;
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        harvestString(message.content, numbers);
        textParts.push(message.content);
      }
      continue;
    }
    harvestJson(message.result, null, numbers, textParts);
  }

  // 3. What the user just typed.
  if (input.newUserMessage) {
    harvestString(input.newUserMessage, numbers);
    textParts.push(input.newUserMessage);
  }

  // 4. What the tools returned this turn.
  for (const payload of input.toolPayloads) {
    harvestJson(payload, null, numbers, textParts);
  }

  return { numbers, text: foldForProseMatch(textParts.join(' ')) };
}

// ─── The check ───────────────────────────────────────────────────────────────

export type NumberViolationKind =
  /** "$1,240", "62%", "3 work orders" — a digit run with no receipt. */
  | 'numeral'
  /** "four work orders", "cuatro" — a number spelled out, with no receipt. */
  | 'number_word';

export interface NumberViolation {
  kind: NumberViolationKind;
  /** The exact token as the model wrote it. Shown to the user in the
   *  correction, so they know which figure to distrust. */
  token: string;
}

export interface NumberGuardResult {
  ok: boolean;
  violations: NumberViolation[];
}

/**
 * Ordered-list markers, removed before the scan.
 *
 * Line-anchored (`m` flag) and bounded to three digits, so "1." at the start of
 * a line is a bullet while "1,240" mid-sentence is a figure. Optional leading
 * bullet/space covers the "- 1. …" nesting models sometimes emit. Run on the
 * RAW text, before folding collapses the newlines this depends on.
 */
const LIST_MARKER_RE = /^[ \t]*(?:[-*•]\s*)?\d{1,3}[.)](?=\s)/gm;

/**
 * Does every number in `text` have a receipt?
 *
 * @param text     The assistant's final answer for the turn.
 * @param receipt  What the model was shown (see buildAnswerReceipt).
 */
export function checkAnswerNumbers(text: string, receipt: AnswerReceipt): NumberGuardResult {
  const violations: NumberViolation[] = [];
  if (!text) return { ok: true, violations };

  const folded = foldForProseMatch(text.replace(LIST_MARKER_RE, ' '));
  if (!folded) return { ok: true, violations };

  // ── numerals ──
  // Matched with the trailing letters attached so an ordinal suffix is visible:
  // "3rd" and "3" are different claims.
  for (const match of folded.matchAll(/(\d[\d,]*(?:\.\d+)?)([a-z]*)/g)) {
    const digits = match[1];
    const suffix = match[2] ?? '';
    const value = normalizeNumber(Number(digits.replace(/,/g, '')));
    if (!Number.isFinite(value)) continue;
    if (suffix && ORDINAL_SUFFIX_RE.test(suffix) && value <= MAX_EXEMPT_ORDINAL) continue;
    if (receipt.numbers.has(value)) continue;
    violations.push({ kind: 'numeral', token: digits + suffix });
  }

  // ── numbers spelled out ──
  // Presence-checked like numerals rather than refused outright: chat is free
  // prose, and "four work orders" is a legitimate way to report a payload's 4.
  // (The card guard refuses spelled numbers because a spelled number is bound
  // to no slot — a rule that only makes sense where slots exist.)
  for (const match of folded.matchAll(/[a-z]+/g)) {
    const word = match[0];
    const value = CHAT_NUMBER_WORDS[word];
    if (value === undefined) continue;
    if (receipt.numbers.has(normalizeNumber(value))) continue;
    violations.push({ kind: 'number_word', token: word });
  }

  return { ok: violations.length === 0, violations };
}

// ─── The correction ──────────────────────────────────────────────────────────

export type NumberGuardLanguage = 'en' | 'es';

/**
 * High-frequency Spanish tokens with no English collision.
 *
 * `no`, `con`, `son` and friends are absent: each is also an English word, and
 * this only has to be right often enough to pick the language of a two-sentence
 * correction. Worst case the retraction is true but in the wrong language,
 * which is a great deal better than not retracting.
 */
const ES_MARKERS = [
  'que', 'los', 'las', 'del', 'para', 'por', 'una', 'esta', 'estan', 'hay',
  'pero', 'mas', 'tiene', 'tienen', 'habitacion', 'habitaciones', 'gerente',
  'segun', 'cuanto', 'ningun', 'ninguna', 'eso', 'esos', 'ahora', 'tambien',
];

/**
 * Which language the answer was written in.
 *
 * Two distinct markers, not one: a single "para" inside an English sentence
 * quoting a Spanish room note should not flip the whole correction.
 */
export function detectAnswerLanguage(text: string): NumberGuardLanguage {
  const folded = foldForProseMatch(text);
  let hits = 0;
  for (const marker of ES_MARKERS) {
    if (!containsWord(folded, marker)) continue;
    hits += 1;
    if (hits >= 2) return 'es';
  }
  return 'en';
}

/** How many offending figures the correction names before it stops. Enough to
 *  be useful, few enough that the retraction stays one readable line. */
const MAX_TOKENS_IN_CORRECTION = 3;

/** The distinct offending tokens, in the order they appeared. */
export function violationTokens(violations: readonly NumberViolation[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of violations) {
    if (seen.has(v.token)) continue;
    seen.add(v.token);
    out.push(v.token);
  }
  return out;
}

/**
 * The retraction appended to the turn.
 *
 * Names the figures rather than gesturing at them — "some numbers may be wrong"
 * tells a manager nothing they can act on, while "30%, $1,240" tells them
 * exactly which two to throw away. It echoes only tokens the answer already
 * contains, so the correction itself can never introduce a new unbacked number.
 */
export function numberGuardCorrection(
  lang: NumberGuardLanguage,
  violations: readonly NumberViolation[],
): string {
  const tokens = violationTokens(violations);
  const shown = tokens.slice(0, MAX_TOKENS_IN_CORRECTION);
  const more = tokens.length - shown.length;

  if (lang === 'es') {
    const list = shown.join(', ');
    const tail = more > 0 ? ` (y ${more} más)` : '';
    return '\n\n⚠️ **Corrección automática: no puedo respaldar esas cifras.** ' +
      `Esto no aparece en los registros de este hotel ni en nada que consulté ahora: ${list}${tail}. ` +
      'Trátalo como incorrecto — vuelve a preguntarme y te doy solo lo que dicen los registros.';
  }
  const list = shown.join(', ');
  const tail = more > 0 ? ` (and ${more} more)` : '';
  return '\n\n⚠️ **Automatic correction: I can\'t back those figures.** ' +
    `These do not appear in this hotel's records or in anything I looked up just now: ${list}${tail}. ` +
    'Treat them as wrong — ask me again and I\'ll quote only what the records actually say.';
}
