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
