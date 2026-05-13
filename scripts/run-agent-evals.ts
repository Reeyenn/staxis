#!/usr/bin/env tsx
// ─── CLI entry point for the agent eval bank ─────────────────────────────
// Usage:
//   npm run agent:evals                       # run everything
//   npm run agent:evals -- --filter=spanish   # subset (matches name or category)
//   STAXIS_EVAL_PROPERTY_ID=<uuid> npm run agent:evals
//
// Picks a property + user to run as. By default uses the first property the
// service-role client can see; pass STAXIS_EVAL_PROPERTY_ID to pin one.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { runAllEvals } from '../src/lib/agent/evals/runner';

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  let propertyId = process.env.STAXIS_EVAL_PROPERTY_ID;
  if (!propertyId) {
    const { data } = await supabase.from('properties').select('id').limit(1).maybeSingle();
    propertyId = data?.id as string | undefined;
  }
  if (!propertyId) {
    console.error('No property found. Set STAXIS_EVAL_PROPERTY_ID or create a property first.');
    process.exit(1);
  }

  // Pick any admin account to attribute the run to (their cap won't be hit —
  // we mark kind=eval so it doesn't count against request caps).
  const { data: admin } = await supabase.from('accounts').select('id').eq('role', 'admin').limit(1).maybeSingle();
  if (!admin) {
    console.error('No admin account found. Cannot run evals.');
    process.exit(1);
  }

  const filter = process.argv.find(a => a.startsWith('--filter='))?.slice('--filter='.length);

  console.log(`\nRunning agent evals against property ${propertyId.slice(0, 8)}…\n`);
  const summary = await runAllEvals({
    propertyId,
    userId: admin.id as string,
    filter,
  });

  console.log(`\n${summary.passed}/${summary.total} passed  ·  $${summary.totalCostUsd.toFixed(4)} spent  ·  ${(summary.totalDurationMs / 1000).toFixed(1)}s total\n`);

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
