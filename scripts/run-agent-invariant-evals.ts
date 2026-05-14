#!/usr/bin/env tsx
// ─── Agent invariant evals (SQL-based, real live DB) ────────────────────
// Round 12 T12.13 / T12.14 / T12.15 / T12.16.
//
// Usage:
//   STAXIS_EVAL_PROPERTY_ID=<uuid> npm run agent:invariant-evals
//
// This is the "boundary tests" suite: things only the live DB can
// verify. We can't unit-test the bump triggers + the restore RPC +
// the trigger interaction with the orphan-tool-result check; we need
// a real Postgres. So we run a few sandbox scenarios end-to-end.
//
// IMPORTANT: every scenario operates inside a transaction it ROLLS
// BACK at the end. No production data is mutated. The scenarios just
// need write access to verify the RPCs/triggers produce expected
// state on real schemas.
//
// Each scenario is self-contained and resilient to other scenarios
// running before/after.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';

interface Scenario {
  name: string;
  description: string;
  run: (pg: Client) => Promise<{ pass: boolean; details: string }>;
}

const SCENARIOS: Scenario[] = [
  // ── T12.15: archive + restore round-trip preserves counters ────────────
  {
    name: 'archive_restore_round_trip',
    description: 'Create a conversation with 4 messages, archive it, restore it, verify counters match.',
    run: async (pg) => {
      const conv = await pg.query(`
        INSERT INTO agent_conversations (user_id, property_id, role)
        SELECT id, $1, 'admin' FROM accounts WHERE role='admin' LIMIT 1
        RETURNING id;
      `, [process.env.STAXIS_EVAL_PROPERTY_ID]);
      const convId = conv.rows[0].id;

      // Insert 4 messages: 2 user + 2 assistant text turns.
      await pg.query(`
        INSERT INTO agent_messages (conversation_id, role, content, created_at)
        VALUES
          ($1, 'user', 'hi', now() - interval '1 min'),
          ($1, 'assistant', 'hello', now() - interval '50 sec'),
          ($1, 'user', 'thanks', now() - interval '40 sec'),
          ($1, 'assistant', 'you''re welcome', now() - interval '30 sec');
      `, [convId]);

      const before = await pg.query(`
        SELECT message_count, unsummarized_message_count FROM agent_conversations WHERE id = $1
      `, [convId]);

      // The archive RPC requires the conversation to be eligible
      // (older than some threshold); for testing we bypass by using
      // a force flag if supported, or by directly setting updated_at
      // back in time.
      await pg.query(`UPDATE agent_conversations SET updated_at = now() - interval '91 days' WHERE id = $1`, [convId]);

      const archiveResult = await pg.query(`SELECT staxis_archive_conversation($1, 90)`, [convId]);
      const archived = Number(archiveResult.rows[0].staxis_archive_conversation);
      if (archived < 0) {
        return { pass: false, details: `archive returned ${archived}, expected >=0` };
      }

      // Verify hot tables don't have this conversation.
      const hot = await pg.query(`SELECT count(*)::int AS n FROM agent_messages WHERE conversation_id = $1`, [convId]);
      if (hot.rows[0].n !== 0) {
        return { pass: false, details: `after archive, hot agent_messages still has ${hot.rows[0].n} rows` };
      }

      // Restore.
      const restoreResult = await pg.query(`SELECT staxis_restore_conversation($1)`, [convId]);
      const restored = Number(restoreResult.rows[0].staxis_restore_conversation);
      if (restored !== 4) {
        return { pass: false, details: `restore returned ${restored}, expected 4` };
      }

      // Verify counters match what they were before archive.
      const after = await pg.query(`
        SELECT message_count, unsummarized_message_count FROM agent_conversations WHERE id = $1
      `, [convId]);

      if (after.rows[0].message_count !== before.rows[0].message_count) {
        return {
          pass: false,
          details: `message_count drift: before=${before.rows[0].message_count} after=${after.rows[0].message_count}`,
        };
      }
      if (after.rows[0].unsummarized_message_count !== before.rows[0].unsummarized_message_count) {
        return {
          pass: false,
          details: `unsummarized_message_count drift: before=${before.rows[0].unsummarized_message_count} after=${after.rows[0].unsummarized_message_count}`,
        };
      }

      // Verify SELECT count(*) matches stored counter (INV-4).
      const actual = await pg.query(`SELECT count(*)::int AS n FROM agent_messages WHERE conversation_id = $1`, [convId]);
      if (actual.rows[0].n !== after.rows[0].message_count) {
        return {
          pass: false,
          details: `INV-4 violation: stored message_count=${after.rows[0].message_count}, actual count(*)=${actual.rows[0].n}`,
        };
      }

      return {
        pass: true,
        details: `archive(4)→restore(4); counters match ${after.rows[0].message_count}/${after.rows[0].unsummarized_message_count}`,
      };
    },
  },

  // ── T12.14: heal RPC catches drift ─────────────────────────────────────
  {
    name: 'heal_rpc_detects_drift',
    description: 'Manually drift a conversation\'s counter, run dry-run heal, verify it detects the drift.',
    run: async (pg) => {
      const conv = await pg.query(`
        INSERT INTO agent_conversations (user_id, property_id, role, message_count, unsummarized_message_count)
        SELECT id, $1, 'admin', 999, 999 FROM accounts WHERE role='admin' LIMIT 1
        RETURNING id;
      `, [process.env.STAXIS_EVAL_PROPERTY_ID]);
      const convId = conv.rows[0].id;
      // Note: counters set to 999 but actual messages = 0.

      const dryRun = await pg.query(`
        SELECT conversation_id, stored_msg_count, actual_msg_count
        FROM staxis_heal_conversation_counters(true)
        WHERE conversation_id = $1;
      `, [convId]);

      if (dryRun.rows.length === 0) {
        return { pass: false, details: `heal RPC didn't detect drift on conv ${convId}` };
      }
      const row = dryRun.rows[0];
      if (row.stored_msg_count !== 999 || row.actual_msg_count !== 0) {
        return {
          pass: false,
          details: `heal RPC reported stored=${row.stored_msg_count}, actual=${row.actual_msg_count}; expected stored=999, actual=0`,
        };
      }
      return { pass: true, details: `heal RPC correctly detected drift (999→0)` };
    },
  },

  // ── T12.13: orphan tool_result trigger blocks bad inserts ──────────────
  {
    name: 'orphan_tool_result_trigger_blocks',
    description: 'Insert a tool row with no preceding tool_use; trigger should reject.',
    run: async (pg) => {
      const conv = await pg.query(`
        INSERT INTO agent_conversations (user_id, property_id, role)
        SELECT id, $1, 'admin' FROM accounts WHERE role='admin' LIMIT 1
        RETURNING id;
      `, [process.env.STAXIS_EVAL_PROPERTY_ID]);
      const convId = conv.rows[0].id;

      try {
        await pg.query(`
          INSERT INTO agent_messages (conversation_id, role, tool_call_id, tool_result)
          VALUES ($1, 'tool', 'orphan-call-id', '{"ok":false}'::jsonb);
        `, [convId]);
        return { pass: false, details: 'orphan tool_result was accepted; trigger did not fire' };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('orphan_tool_result')) {
          return { pass: true, details: `trigger fired: ${msg.split('\n')[0]}` };
        }
        return { pass: false, details: `unexpected error: ${msg}` };
      }
    },
  },

  // ── T12.16 (lighter version): empty prompt content blocked ────────────
  {
    name: 'empty_prompt_content_check',
    description: 'Insert agent_prompts with empty content; CHECK constraint should reject.',
    run: async (pg) => {
      try {
        await pg.query(`
          INSERT INTO agent_prompts (role, version, content, is_active)
          VALUES ('base', 'test-' || substr(md5(random()::text), 1, 8), '', false);
        `);
        return { pass: false, details: 'empty content was accepted; CHECK constraint missing' };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('agent_prompts_content_nonempty')) {
          return { pass: true, details: 'CHECK constraint fired correctly' };
        }
        return { pass: false, details: `unexpected error: ${msg}` };
      }
    },
  },
];

