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
// ═══ THE PRESENCE HOLE, AND WHY THERE IS NOW A SECOND MODE ═══════════════════
//
// Everything above checks PRESENCE: does this number appear ANYWHERE in the
// payload. That is not the promise the layer makes. On 2026-07-26 a live card on
// Test Hotel proved the gap: the payload said `work_orders: 4, still_open: 3`
// and the judge's own sentence, English and Spanish, said "3 work orders … 2
// still open" — printed directly above a receipt reading 4. Both 3 and 2 exist
// somewhere in that payload (3 is `still_open`, 2 is nothing at all in this
// case… but a `2` in any field would have done), so presence passed and the
// BINDING — which quantity each number is the quantity OF — was never checked.
//
// Presence cannot be repaired into binding. "Every numeral appears somewhere" is
// a strictly weaker statement than "this numeral is the value of the field it
// claims to describe", and no amount of tightening the numeral scan closes it.
//
// So the model path no longer authors numbers at all. See `buildProseSlots`,
// `checkBilingualSlotProse` and `renderProseSlots` below: the judge writes
// `{work_orders}` and `{still_open}`, CODE substitutes the values from the named
// payload fields, and a digit typed outside a brace is a rejection. The presence
// checks above remain, unchanged, as the floor for text that is not slotted —
// the deterministic template, and anything a future caller phrases itself.
//
// WHY SLOTS AND NOT NOUN-PHRASE BINDING. The alternative was to keep free
// phrasing and verify each numeral against the specific quantity it modifies:
// extract (number, noun phrase) pairs and map the nouns to payload fields
// through a per-detector vocabulary. Rejected on two grounds, both of which are
// this file's existing doctrine rather than new opinion. First, it needs a
// bilingual noun vocabulary per detector, so a detector shipped without one is
// silently back to presence-only — the guard would appear to cover code it does
// not. Second, Spanish noun phrases separate from their number ("{n} órdenes de
// trabajo, de las cuales {m} siguen abiertas") in ways a window-of-words matcher
// gets wrong, and a guard that fires on honest Spanish is a guard that gets
// switched off. Slots need no vocabulary, work identically in both languages,
// and make the failure mode structural instead of statistical.
//
// ACCEPTED RESIDUAL — presence mode
// A number that happens to appear anywhere in the payload backs any use of that
// number in the prose. "4 work orders" passes on a finding whose payload holds
// a 4 for something else. This is why the model no longer runs in this mode.
//
// ACCEPTED RESIDUAL — slot mode
// The model can still choose the WRONG slot: `{still_open} work orders` prints a
// true number under a false label. That is a much smaller residual than the one
// it replaces — every printed number is now the real value of a real field of
// THIS finding, so the worst case is a mislabelled true quantity rather than an
// invented one — and it is the residual that noun-phrase binding would have
// closed at the cost above. If a live miss of that shape is ever observed, the
// fix is a per-detector noun vocabulary layered on top of slots, not a return to
// free phrasing.

import type { FindingEvidence, JsonValue, PriceRange } from './types';
import { formatMoney, formatMoneyRange } from './pricing';

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

export type ProseViolationKind =
  | 'numeral'
  | 'number_word'
  | 'day_name'
  | 'month_name'
  /** Slot mode only: a digit typed outside a `{slot}`. */
  | 'unbound_numeral'
  /** Slot mode only: a brace that does not name a field of THIS finding. */
  | 'unknown_slot';

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

// ─── Slot mode: the model names a field, code prints the value ────────────────
//
// The binding fix. Read the header's "THE PRESENCE HOLE" note first — this is
// the mode the judge actually runs in, and the presence checks above are the
// floor beneath it, not the thing that protects a card.

/**
 * The values one finding's phrasing may print, by the name the model must use.
 *
 * Names are the detector's OWN field names (`work_orders`, `still_open`,
 * `window_days`, `location`), because the detector already chose names a human
 * can read and a second naming scheme would be a second thing to keep in sync.
 * Values are pre-rendered strings: substitution is a string replace, so there is
 * exactly one place where a number becomes text and it is this file.
 */
export type ProseSlots = ReadonlyMap<string, string>;

/** A name the model can type without ambiguity, and the shape a field name must
 *  already have to become a slot. Anything else is simply not offered. */
const SLOT_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Longest string a slot will print. A field holding a paragraph (a price
 *  basis, an explanatory note) is not a thing to drop into a sentence, and
 *  TRUNCATING one could cut a number in half and print a figure that is in no
 *  payload anywhere. So an over-long value is not offered as a slot at all. */
const MAX_SLOT_TEXT = 120;

function slotText(value: JsonValue): string | null {
  if (typeof value === 'number') {
    // Two decimals, the same granularity the receipt normalises to, so a slot's
    // printed value is always a number the receipt also holds.
    const n = normalizeNumber(value);
    if (!Number.isFinite(n)) return null;
    return String(n);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_SLOT_TEXT) return null;
    return trimmed;
  }
  // Booleans, nulls, arrays and objects have no honest one-word rendering, and
  // guessing one ("true", "3 items") would be this layer authoring meaning.
  return null;
}

