/**
 * Learning Board robot-side tests (feature/cua-assist-board).
 *
 * Three contracts, each pinned because regressing it produces a founder-
 * visible failure that build/tsc can't catch:
 *
 *  1. validateSupervisorCoordinate — the robot physically clicks this point
 *     inside a REAL hotel PMS. Anything malformed or outside the 1280×800
 *     capture viewport must be rejected (the mapper then falls back to
 *     mark-unavailable instead of clicking somewhere random). Mirrors the
 *     route-side gate in /api/admin/mapper/assist — keep in sync.
 *
 *  2. mappingJobResultToWorkflowResult — the workflow runtime REPLACES
 *     workflow_jobs.result at completion with exactly this object. If the
 *     adapter drops targetCatalog/boardTargets, the admin board blanks the
 *     moment a run succeeds (the P0 the plan review caught). This test is
 *     the regression pin.
 *
 *  3. truncatePreviewRows — captured-row previews are persisted into a
 *     jsonb column read by the admin UI; the caps (3 rows, 80 chars/cell)
 *     keep result rows small no matter what a PMS table contains.
 */

// MUST be first: WebSocket shim + env placeholders before the import
// graph (supabase/env/anthropic all construct at module load).
import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateSupervisorCoordinate, truncatePreviewRows } from '../mapper.js';
import { mappingJobResultToWorkflowResult, type MappingJobResult } from '../mapping-driver.js';

// ─── 1. Supervisor click validation ────────────────────────────────────────

describe('validateSupervisorCoordinate', () => {
  test('accepts in-viewport points; rounds fractional admin clicks', () => {
    assert.deepEqual(validateSupervisorCoordinate({ x: 0, y: 0 }), { x: 0, y: 0 });
    assert.deepEqual(validateSupervisorCoordinate({ x: 1279, y: 799 }), { x: 1279, y: 799 });
    assert.deepEqual(validateSupervisorCoordinate({ x: 639.7, y: 400.2 }), { x: 640, y: 400 });
  });

  test('rejects missing / non-numeric / non-finite coordinates', () => {
    for (const raw of [
      undefined, null, 'click', 42, [640, 400],
      {}, { x: 640 }, { y: 400 },
      { x: '640', y: '400' }, { x: NaN, y: 10 }, { x: 10, y: Infinity },
    ]) {
      assert.equal(validateSupervisorCoordinate(raw), null, `should reject ${JSON.stringify(raw)}`);
    }
  });

  test('rejects out-of-viewport points (1280×800 capture; edges exclusive)', () => {
    for (const raw of [
      { x: -1, y: 10 }, { x: 10, y: -1 },
      { x: 1280, y: 10 }, { x: 10, y: 800 },
      { x: 5000, y: 5000 },
    ]) {
      assert.equal(validateSupervisorCoordinate(raw), null, `should reject ${JSON.stringify(raw)}`);
    }
  });
});

// ─── 2. Completion-result adapter pass-through (P0 regression pin) ─────────

describe('mappingJobResultToWorkflowResult', () => {
  test('Learning Board keys survive the completion replace', () => {
    const input: MappingJobResult = {
      ok: true,
      knowledgeFileId: 'kf-1',
      knowledgeFileVersion: 3,
      targetsFound: 5,
      targetsUnavailable: 1,
      targetsFailed: 0,
      spentMicros: 1_234_000,
      promotionDecision: 'park_draft',
      promotionReason: 'because',
      targetCatalog: [{ key: 'getArrivals', label: 'Finding arrivals…', goal: 'Guests arriving today', optional: false }],
      boardTargets: {
        getArrivals: {
          status: 'found',
          finishedAt: '2026-06-11T10:00:00Z',
          preview: { rowCount: 12, sample: [{ guest_name: 'G' }], sampleKind: 'rows' },
        },
      },
    };
    const out = mappingJobResultToWorkflowResult(input);
    // Pre-existing aggregate keys keep their snake_case names…
    assert.equal(out.knowledge_file_id, 'kf-1');
    assert.equal(out.targets_found, 5);
    assert.equal(out.promotion_decision, 'park_draft');
    // …and the board keys pass through under the SAME camelCase names the
    // mapper used mid-run, so the board reads one contract.
    assert.deepEqual(out.targetCatalog, input.targetCatalog);
    assert.deepEqual(out.boardTargets, input.boardTargets);
  });

  test('absent board state passes through as undefined keys (older callers)', () => {
    const out = mappingJobResultToWorkflowResult({ ok: true });
    assert.equal(out.targetCatalog, undefined);
    assert.equal(out.boardTargets, undefined);
  });
});

// ─── 3. Preview caps ────────────────────────────────────────────────────────

describe('truncatePreviewRows', () => {
  test('caps at 3 rows and 80 chars per cell (with ellipsis)', () => {
    const long = 'x'.repeat(200);
    const rows = [1, 2, 3, 4, 5].map((i) => ({ a: `v${i}`, b: long }));
    const out = truncatePreviewRows(rows);
    assert.equal(out.length, 3);
    assert.equal(out[0]!.a, 'v1');
    assert.equal(out[0]!.b.length, 80);
    assert.ok(out[0]!.b.endsWith('…'));
  });

  test('short cells pass through untouched', () => {
    const out = truncatePreviewRows([{ room: '101', status: 'Clean' }]);
    assert.deepEqual(out, [{ room: '101', status: 'Clean' }]);
  });

  test('contact-detail fields are dropped — previews persist in the job log forever', () => {
    const out = truncatePreviewRows([{
      pms_guest_id: 'G-1', name: 'Test Guest',
      email: 'guest@example.com', phone: '555-0100', mobile_number: '555-0101',
    }]);
    assert.deepEqual(out, [{ pms_guest_id: 'G-1', name: 'Test Guest' }]);
  });
});
