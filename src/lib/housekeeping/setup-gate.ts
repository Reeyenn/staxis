/**
 * feature/housekeeping-levels (2026-07-24) — the one-time Housekeeping
 * questionnaire: its types, its rules, and its two parsers.
 *
 * This module is the SINGLE SOURCE OF TRUTH for `properties.housekeeping_setup`
 * (migration 0337). It is deliberately pure — no React, no Supabase, no I/O, no
 * module-level state — so the questionnaire UI, the write route, the gate that
 * decides whether to show the questionnaire, and the labor-cost math all agree
 * on exactly one set of rules. Client and server importing the same validators
 * is the point: they can never disagree about what a valid answer is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FEATURE EXISTS (read this before changing any rule below)
 *
 * Staxis reads each hotel's booking system through scheduled report emails. Two
 * hard product constraints shape everything in this file:
 *
 *   1. Staxis can NEVER write back into the hotel's booking system. One-way,
 *      read-only, forever. So Staxis does not own whether a room is clean — the
 *      hotel's own system does. Staxis owns the PLAN: who cleans which rooms,
 *      in what order, how many people are needed tomorrow, what it costs.
 *
 *   2. Staxis can NEVER add a step to anybody's existing job. If a person
 *      already records something somewhere, we cannot ask them to also record
 *      it in Staxis. Double entry means nobody uses the product. REPLACING
 *      something they already do (a paper sheet, a radio call, a notebook) is
 *      fine; adding on top of it is not.
 *
 * The questionnaire exists to work out, per hotel, how much of Staxis can be
 * adopted without breaking constraint 2. That produces three levels:
 *
 *   Level 1 — "Staxis plans it."   Only the manager opens Staxis. The board is
 *             built overnight, approved, and printed onto the same paper the
 *             crew already carries. Nothing changes for any employee.
 *   Level 2 — "The head housekeeper runs her day in it." One more person
 *             adopts; her notebook moves into Staxis. Each item replaces paper
 *             she already keeps. This is also what keeps Level 1's numbers
 *             honest — if she adjusts the board on paper instead, per-person
 *             attribution goes quietly wrong while still looking right.
 *   Level 3 — "The crew carries it." Housekeepers get the board on their phones
 *             and tap once when a room is done. There is deliberately no
 *             "start" tap — nobody announces starting a room today, so a start
 *             tap would be an added step rather than a swap.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE HARD LOCK
 *
 * Level 3 is NOT offerable when the hotel's housekeepers already enter room
 * status themselves (`statusEntry === 'housekeeper_direct'` — e.g. dialling a
 * code on the room phone, or their own login in the hotel's system). For those
 * hotels a tap in Staxis is a second recording of a fact the housekeeper has
 * already recorded: pure double entry, a direct violation of constraint 2.
 *
 * That lock is enforced in three places, all routed through `isLevelOfferable`:
 *   - the UI renders Level 3 visibly locked with a plain-English explanation,
 *   - `parseHousekeepingSetup` clamps a stored-but-impossible level on read,
 *   - `validateSetupSubmission` REJECTS such a submission on write.
 * The write-side rejection is the real boundary; the other two are so a corrupt
 * or hand-edited row can never quietly put a hotel into double entry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO FREE-TEXT LISTS (added 2026-07-25)
 *
 * Two screens let a hotel add its own answers: Q2 can hold room types beyond
 * checkout and stayover (a suite, an extended-stay unit, a scheduled deep
 * clean), and Q6 can hold duties beyond the five we list. Hotels genuinely
 * differ here, and a hotel that cannot describe its own rooms cannot describe
 * its own workload.
 *
 * They were added to schema version 1 rather than a version 2 — the reason is
 * on `HousekeepingSetup.version` and it matters: bumping would have re-asked
 * the whole questionnaire to every hotel that had already finished it.
 *
 * Neither list is written to `hk_clean_time_standards`, so a custom room type
 * does NOT drive the board's minutes today. Reasoning in the header of
 * src/app/api/housekeeping/setup/route.ts.
 */

/* ───────────────────────────── Types ───────────────────────────── */

/** How much of Staxis this hotel has chosen to adopt. See the header. */
export type HkLevel = 1 | 2 | 3;

/**
 * Q1 — "How does a clean room get into your system today?"
 *
 * The single most consequential answer in the questionnaire: it decides whether
 * Level 3 can be offered at all.
 *   housekeeper_radio  — the housekeeper tells the front desk; the desk enters it.
 *   supervisor_keys    — a supervisor or head housekeeper enters it.
 *   housekeeper_direct — housekeepers enter it themselves (room phone code or
 *                        their own login). LOCKS LEVEL 3.
 *   unsure             — they don't know. Treated as offerable; we would rather
 *                        offer and let them decline than block a hotel out of a
 *                        level because nobody was sure on day one.
 */
export type StatusEntryMethod =
  | 'housekeeper_radio'
  | 'supervisor_keys'
  | 'housekeeper_direct'
  | 'unsure';

/**
 * Q4 (second half) — "Who builds the board?"
 *
 * `head_housekeeper` is the signal we act on: where a real person already owns
 * the board on paper, Level 2 is the right first ask, because winning her is
 * what keeps every downstream number honest.
 */
export type BoardBuiltBy = 'head_housekeeper' | 'gm' | 'nobody' | 'unsure';

/**
 * Q5 — "Who checks rooms before they're sold?"
 *
 * Kept because cleaned, inspected and sellable are three different states. A
 * hotel that inspects every room has a real second step between "housekeeper
 * finished" and "front desk can sell it", and later screens must not conflate
 * them.
 */
