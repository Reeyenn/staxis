// ─── "Right now": the situational-awareness block ────────────────────────────
//
// The copilot already knew WHAT the hotel is (the snapshot), WHAT it has been
// told (memory, knowledge) and WHO it is talking to (the lens). It did not know
// anything about the MOMENT: what screen the person is looking at, what they
// have already done today, what landed since the last report, what is waiting on
// them, what time it is where the hotel is, what Staxis itself did overnight, or
// what tonight looks like.
//
// That absence produced a specific, recurring kind of bad answer: a manager who
// had just marked eight rooms clean asking "what's left" and being told to go do
// the thing they had spent the morning doing; a 6am question answered as though
// it were mid-turnover; "what should I look at" answered without reference to
// the three offers sitting in their own queue.
//
// ═══ THE RULE THAT SHAPES EVERY LINE BELOW ═══════════════════════════════════
//
// CODE ASSEMBLES THIS. There is no model call in this file and there must never
// be one. Every feed is SQL plus a format string. The block is built on every
// turn, so a model call here would put a second round-trip (and a second bill)
// in front of every message anyone sends.
//
// ═══ WHERE IT GOES, AND WHY THAT IS THE WHOLE DESIGN PROBLEM ═════════════════
//
// This block is the most per-turn thing in the entire prompt — the clock alone
// changes every minute. It therefore belongs in the DYNAMIC half, appended by
// llm.ts WITHOUT `cache_control`, exactly where the hotel snapshot and the
// memory block already live.
//
// Putting it in the stable block would not break a single test of behaviour: the
// copilot would keep answering correctly, and every turn of every conversation
// would miss the Anthropic prompt cache forever. That is INV-TIER-5's named
// hazard and it is why `'right_now'` is a member of `DynamicTier` (a compile
// error if moved), why the section header is registered in llm.ts's
// `DYNAMIC_ONLY_MARKERS` (a runtime throw outside production), and why
// agent-awareness.test.ts re-runs the cache-purity assertions with the block
// present.
//
// ═══ NUMBERS IN HERE ARE RECEIPTS ═══════════════════════════════════════════
//
// `buildAnswerReceipt` (number-guard.ts) harvests `systemPrompt.dynamic` whole,
// so every count printed below automatically becomes evidence the model is
// allowed to quote — the same way the snapshot's counts already are. That is the
// correct wiring and it needs no new plumbing, but it does mean a WRONG number
// here launders into a citable one. Hence: every figure is a `count(*)` over a
// property-scoped query, never a derivation, never an estimate.
//
// ═══ SILENCE IS A FEATURE ═══════════════════════════════════════════════════
//
// An empty feed renders NOTHING. Not "No activity today", not "0 items waiting"
// — nothing. Two reasons, and the second is the real one:
//
//   1. Tokens. This is on every turn.
//   2. "No activity today" is a CLAIM, and for most of these feeds it is a claim
//      we cannot support. Data intake is off for nearly every hotel right now,
//      so "0 rooms changed" means "we are not receiving room data", not "no room
//      changed". A blank line asserts nothing; a zero asserts something false.
//      This is the same rule the data-age honesty work (A2) settled on.
//
// ═══ DEGRADE TO SILENCE, NEVER TO ERROR ═════════════════════════════════════
//
// Every feed runs inside its own `Promise.allSettled` slot. A feed whose query
// throws is dropped and reported; the block renders without it and the chat turn
// proceeds. Nothing in this file may ever be the reason a manager's message
// fails to send.

import 'server-only';

import { scopedDb, unscopedBecause } from '@/lib/agent/scoped-db';
import { captureException } from '@/lib/sentry';
import { canManageTeam, type AppRole } from '@/lib/roles';
import { addDaysInTz, propertyLocalToday, startOfLocalDay } from '@/lib/schedule/local-date';
import { countProposeFindings, latestRunFacts } from '@/lib/findings/store';
import { scheduleState } from '@/lib/findings/detectors/preventive-due';
import { lensAllowsTool, moneyVisibleToRole } from './lenses';
import { readAgentJournal } from './journal';
import { anchorsOnPage } from '@/lib/companion/anchors';
import { pageForPath } from '@/lib/companion/pages';
import type { HotelSnapshot } from './context';

// ═══════════════════════════════════════════════════════════════════════════
// WHICH FEEDS A HAT GETS — derived, never declared
// ═══════════════════════════════════════════════════════════════════════════
//
// There is no role table in this file, on purpose. A second role map is a second
// thing to keep in sync with `lenses.ts`, and the failure mode when it drifts is
// silent and bad in the wrong direction: the front desk gets told what is
// waiting on a manager's approval because someone edited one table and not the
// other.
//
// So each feed asks the SAME question the tool catalog asks — "does this hat
// mount the tool that answers this?" — and mounts the feed only if so. The lens
// keyhole is the single definition, and a lens edit propagates here for free.
//
//   findings        ⇢ staxis_findings           (GM/owner/admin + maintenance;
//                                                NOT front desk — "what Staxis
//                                                found" is named in their prompt
//                                                as a manager question)
//   approvals       ⇢ staxis_pending_decisions  (manager tier only; the
//                                                maintenance lens names
//                                                sign-offs as the manager's)
//   preventive due  ⇢ staxis_preventive         (manager tier + maintenance —
//                                                the wrench's own "what's due")
//   tonight         ⇢ get_future_bookings       (manager tier + front desk, who
//                                                answer arriving guests; not
//                                                maintenance's business)
//
// A role absent from CHAT_LENSES (admin, owner, general_manager, legacy 'staff')
// gets `true` from every one of these, which is exactly today's behaviour for
// them — this can only ever have narrowed the two floor hats.