/**
 * A field name as the model will be shown it: snake_case, lowercase.
 *
 * Detectors already write snake_case, so this is almost always the identity.
 * It exists so that a detector which one day writes `windowDays` gets a slot
 * called `window_days` rather than no slot at all — silently losing a field's
 * slot would mean that detector's cards quietly all fall back to templates,
 * which is the kind of regression nothing would report.
 */
function slotNameFor(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function offerSlot(into: Map<string, string>, name: string, value: JsonValue): void {
  const key = slotNameFor(name);
  if (!SLOT_NAME_RE.test(key)) return;
  const text = slotText(value);
  if (text === null) return;
  into.set(key, text);
}

/**
 * Money in a slot is money on a CARD, so it is spelled by the one money
 * formatter in the product (`pricing.ts`) — thousands separated, en dash.
 *
 * This file used to carry its own, and the slot path is where that mattered
 * most: `{price_range}` rendered "$750-$1750" INSIDE the model's sentence while
 * the price chip a centimetre below it said "$750–$1,750" about the same two
 * numbers. Same defect the deterministic floor had, on the primary path.
 *
 * ─── THIS DOES NOT LOOSEN THE BINDING GUARD ───────────────────────────────
 * The order of operations is what makes that safe, and it is worth stating
 * because a comma inside a rendered number looks like exactly the thing
 * `unbound_numeral` exists to catch. `checkSlotProse` strips every `{…}` group
 * and runs the digit and number-word checks on what is LEFT — the model's own
 * typing — and only then calls `renderProseSlots`. A slot's value is therefore
 * never seen by those two rules, whatever it is spelled like. The rules that DO
 * read rendered text are the day and month names, which no money format can
 * collide with, and the receipt's own harvester strips commas and folds en
 * dashes to hyphens, so a rendered "$1,750" still matches the payload's 1750.
 */
function slotMoney(cents: number): string {
  return formatMoney(cents);
}

/**
 * What this finding's phrasing may print, and under what name.
 *
 * Built from the SAME input as the receipt, so a slot can never print a number
 * the receipt does not also hold — which is what keeps the two modes consistent
 * and lets a test assert it rather than trust it.
 *
 * `values` are offered after `params`, so where a detector puts the same name in
 * both, the measured value wins over the argument it was measured with.
 */
export function buildProseSlots(input: ProseReceiptInput): ProseSlots {
  const slots = new Map<string, string>();

  offerSlot(slots, 'magnitude', input.magnitude);
  if (typeof input.weakestInputAgeDays === 'number') {
    offerSlot(slots, 'data_age_days', input.weakestInputAgeDays);
  }

  const evidence = input.evidence ?? null;
  if (evidence) {
    for (const [key, value] of Object.entries(evidence.params ?? {})) {
      offerSlot(slots, key, value as JsonValue);
    }
    for (const [key, value] of Object.entries(evidence.values ?? {})) {
      offerSlot(slots, key, value as JsonValue);
    }
  }

  if (input.price) {
    // A price is a RANGE or it is absent (types.ts PriceRange). `price_range` is
    // offered as one slot precisely so the model cannot print half of it: there
    // is no `{price}` that could become a point estimate.
    slots.set('price_low', slotMoney(input.price.lowCents));
    slots.set('price_high', slotMoney(input.price.highCents));
    slots.set(
      'price_range',
      formatMoneyRange(input.price.lowCents, input.price.highCents, input.price.currency),
    );
  }

  return slots;
}

/** Every `{…}` group in the text, valid or not. A fresh RegExp per call rather
 *  than one shared global — a shared `lastIndex` across two functions that both
 *  scan the same string is a bug waiting for the first re-entrant caller. */
function slotPattern(): RegExp {
  return /\{([^{}]*)\}/g;
}

/** Substitute the slots the model named. Unknown names are left untouched — the
 *  check refuses them before anything is rendered for a manager, and this
 *  function is also used on the internal rationale line, which is not gated. */
export function renderProseSlots(text: string, slots: ProseSlots): string {
  return text.replace(slotPattern(), (whole, inner: string) => {
    const value = slots.get(slotNameFor(inner));
    return value === undefined ? whole : value;
  });
}

export interface SlotProseResult extends ProseGuardResult {
  /** The phrasing with every slot substituted — what would be stored. */
  text: string;
}

/**
 * Slot-mode check for one language.
 *
 * Four refusals, in the order they matter:
 *   1. a brace naming a field this finding does not have → `unknown_slot`;
 *   2. any digit outside a brace → `unbound_numeral`. This is the binding fix:
 *      the model cannot type "3" at all, so it cannot type a 3 that belongs to
 *      a different quantity;
 *   3. a number spelled out as a word → `number_word`. Not presence-checked
 *      here as it is above: under this contract a spelled-out number is bound to
 *      nothing, so "cuatro órdenes" is refused even when the payload holds a 4;
 *   4. day and month names, presence-checked against the payload exactly as in
 *      free mode — a slot cannot express "since Monday", so that rule still has
 *      to do its own work.
 */
export function checkSlotProse(
  text: string,
  receipt: ProseReceipt,
  slots: ProseSlots,
  lang: 'en' | 'es',
): SlotProseResult {
  const violations: ProseViolation[] = [];

  // ── 1. every brace must name a field of THIS finding ──
  let stripped = '';
  let cursor = 0;
  const pattern = slotPattern();
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const inner = slotNameFor(m[1]);
    if (!slots.has(inner)) {
      violations.push({ kind: 'unknown_slot', lang, token: m[1].trim().slice(0, 40) || '(empty)' });
    }
    // Replaced with a space, not removed: "{a}{b}" must not fuse into one word
    // and hide a boundary from the checks below.
    stripped += `${text.slice(cursor, m.index)} `;
    cursor = m.index + m[0].length;
  }
  stripped += text.slice(cursor);

  // A lone brace is not a typo to be forgiven — braces are reserved here, and a
  // half-written slot would render literally on a manager's card.
  if (/[{}]/.test(stripped)) {
    violations.push({ kind: 'unknown_slot', lang, token: '(unpaired brace)' });
  }

  const folded = foldForProseMatch(stripped);

  // ── 2. no digit the model typed itself ──
  for (const match of folded.matchAll(/(\d[\d,]*(?:\.\d+)?)([a-z]*)/g)) {
    const digits = match[1];
    const suffix = match[2] ?? '';
    const value = normalizeNumber(Number(digits.replace(/,/g, '')));
    // Small ordinals stay exempt for the reason they always were: "the 3rd
    // invoice" is positional and expresses no quantity, so there is no field it
    // could be bound to. Bounded, so "the 400th" cannot use the exemption.
    if (
      suffix
      && ORDINAL_SUFFIX_RE.test(suffix)
      && Number.isFinite(value)
      && value <= MAX_EXEMPT_ORDINAL
    ) {
      continue;
    }
    violations.push({ kind: 'unbound_numeral', lang, token: digits + suffix });
  }

  // ── 3. no number spelled out, backed or not ──
  for (const match of folded.matchAll(/[a-z]+/g)) {
    if (NUMBER_WORDS[match[0]] === undefined) continue;
    violations.push({ kind: 'number_word', lang, token: match[0] });
  }

  const rendered = renderProseSlots(text, slots);

  // ── 4. days and months, against the payload's text ──
  const foldedRendered = foldForProseMatch(rendered);
  for (const day of [...DAY_NAMES_EN, ...DAY_NAMES_ES]) {
    if (!containsWord(foldedRendered, day)) continue;
    if (containsWord(receipt.text, day)) continue;
    violations.push({ kind: 'day_name', lang, token: day });
  }
  for (const month of [...MONTH_NAMES_EN, ...MONTH_NAMES_ES]) {
    if (month === 'may') continue; // the English modal; see checkProse.
    if (!containsWord(foldedRendered, month)) continue;
    if (containsWord(receipt.text, month)) continue;
    violations.push({ kind: 'month_name', lang, token: month });
  }

  return { ok: violations.length === 0, violations, text: rendered };
}

