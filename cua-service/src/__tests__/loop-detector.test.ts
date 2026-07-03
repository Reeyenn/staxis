/**
 * Tests for cua-service/src/loop-detector.ts.
 *
 * Pin the four invariants that make the loop detector load-bearing in
 * mapper.ts: it must trip on genuine loops (same action on same page
 * 4+ times) and must NOT trip on legitimate diversity (different
 * actions, or same action across actual page changes).
 *
 * Pure-function tests — no Playwright, no Anthropic, no DB.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { ActionLoopDetector, actionFingerprint, pageFingerprint } from '../loop-detector.js';

/** Tiny stub of Playwright's Page surface that pageFingerprint uses. */
function fakePage(opts: { url: string; title?: string; bodyText?: string; throwOnEval?: boolean; throwOnUrl?: boolean }): Page {
  return {
    url: () => {
      if (opts.throwOnUrl) throw new Error('page closed');
      return opts.url;
    },
    evaluate: async () => {
      if (opts.throwOnEval) throw new Error('eval failed');
      return { title: opts.title ?? '', bodyText: opts.bodyText ?? '' };
    },
  } as unknown as Page;
}

describe('ActionLoopDetector — not stuck on diverse actions', () => {
  test('different actions on same page do not trip', () => {
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    assert.equal(d.record('left_click:100,200', 'page-A').stuck, false);
    assert.equal(d.record('read_page:interactive', 'page-A').stuck, false);
    assert.equal(d.record('scroll:down:3', 'page-A').stuck, false);
    assert.equal(d.record('find:Reports', 'page-A').stuck, false);
    assert.equal(d.record('left_click:200,300', 'page-A').stuck, false);
  });

  test('three identical (action, page) tuples do NOT trip — legitimate "click 3 rows" pattern', () => {
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    assert.equal(d.record('left_click:520,340', 'page-A').stuck, false);
    assert.equal(d.record('left_click:520,340', 'page-A').stuck, false);
    assert.equal(d.record('left_click:520,340', 'page-A').stuck, false);
  });
});

describe('ActionLoopDetector — stuck when same action repeats on same page', () => {
  test('FOURTH identical (action, page) tuple trips the detector', () => {
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    d.record('left_click:520,340', 'page-A');
    d.record('left_click:520,340', 'page-A');
    d.record('left_click:520,340', 'page-A');
    const verdict = d.record('left_click:520,340', 'page-A');
    assert.equal(verdict.stuck, true);
    assert.match(verdict.reason ?? '', /left_click:520,340/);
    assert.match(verdict.reason ?? '', /4 times/);
  });

  test('trip persists if the same loop continues', () => {
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    for (let i = 0; i < 6; i++) d.record('read_page:interactive', 'page-A');
    const verdict = d.record('read_page:interactive', 'page-A');
    assert.equal(verdict.stuck, true);
  });

  test('custom maxRepeats=1 trips on second identical tuple', () => {
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 1 });
    assert.equal(d.record('left_click:1,1', 'page-A').stuck, false);
    const verdict = d.record('left_click:1,1', 'page-A');
    assert.equal(verdict.stuck, true);
  });
});

describe('ActionLoopDetector — not stuck when action changes', () => {
  test('three rotating actions on same page never trip', () => {
    // With window=8 and 3-action rotation, each action appears at most
    // 3 times in any 8-record window. count > maxRepeats=3 requires 4+,
    // so a 3-cycle stays under threshold indefinitely.
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    const cycle = ['left_click:100,100', 'read_page:interactive', 'scroll:down:3'];
    for (let i = 0; i < 30; i++) {
      assert.equal(d.record(cycle[i % 3]!, 'page-A').stuck, false, `iteration ${i} should not trip`);
    }
  });

  test('two-action alternation eventually trips (each appears 4x in window=8)', () => {
    // Sanity check on the boundary — alternating two actions over a
    // window of 8 means each accumulates 4 hits, which IS more than
    // maxRepeats=3. Codifies the threshold so we don't accidentally
    // change behavior in a future refactor.
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    let tripped = false;
    for (let i = 0; i < 20 && !tripped; i++) {
      const action = i % 2 === 0 ? 'A' : 'B';
      if (d.record(action, 'page-A').stuck) tripped = true;
    }
    assert.equal(tripped, true, 'two-action alternation should eventually trip');
  });
});

