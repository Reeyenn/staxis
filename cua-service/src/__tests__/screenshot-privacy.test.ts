/**
 * Tests for cua-service/src/screenshot-privacy.ts — the shared capture
 * primitive that must NEVER emit an unredacted screenshot.
 *
 * The redaction now rides on Playwright's native screenshot `mask`: every
 * call to page.screenshot() carries `mask: [frame.locator(SEL), …]` for EVERY
 * frame, so the black boxes are painted onto the output image as part of the
 * capture. There is no separate "paint overlays then screenshot" step, so the
 * original bug — overlay-add throws but the bare screenshot still fires
 * unredacted — is structurally impossible. These tests pin that:
 *   - EVERY screenshot is taken with a full per-frame mask (never a bare one);
 *   - a screenshot error (navigation race) retries-after-settle, then withholds;
 *   - the per-frame mask count tracks the frame count (so sub-frame/iframe
 *     credentials are masked too);
 *   - the primitive NEVER rejects (page.frames() throwing ⇒ null);
 *   - a hung capture hits the wall-clock deadline and withholds (the late
 *     buffer can never escape);
 *   - the critic path inherits all of the above.
 *
 * The fake Page records the options every screenshot() is called with, so the
 * "always masked" invariant is asserted directly rather than inferred.
 */

// env.ts validates at module load; set placeholders before any transitive load.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-for-tests';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { captureHardenedScreenshot, SENSITIVE_FIELD_SELECTOR } from '../screenshot-privacy.js';
import { captureScreenshotForCritic } from '../critic.js';

// 1×1 transparent PNG — what the fake screenshot() returns on success.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

interface ScreenshotCall {
  maskLen: number;        // number of mask locators (-1 if mask missing)
  maskColor: unknown;
  maskSelectors: string[]; // the selector each mask locator was built from
  fullPage: unknown;
  style: unknown;          // the atomic paint-outside-suppression CSS
}

interface PageState {
  frames: number;                 // how many frames page.frames() returns
  framesThrows?: boolean;         // page.frames() throws (closed page)
  screenshotThrowFirst?: number;  // throw on the first N screenshot calls
  hangScreenshot?: boolean;       // screenshot never resolves (deadline test)
  mutateFrameOnScreenshot?: number; // fire a frame-mutation event DURING the first N captures
  screenshotCalls: number;
  calls: ScreenshotCall[];        // options every screenshot() saw
  waitCalls: number;
}

function pageState(over: Partial<PageState> = {}): PageState {
  return { frames: 1, screenshotCalls: 0, calls: [], waitCalls: 0, ...over };
}

function frameStub(i: number) {
  // Fake Locator — records the selector it was built from.
  return { locator: (sel: string) => ({ __frame: i, __sel: sel }) };
}

function makeFakePage(st: PageState): Page {
  const frameObjs = Array.from({ length: st.frames }, (_unused, i) => frameStub(i));
  const handlers: Record<string, Array<() => void>> = {};
  return {
    frames: () => {
      if (st.framesThrows) throw new Error('Target page, context or browser has been closed');
      return frameObjs;
    },
    on: (ev: string, h: () => void) => {
      (handlers[ev] ??= []).push(h);
    },
    off: (ev: string, h: () => void) => {
      handlers[ev] = (handlers[ev] ?? []).filter((x) => x !== h);
    },
    screenshot: async (opts: {
      mask?: Array<{ __sel: string }>;
      maskColor?: unknown;
      fullPage?: unknown;
      style?: unknown;
    }) => {
      st.screenshotCalls += 1;
      const mask = Array.isArray(opts?.mask) ? opts.mask : null;
      st.calls.push({
        maskLen: mask ? mask.length : -1,
        maskColor: opts?.maskColor,
        maskSelectors: mask ? mask.map((m) => m.__sel) : [],
        fullPage: opts?.fullPage,
        style: opts?.style,
      });
      if (st.hangScreenshot) return new Promise<Buffer>(() => {}); // never resolves
      // Simulate a frame attaching/navigating/detaching DURING this capture —
      // exercises the frame-mutation guard (the guard's listener is registered
      // before this call, so firing it here flips its frameMutated flag).
      if (st.mutateFrameOnScreenshot && st.screenshotCalls <= st.mutateFrameOnScreenshot) {
        for (const h of handlers['frameattached'] ?? []) h();
      }
      if (st.screenshotThrowFirst && st.screenshotCalls <= st.screenshotThrowFirst) {
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      }
      return Buffer.from(TINY_PNG_B64, 'base64');
    },
    waitForTimeout: async (_ms: number) => {
      st.waitCalls += 1;
    },
  } as unknown as Page;
}

/** Asserts a recorded screenshot call carried a complete, black, per-frame mask + the suppression style. */
function assertMaskedCall(call: ScreenshotCall, frames: number) {
  assert.equal(call.maskLen, frames, `screenshot must mask all ${frames} frame(s), never a bare capture`);
  assert.equal(call.maskColor, '#000000', 'mask must be solid black');
  assert.equal(call.fullPage, false, 'viewport screenshot');
  for (const sel of call.maskSelectors) {
    assert.equal(sel, SENSITIVE_FIELD_SELECTOR, 'mask built from the sensitive-field selector');
  }
  assert.equal(typeof call.style, 'string', 'paint-outside-suppression style must be injected');
  assert.match(call.style as string, /overflow:hidden/, 'style clips overflow on sensitive elements');
}

