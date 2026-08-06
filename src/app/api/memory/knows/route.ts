/**
 * "What Staxis knows about your hotel" — the whole Knows page, one URL.
 *
 * GET  ?propertyId=<uuid>
 *   → { ok, data: { items, canTeach, canSeeNoticed } }
 *   Every row on the page, from five stores, each already rendered as ONE plain
 *   sentence. `items[].kind` says which store a row came out of, because that
 *   is what decides where its correction is written back to.
 *
 * POST { propertyId, action, ... }
 *   teach   { text }              file one typed sentence into the right drawer.
 *   adjust  { kind, id, text }    reword one row in its own store.
 *   wrong   { kind, id, text? }   a noticed row is not true. With text, the
 *                                 correction is recorded; without, the row is
 *                                 dropped so nothing goes on believing it.
 *   remove  { kind, id }          take back something a person said.
 *
 * ── WHY THIS ROUTE GREW RATHER THAN A NEW ONE APPEARING ────────────────────
 * The page is ONE list assembled across `agent_memory`, `hotel_standing_rules`,
 * `knowledge_contacts`, `knowledge_documents` and `knowledge_articles`. Read
 * from the browser that is five requests and a client that has to know five
 * write shapes; the point of the rebuild is that the person does not know
 * there are five drawers, and neither should the screen. This route is already
 * called "what Staxis knows", so it is the one that widened.
 *
 * The PAPERCLIP does not come here. A file still goes presign, PUT, register
 * through /api/knowledge/documents, the one seam that also indexes it for
 * search. The row it creates then shows up in this route's GET as a sentence.
 * A second register path would have been a second place to get indexing wrong.
 *
 * ── AUTH, AND THE ONE THING THAT MUST NOT REGRESS ──────────────────────────
 * `commsContext` + KNOWLEDGE_CTX, the same gate every /api/knowledge/* route
 * uses: session, hotel access, and no section toggle (knowledge is not owned by
 * one section).
 *
 * Reading the TAUGHT half is open to everybody signed in at this hotel. That is
 * not a relaxation, it is the rule the contact directory has always had: before
 * this page existed the front desk could open the directory and tap an
 * emergency number, and collapsing that directory into sentences must not
 * quietly take it away. Reading the NOTICED half stays a manager view, exactly
 * as it was, because those rows are `agent_memory` and that has always been
 * manager-only. Every WRITE is manager-only and re-checked here, and the writes
 * that touch the knowledge hub additionally run the `manage_knowledge`
 * capability check the hub's own routes run, so a hotel that restricted it from
 * the Access tab keeps that restriction on this screen too.
 *
 * `agent_memory`, `hotel_standing_rules` and the `knowledge_*` tables are all
 * deny-all to the browser. Every read and write below goes through a module
 * that filters on property_id, and THAT filter is the per-tenant guarantee.
 */

import { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { commsContext, KNOWLEDGE_CTX } from '@/lib/comms/route-helpers';
import { capabilityDecisionForUserId } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import type { AppRole } from '@/lib/roles';
import {
  listMemory,
  editMemoryFact,
  removeMemoryFact,
  storeMemory,
  type MemoryRow,
} from '@/lib/db/agent-memory';
import { redactMemoryContent } from '@/lib/agent/memory-redact';
import {
  listStandingRules,
  storeStandingRule,
  updateStandingRule,
  removeStandingRule,
} from '@/lib/companion/rules';
import {
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  listDocuments,
  renameDocument,
  deleteDocument,
  listArticles,
  renameArticle,
  deleteArticle,
} from '@/lib/knowledge/core';
import {
  contactSentence,
  documentSentence,
  groupForMemorySource,
  knowsTelHref,
  plainSentence,
  sopSentence,
  sortKnowsItems,
  TEACH_MAX_CHARS,
  type KnowsItem,
  type KnowsItemKind,
} from '@/lib/knows/page-model';
import {
  applyAdjust,
  applyDrop,
  applyTeach,
  type KnowsActor,
  type KnowsStores,
} from '@/lib/knows/writes';
import { fileTypedSentence } from '@/lib/knows/filing-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ITEM_KINDS: readonly KnowsItemKind[] = ['fact', 'rule', 'contact', 'document', 'sop'];

function isItemKind(value: unknown): value is KnowsItemKind {
  return typeof value === 'string' && (ITEM_KINDS as readonly string[]).includes(value);
}

// ─── Read ───────────────────────────────────────────────────────────────────

/** Every remembered fact, split into the two groups by who authored it. */
function memoryItems(rows: readonly MemoryRow[]): KnowsItem[] {
  const out: KnowsItem[] = [];
  for (const row of rows) {
    const sentence = plainSentence(row.content);
    if (!sentence) continue;
    out.push({
      id: row.id,
      kind: 'fact',
      group: groupForMemorySource(row.source),
      sentence,
      tel: null,
      telText: null,
      at: row.updatedAt,
    });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const propertyIdRaw = new URL(req.url).searchParams.get('propertyId');
  const ctx = await commsContext(req, propertyIdRaw, KNOWLEDGE_CTX);
  if (!ctx.ok) return ctx.response;

  const items: KnowsItem[] = [];

  // Everything a person told it. Open to everybody at this hotel: see the
  // header, and told-knowledge.ts's canReadTold, which this preserves.
  const [rules, contacts, documents, articles] = await Promise.all([
    listStandingRules(ctx.pid),
    listContacts(ctx.pid),
    listDocuments(ctx.pid, { role: ctx.role as AppRole, dept: ctx.dept }),
    listArticles(ctx.pid, ctx.role as AppRole),
  ]);

  for (const rule of rules) {
    const sentence = plainSentence(rule.ruleText);
    if (sentence) {
      items.push({ id: rule.id, kind: 'rule', group: 'taught', sentence, tel: null, telText: null, at: rule.createdAt });
    }
  }
  for (const contact of contacts) {
    const sentence = contactSentence(contact);
    if (sentence) {
      items.push({
        id: contact.id,
        kind: 'contact',
        group: 'taught',
        sentence,
        tel: knowsTelHref(contact.phone),
        // The number as the sentence prints it, not as it dials: the row wraps
        // this exact substring in the link.
        telText: contact.phone ? contact.phone.replace(/\s+/g, ' ').trim() : null,
        at: contact.createdAt,
      });
    }
  }
  for (const doc of documents) {
    const sentence = documentSentence(doc.title);
    if (sentence) {
      items.push({ id: doc.id, kind: 'document', group: 'taught', sentence, tel: null, telText: null, at: doc.createdAt });
    }
  }
  for (const article of articles) {
    const sentence = sopSentence(article.title);
    if (sentence) {
      items.push({ id: article.id, kind: 'sop', group: 'taught', sentence, tel: null, telText: null, at: article.updatedAt });
    }
  }

  // What it worked out by itself, plus the facts somebody taught it in words.
  // Manager-only, unchanged: agent_memory has never been readable by the floor.
  if (ctx.isManager) {
    const rows = await listMemory(ctx.pid, { scope: 'property', limit: 200 });
    items.push(...memoryItems(rows));
  }

  return ok(
    {
      items: sortKnowsItems(items),
      canTeach: ctx.isManager && ctx.hotelMutationAllowed,
      canSeeNoticed: ctx.isManager,
    },
    { requestId: ctx.requestId, headers: ctx.headers },
  );
}

// ─── Write ──────────────────────────────────────────────────────────────────

interface PostBody {
  propertyId?: unknown;
  action?: unknown;
  kind?: unknown;
  id?: unknown;
  text?: unknown;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) {
    // No context yet, so no requestId from the gate. Mint one for the refusal.
    return err('Invalid JSON body', {
      requestId: getOrMintRequestId(req), status: 400, code: ApiErrorCode.InvalidBody,
    });
  }

  const ctx = await commsContext(
    req,
    typeof body.propertyId === 'string' ? body.propertyId : null,
    KNOWLEDGE_CTX,
  );
  if (!ctx.ok) return ctx.response;

  const fail = (message: string, status: number, code: string) =>
    err(message, { requestId: ctx.requestId, status, code, headers: ctx.headers });

  // Every write on this screen is a manager's. The buttons are absent for
  // everybody else, and this is the check that counts.
  if (!ctx.isManager || !ctx.hotelMutationAllowed) {
    return fail('Only a manager at this hotel can change what Staxis knows.', 403, ApiErrorCode.Forbidden);
  }

  const action = body.action;
  if (action !== 'teach' && action !== 'adjust' && action !== 'wrong' && action !== 'remove') {
    return fail('Unknown action', 400, ApiErrorCode.UnknownAction);
  }

  const rl = await checkAndIncrementRateLimit(
    action === 'teach' ? 'knows-intake' : 'knows-write',
    action === 'teach' ? ctx.pid : hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`),
  );
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const text = typeof body.text === 'string' ? body.text.slice(0, TEACH_MAX_CHARS).trim() : '';
  const actor: KnowsActor = {
    propertyId: ctx.pid,
    accountId: ctx.accountId,
    displayName: ctx.displayName,
    role: ctx.role,
  };
  const stores = knowsStores(actor);

  if (action === 'teach') {
    if (!text) return fail('Type something first.', 400, ApiErrorCode.NothingToRead);
    const res = await applyTeach(stores, actor, text, (reason) => {
      // Not an error for the person: their sentence is being saved as a fact.
      // The line exists so a drawer that has been refusing writes all week is
      // visible in the logs rather than showing up as "everything becomes a
      // fact now".
      log.warn('[memory/knows:teach] fell back to a plain fact', { pid: ctx.pid, reason });
    });
    if (!res.ok) return fail(res.message, res.reason === 'invalid' ? 400 : 500, codeFor(res.reason));
    return ok({ filedAs: res.filedAs }, { requestId: ctx.requestId, headers: ctx.headers });
  }

  // ── adjust / wrong / remove all name one existing row ─────────────────────
  if (!isItemKind(body.kind)) return fail('Unknown action', 400, ApiErrorCode.UnknownAction);
  const idV = validateUuid(body.id, 'id');
  if (idV.error) return fail(idV.error, 400, ApiErrorCode.ValidationFailed);
  const kind = body.kind;
  const id = idV.value!;

  // The knowledge hub's own routes gate their writes on this capability, which
  // a hotel can restrict from the Access tab. Rendering those rows on a new
  // screen must not hand the write back to somebody it was taken from.
  if (kind !== 'fact') {
    const decision = await capabilityDecisionForUserId(ctx.userId, 'manage_knowledge', ctx.pid);
    if (decision === 'unavailable') return capabilityUnavailableResponse(ctx.requestId);
    if (decision === 'denied') {
      return fail('Only a manager at this hotel can change this.', 403, ApiErrorCode.Forbidden);
    }
  }

  // "That's wrong" with nothing typed drops the row. With a correction it is
  // the same write as Adjust, because a correction IS the new wording: the
  // store already promotes an edited fact to human-authored (see
  // editMemoryFact), which is what makes the old guess stop being believed.
  const res = action === 'remove' || (action === 'wrong' && !text)
    ? await applyDrop(stores, actor, kind, id)
    : await applyAdjust(stores, actor, kind, id, text);
  if (!res.ok) {
    const status = res.reason === 'gone' ? 404 : res.reason === 'invalid' ? 400 : 500;
    return fail(res.message, status, codeFor(res.reason));
  }
  return ok({ kind, id }, { requestId: ctx.requestId, headers: ctx.headers });
}

function codeFor(reason: 'save_failed' | 'gone' | 'invalid'): string {
  if (reason === 'gone') return ApiErrorCode.FactGone;
  if (reason === 'invalid') return ApiErrorCode.ContentRequired;
  return ApiErrorCode.SaveFailed;
}

/**
 * The real stores, wired to the seams each one already had.
 *
 * Assembled here rather than imported by `writes.ts` so the routing logic can
 * be driven by a test with fakes: the five drawers all sit behind service-role
 * modules, and a test that needs a database to prove a sentence went into the
 * rules table is a test nobody runs.
 */
function knowsStores(actor: KnowsActor): KnowsStores {
  return {
    file: (sentence) => fileTypedSentence({
      sentence,
      propertyId: actor.propertyId,
      accountId: actor.accountId,
      displayName: actor.displayName,
      role: actor.role,
    }),
    redact: (text) => redactMemoryContent(text.slice(0, TEACH_MAX_CHARS)).content,

    storeFact: async ({ topic, content, category, actor }) => {
      const res = await storeMemory({
        propertyId: actor.propertyId,
        scope: 'property',
        subjectAccountId: null,
        topic,
        content,
        // Human-authored and high confidence, so it reaches the copilot
        // immediately. Nobody on this screen is asked to confirm a sentence
        // they just typed themselves, so nothing here may land unreviewed.
        source: 'explicit_user',
        confidence: 'high',
        category,
        createdByAccountId: actor.accountId,
        createdByName: actor.displayName,
        createdByRole: actor.role,
      });
      return { ok: res.ok };
    },
    editFact: async (id, content, actor) => {
      const res = await editMemoryFact(actor.propertyId, id, { content }, {
        accountId: actor.accountId, name: actor.displayName, role: actor.role,
      });
      return { ok: res.ok, hit: res.updated };
    },
    removeFact: async (id, actor) => {
      const res = await removeMemoryFact(actor.propertyId, id);
      return { ok: res.ok, hit: res.removed };
    },

    storeRule: async (text, actor) => {
      const res = await storeStandingRule({
        propertyId: actor.propertyId,
        ruleText: text,
        accountId: actor.accountId,
        authorName: actor.displayName,
        authorRole: actor.role,
      });
      return res.ok ? { ok: true } : { ok: false, message: res.reason };
    },
    editRule: async (id, text, actor) => {
      const res = await updateStandingRule({ propertyId: actor.propertyId, ruleId: id, ruleText: text });
      if (res.ok) return { ok: true, hit: true };
      // A length refusal is worth showing; "no such rule" is a miss, not a
      // refusal, and must read as gone rather than as an invalid sentence.
      if (res.reason === 'too_short' || res.reason === 'too_long') return { ok: false, message: res.error };
      return { ok: true, hit: false };
    },
    removeRule: async (id, actor) => {
      const res = await removeStandingRule({
        propertyId: actor.propertyId, ruleId: id, accountId: actor.accountId,
      });
      return { ok: res.ok, hit: !!res.removed };
    },

    storeContact: async (contact, actor) => {
      await createContact(
        actor.propertyId,
        {
          name: contact.name, company: contact.company, phone: contact.phone,
          email: contact.email, notes: contact.notes, category: contact.category,
          address: null, cityStateZip: null, hours: null, localCategory: null,
        },
        { accountId: actor.accountId, name: actor.displayName ?? 'Manager' },
      );
      return { ok: true };
    },
    editContact: async (id, contact, actor) => {
      const hit = await updateContact(actor.propertyId, id, {
        name: contact.name, company: contact.company, phone: contact.phone,
        email: contact.email, notes: contact.notes, category: contact.category,
        address: null, cityStateZip: null, hours: null, localCategory: null,
      });
      return { ok: true, hit };
    },
    removeContact: async (id, actor) => ({ ok: true, hit: await deleteContact(actor.propertyId, id) }),

    renameDocument: async (id, title, actor) => ({ ok: true, hit: await renameDocument(actor.propertyId, id, title) }),
    removeDocument: async (id, actor) => ({ ok: true, hit: await deleteDocument(actor.propertyId, id) }),
    renameSop: async (id, title, actor) => ({ ok: true, hit: await renameArticle(actor.propertyId, id, title) }),
    removeSop: async (id, actor) => ({ ok: true, hit: await deleteArticle(actor.propertyId, id) }),
  };
}

