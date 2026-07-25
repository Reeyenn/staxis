// ─── Drip questions ("the one thing Staxis asks you today") ──────────────────
//
// WHAT THIS IS
// The copilot already notices durable operational patterns in the hotel's own
// data — operational-signals.ts detects "4 hvac work orders on room 214 in 30
// days" with deterministic SQL and no model call. Until now the only thing it
// could do with that was file a LOW-confidence guess into agent_memory. This
// module lets it occasionally ask the manager ONE one-tap question instead:
//
//     "4 hvac work orders on room 214 in the last 30 days — known problem room?"
//
// A "yes" is stored as a HUMAN-AUTHORED, non-expiring fact (source
// 'explicit_user', confidence 'high'), which upgrades the auto-learned row in
// place and gains the 0260/0261 protection against the nightly learner
// overwriting it. A "no" is recorded as a decline and the question is never
// asked again.
//
// THE TWO PRODUCT RULES, AND WHERE EACH IS ENFORCED
//   1. At most ONE question per session. `selectQuestion` returns at most one
//      candidate, and the client marks the session as asked the first time it
//      calls (src/lib/drip-question-session.ts) so a second card cannot appear
//      after an answer or a route change.
//   2. It never adds a step to anyone's job. The card is dismissible, never
//      blocking. Ignoring it is a legitimate answer: the ask is RECORDED when
//      it is served, so an ignored question cannot return the same day, and
//      `MAX_ASKS_PER_TOPIC` stops it returning forever.
//
// COST
// Detection is the existing deterministic SQL. Phrasing is a template, not a
// model call — there is no LLM anywhere in this file, so a hotel can be asked a
// question with the provider down and at zero marginal cost.
//
// TENANCY
// Everything reads through `scopedDb(propertyId)`; there is no unfiltered
// builder in here to forget a hotel filter on. The one write that does not go
// through the accessor is the memory write itself, which goes through
// `storeMemory` — the sanctioned door, whose RPC takes p_property_id.

import 'server-only';
import { scopedDb } from './scoped-db';
import { gatherOperationalSignals, type OperationalSignal } from './operational-signals';
import { redactMemoryContent } from './memory-redact';
import { storeMemory } from '@/lib/db/agent-memory';
import { propertyLocalToday } from '@/lib/schedule/local-date';
import { log } from '@/lib/log';

/** How many times one topic may be SERVED before Staxis gives up on it for
 *  good. Three unanswered asks, spread across three different days, is the
 *  point at which asking a fourth time stops being helpful and starts being
 *  the thing this feature exists not to be. */
export const MAX_ASKS_PER_TOPIC = 3;

/** How the question ledger looks to the pure selector. */
export interface AskRecord {
  topic: string;
  status: 'asked' | 'answered_yes' | 'declined';
  /** Hotel-local business date, YYYY-MM-DD. */
  lastAskedOn: string;
  askCount: number;
}

/** What the manager is shown. Both languages are carried, never translated at
 *  render time — see `phraseSignal`. */
export interface DripQuestion {
  topic: string;
  category: OperationalSignal['category'];
  en: string;
  es: string;
}

interface PhrasedSignal {
  signal: OperationalSignal;
  en: string;
  es: string;
  /** The sentence a "yes" stores into agent_memory. */
  fact: string;
}

// ─── Sanitising the hotel's own data ─────────────────────────────────────────
// Room numbers and work-order categories are free text out of a PMS or a staff
// member's typing. They end up in a stored memory the copilot reads back, so
// they are bounded and stripped of anything that is not plainly a label.