export type InspectionPolicy = 'none' | 'spot_check' | 'every_room';

/**
 * Q6 — "What else do your housekeepers do besides rooms?"
 *
 * Without this, time spent on laundry or breakfast is silently counted as room
 * time, which makes honest workers look slow — our headline productivity number
 * would slander people. An empty list means "rooms only".
 */
export type SideDuty = 'laundry' | 'breakfast' | 'lobby' | 'public_areas' | 'shuttle';

/**
 * Q2 (the "+") — one room type this hotel invented, with its own standard time.
 *
 * Hotels do not agree on what rooms they have. "Checkout" and "stayover" cover
 * every hotel; suites, extended-stay units and scheduled deep cleans do not fit
 * either box, and a hotel that has them cannot describe its real workload with
 * two numbers. So the questionnaire lets them name their own.
 *
 * `label` is whatever the hotel calls it, in their words. `minutes` obeys
 * EXACTLY the same rule as the two built-in times (`isValidCleanMinutes`) —
 * there is deliberately only one definition of "a believable room time" in this
 * file, because two would eventually disagree.
 *
 * NOT written to `hk_clean_time_standards` — see the note on `customRoomTypes`
 * below, and the header of src/app/api/housekeeping/setup/route.ts.
 */
export interface CustomRoomType {
  /** The hotel's own name for it. Trimmed, whitespace-collapsed, 1..40 chars. */
  label: string;
  /** Standard minutes for this room type. Whole number, 5..240. */
  minutes: number;
}

/**
 * The persisted shape of `properties.housekeeping_setup` (migration 0337).
 *
 * NULL column, or `completedAt === null`, both mean "questionnaire not finished"
 * — see `isHousekeepingSetupComplete`.
 */
export interface HousekeepingSetup {
  /**
   * Schema version of this blob. Only 1 exists today.
   *
   * `customRoomTypes` and `customDuties` were ADDED to version 1 rather than
   * shipped as version 2, on purpose. `parseHousekeepingSetup` returns null for
   * any version it does not recognise, and null reads as "questionnaire not
   * finished" — so bumping the version would have thrown every hotel that
   * already answered the seven questions straight back into the questionnaire,
   * for a change that adds nothing they have to answer. Both new fields default
   * to `[]` when absent instead, which makes yesterday's stored records parse as
   * complete and unchanged. The rule for any future field is the same: if it can
   * default safely, add it to version 1; only bump when an existing field's
   * MEANING changes, and then write a converter.
   */
  version: 1;
  /** ISO timestamp the questionnaire was finished. null => not finished. */
  completedAt: string | null;
  /** The level they chose. */
  level: HkLevel;
  /**
   * The level we suggested to them. Kept alongside `level` on purpose: the gap
   * between what we recommend and what hotels actually pick is the only data
   * that will ever tell us whether our recommendation rule is any good.
   */
  recommendedLevel: HkLevel;
  /** Q1 — how a clean room gets recorded today. */
  statusEntry: StatusEntryMethod;
  /** Q2 — standard minutes for a checkout room. Whole number, 5..240. */
  checkoutMinutes: number;
  /** Q2 — standard minutes for a stayover room. Whole number, 5..240. */
  stayoverMinutes: number;
  /** Q4 — when housekeeping starts, 'HH:MM' on a 24-hour clock. */
  shiftStartTime: string;
  /** Q4 — who builds the board today. */
  boardBuiltBy: BoardBuiltBy;
  /** Q5 — inspection policy. */
  inspection: InspectionPolicy;
  /** Q6 — side duties. May be empty (= rooms only). Deduped and sorted. */
  sideDuties: SideDuty[];
  /**
   * Q2 (the "+") — room types this hotel added itself, beyond checkout and
   * stayover. `[]` when they added none, which is the case for most hotels and
   * for every record written before this field existed.
   *
   * Deduped case-insensitively and sorted by label, so two hotels that entered
   * the same room types in a different order serialize identically.
   *
   * IMPORTANT: these live in this jsonb blob ONLY. They are NOT written to
   * `hk_clean_time_standards`, so they do NOT drive the board, the timeline or
   * the earned-hours math today — that table is keyed by a CHECK-constrained
   * `cleaning_type` enum, and a free-text label cannot become a member of it
   * without a migration. Anything reading these must treat them as the hotel's
   * stated intent, not as live workload input. Full reasoning in the header of
   * src/app/api/housekeeping/setup/route.ts.
   */
  customRoomTypes: CustomRoomType[];
  /**
   * Q6 (the "+") — duties this hotel added itself, beyond the five built-ins.
   * `[]` when they added none, and for every record written before this field
   * existed.
   *
   * Free text, in the hotel's own words ("van runs", "pool towels"). Deduped
   * case-insensitively and sorted, same as `customRoomTypes`. Like
   * `sideDuties`, these exist so time spent off-rooms is not silently counted
   * as room time — but they carry no minutes model, so they are a label only.
   */
  customDuties: string[];
  /**
   * Q3 — storage PATH of the photo of their paper board, NOT a URL. Signed URLs
   * expire; a stored URL would rot. null when they skipped the photo (which is
   * always allowed, in one tap).
   */
  boardPhotoPath: string | null;
}

/* ─────────────────────────── Constants ─────────────────────────── */

/** Every level, in display order. */
export const HK_LEVELS: readonly HkLevel[] = [1, 2, 3] as const;

