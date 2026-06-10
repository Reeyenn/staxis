/**
 * Tests for cua-service/src/screenshot-privacy.ts — the shared, gated capture
 * primitive that must NEVER let an unredacted screenshot reach Claude/storage.
 *
 * The headline invariant these pin down (the bug that motivated the rewrite):
 *   overlay-add throws ("Execution context was destroyed … navigation") BUT
 *   the screenshot would otherwise succeed  ⇒  NO buffer is returned and the
 *   screenshot is never even taken. The old code swallowed the overlay error
 *   and shipped the unredacted frame.
 *
 * Plus the defenses layered on top:
 *   - retry-after-settle recovers a transient race without withholding
 *   - post-capture geometric verify discards a frame that drifted/navigated
 *     between paint and capture (verify reports uncovered > 0)
 *   - fail-closed: a verify that throws ⇒ withhold
 *   - screenshot error ⇒ withhold, cleanup still runs
 *   - per-frame coverage: a sensitive field uncovered in a SUB-frame ⇒ withhold
 *   - the critic path (captureScreenshotForCritic) inherits all of the above
 *
 * The fake Page never runs the real DOM code — it dispatches each
 * `frame.evaluate(fn)` by inspecting the function source: it contains
 * `appendChild` → paint, `remove(` → cleanup, otherwise → verify. This mirrors
 * the real call sites without needing a browser, so the SEQUENCE
 * (paint → screenshot → verify → cleanup) and the gating are what get asserted.
 */

// env.ts validates at module load; set placeholders before any transitive load.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-for-tests';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { captureHardenedScreenshot } from '../screenshot-privacy.js';
import { captureScreenshotForCritic } from '../critic.js';

// 1×1 transparent PNG — what the fake screenshot() returns.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

interface FrameState {
  /** Ordered ops this frame observed: 'paint' | 'verify' | 'cleanup'. */
  ops: string[];
  /** Throw on the first N paint evaluates (simulates a navigation race). */
  paintThrowFirst?: number;
  paintCallCount: number;
  /** What verify reports as uncovered sensitive-field count (default 0 = safe). */
  verifyUncovered?: number;
  /** Make the verify evaluate throw (context torn down mid-read). */
  verifyThrows?: boolean;
}

interface PageState {
  frames: FrameState[]; // frames[0] is the main frame
  screenshotThrows?: boolean;
  screenshotCalls: number;
  waitCalls: number;
}

function frameState(over: Partial<FrameState> = {}): FrameState {
  return { ops: [], paintCallCount: 0, ...over };
}

function makeFakePage(state: PageState): Page {
  const frameObjs = state.frames.map((fs) => ({
    evaluate: async (fn: unknown, _arg?: unknown) => {
      const src = String(fn);
      if (src.includes('appendChild')) {
        fs.ops.push('paint');
        fs.paintCallCount += 1;
        if (fs.paintThrowFirst && fs.paintCallCount <= fs.paintThrowFirst) {
          throw new Error('Execution context was destroyed, most likely because of a navigation');
        }
        return undefined;
      }
      if (src.includes('remove(')) {
        fs.ops.push('cleanup');
        return undefined;
      }
      // verify
      fs.ops.push('verify');
      if (fs.verifyThrows) throw new Error('verify: context destroyed');
      return fs.verifyUncovered ?? 0;
    },
  }));
  return {
    frames: () => frameObjs,
    mainFrame: () => frameObjs[0],
    screenshot: async (_opts?: unknown) => {
      state.screenshotCalls += 1;
      if (state.screenshotThrows) throw new Error('screenshot failed');
      return Buffer.from(TINY_PNG_B64, 'base64');
    },
    waitForTimeout: async (_ms: number) => {
      state.waitCalls += 1;
    },
  } as unknown as Page;
}

function pageState(over: Partial<PageState> = {}): PageState {
  return { frames: [frameState()], screenshotCalls: 0, waitCalls: 0, ...over };
}

describe('captureHardenedScreenshot — happy path', () => {
  test('returns a PNG Buffer; sequence is paint → screenshot → verify → cleanup', async () => {
    const st = pageState();
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.ok(Buffer.isBuffer(result), 'returns a Buffer on a clean capture');
    assert.equal(st.screenshotCalls, 1, 'screenshot taken exactly once');
    assert.deepEqual(st.frames[0]!.ops, ['paint', 'verify', 'cleanup'],
      'paint, then (screenshot), then verify-coverage, then cleanup');
  });
});

