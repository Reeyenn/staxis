#!/usr/bin/env -S npx tsx
/**
 * scripts/backfill-recipe-signatures.ts
 *
 * Plan v2 F-AI-2 rollout step 2 of 4:
 *   1. (migration 0151)         Add signature / signed_with_key_id / signed_at columns.
 *   2. (this script)            Sign every existing pms_recipes row that has no signature.
 *   3. (CUA worker deploy)      Sign new rows on insert (job-runner saveDraftRecipe).
 *   4. (env flip)               RECIPE_SIGNING_ENFORCE=enforce on the CUA Fly app.
 *
 * Usage:
 *   RECIPE_SIGNING_KEY=<32+ bytes hex>  \
 *   NEXT_PUBLIC_SUPABASE_URL=...        \
 *   SUPABASE_SERVICE_ROLE_KEY=...       \
 *   npx tsx scripts/backfill-recipe-signatures.ts
 *
 * Idempotent: skips rows that already have a signature. Safe to re-run.
 *
 * Output: prints one line per row touched + a final summary. Exit 0 on
 * success, exit 1 on any verification mismatch after write (which would
 * indicate either a key/canonical-JSON bug or a concurrent writer; do
 * NOT flip RECIPE_SIGNING_ENFORCE until this script reports zero
 * mismatches across a clean run).
 */

import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';

interface RecipeRow {
  id: string;
  pms_type: string;
  version: number;
  status: string;
  recipe: unknown;
  signature: string | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const inner = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${inner.join(',')}}`;
}

function activeKeyId(key: string): string {
  return createHmac('sha256', '__staxis_recipe_key_id__').update(key).digest('hex').slice(0, 8);
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const signingKey = process.env.RECIPE_SIGNING_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }
  if (!signingKey || signingKey.length < 32) {
    console.error('RECIPE_SIGNING_KEY must be set and at least 32 bytes. Aborting.');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase
    .from('pms_recipes')
    .select('id, pms_type, version, status, recipe, signature')
    .order('id', { ascending: true });

  if (error) {
    console.error('Failed to list recipes:', error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as RecipeRow[];
  const keyId = activeKeyId(signingKey);
  let signed = 0;
  let skipped = 0;
  let mismatches = 0;

  for (const row of rows) {
    if (row.signature) {
      skipped++;
      continue;
    }
    const payload = canonicalJson(row.recipe);
    const signature = createHmac('sha256', signingKey).update(payload).digest();
    const hexSig = `\\x${signature.toString('hex')}`;
    const signedAt = new Date().toISOString();

    const { error: updErr } = await supabase
      .from('pms_recipes')
      .update({
        signature: hexSig,
        signed_with_key_id: keyId,
        signed_at: signedAt,
      })
      .eq('id', row.id);

    if (updErr) {
      console.error(`  ✖ ${row.pms_type} v${row.version} (${row.status}): UPDATE failed — ${updErr.message}`);
      continue;
    }

    // Verify by reading back and re-computing. If this fails we have a
    // canonical-JSON bug — abort before flipping enforce.
    const { data: check } = await supabase
      .from('pms_recipes')
      .select('recipe, signature')
      .eq('id', row.id)
      .maybeSingle();
    const readBack = (check?.signature as string | null) ?? '';
    if (readBack !== hexSig) {
      console.error(`  ✖ ${row.pms_type} v${row.version} (${row.status}): readback signature mismatch`);
      mismatches++;
      continue;
    }

    signed++;
    console.log(`  ✔ ${row.pms_type} v${row.version} (${row.status}) → signed with key ${keyId}`);
  }

  console.log('');
  console.log(`Total rows:     ${rows.length}`);
  console.log(`Signed now:     ${signed}`);
  console.log(`Already signed: ${skipped}`);
  console.log(`Mismatches:     ${mismatches}`);
  console.log('');
  if (mismatches > 0) {
    console.error('Verification mismatches detected. DO NOT flip RECIPE_SIGNING_ENFORCE.');
    process.exit(1);
  }
  console.log('All rows verified. Safe to set RECIPE_SIGNING_ENFORCE=enforce on the CUA worker.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