function canSee(role: AppRole, toolName: string): boolean {
  return lensAllowsTool(role, 'chat', toolName);
}
// ═══════════════════════════════════════════════════════════════════════════
// 1. WHERE YOU ARE — the screen, resolved through an allowlist
// ═══════════════════════════════════════════════════════════════════════════
//
// The pathname arrives from the BROWSER, which makes it the only attacker-
// controlled input in this entire file. It is never interpolated into the
// prompt. It is matched against the table below and what gets printed is the
// table's own `surface` string — a constant from this file, not a byte of what
// the client sent.
//
// That is the difference between "escape the input" and "do not use the input".
// Escaping is what the snapshot does for a hotel name it must actually display.
// Here there is nothing to display: a path either IS one of these screens or it
// is not interesting, so the client string only ever selects a row. A path with
// `</staxis-awareness>` in it matches nothing and renders nothing.
//
// UNKNOWN PATHS RENDER NOTHING, deliberately. A new page added next month is
// invisible to the copilot until someone adds it here — a small, visible,
// self-correcting gap. The alternative (print whatever came in) is an open
// prompt-injection channel through a query string.

interface SurfaceRoute {
  /** Anchored, no user input interpolated. Matched against the CLEAN path. */
  readonly test: RegExp;
  /** What the model is told. A constant from this file — never client bytes. */
  readonly surface: string;
}

/**
 * The screens the copilot knows the names of.
 *
 * Ordered: the first match wins, so specific routes precede their parents.
 * Dynamic segments are matched STRUCTURALLY (`[^/]+`) and their value is
 * discarded — "the Room detail screen" is the useful fact, and the room number
 * is already in the conversation if it matters.
 */
const SURFACE_ROUTES: readonly SurfaceRoute[] = [
  // ── Settings sub-pages, before the parent ──
  // Named individually because "they are on the Wages screen" is a materially
  // different situation from "they are in Settings", and these are exactly the
  // screens where someone asks a question about what is in front of them.
  { test: /^\/settings\/accounts$/, surface: 'Settings → Accounts' },
  { test: /^\/settings\/activity-log$/, surface: 'Settings → Activity log' },
  { test: /^\/settings\/checklists$/, surface: 'Settings → Checklists' },
  { test: /^\/settings\/clean-times$/, surface: 'Settings → Clean times' },
  { test: /^\/settings\/notifications$/, surface: 'Settings → Notifications' },
  { test: /^\/settings\/reports$/, surface: 'Settings → Reports' },
  { test: /^\/settings\/shifts$/, surface: 'Settings → Shifts' },
  { test: /^\/settings\/users$/, surface: 'Settings → Users' },
  { test: /^\/settings\/wages$/, surface: 'Settings → Wages' },
  { test: /^\/settings$/, surface: 'Settings' },

  // ── The operating screens ──
  { test: /^\/inventory$/, surface: 'Inventory' },
  { test: /^\/maintenance$/, surface: 'Maintenance' },
  { test: /^\/housekeeping$/, surface: 'Housekeeping' },
  { test: /^\/staff$/, surface: 'Staff' },
  { test: /^\/financials$/, surface: 'Financials' },
  { test: /^\/communications$/, surface: 'Messages' },
  { test: /^\/company$/, surface: 'the company (multi-hotel) screen' },
  { test: /^\/feed$/, surface: 'the activity feed' },
  { test: /^\/dashboard$/, surface: 'the dashboard' },
  { test: /^\/home$/, surface: 'the home screen' },

  // ── Admin (Staxis staff only). Dynamic segments matched structurally; the
  //    id itself is discarded — "an admin hotel page" is the useful fact. ──
  { test: /^\/admin\/ai-staff$/, surface: 'the admin AI-staff screen' },
  { test: /^\/admin\/properties\/[^/]+$/, surface: 'an admin hotel page' },
  { test: /^\/admin\/properties$/, surface: 'the admin hotels list' },
];

/** Longest client path we will even look at. A path longer than this is not a
 *  route, it is someone probing. Bounded before any regex runs. */
const MAX_PATHNAME_CHARS = 512;

/**
 * Resolve a client-supplied pathname to a surface NAME, or null.
 *
 * Null on: absent, non-string, over-length, not starting with `/`, containing a
 * character no real route contains, or simply unlisted. Every one of those is
 * silent — an unknown screen is not an error, it is just not worth a line.
 */
