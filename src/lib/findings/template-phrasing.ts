// ═══════════════════════════════════════════════════════════════════════════
// THE DETERMINISTIC PHRASING FLOOR — what a card says when no model wrote it.
//
// ─── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────
// Two completely different callers need the SAME Spanish sentence and neither
// may own it:
//
//   src/lib/findings/judge.ts        writes `judged_summary_es` when the model
//                                   is unavailable, over budget, or was caught
//                                   inventing a number.
//   components/concourse/
//     finding-cards.ts              renders a card whose `phrasedEs` is null —
//                                   which is EVERY company-scope card, because
//                                   `company_findings` has no judged_* columns
//                                   at all, and every hotel card on a deploy
//                                   where the judge has not run yet.
//
// Before this file the second caller silently fell back to `summary`, which the
// detector writes in ENGLISH. So a Spanish-reading VP got English prose under a
// Spanish heading, and the first caller printed "(magnitud 4)" — a word no
// hotel manager has ever used — with no room number in a sentence whose English
// twin said "Room 231 has had 4 work orders in the last 30 days".
//
// ─── THE RULES THIS FLOOR OBEYS ───────────────────────────────────────────
//   1. NO NUMBER THAT IS NOT IN THE ROW. Every numeral below comes from the
//      finding's own evidence, so the prose guard passes this text by
//      construction (findings-judge.test.ts holds that as a standing
//      assertion). `magnitude` is deliberately NOT printed: it is a bare count
//      with no unit attached, so the only honest way to say it is with the
//      detector's own word for what it counted, and this layer does not have
//      one.
//   2. NEVER MIXED. A Spanish sentence is Spanish. The one thing carried
//      across verbatim is the hotel's OWN LABEL for a place or a task —
//      "Room 231", "[QA seed] Grease trap service" — because those are names,
//      and translating a name is how you tell somebody about a room that does
//      not exist.
//   3. IT POINTS AT THE RECEIPT. The floor cannot restate the finding, so it
//      names the subject and sends the reader to the numbers, using the exact
//      words on the button ("Ver los números").
// ═══════════════════════════════════════════════════════════════════════════

import type { FindingSeverity, PriceRange } from './types';
import { formatMoneyRange } from './pricing';

/**
 * The only shape this module reads.
 *
 * Deliberately structural and loose rather than `Pick<FindingEvidence,'params'>`:
 * the CARD's evidence type carries `Record<string, unknown>` (it came off the
 * wire) and the DETECTOR's carries `Record<string, JsonValue>`. Both callers
 * need the same sentence, and `readString` narrows every value anyway, so the
 * looser type is the honest one rather than a cast at each call site.
 */
export interface SubjectSource {
  params?: Readonly<Record<string, unknown>> | null;
}

/**
 * Evidence params, in the order a subject is most specifically named.
 *
 * Order is the whole design. `location` before `area` because "Room 231" beats
 * "Building"; `task_name` before `area` for the same reason. A detector that
 * names none of these has no subject, and the sentence says "this hotel" rather
 * than inventing one.
 */
const SUBJECT_PARAM_KEYS = [
  'location',
  'task_name',
  'equipment_name',
  'certificate',
  'item_name',
  'area',
  'category',
] as const;

/** How long a subject may be before it stops being a label and starts being a
 *  paragraph. Long enough for "[QA seed] Backflow preventer test". */
const MAX_SUBJECT_CHARS = 60;

function readString(params: Readonly<Record<string, unknown>> | null | undefined, key: string): string | null {
  const raw = params?.[key];
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > MAX_SUBJECT_CHARS) return null;
  return text;
}

/**
 * What this finding is ABOUT, as the hotel's own label for it — or null.
 *
 * `target_kind: 'room'` + `target_value` is handled separately and IS
 * translated, because there the word "room" is a TYPED FIELD rather than part
 * of a free-text label: the detector asserted the kind, so "Habitación 214" is
 * a translation of structure, not a guess about prose.
 */
export function templateSubject(
  evidence: SubjectSource | null | undefined,
  lang: 'en' | 'es' = 'en',
): string | null {
  const params = evidence?.params;
  if (!params) return null;

  const kind = readString(params, 'target_kind');
  const value = readString(params, 'target_value');
  if (kind === 'room' && value) {
    return lang === 'es' ? `Habitación ${value}` : `Room ${value}`;
  }
  // A bare `room` param is the same typed assertion by a different name, and
  // several detectors write it that way.
  const room = readString(params, 'room') ?? readString(params, 'room_number');
  if (room) return lang === 'es' ? `Habitación ${room}` : `Room ${room}`;

  for (const key of SUBJECT_PARAM_KEYS) {
    const found = readString(params, key);
    if (found) return found;
  }
  return null;
}