function safeLabel(raw: string | null | undefined, max: number): string | null {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/[^\p{L}\p{N} /&.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || null;
}

/** Sub-categories we can say in Spanish without guessing. Everything else — a
 *  free-text PMS work-order category — is carried through verbatim in BOTH
 *  languages rather than mistranslated. (The `complaints.category` CHECK set is
 *  covered in full; that is where most of these come from.) */
const DETAIL_ES: Readonly<Record<string, string>> = Object.freeze({
  maintenance: 'mantenimiento',
  cleanliness: 'limpieza',
  noise: 'ruido',
  service: 'servicio',
  billing: 'facturación',
  amenities: 'amenidades',
  hvac: 'climatización',
  plumbing: 'plomería',
  electrical: 'electricidad',
});

/** 'other' carries no information — a question reads better without it. */
function usefulDetail(raw: string | null): string | null {
  const d = safeLabel(raw, 32);
  if (!d) return null;
  return d.toLowerCase() === 'other' ? null : d.toLowerCase();
}

// ─── Phrasing (templates, no model) ──────────────────────────────────────────

/**
 * Turn one detected pattern into the question and the fact it would become.
 *
 * Returns null when the signal cannot be phrased into something a manager could
 * answer with one tap — a pattern with no room or floor attached, for instance.
 * Saying nothing is always allowed; asking a question with a hole in it is not.
 *
 * Both languages are built HERE, from the signal's structured fields, so the
 * Spanish path is Spanish by construction. There is no render-time lookup that
 * could silently fall back to English.
 */
export function phraseSignal(signal: OperationalSignal): PhrasedSignal | null {
  const target = safeLabel(signal.targetValue, 16);
  if (!target || !signal.targetKind) return null;
  const n = signal.count;
  const days = signal.windowDays;
  const detail = usefulDetail(signal.detail);
  const detailEs = detail ? (DETAIL_ES[detail] ?? detail) : null;

  let en: string;
  let es: string;
  let fact: string;

  switch (signal.category) {
    case 'maintenance': {
      const whatEn = detail ? `${detail} work orders` : 'work orders';
      const whatEs = detailEs ? `órdenes de trabajo de ${detailEs}` : 'órdenes de trabajo';
      en = `${n} ${whatEn} on room ${target} in the last ${days} days — known problem room?`;
      es = `${n} ${whatEs} en la habitación ${target} en los últimos ${days} días — ¿es una habitación con un problema conocido?`;
      fact = detail
        ? `Room ${target} is a known problem room for ${detail} — confirmed by a manager (${n} ${detail} work orders in ${days} days).`
        : `Room ${target} is a known problem room for maintenance — confirmed by a manager (${n} work orders in ${days} days).`;
      break;
    }
    case 'complaint': {
      const whatEn = detail ? `${detail} complaints` : 'guest complaints';
      const whatEs = detailEs ? `quejas de ${detailEs}` : 'quejas de huéspedes';
      en = `${n} ${whatEn} about room ${target} in the last ${days} days — known issue with that room?`;
      es = `${n} ${whatEs} sobre la habitación ${target} en los últimos ${days} días — ¿es un problema conocido de esa habitación?`;
      fact = detail
        ? `Room ${target} has a known recurring ${detail} problem guests complain about — confirmed by a manager (${n} ${detail} complaints in ${days} days).`
        : `Room ${target} has a known recurring problem guests complain about — confirmed by a manager (${n} complaints in ${days} days).`;
      break;
    }
    case 'noise': {
      en = `${n} weekend noise complaints on floor ${target} in the last ${days} days — is that floor a known noise problem?`;
      es = `${n} quejas de ruido de fin de semana en el piso ${target} en los últimos ${days} días — ¿es un problema conocido de ese piso?`;
      fact = `Floor ${target} is a known weekend noise problem — confirmed by a manager (${n} weekend noise complaints in ${days} days).`;
      break;
    }
    case 'inspection': {
      en = `Room ${target} failed inspection ${n} times in the last ${days} days — is something wrong with the room itself?`;
      es = `La habitación ${target} falló la inspección ${n} veces en los últimos ${days} días — ¿hay algo mal con la habitación misma?`;
      fact = `Room ${target} has a standing problem that keeps failing housekeeping inspection — confirmed by a manager (${n} failed inspections in ${days} days).`;
      break;
    }
    case 'cleaning': {
      // The minutes live only in the signal's English `metric`, so this one
      // question is phrased without numbers rather than half-translated.
      en = `Room ${target} consistently takes longer to clean than your other rooms — is there something about that room?`;
      es = `La habitación ${target} siempre tarda más en limpiarse que las demás — ¿hay algo especial en esa habitación?`;
      fact = `Room ${target} genuinely takes longer to clean than a typical room here — confirmed by a manager.`;
      break;
    }
    default:
      return null;
  }

  // Same redaction the nightly learner applies before anything reaches
  // agent_memory: the inputs are counts and room labels, and this keeps it that
  // way even if a category field ever carries something it shouldn't.
  const safeFact = redactMemoryContent(fact.slice(0, 500)).content.trim();
  if (!safeFact) return null;

  return { signal, en: en.slice(0, 300), es: es.slice(0, 300), fact: safeFact };
}

// ─── Selection (pure — this is the never-be-obnoxious policy) ────────────────

export interface SelectQuestionInput {
  /** Detected patterns, already ranked by `rankAndCapSignals`. */
  signals: OperationalSignal[];
  /** Everything this hotel has ever been asked. */
  records: AskRecord[];
  /** Topics whose memory row a human deactivated. They said their piece by
   *  deleting it; re-asking would be the same nag wearing a question mark. */
  deactivatedTopics: string[];
  /** The hotel's local business date, YYYY-MM-DD. */
  today: string;
  maxAsks?: number;
}

/**
 * Choose AT MOST ONE question, or none.
 *
 * A topic is skipped when, in order:
 *   • a human deactivated its memory row;
 *   • it was answered "yes" (it is a confirmed fact now — asking again would be
 *     asking a manager to re-confirm what they already told us);
 *   • it was declined (the failure mode this whole feature is judged on);
 *   • it was already served TODAY (ignoring is an answer, and it is respected
 *     for the rest of the day);
 *   • it has been served `maxAsks` times without a verdict.
 *
 * Everything else is a candidate, and the first phraseable one wins. Signals
 * arrive pre-ranked (attention before info, then by count), so "first" means
 * "the one most worth a manager's single tap".
 */
export function selectQuestion(input: SelectQuestionInput): PhrasedSignal | null {
  const maxAsks = input.maxAsks ?? MAX_ASKS_PER_TOPIC;
  const byTopic = new Map(input.records.map((r) => [r.topic, r]));
  const deactivated = new Set(input.deactivatedTopics);

  for (const signal of input.signals) {
    if (deactivated.has(signal.topic)) continue;
    const record = byTopic.get(signal.topic);
    if (record) {
      if (record.status !== 'asked') continue; // answered or declined — never again
      if (record.lastAskedOn === input.today) continue; // already asked today
      if (record.askCount >= maxAsks) continue; // asked enough; stop for good
    }
    const phrased = phraseSignal(signal);
    if (phrased) return phrased;
  }
  return null;
}

// ─── Server orchestration ────────────────────────────────────────────────────

interface LedgerRow {
  topic: string;
  status: string;
  last_asked_on: string;
  ask_count: number;
}

/** The hotel's own calendar day — "did we ask today?" is a local question. */
async function hotelToday(db: ReturnType<typeof scopedDb>, now: Date): Promise<string> {
  const { data } = await db.from('properties').select('timezone').maybeSingle();
  const tz = (data as { timezone?: string | null } | null)?.timezone ?? null;
  return propertyLocalToday(now, tz);
}

/**
 * The one question this hotel should be asked right now, or null.
 *
 * Serving a question RECORDS the ask before returning it. That write is what
 * makes "ignored → gone for the day" true, so a question we could not record is
 * a question we do not ask: every failure path below returns null rather than
 * risk a card that reappears on every page load.
 *
 * Day zero (a brand-new hotel with no operational history) exits on the first
 * line with zero further queries and no card.
 */
export async function getDripQuestion(
  propertyId: string,
  now: Date = new Date(),
): Promise<DripQuestion | null> {
  const signals = await gatherOperationalSignals(propertyId);
  if (signals.length === 0) return null; // day zero — never invent a question

  const db = scopedDb(propertyId);

  const [ledgerRes, memoryRes] = await Promise.all([
    db.from('agent_knowledge_questions').select('topic, status, last_asked_on, ask_count').limit(500),
    db.from('agent_memory').select('topic').eq('scope', 'property').eq('is_active', false).limit(200),
  ]);

  // A ledger we cannot read is a ledger we cannot honour. Ask nothing rather
  // than risk re-asking something already answered or declined. (This is also
  // what makes the code safe to deploy before migration 0359 is applied.)
  if (ledgerRes.error) {
    log.warn('[drip-questions] question ledger unreadable; asking nothing', {
      propertyId,
      err: ledgerRes.error.message,
    });
    return null;
  }

  const records: AskRecord[] = ((ledgerRes.data ?? []) as LedgerRow[])
    .filter((r) => r.status === 'asked' || r.status === 'answered_yes' || r.status === 'declined')
    .map((r) => ({
      topic: r.topic,
      status: r.status as AskRecord['status'],
      lastAskedOn: String(r.last_asked_on ?? '').slice(0, 10),
      askCount: Number(r.ask_count ?? 0),
    }));

  const today = await hotelToday(db, now);
  const chosen = selectQuestion({
    signals,
    records,
    deactivatedTopics: ((memoryRes.data ?? []) as Array<{ topic: string }>).map((r) => r.topic),
    today,
  });
  if (!chosen) return null;

  const existing = records.find((r) => r.topic === chosen.signal.topic);
  const nowIso = now.toISOString();
  const recorded = existing
    ? await db
        .from('agent_knowledge_questions')
        .update({
          ask_count: existing.askCount + 1,
          last_asked_at: nowIso,
          last_asked_on: today,
          // Re-freeze the wording: the counts have moved since the last ask.
          question_en: chosen.en,
          question_es: chosen.es,
          fact_content: chosen.fact,
        })
        .eq('topic', chosen.signal.topic)
        // Guard against a concurrent tab answering between the read and here.
        .eq('status', 'asked')
        .select('id')
    : await db
        .from('agent_knowledge_questions')
        .insert({
          topic: chosen.signal.topic,
          category: chosen.signal.category,
          question_en: chosen.en,
          question_es: chosen.es,
          fact_content: chosen.fact,
          status: 'asked',
          ask_count: 1,
          first_asked_at: nowIso,
          last_asked_at: nowIso,
          last_asked_on: today,
        })
        .select('id');

  if (recorded.error || (recorded.data ?? []).length === 0) {
    // Either the write failed or another tab won the race. Both mean "not our
    // question to ask" — stay quiet.
    if (recorded.error) {
      log.warn('[drip-questions] could not record the ask; asking nothing', {
        propertyId,
        err: recorded.error.message,
      });
    }
    return null;
  }

  return {
    topic: chosen.signal.topic,
    category: chosen.signal.category,
    en: chosen.en,
    es: chosen.es,
  };
}

export interface AnswerDripQuestionInput {
  propertyId: string;
  topic: string;
  answer: 'yes' | 'no';
  actor: { accountId: string | null; name: string | null; role: string | null };
}

export interface AnswerDripQuestionResult {
  ok: boolean;
  /** False when there was nothing outstanding to answer (an unknown topic or a
   *  replayed tap). Not an error the manager should ever see. */
  recorded: boolean;
  /** True when the answer became a human-authored fact. */
  storedFact?: boolean;
  error?: string;
}

/**
 * Record the manager's one tap.
 *
 * "Yes" writes a HUMAN-AUTHORED fact: source 'explicit_user', confidence
 * 'high', and no expiry. That is the whole upgrade — staxis_store_memory (0260 /
 * 0261) then refuses to let the nightly auto-learner overwrite or expire it,
 * and it stops ageing out at 75 days like the guess it replaces.
 *
 * "No" writes no fact at all. It is recorded as a decline, which is a different
 * thing from a deleted fact and is stored somewhere different on purpose.
 *
 * Idempotent: a replayed tap on an already-answered question changes nothing.
 */
export async function answerDripQuestion(
  input: AnswerDripQuestionInput,
): Promise<AnswerDripQuestionResult> {
  const db = scopedDb(input.propertyId);

  const { data, error } = await db
    .from('agent_knowledge_questions')
    .select('id, topic, fact_content, status')
    .eq('topic', input.topic)
    .maybeSingle();
  if (error) return { ok: false, recorded: false, error: error.message };

  const row = data as { id: string; topic: string; fact_content: string; status: string } | null;
  if (!row || row.status !== 'asked') return { ok: true, recorded: false };

  let memoryId: string | null = null;
  if (input.answer === 'yes') {
    const stored = await storeMemory({
      propertyId: input.propertyId,
      scope: 'property',
      subjectAccountId: null,
      topic: row.topic,
      content: row.fact_content,
      // A manager confirming a pattern is a HUMAN authoring a fact, not the
      // learner guessing again. Anything weaker would leave it expiring and
      // overwritable, which would make the tap meaningless.
      source: 'explicit_user',
      confidence: 'high',
      createdByAccountId: input.actor.accountId,
      createdByName: input.actor.name,
      createdByRole: input.actor.role,
      expiresAt: null,
    });
    if (!stored.ok) return { ok: false, recorded: false, error: stored.error };
    if (stored.action === 'property_full') {
      return { ok: false, recorded: false, error: 'This hotel has reached its saved-knowledge limit.' };
    }
    memoryId = stored.memoryId ?? null;
  }

  const verdict = await db
    .from('agent_knowledge_questions')
    .update({
      status: input.answer === 'yes' ? 'answered_yes' : 'declined',
      answered_at: new Date().toISOString(),
      answered_by_account_id: input.actor.accountId,
      memory_id: memoryId,
    })
    .eq('topic', input.topic)
    .eq('status', 'asked')
    .select('id');
  if (verdict.error) return { ok: false, recorded: false, error: verdict.error.message };

  return {
    ok: true,
    recorded: (verdict.data ?? []).length > 0,
    storedFact: input.answer === 'yes' && memoryId !== null,
  };
}
