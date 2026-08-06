// ═══════════════════════════════════════════════════════════════════════════
// Teach, Adjust, That's wrong, Remove — where each one is actually written.
//
// The Knows page shows five stores as one list, so the interesting part of
// every button is the ROUTING: a sentence typed into the box lands in one of
// three tables depending on what it says, and an Adjust on a contact is a
// different write from an Adjust on a rule.
//
// That routing lives here, behind an injected `KnowsStores`, for one reason:
// it is the part that can be wrong in a way nothing else notices. A rule that
// quietly becomes a fact still shows up on the list and still reads correctly;
// it simply stops governing anything. A test with fake stores can watch which
// door each sentence went through. A test against the real ones cannot run at
// all without a database.
//
// NOTHING HERE IMPORTS A STORE. The real implementations are wired up in
// /api/memory/knows, which is also the only place the tenant gate lives; this
// module never sees a session and never decides who may write.
//
// ─── THE INVARIANT ─────────────────────────────────────────────────────────
//
//   A TYPED SENTENCE IS NEVER LOST.
//
// `applyTeach` has exactly one failure: the fact store itself refusing. Every
// other disappointment along the way — the filer being down, a rule too long
// for the rules table, a contact with nobody in it, a store throwing — falls
// through to the plain-fact drawer, which holds anything. Read the fallbacks
// below as a chain with one floor, and do not add a branch that returns a
// refusal before reaching it.
// ═══════════════════════════════════════════════════════════════════════════

import type { Filed } from '@/lib/agent/knows-filing';
import type { MemoryCategory } from '@/lib/agent/memory-facets';
import type { KnowsItemKind } from './page-model';

/** Who is writing. Names only, for authorship columns. */
export interface KnowsActor {
  propertyId: string;
  accountId: string;
  displayName: string | null;
  role: string;
}

export interface StoreOutcome {
  ok: boolean;
  /** False when the row was not there (already gone, or another hotel's). */
  hit?: boolean;
  /** A refusal a person should read, when the store has one worth showing. */
  message?: string;
}

/**
 * Every store write the page can perform, as functions rather than imports.
 *
 * Deliberately narrow: each entry is the seam that store ALREADY had, or (for
 * the three renames) a seam added to it that touches one column. There is no
 * generic "update anything" door here, so this module cannot grow the power to
 * re-scope a document or reassign a rule's author.
 */
export interface KnowsStores {
  file: (sentence: string) => Promise<Filed>;
  /** PII masking, applied to anything that lands in long-term memory. */
  redact: (text: string) => string;

  storeFact: (input: {
    topic: string; content: string; category: MemoryCategory; actor: KnowsActor;
  }) => Promise<StoreOutcome>;
  editFact: (id: string, content: string, actor: KnowsActor) => Promise<StoreOutcome>;
  removeFact: (id: string, actor: KnowsActor) => Promise<StoreOutcome>;

  storeRule: (text: string, actor: KnowsActor) => Promise<StoreOutcome>;
  editRule: (id: string, text: string, actor: KnowsActor) => Promise<StoreOutcome>;
  removeRule: (id: string, actor: KnowsActor) => Promise<StoreOutcome>;

  storeContact: (contact: NonNullable<Filed['contact']>, actor: KnowsActor) => Promise<StoreOutcome>;
  editContact: (id: string, contact: NonNullable<Filed['contact']>, actor: KnowsActor) => Promise<StoreOutcome>;
  removeContact: (id: string, actor: KnowsActor) => Promise<StoreOutcome>;

  renameDocument: (id: string, title: string, actor: KnowsActor) => Promise<StoreOutcome>;
  removeDocument: (id: string, actor: KnowsActor) => Promise<StoreOutcome>;
  renameSop: (id: string, title: string, actor: KnowsActor) => Promise<StoreOutcome>;
  removeSop: (id: string, actor: KnowsActor) => Promise<StoreOutcome>;
}

/** Which drawer a sentence ended up in, or why nothing could be written. */
export type KnowsWrite =
  | { ok: true; filedAs: KnowsItemKind }
  | { ok: false; reason: 'save_failed' | 'gone' | 'invalid'; message: string };

const SAVE_FAILED = 'That did not save. Try again in a moment.';
const GONE = 'That one is not here anymore.';

/**
 * One typed sentence, filed.
 *
 * The order is: ask which drawer, try that drawer, and fall to the fact drawer
 * on anything at all. A refusal from the rules table is logged by the caller
 * and then IGNORED here on purpose — a manager whose sentence was four
 * characters too long for a standing rule should get a fact, not an error
 * message about a character limit they were never shown.
 */
