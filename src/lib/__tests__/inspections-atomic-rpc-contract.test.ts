/**
 * Contract tests for the atomic-finalize wiring in
 * src/lib/inspections/correction-loop.ts.
 *
 * The actual DB execution requires a live Postgres connection (it's a
 * SECURITY DEFINER plpgsql function), so these tests verify the *call
 * site* contract by inspecting the source — same approach as the
 * countConsecutiveFails shape test. If anyone removes the RPC call or
 * breaks the parameter list, these fail loudly without needing a DB.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const loopSrc = readFileSync(
  resolve(here, '..', 'inspections', 'correction-loop.ts'),
  'utf8',
);
const rpcSql = readFileSync(
  resolve(here, '..', '..', '..', 'supabase', 'migrations', '0225_complete_inspection_atomic_rpc.sql'),
  'utf8',
);

describe('correction-loop ↔ complete_inspection_atomic RPC wiring', () => {
  it('finalizeInspection calls the RPC by name', () => {
    assert.match(loopSrc, /supabaseAdmin\.rpc\(\s*['"]complete_inspection_atomic['"]/);
  });

  it('passes every required parameter to the RPC', () => {
    // The RPC signature has 10 parameters. All must be passed at the
    // call site or the function silently errors.
    const required = [
      'p_inspection_id',
      'p_property_id',
      'p_result',
      'p_failed_items',
      'p_passed_items',
      'p_notes',
      'p_escalated',
      'p_escalation_reason',
      'p_correction_notice_sent_at',
      'p_correction_note',
    ];
    for (const param of required) {
      assert.ok(
        loopSrc.includes(param),
        `correction-loop.ts must pass ${param} to complete_inspection_atomic`,
      );
    }
  });

  it('falls back to the legacy non-atomic path on transient RPC failure', () => {
    // The fallback path must call completeInspection + apply{Pass,Fail}SideEffects.
    assert.match(loopSrc, /completeInspection\(\{/);
    assert.match(loopSrc, /applyPassSideEffects\(/);
    assert.match(loopSrc, /applyFailSideEffects\(/);
    // And it must log a warning so the rollout/regression is visible.
    assert.match(loopSrc, /atomic RPC unavailable/);
  });

  it('re-throws caller-bug errors (E_NOT_FOUND / E_ALREADY_FINALIZED / E_BAD_RESULT) instead of falling back', () => {
    assert.match(loopSrc, /E_NOT_FOUND/);
    assert.match(loopSrc, /E_ALREADY_FINALIZED/);
    assert.match(loopSrc, /E_BAD_RESULT/);
  });
});

describe('complete_inspection_atomic RPC migration', () => {
  it('uses SECURITY DEFINER with a pinned search_path', () => {
    assert.match(rpcSql, /security definer/i);
    assert.match(rpcSql, /set search_path\s*=\s*public,\s*pg_temp/i);
  });

  it('locks the inspection row FOR UPDATE before mutating', () => {
    assert.match(rpcSql, /select[\s\S]+\*[\s\S]+into[\s\S]+v_row[\s\S]+from[\s\S]+public\.inspections[\s\S]+where[\s\S]+id\s*=\s*p_inspection_id[\s\S]+for\s+update/i);
  });

  it('guards on property_id and on result=in_progress', () => {
    assert.match(rpcSql, /property_id\s+is\s+distinct\s+from\s+p_property_id/i);
    assert.match(rpcSql, /v_row\.result\s*<>\s*'in_progress'/i);
  });

  it('scopes rooms / cleaning_tasks updates by property_id', () => {
    // Both side-effect updates must have property_id = p_property_id in
    // the WHERE clause so a malformed room_id / cleaning_task_id pointing
    // at another property can't be hijacked through the RPC either.

    // Count each side-effect's UPDATE — pass + fail branches.
    const roomsUpdateCount = (rpcSql.match(/update\s+public\.rooms/gi) ?? []).length;
    assert.ok(roomsUpdateCount >= 2, `expected ≥2 rooms updates (pass/fail); got ${roomsUpdateCount}`);

    const taskUpdateCount = (rpcSql.match(/update\s+public\.cleaning_tasks/gi) ?? []).length;
    assert.ok(taskUpdateCount >= 2, `expected ≥2 cleaning_tasks updates (pass/fail); got ${taskUpdateCount}`);

    // And every such update must be paired with the property_id guard.
    // Conservative check: the count of `property_id = p_property_id`
    // clauses must be at least the sum of the two side-effect update
    // counts (one per branch, plus the parent-link update).
    const guardCount = (rpcSql.match(/property_id\s*=\s*p_property_id/gi) ?? []).length;
    assert.ok(
      guardCount >= roomsUpdateCount + taskUpdateCount,
      `expected ≥${roomsUpdateCount + taskUpdateCount} property_id guards; got ${guardCount}`,
    );
  });

  it('grants execute to service_role only', () => {
    assert.match(rpcSql, /revoke all on function public\.complete_inspection_atomic/i);
    assert.match(rpcSql, /grant execute on function public\.complete_inspection_atomic[\s\S]+to service_role/i);
  });

  it('self-registers in applied_migrations', () => {
    assert.match(rpcSql, /insert into public\.applied_migrations[\s\S]+'0225'/);
  });
});
