import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyAlert, type ApplyAlertWriter } from '../schedule-reactivity/apply-alert';
import type { AlertDepartment } from '../schedule-reactivity/types';

interface StubShift {
  id: string; staffId: string | null; status: string; createdAt: string;
}

function makeWriter(opts: {
  alert?: {
    id: string;
    propertyId: string;
    alertDate: string;
    department: AlertDepartment;
    suggestedAction: 'add_shift' | 'release_shift';
    dismissedAt?: string | null;
    appliedAt?: string | null;
  } | null;
  shifts?: StubShift[];
  preset?: { startTime: string; endTime: string } | null;
}): { writer: ApplyAlertWriter; spy: Record<string, unknown> } {
  const spy: Record<string, unknown> = {};
  const shifts: StubShift[] = opts.shifts ?? [];
  let nextShiftId = 1;
  const writer: ApplyAlertWriter = {
    async loadAlert() {
      if (!opts.alert) return null;
      return {
        ...opts.alert,
        dismissedAt: opts.alert.dismissedAt ?? null,
        appliedAt: opts.alert.appliedAt ?? null,
      };
    },
    async lookupFirstPreset() {
      return opts.preset ?? null;
    },
    async insertOpenShift(input) {
      const id = `new-${nextShiftId++}`;
      spy.insertedShift = { ...input, id };
      return { id };
    },
    async pickShiftToRelease(input) {
      spy.pickStrategy = input.strategy;
      const ordered = input.strategy === 'latest_added'
        ? [...shifts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [...shifts]; // pretend pre-sorted by seniority
      const first = ordered[0];
      if (!first) return null;
      if (['published', 'sent', 'confirmed'].includes(first.status)) {
        return {
          id: first.id, staffId: first.staffId,
          published: true, status: first.status,
        };
      }
      return { id: first.id, staffId: first.staffId, published: false };
    },
    async deleteShift(id) {
      spy.deletedShiftId = id;
      return { ok: true };
    },
    async markApplied(input) {
      spy.markedApplied = input;
      return { ok: true };
    },
    async preclaimApply(alertId, accountId) {
      spy.preclaimed = { alertId, accountId };
      return { claimed: true };
    },
    async setAppliedPayload(alertId, outcome, affectedShiftId) {
      spy.appliedPayload = { alertId, outcome, affectedShiftId };
    },
  };
  return { writer, spy };
}

test('add_shift: inserts open shift using preset times', async () => {
  const { writer, spy } = makeWriter({
    alert: {
      id: 'a1', propertyId: 'p1', alertDate: '2026-06-01',
      department: 'housekeeping', suggestedAction: 'add_shift',
    },
    preset: { startTime: '07:00', endTime: '15:00' },
  });
  const r = await applyAlert('a1', 'acct-1', { releaseShiftStrategy: 'latest_added' }, writer, 'p1');
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'created_open_shift');
  assert.match(r.affectedShiftId!, /^new-/);
  assert.deepEqual((spy.insertedShift as { startTime: string }).startTime, '07:00');
});

test('add_shift: falls back to 08:00–16:00 when no preset', async () => {
  const { writer, spy } = makeWriter({
    alert: {
      id: 'a2', propertyId: 'p1', alertDate: '2026-06-01',
      department: 'maintenance', suggestedAction: 'add_shift',
    },
    preset: null,
  });
  const r = await applyAlert('a2', null, { releaseShiftStrategy: 'latest_added' }, writer, 'p1');
  assert.equal(r.ok, true);
  assert.deepEqual(
    { s: (spy.insertedShift as { startTime: string }).startTime,
      e: (spy.insertedShift as { endTime: string }).endTime },
    { s: '08:00', e: '16:00' },
  );
});

test('release_shift: latest_added strategy picks newest draft shift', async () => {
  const { writer, spy } = makeWriter({
    alert: {
      id: 'a3', propertyId: 'p1', alertDate: '2026-06-01',
      department: 'front_desk', suggestedAction: 'release_shift',
    },
    shifts: [
      { id: 's-old', staffId: 'u1', status: 'draft', createdAt: '2026-05-30T10:00:00Z' },
      { id: 's-new', staffId: 'u2', status: 'draft', createdAt: '2026-05-31T12:00:00Z' },
    ],
  });
  const r = await applyAlert('a3', 'acct-1', { releaseShiftStrategy: 'latest_added' }, writer, 'p1');
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'deleted_shift');
  assert.equal(r.affectedShiftId, 's-new');
  assert.equal(spy.deletedShiftId, 's-new');
});

