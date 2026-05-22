/**
 * Phase 7 v2 (2026-05-22) — derivation of the Rollback safety mode
 * label in HousekeepingSystemHealth.tsx.
 *
 * The label is the only state that's NOT a direct field from
 * cockpit-data — it's derived from autoRollbacksLast7d:
 *   - autoRollbacksLast7d > 0  →  "Live (deactivates bad models)"
 *   - otherwise                 →  "Dry-run (logs only — first 30 days)"
 *
 * This logic lives in HousekeepingSystemHealth.tsx and is the bridge
 * between "what cockpit-data exposes" (raw counts) and "what operators
 * read" (safety mode in plain English). The derivation is simple but
 * load-bearing — flipping the wrong way would lie about whether rollbacks
 * can actually deactivate models.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure derivation function mirroring the inline ternary in
// HousekeepingSystemHealth.tsx. Keeping it as a local helper means
// the test stays node-test-only (no DOM import needed).
function deriveSafetyModeLabel(autoRollbacksLast7d: number): string {
  return autoRollbacksLast7d > 0
    ? 'Live (deactivates bad models)'
    : 'Dry-run (logs only — first 30 days)';
}

function deriveSafetyModeHealthy(autoRollbacksLast7d: number): boolean {
  // 'healthy' indicator: green dot when live (active drift protection),
  // red dot when dry-run (operator awareness — system isn't yet
  // protecting models from drift).
  return autoRollbacksLast7d > 0;
}

describe('Rollback safety mode label derivation', () => {
  it('shows dry-run when no real rollbacks have fired in 7 days', () => {
    assert.equal(
      deriveSafetyModeLabel(0),
      'Dry-run (logs only — first 30 days)',
    );
    assert.equal(deriveSafetyModeHealthy(0), false);
  });

  it('shows live mode when at least one real rollback fired', () => {
    assert.equal(
      deriveSafetyModeLabel(1),
      'Live (deactivates bad models)',
    );
    assert.equal(deriveSafetyModeHealthy(1), true);
  });

  it('shows live mode for many real rollbacks', () => {
    assert.equal(
      deriveSafetyModeLabel(7),
      'Live (deactivates bad models)',
    );
    assert.equal(deriveSafetyModeHealthy(7), true);
  });

  it('shows dry-run even when dry-run-only events exist (because no LIVE fires)', () => {
    // The cockpit shows dry-run-only events in a separate row; the
    // safety-mode row gates on REAL fires (autoRollbacksLast7d), not
    // dry-run counts. Otherwise an operator running 30 days of dry-run
    // would falsely see "Live" the moment any would-have-fired event
    // landed.
    assert.equal(
      deriveSafetyModeLabel(0),
      'Dry-run (logs only — first 30 days)',
    );
    assert.equal(deriveSafetyModeHealthy(0), false);
  });
});

describe('Rollbacks-in-last-7-days row visibility', () => {
  // Derivation mirrors the inline `((autoRollbacksLast7d ?? 0) +
  // (dryRunRollbacksLast7d ?? 0)) > 0` guard in HousekeepingSystemHealth.tsx.
  function shouldRender(real: number, dryRun: number): boolean {
    return (real + dryRun) > 0;
  }

  it('hides the row when both counts are zero', () => {
    assert.equal(shouldRender(0, 0), false);
  });

  it('shows the row when there are dry-run-only events', () => {
    assert.equal(shouldRender(0, 3), true);
  });

  it('shows the row when there are real fires', () => {
    assert.equal(shouldRender(2, 0), true);
  });

  it('shows the row when there are both', () => {
    assert.equal(shouldRender(1, 5), true);
  });
});
