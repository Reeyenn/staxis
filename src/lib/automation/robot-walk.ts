/**
 * The nightly robot walkthrough — the contract shared by everything that
 * touches it.
 *
 * WHAT THE ROBOT IS. Every night a browser signs into the REAL live site as a
 * manager at a dedicated seeded test hotel and does what a person does, step by
 * step: opens the list, writes a to-do, assigns it, ticks it off, opens the log
 * book, teaches the companion a fact, asks it a question, adds and deletes an
 * inventory item, looks at the roster, signs out. It runs on GitHub Actions
 * (`.github/workflows/robot-walk.yml`) because a real browser is not something
 * a serverless function can be trusted to hold open, and it reports back to
 * `/api/admin/robot-walk/report`.
 *
 * WHY IT EXISTS. Every other health check in this product asks the database
 * whether the data looks right. A broken sign-in, a composer that stopped
 * submitting, a page that renders empty for a signed-in manager: none of those
 * disturb a single row, and every existing check reports green through all of
 * them. This is the only signal that fails when the PRODUCT fails.
 *
 * WHERE THE ANSWER SHOWS UP. Two places, and the split is the founder's rule
 * that jobs are invisible when healthy:
 *   - a green run writes a heartbeat, so the robot is one calm "on time" row in
 *     Mission Control's Automatic AI jobs list and nothing else,
 *   - a failed step writes an `error_logs` row whose source is
 *     ROBOT_WALK_ERROR_SOURCE, which is what Mission Control's "Recent errors"
 *     box reads. The step's name is in the message, because "something broke"
 *     is not a thing anybody can act on.
 *
 * This module is the single place all of that is written down, so the runner,
 * the route, the doctor check and the tests cannot drift apart. It imports
 * nothing: the runner runs on a bare GitHub runner with no Supabase client and
 * no Next.js around it.
 */

/** `error_logs.source` for every failure the robot reports. */
export const ROBOT_WALK_ERROR_SOURCE = 'robot-walk';

/** `cron_heartbeats.cron_name`, and the job catalog id. */
export const ROBOT_WALK_HEARTBEAT = 'robot-walk';

/**
 * Every artifact the robot creates is named with this prefix, so the cleanup
 * pass can tell its own litter from a person's real work with certainty rather
 * than by guessing at timestamps. Nothing without this prefix is ever deleted.
 */
export const ROBOT_WALK_MARKER = 'Robot check:';

/**
 * Exact sentences the browser types into the hotel's to-do composer.
 *
 * The composer reads cadence words such as "nightly". The old walkthrough
 * sentence therefore created a daily recurring template (and returned a
 * template id) instead of a one-off task row. Keep the robot's own sentences
 * here, beside the contract that tests them through the real parser, so a
 * future wording change cannot silently turn a create step back into a rule.
 */
export const ROBOT_WALK_TODO_TITLE = `${ROBOT_WALK_MARKER} walkthrough`;
export const ROBOT_WALK_ASSIGNED_TODO_TITLE = `${ROBOT_WALK_MARKER} handover`;
export const ROBOT_WALK_FACT_TEXT = `${ROBOT_WALK_MARKER} the supply closet is on floor 2.`;
export const ROBOT_WALK_ITEM_NAME = `${ROBOT_WALK_MARKER} spare bulbs`;

/** Every sentence the robot types into the parsed composer surface. */
export const ROBOT_WALK_COMPOSER_STRINGS: readonly string[] = [
  ROBOT_WALK_TODO_TITLE,
  ROBOT_WALK_ASSIGNED_TODO_TITLE,
];

/**
 * How stale the last run may get before the doctor says so. The walk is nightly
 * (24h), and 26 gives a two-hour grace for a slow runner or a queued job, so a
 * single late start is not an alert while a genuinely stopped robot is caught
 * inside a day.
 */
export const ROBOT_WALK_FRESH_HOURS = 26;

/** How long a run row is kept. Swept by the report route; there is no cron. */
export const ROBOT_WALK_RETENTION_DAYS = 90;

/**
 * The walk, in order.
 *
 * Names are the plain-English sentence the founder reads in "Recent errors"
 * when one of them fails, so they are written as the thing a person does and
 * not as the thing the code calls. `dependsOn` is what keeps one broken step
 * from turning into a screenful of red: a step whose prerequisite failed is
 * recorded as not-run, and only the step that ACTUALLY broke is reported.
 */