describe('ActionLoopDetector — not stuck when page changes', () => {
  test('same action on different pages never trips', () => {
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    assert.equal(d.record('left_click:520,340', 'page-A').stuck, false);
    assert.equal(d.record('left_click:520,340', 'page-B').stuck, false);
    assert.equal(d.record('left_click:520,340', 'page-C').stuck, false);
    assert.equal(d.record('left_click:520,340', 'page-D').stuck, false);
    assert.equal(d.record('left_click:520,340', 'page-E').stuck, false);
  });

  test('returning to a prior page resumes counting toward the threshold', () => {
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    d.record('left_click:1,1', 'page-A');     // 1
    d.record('left_click:1,1', 'page-B');     // page-A count: 1
    d.record('left_click:1,1', 'page-A');     // page-A count: 2
    d.record('left_click:1,1', 'page-A');     // page-A count: 3
    const verdict = d.record('left_click:1,1', 'page-A'); // page-A count: 4 → trip
    assert.equal(verdict.stuck, true);
  });
});

describe('ActionLoopDetector — window eviction', () => {
  test('old records age out of the window so prior A-spam no longer counts', () => {
    const d = new ActionLoopDetector({ windowSize: 4, maxRepeats: 3 });
    // Prime with 3 A's. No trip (count=3, not > 3).
    d.record('A', 'page');
    d.record('A', 'page');
    d.record('A', 'page');
    // Push 4 different records — window=4 means the original A's get evicted.
    d.record('X', 'page');
    d.record('Y', 'page');
    d.record('Z', 'page');
    d.record('W', 'page');
    // Window is now [X,Y,Z,W]. A's count back to 0.
    // First fresh A: window becomes [Y,Z,W,A], A count=1. If old A's were
    // still in scope, count would be 4 → trip. Assertion that this does
    // NOT trip is the load-bearing part of this test.
    assert.equal(d.record('A', 'page').stuck, false);
    // 2nd, 3rd fresh A — count rises to 2, 3. Still no trip.
    assert.equal(d.record('A', 'page').stuck, false);
    assert.equal(d.record('A', 'page').stuck, false);
    // 4th fresh A — count=4 > maxRepeats=3 → DOES trip. (Window holds
    // [A,A,A,A]; no false-negative either.)
    assert.equal(d.record('A', 'page').stuck, true);
  });
});

describe('actionFingerprint — vision (computer_20251124) action shapes', () => {
  test('left_click with coordinate is stable (quantized to 16px buckets)', () => {
    const fp1 = actionFingerprint({ action: 'left_click', coordinate: [520, 340] });
    const fp2 = actionFingerprint({ action: 'left_click', coordinate: [520, 340] });
    assert.equal(fp1, fp2);
    // 520/16=32.5→33, 340/16=21.25→21. Coordinates snap to a coarse grid so
    // a few pixels of model jitter on the same control collapse together.
    assert.equal(fp1, 'left_click:33,21');
  });

  test('left_click at far-apart coords produces different fingerprints', () => {
    const fp1 = actionFingerprint({ action: 'left_click', coordinate: [100, 200] });
    const fp2 = actionFingerprint({ action: 'left_click', coordinate: [100, 300] });
    assert.notEqual(fp1, fp2);
  });

  test('double_click separate from left_click', () => {
    const fp1 = actionFingerprint({ action: 'left_click', coordinate: [10, 10] });
    const fp2 = actionFingerprint({ action: 'double_click', coordinate: [10, 10] });
    assert.notEqual(fp1, fp2);
  });

  test('scroll with direction + amount is stable', () => {
    const fp1 = actionFingerprint({ action: 'scroll', coordinate: [0, 0], scroll_direction: 'down', scroll_amount: 3 });
    const fp2 = actionFingerprint({ action: 'scroll', coordinate: [99, 99], scroll_direction: 'down', scroll_amount: 3 });
    // Coordinate ignored for scroll — direction + amount is what matters.
    assert.equal(fp1, fp2);
  });

  test('type action includes text', () => {
    const fp1 = actionFingerprint({ action: 'type', text: '$username' });
    const fp2 = actionFingerprint({ action: 'type', text: '$password' });
    assert.notEqual(fp1, fp2);
  });

  test('screenshot is a fixed fingerprint', () => {
    const fp1 = actionFingerprint({ action: 'screenshot' });
    const fp2 = actionFingerprint({ action: 'screenshot' });
    assert.equal(fp1, fp2);
    assert.equal(fp1, 'screenshot');
  });
});

