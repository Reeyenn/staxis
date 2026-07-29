// ─── "You've written PTAC in 9 work orders — track it as equipment?" ─────────
//
// THE MECHANIC, AS THE FOUNDER SPECIFIED IT
// A hotel keeps typing the same word into its work orders — PTAC, boiler, the
// elevator — and has nothing on its equipment list matching it. Staxis noticed;
// Staxis asks once. One tap creates the entry, and THEIR TAP IS WHAT MAKES IT
// REAL. Nothing in this file ever creates a piece of equipment on its own, and
// there is no state in which it could: this module produces a QUESTION, and the
// only code that writes an `equipment` row from one is the answer path a manager
// triggered.
//
// NO MODEL, ANYWHERE. Extraction is frequency counting over text the hotel wrote,
// with a stoplist. That is a deliberate constraint and not a cost saving: a term
// an LLM proposed would be a word Staxis invented and then asked the hotel to
// ratify, and the thing that makes the equipment list trustworthy is that every
// row on it traces to something a human at that hotel actually said. Counting
// their own words is the strongest version of that; guessing at them is the
// weakest. It also means the suggestion works with the provider down, costs
// nothing, and gives the same answer twice.
//
// WHY IT RIDES THE EXISTING DRIP QUESTION AND DOES NOT BUILD A SECOND ONE
// Staxis asks a manager a question in exactly one place, and that place owns four
// promises that took real work to get right: one question per session, never the
// same one twice, an ignored question gone for the rest of the day, and given up
// on for good after three asks. A second question surface would either duplicate
// those rules or quietly break one. So this file phrases candidates into the
// shape `selectQuestion` already consumes and hands them over — the same move
// src/lib/findings/ask-drip.ts made for findings, for the same reason.
//
// THE TWO WAYS THIS COULD BE OBNOXIOUS, AND WHERE EACH IS STOPPED
//   asking about a word that is not equipment  — the stoplist, the minimum
//     length, and a bar of five separate work orders. "Leaking", "broken" and
//     "guest" never reach the ledger.
//   asking about equipment they already track  — `hasMatchingEquipment`, checked
//     against the hotel's own registry before a candidate is built at all. A
//     hotel that has already logged its PTAC batch is never asked to log it
//     again, however many tickets mention it.

import type { QuestionCandidate } from '@/lib/agent/drip-questions';

/**
 * How many SEPARATE work orders must mention a term before it is worth a
 * manager's one tap.
 *
 * Five, and counted per work order rather than per occurrence: a single ticket
 * reading "PTAC in 214 — PTAC fan, PTAC filter" is one person describing one
 * fault, and counting its three mentions would let one verbose ticket clear the
 * bar on its own. Five separate tickets is five separate occasions on which
 * somebody at this hotel decided that word was the right one.
 */
export const MIN_WORK_ORDERS_MENTIONING = 5;

/** How far back the count reaches. A quarter of typing, not a lifetime of it. */
export const SUGGESTION_WINDOW_DAYS = 90;

/** Bounds on a token that could plausibly name a piece of equipment. */
const MIN_TERM_LENGTH = 3;
const MAX_TERM_LENGTH = 24;