export interface RobotWalkStepSpec {
  /** Stable id used in code and in the stored run row. */
  id: string;
  /** What the founder sees. One short sentence, no jargon. */
  label: string;
  /** Ids of steps this one cannot be attempted without. */
  dependsOn?: readonly string[];
}

export const ROBOT_WALK_STEPS: readonly RobotWalkStepSpec[] = [
  { id: 'sign-in', label: 'sign in' },
  { id: 'staxis-list', label: 'open the hotel list', dependsOn: ['sign-in'] },
  { id: 'add-todo', label: 'add a to-do', dependsOn: ['staxis-list'] },
  { id: 'assign-todo', label: 'assign the to-do to somebody', dependsOn: ['add-todo'] },
  { id: 'complete-todo', label: 'mark the to-do done', dependsOn: ['add-todo'] },
  { id: 'log-book', label: 'open the log book', dependsOn: ['staxis-list'] },
  { id: 'teach-fact', label: 'teach the companion a fact', dependsOn: ['sign-in'] },
  { id: 'forget-fact', label: 'remove the fact again', dependsOn: ['teach-fact'] },
  { id: 'ask-companion', label: 'ask the companion a question', dependsOn: ['sign-in'] },
  { id: 'add-item', label: 'add an inventory item', dependsOn: ['sign-in'] },
  { id: 'delete-item', label: 'delete the inventory item', dependsOn: ['add-item'] },
  { id: 'people-roster', label: 'open the staff list', dependsOn: ['sign-in'] },
  { id: 'anchor-census', label: 'find the buttons the companion points at', dependsOn: ['sign-in'] },
  { id: 'sign-out', label: 'sign out' },
];

// ═══════════════════════════════════════════════════════════════════════════
// The anchor census — the drift protection for everything that points.
//
// ─── THE FAILURE THIS EXISTS TO CATCH ──────────────────────────────────────
//
// The companion locates every control it points at by one attribute:
// `data-staxis-anchor="<key>"`. The tour walks those keys, the chat pointer
// draws at them when somebody asks where something is, and the discovery
// pointer uses them for its one tip per screen. All three fail the SAME way
// and it is the quietest failure in the product: somebody refactors a toolbar,
// the attribute does not ride along, and from then on the companion says "it
// is this one" and draws nothing. Nobody notices, because the person who was
// lost enough to ask is not the person who knows what should have happened.
//
// No test catches it. A unit test asserting the attribute is in a component's
// source is the exact kind of grep-the-file test this codebase does not write,
// and it would pass on a control that no longer renders. The only honest check
// is to open the real page in a real browser and look, which is a thing the
// nightly robot already does every night on the real deploy.
//
// ─── WHY THE LOCATION IS A MAP AND NOT THE REGISTRY'S `page` ───────────────
//
// An anchor's `page` is the companion's own vocabulary and answers "may I draw
// here". It is deliberately coarse: `knows-teach` lives on page `staxis`
// because the Knows view is a dialog over /feed and that is the page proof the
// pointer will get. A census needs the finer fact, which is the URL a browser
// must actually be at for the control to be rendered, and those are different
// for anything behind a tab.
//
// So this is a second list, and the thing that stops a second list from
// drifting is a test: `companion-tour-registry.test.ts` asserts that every key
// in the anchor registry appears here, so adding an anchor without saying where
// to find it fails the suite rather than the census.
//
// `null` means DELIBERATELY NOT ASSERTED, with the reason beside it. A census
// that asserted an entitlement-gated control would be testing what the robot
// account is allowed to see rather than whether the attribute survived, and it
// would go red the day somebody adjusted a capability.
// ═══════════════════════════════════════════════════════════════════════════

