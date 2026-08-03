/**
 * TEMPORARY capture harness for the knowledge-door byte-equality proof.
 *
 * Composes every prompt the consolidation touches, from fixed inputs, and
 * writes the rendered bytes to src/lib/__tests__/fixtures/knowledge-door-golden.json.
 * Run once on the PRE-change tree; the committed fixture is then the baseline
 * agent-knowledge-door.test.ts asserts against.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabase-admin';
import {
  FIXTURES,
  OUTPUT_PATH,
  buildGoldenSubjects,
  stubSupabaseFrom,
} from '../src/lib/__tests__/knowledge-door-fixtures';

async function main(): Promise<void> {
  const restore = stubSupabaseFrom(supabaseAdmin, FIXTURES);
  const subjects = await buildGoldenSubjects();
  restore();

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(subjects, null, 2)}\n`, 'utf8');
  console.log(`wrote ${Object.keys(subjects).length} subjects to ${OUTPUT_PATH}`);
}

void main();