/**
 * Bounds for the two standard room times. 5 minutes is below any real room and
 * exists only to catch fat-finger entry; 240 (4 hours) is above any real room
 * and exists to stop a typo from turning the labor-cost math into nonsense.
 * These are the numbers the entire earned-hours-vs-paid-hours calculation rests
 * on, so they are validated identically on the client and the server.
 */
export const MIN_CLEAN_MINUTES = 5;
export const MAX_CLEAN_MINUTES = 240;

/** Prefilled in Q2. Industry-typical starting points, not opinions. */
export const DEFAULT_CHECKOUT_MINUTES = 30;
export const DEFAULT_STAYOVER_MINUTES = 20;

/** Prefilled in Q4. */
export const DEFAULT_SHIFT_START = '08:00';

/**
 * Canonical option orders. Exported so the questionnaire screens, the write
 * route and any later screen all render/iterate the same members in the same
 * order — and so `sideDuties` has one deterministic sort order (this array's
 * index), which keeps equality checks between two saved setups stable.
 */
export const STATUS_ENTRY_METHODS: readonly StatusEntryMethod[] = [
  'housekeeper_radio',
  'supervisor_keys',
  'housekeeper_direct',
  'unsure',
] as const;

export const BOARD_BUILT_BY_OPTIONS: readonly BoardBuiltBy[] = [
  'head_housekeeper',
  'gm',
  'nobody',
  'unsure',
] as const;

export const INSPECTION_POLICIES: readonly InspectionPolicy[] = [
  'none',
  'spot_check',
  'every_room',
] as const;

export const SIDE_DUTIES: readonly SideDuty[] = [
  'laundry',
  'breakfast',
  'lobby',
  'public_areas',
  'shuttle',
] as const;

/**
 * Upper bound on the stored storage path. Supabase storage keys are well under
 * this; the cap only exists so a caller can't grow the jsonb row unboundedly
 * (same reasoning as ONBOARDING_STATE_MAX_STRING in src/lib/onboarding/state.ts).
 */
const MAX_BOARD_PHOTO_PATH = 500;

/* ─────────────────── Custom room types and custom duties ────────────────────
 *
 * Both "+" fields are free text, which means they are the only place in this
 * questionnaire where a hotel can type something we have never seen. Three
 * bounds keep that from becoming a problem, and all three are exported so the
 * questionnaire enforces exactly what the server enforces:
 *
 *   • a LENGTH cap, so one entry can't be a paragraph,
 *   • a COUNT cap, so the jsonb row (and the screen) stay bounded,
 *   • a RESERVED list, so a hotel can't create a second, competing copy of
 *     something the questionnaire already asks about.
 */

/**
 * Longest custom label we store. 40 characters holds every real answer a hotel
 * gives ("Extended stay studio", "Deep clean — quarterly") and fits on one line
 * on a phone, which is where the founder reviews this.
 */
export const MAX_CUSTOM_LABEL_LENGTH = 40;

/**
 * How many custom entries each list may hold.
 *
 * Eight is well past what any limited-service hotel actually has (most have
 * none) and is low enough that the jsonb row stays small and the screen stays
 * readable. The cap exists mostly so a bug or a scripted client can't grow one
 * property row without limit.
 */
export const MAX_CUSTOM_ROOM_TYPES = 8;
export const MAX_CUSTOM_DUTIES = 8;

/**
 * Labels a hotel may NOT reuse for a custom room type: the two standard times
 * the questionnaire already collects, under the names anyone would type for
 * them. A custom "Checkout" would sit next to `checkoutMinutes` holding a
 * different number, and no later screen could say which one the hotel meant.
 *
 * BOTH LANGUAGES, deliberately — unlike `RESERVED_DUTY_KEYS` below. The
 * questionnaire is bilingual, and a Spanish-speaking manager types "Salida",
 * not "Checkout". Left English-only, "Salida — 40 min" would sit beside
 * `checkoutMinutes: 30` with nothing able to say which number the hotel meant:
 * exactly the harm this list exists to prevent, reachable by every ES user.
 * The duty list can live with the same gap because custom duties carry no
 * minutes; a room type carries the number the labor-cost math rests on.
 *
 * These are literal spellings, not a translation-table import — this module
 * stays pure, with no UI dependency. Accented and unaccented forms are both
 * listed because `customEntryKey` lower-cases but does not fold accents, and a
 * phone keyboard produces either.
 *
 * NOT reserved on purpose: anything built on "estancia". The Spanish Q2
 * placeholder offers "estancia larga" (extended stay) as an EXAMPLE of a good
 * custom room type, so reserving it would refuse the answer we just suggested.
 */
export const RESERVED_ROOM_TYPE_KEYS: readonly string[] = [
  // English — the stored words, the hyphenations, and the on-screen labels.
  'checkout',
  'check out',
  'check-out',
  'checkout room',
  'departure',
  'departure room',
  'stayover',
  'stay over',
  'stay-over',
  'stayover room',
  // Spanish — "Habitación de salida" / "Habitación ocupada" on screen, and the
  // one-word forms a manager actually types.
  'salida',
  'salidas',
  'habitacion de salida',
  'habitación de salida',
  'ocupada',
  'ocupadas',
  'habitacion ocupada',
  'habitación ocupada',
] as const;

