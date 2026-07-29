/**
 * Tables the ML retention cron may never delete from.
 *
 * The decision corpus records what the AI proposed, the property state at the
 * time, the human response, and the eventual outcome. Those snapshots cannot
 * be reconstructed after a retention run, so this policy lives outside the
 * Next route and is shared directly with its schema regression tests.
 */
export const EXEMPT_FROM_PURGE: ReadonlySet<string> = new Set([
  'agent_decisions',
  'agent_pending_actions',
  'user_feedback',
  'agent_eval_baselines',
  // Financial records are pruned only by the rollup job after their monthly
  // aggregate has been verified. This generic retention cron must never race
  // that ledger owner.
  'agent_costs',
]);