export function resolveSurface(pathname: unknown): string | null {
  if (typeof pathname !== 'string') return null;
  if (pathname.length === 0 || pathname.length > MAX_PATHNAME_CHARS) return null;
  if (!pathname.startsWith('/')) return null;

  // Strip query + hash, then require the remainder to look like a path. The
  // character class is the real guard: no '<', no whitespace, no quotes, so
  // nothing that could open a tag survives to the matcher below.
  const clean = pathname.split('?')[0].split('#')[0];
  if (!/^\/[A-Za-z0-9\-._~/%]*$/.test(clean)) return null;

  // Normalize a trailing slash so '/inventory/' and '/inventory' are one screen.
  const normalized = clean.length > 1 && clean.endsWith('/') ? clean.slice(0, -1) : clean;

  for (const route of SURFACE_ROUTES) {
    if (route.test.test(normalized)) return route.surface;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. WHAT TIME IT MEANS — pure code, no query
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The operating phase of a hotel day.
 *
 * Not clock decoration — these are the four genuinely different situations a
 * limited-service hotel is in, and the right answer to "what should I be doing"
 * differs across them. The boundaries are the standard shape of the day
 * (checkout ~11, check-in ~16, audit after 23) rather than anything per-hotel;
 * a hotel with unusual hours gets a phase that is slightly early or late, which
 * is a far smaller error than having no idea what time it is.
 */
export type DayPhase = 'early_morning' | 'morning' | 'turnover' | 'evening' | 'night';

export interface HotelClock {
  /** e.g. "2:47 PM". Rendered in the hotel's own zone. */
  time: string;
  /** e.g. "Thu". */
  weekday: string;
  phase: DayPhase;
}

const PHASE_WORDS: Readonly<Record<DayPhase, string>> = {
  early_morning: 'early morning, before the first checkouts',
  morning: 'morning — checkouts and the main clean',
  turnover: 'afternoon turnover — rooms being readied for tonight',
  evening: 'evening — arrivals checking in',
  night: 'overnight — night audit',
};

function phaseForHour(hour: number): DayPhase {
  if (hour < 5) return 'night';
  if (hour < 8) return 'early_morning';
  if (hour < 12) return 'morning';
  if (hour < 16) return 'turnover';
  if (hour < 23) return 'evening';
  return 'night';
}

/**
 * The hotel's own wall clock. Pure — `now` and `timezone` in, strings out.
 *
 * Falls back to UTC on a null or junk timezone (same posture as
 * `propertyLocalToday`): a slightly wrong phase beats no time at all, and the
 * zone is printed alongside so the model can see what it was told.
 */
export function hotelClock(now: Date, timezone: string | null): HotelClock {
  const tz = timezone || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      weekday: 'short',
    }).formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    const hour12 = get('hour');
    const minute = get('minute');
    const dayPeriod = get('dayPeriod');
    const weekday = get('weekday');

    // A second pass for the 24-hour value — phase boundaries are defined on it,
    // and deriving it from the 12-hour string plus AM/PM is the kind of arithmetic
    // that is wrong exactly at noon and midnight.
    // `% 24` is not paranoia: ICU's h23/h24 handling differs across builds and
    // some render local midnight as "24" rather than "00". Unguarded, that puts
    // midnight past every phase boundary and the night audit reports as evening
    // — on one hotel, on one Node build, which is the worst way to find a bug.
    const hour24 = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false })
        .format(now)
        .slice(0, 2),
    ) % 24;

    return {
      time: `${hour12}:${minute} ${dayPeriod}`,
      weekday,
      phase: phaseForHour(Number.isFinite(hour24) ? hour24 : 12),
    };
  } catch {
    const hour = now.getUTCHours();
    return {
      time: `${now.toISOString().slice(11, 16)} UTC`,
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getUTCDay()],
      phase: phaseForHour(hour),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The assembled shape
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One rendered line, or absent.
 *
 * Every field is a finished STRING rather than structured data, because the
 * only consumer is the formatter and keeping the numbers next to the words that
 * qualify them is what stops "3" from being printed without "of them overdue".
 */
export interface Awareness {
  /** 5 — always present; the clock never fails. */
  clock: string;
  /** 1 — the screen they are on, when it is a screen we know. */
  screen?: string;
  /**
   * 1b — the controls on that screen the companion may draw an arrow at.
   *
   * The ONLY way `staxis_point_at` learns which keys exist, and it is scoped
   * to this screen on purpose: a model that was handed the whole registry
   * could name a stockroom button to somebody standing on the one-list, and
   * the refusal would happen a round trip later. Absent when the screen has
   * nothing pointable, or when this hat has no such tool.
   */
  pointables?: string;
  /** 2 — what THIS person did today, in this hotel. */
  didToday?: string;
  /** 3 — what landed since the last report. */
  justChanged?: string;
  /** 4 — what is waiting on them. */
  onYourPlate?: string;
  /** 6 — what Staxis itself did today. */
  staxisToday?: string;
  /** 7 — tonight, when there is fresh enough data to say. */
  tonight?: string;
}

export interface AwarenessInput {
  propertyId: string;
  /** The hat at THIS hotel (the spine's effectiveRole), not the legacy role. */
  role: AppRole;
  accountId: string;
  /**
   * The Supabase AUTH uid, which is a different id from `accountId`.
   *
   * Both are needed and they are not interchangeable: `activity_log` and
   * `agent_decisions` key the actor by account id, while `inventory_audit_events`
   * keys it by the auth uid. Passing one where the other belongs returns zero
   * rows and no error — a silently empty feed, which is this codebase's most
   * frequently repeated bug shape.
   */
  authUserId?: string | null;
  // NOTE — there is deliberately NO staffId here, and the absence is a known
  // gap rather than an oversight. All three "what you did today" sources key
  // the actor by an ACCOUNT (activity_log.actor_account_id,
  // agent_decisions.actor_account_id) or by an AUTH UID
  // (inventory_audit_events.actor_user_id). Actions recorded only against a
  // `staff.id` — the staff-keyed paths behind the public housekeeper link —
  // are therefore not attributed to the person asking. That costs nothing
  // today, because housekeepers have no chat at all; it would start to matter
  // if a staff-keyed write path ever appeared for a hat that does. Carrying an
  // unused field in the meantime would just be surface nobody maintains.
  /**
   * The company this person holds a COMPANY-scope hat in, when they hold one.
   *
   * Null for a hotel-only person and for a property-scope hat covering several
   * hotels — the company queue belongs to a company job, not to breadth of
   * coverage. Resolved by the caller off the spine's `effectiveRole`, so this
   * file never widens anyone's reach on its own.
   */
  organizationId?: string | null;
  /** Raw pathname from the browser. Validated here; never trusted. */
  pathname?: string | null;
  /** The snapshot already built for this turn — reused for timezone + freshness
   *  rather than re-querying what the caller is holding. */
  snapshot: HotelSnapshot;
  now?: Date;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared query plumbing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rows read per feed. Small on purpose: every feed below reduces its rows to a
 * COUNT or a top-N, so a bigger cap would buy a more precise number for a line
 * that says "…and N more" anyway.
 */
const FEED_ROW_CAP = 200;

/**
 * Escape the trust-marker metacharacters in anything that reaches the prompt.
 *
 * Almost everything printed by this file is a number or a constant from this
 * file, and those need nothing. The exceptions are the few places a DB TEXT
 * column is rendered (an event type, an AI employee's name), and those columns
 * are free text with no CHECK behind them — so a future writer, or a hotel that
 * names something creatively, could otherwise close the block's tag. Applied at
 * every interpolation site rather than at the boundary, so a new one has to opt
 * OUT of escaping rather than remember to opt in.
 */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Turn a snake_case event type into something readable. Bounded, and escaped. */
function humanize(token: string): string {
  return esc(token.replace(/_/g, ' ').trim().slice(0, 40));
}

/** "3 rooms" / "1 room" — the only pluralisation this file needs. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Join a list of phrases, truncating to `max` with an honest tail.
 *
 * The tail is "…and N more", never a silent cut: a truncated list that does not
 * say it was truncated tells the model it has seen everything, and the model
 * will then answer "that's all of it" on a list that was three items longer.
 */
function joinCapped(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  const shown = items.slice(0, max);
  return `${shown.join(', ')}, and ${items.length - max} more`;
}

/** Start-of-day in the property's own calendar, as an ISO instant for `gte`. */
function startOfLocalDayIso(now: Date, timezone: string | null): string {
  // Was: resolve the offset AT `now` and apply it to today's local midnight.
  // Those are two different instants, and on the two DST days a year they carry
  // two different offsets — so "since midnight" started an hour early or late
  // and quietly counted an hour of yesterday's work as today's. It also leaned
  // on Date(toLocaleString(...)), which no spec requires an engine to parse.
  // startOfLocalDay evaluates the offset at the answer instead of at the guess.
  return startOfLocalDay(propertyLocalToday(now, timezone), timezone).toISOString();
}

/** The count off a `head: true` read, or null when the query failed. */
function countOf(result: { count: number | null; error: unknown }): number | null {
  if (result.error) return null;
  return result.count ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. WHAT YOU DID TODAY
// ═══════════════════════════════════════════════════════════════════════════
//
// Assembled from records that ALREADY EXIST. No new tracking table, no new
// write path, nothing added to any hot path — if a domain does not already
// record who did a thing, this feed is silent about that domain rather than
// growing a way to find out.
//
// Three sources, because no single table sees everything and each of the three
// keys the actor differently — which is itself the reason a naive "just query
// the audit table" would have quietly reported half a day's work:
//
//   activity_log          — actor_account_id. The broadest: eleven source
//                           tables mirror into it by trigger (cleaning,
//                           inspections, assignments, callouts, work orders,
//                           room status, role changes, breaks).
//   inventory_audit_events — actor_user_id, which is the AUTH uid, NOT the
//                           account id. Inventory does not mirror into
//                           activity_log despite 'inventory' being a valid
//                           category there, so without this source a manager
//                           who spent the morning counting linen did "nothing".
//   agent_decisions       — actor_account_id. What they asked Staxis itself to
//                           do and approved. Their own actions, through us.
//
// KNOWN GAPS, stated rather than papered over. These domains have no per-user
// action record to read, so this feed cannot mention them and does not pretend
// to: complaints and lost-and-found (actor columns exist but nothing mirrors
// them anywhere queryable by actor + day), non-PMS `work_orders` (its
// `submitted_by` is TEXT, not an id, so it cannot be joined to a person), and
// the knowledge hub (created_by exists but has no FK and no index by actor).
// Building tracking for any of them is a separate decision, deliberately not
// smuggled in here.

interface DidTodayRow {
  label: string;
  count: number;
}

async function feedDidToday(
  propertyId: string,
  accountId: string,
  authUserId: string | null,
  sinceIso: string,
): Promise<string | null> {
  const db = scopedDb(propertyId);
  const tally = new Map<string, number>();
  const bump = (label: string, by = 1) => tally.set(label, (tally.get(label) ?? 0) + by);

  const [activity, inventory, decisions] = await Promise.allSettled([
    db
      .from('activity_log')
      .select('event_type')
      .eq('actor_account_id', accountId)
      .gte('occurred_at', sinceIso)
      .limit(FEED_ROW_CAP),
    authUserId
      ? db
        .from('inventory_audit_events')
        .select('action')
        .eq('actor_user_id', authUserId)
        .gte('occurred_at', sinceIso)
        .limit(FEED_ROW_CAP)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('agent_decisions')
      .select('tool_name')
      .eq('actor_account_id', accountId)
      .gte('occurred_at', sinceIso)
      .limit(FEED_ROW_CAP),
  ]);

  if (activity.status === 'fulfilled' && !activity.value.error) {
    for (const row of activity.value.data ?? []) {
      bump(humanize(String((row as { event_type?: unknown }).event_type ?? 'action')));
    }
  }
  if (inventory.status === 'fulfilled' && !inventory.value.error) {
    for (const row of inventory.value.data ?? []) {
      // 'count.saved' / 'delivery.received' — dotted, not snake_cased.
      bump(humanize(String((row as { action?: unknown }).action ?? 'inventory').replace(/\./g, ' ')));
    }
  }
  if (decisions.status === 'fulfilled' && !decisions.value.error) {
    for (const row of decisions.value.data ?? []) {
      bump(`asked Staxis to ${humanize(String((row as { tool_name?: unknown }).tool_name ?? 'act'))}`);
    }
  }

  if (tally.size === 0) return null;

  const rows: DidTodayRow[] = [...tally.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return joinCapped(rows.map(r => (r.count > 1 ? `${r.label} ×${r.count}` : r.label)), 5);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. WHAT JUST CHANGED
// ═══════════════════════════════════════════════════════════════════════════
//
// NOT the as-of time. The snapshot block two lines above this one already
// prints "PMS data as of 2:40 PM, 12 min ago" and the model has a whole cached
// rule about how to use it; reprinting it here would cost tokens on every turn
// to say a thing already said, and would create a second stamp to disagree with
// the first.
//
// What this adds is the DELTA the snapshot cannot express: how much moved. A
// count of room-status events today tells the model whether the hotel is mid-
// flip or quiet, which is the actual question behind "what's the situation".
//
// HONEST DEGRADATION. `pmsDataSource` on the snapshot is set if and only if
// this is a live-PMS hotel. For a manual hotel, or one whose intake is off —
// which is nearly all of them right now — this feed renders NOTHING. It must
// never render "0 changes", because zero here means "no feed", not "nothing
// happened", and that is the exact lie the data-age honesty work exists to
// prevent.

async function feedJustChanged(
  snapshot: HotelSnapshot,
  propertyId: string,
  sinceIso: string,
): Promise<string | null> {
  // The gate: no live feed ⇒ no claim, in either direction.
  if (!snapshot.pmsDataSource) return null;
  if (snapshot.pmsConnectionPending) return null;

  const changes = countOf(
    await scopedDb(propertyId)
      .from('pms_room_status_log')
      .select('id', { count: 'exact', head: true })
      .gte('changed_at', sinceIso),
  );
  if (changes === null || changes === 0) return null;
  return `${plural(changes, 'room-status change')} recorded today`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. TONIGHT
// ═══════════════════════════════════════════════════════════════════════════
//
// Deliberately only the numbers the snapshot does NOT already carry. The
// snapshot prints occupied / checking-out / stayover; what it has never had is
// ARRIVALS, which is the single number that decides whether tonight is busy.
//
// Same gate as feed 3, for the same reason: no live feed, no claim.

async function feedTonight(
  snapshot: HotelSnapshot,
  propertyId: string,
  today: string,
): Promise<string | null> {
  if (!snapshot.pmsDataSource) return null;
  if (snapshot.pmsConnectionPending) return null;

  const arrivals = countOf(
    await scopedDb(propertyId)
      .from('pms_reservations')
      .select('id', { count: 'exact', head: true })
      .eq('arrival_date', today)
      .in('status', ['booked', 'checked_in']),
  );
  if (arrivals === null) return null;

  const yetToArrive = countOf(
    await scopedDb(propertyId)
      .from('pms_reservations')
      .select('id', { count: 'exact', head: true })
      .eq('arrival_date', today)
      .eq('status', 'booked'),
  );

  if (arrivals === 0 && (yetToArrive ?? 0) === 0) return null;
  const parts = [`${plural(arrivals, 'arrival')} booked for tonight`];
  if (yetToArrive !== null && yetToArrive > 0) {
    parts.push(`${yetToArrive} not checked in yet`);
  }
  return parts.join(', ');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. WHAT'S ON YOUR PLATE
// ═══════════════════════════════════════════════════════════════════════════
//
// Counts and one-liners — never the payloads. The model has a tool for each of
// these (`staxis_findings`, `staxis_pending_decisions`, `staxis_preventive`) and
// the point of this line is to tell it there is something worth CALLING them
// for. Inlining the items would cost hundreds of tokens on every turn to
// pre-answer a question usually nobody asked.
//
// Each item is gated by `canSee`, which asks the lens table whether this hat
// mounts the corresponding tool. So the front desk — whose prompt explicitly
// says approvals and findings are manager questions — is told about neither,
// and cannot be tempted to describe a queue it is not allowed to read.

async function feedOnYourPlate(
  propertyId: string,
  role: AppRole,
  accountId: string,
  organizationId: string | null,
  today: string,
  nowIso: string,
): Promise<string | null> {
  const items: string[] = [];

  // Each item is independently resilient.
  //
  // WHY, in one sentence a test caught for me: this function assembles four
  // sources into ONE line, so without per-item isolation a single failing
  // source takes the other three down with it — a manager with two decisions
  // waiting is told nothing because the preventive schedule had a bad row. The
  // outer `Promise.allSettled` in loadFeedsUncached is the wrong granularity
  // for a composite feed; it only knows how to drop the whole line.
  const item = async (produce: () => Promise<string | null>, name: string) => {
    try {
      const value = await produce();
      if (value) items.push(value);
    } catch (error) {
      captureException(error, { where: `agent/awareness.onYourPlate.${name}` });
    }
  };

  // ── Approval cards this person left hanging ──
  // `status = 'pending'` ALONE IS WRONG. The 10-minute TTL is enforced lazily —
  // nothing sweeps the table on a timer — so an abandoned card sits at
  // 'pending' indefinitely and a naive count reports yesterday's dead cards as
  // things waiting on you this morning. The `expires_at` guard is the same one
  // `getLivePendingActions` applies in JS; pushed into SQL here because this is
  // a count, and dragging rows back to filter them would be the slow way to
  // reach the same number.
  if (canSee(role, 'staxis_pending_decisions')) {
    await item(async () => {
      const pending = countOf(
        await scopedDb(propertyId)
          .from('agent_pending_actions')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('status', 'pending')
          .gt('expires_at', nowIso),
      );
      return pending !== null && pending > 0
        ? `${plural(pending, 'action')} you left waiting on a Yes/No`
        : null;
    }, 'approvals');
  }

  // ── Offers Staxis is holding for a human ──
  // Through the canonical helper, NOT a hand-rolled query: "waiting" means the
  // JUDGE's disposition where there is one and the detector's where there is
  // not, and re-deriving that here is how the badge and this line would come to
  // disagree about the same number in the same session.
  if (canSee(role, 'staxis_findings')) {
    await item(async () => {
      const proposed = await countProposeFindings(propertyId);
      return proposed > 0 ? `${plural(proposed, 'thing')} Staxis is offering to do` : null;
    }, 'findings');
  }

  // ── Preventive work that has come due ──
  // Reuses `scheduleState`, the pure rule the detector itself uses, rather than
  // a second "is it overdue" formula. There are already two copies of that
  // arithmetic in this codebase (findings + worklist) and they disagree about a
  // called-but-not-done task; a third would be worse than either.
  if (canSee(role, 'staxis_preventive')) {
    await item(async () => {
      const due = await countPreventiveDue(propertyId, today);
      return due !== null && due > 0 ? `${plural(due, 'preventive task')} due or overdue` : null;
    }, 'preventive');
  }

  // ── A company person's own queue ──
  // Only for someone holding a COMPANY-scope hat, and only ever a count. The
  // real queue is built by `buildPortfolioQueue`, which runs the portfolio
  // detectors and holds a day-slot — far too heavy for something that would run
  // on every chat message. This is one indexed count over rows that queue has
  // already produced.
  if (organizationId) {
    // THE ONE ESCAPE HATCH IN THIS FILE, and it is a real one: company_findings
    // is keyed by `organization_id` and has no `property_id` at all, so the
    // one-hotel accessor cannot scope it — it would filter on a column that
    // does not exist. The tenant boundary is still closed, just drawn one level
    // up: `organizationId` comes from the spine's `effectiveRole` for THIS
    // person, and is non-null only for a company-scope hat. Nobody can reach
    // another company's queue because nobody can reach another company's hat.
    await item(async () => {
      const companyOpen = countOf(
        await unscopedBecause('company-scope-table')
          .from('company_findings')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .in('status', ['open', 'updated']),
      );
      return companyOpen !== null && companyOpen > 0
        ? `${plural(companyOpen, 'open item')} across the company`
        : null;
    }, 'company');
  }

  if (items.length === 0) return null;
  return joinCapped(items, 4);
}

/**
 * How many preventive tasks are due or past due today, or null if unreadable.
 *
 * `resting` and `never_done` are BOTH excluded, for different reasons that both
 * matter: a task somebody has already called about is handled (chasing it is
 * the noise the follow-up window exists to prevent), and a task that has never
 * been completed has no due date at all — treating "new schedule" as "overdue"
 * would put every hotel that just set up maintenance into permanent alarm.
 */
async function countPreventiveDue(propertyId: string, today: string): Promise<number | null> {
  const { data, error } = await scopedDb(propertyId)
    .from('preventive_tasks')
    .select('id, name, frequency_days, last_completed_at, called_at')
    .limit(FEED_ROW_CAP);
  if (error) return null;

  let due = 0;
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    const frequencyDays = Math.round(Number(row.frequency_days ?? 0));
    if (!Number.isFinite(frequencyDays) || frequencyDays < 1) continue;
    const lastDoneDate = isoToLocalDate(row.last_completed_at);
    const state = scheduleState(
      {
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        area: null,
        frequencyDays,
        lastDoneDate,
        lastDoneAtIso: typeof row.last_completed_at === 'string' ? row.last_completed_at : null,
        nextDueDate: lastDoneDate ? addDaysInTz(lastDoneDate, frequencyDays) : null,
        calledDate: isoToLocalDate(row.called_at),
        calledBy: null,
      },
      today,
    );
    if (state.kind === 'due' || state.kind === 'follow_up') due += 1;
  }
  return due;
}

/** YYYY-MM-DD off a stored timestamp, or null. */
function isoToLocalDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) return null;
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. WHAT STAXIS ITSELF DID TODAY, AND WHAT IT IS IN THE MIDDLE OF
// ═══════════════════════════════════════════════════════════════════════════
//
// This feed used to be able to say exactly two things: "the nightly check ran"
// and "the brief got written". Ask a live hotel's companion "what have you been
// doing?" and it rendered nothing at all, because nothing anywhere recorded
// that it had done anything. Now it reads its own journal (`activity_log` rows
// with source='staxis_agent' — see src/lib/agent/journal.ts) plus the one
// question it is still waiting on an answer to.
//
// ─── THE HONESTY RULE IS UNCHANGED AND IS WHY THIS IS SHAPED LIKE THIS ─────
//
// The rule from the file header (lines 48-58) applies here more sharply than
// anywhere else: an empty feed renders NOTHING. Not "did nothing today", not
// "0 actions". The journal is written fail-soft on purpose, so an empty read
// means "no record", which is a different claim from "nothing happened", and
// only silence is true for both.
//
// The nightly detector run stays a separate probe rather than a journal read.
// It is written by a cron, not by the companion, and the crons that produce it
// are the founder's master switch: a hotel whose check never ran must never see
// a line implying it did. `latestRunFacts` returns null for a hotel that has
// never been checked (deliberately, rather than a zeroed object), and a run
// from an earlier day renders nothing. "When did Staxis last look?" also has a
// dedicated tool, `staxis_checked_last_night`, and answering it approximately
// here would undercut the tool that answers it properly.
//
// ─── WHY IT COUNTS RATHER THAN QUOTES ──────────────────────────────────────
//
// A journal description is a full sentence up to 300 characters. Four of them
// would be 1200 characters, which is the ENTIRE budget of the awareness block
// (MAX_BLOCK_CHARS), on one feed, on every turn. So the acts are counted and
// only the most recent one is quoted, clipped. The conversation can ask for
// more; the block's job is to stop the companion answering "what have you been
// doing" with nothing.

/** Longest quotation this feed takes from a journal line. See above. */
const JOURNAL_QUOTE_MAX = 110;

/** The three families of journal entry this feed counts separately. */
const ACT_EVENTS = ['agent_acted', 'agent_action_approved', 'agent_action_edited'] as const;

function clipQuote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= JOURNAL_QUOTE_MAX ? clean : `${clean.slice(0, JOURNAL_QUOTE_MAX - 1)}…`;
}

async function feedStaxisToday(
  propertyId: string,
  today: string,
  timezone: string | null,
  sinceIso: string,
  nowIso: string,
): Promise<string | null> {
  const parts: string[] = [];

  // ── The nightly detector run (a cron's record, not the companion's) ──
  try {
    const run = await latestRunFacts(propertyId);
    if (run && propertyLocalToday(new Date(run.runAt), timezone) === today) {
      const at = hotelClock(new Date(run.runAt), timezone).time;
      parts.push(`checked ${plural(run.detectorsChecked, 'thing')} at ${at}`);
      if (run.detectorsSkipped > 0) {
        // Named, not hidden: a skip is "not enough data to judge", which is a
        // different claim from "looked and found nothing" and the model must
        // not collapse the two.
        parts.push(`${run.detectorsSkipped} skipped for thin data`);
      }
    }
  } catch {
    // Feed degrades; chat continues.
  }

  // ── The journal: what it actually did, since midnight at the hotel ──
  //
  // `sinceIso` is the SAME start-of-local-day instant every other feed in this
  // file counts from (startOfLocalDayIso), so "today" means one thing across
  // the whole block. A night auditor at 1am is on the hotel's day, not UTC's.
  try {
    const rows = await readAgentJournal(propertyId, { sinceIso });
    // `ok: false` is a thing that was TRIED, not a thing that was done. Counting
    // a failed write into "did 2 things" would put a number in front of the
    // model that the number guard would then let it quote.
    const acts = rows.filter((r) => (ACT_EVENTS as readonly string[]).includes(r.eventType)
      && r.metadata.ok !== false);
    const said = rows.filter((r) => r.eventType === 'agent_said');
    const learned = rows.filter((r) => r.eventType === 'agent_learned');
    const brief = rows.find((r) => r.eventType === 'agent_briefed');

    if (brief) {
      parts.push(`wrote the morning brief at ${hotelClock(new Date(brief.occurredAt), timezone).time}`);
    }
    if (acts.length > 0) {
      // Rows come back newest first, so [0] is the most recent act.
      parts.push(`did ${plural(acts.length, 'thing')}, most recently: ${esc(clipQuote(acts[0].description))}`);
    }
    if (learned.length > 0) parts.push('updated what it remembers about this hotel');
    if (said.length > 0) parts.push(`spoke first ${plural(said.length, 'time')}`);
  } catch {
    // Feed degrades; chat continues.
  }

  // ── What it is in the MIDDLE of ──
  //
  // A card that is still up is the companion holding a question open, and it is
  // the single most useful thing this feed can carry: a manager who asks "what
  // are you doing" while an approval is on their screen should not be told
  // about this morning. Live rows only: `expires_at > now` excludes the ones
  // the lazy TTL has not flipped yet, so this never claims to be waiting on an
  // answer to a question that already timed out.
  try {
    const { data } = await scopedDb(propertyId)
      .from('agent_pending_actions')
      .select('tool_name')
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .limit(FEED_ROW_CAP);
    const waiting = (data ?? []).length;
    if (waiting > 0) {
      parts.push(`still waiting on an answer to ${plural(waiting, 'question')} it asked`);
    }
  } catch {
    // Feed degrades; chat continues.
  }

  if (parts.length === 0) return null;
  return joinCapped(parts, 4);
}

// ═══════════════════════════════════════════════════════════════════════════
// ASSEMBLY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The DB-backed half of the block, cached briefly per (hotel, person, hat).
 *
 * WHAT IS AND IS NOT IN HERE is the whole point of the split. The clock and the
 * screen are NOT cached — they are rendered from `now` and the request's own
 * pathname at format time. Caching the clock would serve "2:47 PM" for twenty
 * seconds after it stopped being true, and caching the screen would tell the
 * model the person is on Inventory after they have navigated to Staff.
 *
 * That is the same lesson `pmsDataCapturedAt` already encodes on the snapshot:
 * store the raw fact, render the time-sensitive form at the moment of use. A
 * pre-rendered age inside a cache is a small lie with a 30-second half-life.
 */
type CachedFeeds = Omit<Awareness, 'clock' | 'screen'>;

const feedCache = new Map<string, { feeds: CachedFeeds; expiresAt: number }>();
const inflight = new Map<string, Promise<CachedFeeds>>();

/**
 * Twenty seconds. Shorter than the snapshot's thirty on purpose: this block is
 * about what just happened, and a manager who marks a room clean and
 * immediately asks "what's left" is the exact interaction the feed exists for.
 */
const FEED_CACHE_TTL_MS = 20_000;

function feedCacheKey(propertyId: string, accountId: string, role: AppRole): string {
  return `${propertyId}::${accountId}::${role}`;
}

/** Exported for tests — a module-level cache otherwise leaks between cases. */
export function clearAwarenessCache(): void {
  feedCache.clear();
  inflight.clear();
}

/**
 * Build the situational-awareness block for one turn.
 *
 * NEVER THROWS. Every feed is settled independently and a rejected one is
 * dropped after being reported; the clock always renders, so the return value
 * is always a usable `Awareness`. The chat turn must not be able to fail
 * because the hotel's preventive schedule had a bad row in it.
 */
export async function buildAwareness(input: AwarenessInput): Promise<Awareness> {
  const now = input.now ?? new Date();
  const timezone = input.snapshot.property.timezone;
  const clock = hotelClock(now, timezone);

  const base: Awareness = {
    clock: `${clock.time} ${clock.weekday} at the hotel — ${PHASE_WORDS[clock.phase]}`,
  };

  const screen = resolveSurface(input.pathname);
  if (screen) base.screen = screen;

  // Which buttons on that screen the companion is allowed to point at.
  //
  // TWO gates, and the second is the one that matters. The lens decides whether
  // this hat has a pointer at all. The STANDING decides which controls their
  // own screen actually rendered: the importer and the delivery scanner are
  // behind `canManage` and `canViewFinancials` on the stockroom page, and a
  // maintenance tech told those keys exist would get a confident "it is this
  // one" with no arrow, because the button was never on their screen.
  //
  // This block only decides what the model is TEMPTED by. The wall is in the
  // tool, which re-derives the same standing from the route-bound per-hotel
  // capability snapshot this function does not hold. `moneyVisibleToRole` is
  // the closest signal available here and is deliberately the looser of the
  // two: a manager without the money capability may still be shown the key and
  // will get a refusal in words, which is a recoverable turn rather than a
  // silent one.
  if (canSee(input.role, 'staxis_point_at')) {
    const pointable = anchorsOnPage(pageForPath(input.pathname)?.key ?? null, {
      canManage: canManageTeam(input.role),
      seesMoney: moneyVisibleToRole(input.role),
    });
    if (pointable.length > 0) {
      base.pointables = pointable.map((a) => `${a.key} (${a.label}: ${a.does})`).join('; ');
    }
  }

  let feeds: CachedFeeds = {};
  try {
    feeds = await loadFeeds(input, now, timezone);
  } catch (error) {
    // The gatherer itself is already all-settled, so reaching here means
    // something structural (a cache bug, a bad clock). Report and serve the
    // clock alone rather than failing the turn.
    captureException(error, { where: 'agent/awareness.loadFeeds' });
  }

  return { ...base, ...feeds };
}

async function loadFeeds(
  input: AwarenessInput,
  now: Date,
  timezone: string | null,
): Promise<CachedFeeds> {
  const key = feedCacheKey(input.propertyId, input.accountId, input.role);
  const cached = feedCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.feeds;
  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = loadFeedsUncached(input, now, timezone)
    .then((feeds) => {
      feedCache.set(key, { feeds, expiresAt: Date.now() + FEED_CACHE_TTL_MS });
      return feeds;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

async function loadFeedsUncached(
  input: AwarenessInput,
  now: Date,
  timezone: string | null,
): Promise<CachedFeeds> {
  const { propertyId, role, accountId, authUserId, organizationId, snapshot } = input;
  const today = propertyLocalToday(now, timezone);
  const sinceIso = startOfLocalDayIso(now, timezone);
  const nowIso = now.toISOString();

  // One settled slot per feed. A rejection drops that line and nothing else.
  const [didToday, justChanged, onYourPlate, staxisToday, tonight] = await Promise.allSettled([
    feedDidToday(propertyId, accountId, authUserId ?? null, sinceIso),
    feedJustChanged(snapshot, propertyId, sinceIso),
    feedOnYourPlate(propertyId, role, accountId, organizationId ?? null, today, nowIso),
    feedStaxisToday(propertyId, today, timezone, sinceIso, nowIso),
    canSee(role, 'get_future_bookings')
      ? feedTonight(snapshot, propertyId, today)
      : Promise.resolve(null),
  ]);

  const out: CachedFeeds = {};
  const take = (
    slot: PromiseSettledResult<string | null>,
    field: keyof CachedFeeds,
    name: string,
  ) => {
    if (slot.status === 'rejected') {
      // Countable. A feed that fails silently forever is indistinguishable
      // from a feed that is legitimately empty — and this file's whole
      // contract is that empty means empty.
      captureException(slot.reason, { where: `agent/awareness.${name}` });
      return;
    }
    if (slot.value) out[field] = slot.value;
  };

  take(didToday, 'didToday', 'didToday');
  take(justChanged, 'justChanged', 'justChanged');
  take(onYourPlate, 'onYourPlate', 'onYourPlate');
  take(staxisToday, 'staxisToday', 'staxisToday');
  take(tonight, 'tonight', 'tonight');

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The section header.
 *
 * Exported because llm.ts registers it in `DYNAMIC_ONLY_MARKERS` — the runtime
 * check that throws (outside production) if this block ever ends up inside the
 * cached stable half. Importing the constant rather than retyping the string
 * means the guard cannot drift out of alignment with the thing it guards.
 */
export const AWARENESS_HEADER = '─── Right now ───';

/**
 * The envelope, as constants rather than inline literals.
 *
 * Registered in `knowledge-door.ts` like every other store's envelope, so the
 * inventory that polices "which modules inject knowledge" is reading the same
 * strings this formatter prints instead of a copy of them.
 *
 * `trust="system"` and no ceiling above it, deliberately. The ceilings belong
 * to the tiers that carry text SOMEBODY ELSE WROTE — the PMS family row, the
 * company rulebook, the hotel's standing rules, the hotel's own setup labels.
 * This block is assembled here, in code, from nine of our own reads; there is
 * no third party whose prose needs fencing off.
 */
export const AWARENESS_TRUST_MARKER_OPEN = '<staxis-awareness trust="system">';
export const AWARENESS_TRUST_MARKER_CLOSE = '</staxis-awareness>';

/**
 * Version stamp for this block, folded into the PERSISTED receipt only.
 *
 * Every other envelope-wrapped store had one and this one did not, so "which
 * awareness rendering ran on this turn" was the one question
 * `agent_messages.prompt_version` could not answer. It goes in `versionLabel`
 * and NOT in the printed `stableStamp`: the block is per-turn, so printing
 * anything about it into the cached half would rewrite the cached prefix every
 * single turn. Bump on a rendering change.
 */
export const AWARENESS_VERSION = 'awareness-v2';

/**
 * The hard ceiling on the whole block, in characters.
 *
 * ~4 chars per token puts this at roughly 300 tokens of content plus the
 * wrapper — inside the 400-token budget with room for a long hotel's feed
 * lines. It is a BACKSTOP, not the primary control: every feed above caps its
 * own list, so reaching this bound means a feed grew a new shape and the cap
 * is telling us before the bill does.
 */
const MAX_BLOCK_CHARS = 1200;

/**
 * Render the block, or '' when there is nothing worth saying.
 *
 * Returns the empty string — not a wrapper containing nothing — when only the
 * clock is present and no feed produced a line. A `<staxis-awareness>` element
 * holding one clock line is worth neither the tokens nor the model's attention.
 * The clock alone IS worth it once anything else is there to give it context.
 */
export function formatAwarenessForPrompt(awareness: Awareness): string {
  const lines: string[] = [];
  if (awareness.screen) lines.push(`On screen: ${awareness.screen}.`);
  if (awareness.pointables) {
    lines.push(
      'Controls on this screen you can point at with staxis_point_at, by key: '
      + `${awareness.pointables}. No other key works here.`,
    );
  }
  lines.push(`Time: ${awareness.clock}.`);
  if (awareness.didToday) lines.push(`This person has done today: ${awareness.didToday}.`);
  if (awareness.justChanged) lines.push(`Since the last report: ${awareness.justChanged}.`);
  if (awareness.onYourPlate) lines.push(`Waiting on them: ${awareness.onYourPlate}.`);
  // Written in the first person because it is the ONE line in this block that
  // is about the companion rather than about the hotel. "What have you been
  // doing?" is answered from here, and a model handed "Staxis today: …" in a
  // block of third-person facts has to work out that it is Staxis.
  if (awareness.staxisToday) lines.push(`What I have done today: ${awareness.staxisToday}.`);
  if (awareness.tonight) lines.push(`Tonight: ${awareness.tonight}.`);

  // Clock-only ⇒ nothing. `lines` always holds the time, so the test is >1.
  if (lines.length <= 1 && !awareness.screen) return '';

  let body = lines.join('\n');
  if (body.length > MAX_BLOCK_CHARS) {
    body = `${body.slice(0, MAX_BLOCK_CHARS)}\n…truncated.`;
  }

  return [
    AWARENESS_HEADER,
    AWARENESS_TRUST_MARKER_OPEN,
    body,
    AWARENESS_TRUST_MARKER_CLOSE,
  ].join('\n');
}