/**
 * Labels a hotel may NOT reuse for a custom duty: the five built-in duties,
 * both as the stored token and as the words the questionnaire shows for them.
 *
 * Known limit, stated rather than hidden: the comparison is against the ENGLISH
 * words only. A Spanish-speaking manager typing "Lavandería" gets a custom duty
 * that means the same thing as `laundry`. That is a cosmetic duplicate — a
 * custom duty is a label with no minutes behind it, so a second copy of
 * "laundry" cannot make any number wrong; the worst case is one redundant row
 * on a screen. `RESERVED_ROOM_TYPE_KEYS` above deliberately does NOT accept the
 * same gap, because a custom room type carries a minute count that competes
 * with `checkoutMinutes`. Revisit this list only if custom duties ever gain a
 * minutes model — at that point the harm becomes the same and so must the fix.
 */
export const RESERVED_DUTY_KEYS: readonly string[] = SIDE_DUTIES.flatMap((d) => [
  d,
  d.replace(/_/g, ' '),
]);

/**
 * Does this label contain a control character?
 *
 * Not paranoia: a NUL byte inside a JSON string is rejected outright by
 * Postgres ("unsupported Unicode escape sequence"), so one stray invisible
 * byte pasted in from a spreadsheet would fail the entire save with an error
 * no manager could act on. Tab / newline / return are already collapsed into
 * spaces by `normalizeCustomLabel` before this runs, so anything still caught
 * here is genuinely junk.
 *
 * Written as a code-point scan rather than a regex literal so the source file
 * itself never has to contain a control character.
 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/** 'HH:MM' on a 24-hour clock. Strict two-digit hour: '8:00' is rejected. */
const SHIFT_START_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ──────────────────────── Membership helpers ───────────────────── */

function isHkLevel(v: unknown): v is HkLevel {
  return v === 1 || v === 2 || v === 3;
}

function isStatusEntryMethod(v: unknown): v is StatusEntryMethod {
  return typeof v === 'string' && (STATUS_ENTRY_METHODS as readonly string[]).includes(v);
}

function isBoardBuiltBy(v: unknown): v is BoardBuiltBy {
  return typeof v === 'string' && (BOARD_BUILT_BY_OPTIONS as readonly string[]).includes(v);
}

function isInspectionPolicy(v: unknown): v is InspectionPolicy {
  return typeof v === 'string' && (INSPECTION_POLICIES as readonly string[]).includes(v);
}

function isSideDuty(v: unknown): v is SideDuty {
  return typeof v === 'string' && (SIDE_DUTIES as readonly string[]).includes(v);
}

/**
 * Deduplicate and sort side duties into canonical (SIDE_DUTIES) order so two
 * setups holding the same duties always serialize identically. Unknown members
 * are dropped rather than kept — an unrecognised duty has no minutes model
 * behind it, so carrying it forward would only mislead later screens.
 */
function normalizeSideDuties(list: readonly unknown[]): SideDuty[] {
  const seen = new Set<SideDuty>();
  for (const v of list) if (isSideDuty(v)) seen.add(v);
  return SIDE_DUTIES.filter((d) => seen.has(d));
}

/* ──────────────── Custom label helpers (shared with the UI) ─────────────────
 *
 * Exported so the questionnaire can tell a manager "you already have that one"
 * WHILE HE IS TYPING, using the exact comparison the server will use a moment
 * later. If the two ever drifted, the screen would accept an entry the save
 * then refused, with no way for him to work out why.
 */

/**
 * The label as we store it: outer whitespace trimmed, and any run of inner
 * whitespace (including newlines pasted in from a spreadsheet) collapsed to a
 * single space. Nothing else is touched — "King Suite" keeps its capitals,
 * because that is how the hotel writes it and how it will read back to them.
 */
export function normalizeCustomLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

/**
 * The comparison key for one custom label: the stored form, lower-cased.
 *
 * This is what makes de-duplication case-insensitive. "Suite", "suite" and
 * "SUITE" are one room type to a hotel, and storing all three would show the
 * manager three rows he thinks he entered once.
 */
export function customEntryKey(label: string): string {
  return normalizeCustomLabel(label).toLowerCase();
}

/**
 * Is this a storable custom label? Non-empty after normalizing, within the
 * length cap, and free of control characters (see `hasControlChars`).
 */
export function isValidCustomLabel(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const normalized = normalizeCustomLabel(v);
  if (normalized === '' || normalized.length > MAX_CUSTOM_LABEL_LENGTH) return false;
  return !hasControlChars(normalized);
}

/** Does this label collide with one of the two built-in room times? */
export function isReservedRoomTypeLabel(label: string): boolean {
  return RESERVED_ROOM_TYPE_KEYS.includes(customEntryKey(label));
}

/** Does this label collide with one of the five built-in side duties? */
export function isReservedDutyLabel(label: string): boolean {
  return RESERVED_DUTY_KEYS.includes(customEntryKey(label));
}

/**
 * Is this a well-formed custom room type entry? Shape + label + minutes.
 * Minutes reuse `isValidCleanMinutes` deliberately — there is exactly ONE
 * definition of a believable room time in this file, and a custom room type is
 * not a different kind of room.
 */
function isValidCustomRoomTypeShape(v: unknown): v is { label: string; minutes: number } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return isValidCustomLabel(o.label) && isValidCleanMinutes(o.minutes);
}

/**
 * READ-side normalizer for custom room types. Forgiving by contract: anything
 * malformed is DROPPED, never repaired, and this never throws.
 *
 * Why dropped rather than defaulted: the built-in times can fall back to a
 * prefilled default because the questionnaire always collects them, but a
 * custom room type with a made-up minute count would be a number no one at the
 * hotel ever chose, sitting under a name they did choose. Silently inventing
 * that is worse than losing the row — and the row can only be malformed if it
 * was hand-edited or corrupted, since the write path rejects all of this.
 *
 * Also drops entries that collide with a built-in, keeps the FIRST of any
 * case-insensitive duplicate, stops at MAX_CUSTOM_ROOM_TYPES, and sorts by
 * comparison key so two equivalent setups serialize identically (the same
 * guarantee `sideDuties` gets from its canonical order).
 */
