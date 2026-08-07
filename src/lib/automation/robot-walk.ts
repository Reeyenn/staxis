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
 * The exact words the robot types, in the exact places it types them.
 *
 * ─── WHY THESE ARE HERE AND NOT IN THE SCRIPT ──────────────────────────────
 *
 * The first live run failed on `Robot check: nightly walkthrough`, and the
 * reason is worth keeping written down because nothing about it looked like a
 * bug from either side.
 *
 * The composer READS the sentence. "nightly" is a cadence, so it filed the
 * to-do as a REPEATING one — and a repeating to-do is not a to-do. It is a
 * rule: `/api/comms/tasks` writes a row to `recurring_task_templates`, returns
 * a template id, and creates nothing on anybody's list. The first actual to-do
 * appears whenever the recurring sweep next runs. So the row the walk was
 * waiting for could not have appeared inside its twenty seconds, or inside
 * twenty minutes, and no longer wait would ever have fixed it.
 *
 * That is the product working exactly as intended. Somebody who types "nightly"
 * is asking for a repeating job and gets one. It is the ROBOT's sentence that
 * was wrong, and the only way to know a sentence is safe is to run it through
 * the same parser the composer uses — which is what
 * `robot-walk-composer-strings.test.ts` does with this list.
 *
 * (The title itself was never the problem, which is worth recording because it
 * is the obvious suspect: the parser tidies its own copy for the chips, but the
 * composer sends the sentence exactly as typed. The stored title was the full
 * one. The cadence was the whole of it.)
 *
 * Anything added here must survive `parseTodo` untouched: same title, no
 * assignee lifted, no date lifted, no cadence lifted.
 */
export const ROBOT_WALK_TODO_TITLE = `${ROBOT_WALK_MARKER} walkthrough`;
export const ROBOT_WALK_ASSIGNED_TODO_TITLE = `${ROBOT_WALK_MARKER} handover`;
export const ROBOT_WALK_FACT_TEXT = `${ROBOT_WALK_MARKER} the supply closet is on floor 2.`;
export const ROBOT_WALK_ITEM_NAME = `${ROBOT_WALK_MARKER} spare bulbs`;

/** Everything typed into the composer, which is the only parsed surface. */
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
  { id: 'sign-out', label: 'sign out' },
];

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
