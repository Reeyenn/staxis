// ═══════════════════════════════════════════════════════════════════════════
// /api/companion — everything the bubble needs, and the only way its memory
// moves.
//
//   GET  ?pid=…                → bootstrap: who this is, what the hotel is
//                                called, what the companion remembers, the one
//                                or two things it could say, and whether it is
//                                awake
//   POST { pid, event, … }     → apply one memory event and return the new
//                                memory
//
// TWO VERBS, ONE ROUTE, because they are one resource: the bubble's state for
// this person at this hotel. Splitting them would have meant two files reading
// the same row through the same gate.
//
// ─── WHY THE REDUCERS RUN HERE AND NOT IN THE BROWSER ──────────────────────
//
// The memory blob is what stops the companion introducing itself twice and what
// makes a No permanent. If the browser sent the whole blob, a stale tab could
// post a memory from ten minutes ago and un-say somebody's No, and a person
// could turn the greeting back on by editing a request body. So the client
// sends an EVENT ("they declined this topic") and the server reads the current
// memory, applies the pure reducer from manners.ts, and writes the result. The
// same reducers the tests exercise are the ones that run.
//
// ─── WHY THIS DOES NOT USE requireSectionEnabled ───────────────────────────
//
// That helper 403s when a hotel has Staxis switched off, and a 403 is the wrong
// answer to "should the bubble be awake". The bubble needs to know it is
// switched off so it can rest quietly and say so plainly if somebody opens it,
// which is a 200 with `awake: false`. A refusal would leave it with no way to
// tell "off" from "broken", and the honest sleep state is the whole point.
// Nothing is leaked by the distinction: with the section off, this route
// returns no candidates at all.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { readFeedPrefs, writeFeedPrefs } from '@/lib/feed/prefs';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { propertyLocalHour, propertyLocalToday } from '@/lib/schedule/local-date';
import { isSectionEnabled, normalizeSectionFlags } from '@/lib/sections/registry';
import { chatIsMountedForRole } from '@/lib/agent/lenses';
import { isValidRole, type AppRole } from '@/lib/roles';
import { validateString } from '@/lib/api-validate';
import { buildCompanionCandidates } from '@/lib/companion/candidates';
import {
  appendCompanionOffer,
  ensureCompanionConversation,
  stampCompanionOffer,
} from '@/lib/agent/memory';
import {
  COMPANION_OFFER_KINDS,
  OFFER_ACTIONS_MAX,
  OFFER_TEXT_MAX,
  type CompanionOffer,
  type CompanionOfferAction,
  type CompanionOfferAnswer,
  type CompanionOfferKind,
} from '@/lib/companion/offers';
import { cleanName, looksSharedLogin, type SleepReason } from '@/lib/companion/copy';
import { recordAgentJournalEntry, journalSaidLine } from '@/lib/agent/journal';
import { loadAssignmentNotices } from '@/lib/companion/notices-server';
import type { AssignmentNotice } from '@/lib/companion/notices';
import {
  EMPTY_COMPANION_MEMORY,
  parseCompanionMemory,
  rememberAccepted,
  rememberDeclined,
  rememberSpoke,
  rememberGreeted,
  rememberNoticesAnnounced,
  rememberNoticesSeen,
  rememberTaught,
  rememberTourDeclined,
  rememberTourTaken,
  rememberWelcomed,
  COMPOSER_TAUGHT_TODO_REPEAT,
  type CompanionMemory,
  type TaughtKey,
} from '@/lib/companion/manners';
import { rememberDroppedTopic } from '@/lib/companion/pointers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PropertyRow {
  name: string | null;
  timezone: string | null;
  enabled_sections: unknown;
  onboarding_prompt_shown_at: string | null;
}

/**
 * One read for everything about the hotel this route needs.
 *
 * Fails soft into "we know nothing about the building", which produces a
 * companion that is awake, unnamed and quiet. That is the right degradation:
 * the alternative is a bubble that disappears whenever a property read hiccups.
 */