export const ANCHOR_CENSUS_LOCATIONS: Readonly<Record<string, string | null>> = {
  // The one-list, and the app chrome that is on every screen with it.
  'todo-composer': '/feed',
  'staxis-mark': '/feed',
  'nav-staxis': '/feed',
  'nav-dashboard': '/feed',
  'nav-inventory': '/feed',
  'nav-maintenance': '/feed',
  'nav-communications': '/feed',
  // Behind the Knows tab, which is a dialog over the same path.
  'knows-teach': '/feed?tab=knows',
  // The delivery scanner on the stockroom rail. Rendered under `canManage`,
  // which the robot manager proves two steps earlier by adding and deleting a
  // real item on this same screen.
  'add-delivery': '/inventory',
  // NOT ASSERTED. The importer additionally needs the money capability, and
  // the robot account never exercises financials, so a census that required it
  // would be asserting an entitlement rather than a mount.
  'inventory-import': null,
};

/** The pages a census has to open, each once, in a stable order. */
export function anchorCensusPages(
  locations: Readonly<Record<string, string | null>> = ANCHOR_CENSUS_LOCATIONS,
): string[] {
  const seen: string[] = [];
  for (const url of Object.values(locations)) {
    if (url !== null && !seen.includes(url)) seen.push(url);
  }
  return seen;
}

/** The keys that must be in the DOM at one url. */
export function anchorsExpectedAt(
  url: string,
  locations: Readonly<Record<string, string | null>> = ANCHOR_CENSUS_LOCATIONS,
): string[] {
  return Object.entries(locations)
    .filter(([, at]) => at === url)
    .map(([key]) => key)
    .sort();
}

/**
 * The sentence a failed census puts in front of the founder.
 *
 * Names the anchors, not the pages: "the companion cannot find X" is the fact,
 * and which URL it was looking at is detail for the stack. The message itself
 * is FIXED (see robotWalkFailureMessage) because Recent errors groups by it;
 * this is the DETAIL half, which is allowed to vary.
 */
export function anchorCensusDetail(missing: readonly string[]): string {
  return `The companion can no longer find these controls on the page: ${[...missing].sort().join(', ')}. `
    + 'Something they were attached to was renamed or removed, so pointing at them now draws nothing.';
}

export const ROBOT_WALK_STEP_IDS: readonly string[] = ROBOT_WALK_STEPS.map((s) => s.id);

export function robotWalkStepLabel(id: string): string {
  return ROBOT_WALK_STEPS.find((s) => s.id === id)?.label ?? id;
}

/** One step's outcome, exactly as it is stored in `robot_walk_runs.steps`. */
export interface RobotWalkStepResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  /**
   * True when the step was never attempted because something it depends on
   * failed. Still `ok: false` (it did not pass, and pretending otherwise would
   * make a broken run look partly fine), but deliberately NOT reported to
   * "Recent errors" — one broken step should produce one entry naming it, not
   * a cascade naming its innocent neighbours.
   */
  skipped?: boolean;
}

/** The body the runner POSTs to /api/admin/robot-walk/report. */
export interface RobotWalkReportBody {
  startedAt: string;
  finishedAt: string;
  steps: RobotWalkStepResult[];
  workflowRunUrl?: string | null;
}

export interface RobotWalkSummary {
  total: number;
  passed: number;
  ok: boolean;
  /** Steps that actually broke. Excludes the ones skipped in their wake. */
  failed: RobotWalkStepResult[];
  /** Steps never attempted because a prerequisite failed. */
  skipped: RobotWalkStepResult[];
}

export function summarizeRobotWalk(steps: readonly RobotWalkStepResult[]): RobotWalkSummary {
  const passed = steps.filter((s) => s.ok).length;
  return {
    total: steps.length,
    passed,
    // A run with no steps at all is NOT a pass. That shape is what a runner
    // crashing before its first click produces, and reading it as green would
    // make the quietest possible failure the most reassuring one.
    ok: steps.length > 0 && passed === steps.length,
    failed: steps.filter((s) => !s.ok && s.skipped !== true),
    skipped: steps.filter((s) => s.skipped === true),
  };
}

// ─── What the composer is allowed to say back ────────────────────────────────

