#!/usr/bin/env tsx
// ─── CLI entry point for the agent eval bank ─────────────────────────────
// Usage:
//   STAXIS_EVAL_PROPERTY_ID=<uuid> npm run agent:evals                # run everything
//   STAXIS_EVAL_PROPERTY_ID=<uuid> npm run agent:evals -- --filter=spanish
//
// STAXIS_EVAL_PROPERTY_ID is REQUIRED. Codex adversarial review 2026-05-13
// (A-H11) flagged that the prior "first property" fallback could point evals
// at production data when the env var was missing. Tools are dry-run by
// default in the runner (see runner.ts dryRun), but property choice should
// also be explicit.

// `./load-env` reads `.env.local` (see that file for why `dotenv/config` was
// wrong). It must run before anything under src/lib is loaded — supabase-admin
// THROWS at module load when its env vars are missing, by design. Imports are
// hoisted, so the eval runner is pulled in dynamically inside main() instead of
// at the top: that ordering holds whether tsx loads this as CJS or ESM.
import { loadEnv } from './load-env';
import { createClient } from '@supabase/supabase-js';

loadEnv();

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }
  const { runAllEvals } = await import('../src/lib/agent/evals/runner');
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const propertyId = process.env.STAXIS_EVAL_PROPERTY_ID;
  if (!propertyId) {
    console.error('STAXIS_EVAL_PROPERTY_ID is required. Set it to a sandbox property\'s UUID.');
    process.exit(1);
  }

  // Pick any admin account to attribute the run to (their cap won't be hit —
  // we mark kind=eval so it doesn't count against request caps).
  const { data: admin } = await supabase
    .from('accounts')
    .select('id, data_user_id')
    .eq('role', 'admin')
    .not('data_user_id', 'is', null)
    .limit(1)
    .maybeSingle();
  if (!admin?.data_user_id) {
    console.error('No admin account found. Cannot run evals.');
    process.exit(1);
  }

  const filter = process.argv.find(a => a.startsWith('--filter='))?.slice('--filter='.length);

  console.log(`\nRunning agent evals against property ${propertyId.slice(0, 8)}…\n`);
  const summary = await runAllEvals({
    propertyId,
    userId: admin.id as string,
    authUserId: admin.data_user_id as string,
    filter,
  });

  console.log(`\n${summary.passed}/${summary.total} passed  ·  $${summary.totalCostUsd.toFixed(4)} spent  ·  ${(summary.totalDurationMs / 1000).toFixed(1)}s total\n`);

  // A run that records nothing is indistinguishable from a run that never
  // happened — which is exactly the state prod was found in (0 rows in
  // agent_eval_baselines). Fail loudly rather than printing a happy summary
  // on top of a bank that left no trace. See runner.ts's baseline block.
  if (summary.total > 0 && summary.baselinesRecorded === 0) {
    console.error(
      '\n✗ The run recorded ZERO baseline rows in agent_eval_baselines.\n' +
      '  Nothing above can be compared to a previous run, and /api/admin/doctor\n' +
      '  will report the live bank as stale. Fix the write before trusting this run.\n',
    );
    process.exit(1);
  }
  if (summary.baselinesRecorded < summary.total) {
    console.warn(
      `⚠ only ${summary.baselinesRecorded}/${summary.total} cases recorded a baseline row.`,
    );
  }

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