describe('captureHardenedScreenshot — THE navigation race (overlay-add throws, screenshot would succeed)', () => {
  test('withholds: returns null AND never takes the screenshot', async () => {
    const st = pageState({ frames: [frameState({ paintThrowFirst: 99 })] });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.equal(result, null, 'no buffer when overlays can never be applied');
    assert.equal(st.screenshotCalls, 0,
      'screenshot must NOT run when redaction failed — no unredacted buffer can exist');
    // Each of the 3 attempts paints (throws) then cleans up; never verifies.
    assert.equal(st.frames[0]!.ops.filter((o) => o === 'paint').length, 3, 'bounded to 3 attempts');
    assert.equal(st.frames[0]!.ops.filter((o) => o === 'cleanup').length, 3, 'cleanup runs every attempt');
    assert.ok(!st.frames[0]!.ops.includes('verify'), 'never reaches verify (no capture happened)');
    assert.equal(st.waitCalls, 2, 'settles between attempts (2 gaps for 3 attempts), then gives up');
  });
});

describe('captureHardenedScreenshot — retry-after-settle recovers a transient race', () => {
  test('paint throws once then succeeds → returns a Buffer, settle happened', async () => {
    const st = pageState({ frames: [frameState({ paintThrowFirst: 1 })] });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.ok(Buffer.isBuffer(result), 'recovers without withholding');
    assert.equal(st.screenshotCalls, 1, 'one successful capture on attempt 2');
    assert.ok(st.waitCalls >= 1, 'settled at least once before retrying');
    assert.deepEqual(st.frames[0]!.ops, ['paint', 'cleanup', 'paint', 'verify', 'cleanup']);
  });
});

describe('captureHardenedScreenshot — post-capture drift (TOCTOU between paint and capture)', () => {
  test('screenshot SUCCEEDS but verify reports uncovered → discard, returns null', async () => {
    const st = pageState({ frames: [frameState({ verifyUncovered: 1 })] });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.equal(result, null, 'a captured-but-unverified frame is discarded, never returned');
    assert.ok(st.screenshotCalls >= 1, 'capture DID happen — proving discard is post-capture, not instead-of');
    assert.ok(st.frames[0]!.ops.includes('verify'), 'verify ran');
    assert.ok(st.frames[0]!.ops.includes('cleanup'), 'overlays cleaned up');
  });
});

describe('captureHardenedScreenshot — fail-closed verify', () => {
  test('verify evaluate throws → returns null (treats unknown coverage as unsafe)', async () => {
    const st = pageState({ frames: [frameState({ verifyThrows: true })] });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.equal(result, null, 'a verify we cannot trust ⇒ withhold');
    assert.ok(st.frames[0]!.ops.includes('cleanup'), 'cleanup still runs');
  });
});

describe('captureHardenedScreenshot — screenshot error', () => {
  test('screenshot throws → returns null, cleanup runs, verify skipped', async () => {
    const st = pageState({ screenshotThrows: true });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.equal(result, null);
    assert.ok(st.frames[0]!.ops.includes('cleanup'), 'cleanup runs even when screenshot throws');
    assert.ok(!st.frames[0]!.ops.includes('verify'), 'no verify after a failed capture');
  });
});

describe('captureHardenedScreenshot — per-frame coverage (iframe leak)', () => {
  test('a sensitive field uncovered in a SUB-frame ⇒ withhold the whole frame', async () => {
    const st = pageState({
      frames: [frameState(), frameState({ verifyUncovered: 1 })], // main covered, sub leaks
    });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.equal(result, null, 'an iframe with an unmasked credential field must not be sent');
    assert.ok(st.frames[1]!.ops.includes('verify'), 'the sub-frame was actually checked');
  });
});

describe('captureScreenshotForCritic — inherits the gate', () => {
  test('returns base64 on a clean capture', async () => {
    const st = pageState();
    const result = await captureScreenshotForCritic(makeFakePage(st));
    assert.equal(typeof result, 'string', 'base64 string on success');
  });

  test('navigation race (paint throws) → returns null AND no screenshot taken', async () => {
    const st = pageState({ frames: [frameState({ paintThrowFirst: 99 })] });
    const result = await captureScreenshotForCritic(makeFakePage(st));
    assert.equal(result, null, 'critic path withholds on the same race');
    assert.equal(st.screenshotCalls, 0, 'critic never captures an unredacted frame');
  });
});