/**
 * Words that appear in work orders constantly and name no equipment.
 *
 * Three groups, and the reason for each is different:
 *
 *   structure    "the", "and", "in" — grammar. Present in every language's
 *                filler and carries no content at all.
 *   the JOB      "broken", "leaking", "replace", "check" — these describe what
 *                happened or what to do. They are the single biggest false
 *                positive class, because a maintenance board is mostly verbs.
 *   the PLACE    "room", "lobby", "floor" — real, common, and already covered by
 *                `repeat_room_work_orders`, which groups by location. A hotel
 *                asked to track "room" as a piece of equipment would rightly
 *                conclude nobody was reading what it wrote.
 *
 * Spanish alongside English throughout: a bilingual hotel writes tickets in
 * both, and a stoplist that only knew English would ask a Spanish-speaking team
 * to track "roto" as equipment.
 *
 * Deliberately a stoplist rather than an allowlist. An allowlist of equipment
 * words would be Staxis deciding in advance what a hotel is allowed to own, and
 * the whole point is that the hotel names its own things.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // ── structure ──
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'was', 'were', 'has', 'had',
  'not', 'but', 'all', 'any', 'out', 'off', 'its', 'are', 'you', 'our', 'his', 'her',
  'los', 'las', 'del', 'con', 'por', 'para', 'que', 'una', 'uno', 'esta', 'este',
  'muy', 'sin', 'les', 'sus', 'ser', 'como', 'pero', 'hay',
  // ── the job ──
  'broken', 'break', 'broke', 'leak', 'leaks', 'leaking', 'leaked', 'fix', 'fixed',
  'fixing', 'repair', 'repairs', 'repaired', 'replace', 'replaced', 'replacing',
  'check', 'checked', 'checking', 'clean', 'cleaned', 'cleaning', 'reset', 'issue',
  'issues', 'problem', 'problems', 'need', 'needs', 'needed', 'please', 'asap',
  'urgent', 'again', 'still', 'work', 'works', 'working', 'order', 'orders', 'call',
  'called', 'done', 'stopped', 'stop', 'running', 'noise', 'noisy', 'loud', 'smell',
  'water', 'hot', 'cold', 'new', 'old', 'bad', 'good', 'test', 'tested', 'parts',
  'part', 'unit', 'units', 'maintenance', 'ticket', 'staff', 'guest', 'guests',
  // The condition, not the thing. Added after the first run of this module's
  // own tests offered "failure" and "dead" as pieces of equipment — which is
  // exactly the sentence that would have cost a manager's trust in one morning.
  'dead', 'fail', 'fails', 'failed', 'failing', 'failure', 'failures', 'down',
  'stuck', 'jammed', 'loose', 'dirty', 'blocked', 'clogged', 'burnt', 'burned',
  'roto', 'rota', 'fuga', 'gotea', 'reparar', 'arreglar', 'revisar', 'cambiar',
  'limpiar', 'problema', 'urgente', 'nuevo', 'nueva', 'viejo', 'funciona',
  'funcionando', 'ruido', 'agua', 'caliente', 'frio', 'huesped', 'huespedes',
  'personal', 'pieza', 'piezas', 'unidad', 'unidades', 'mantenimiento',
  'muerto', 'falla', 'fallas', 'fallo', 'atascado', 'sucio', 'tapado', 'quemado',
  // ── the place (already `repeat_room_work_orders`' territory) ──
  'room', 'rooms', 'lobby', 'floor', 'floors', 'hall', 'hallway', 'building',
  'suite', 'suites', 'front', 'desk', 'office', 'pool', 'area', 'side', 'left',
  'right', 'upstairs', 'downstairs', 'outside', 'inside',
  'habitacion', 'habitaciones', 'cuarto', 'piso', 'pasillo', 'edificio', 'oficina',
  'recepcion', 'alberca', 'piscina', 'lado', 'afuera', 'adentro', 'arriba', 'abajo',
  // ── planted by Staxis itself, never by a person ──
  'staxis', 'planted', 'detector', 'exam',
]);

/** One work order's free text, as the counter sees it. */
export interface SuggestionSourceText {
  /** The work order's id. Identity for "how many SEPARATE tickets said this". */
  id: string;
  /** description + notes, or whatever the hotel wrote. */
  text: string;
}

export interface EquipmentTermCount {
  /** Lowercase, the comparison form. */
  term: string;
  /** The casing the hotel writes most often: "PTAC", not "ptac". */
  display: string;
  /** How many SEPARATE work orders mention it. */
  workOrders: number;
}

/**
 * Split free text into candidate equipment words.
 *
 * Accents are kept (`\p{L}` includes them) so "climatización" survives as one
 * token; punctuation, digits-only runs and anything shorter than three letters
 * do not. A token has to contain at least one letter, so a model number typed
 * on its own — "48-A-2019" — is not offered as the name of a machine.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_TERM_LENGTH || raw.length > MAX_TERM_LENGTH) continue;
    if (!/\p{L}/u.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

/**
 * Which words this hotel keeps writing, and how many separate tickets say each.
 *
 * DETERMINISTIC IN EVERY RESPECT, including the tie-breaks: same input, same
 * order, same display casing, forever. That is what makes "we asked about PTAC
 * and they said no" a promise the ledger can keep — a suggestion whose term
 * drifted between two runs would be asked again under a different topic, which
 * is precisely the never-twice rule failing while looking like it works.
 */
export function countEquipmentTerms(sources: readonly SuggestionSourceText[]): EquipmentTermCount[] {
  /** term → work-order ids that mention it. A Set, so one ticket counts once. */
  const ticketsByTerm = new Map<string, Set<string>>();
  /** term → casing → how many times written that way. */
  const casings = new Map<string, Map<string, number>>();

  for (const source of sources) {
    const seen = new Set<string>();
    for (const token of tokenize(source.text)) {
      const term = token.toLowerCase();
      if (STOPWORDS.has(term)) continue;

      const casingCounts = casings.get(term) ?? new Map<string, number>();
      casingCounts.set(token, (casingCounts.get(token) ?? 0) + 1);
      casings.set(term, casingCounts);

      // One ticket, one vote — however many times it says the word.
      if (seen.has(term)) continue;
      seen.add(term);
      const tickets = ticketsByTerm.get(term) ?? new Set<string>();
      tickets.add(source.id);
      ticketsByTerm.set(term, tickets);
    }
  }

  const out: EquipmentTermCount[] = [];
  for (const [term, tickets] of ticketsByTerm) {
    out.push({ term, display: pickDisplay(casings.get(term)), workOrders: tickets.size });
  }

  // Most-written first; alphabetical within a tie, so two terms on the same
  // count are always offered in the same order.
  return out.sort((a, b) =>
    b.workOrders - a.workOrders || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0),
  );
}