async function main(): Promise<void> {
  // If STAXIS_EVAL_PROPERTY_ID isn't a valid UUID, fall back to
  // discovering one at startup (any property is fine — every scenario
  // operates inside a transaction it rolls back).
  let propertyId = process.env.STAXIS_EVAL_PROPERTY_ID ?? '';
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Auth check via supabase admin client.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.');
    process.exit(1);
  }
  void createClient(url, key);  // sanity-check creds parse

  // Direct pg client so we can use BEGIN/ROLLBACK across statements.
  const dbHost = process.env.SUPABASE_DB_HOST ?? 'aws-1-us-east-1.pooler.supabase.com';
  const dbPassword = process.env.SUPABASE_DB_PASSWORD;
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  if (!dbPassword || !projectRef) {
    console.error('SUPABASE_DB_PASSWORD + SUPABASE_PROJECT_REF required (see ~/.config/staxis/tokens.env).');
    process.exit(1);
  }

  const pg = new Client({
    host: dbHost,
    port: 5432,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    password: dbPassword,
    ssl: { rejectUnauthorized: false },
  });

  await pg.connect();

  // If property id wasn't a valid UUID, auto-discover one.
  if (!uuidRe.test(propertyId)) {
    const r = await pg.query(`SELECT id FROM properties LIMIT 1`);
    if (r.rows.length === 0) {
      console.error('No properties found in DB; cannot run scenarios.');
      process.exit(1);
    }
    propertyId = r.rows[0].id as string;
    console.log(`Auto-discovered property ${propertyId} (set STAXIS_EVAL_PROPERTY_ID to pin).\n`);
  }
  process.env.STAXIS_EVAL_PROPERTY_ID = propertyId;

  console.log('Running agent invariant evals against live DB (all scenarios are rolled back)...\n');

  let passed = 0;
  for (const sc of SCENARIOS) {
    process.stdout.write(`  ${sc.name.padEnd(42)} `);
    try {
      await pg.query('BEGIN');
      const result = await sc.run(pg);
      await pg.query('ROLLBACK');
      if (result.pass) {
        console.log(`✓  ${result.details}`);
        passed++;
      } else {
        console.log(`✗  ${result.details}`);
      }
    } catch (e) {
      try { await pg.query('ROLLBACK'); } catch { /* ignore */ }
      console.log(`✗  threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await pg.end();

  console.log(`\n${passed}/${SCENARIOS.length} scenarios passed.\n`);
  if (passed < SCENARIOS.length) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
