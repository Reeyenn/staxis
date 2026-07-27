/**
 * PMS robot (CUA) decommission switch — ONE place the whole app agrees on.
 *
 * ─── What was decommissioned, and why ────────────────────────────────────
 * `cua-service/` is the 24/7 Playwright + Claude-vision worker (Fly app
 * `staxis-cua`) that used to stay logged into each hotel's PMS and poll five
 * feeds every ~30s. It has been switched off since ~2026-07-06, and the
 * product intent changed underneath it: PMS data now arrives as **scheduled
 * report emails** (migrations 0340-0343), not as a browser robot reading
 * screens. A robot that nobody intends to run is not free — it burns Claude
 * tokens and a Fly machine, and it makes the health dashboard lie.
 *
 * ─── Disable, do NOT delete ──────────────────────────────────────────────
 * Every line of robot code is deliberately KEPT. This flag is the single
 * gate: while it is `true`, nothing may spawn robot work and nothing may
 * claim to be monitoring a live robot.
 *
 * ─── To bring the robot back ─────────────────────────────────────────────
 *   1. Flip `CUA_DECOMMISSIONED` to `false` here (re-arms the pull-enqueue
 *      cron route + the three cua_* doctor checks).
 *   2. Set `CUA_DECOMMISSIONED = "false"` in `cua-service/fly.toml` `[env]`,
 *      then `fly deploy` from `cua-service/` (the worker parks itself at boot
 *      while that var is unset or 'true' — see cua-service/src/index.ts).
 *   3. Re-add a `schedule:` block on a 15-minute cron to
 *      `.github/workflows/pull-jobs-cron.yml`.
 * Full checklist: `cua-service/README.md`.
 */

import { NextResponse } from 'next/server';
import { err, ApiErrorCode } from '@/lib/api-response';

/**
 * `true` = the robot is decommissioned. Flip to `false` to re-arm the app
 * side (step 1 above). Deliberately a compile-time constant, not an env var:
 * an env var can be set by accident on one platform and drift; a constant
 * means "the robot is off" is visible in the diff and reviewable.
 *
 * Annotated `: boolean` on purpose. Without it the inferred type is the
 * literal `true`, which makes TypeScript treat every guarded branch as
 * statically dead — so flipping this to `false` would light up unrelated
 * "unreachable" noise across the files that read it. `boolean` keeps the flip
 * a genuine one-line change.
 */
export const CUA_DECOMMISSIONED: boolean = true;

/** One-line human explanation, reused by every surface that reports it. */
export const CUA_DECOMMISSION_REASON =
  'PMS robot decommissioned 2026-07-25 — PMS data arrives by scheduled report email now. Code kept, disabled.';

/** How an operator turns it back on. Shown in doctor `fix` fields. */
export const CUA_DECOMMISSION_REVIVE_HINT =
  'To re-arm: set CUA_DECOMMISSIONED=false in src/lib/pms/decommission.ts AND in ' +
  'cua-service/fly.toml (then fly deploy), and restore the schedule: block in ' +
  '.github/workflows/pull-jobs-cron.yml. See cua-service/README.md.';

export type DecommissionVerdict = {
  status: 'ok';
  detail: string;
  fix: string;
};

/**
 * The verdict a robot-era health check returns while the robot is off.
 *
 * Deliberately `ok`, not `warn`/`fail`/`skipped`:
 *   - `fail` would 503 the deploy gate forever over a thing we chose to turn off.
 *   - `warn` would train everyone to ignore the doctor's warnings.
 *   - `skipped` reads as "couldn't check", which is a different, misleading claim.
 * `ok` + a detail line that says the word "decommissioned" is the honest answer:
 * the state is exactly what we intend it to be.
 *
 * @param what short label for the thing that is no longer being monitored
 */
export function decommissionedCheck(what: string): DecommissionVerdict {
  return {
    status: 'ok',
    detail: `not monitored — ${what} belongs to the CUA robot. ${CUA_DECOMMISSION_REASON}`,
    fix: CUA_DECOMMISSION_REVIVE_HINT,
  };
}

/**
 * The admin-facing refusal for a button that would have queued robot work.
 *
 * ─── The bug this closes (2026-07-27 chore audit) ────────────────────────
 * Seven admin routes INSERT into `workflow_jobs`. The only consumer of that
 * queue is cua-service's WorkflowRuntime poller, which refuses to start while
 * the robot is decommissioned. So every one of those buttons wrote a row that
 * nobody would ever claim: it sat `queued` forever, the admin was often
 * redirected to a live board that would spin until it timed out, and — worst —
 * the row permanently occupied its `(property_id, idempotency_key)` slot.
 *
 * That last part is why this refusal must come BEFORE the insert AND before
 * every side effect around it. Two routes key by DAY rather than by
 * `Date.now()` (`mapper.repair:<family>:<target>:<day>`), so a single dead
 * click burned that target's only retry for the rest of the UTC day and every
 * later click that day got "repair already in-flight" — a lie about a row that
 * would never run. `capture-feed` similarly arms a 60-second cooldown, and
 * `regenerate-recipe` increments a 10/hour rate-limit counter. Guard first,
 * spend nothing.
 *
 * ─── Shape: an ERROR, deliberately ───────────────────────────────────────
 * `/api/cron/enqueue-property-pulls` refuses with `ok:true` — correct THERE,
 * because a GitHub Actions `workflow_dispatch` greps the body for `"ok":true`
 * and a red run would send someone investigating a thing we chose to turn off.
 * A human pressing a button needs the opposite: `ok:true` would render as
 * success and teach the admin the job was queued. So these routes return 503 +
 * `robot_decommissioned`, which the existing admin error toasts already
 * surface verbatim.
 *
 * The message names all three things an operator needs: that nothing was
 * written, why, and that the work still needs doing another way.
 */
export const CUA_DECOMMISSIONED_ADMIN_MESSAGE =
  'Nothing was queued. The PMS robot is switched off, so this job would sit in the ' +
  'queue forever with nobody to run it. ' + CUA_DECOMMISSION_REASON;

/**
 * Guard for any admin route that would enqueue `workflow_jobs`. Returns a ready
 * 503 response when the robot is off, or `null` to continue.
 *
 * Call it IMMEDIATELY after the auth gate and before any rate-limit
 * increment, cooldown stamp, audit write, or insert — see the note above on
 * why the ordering is the whole point.
 *
 *   const robotOff = robotDecommissionedResponse(requestId);
 *   if (robotOff) return robotOff;
 */
export function robotDecommissionedResponse(requestId: string): NextResponse | null {
  if (!CUA_DECOMMISSIONED) return null;
  return err(CUA_DECOMMISSIONED_ADMIN_MESSAGE, {
    requestId,
    status: 503,
    code: ApiErrorCode.RobotDecommissioned,
    details: { decommissioned: true, revive: CUA_DECOMMISSION_REVIVE_HINT },
  });
}