/**
 * How the hotel most often writes this word — which is how the entry will be
 * named. "PTAC" if that is what they type; "boiler" if that is.
 *
 * Ties go to the lexicographically smallest form rather than to whichever the
 * Map happened to yield first, because insertion order depends on the row order
 * of a query and a name that changed with the sort would be a different topic.
 */
function pickDisplay(casingCounts: Map<string, number> | undefined): string {
  let best = '';
  let bestCount = -1;
  for (const [casing, count] of casingCounts ?? []) {
    if (count > bestCount || (count === bestCount && casing < best)) {
      best = casing;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Does this hotel already track something by that name?
 *
 * Containment in EITHER direction, because a registry entry is usually longer
 * than the word staff type: the term "ptac" is already tracked by an entry
 * called "PTAC units — rooms 201-240", and the term "elevator inspection" would
 * be already tracked by one called "Elevator". Being generous here is the safe
 * direction — the cost of a false match is a question that never gets asked, and
 * the cost of a miss is asking a hotel to log something already on its list.
 */
export function hasMatchingEquipment(term: string, equipmentNames: readonly string[]): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return equipmentNames.some((name) => {
    const hay = name.trim().toLowerCase();
    if (!hay) return false;
    return hay.includes(needle) || needle.includes(hay);
  });
}

/** The topic this offer is filed under. Stable across runs — the never-twice
 *  rule is keyed on it, and `agent_knowledge_questions.topic` caps at 80. */
export function equipmentSuggestionTopic(term: string): string {
  return `equipment:${term.trim().toLowerCase()}`.slice(0, 80);
}

/**
 * The terms worth offering, as drip-question candidates.
 *
 * PURE — no database, no clock. The server half reads the rows; this decides
 * what they mean, so the rule can be asserted directly instead of inferred from
 * a route's output.
 */
export function equipmentSuggestionCandidates(input: {
  sources: readonly SuggestionSourceText[];
  /** Every name on this hotel's equipment registry today. */
  equipmentNames: readonly string[];
  minWorkOrders?: number;
  /** Cap. The card asks ONE question, so a long list is wasted work. */
  limit?: number;
}): QuestionCandidate[] {
  const bar = input.minWorkOrders ?? MIN_WORK_ORDERS_MENTIONING;
  const limit = input.limit ?? 5;
  const out: QuestionCandidate[] = [];

  for (const counted of countEquipmentTerms(input.sources)) {
    if (counted.workOrders < bar) break; // sorted desc — nothing after this clears it
    if (hasMatchingEquipment(counted.term, input.equipmentNames)) continue;
    out.push(phraseEquipmentSuggestion(counted));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One counted term → the question and the row a "yes" would create.
 *
 * Both languages built HERE from the count, so the Spanish path is Spanish by
 * construction — there is no render-time lookup that could fall back to English.
 * The TERM ITSELF is never translated: it is what this hotel's own staff typed,
 * and a Spanish card offering to track "climatización" when every ticket says
 * "PTAC" would create an entry nobody recognises.
 */
export function phraseEquipmentSuggestion(counted: EquipmentTermCount): QuestionCandidate {
  const name = counted.display.slice(0, 120);
  const n = counted.workOrders;
  return {
    topic: equipmentSuggestionTopic(counted.term),
    category: 'equipment',
    en: `You've written "${name}" in ${n} work orders. Want to track it as equipment?`.slice(0, 300),
    es: `Han escrito "${name}" en ${n} órdenes de trabajo. ¿Quieren registrarlo como equipo?`.slice(0, 300),
    // Stored on the ledger row, and deliberately NOT written into agent_memory
    // the way every other "yes" is — see answerDripQuestion. The equipment row
    // IS the record; a memory sentence saying the same thing would be a second
    // copy of a fact with its own way of going stale.
    fact: `"${name}" is tracked as equipment at this hotel. A manager confirmed it after it appeared in ${n} work orders.`.slice(0, 500),
    findingId: null,
    suggestedEquipmentName: name,
  };
}