describe('actionFingerprint — coordinate jitter & Set-of-Mark badge tokens', () => {
  test('same-badge clicks with jittered coordinates share ONE fingerprint', () => {
    // executeVisionAction resolves `text: "#N"` to the stored badge center
    // and ignores the raw coordinate, so a re-click of the same ineffective
    // badge with per-turn model jitter is the SAME action. The fingerprint
    // must collapse on the badge token, not the pixel guess.
    const fp1 = actionFingerprint({ action: 'left_click', coordinate: [642, 318], text: '#7' });
    const fp2 = actionFingerprint({ action: 'left_click', coordinate: [640, 320], text: '#7' });
    const fp3 = actionFingerprint({ action: 'left_click', coordinate: [641, 319], text: '#7' });
    assert.equal(fp1, fp2);
    assert.equal(fp2, fp3);
    assert.equal(fp1, 'left_click:#7');
  });

  test('clicks on genuinely different badges still differ', () => {
    const fp7 = actionFingerprint({ action: 'left_click', coordinate: [642, 318], text: '#7' });
    const fp8 = actionFingerprint({ action: 'left_click', coordinate: [642, 318], text: '#8' });
    assert.notEqual(fp7, fp8);
  });

  test('badge token takes precedence over a wildly different coordinate', () => {
    // Even if the model guesses very different pixels, the same badge is the
    // same semantic click.
    const fp1 = actionFingerprint({ action: 'left_click', coordinate: [10, 10], text: '#3' });
    const fp2 = actionFingerprint({ action: 'left_click', coordinate: [900, 700], text: '#3' });
    assert.equal(fp1, fp2);
  });

  test('same-control clicks with pixel jitter (no badge) share ONE fingerprint', () => {
    // Pure-coordinate path: three clicks within a ~16px cell of each other
    // must quantize to the same bucket.
    const fp1 = actionFingerprint({ action: 'left_click', coordinate: [642, 318] });
    const fp2 = actionFingerprint({ action: 'left_click', coordinate: [640, 320] });
    const fp3 = actionFingerprint({ action: 'left_click', coordinate: [641, 319] });
    assert.equal(fp1, fp2);
    assert.equal(fp2, fp3);
  });

  test('a stuck agent re-clicking one badge with jitter TRIPS the detector', () => {
    // End-to-end: the failure the finding describes. Badge #7 on a feed that
    // never changes; the model sends slightly different coordinates each turn
    // (with screenshots interleaved). The 4th same-badge click must trip
    // instead of grinding to the per-target cost cap.
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    const jitter = [[642, 318], [640, 320], [641, 319], [643, 317]] as const;
    let tripped = false;
    for (const [x, y] of jitter) {
      const clickFp = actionFingerprint({ action: 'left_click', coordinate: [x, y], text: '#7' });
      if (d.record(clickFp, 'stuck-feed').stuck) tripped = true;
      // interleave the screenshot the model needs to re-read the unchanged page
      d.record(actionFingerprint({ action: 'screenshot' }), 'stuck-feed');
    }
    assert.equal(tripped, true, 'jittered same-badge clicks must trip the loop-abort');
  });

  test('clicks on FAR-APART controls do NOT trip (bucketing is not over-broad)', () => {
    // Guard the other direction: clicking four distinct controls (each >16px
    // apart) must NOT be misread as a loop.
    const d = new ActionLoopDetector({ windowSize: 8, maxRepeats: 3 });
    const spots = [[100, 100], [300, 300], [500, 500], [700, 100]] as const;
    let tripped = false;
    for (const [x, y] of spots) {
      const fp = actionFingerprint({ action: 'left_click', coordinate: [x, y] });
      if (d.record(fp, 'page-A').stuck) tripped = true;
    }
    assert.equal(tripped, false, 'clicks on distinct far-apart controls must not trip');
  });

  test('left_click_drag coordinates are quantized too', () => {
    // Pick values mid-cell (well away from a 16px boundary) so ±2px stays in
    // the same bucket: 100/16=6.25, 292/16=18.25, 404/16=25.25, 196/16=12.25.
    const fp1 = actionFingerprint({ action: 'left_click_drag', start_coordinate: [100, 292], coordinate: [404, 196] });
    const fp2 = actionFingerprint({ action: 'left_click_drag', start_coordinate: [102, 294], coordinate: [406, 198] });
    assert.equal(fp1, fp2, 'a drag from/to the same ~16px cells is the same action');
  });
});

// (Plan v8 D.2 removed DOM-tool action shapes — read_page / find /
// form_input / navigate / ref-based clicks no longer flow through the
// pipeline. actionFingerprint() is still shape-generic for safety, but
// the only live caller is the vision tool.)

