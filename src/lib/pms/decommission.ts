/**
 * PMS browser robot (CUA) retirement switch — one place the app agrees on.
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
 * The implementation is deliberately kept for historical reference. This
 * compile-time product switch is the single web-app gate: while false, no
 * route may expose robot-only state, store robot credentials, mutate a robot
 * session, or enqueue work for the retired worker.
 *
 * There is intentionally no supported configuration-only re-enable path.
 * Reintroducing browser automation would be a new product/architecture
 * decision and must include a coordinated implementation and review.
 */

import { NextResponse } from 'next/server';
import { err, ApiErrorCode } from '@/lib/api-response';
import { PMS_ROBOT_ENABLED } from '@/lib/pms/robot-status';

/**
 * Legacy inverse kept for older server-only callers. The authoritative switch
 * is the client-safe compile-time constant in `robot-status.ts`; it is not an
 * environment variable that can drift between deployments.
 *
 * Annotated `: boolean` on purpose. Without it the inferred type is the
 * literal `true`, which makes TypeScript treat every guarded branch as
 * statically dead — so flipping this to `false` would light up unrelated
 * "unreachable" noise across the files that read it. `boolean` keeps the flip
 * a genuine one-line change.
 */
export const CUA_DECOMMISSIONED: boolean = !PMS_ROBOT_ENABLED;

/** One-line human explanation, reused by every surface that reports it. */
export const CUA_DECOMMISSION_REASON =
  'The PMS browser robot is retired. PMS data arrives by scheduled report email; the old robot code is retained but disabled.';

/** Honest operator guidance shown in legacy doctor `fix` fields. */
export const CUA_DECOMMISSION_REVIVE_HINT =
  'There is no supported configuration-only re-enable path. Reintroducing browser automation requires an explicit product and architecture review.';

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
 * The authenticated refusal for any robot-only route or action.
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
  'The PMS browser robot is unavailable. No robot data was returned and no robot action was performed. ' +
  CUA_DECOMMISSION_REASON;

/**
 * Guard for an authenticated robot-only route. Returns a ready 503 response
 * when the robot is off, or `null` to continue.
 *
 * Call it immediately after the auth gate and before parsing request data or
 * touching storage, rate limits, audit logs, or queues.
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
    details: { decommissioned: true },
  });
}
