// ═══════════════════════════════════════════════════════════════════════════
// The companion's charter.
//
// ONE AI companion for the whole app. Not a second brain: it is a FACE on the
// chat pipeline that already exists (src/lib/agent/*). Everything it can DO, it
// does by opening that conversation. Nothing in this folder starts a second
// agent loop, a second prompt stack, or a second action system.
//
// What lives here is the promise the companion makes to the person using it.
// Each clause below is enforced by a behaviour test in
// src/lib/__tests__/companion-charter.test.ts — the clause and its test are
// written as a pair on purpose, so a promise cannot survive its enforcement.
//
//   1. NEVER ACTS WITHOUT A YES.  Every offer the companion makes is a Yes/No
//      with a real No. Actual mutations go through the existing approval-card
//      DO wire (agent_pending_actions + ApprovalOverlay), which shows a receipt
//      after the fact. The companion adds no path around that.
//   2. NEVER SPENDS MONEY.  It has no purchasing affordance of its own and
//      offers none. Ordering is out of its reach entirely.
//   3. HONEST ABOUT ABILITY AND DATA AGE.  When the AI layer is unavailable it
//      says so plainly instead of spinning. It never claims a number it was not
//      given (the existing number guard covers the conversation).
//   4. ONE VOICE.  Warm, brief, plain English. Short sentences. No exclamation
//      marks, no marketing words, no emoji, no em dashes.
//   5. ENGLISH ONLY.  Founder ruling 2026-07-29.
//   6. NEVER ON A HOUSEKEEPER SCREEN.  See mount.ts.
//
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The companion's instruction layer, in the voice it must speak in.
 *
 * MODEL-FACING TEXT. It is never rendered to a person, so the no-em-dash rule
 * does not apply to it (same carve-out as agent tool descriptions). It is
 * appended to the conversation the companion opens so that a turn started from
 * the bubble sounds like the bubble, without forking the prompt stack: this is
 * a suffix on the existing dynamic block, not a second system prompt.
 */
export const COMPANION_VOICE = [
  'You are the Staxis companion. You are the same assistant the person already',
  'knows, speaking from the small helper bubble in the corner of the screen.',
  'Speak like a competent colleague who has worked here a while: warm, brief,',
  'plain English, short sentences. Two or three sentences is usually enough.',
  'Never use an em dash; use a full stop, a comma or a colon. Never use emoji.',
  'Never use marketing words. Never claim you did something you only offered to',
  'do. If you are unsure, say so and say what you would need to be sure.',
].join(' ');

/** Stamp for the voice suffix. Bump when COMPANION_VOICE changes. */
export const COMPANION_VOICE_VERSION = 'companion-voice-v1';

// ─── Tunables ───────────────────────────────────────────────────────────────
//
// These are the "quiet by default" dial. They are constants rather than
// settings because a hotel should never have to configure politeness, and
// because a per-hotel knob would be a knob nobody turns and everybody has to
// reason about. Raise them here if the companion ever feels too quiet.

/**
 * Most unprompted messages the companion may speak in one hotel-local day.
 *
 * Two until 2026-08-06, now five. Two was set before the companion had
 * anything worth saying twice: it could volunteer a finding and nothing else,
 * so a low cap cost nothing. It now has a record of its own day to draw on and
 * a forgotten question to close, and a cap of two meant the second half of a
 * shift was silent by arithmetic rather than by judgement.
 *
 * Five is still quiet. Every other floor is untouched and each one bites
 * first: one thing at a time, never over a person who is typing, never a topic
 * already raised today, never a topic already turned down twice, and never
 * something a card on the screen is already showing.
 */
export const COMPANION_MAX_SPEECH_PER_DAY = 5;

/**
 * Minimum gap between two unprompted messages, in minutes.
 *
 * Two hours until 2026-08-06, now forty-five minutes. Two hours was the same
 * conservatism as the cap above and had the same failure: something that
 * became true at 9:05 waited until 11:00 to be said, by which point a shift
 * had turned over and the person it mattered to had gone home.
 *
 * Forty-five minutes is longer than any single task on the floor, so this can
 * never interrupt the same piece of work twice.
 */
export const COMPANION_MIN_GAP_MINUTES = 45;

/**
 * How many times an offer on a topic may be turned down before that topic is
 * dropped for good. Two, because one No can be a No to the moment and a second
 * is a No to the subject.
 */
export const COMPANION_DECLINES_BEFORE_DROP = 2;

/**
 * Cap on how many topics the per-person memory remembers. A companion that
 * accumulated one row per finding forever would grow a preference blob without
 * a bound. Oldest topics fall off first; a dropped topic outranks a live one
 * because forgetting a No is the failure that actually annoys people.
 *
 * A COUNT IS NOT THE REAL LIMIT. See COMPANION_MEMORY_MAX_BYTES: the column has
 * a size CHECK on it and sixty topics does not fit inside that check when the
 * keys are long. This number is the cheap upper bound on how many things one
 * person is worth remembering; the byte budget below is the one that keeps the
 * write from being refused.
 */
export const COMPANION_MEMORY_TOPIC_CAP = 60;

// ─── The size of the ledger, in the units the database actually measures ────
//
// `staxis_user_prefs.companion_memory` carries
// `CHECK (pg_column_size(companion_memory) <= 8192)` (migration 0417). Past it
// the UPSERT is REFUSED, and the refusal is the dangerous kind rather than a
// loud one: POST /api/companion 500s, the browser keeps its optimistic memory
// for the rest of the page load, and `rememberSpoke` silently stops persisting.
// The daily speech cap and the never-nag ledger are both stored state, so both
// stop being enforced across page loads while the bubble looks fine.
//
// So the ledger bounds ITSELF, in bytes, against that number. The topic count
// above is kept as a second and cheaper ceiling; this is the one that has to
// hold.

/**
 * Byte budget for the whole serialized memory blob.
 *
 * 6 KB against an 8 KB column check, and the 2 KB of headroom is not timidity:
 * `pg_column_size` measures the jsonb BINARY representation, which carries a
 * per-key header and can run larger than the JSON text we measure here. The
 * gap is the margin between what this code can count and what Postgres will
 * count. Raise the column check first if this ever needs to grow.
 */
export const COMPANION_MEMORY_MAX_BYTES = 6_144;

/**
 * Held back from the budget for everything that is NOT a topic.
 *
 * The welcome stamp, the tour stamps, both notices cursors, the speech counters
 * and the taught map. These are the fields that ENFORCE the limits, so they are
 * never the thing that gets evicted: a memory that dropped `spokenCount` to make
 * room for a topic would have thrown away the daily cap to remember an
 * interruption. A fully populated set of them is around 700 bytes; this is
 * rounded up so a future field does not silently eat into the same margin.
 */
export const COMPANION_MEMORY_FIXED_RESERVE_BYTES = 1_024;

/** What the topics map itself may weigh, serialized. */
export const COMPANION_MEMORY_TOPICS_MAX_BYTES =
  COMPANION_MEMORY_MAX_BYTES - COMPANION_MEMORY_FIXED_RESERVE_BYTES;