export interface BilingualSlotProseResult extends ProseGuardResult {
  /** Rendered English — only meaningful when `ok`. */
  en: string;
  /** Rendered Spanish — only meaningful when `ok`. */
  es: string;
}

/**
 * The bilingual slot gate. Same two structural rules as `checkBilingualProse`:
 * both languages must pass, and either failing discards both.
 *
 * The English-standing-in-for-Spanish check runs on the RENDERED text, because
 * that is what a Spanish speaker would be shown. Two different slot spellings
 * that render to the same sentence are the same failure as writing it twice.
 */
export function checkBilingualSlotProse(
  en: string,
  es: string,
  receipt: ProseReceipt,
  slots: ProseSlots,
): BilingualSlotProseResult {
  const violations: ProseViolation[] = [];
  const enResult = checkSlotProse(en, receipt, slots, 'en');
  const esResult = checkSlotProse(es, receipt, slots, 'es');

  const foldedEn = foldForProseMatch(enResult.text);
  const foldedEs = foldForProseMatch(esResult.text);
  if (!foldedEn) violations.push({ kind: 'numeral', lang: 'en', token: '(empty)' });
  if (!foldedEs) violations.push({ kind: 'numeral', lang: 'es', token: '(empty)' });
  if (foldedEn && foldedEs && foldedEn === foldedEs) {
    violations.push({ kind: 'numeral', lang: 'es', token: '(english-standing-in-for-spanish)' });
  }

  violations.push(...enResult.violations, ...esResult.violations);

  return { ok: violations.length === 0, violations, en: enResult.text, es: esResult.text };
}
