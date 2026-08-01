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
import { propertyLocalToday } from '@/lib/schedule/local-date';
import { isSectionEnabled, normalizeSectionFlags } from '@/lib/sections/registry';
import { chatIsMountedForRole } from '@/lib/agent/lenses';
import { isValidRole, type AppRole } from '@/lib/roles';
import { validateString } from '@/lib/api-validate';
import { buildCompanionCandidates } from '@/lib/companion/candidates';
import { cleanName, looksSharedLogin, type SleepReason } from '@/lib/companion/copy';
import {
  EMPTY_COMPANION_MEMORY,
  parseCompanionMemory,
  rememberAccepted,
  rememberDeclined,
  rememberSpoke,
  rememberTaught,
  rememberTourDeclined,
  rememberTourTaken,
  rememberWelcomed,
  type CompanionMemory,
  type TeachFlow,
} from '@/lib/companion/manners';

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
  const today = propertyLocalToday(new Date(), facts?.timezone ?? null);

  // Candidates only when the companion could actually act on them. A hotel with
  // Staxis switched off gets no findings shipped to its browser, whatever the
  // browser then decides to do with them.
  const candidates = awake
    ? await buildCompanionCandidates({
        propertyId: ctx.pid,
        role,
        hotelMutationAllowed: ctx.hotelMutationAllowed,
      })
    : [];

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
      },
      memory,
      // The one-time setup wizard's own guard. When it has already run for this
      // hotel, the companion skips its welcome entirely rather than stacking a
      // second greeting on top of the first. See decideCompanionSpeech.
      wizardAlreadyRan: Boolean(facts?.onboarding_prompt_shown_at),
      candidates,
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
  | 'taught';

const EVENTS: readonly CompanionEvent[] = [
  'welcomed', 'tour_declined', 'tour_taken', 'spoke', 'declined', 'accepted', 'taught',
];

function isEvent(x: unknown): x is CompanionEvent {
  return typeof x === 'string' && (EVENTS as readonly string[]).includes(x);
}

const TEACH_FLOWS: readonly TeachFlow[] = ['create_task', 'log_book_entry', 'announcement'];

function isTeachFlow(x: unknown): x is TeachFlow {
  return typeof x === 'string' && (TEACH_FLOWS as readonly string[]).includes(x);
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { pid?: string; event?: unknown; topic?: unknown; flow?: unknown };
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
  if (body.event === 'spoke' || body.event === 'declined' || body.event === 'accepted') {
    const v = validateString(body.topic, { max: 200, min: 1, label: 'topic' });
    if (v.error) {
      return err(v.error, {
        requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers,
      });
    }
    topic = v.value!;
  }
  if (body.event === 'taught' && !isTeachFlow(body.flow)) {
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
      case 'taught':        next = rememberTaught(current, body.flow as TeachFlow); break;
      default:              next = current;
    }

    await writeFeedPrefs(ctx.accountId, ctx.pid, { companionMemory: next });
    return ok({ memory: next }, { requestId: ctx.requestId, headers: ctx.headers });
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