export async function applyTeach(
  stores: KnowsStores,
  actor: KnowsActor,
  text: string,
  onFallback?: (reason: string) => void,
): Promise<KnowsWrite> {
  const sentence = text.trim();
  if (!sentence) return { ok: false, reason: 'invalid', message: 'Write something first.' };

  let filed: Filed;
  try {
    filed = await stores.file(sentence);
  } catch {
    // `fileTypedSentence` does not throw, but a store map assembled wrong
    // could. The sentence still survives.
    onFallback?.('filer_threw');
    filed = { drawer: 'fact', topic: '', category: 'rhythm', contact: null };
  }

  if (filed.drawer === 'rule') {
    const res = await safely(() => stores.storeRule(sentence, actor));
    if (res.ok) return { ok: true, filedAs: 'rule' };
    onFallback?.(res.message ?? 'rule_refused');
  }

  if (filed.drawer === 'contact' && filed.contact) {
    const res = await safely(() => stores.storeContact(filed.contact!, actor));
    if (res.ok) return { ok: true, filedAs: 'contact' };
    onFallback?.(res.message ?? 'contact_refused');
  }

  // The floor. Everything that reaches here is saved as a plain taught fact.
  const content = stores.redact(sentence).trim();
  if (!content) return { ok: false, reason: 'save_failed', message: SAVE_FAILED };
  const stored = await safely(() => stores.storeFact({
    topic: filed.topic || fallbackTopicFor(sentence),
    content,
    category: filed.category,
    actor,
  }));
  if (!stored.ok) return { ok: false, reason: 'save_failed', message: SAVE_FAILED };
  return { ok: true, filedAs: 'fact' };
}

/** Reword one row, in the store it came from. */
export async function applyAdjust(
  stores: KnowsStores,
  actor: KnowsActor,
  kind: KnowsItemKind,
  id: string,
  text: string,
): Promise<KnowsWrite> {
  const next = text.trim();
  if (!next) return { ok: false, reason: 'invalid', message: 'Write something first.' };

  if (kind === 'fact') {
    const content = stores.redact(next).trim();
    if (!content) return { ok: false, reason: 'invalid', message: 'Write something first.' };
    return outcome(kind, await safely(() => stores.editFact(id, content, actor)));
  }
  if (kind === 'rule') {
    return outcome(kind, await safely(() => stores.editRule(id, next, actor)));
  }
  if (kind === 'contact') {
    // The edited sentence goes back through the same filing pass that created
    // the row, so "Mike is on 555-9999 now" re-reads as a contact instead of
    // sending the manager hunting for a form with a phone field on it.
    let filed: Filed | null = null;
    try {
      filed = await stores.file(next);
    } catch {
      filed = null;
    }
    if (!filed?.contact) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'Say who it is, and a number if you have one.',
      };
    }
    return outcome(kind, await safely(() => stores.editContact(id, filed.contact!, actor)));
  }
  // A file and a procedure are both rendered as "you added / wrote X", so the
  // only thing there is to adjust is the name.
  const res = kind === 'document'
    ? await safely(() => stores.renameDocument(id, next, actor))
    : await safely(() => stores.renameSop(id, next, actor));
  return outcome(kind, res);
}

/** Stop believing one row, and stop showing it. */
export async function applyDrop(
  stores: KnowsStores,
  actor: KnowsActor,
  kind: KnowsItemKind,
  id: string,
): Promise<KnowsWrite> {
  const res = await safely(() => {
    switch (kind) {
      case 'fact': return stores.removeFact(id, actor);
      case 'rule': return stores.removeRule(id, actor);
      case 'contact': return stores.removeContact(id, actor);
      case 'document': return stores.removeDocument(id, actor);
      default: return stores.removeSop(id, actor);
    }
  });
  if (!res.ok) return { ok: false, reason: 'save_failed', message: 'Could not remove that.' };
  if (res.hit === false) return { ok: false, reason: 'gone', message: GONE };
  return { ok: true, filedAs: kind };
}

// ─── Plumbing ───────────────────────────────────────────────────────────────

async function safely(run: () => Promise<StoreOutcome>): Promise<StoreOutcome> {
  try {
    return await run();
  } catch {
    // A store that throws is a store that did not write. Nothing here decides
    // that a throw means "gone" — that would turn an outage into a silent
    // 404 and teach the screen to say "somebody removed it".
    return { ok: false };
  }
}

function outcome(kind: KnowsItemKind, res: StoreOutcome): KnowsWrite {
  if (!res.ok) {
    return { ok: false, reason: res.message ? 'invalid' : 'save_failed', message: res.message ?? SAVE_FAILED };
  }
  if (res.hit === false) return { ok: false, reason: 'gone', message: GONE };
  return { ok: true, filedAs: kind };
}

/** Last-resort dedupe key, when even the filer produced no topic. Mirrors
 *  `fallbackTopic` in knows-filing.ts; kept local so this module stays free of
 *  anything that reaches a provider. */
function fallbackTopicFor(sentence: string): string {
  const slug = sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('_')
    .slice(0, 80);
  return slug || 'taught_note';
}
