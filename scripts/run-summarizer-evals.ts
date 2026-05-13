#!/usr/bin/env tsx
// ─── CLI entry point for the summarizer eval bank ────────────────────────
// Usage:
//   STAXIS_EVAL_PROPERTY_ID=<uuid> npm run agent:summarizer-evals
//   STAXIS_EVAL_PROPERTY_ID=<uuid> npm run agent:summarizer-evals -- --filter=injection
//
// Round 11 T4, 2026-05-13.
//
// Runs each case in src/lib/agent/evals/summarizer/test-bank.ts against
// Haiku (the live API — no mocking; semantics matter). Pin the snapshot
// with MODEL_OVERRIDE=haiku=<snapshot> to make results reproducible.
//
// Real API calls = real cost. Each case is ~$0.0005, ~8 cases per run,
// ~$0.004 per full run. Worth it for catching regressions in the
// summary prompt or the model.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { runSummarizerEvals } from '../src/lib/agent/evals/summarizer/runner';

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const propertyId = process.env.STAXIS_EVAL_PROPERTY_ID;
  if (!propertyId) {
    console.error('STAXIS_EVAL_PROPERTY_ID is required. Set it to a sandbox property\'s UUID.');
    process.exit(1);
  }

  const { data: admin } = await supabase.from('accounts').select('id').eq('role', 'admin').limit(1).maybeSingle();
  if (!admin) {
    console.error('No admin account found. Cannot run evals.');
    process.exit(1);
  }

  const filter = process.argv.find(a => a.startsWith('--filter='))?.slice('--filter='.length);

  console.log('\nRunning summarizer evals against Haiku…\n');
  const summary = await runSummarizerEvals({
    propertyId,
    userId: admin.id as string,
    filter,
  });

  console.log(`\n${summary.passed}/${summary.total} passed  ·  $${summary.totalCostUsd.toFixed(4)} spent  ·  ${(summary.totalDurationMs / 1000).toFixed(1)}s total\n`);

  if (summary.passed < summary.total) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
