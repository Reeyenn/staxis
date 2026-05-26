import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dismissAlert, type DismissAlertWriter } from '../schedule-reactivity/dismiss-alert';

function makeWriter(state: { found?: boolean; alreadyDismissed?: boolean }): {
  writer: DismissAlertWriter;
  calls: number;
} {
  let calls = 0;
  return {
    get calls() { return calls; },
    writer: {
      async markDismissed() {
        calls++;
        if (!state.found) return { ok: false, alreadyDismissed: false, notFound: true };
        if (state.alreadyDismissed) return { ok: true, alreadyDismissed: true, notFound: false };
        return { ok: true, alreadyDismissed: false, notFound: false };
      },
    },
  };
}

test('first dismiss returns ok=true, alreadyDismissed=false', async () => {
  const w = makeWriter({ found: true });
  const r = await dismissAlert('a1', 'acct-1', w.writer);
  assert.equal(r.ok, true);
  assert.equal(r.alreadyDismissed, false);
  assert.equal(r.notFound, false);
});

test('re-dismiss is idempotent (alreadyDismissed=true, still ok)', async () => {
  const w = makeWriter({ found: true, alreadyDismissed: true });
  const r = await dismissAlert('a1', 'acct-1', w.writer);
  assert.equal(r.ok, true);
  assert.equal(r.alreadyDismissed, true);
});

test('unknown id surfaces notFound=true (not silent ok)', async () => {
  const w = makeWriter({ found: false });
  const r = await dismissAlert('missing', null, w.writer);
  assert.equal(r.ok, false);
  assert.equal(r.notFound, true);
});

test('accepts null accountId (system-initiated dismiss)', async () => {
  const w = makeWriter({ found: true });
  const r = await dismissAlert('a1', null, w.writer);
  assert.equal(r.ok, true);
});