/**
 * Did the composer accept the person the robot just picked?
 *
 * THIS EXISTS BECAUSE THE OBVIOUS TEST WAS WRONG AND WAS RED EVERY NIGHT. The
 * walk used to assert that the Who button's accessible name CONTAINED the full
 * name it had just clicked, e.g. "Robot Manager". It never can: `whoWord` in
 * src/lib/feed/one-list-copy.ts renders a person as their FIRST NAME only, on
 * purpose, because the row is a sentence and nobody says "for Marcus Webb" out
 * loud. So the label reads "Who: for Robot", the assertion failed, and the one
 * check in this product that is supposed to fail when the PRODUCT fails
 * reported a failure that had nothing to do with the product.
 *
 * The cost of that was not one red row. The heartbeat lands only on a night
 * where every step passed, so a permanently failing step means the robot can
 * never read "on time" in Mission Control, and the founder's "Recent errors"
 * box carries a standing entry that is not true. A box with a permanent false
 * entry in it is a box nobody reads.
 *
 * The rule is therefore written down once, here, beside the walk it governs,
 * and its test walks the REAL producer rather than restating it: whatever
 * `whoWord` puts on that button for a person, this has to accept.
 */
export function composerNamesAssignee(
  ariaLabel: string | null | undefined,
  assigneeName: string,
): boolean {
  if (typeof ariaLabel !== 'string' || ariaLabel.trim() === '') return false;
  const first = assigneeName.trim().split(/\s+/)[0] ?? '';
  if (first === '') return false;
  // A word boundary rather than a bare substring: "for Roberta" must not be
  // read as proof that "Rob Smith" was the one picked.
  const rx = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeForRegExp(first)}([^\\p{L}\\p{N}]|$)`,
    'iu',
  );
  return rx.test(ariaLabel);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The sentence that lands in Mission Control's "Recent errors" box.
 *
 * Grouping there is by (source, message), so the message must NOT carry
 * anything that changes between nights — no timestamps, no ids, no durations.
 * A step that has been broken for a week should read "7x", not seven separate
 * rows nobody can count.
 */
export function robotWalkFailureMessage(step: RobotWalkStepResult): string {
  return `Nightly robot walkthrough could not ${robotWalkStepLabel(step.name)}.`;
}

/** The detail behind the row, shown when the founder clicks it open. */
export function robotWalkFailureDetail(step: RobotWalkStepResult): string {
  const reason = (step.error ?? '').trim();
  return reason.length > 0 ? reason : 'The step failed without saying why.';
}

// ─── Running the walk ────────────────────────────────────────────────────────

/** One step the driver knows how to perform. */
export interface RobotWalkStep {
  /** Must be one of ROBOT_WALK_STEPS. */
  id: string;
  /** Throws on failure. Returning is passing. */
  run: () => Promise<void>;
}

export interface RunRobotWalkOptions {
  /** Injectable clock so the runner's timing is testable. */
  now?: () => number;
  /** Called once per step that actually broke, before the walk moves on. */
  onFailure?: (id: string, error: unknown) => void | Promise<void>;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Walk the steps, and keep walking.
 *
 * THE WHOLE POINT IS THAT ONE BROKEN STEP DOES NOT END THE NIGHT. A walk that
 * stops at the first failure reports one problem and hides every other one, so
 * fixing the first buys you another night to find the second. Every step that
 * CAN still be attempted is attempted.
 *
 * "Can still be attempted" is the other half. There is no point clicking Done on
 * a to-do that was never created, and doing it anyway produces a second red row
 * blaming a step that is fine. So a step whose prerequisite failed is recorded
 * as not-run rather than as broken, and only the step that actually broke is
 * reported to the founder.
 */
export async function runRobotWalk(
  steps: readonly RobotWalkStep[],
  opts: RunRobotWalkOptions = {},
): Promise<RobotWalkStepResult[]> {
  const now = opts.now ?? (() => Date.now());
  const results: RobotWalkStepResult[] = [];
  const broken = new Set<string>();

  for (const step of steps) {
    const spec = ROBOT_WALK_STEPS.find((s) => s.id === step.id);
    const blockedBy = (spec?.dependsOn ?? []).filter((dep) => broken.has(dep));

    if (blockedBy.length > 0) {
      broken.add(step.id);
      results.push({
        name: step.id,
        ok: false,
        ms: 0,
        skipped: true,
        error: `Not attempted: could not ${blockedBy.map(robotWalkStepLabel).join(', ')}.`,
      });
      continue;
    }

    const startedAt = now();
    try {
      await step.run();
      results.push({ name: step.id, ok: true, ms: Math.max(0, now() - startedAt) });
    } catch (err) {
      broken.add(step.id);
      results.push({
        name: step.id,
        ok: false,
        ms: Math.max(0, now() - startedAt),
        error: errorText(err),
      });
      // A failing hook must not take down the walk it is only observing. This
      // is where a screenshot is taken, and a screenshot failing on a headless
      // runner is the least interesting thing that can go wrong tonight.
      try { await opts.onFailure?.(step.id, err); } catch { /* observer only */ }
    }
  }

  return results;
}

/**
 * Is this a thing the robot made, and may therefore delete?
 *
 * THE ONLY GATE ON EVERY DESTRUCTIVE ACTION THE ROBOT TAKES. It walks a real
 * hotel in the real production app, and the difference between tidying up after
 * itself and deleting somebody's work is this function returning false. It is
 * deliberately a plain prefix test on the visible text, with no fuzzy matching,
 * no timestamps and no "probably ours" heuristics: anything it is not certain
 * about, it leaves alone forever.
 */
export function isRobotWalkArtifact(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim().startsWith(ROBOT_WALK_MARKER);
}

// ─── Parsing what the runner sent ────────────────────────────────────────────

/** Longest single step error the route will store. */
export const ROBOT_WALK_ERROR_MAX = 2_000;
/** More steps than this is a runaway runner, not a walkthrough. */
export const ROBOT_WALK_MAX_STEPS = 100;

export interface ParsedRobotWalkReport {
  error?: string;
  value?: RobotWalkReportBody;
}

const ISO_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !ISO_RX.test(v)) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * Turn whatever the runner POSTed into a report, or say exactly what is wrong
 * with it.
 *
 * Pure, and separate from the route, because the interesting failures here are
 * shapes rather than HTTP: a run with no steps (a runner that crashed before
 * its first click), a finish time before the start time (a clock bug that would
 * poison every duration derived from the table), a step with no name (an error
 * row in Mission Control that names nothing).
 */
export function parseRobotWalkReport(raw: unknown): ParsedRobotWalkReport {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'body must be an object' };
  }
  const body = raw as Record<string, unknown>;

  const startedAt = isoOrNull(body.startedAt);
  if (!startedAt) return { error: 'startedAt must be an ISO timestamp' };
  const finishedAt = isoOrNull(body.finishedAt);
  if (!finishedAt) return { error: 'finishedAt must be an ISO timestamp' };
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    return { error: 'finishedAt cannot be before startedAt' };
  }

  if (!Array.isArray(body.steps)) return { error: 'steps must be an array' };
  // An empty array is accepted and stored. It is a real thing that happens —
  // the runner died before its first step — and the honest record of that is a
  // run with nothing in it, which summarizeRobotWalk() reads as NOT ok. What
  // must never happen is it being dropped for being malformed, because then the
  // loudest possible failure leaves the quietest possible trace.
  if (body.steps.length > ROBOT_WALK_MAX_STEPS) {
    return { error: `steps too large (max ${ROBOT_WALK_MAX_STEPS})` };
  }

  const steps: RobotWalkStepResult[] = [];
  for (const [i, entry] of body.steps.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `steps[${i}] must be an object` };
    }
    const s = entry as Record<string, unknown>;
    if (typeof s.name !== 'string' || s.name.trim() === '') {
      return { error: `steps[${i}].name must be a non-empty string` };
    }
    if (typeof s.ok !== 'boolean') return { error: `steps[${i}].ok must be a boolean` };
    const ms = typeof s.ms === 'number' && Number.isFinite(s.ms) && s.ms >= 0 ? Math.round(s.ms) : 0;
    const step: RobotWalkStepResult = { name: s.name.trim(), ok: s.ok, ms };
    if (typeof s.error === 'string' && s.error.trim() !== '') {
      step.error = s.error.trim().slice(0, ROBOT_WALK_ERROR_MAX);
    }
    if (s.skipped === true) step.skipped = true;
    steps.push(step);
  }

  // A URL and nothing else. This string ends up in a stored row an operator
  // clicks, so anything that is not an https link to a run is dropped rather
  // than stored and rendered.
  let workflowRunUrl: string | null = null;
  if (typeof body.workflowRunUrl === 'string' && body.workflowRunUrl.startsWith('https://')) {
    workflowRunUrl = body.workflowRunUrl.slice(0, 500);
  }

  return { value: { startedAt, finishedAt, steps, workflowRunUrl } };
}