const SEVERITY_ES: Record<FindingSeverity, string> = {
  critical: 'Crítico',
  attention: 'Atención',
  info: 'Información',
};

/** U+2014. Named because it is invisible in a diff otherwise. */
const EM_DASH = '—';

/**
 * The same sentence with its em dashes turned into full stops.
 *
 * ─── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────
 * Findings prose is PERSISTED, not derived. `findings.summary` is written by
 * the detector at detection time and `judged_summary_en` / `judged_summary_es`
 * are written by the judge; all three are read back verbatim months later. So
 * fixing the templates only cleans rows written from now on. Every card already
 * in the database would keep its dash forever.
 *
 * Rather than rewrite history in a table that is meant to be an immutable
 * record of what Staxis said and when, the fix runs on READ, at the single seam
 * every card headline passes through (`cardPhrasing`). Old rows render clean,
 * the stored record stays exactly as it was written, and nothing has to be
 * backfilled.
 *
 * The transform is deliberately dumb: split on the dash, join the pieces with a
 * full stop, capitalise what follows. It does not try to guess whether a comma
 * would have read better, because it is operating on text nobody is reviewing.
 * New copy gets written properly at the template instead, and the guard test
 * holds the templates to that.
 */
export function withoutEmDash(text: string): string {
  if (!text.includes(EM_DASH)) return text;
  const parts = text
    .split(EM_DASH)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return '';

  let out = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    // A clause that already closed itself does not need a second stop stacked
    // onto it: "Room 231: — 4 work orders" must not become "Room 231:. 4 …".
    const alreadyClosed = /[.,:;!?]$/.test(out);
    if (alreadyClosed) {
      out += ` ${parts[i]}`;
    } else {
      out += `. ${parts[i].charAt(0).toLocaleUpperCase()}${parts[i].slice(1)}`;
    }
  }
  return out;
}

/** " Costo estimado: $750–$1,750." — one money formatter, shared with the card
 *  chip that sits a centimetre below this sentence. */
export function templatePriceSentence(
  price: Pick<PriceRange, 'lowCents' | 'highCents' | 'currency'> | null | undefined,
  lang: 'en' | 'es',
): string {
  if (!price) return '';
  if (!Number.isFinite(price.lowCents) || !Number.isFinite(price.highCents)) return '';
  if (price.highCents <= price.lowCents || price.lowCents < 0) return '';
  const range = formatMoneyRange(price.lowCents, price.highCents, price.currency);
  return lang === 'en' ? ` Estimated cost: ${range}.` : ` Costo estimado: ${range}.`;
}

export interface TemplateFloorInput {
  severity: FindingSeverity;
  evidence?: SubjectSource | null;
  price?: Pick<PriceRange, 'lowCents' | 'highCents' | 'currency'> | null;
}

/**
 * The Spanish floor: real Spanish, the subject named, and no jargon.
 *
 *   "Atención: Habitación 231. Staxis tiene algo abierto aquí. Toca «Ver los
 *    números» para el detalle. Costo estimado: $750–$1,750."
 *
 * Deliberately vaguer than the English, and that is the honest asymmetry: the
 * English reuses the detector's own template sentence, which is already exact.
 * Spanish has no such sentence to reuse, so it says only what it can vouch for
 * and hands the reader the receipt, rather than paraphrasing a claim it cannot
 * check, which is the failure mode a translated sentence invites.
 *
 * The severity, the subject and the body are three short statements separated by
 * ordinary punctuation. They used to be joined with an em dash; the founder
 * ruled those out of user-facing copy on 2026-07-28, and this sentence is the
 * one every findings surface shares, so it is the one that mattered most.
 */
export function spanishTemplateSentence(input: TemplateFloorInput): string {
  const subject = templateSubject(input.evidence, 'es');
  const where = subject
    ? `${SEVERITY_ES[input.severity]}: ${subject}.`
    : `${SEVERITY_ES[input.severity]}:`;
  const body = subject
    ? 'Staxis tiene algo abierto aquí.'
    : 'Staxis tiene algo abierto en este hotel.';
  return `${where} ${body} Toca «Ver los números» para el detalle.${templatePriceSentence(input.price, 'es')}`
    .trim();
}