function normalizeCustomRoomTypes(list: readonly unknown[]): CustomRoomType[] {
  const out: Array<{ key: string; value: CustomRoomType }> = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (out.length >= MAX_CUSTOM_ROOM_TYPES) break;
    if (!isValidCustomRoomTypeShape(v)) continue;
    const label = normalizeCustomLabel(v.label);
    const key = customEntryKey(label);
    if (seen.has(key) || RESERVED_ROOM_TYPE_KEYS.includes(key)) continue;
    seen.add(key);
    out.push({ key, value: { label, minutes: v.minutes } });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out.map((e) => e.value);
}

/**
 * READ-side normalizer for custom duties. Same contract as
 * `normalizeCustomRoomTypes`: drop anything malformed or colliding, keep the
 * first of a case-insensitive duplicate, cap the count, sort for determinism,
 * never throw.
 */
function normalizeCustomDuties(list: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (out.length >= MAX_CUSTOM_DUTIES) break;
    if (!isValidCustomLabel(v)) continue;
    const label = normalizeCustomLabel(v as string);
    const key = customEntryKey(label);
    if (seen.has(key) || RESERVED_DUTY_KEYS.includes(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.sort((a, b) => {
    const ka = customEntryKey(a);
    const kb = customEntryKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/* ─────────────────────── Shared field validators ─────────────────
 * Exported because the API route validates with exactly these, so a value the
 * questionnaire accepts can never be rejected by the server (or vice versa).
 */

/**
 * A standard room time: a WHOLE number of minutes within [5, 240].
 * `Number.isInteger` rejects NaN, ±Infinity and fractions in one step; string
 * digits ('30') are rejected too, because a string here means the caller never
 * parsed its own form input.
 */
export function isValidCleanMinutes(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_CLEAN_MINUTES && v <= MAX_CLEAN_MINUTES;
}

/** A shift start time: 'HH:MM', 24-hour, zero-padded ('08:00', not '8:00'). */
export function isValidShiftStart(v: unknown): boolean {
  return typeof v === 'string' && SHIFT_START_RE.test(v);
}

/* ──────────────────────────── Level rules ──────────────────────── */

/**
 * Can this hotel be offered this level at all?
 *
 * Levels 1 and 2 are always offerable — they add nothing to any existing
 * employee's job (Level 1 is manager-only; Level 2 replaces the head
 * housekeeper's notebook).
 *
 * Level 3 is NOT offerable when housekeepers already enter room status
 * themselves. Tapping "done" in Staxis would then be the second time the same
 * person records the same fact — double entry, which is the one thing this
 * product must never introduce. See the header.
 */
export function isLevelOfferable(level: HkLevel, statusEntry: StatusEntryMethod): boolean {
  if (level === 3) return statusEntry !== 'housekeeper_direct';
  return true;
}

/**
 * Why a level is locked, as a stable code the UI turns into plain English in
 * both languages. Exists so no screen has to re-derive the rule (and get it
 * subtly wrong) just to explain the padlock.
 *
 * Returns null when the level is offerable.
 */
export function levelLockReason(
  level: HkLevel,
  statusEntry: StatusEntryMethod,
): 'double_entry' | null {
  return isLevelOfferable(level, statusEntry) ? null : 'double_entry';
}

/** The answers the recommendation actually depends on. */
export interface RecommendLevelInput {
  statusEntry: StatusEntryMethod;
  boardBuiltBy: BoardBuiltBy;
}

/**
 * Which level do we pre-select on the final screen?
 *
 * Never make a hotel guess cold — one option is always pre-selected, and they
 * can always override it.
 *
 *   • We NEVER auto-recommend Level 3. Putting the whole crew on phones is a
 *     real change to real people's day; it has to be an opt-in climb from
 *     Level 2 once they trust the product, not something we quietly select for
 *     them on day one. (The offerability check below is therefore belt-and-
 *     braces, but it is kept so the rule survives any future softening here.)
 *   • Level 2 when a head housekeeper already builds the board: she is the
 *     trust gradient — she already keeps the notebook we are replacing, and
 *     she is the person whose edits keep Level 1's per-person numbers honest.
 *   • Level 1 otherwise: it changes nothing for anybody and is always safe.
 */
export function recommendLevel(input: RecommendLevelInput): HkLevel {
  const suggestion: HkLevel = input.boardBuiltBy === 'head_housekeeper' ? 2 : 1;
  // A guard, not decoration: today nothing here can suggest 3, so this never
  // fires. It stays so that if this rule ever grows a branch that does, it
  // cannot recommend a level the hotel is locked out of.
  return isLevelOfferable(suggestion, input.statusEntry) ? suggestion : 1;
}

/* ────────────────────────────── Parsing ────────────────────────── */

/**
 * Read a stored `properties.housekeeping_setup` value.
 *
 * TOTAL and defensive: it never throws, for any input at all — null, a string,
 * an array, wrong-typed fields, unknown enum members, NaN, Infinity, fractional
 * minutes, out-of-range minutes, malformed times, duplicate side duties. Every
 * bad field falls back to a safe default instead of failing, because a single
 * corrupt row must never white-screen the Housekeeping page for a hotel whose
 * staff are standing in a corridor waiting for their board.
 *
 * Returns null only when the value cannot be a setup blob at all (not an
 * object, or an unrecognised schema version). Callers treat null exactly like
 * a NULL column: the questionnaire has not been done.
 *
 * Fallbacks, and why each is the safe direction:
 *   version           unknown number/type -> null (see above)
 *   completedAt       anything not a non-empty string -> null (re-ask, don't
 *                     silently mark a half-finished hotel as done)
 *   statusEntry       unknown -> 'unsure'
 *   level             unknown -> 1  ("Staxis plans it" changes nothing for
 *                     anybody, so it is the safe landing spot)
 *   level             stored but not offerable -> 2 (highest offerable level;
 *                     this is the read-side half of the double-entry lock)
 *   recommendedLevel  unknown -> recomputed from the parsed answers
 *   minutes           invalid -> the prefilled defaults
 *   shiftStartTime    invalid -> '08:00'
 *   boardBuiltBy      unknown -> 'unsure'
 *   inspection        unknown -> 'none'
 *   sideDuties        non-array / unknown members -> dropped; result deduped
 *                     and sorted into canonical order
 *   customRoomTypes   absent -> [] (see below); non-array -> []; malformed,
 *                     over-long, reserved or duplicate entries -> dropped;
 *                     result capped, deduped case-insensitively and sorted
 *   customDuties      same treatment as customRoomTypes
 *   boardPhotoPath    anything not a non-empty string -> null
 *
 * THE MOST IMPORTANT DEFAULT IN THIS FUNCTION is `customRoomTypes` /
 * `customDuties` falling back to `[]` when the key is absent. Every hotel that
 * finished the questionnaire before those fields existed has a stored blob
 * without them. If their absence produced anything other than a complete,
 * empty list — a null, or a null return — those hotels would be handed back
 * into the seven-screen questionnaire they already answered. That is also why
 * `version` stayed at 1; see the comment on `HousekeepingSetup.version`.
 */
export function parseHousekeepingSetup(raw: unknown): HousekeepingSetup | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // A blob written by a future schema version is not something this code can
  // safely interpret, and guessing would be worse than re-asking six short
  // questions. Missing version is treated as 1 (the only version that exists).
  if (obj.version !== undefined && obj.version !== 1) return null;

  const statusEntry: StatusEntryMethod = isStatusEntryMethod(obj.statusEntry)
    ? obj.statusEntry
    : 'unsure';
  const boardBuiltBy: BoardBuiltBy = isBoardBuiltBy(obj.boardBuiltBy) ? obj.boardBuiltBy : 'unsure';

  // Level: fall back to 1, then clamp anything the hotel is not allowed to be
  // on. A stored level 3 on a 'housekeeper_direct' hotel can only come from a
  // corrupt row, a hand-edit, or an answer changed after the fact — in every
  // case leaving it at 3 would put housekeepers into double entry.
  let level: HkLevel = isHkLevel(obj.level) ? obj.level : 1;
  if (!isLevelOfferable(level, statusEntry)) level = 2;

  const recommendedLevel: HkLevel = isHkLevel(obj.recommendedLevel)
    ? obj.recommendedLevel
    : recommendLevel({ statusEntry, boardBuiltBy });

  const completedAt =
    typeof obj.completedAt === 'string' && obj.completedAt.trim() !== '' ? obj.completedAt : null;

  const boardPhotoPath =
    typeof obj.boardPhotoPath === 'string' && obj.boardPhotoPath.trim() !== ''
      ? obj.boardPhotoPath
      : null;

  return {
    version: 1,
    completedAt,
    level,
    recommendedLevel,
    statusEntry,
    checkoutMinutes: isValidCleanMinutes(obj.checkoutMinutes)
      ? (obj.checkoutMinutes as number)
      : DEFAULT_CHECKOUT_MINUTES,
    stayoverMinutes: isValidCleanMinutes(obj.stayoverMinutes)
      ? (obj.stayoverMinutes as number)
      : DEFAULT_STAYOVER_MINUTES,
    shiftStartTime: isValidShiftStart(obj.shiftStartTime)
      ? (obj.shiftStartTime as string)
      : DEFAULT_SHIFT_START,
    boardBuiltBy,
    inspection: isInspectionPolicy(obj.inspection) ? obj.inspection : 'none',
    sideDuties: Array.isArray(obj.sideDuties) ? normalizeSideDuties(obj.sideDuties) : [],
    // Absent (every record written before these fields existed) and non-array
    // (corrupt) both land on the same empty list — a complete answer meaning
    // "they added none", never a hole a later screen has to null-check.
    customRoomTypes: Array.isArray(obj.customRoomTypes)
      ? normalizeCustomRoomTypes(obj.customRoomTypes)
      : [],
    customDuties: Array.isArray(obj.customDuties) ? normalizeCustomDuties(obj.customDuties) : [],
    boardPhotoPath,
  };
}

/**
 * Has this hotel finished the questionnaire?
 *
 * The gate in front of the whole Housekeeping section. True only when the value
 * parses AND carries a non-empty `completedAt`. Anything else — NULL column,
 * junk, a half-written blob — means "ask the six questions", which is always
 * recoverable. The opposite mistake (deciding a hotel is set up when it isn't)
 * would leave them on defaults they never agreed to, silently driving the
 * labor-cost numbers.
 */
export function isHousekeepingSetupComplete(raw: unknown): boolean {
  const parsed = parseHousekeepingSetup(raw);
  return parsed !== null && typeof parsed.completedAt === 'string' && parsed.completedAt !== '';
}

/* ──────────────────────────── Submission ───────────────────────── */

/** Result of `validateSetupSubmission`: a ready-to-persist value, or a reason. */
export type SetupSubmissionResult = { value: HousekeepingSetup } | { error: string };

/**
 * Validate a questionnaire submission on its way INTO the database.
 *
 * STRICT, unlike `parseHousekeepingSetup`. Reading is forgiving because the
 * page must render whatever is already stored; writing is not, because this is
 * the moment a wrong value becomes the thing every later screen and every
 * labor-cost number trusts. Bad answers are rejected with a message naming the
 * field, never coerced into a plausible-looking default.
 *
 * Required (rejected if missing or wrong): statusEntry, checkoutMinutes,
 * stayoverMinutes, shiftStartTime, boardBuiltBy, inspection, level.
 * Filled in when omitted (but rejected if present and wrong): version,
 * recommendedLevel (recomputed), sideDuties (empty = rooms only),
 * customRoomTypes / customDuties (empty = they added none), boardPhotoPath
 * (null = photo skipped), completedAt (stamped now).
 *
 * The load-bearing check is the last one: a submission choosing a level that
 * `isLevelOfferable` says is locked is REJECTED. That is a real consistency
 * boundary, not UI polish — the browser can send anything, and accepting a
 * level-3 submission from a hotel whose housekeepers already enter status
 * themselves would put those housekeepers into double entry.
 *
 * On success the returned object is safe to persist verbatim: it is fully
 * normalized (side duties deduped and sorted, `completedAt` stamped), so the
 * route does not need to post-process it.
 */
export function validateSetupSubmission(raw: unknown): SetupSubmissionResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Setup must be an object' };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== undefined && obj.version !== 1) {
    return { error: 'version must be 1' };
  }

  if (!isStatusEntryMethod(obj.statusEntry)) {
    return { error: `statusEntry must be one of: ${STATUS_ENTRY_METHODS.join(', ')}` };
  }
  const statusEntry: StatusEntryMethod = obj.statusEntry;

  if (!isValidCleanMinutes(obj.checkoutMinutes)) {
    return {
      error: `checkoutMinutes must be a whole number between ${MIN_CLEAN_MINUTES} and ${MAX_CLEAN_MINUTES}`,
    };
  }
  if (!isValidCleanMinutes(obj.stayoverMinutes)) {
    return {
      error: `stayoverMinutes must be a whole number between ${MIN_CLEAN_MINUTES} and ${MAX_CLEAN_MINUTES}`,
    };
  }

  if (!isValidShiftStart(obj.shiftStartTime)) {
    return { error: 'shiftStartTime must be a 24-hour time like 08:00' };
  }

  if (!isBoardBuiltBy(obj.boardBuiltBy)) {
    return { error: `boardBuiltBy must be one of: ${BOARD_BUILT_BY_OPTIONS.join(', ')}` };
  }
  const boardBuiltBy: BoardBuiltBy = obj.boardBuiltBy;

  if (!isInspectionPolicy(obj.inspection)) {
    return { error: `inspection must be one of: ${INSPECTION_POLICIES.join(', ')}` };
  }
  const inspection: InspectionPolicy = obj.inspection;

  // Side duties: absent means "rooms only". Present means it must be a clean
  // array of known duties — an unknown duty is a client/server mismatch, and
  // silently dropping it would hide the bug until the minutes stopped adding up.
  let sideDuties: SideDuty[] = [];
  if (obj.sideDuties !== undefined && obj.sideDuties !== null) {
    if (!Array.isArray(obj.sideDuties)) {
      return { error: 'sideDuties must be an array' };
    }
    for (const d of obj.sideDuties) {
      if (!isSideDuty(d)) {
        return { error: `sideDuties contains an unknown duty: ${String(d)}` };
      }
    }
    sideDuties = normalizeSideDuties(obj.sideDuties);
  }

  // ── The two "+" lists ────────────────────────────────────────────────────
  // Absent/null means "they added none", which is the normal case and the case
  // for every submission written before these fields existed.
  //
  // WRITE-SIDE RULE, and why it differs from `sideDuties` above: a repeated
  // side duty is lossless (the second 'laundry' says nothing the first didn't),
  // so folding it is safe. A repeated CUSTOM entry is not — "Suite 45" and
  // "suite 60" are two different numbers under one name, and quietly keeping
  // one of them would hand the hotel a room time nobody chose. So duplicates
  // are REFUSED here, with the offending label in the message. Same for a label
  // that collides with something the questionnaire already asks about: folding
  // it into the built-in would be Staxis ticking a box the manager didn't tick,
  // and dropping it would lose a duty the hotel really does. Both are one tap
  // for him to fix once we say which word is the problem; neither is something
  // we should decide on his behalf.
  //
  // `parseHousekeepingSetup` resolves every one of these conditions silently
  // instead, because reading must never fail. Strict in, forgiving out.
  const customRoomTypes = validateCustomRoomTypes(obj.customRoomTypes);
  if ('error' in customRoomTypes) return { error: customRoomTypes.error };

  const customDuties = validateCustomDuties(obj.customDuties);
  if ('error' in customDuties) return { error: customDuties.error };

  // Board photo: skipping is always allowed, so null/absent/'' all mean "no
  // photo". A non-string is a real client bug and is rejected.
  let boardPhotoPath: string | null = null;
  if (obj.boardPhotoPath !== undefined && obj.boardPhotoPath !== null) {
    if (typeof obj.boardPhotoPath !== 'string') {
      return { error: 'boardPhotoPath must be a string or null' };
    }
    const trimmed = obj.boardPhotoPath.trim();
    if (trimmed.length > MAX_BOARD_PHOTO_PATH) {
      return { error: `boardPhotoPath must be at most ${MAX_BOARD_PHOTO_PATH} characters` };
    }
    boardPhotoPath = trimmed === '' ? null : trimmed;
  }

  if (!isHkLevel(obj.level)) {
    return { error: 'level must be 1, 2 or 3' };
  }
  const level: HkLevel = obj.level;

  if (obj.recommendedLevel !== undefined && !isHkLevel(obj.recommendedLevel)) {
    return { error: 'recommendedLevel must be 1, 2 or 3' };
  }
  const recommendedLevel: HkLevel = isHkLevel(obj.recommendedLevel)
    ? obj.recommendedLevel
    : recommendLevel({ statusEntry, boardBuiltBy });

  // THE boundary. See the doc comment and the module header.
  if (!isLevelOfferable(level, statusEntry)) {
    return {
      error:
        'level 3 is not available when housekeepers already enter room status themselves. It would mean entering the same room twice',
    };
  }

  // `completedAt`: a submission IS the act of finishing, so it is stamped here
  // unless the caller supplies its own timestamp (which tests do, to stay
  // deterministic). A present-but-unparseable value is rejected rather than
  // quietly replaced — a bad timestamp usually means a bad client.
  let completedAt: string;
  if (obj.completedAt === undefined || obj.completedAt === null) {
    completedAt = new Date().toISOString();
  } else if (
    typeof obj.completedAt === 'string' &&
    obj.completedAt.trim() !== '' &&
    !Number.isNaN(Date.parse(obj.completedAt))
  ) {
    completedAt = obj.completedAt;
  } else {
    return { error: 'completedAt must be an ISO date string' };
  }

  return {
    value: {
      version: 1,
      completedAt,
      level,
      recommendedLevel,
      statusEntry,
      checkoutMinutes: obj.checkoutMinutes as number,
      stayoverMinutes: obj.stayoverMinutes as number,
      shiftStartTime: obj.shiftStartTime as string,
      boardBuiltBy,
      inspection,
      sideDuties,
      customRoomTypes: customRoomTypes.value,
      customDuties: customDuties.value,
      boardPhotoPath,
    },
  };
}

/* ──────────── Strict validators for the two "+" lists ────────────
 * Split out only because inlining two ~35-line blocks would have buried the
 * level check that `validateSetupSubmission` exists to perform. Same contract
 * as the rest of that function: a message naming the field, never a coercion.
 */

type CustomListResult<T> = { value: T[] } | { error: string };

function validateCustomRoomTypes(raw: unknown): CustomListResult<CustomRoomType> {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'customRoomTypes must be an array' };
  if (raw.length > MAX_CUSTOM_ROOM_TYPES) {
    return { error: `customRoomTypes can hold at most ${MAX_CUSTOM_ROOM_TYPES} room types` };
  }

  const out: Array<{ key: string; value: CustomRoomType }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { error: `customRoomTypes[${i}] must be an object with a label and minutes` };
    }
    const o = entry as Record<string, unknown>;

    if (typeof o.label !== 'string') {
      return { error: `customRoomTypes[${i}].label must be text` };
    }
    if (!isValidCustomLabel(o.label)) {
      return {
        error: `customRoomTypes[${i}].label must be 1 to ${MAX_CUSTOM_LABEL_LENGTH} characters of plain text`,
      };
    }
    const label = normalizeCustomLabel(o.label);

    // Reuses the built-ins' rule on purpose — one definition of a believable
    // room time, so a custom room can never be validated more loosely than
    // "checkout" was three fields ago.
    if (!isValidCleanMinutes(o.minutes)) {
      return {
        error: `customRoomTypes[${i}].minutes ("${label}") must be a whole number between ${MIN_CLEAN_MINUTES} and ${MAX_CLEAN_MINUTES}`,
      };
    }

    const key = customEntryKey(label);
    if (RESERVED_ROOM_TYPE_KEYS.includes(key)) {
      return {
        error: `customRoomTypes cannot use "${label}". Checkout and stayover rooms already have their own times above`,
      };
    }
    if (seen.has(key)) {
      return { error: `customRoomTypes lists "${label}" twice. Each room type needs its own name` };
    }
    seen.add(key);
    out.push({ key, value: { label, minutes: o.minutes as number } });
  }

  // Same deterministic order the reader produces, so a value returned from here
  // round-trips through `parseHousekeepingSetup` unchanged.
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { value: out.map((e) => e.value) };
}

function validateCustomDuties(raw: unknown): CustomListResult<string> {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'customDuties must be an array' };
  if (raw.length > MAX_CUSTOM_DUTIES) {
    return { error: `customDuties can hold at most ${MAX_CUSTOM_DUTIES} extra duties` };
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== 'string') {
      return { error: `customDuties[${i}] must be text` };
    }
    if (!isValidCustomLabel(entry)) {
      return {
        error: `customDuties[${i}] must be 1 to ${MAX_CUSTOM_LABEL_LENGTH} characters of plain text`,
      };
    }
    const label = normalizeCustomLabel(entry);
    const key = customEntryKey(label);
    if (RESERVED_DUTY_KEYS.includes(key)) {
      return { error: `customDuties cannot use "${label}". It is already one of the choices above` };
    }
    if (seen.has(key)) {
      return { error: `customDuties lists "${label}" twice` };
    }
    seen.add(key);
    out.push(label);
  }

  return {
    value: out.sort((a, b) => {
      const ka = customEntryKey(a);
      const kb = customEntryKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }),
  };
}