async function loadPropertyFacts(pid: string): Promise<PropertyRow | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('properties')
      .select('name, timezone, enabled_sections, onboarding_prompt_shown_at')
      .eq('id', pid)
      .maybeSingle();
    if (error || !data) return null;
    return data as PropertyRow;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'), ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  const rl = await checkAndIncrementRateLimit(
    'companion-read',
    hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`),
  );
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const role: AppRole = isValidRole(ctx.role) ? ctx.role : 'staff';

  const [facts, prefs] = await Promise.all([
    loadPropertyFacts(ctx.pid),
    readFeedPrefs(ctx.accountId, ctx.pid),
  ]);

  const sectionOn = isSectionEnabled(normalizeSectionFlags(facts?.enabled_sections), 'staxis');
  const roleHasChat = chatIsMountedForRole(role);

  let awake = true;
  let sleepReason: SleepReason | null = null;
  if (!sectionOn || !roleHasChat) {
    awake = false;
    sleepReason = 'section_off';
  }

  const memory = parseCompanionMemory(prefs.companionMemory);
  const now = new Date();
  const today = propertyLocalToday(now, facts?.timezone ?? null);
  // The hour on the wall AT THE HOTEL, for the greeting. Null when the hotel
  // has no timezone set, in which case the greeting says "Hello" rather than
  // guessing which third of the day somebody is in.
  const hour = propertyLocalHour(now, facts?.timezone ?? null);

  // Candidates only when the companion could actually act on them. A hotel with
  // Staxis switched off gets no findings shipped to its browser, whatever the
  // browser then decides to do with them.
  const candidates = awake
    ? await buildCompanionCandidates({
        propertyId: ctx.pid,
        role,
        hotelMutationAllowed: ctx.hotelMutationAllowed,
        // The HOTEL's day and clock, resolved above from properties.timezone.
        // The unfinished-business recall reads "before today" off it, and the
        // browser's idea of today is the one thing that must never decide that.
        today,
        timezone: facts?.timezone ?? null,
      })
    : [];

  // ── Notices ────────────────────────────────────────────────────────────
  //
  // The same `awake` gate, which is also the HOUSEKEEPER GATE: `roleHasChat`
  // is false for the housekeeping hat, so this route ships that hat no notices
  // at all rather than relying on the browser to decline to render them. The
  // mount gate in the browser is the second, independent refusal.
  //
  // Fails soft to an empty list for the same reason the candidates do: the
  // companion is a greeter, not a dependency.
  let notices: AssignmentNotice[] = [];
  if (awake && ctx.staffId) {
    try {
      notices = await loadAssignmentNotices({ propertyId: ctx.pid, staffId: ctx.staffId, now });
    } catch (e) {
      log.warn('[companion] notices read failed; the panel opens without them', {
        requestId: ctx.requestId, pid: ctx.pid, err: errToString(e),
      });
    }
  }

  return ok(
    {
      person: {
        firstName: cleanName(ctx.displayName),
        role,
        sharedLogin: looksSharedLogin(ctx.displayName),
        isManager: ctx.isManager,
      },
      hotel: {
        id: ctx.pid,
        name: facts?.name ?? null,
        today,
        hour,
      },
      memory,
      // The one-time setup wizard's own guard. When it has already run for this
      // hotel, the companion skips its welcome entirely rather than stacking a
      // second greeting on top of the first. See decideCompanionSpeech.
      wizardAlreadyRan: Boolean(facts?.onboarding_prompt_shown_at),
      candidates,
      notices,
      availability: { awake, reason: sleepReason },
    },
    { requestId: ctx.requestId, headers: ctx.headers },
  );
}

// ─── Memory events ──────────────────────────────────────────────────────────

type CompanionEvent =
  | 'welcomed'
  | 'tour_declined'
  | 'tour_taken'
  | 'spoke'
  | 'declined'
  | 'accepted'
  | 'taught'
  | 'greeted'
  // "Do not show this again", said once and meant. The ordinary `declined`
  // event needs two Nos before a topic drops, which is right for something the
  // companion noticed and wrong for a button somebody has read about and
  // decided against. See src/lib/companion/pointers.ts.
  | 'dropped'
  // The fourth mouth. `notices_announced` stamps the batch that was just said
  // out loud (and writes the sentence into the thread like every other thing
  // the companion says first); `notices_seen` moves the read cursor when the
  // list is opened. Two events because being told and having looked are two
  // acts — see notices.ts.
  | 'notices_announced'
  | 'notices_seen';

const EVENTS: readonly CompanionEvent[] = [
  'welcomed', 'tour_declined', 'tour_taken', 'spoke', 'declined', 'accepted', 'taught', 'greeted', 'dropped',
  'notices_announced', 'notices_seen',
];

/** An ISO instant off a request body, or null. Never trusted as a Date. */
function readInstant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10 || value.length > 40) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

// ─── The offer half ─────────────────────────────────────────────────────────
//
// EVERY SENTENCE THE COMPANION SAYS FIRST BECOMES A MESSAGE IN THE THREAD, and
// it is written by THIS handler, on the same event that moves the manners
// ledger. That is the whole design of it: `declined` still counts a decline in
// `companion_memory.topics` through `rememberDeclined` and nowhere else, and
// the message's `state` is a rendering of the same event in the same request.
// There is no second ledger to drift, and no way to stamp a message state
// without the manners engine hearing about it — because the message state is
// not an event, it is a side effect of one.
//
// The reverse also holds and matters: `offerCountsAsDecline` is the only thing
// that decides which answers reach the ledger, so a dismissal counts once, a
// yes forgives, and an expiry counts for nothing.

/** `spoke` may carry a sentence to write down. Everything here is optional. */
interface OfferSpeech {
  kind: CompanionOfferKind;
  text: string;
  page: string | null;
  actions: CompanionOfferAction[];
  conversationId: string | null;
}

const OFFER_ACTION_KINDS: readonly CompanionOfferAction['kind'][] = ['show', 'walk', 'seed', 'no'];

/**
 * Read the offer half of a POST body, or null when there is none.
 *
 * Returns null rather than erroring on a malformed shape: the memory event is
 * the load-bearing half of this request and must not fail because a browser
 * sent a button label that was too long. A sentence we cannot store is a
 * sentence that stays ephemeral, which is exactly what it was before.
 */
function readOfferSpeech(body: Record<string, unknown>): OfferSpeech | null {
  const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > OFFER_TEXT_MAX) return null;
  const kind = COMPANION_OFFER_KINDS.includes(body.kind as CompanionOfferKind)
    ? (body.kind as CompanionOfferKind)
    : null;
  if (!kind) return null;
  const actions: CompanionOfferAction[] = [];
  if (Array.isArray(body.actions)) {
    for (const raw of body.actions.slice(0, OFFER_ACTIONS_MAX)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 40) : '';
      const actionKind = OFFER_ACTION_KINDS.includes(entry.kind as CompanionOfferAction['kind'])
        ? (entry.kind as CompanionOfferAction['kind'])
        : null;
      if (!label || !actionKind) continue;
      actions.push({ label, kind: actionKind });
    }
  }
  const page = typeof body.page === 'string' && body.page.length > 0 && body.page.length <= 40
    ? body.page
    : null;
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null;
  return { kind, text, page, actions, conversationId };
}

function readAnswer(value: unknown): CompanionOfferAnswer | null {
  return value === 'accepted' || value === 'declined' || value === 'dismissed' || value === 'expired'
    ? value
    : null;
}

function isEvent(x: unknown): x is CompanionEvent {
  return typeof x === 'string' && (EVENTS as readonly string[]).includes(x);
}

/**
 * Everything the `taught` ledger may be keyed by, in one closed list.
 *
 * The three companion flows, plus the Staxis list's own once-ever line. The
 * list is closed on purpose: `taught` keys are stored in a jsonb blob a request
 * body can reach, and an open key space would let a caller write junk into
 * somebody's permanent memory. See COMPOSER_TAUGHT_TODO_REPEAT.
 */
const TAUGHT_KEYS: readonly TaughtKey[] = [
  'create_task', 'log_book_entry', 'announcement', COMPOSER_TAUGHT_TODO_REPEAT,
];

function isTaughtKey(x: unknown): x is TaughtKey {
  return typeof x === 'string' && (TAUGHT_KEYS as readonly string[]).includes(x);
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: {
    pid?: string; event?: unknown; topic?: unknown; flow?: unknown;
    // The offer half. See the OfferSpeech block above.
    text?: unknown; kind?: unknown; page?: unknown; actions?: unknown;
    conversationId?: unknown; offerId?: unknown; offerState?: unknown;
    // The notices half. `through` is the newest notice in the batch that was
    // announced. There is deliberately no "when did I open the list" field:
    // that instant is the server's own clock.
    through?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const ctx = await commsContext(req, typeof body.pid === 'string' ? body.pid : null, ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  if (!isEvent(body.event)) {
    return err('unknown event', {
      requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers,
    });
  }

  const rl = await checkAndIncrementRateLimit(
    'companion-write',
    hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`),
  );
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Topic-bearing events need a topic, and it is bounded here because it becomes
  // a key in a stored blob. `parseCompanionMemory` would drop an over-long key
  // on the way back out, which is a silent way for a No to stop working.
  let topic = '';
  if (body.event === 'spoke' || body.event === 'declined' || body.event === 'accepted' || body.event === 'dropped') {
    const v = validateString(body.topic, { max: 200, min: 1, label: 'topic' });
    if (v.error) {
      return err(v.error, {
        requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers,
      });
    }
    topic = v.value!;
  }
  if (body.event === 'taught' && !isTaughtKey(body.flow)) {
    return err('unknown flow', {
      requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers,
    });
  }

  try {
    const [facts, prefs] = await Promise.all([
      loadPropertyFacts(ctx.pid),
      readFeedPrefs(ctx.accountId, ctx.pid),
    ]);
    const today = propertyLocalToday(new Date(), facts?.timezone ?? null);
    const now = new Date();
    const current = parseCompanionMemory(prefs.companionMemory);

    let next: CompanionMemory;
    switch (body.event) {
      case 'welcomed':      next = rememberWelcomed(current, now); break;
      case 'tour_declined': next = rememberTourDeclined(rememberWelcomed(current, now)); break;
      case 'tour_taken':    next = rememberTourTaken(rememberWelcomed(current, now), now); break;
      case 'spoke':         next = rememberSpoke(current, topic, now, today); break;
      case 'declined':      next = rememberDeclined(current, topic, today); break;
      case 'accepted':      next = rememberAccepted(current, topic, today); break;
      case 'dropped':       next = rememberDroppedTopic(current, topic, today); break;
      case 'taught':        next = rememberTaught(current, body.flow as TaughtKey); break;
      // Stamped with the HOTEL's day, so a person working past midnight is
      // greeted when the hotel's morning starts and not when UTC's does.
      case 'greeted':       next = rememberGreeted(current, today); break;
      // Both stamps are MONOTONIC inside their reducers, so a stale tab
      // replaying an older batch cannot drag either cursor backwards and make
      // the companion repeat itself or mark read work unread. A missing or
      // unparseable instant leaves the memory exactly as it was: the safe
      // direction here is "not stamped", which costs at most one repeat.
      case 'notices_announced': {
        const through = readInstant(body.through);
        next = through ? rememberNoticesAnnounced(current, through) : current;
        break;
      }
      case 'notices_seen': {
        // The server's own clock, not the browser's. "When did you last look"
        // is a fact about this request, and a tab with a skewed clock could
        // otherwise mark tomorrow's notices read today.
        next = rememberNoticesSeen(current, now.toISOString());
        break;
      }
      default:              next = current;
    }

    await writeFeedPrefs(ctx.accountId, ctx.pid, { companionMemory: next });

    // ── The same event, written down ──────────────────────────────────────
    //
    // Runs AFTER the memory write and never blocks it. The ledger is what makes
    // a No permanent; the message is what makes it visible. If the thread write
    // fails, the person has still been heard — they just do not get to re-read
    // the sentence, which is the behaviour this whole feature replaced and is a
    // safe place to land.
    let offer: CompanionOffer | null = null;
    let spokenInto: string | null = null;
    try {
      // Every event on which the companion actually SAYS something. `spoke` is
      // an offer, `greeted` is the once-a-day hello, `welcomed` is day one, and
      // `notices_announced` is the batched line about work. Anything else (a
      // tour taken, a tip shown, a list opened) moves the ledger without
      // putting a sentence in front of anybody, so there is nothing to write.
      if (
        body.event === 'spoke' || body.event === 'greeted' || body.event === 'welcomed'
        || body.event === 'notices_announced'
      ) {
        const speech = readOfferSpeech(body as Record<string, unknown>);
        if (speech) {
          const conversationId = await ensureCompanionConversation({
            userAccountId: ctx.accountId,
            propertyId: ctx.pid,
            role: isValidRole(ctx.role) ? ctx.role : 'staff',
            preferredId: speech.conversationId,
            title: speech.text.slice(0, 80),
          });
          if (conversationId) {
            spokenInto = conversationId;
            offer = await appendCompanionOffer({
              conversationId,
              text: speech.text,
              kind: speech.kind,
              topic: topic || null,
              page: speech.page,
              actions: speech.actions,
              now,
            });
            // ── The third family of journal entry: a thing said to a person ──
            //
            // The thread already holds the sentence, and that is the right home
            // for reading it back. What the thread cannot answer is "what have
            // you been doing today", which is asked of the hotel and not of one
            // conversation. So the same act lands once in each: the words in the
            // thread, the fact in the timeline.
            //
            // Only when a row was actually written. An offer the thread refused
            // is an offer nobody was shown, and journaling it would be the
            // companion claiming to have spoken into a void.
            if (offer) {
              await recordAgentJournalEntry({
                propertyId: ctx.pid,
                eventType: 'agent_said',
                description: journalSaidLine({
                  text: speech.text,
                  personName: cleanName(ctx.displayName),
                }),
                // The person SPOKEN TO, as the target. The actor is the
                // companion, which is what the null account id on this table
                // has meant since 0228.
                targetType: 'person',
                targetId: ctx.accountId,
                targetLabel: cleanName(ctx.displayName),
                metadata: {
                  kind: speech.kind,
                  topic: topic || null,
                  offerId: offer.id,
                  event: body.event,
                },
                occurredAt: now,
              });
            }
          }
        }
      } else if (body.event === 'declined' || body.event === 'accepted') {
        // The answer the ledger just recorded, stamped onto the sentence it was
        // about. `offerState` only chooses BETWEEN declined and dismissed —
        // both of which the ledger already counted identically — so it can
        // never disagree with the count.
        const requested = readAnswer(body.offerState);
        const answer: CompanionOfferAnswer = body.event === 'accepted'
          ? 'accepted'
          : requested === 'dismissed' || requested === 'expired' ? requested : 'declined';
        if (typeof body.offerId === 'string') {
          offer = await stampCompanionOffer({
            offerId: body.offerId,
            userAccountId: ctx.accountId,
            propertyId: ctx.pid,
            answer,
            now,
          });
        }
      }
    } catch (e) {
      log.error('[companion] offer write failed', {
        requestId: ctx.requestId, pid: ctx.pid, err: errToString(e),
      });
    }

    return ok(
      { memory: next, offer, conversationId: spokenInto },
      { requestId: ctx.requestId, headers: ctx.headers },
    );
  } catch (e) {
    log.error('[companion] POST failed', {
      requestId: ctx.requestId, pid: ctx.pid, err: errToString(e),
    });
    // The bubble treats a failed write as "assume it stuck" for this session, so
    // a person is never greeted twice inside one page load. The next page load
    // reads the truth again.
    return err('Internal server error', {
      requestId: ctx.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: ctx.headers,
      details: { memory: EMPTY_COMPANION_MEMORY },
    });
  }
}
