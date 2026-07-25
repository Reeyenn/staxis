// ─── A finding the judge turned into a question ──────────────────────────────
//
// WHY THIS FILE IS AN ADAPTER AND NOT A FEATURE
// The judge may sort a finding as `ask`: the data behind it is too thin or too
// old to tell a manager what to do, so the honest move is to ask them. The card
// surface deliberately refuses those (`isCardRenderable`), and until now they
// simply went nowhere.
//
// The obvious fix — render `ask` findings as a second kind of card with a
// yes/no on it — is the wrong one, because Staxis already has exactly one place
// it asks a manager a question, and that place owns three promises that took
// real work to get right:
//
//   • at most ONE question per session
//   • never the same question twice, and never again after any answer
//   • an ignored question is gone for the rest of the day, and gives up for
//     good after three asks
//
// A second question surface would either duplicate those rules or quietly break
// them. So this file does not ask anything. It turns a finding into the shape
// the existing drip pipeline already consumes and hands it over; the ledger,
// the cap and the never-twice rule stay exactly where they are.
//
// WHAT COMES FROM WHERE
//   the QUESTION   the judge's bilingual phrasing, which has already been
//                  through the prose guard — every number in it is one the
//                  finding's own payload vouches for.
//   the FACT       the DETECTOR's deterministic summary, never the model's
//                  sentence. A "yes" writes a permanent, human-authored fact
//                  into the hotel's knowledge, and the thing that gets written
//                  down forever should come from the half of this system that
//                  cannot phrase its way into being wrong.

import 'server-only';

import { createHash } from 'node:crypto';

import { scopedDb } from '@/lib/agent/scoped-db';
import { redactMemoryContent } from '@/lib/agent/memory-redact';
import { log } from '@/lib/log';
import type { QuestionCandidate } from '@/lib/agent/drip-questions';

/**
 * A stable, bounded topic for a finding.
 *
 * `agent_knowledge_questions.topic` is CHECK-capped at 80 characters and
 * `findings.dedupe_key` runs to 200, so the identity is hashed rather than
 * truncated: two problems whose keys share a prefix must never collapse into
 * one question that is then never asked again. The detector id rides in front
 * because a topic nobody can read in a database console is a topic nobody can
 * debug.
 *
 * Deterministic across nights, which is what makes never-ask-twice work: the
 * same problem re-found next week produces the same topic and the ledger
 * recognises it.
 */
export function findingQuestionTopic(detectorId: string, dedupeKey: string): string {
  const hash = createHash('sha256').update(dedupeKey).digest('hex').slice(0, 10);
  return `finding:${detectorId.slice(0, 40)}:${hash}`;
}

interface AskRow {
  id: string;
  detector_id: string;
  dedupe_key: string;
  summary: string;
  judged_summary_en: string | null;
  judged_summary_es: string | null;
}

/** Bounded: the drip card asks one question, so a long list is wasted work. */
const MAX_ASK_FINDINGS = 20;

/**
 * The `ask` findings at this hotel, as drip-question candidates.
 *
 * Only findings the judge has actually phrased in BOTH languages are eligible.
 * That is not a nicety — `question_es` is NOT NULL and a Spanish-speaking
 * manager must never be handed English wearing a Spanish label. A finding the
 * judge marked `ask` always has both (its template fallback writes both too), so
 * in practice this filter only excludes rows the judge has not reached yet.
 *
 * Returns an empty list on any failure. A question is a nicety; a broken one
 * must never take down the screen it lives on.
 */
export async function findingAskCandidates(propertyId: string): Promise<QuestionCandidate[]> {
  try {
    const { data, error } = await scopedDb(propertyId)
      .from('findings')
      .select('id, detector_id, dedupe_key, summary, judged_summary_en, judged_summary_es')
      .eq('judged_disposition', 'ask')
      .in('status', ['open', 'updated'])
      .limit(MAX_ASK_FINDINGS);
    if (error) {
      log.warn('[findings] ask-finding read failed; no finding questions this time', {
        propertyId,
        err: error.message,
      });
      return [];
    }

    const out: QuestionCandidate[] = [];
    for (const row of (data ?? []) as unknown as AskRow[]) {
      const candidate = toQuestionCandidate(row);
      if (candidate) out.push(candidate);
    }
    return out;
  } catch (e) {
    log.warn('[findings] ask-finding read threw; no finding questions this time', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/** Pure: one row → one candidate, or null when it cannot be asked honestly. */
export function toQuestionCandidate(row: {
  id: string;
  detector_id: string;
  dedupe_key: string;
  summary: string;
  judged_summary_en: string | null;
  judged_summary_es: string | null;
}): QuestionCandidate | null {
  const en = (row.judged_summary_en ?? '').trim();
  const es = (row.judged_summary_es ?? '').trim();
  if (!en || !es) return null;

  // The fact a "yes" would store. Built from the DETECTOR's sentence, run
  // through the same redaction the nightly learner applies before anything
  // reaches agent_memory.
  const fact = redactMemoryContent(
    `${row.summary.trim()} Confirmed by a manager as a known problem at this hotel.`.slice(0, 500),
  ).content.trim();
  if (!fact) return null;

  return {
    topic: findingQuestionTopic(row.detector_id, row.dedupe_key),
    category: 'finding',
    // Turned into an actual question. The judge writes statements — "supply
    // spend is well above normal" — and a card with Yes/No under a statement
    // asks the manager to guess what they are agreeing to.
    en: `${en} Is that a known problem here?`.slice(0, 300),
    es: `${es} ¿Es un problema conocido aquí?`.slice(0, 300),
    fact,
    findingId: row.id,
  };
}