describe('pageFingerprint', () => {
  test('combines URL, title, and body-text hash deterministically', async () => {
    const page = fakePage({ url: 'https://pms.example/reports', title: 'Reports', bodyText: 'Daily revenue 2026-05-25' });
    const fp1 = await pageFingerprint(page);
    const fp2 = await pageFingerprint(page);
    assert.equal(fp1, fp2);
    assert.match(fp1, /^https:\/\/pms\.example\/reports::Reports::[a-f0-9]+$/);
  });

  test('different URLs produce different fingerprints', async () => {
    const a = fakePage({ url: 'https://pms/a', title: 'X', bodyText: 'Y' });
    const b = fakePage({ url: 'https://pms/b', title: 'X', bodyText: 'Y' });
    assert.notEqual(await pageFingerprint(a), await pageFingerprint(b));
  });

  test('different body text produces different fingerprints (same URL)', async () => {
    const a = fakePage({ url: 'https://pms/x', title: 'X', bodyText: 'first content' });
    const b = fakePage({ url: 'https://pms/x', title: 'X', bodyText: 'second content' });
    assert.notEqual(await pageFingerprint(a), await pageFingerprint(b));
  });

  test('evaluate failure falls back to URL-only fingerprint (still URL-stable)', async () => {
    const a = fakePage({ url: 'https://pms/y', throwOnEval: true });
    const b = fakePage({ url: 'https://pms/y', throwOnEval: true });
    assert.equal(await pageFingerprint(a), await pageFingerprint(b),
      'two URL-only fallbacks on the same URL should match — needed so a loop on a broken page CAN still trip');
  });

  test('page.url() throwing returns closed-page constant', async () => {
    const a = fakePage({ url: '', throwOnUrl: true });
    const b = fakePage({ url: '', throwOnUrl: true });
    const fpA = await pageFingerprint(a);
    const fpB = await pageFingerprint(b);
    assert.equal(fpA, 'closed-page');
    assert.equal(fpB, 'closed-page');
  });

  test('two turns differing ONLY by a clock time produce the same fingerprint (so a stuck feed can trip)', async () => {
    // A page with a live clock changes its body text every turn. Without
    // volatile-token stripping, a genuinely-stuck feed would never trip
    // the loop-abort. These two must fingerprint EQUAL.
    const a = fakePage({ url: 'https://pms/dash', title: 'Dashboard', bodyText: 'Rooms clean: 42  Current time 3:04:05 pm' });
    const b = fakePage({ url: 'https://pms/dash', title: 'Dashboard', bodyText: 'Rooms clean: 42  Current time 3:04:06 pm' });
    assert.equal(await pageFingerprint(a), await pageFingerprint(b),
      'a live clock must not change the fingerprint');
  });

  test('two turns differing ONLY by a "last refreshed" timestamp fingerprint equal', async () => {
    const a = fakePage({ url: 'https://pms/dash', title: 'Dashboard', bodyText: 'Occupancy 88%\nLast refreshed: 2026-06-30 14:22:01' });
    const b = fakePage({ url: 'https://pms/dash', title: 'Dashboard', bodyText: 'Occupancy 88%\nLast refreshed: 2026-06-30 14:23:47' });
    assert.equal(await pageFingerprint(a), await pageFingerprint(b),
      'a rotating "last refreshed" timestamp must not change the fingerprint');
  });

  test('two turns differing ONLY by a rotating long counter fingerprint equal', async () => {
    const a = fakePage({ url: 'https://pms/dash', title: 'Dashboard', bodyText: 'Session token 100045 · queue idle' });
    const b = fakePage({ url: 'https://pms/dash', title: 'Dashboard', bodyText: 'Session token 998877 · queue idle' });
    assert.equal(await pageFingerprint(a), await pageFingerprint(b),
      'a rotating long digit run must not change the fingerprint');
  });

  test('REAL content changes still produce different fingerprints (stripping is not over-broad)', async () => {
    // Guard against the strip being so aggressive it masks genuine
    // navigation. Same clock, different real content → must differ.
    const a = fakePage({ url: 'https://pms/dash', title: 'Dashboard', bodyText: 'Arrivals list — Smith, Jones  3:04 pm' });
    const b = fakePage({ url: 'https://pms/dash', title: 'Dashboard', bodyText: 'Departures list — Lee, Kim  3:04 pm' });
    assert.notEqual(await pageFingerprint(a), await pageFingerprint(b),
      'a genuine content change must still change the fingerprint');
  });
});

describe('actionFingerprint — robustness', () => {
  test('null/undefined input does not throw', () => {
    assert.doesNotThrow(() => actionFingerprint(null));
    assert.doesNotThrow(() => actionFingerprint(undefined));
  });

  test('object without action field falls through to "unknown"', () => {
    const fp = actionFingerprint({ foo: 'bar' });
    assert.equal(fp, 'unknown');
  });

  test('unknown action type returns the action name verbatim', () => {
    const fp = actionFingerprint({ action: 'future_action_v2' });
    assert.equal(fp, 'future_action_v2');
  });
});
