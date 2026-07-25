// ─── The prose guard ─────────────────────────────────────────────────────────
//
// "No number without a receipt" is a prompt convention until something checks
// it. This file is the check.
//
// WHY THIS EXISTS
// The judge is allowed to phrase a finding. It is not allowed to author a
// number. Those two things live in the same sentence, so the only way to keep
// them apart is mechanically: extract every numeral and named entity from the
// generated English and Spanish, and require each one to appear in the
// finding's structured payload. A sentence that says "9 work orders" for a
// finding whose evidence says 4 is discarded before it is ever stored — the
// manager never sees it, and the rejection is counted.
//
// This is the same shape as `agent/fake-success-guard.ts`: the model produced
// prose, the runtime independently knows the truth, and "the prose asserts
// something the runtime cannot back" is decidable without asking the model.
// The difference is the response. fake-success-guard APPENDS a correction,
// because there the lie is already in front of the user and swapping one
// confident sentence for another is just a lie of a different shape. Here
// nothing has been shown yet, so the right move is to throw the phrasing away
// and use the deterministic template instead.
//
// PRECISION OVER COVERAGE — the same doctrine, the same reasoning
// A guard that fires on honest phrasing gets switched off within a week, and
// then nothing is checked at all. So this file checks exactly the four classes
// the finding's payload can actually vouch for:
//
//   1. NUMERALS      — "4 work orders", "$340", "12%", "room 214". Every digit
//                      run must match a number in the payload.
//   2. NUMBER WORDS  — "four work orders", "cuatro órdenes". A model that
//                      spells the number out has still authored a number.
//   3. DAY NAMES     — "every Monday", "los martes". Must appear in the payload.
//   4. MONTH NAMES   — same rule; a month is a factual claim about when.
//
// And deliberately does NOT attempt:
//
//   • Freeform proper nouns ("Maria is slower"). Capitalised-token detection
//     cannot tell a fabricated staff name from a capitalised common noun, and
//     the false-positive rate would be exactly the thing that gets a guard
//     turned off. Person-shaped findings are an HR object with different rules
//     (pattern-engine plan, "flagged for later"); when they arrive they need a
//     real allow-list of this hotel's staff, not a heuristic.
//   • Ordinals ("the 3rd invoice"). Positional, not quantitative, and bounded
//     at 31 so "the 400th" cannot smuggle a count through the exemption.
//   • The indefinite article in either language. Spanish "una habitación" is
//     "a room", not "one room", and English "one of the rooms" is not a count.
//     `un`, `una`, `uno` and `one` are therefore never treated as numbers —
//     which does mean a model can write "one work order" unbacked. That is the
//     price of not firing on every Spanish sentence containing an article, and
//     it is the right trade: the residual is a claim of ONE, the smallest
//     possible overstatement, in exchange for the guard staying on.
//
// ACCEPTED RESIDUAL
// A number that happens to appear anywhere in the payload backs any use of that
// number in the prose. "4 work orders" passes on a finding whose payload holds
// a 4 for something else. Tightening that would mean teaching the guard what
// each detector's fields MEAN, which is per-detector knowledge this layer
// deliberately does not have. The guard's job is "could this number have come
// from here at all" — the receipt shown next to the card is what proves it did.

import type { FindingEvidence, JsonValue, PriceRange } from './types';

// ─── What the prose is allowed to say ────────────────────────────────────────

/**
 * The finding's structured payload, flattened into the two things the guard can
 * check prose against: the numbers it contains, and its text.
 */
export interface ProseReceipt {
  /** Every number the payload contains, plus the honest derivations of them. */
  numbers: ReadonlySet<number>;
  /** The payload's text, folded — used for day and month names. */
  text: string;
}

/** Fold to a single comparison form: lowercase, no diacritics, collapsed space.
 *
 *  Diacritics go for the same reason they go in fake-success-guard: model
 *  Spanish drops accents often enough that an accent-sensitive matcher fails
 *  exactly when it matters. Every Spanish pattern below is written unaccented
 *  as a consequence. */
