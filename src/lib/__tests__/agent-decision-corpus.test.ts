/**
 * The decision corpus (migration 0350) — the pieces testable without a database.
 *
 * Two things are checked here, both of which have burned this repo before:
 *   1. The corpus captures the state the AI SAW, redacted. If a future snapshot
 *      field starts carrying guest contact details, that must not become
 *      long-lived data in a table with no purge.
 *   2. The route-level contract for AI feedback matches the DB CHECK. A
 *      category the route accepts but Postgres rejects is a 500 for every
 *      thumbs click, and it would only be discovered in production.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  redactSnapshot,
  snapshotHash,
  actorKindForDecision,
} from '@/lib/agent/decisions';
import { hermeticSnapshot } from '@/lib/agent/evals/hermetic-runner';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

function migrationText(): string {
  return readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .map(f => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

describe('decision corpus — state snapshot capture', () => {
  test('a snapshot round-trips through redaction unchanged when it holds no PII', () => {
    const snap = hermeticSnapshot();
    assert.deepEqual(redactSnapshot(snap), snap);
  });

  test('contact PII anywhere in the snapshot is masked before storage', () => {
    // myRooms is the field most likely to grow a guest-facing string, so the
    // masker must reach nested values, not just the top level.
    const snap = hermeticSnapshot({
      myRooms: [
        {
          id: 'r1',
          number: '302 — guest maria@example.com / (409) 555-1212',
          status: 'dirty',
          is_dnd: false,
          has_issue: false,
          help_requested: false,
        },
      ],
    });
    const redacted = redactSnapshot(snap);
    const asText = JSON.stringify(redacted);
    assert.equal(asText.includes('maria@example.com'), false, 'an email survived into the corpus');
    assert.equal(asText.includes('555-1212'), false, 'a phone number survived into the corpus');
    assert.match(asText, /\[email\]/);
    assert.match(asText, /\[phone\]/);
  });

  test('the snapshot hash is stable for identical state and differs otherwise', () => {
    const a = hermeticSnapshot();
    const b = hermeticSnapshot();
    assert.equal(snapshotHash(a), snapshotHash(b));
    assert.notEqual(snapshotHash(a), snapshotHash(hermeticSnapshot({ staff: { activeToday: 9, assignedHousekeepers: 4 } })));
  });
});

describe('decision corpus — human verdict classification', () => {
  test('approving unchanged args is human_approved', () => {
    assert.equal(
      actorKindForDecision('approve', { roomNumber: '302' }, { roomNumber: '302' }),
      'human_approved',
    );
  });

  test('approving after changing a value is human_edited (the correction signal)', () => {
    assert.equal(
      actorKindForDecision('approve', { recipient: 'Maria' }, { recipient: 'Carlos' }),
      'human_edited',
    );
  });

  test('adding or clearing a field also counts as an edit', () => {
    assert.equal(actorKindForDecision('approve', {}, { note: 'urgent' }), 'human_edited');
    assert.equal(actorKindForDecision('approve', { note: 'urgent' }, {}), 'human_edited');
  });

  test('denial is human_denied regardless of args', () => {
    assert.equal(actorKindForDecision('deny', { a: 1 }, { a: 2 }), 'human_denied');
  });
});

describe('decision corpus — schema contract', () => {
  test('the corpus does not cascade away with the conversation or the account', () => {
    // The whole reason agent_decisions exists rather than reusing
    // agent_pending_actions (which is ON DELETE CASCADE to both). This is a
    // no-runtime invariant, so asserting on the migration text is the only
    // way to pin it without a live database.
    const sql = migrationText();
    const create = sql.slice(sql.indexOf('create table if not exists public.agent_decisions'));
    const body = create.slice(0, create.indexOf('\n);'));
    assert.match(body, /actor_account_id uuid references public\.accounts\(id\) on delete set null/);
    assert.equal(
      /conversation_id[^\n]*references/.test(body),
      false,
      'conversation_id gained a foreign key — the corpus would be purged with the conversation',
    );
    assert.match(body, /property_id uuid not null references public\.properties\(id\) on delete cascade/);
  });

  test('the AI feedback categories the route accepts are allowed by the DB constraint', () => {
    const sql = migrationText();
    // Last definition wins — 0350 drops and re-adds the 0052 constraint.
    const idx = sql.lastIndexOf('user_feedback_category_check');
    assert.ok(idx > 0, 'user_feedback category constraint not found');
    const tail = sql.slice(idx, idx + 400);
    for (const category of ['ai_answer', 'ai_wrong']) {
      assert.ok(
        tail.includes(`'${category}'`),
        `route accepts category '${category}' but the DB CHECK would reject it`,
      );
    }
  });
});
