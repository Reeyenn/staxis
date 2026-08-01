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

/** Most unprompted messages the companion may speak in one hotel-local day. */
export const COMPANION_MAX_SPEECH_PER_DAY = 2;

/** Minimum gap between two unprompted messages, in minutes. */
export const COMPANION_MIN_GAP_MINUTES = 120;

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
 */
export const COMPANION_MEMORY_TOPIC_CAP = 60;