export function foldForProseMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[‘’ʼ′`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Round-trip-safe: 4, 4.0 and "4" are the same claim. */
function normalizeNumber(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  // Two decimal places is the finest granularity anything in this layer
  // asserts (money in cents rendered as dollars). Beyond that, floating point
  // noise would make a true statement fail.
  return Math.round(n * 100) / 100;
}

function addNumber(into: Set<number>, value: number): void {
  const n = normalizeNumber(value);
  if (!Number.isFinite(n)) return;
  into.add(n);
  // A magnitude of 9.4 days legitimately reads as "9 days" or "10 days" in
  // prose. Both roundings are backed; anything further away is not.
  if (!Number.isInteger(n)) {
    into.add(Math.floor(n));
    into.add(Math.ceil(n));
    into.add(normalizeNumber(Math.round(n * 10) / 10));
  }
}

/** Pull every number out of an arbitrary JSON value, including numbers written
 *  inside strings ("room 214", "4 hvac work orders in the last 30 days"). */
function harvestNumbers(value: JsonValue | undefined, into: Set<number>, depth = 0): void {
  if (value === null || value === undefined || depth > 8) return;
  if (typeof value === 'number') {
    addNumber(into, value);
    return;
  }
  if (typeof value === 'boolean') return;
  if (typeof value === 'string') {
    for (const raw of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      addNumber(into, Number(raw[0].replace(/,/g, '')));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestNumbers(item, into, depth + 1);
    return;
  }
  for (const item of Object.values(value)) harvestNumbers(item as JsonValue, into, depth + 1);
}

function harvestText(value: JsonValue | undefined, into: string[], depth = 0): void {
  if (value === null || value === undefined || depth > 8) return;
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    into.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestText(item, into, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    into.push(key);
    harvestText(item as JsonValue, into, depth + 1);
  }
}

/** What a specific finding's prose is allowed to contain. */
export interface ProseReceiptInput {
  summary: string;
  magnitude: number;
  evidence: FindingEvidence;
  price?: PriceRange | null;
  weakestInputAgeDays?: number | null;
  asOf?: string | Date | null;
}

/**
 * Build the receipt from one finding. Everything the prose may say has to come
 * from here — this function is the definition of "what we actually know".
 */
export function buildProseReceipt(input: ProseReceiptInput): ProseReceipt {
  const numbers = new Set<number>();
  const textParts: string[] = [input.summary];

  addNumber(numbers, input.magnitude);
  if (typeof input.weakestInputAgeDays === 'number') {
    addNumber(numbers, input.weakestInputAgeDays);
  }

  const evidence = input.evidence ?? null;
  if (evidence) {
    textParts.push(evidence.basis ?? '', evidence.queryId ?? '');
    harvestNumbers(evidence.params as JsonValue, numbers);
    harvestNumbers(evidence.values as JsonValue, numbers);
    harvestNumbers((evidence.basis ?? '') as JsonValue, numbers);
    harvestText(evidence.params as JsonValue, textParts);
    harvestText(evidence.values as JsonValue, textParts);
  }
  harvestNumbers(input.summary as JsonValue, numbers);

  if (input.price) {
    // Money is stored in cents and spoken in dollars. Both are the same claim,
    // so both back the prose — but nothing between them does: a range of
    // $200–400 does not license "$340".
    addNumber(numbers, input.price.lowCents);
    addNumber(numbers, input.price.highCents);
    addNumber(numbers, input.price.lowCents / 100);
    addNumber(numbers, input.price.highCents / 100);
    textParts.push(input.price.basis ?? '', input.price.currency ?? '');
    harvestNumbers((input.price.basis ?? '') as JsonValue, numbers);
  }

  if (input.asOf) {
    const iso = input.asOf instanceof Date ? input.asOf.toISOString() : String(input.asOf);
    textParts.push(iso);
    harvestNumbers(iso as JsonValue, numbers);
    const at = new Date(iso);
    if (!Number.isNaN(at.getTime())) {
      // The as-of date's own day and month names back "since Monday" / "since
      // March" without the model having to spell out the ISO string.
      textParts.push(DAY_NAMES_EN[at.getUTCDay()], DAY_NAMES_ES[at.getUTCDay()]);
      textParts.push(MONTH_NAMES_EN[at.getUTCMonth()], MONTH_NAMES_ES[at.getUTCMonth()]);
    }
  }

  return { numbers, text: foldForProseMatch(textParts.filter(Boolean).join(' ')) };
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

const DAY_NAMES_EN = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];
// Written unaccented to match foldForProseMatch (miercoles, sabado).
const DAY_NAMES_ES = [
  'domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado',
];
const MONTH_NAMES_EN = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_NAMES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * Words that name a number. `one` / `un` / `una` / `uno` are ABSENT on purpose:
 * in both languages they are the indefinite article far more often than a
 * count, and a guard that fires on "una habitación" is a guard that gets turned
 * off. See the header's accepted-residual note.
 *
 * Spanish entries are unaccented to match the fold ("dieciseis", "veintidos").
 */
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  // English
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80,
  ninety: 90, hundred: 100,
  // Spanish
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiuno: 21, veintidos: 22, veintitres: 23, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100,
});

/** Ordinals are positional, not quantitative — "the 3rd invoice" makes no claim
 *  about how many there are. Bounded so "the 400th" cannot use the exemption to
 *  smuggle a count through. */
const MAX_EXEMPT_ORDINAL = 31;
const ORDINAL_SUFFIX_RE = /^(?:st|nd|rd|th|o|a|er|ro|do|mo|vo|no)\b/;

// ─── The check ───────────────────────────────────────────────────────────────

export type ProseViolationKind = 'numeral' | 'number_word' | 'day_name' | 'month_name';

export interface ProseViolation {
  kind: ProseViolationKind;
  /** Which language's phrasing tripped it. */
  lang: 'en' | 'es';
  /** The exact token that has no receipt. */
  token: string;
}

export interface ProseGuardResult {
  ok: boolean;
  violations: ProseViolation[];
}

/**
 * Does every numeral and named entity in `text` appear in the receipt?
 *
 * @param text     One or two sentences of generated phrasing.
 * @param receipt  What the finding actually knows (see buildProseReceipt).
 * @param lang     Which phrasing this is — recorded on any violation so the
 *                 rejection log says whether the model's English or its Spanish
 *                 is the unreliable half.
 */
export function checkProse(
  text: string,
  receipt: ProseReceipt,
  lang: 'en' | 'es',
): ProseGuardResult {
  const violations: ProseViolation[] = [];
  const folded = foldForProseMatch(text);
  if (!folded) return { ok: true, violations };

  // ── 1. numerals ──
  // Matched with the trailing characters attached so an ordinal suffix is
  // visible: "3rd" and "3" are different claims.
  for (const match of folded.matchAll(/(\d[\d,]*(?:\.\d+)?)([a-z]*)/g)) {
    const digits = match[1];
    const suffix = match[2] ?? '';
    const value = normalizeNumber(Number(digits.replace(/,/g, '')));
    if (!Number.isFinite(value)) continue;

    if (suffix && ORDINAL_SUFFIX_RE.test(suffix) && value <= MAX_EXEMPT_ORDINAL) continue;
    if (receipt.numbers.has(value)) continue;

    // "1,200" written as "1200" (or vice versa) is the same claim; the
    // separator strip above already handles that. A percentage of a backed
    // number is NOT automatically backed — a rate is its own assertion.
    violations.push({ kind: 'numeral', lang, token: digits + suffix });
  }

  // ── 2. number words ──
  for (const match of folded.matchAll(/[a-z]+/g)) {
    const word = match[0];
    const value = NUMBER_WORDS[word];
    if (value === undefined) continue;
    if (receipt.numbers.has(normalizeNumber(value))) continue;
    violations.push({ kind: 'number_word', lang, token: word });
  }

  // ── 3 + 4. day and month names ──
  // Word-boundary matched against the receipt's text so "march" in the prose
  // needs "march" in the payload, not merely the letters.
  for (const day of [...DAY_NAMES_EN, ...DAY_NAMES_ES]) {
    if (!containsWord(folded, day)) continue;
    if (containsWord(receipt.text, day)) continue;
    violations.push({ kind: 'day_name', lang, token: day });
  }
  for (const month of [...MONTH_NAMES_EN, ...MONTH_NAMES_ES]) {
    // "may" and "mayo" are the one real ambiguity here: English "may" is a
    // modal, Spanish "mayo" is not ambiguous. Skipping the modal costs one
    // month of coverage and buys back every "may need attention" sentence.
    if (month === 'may') continue;
    if (!containsWord(folded, month)) continue;
    if (containsWord(receipt.text, month)) continue;
    violations.push({ kind: 'month_name', lang, token: month });
  }

  return { ok: violations.length === 0, violations };
}

function containsWord(haystack: string, word: string): boolean {
  const at = haystack.indexOf(word);
  if (at === -1) return false;
  // Cheap manual word-boundary check — avoids building a RegExp per token per
  // finding on a path that runs over every card, every night.
  let index = at;
  while (index !== -1) {
    const before = index === 0 ? ' ' : haystack[index - 1];
    const afterIndex = index + word.length;
    const after = afterIndex >= haystack.length ? ' ' : haystack[afterIndex];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    index = haystack.indexOf(word, index + 1);
  }
  return false;
}

/**
 * The bilingual gate applied before any generated phrasing is stored.
 *
 * BOTH languages must pass, and failure in EITHER discards BOTH. A card that is
 * half model prose and half template reads as two different systems talking,
 * and a model that just invented a number in Spanish has not earned the benefit
 * of the doubt in English.
 *
 * The equality check is the language rule made mechanical (CLAUDE.md: every
 * user-facing string is EN + ES): a model that returns the English sentence
 * twice has produced no Spanish, and English silently standing in for Spanish
 * is exactly what must never reach a Spanish speaker's screen.
 */
export function checkBilingualProse(
  en: string,
  es: string,
  receipt: ProseReceipt,
): ProseGuardResult {
  const violations: ProseViolation[] = [];
  const foldedEn = foldForProseMatch(en);
  const foldedEs = foldForProseMatch(es);

  if (!foldedEn) violations.push({ kind: 'numeral', lang: 'en', token: '(empty)' });
  if (!foldedEs) violations.push({ kind: 'numeral', lang: 'es', token: '(empty)' });
  if (foldedEn && foldedEs && foldedEn === foldedEs) {
    violations.push({ kind: 'numeral', lang: 'es', token: '(english-standing-in-for-spanish)' });
  }

  violations.push(...checkProse(en, receipt, 'en').violations);
  violations.push(...checkProse(es, receipt, 'es').violations);

  return { ok: violations.length === 0, violations };
}
