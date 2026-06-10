/**
 * Real-Chromium pixel test for the PRODUCTION captureHardenedScreenshot.
 *
 * The unit tests (screenshot-privacy.test.ts) mock the browser and prove the
 * CONTRACT is requested (every screenshot carries a per-frame black mask + the
 * suppression style, retries/withholds, never rejects). This test proves
 * Playwright actually HONORS it: it captures a fixture containing a credential
 * field in five adversarial positions and asserts each renders solid black (or,
 * for overflow, is clipped away) in the returned PNG, while a control
 * background pixel does not.
 *
 *   1. a normal top-level input[type=password]
 *   2. a password inside an open <dialog> (TOP LAYER — renders above any
 *      z-index; the old DOM-overlay approach could not cover this)
 *   3. a password inside a cross-origin iframe
 *   4. a .ssn div with overflow:visible text that bleeds past its box, in the
 *      TOP document (the injected style must clip the bleed)
 *   5. the same overflow .ssn but INSIDE the cross-origin iframe (the style
 *      must pierce the frame — Playwright applies screenshot `style` to inner
 *      frames)
 *
 * Skips cleanly if Chromium can't launch (keeps non-browser CI green).
 */

// env.ts validates at module load — same inline shim as set-of-mark.test.ts.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-for-tests';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { captureHardenedScreenshot } from '../screenshot-privacy.js';

// Inner iframe document (opaque/cross-origin to the parent data: URL): a
// password AND an overflow .ssn whose text bleeds well past its 24px box.
const IFRAME_HTML =
  '<body style="margin:0;background:white">' +
  '<input type=password id=ifp style="position:absolute;left:5px;top:5px;width:180px;height:24px;background:white" value=IFRAMESECRET>' +
  '<div class=ssn style="position:absolute;left:5px;top:40px;width:24px;height:16px;overflow:visible;white-space:nowrap;background:white">999-88-7777-IFRAME-BLEED</div>' +
  '</body>';

const FIXTURE_HTML = `
<!DOCTYPE html><html><head><title>privacy fixture</title></head>
<body style="margin:0;padding:0;background:white;">
  <input type=password id=top style="position:absolute;left:10px;top:10px;width:200px;height:28px;background:white" value=TOPSECRET>
  <dialog id=dlg open style="position:absolute;left:10px;top:60px;margin:0;padding:0;border:0;background:white">
    <input type=password id=modal style="width:200px;height:28px;background:white" value=MODALSECRET>
  </dialog>
  <div class=ssn style="position:absolute;left:10px;top:120px;width:24px;height:20px;overflow:visible;white-space:nowrap;background:white">123-45-6789-TOP-BLEED</div>
  <iframe id=f src="data:text/html,${encodeURIComponent(IFRAME_HTML)}" style="position:absolute;left:10px;top:160px;width:240px;height:90px;border:0"></iframe>
  <button id=safe style="position:absolute;left:260px;top:10px">Visible button</button>
</body></html>`;

const FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE_HTML)}`;

let browser: Browser | null = null;
let page: Page | null = null;
let launchFailed = false;

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 320, height: 280 } });
    page = await ctx.newPage();
    await page.goto(FIXTURE_URL);
    await page.waitForTimeout(300); // let the iframe load
  } catch {
    launchFailed = true; // no browser available — test below skips
  }
});

after(async () => {
  if (browser) await browser.close();
});

/** Sample RGB at each point from a base64 PNG by drawing it to a canvas in-page. */
async function sample(p: Page, b64: string, points: Record<string, [number, number]>) {
  return p.evaluate(
    async ({ data, pts }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = 'data:image/png;base64,' + data;
      });
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const out: Record<string, string> = {};
      for (const [k, [x, y]] of Object.entries(pts)) {
        const d = g.getImageData(x, y, 1, 1).data;
        out[k] = `${d[0]},${d[1]},${d[2]}`;
      }
      return out;
    },
    { data: b64, pts: points },
  );
}

function isBlack(rgb: string): boolean {
  const [r, g, b] = rgb.split(',').map(Number);
  return r! < 25 && g! < 25 && b! < 25;
}
/** Redacted = either masked black OR clipped away to background (no credential pixels). */
function isRedacted(rgb: string): boolean {
  return isBlack(rgb) || rgb === '255,255,255';
}

describe('captureHardenedScreenshot — real-browser pixel redaction', () => {
  test('blacks out / clips credential fields in normal, top-layer, iframe, and overflow positions', async (t) => {
    if (launchFailed || !page) {
      t.skip('Chromium not available');
      return;
    }
    const buf = await captureHardenedScreenshot(page);
    assert.ok(buf && Buffer.isBuffer(buf), 'produced a (masked) screenshot buffer');

    const px = await sample(page, buf!.toString('base64'), {
      topField: [110, 24], // #top password
      modalField: [110, 74], // #modal password inside <dialog> (top layer)
      topSsnBleed: [120, 130], // where #top .ssn overflow text would bleed past its box
      iframeField: [105, 177], // cross-origin iframe password (#ifp)
      iframeSsnBleed: [130, 208], // iframe .ssn overflow bleed (tests style piercing the frame)
      background: [300, 270], // empty control area
    });

    assert.ok(isBlack(px.topField!), `top-level password must be black, got ${px.topField}`);
    assert.ok(isBlack(px.modalField!), `top-layer <dialog> password must be black, got ${px.modalField}`);
    assert.ok(isBlack(px.iframeField!), `cross-origin iframe password must be black, got ${px.iframeField}`);
    assert.ok(
      isRedacted(px.topSsnBleed!),
      `top-doc .ssn overflow must be clipped/masked, got ${px.topSsnBleed}`,
    );
    assert.ok(
      isRedacted(px.iframeSsnBleed!),
      `iframe .ssn overflow must be clipped/masked (style pierces frames), got ${px.iframeSsnBleed}`,
    );
    assert.ok(
      !isBlack(px.background!),
      `control background must NOT be black (mask isn't over-covering), got ${px.background}`,
    );
  });
});
