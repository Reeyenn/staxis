// ─── Eval-bank health verdicts ─────────────────────────────────────────────
// The decision logic behind the doctor's two ratchet checks, kept out of the
// route so it can be tested directly rather than by grepping the route's source
// (the repo's stated bar: "would this fail if I introduced a plausible bug").
//
// The route owns the queries; these functions own the judgement.

export type HealthStatus = 'ok' | 'warn' | 'fail';

export interface HealthVerdict {
  status: HealthStatus;
  detail: string;
  fix?: string;
}

/** A live eval run older than this means the model half is unverified. */
export const EVAL_BANK_STALE_DAYS = 30;

/**
 * Is the LIVE eval bank still being run?
 *
 * It is manual by design — it costs money and needs a real hotel. Manual plus
 * invisible means "nobody ran it" looks exactly like "everything is fine",
 * which is the state prod was found in: agent_eval_baselines had ZERO rows, so
 * either the bank has never run or every insert was failing silently behind a
 * console.warn.
 *
 * WARN, never fail: a stale live bank is a prompt to run it, not an outage. The
 * hermetic half runs on every commit regardless.
 */
export function evalBankFreshnessVerdict(
  newestCreatedAt: string | null,
  now: Date = new Date(),
): HealthVerdict {
  if (!newestCreatedAt) {
    return {
      status: 'warn',
      detail: 'agent_eval_baselines is EMPTY — the live eval bank has never recorded a run',
      fix: 'Run `STAXIS_EVAL_PROPERTY_ID=<test hotel> npm run agent:evals`. It now exits non-zero if it records nothing, so a silent write failure surfaces instead of printing a happy summary.',
    };
  }
  const ageDays = Math.floor((now.getTime() - new Date(newestCreatedAt).getTime()) / 86_400_000);
  if (!Number.isFinite(ageDays)) {
    return { status: 'warn', detail: `unparseable baseline timestamp: ${newestCreatedAt}` };
  }
  if (ageDays > EVAL_BANK_STALE_DAYS) {
    return {
      status: 'warn',
      detail: `newest eval baseline is ${ageDays} days old (threshold ${EVAL_BANK_STALE_DAYS})`,
      fix: 'The MODEL half of agent quality is unverified — the hermetic bank only proves the runtime. Run `npm run agent:evals` against the test hotel.',
    };
  }
  return { status: 'ok', detail: `newest eval baseline is ${ageDays} day(s) old` };
}

/**
 * THE RATCHET, part 3: an "AI got this wrong" report cannot be closed without
 * naming the permanent eval case that now covers it.
 *
 * The commit gate catches the developer who fixes a bug without a test. This
 * catches the earlier, quieter failure: a wrong answer is reported, someone
 * tweaks a prompt, the report is marked resolved, and nothing was learned.
 * FAIL rather than warn — an unclosed loop here is the whole workstream not
 * working.
 */
export function evalBankIncidentVerdict(
  uncoveredIds: readonly string[],
): HealthVerdict {
  if (uncoveredIds.length === 0) {
    return { status: 'ok', detail: 'every resolved ai_wrong report names an eval case' };
  }
  return {
    status: 'fail',
    detail:
      `${uncoveredIds.length} resolved "AI got it wrong" report(s) closed without naming an ` +
      `eval case: ${uncoveredIds.map(id => id.slice(0, 8)).join(', ')}`,
    fix: 'Add the permanent case to src/lib/agent/evals/test-bank.ts (origin: { incident: <feedback id>, date }) and set user_feedback.eval_case_name to its name. Otherwise the same wrong answer can ship again.',
  };
}