describe('captureHardenedScreenshot — happy path', () => {
  test('returns a Buffer; the screenshot is masked across the frame', async () => {
    const st = pageState();
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.ok(Buffer.isBuffer(result), 'returns a Buffer on success');
    assert.equal(st.screenshotCalls, 1);
    assertMaskedCall(st.calls[0]!, 1);
  });
});

describe('captureHardenedScreenshot — every frame is masked (iframe coverage)', () => {
  test('builds one mask locator PER frame (main + sub-frames)', async () => {
    const st = pageState({ frames: 3 });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.ok(Buffer.isBuffer(result));
    assertMaskedCall(st.calls[0]!, 3); // 3 frames → 3 mask locators → iframe creds covered
  });
});

describe('captureHardenedScreenshot — navigation race', () => {
  test('screenshot throws once then succeeds → returns a Buffer, settled, still masked', async () => {
    const st = pageState({ screenshotThrowFirst: 1 });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.ok(Buffer.isBuffer(result), 'retry-after-settle recovers a transient race');
    assert.equal(st.screenshotCalls, 2);
    assert.ok(st.waitCalls >= 1, 'settled before retrying');
    st.calls.forEach((c) => assertMaskedCall(c, 1)); // BOTH attempts masked — never a bare retry
  });

  test('screenshot throws every attempt → withholds (null), and never took a bare screenshot', async () => {
    const st = pageState({ screenshotThrowFirst: 99 });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.equal(result, null, 'no buffer when a masked image cannot be produced');
    assert.equal(st.screenshotCalls, 3, 'bounded to MAX_ATTEMPTS');
    assert.equal(st.waitCalls, 2, 'settles between attempts (2 gaps for 3 attempts)');
    // The whole point: even the doomed attempts were masked — there is no code
    // path that takes an UNmasked screenshot.
    st.calls.forEach((c) => assertMaskedCall(c, 1));
  });
});

describe('captureHardenedScreenshot — frame-mutation TOCTOU guard', () => {
  test('a frame mutating DURING the capture is discarded, then succeeds on retry', async () => {
    // A frame attaches/navigates during attempt 1's capture (so we can't trust
    // that image); attempt 2 captures a stable tree and returns the buffer.
    const st = pageState({ mutateFrameOnScreenshot: 1 });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.ok(Buffer.isBuffer(result), 'recovers once the frame tree settles');
    assert.equal(st.screenshotCalls, 2, 'first capture discarded, second kept');
    assert.ok(st.waitCalls >= 1, 'settled before retrying');
  });

  test('a page whose frames keep mutating every capture → withholds (null)', async () => {
    const st = pageState({ mutateFrameOnScreenshot: 99 });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.equal(result, null, 'never trust a capture whose frame tree changed under it');
    assert.equal(st.screenshotCalls, 3, 'bounded to MAX_ATTEMPTS');
    // Every attempt was still masked — there is never a bare capture.
    st.calls.forEach((c) => assertMaskedCall(c, st.frames));
  });
});

describe('captureHardenedScreenshot — never rejects', () => {
  test('page.frames() throwing ⇒ resolves to null, does not reject', async () => {
    const st = pageState({ framesThrows: true });
    const result = await captureHardenedScreenshot(makeFakePage(st));
    assert.equal(result, null, 'a closed/throwing page withholds instead of crashing the caller');
    assert.equal(st.screenshotCalls, 0, 'never reached a screenshot');
  });
});

describe('captureHardenedScreenshot — wall-clock deadline', () => {
  test('a hung screenshot is abandoned at the deadline and withholds', async () => {
    const st = pageState({ hangScreenshot: true });
    const start = Date.now();
    const result = await captureHardenedScreenshot(makeFakePage(st), { deadlineMs: 60 });
    const elapsed = Date.now() - start;
    assert.equal(result, null, 'deadline => withhold; the late buffer can never escape');
    assert.ok(elapsed < 2000, `returned promptly at the deadline (took ${elapsed}ms)`);
    // It DID attempt a (masked) capture — it just never came back.
    assert.equal(st.screenshotCalls, 1);
    assertMaskedCall(st.calls[0]!, 1);
  });
});

describe('captureScreenshotForCritic — inherits the masked capture', () => {
  test('returns base64 on success', async () => {
    const st = pageState();
    const result = await captureScreenshotForCritic(makeFakePage(st));
    assert.equal(typeof result, 'string', 'base64 string on success');
    assertMaskedCall(st.calls[0]!, 1);
  });

  test('navigation race (screenshot throws) → returns null, never a bare capture', async () => {
    const st = pageState({ screenshotThrowFirst: 99 });
    const result = await captureScreenshotForCritic(makeFakePage(st));
    assert.equal(result, null, 'critic path withholds on the same race');
    st.calls.forEach((c) => assertMaskedCall(c, 1));
  });
});
