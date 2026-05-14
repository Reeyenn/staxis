/**
 * One-shot verifier for migration 0116. Confirms:
 *   - accounts has the 3 new voice columns
 *   - agent_costs kind constraint accepts 'audio'
 *   - voice_recordings table + indexes + RLS exist
 *   - applied_migrations records 0116
 */

import { Client } from 'pg';

async function main() {
  const host = process.env.SUPABASE_DB_HOST ?? 'aws-1-us-east-1.pooler.supabase.com';
  const password = process.env.SUPABASE_DB_PASSWORD;
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  if (!password || !projectRef) {
    console.error('Need SUPABASE_DB_PASSWORD + SUPABASE_PROJECT_REF');
    process.exit(1);
  }

  const pg = new Client({
    host, port: 5432, database: 'postgres',
    user: `postgres.${projectRef}`, password, ssl: { rejectUnauthorized: false },
  });
  await pg.connect();

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. accounts columns
  const cols = await pg.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts'
      AND column_name IN ('voice_replies_enabled', 'wake_word_enabled', 'voice_onboarded_at')
    ORDER BY column_name
  `);
  checks.push({
    name: 'accounts voice columns',
    ok: cols.rows.length === 3,
    detail: cols.rows.map(r => r.column_name).join(', '),
  });

  // 2. agent_costs kind constraint
  const con = await pg.query(`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conname = 'agent_costs_kind_check'
  `);
  const def = (con.rows[0]?.def as string) ?? '';
  checks.push({
    name: 'agent_costs.kind accepts audio',
    ok: def.includes("'audio'"),
    detail: def,
  });

  // 3. voice_recordings table
  const tbl = await pg.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'voice_recordings'
    ORDER BY ordinal_position
  `);
  checks.push({
    name: 'voice_recordings table',
    ok: tbl.rows.length >= 9,
    detail: `${tbl.rows.length} columns: ${tbl.rows.map(r => r.column_name).join(', ')}`,
  });

  // 4. indexes
  const idx = await pg.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'voice_recordings'
    ORDER BY indexname
  `);
  checks.push({
    name: 'voice_recordings indexes',
    ok: idx.rows.some(r => r.indexname === 'voice_recordings_expires_idx')
     && idx.rows.some(r => r.indexname === 'voice_recordings_user_created_idx'),
    detail: idx.rows.map(r => r.indexname).join(', '),
  });

  // 5. RLS enabled
  const rls = await pg.query(`
    SELECT relrowsecurity FROM pg_class
    WHERE relname = 'voice_recordings' AND relnamespace = 'public'::regnamespace
  `);
  checks.push({
    name: 'voice_recordings RLS enabled',
    ok: rls.rows[0]?.relrowsecurity === true,
    detail: String(rls.rows[0]?.relrowsecurity),
  });

  // 6. applied_migrations row
  const applied = await pg.query(`
    SELECT description FROM applied_migrations WHERE version = '0116'
  `);
  checks.push({
    name: 'applied_migrations records 0116',
    ok: applied.rows.length === 1,
    detail: applied.rows[0]?.description ?? '(missing)',
  });

  await pg.end();

  let allOk = true;
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name}`);
    console.log(`   ${c.detail}`);
    if (!c.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

void main();