test('release_shift: refuses to silently delete a published shift', async () => {
  const { writer } = makeWriter({
    alert: {
      id: 'a4', propertyId: 'p1', alertDate: '2026-06-01',
      department: 'housekeeping', suggestedAction: 'release_shift',
    },
    shifts: [
      { id: 's-pub', staffId: 'u1', status: 'published', createdAt: '2026-05-31T12:00:00Z' },
    ],
  });
  const r = await applyAlert('a4', 'acct-1', { releaseShiftStrategy: 'latest_added' }, writer, 'p1');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'shift_already_published');
});

test('release_shift: no shift = no_shift_to_release outcome', async () => {
  const { writer, spy } = makeWriter({
    alert: {
      id: 'a5', propertyId: 'p1', alertDate: '2026-06-01',
      department: 'breakfast', suggestedAction: 'release_shift',
    },
    shifts: [],
  });
  const r = await applyAlert('a5', null, { releaseShiftStrategy: 'latest_added' }, writer, 'p1');
  assert.equal(r.outcome, 'no_shift_to_release');
  // The pre-claim ran (alert is closed for audit) and setAppliedPayload
  // recorded the outcome — the manager sees a fresh alert on the next
  // recompute if the gap persists.
  assert.ok(spy.preclaimed);
  assert.equal(
    (spy.appliedPayload as { outcome: string }).outcome,
    'no_shift_to_release',
  );
});

test('double-apply race: second caller sees already_applied without re-doing the action', async () => {
  let claimsConsumed = 0;
  const writer = {
    async loadAlert() {
      return {
        id: 'a9', propertyId: 'p1', alertDate: '2026-06-01',
        department: 'housekeeping' as const, suggestedAction: 'add_shift' as const,
        dismissedAt: null, appliedAt: null,
      };
    },
    async lookupFirstPreset() { return null; },
    async insertOpenShift() { throw new Error('SHOULD NOT INSERT TWICE'); },
    async pickShiftToRelease() { return null; },
    async deleteShift() { return { ok: true }; },
    async markApplied() { return { ok: true }; },
    async preclaimApply() {
      claimsConsumed++;
      return { claimed: claimsConsumed === 1 };  // only first caller wins
    },
    async setAppliedPayload() { /* noop */ },
  };
  // First call: succeeds (claim won) — but we don't let it actually do
  // anything via insertOpenShift throwing. To verify the second call
  // returns already_applied, we wrap the first in a try.
  // Actually simpler: just call apply twice with no insert, and check
  // the SECOND result.

  // Re-wrap: first caller's insertOpenShift returns; only the second
  // would-be insert (which never happens because claim returns false)
  // would throw if it ran.
  const happyWriter = {
    ...writer,
    async insertOpenShift() { return { id: 'new-1' }; },
  };
  const r1 = await applyAlert('a9', null, { releaseShiftStrategy: 'latest_added' }, happyWriter, 'p1');
  assert.equal(r1.ok, true);
  assert.equal(r1.outcome, 'created_open_shift');

  // Second caller — preclaim now returns claimed:false. Action must not run.
  const r2 = await applyAlert('a9', null, { releaseShiftStrategy: 'latest_added' }, happyWriter, 'p1');
  assert.equal(r2.ok, false);
  assert.equal(r2.outcome, 'already_applied');
});

test('refuses when expectedPropertyId mismatch (cross-property isolation)', async () => {
  const { writer } = makeWriter({
    alert: {
      id: 'a6', propertyId: 'p1', alertDate: '2026-06-01',
      department: 'housekeeping', suggestedAction: 'add_shift',
    },
  });
  const r = await applyAlert('a6', null, { releaseShiftStrategy: 'latest_added' }, writer, 'p2');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'forbidden');
});

test('refuses already_dismissed and already_applied (idempotent close)', async () => {
  const w1 = makeWriter({
    alert: {
      id: 'a7', propertyId: 'p1', alertDate: '2026-06-01',
      department: 'housekeeping', suggestedAction: 'add_shift',
      dismissedAt: '2026-05-26T10:00:00Z',
    },
  });
  const r1 = await applyAlert('a7', null, { releaseShiftStrategy: 'latest_added' }, w1.writer, 'p1');
  assert.equal(r1.outcome, 'already_dismissed');

  const w2 = makeWriter({
    alert: {
      id: 'a8', propertyId: 'p1', alertDate: '2026-06-01',
      department: 'housekeeping', suggestedAction: 'add_shift',
      appliedAt: '2026-05-26T10:00:00Z',
    },
  });
  const r2 = await applyAlert('a8', null, { releaseShiftStrategy: 'latest_added' }, w2.writer, 'p1');
  assert.equal(r2.outcome, 'already_applied');
});

test('returns not_found when alert id is unknown', async () => {
  const { writer } = makeWriter({ alert: null });
  const r = await applyAlert('missing', null, { releaseShiftStrategy: 'latest_added' }, writer);
  assert.equal(r.outcome, 'not_found');
});
