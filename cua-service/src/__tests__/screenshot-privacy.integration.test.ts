/**
 * Real-Chromium pixel test for the PRODUCTION captureHardenedScreenshot.
 *
 * The unit tests (screenshot-privacy.test.ts) mock the browser and prove the
 * CONTRACT is requested (every screenshot carries a per-frame black mask + the
 * suppression style, retries/withholds, never rejects). This test proves
 * Playwright actually HONORS it: it captures a fixture containing a credential
 * field in four adversarial positions and asserts each renders solid black in
 * the returned PNG, while a control background pixel does not.
 *
 *   1. a normal top-level input[type=password]
 *   2. a password inside an open <dialog> (TOP LAYER — renders above any
 *      z-index; the old DOM-overlay approach could not cover this)
 *   3. a password inside a cross-origin iframe
 *   4. a .ssn div with overflow:visible text that bleeds past its box (the
 *      paint-outside-box vector the injected style suppresses)
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

// Inner iframe document (opaque/cross-origin to the parent data: URL).
const IFRAME_HTML =
  '<body style="margin:0;background:white">' +
  '<input type=password id=ifp style="position:absolute;left:5px;top:5px;width:180px;height:24px;background:white" value=IFRAMESECRET>' +
  '</body>';

const FIXTURE_HTML = `
<!DOCTYPE html><html><head><title>privacy fixture</title></head>
<body style="margin:0;padding:0;background:white;">
  <input type=password id=top style="position:absolute;left:10px;top:10px;width:200px;height:28px;background:white" value=TOPSECRET>
  <dialog id=dlg open style="position:absolute;left:10px;top:60px;margin:0;padding:0;border:0;background:white">
    <input type=password id=modal style="width:200px;height:28px;background:white" value=MODALSECRET>
  </dialog>
  <div class=ssn style="position:absolute;left:10px;top:120px;width:24px;height:20px;overflow:visible;white-space:nowrap;background:white">123-45-6789-BLEED-OUTSIDE</div>
  <iframe id=f src="data:text/html,${encodeURIComponent(IFRAME_HTML)}" style="position:absolute;left:10px;top:170px;width:200px;height:40px;border:0"></iframe>
  <button id=safe style="position:absolute;left:250px;top:10px">Visible button</button>
</body></html>`;

const FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE_HTML)}`;

let browser: Browser | null = null;
let page: Page | null = null;
let launchFailed = false;

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 320, height: 240 } });
    page = await ctx.newPage();
    await page.goto(FIXTURE_URL);
    await page.waitForTimeout(250); // let the iframe load
  } catch {
    launchFailed = true; // no browser available — tests below skip
  }
});

after(async () => {
  if (browser) await browser.close();
});

/** Sample RGB at (x,y) from a base64 PNG by drawing it to a canvas in-page. */
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

describe('captureHardenedScreenshot — real-browser pixel redaction', () => {
  test('blacks out credential fields in normal, top-layer, iframe, and overflow positions', async (t) => {
    if (launchFailed || !page) {
      t.skip('Chromium not available');
      return;
    }
    const buf = await captureHardenedScreenshot(page);
    assert.ok(buf && Buffer.isBuffer(buf), 'produced a (masked) screenshot buffer');

    const px = await sample(page, buf!.toString('base64'), {
      topField: [110, 24], // center of #top password
      modalField: [110, 74], // center of #modal password inside <dialog> (top layer)
      ssnBleed: [120, 130], // where the .ssn overflow text WOULD paint past its 24px box
      iframeField: [110, 190], // center of the cross-origin iframe's password
      background: [300, 230], // empty control area
    });

    assert.ok(isBlack(px.topField!), `top-level password must be black, got ${px.topField}`);
    assert.ok(isBlack(px.modalField!), `top-layer <dialog> password must be black, got ${px.modalField}`);
    assert.ok(isBlack(px.iframeField!), `cross-origin iframe password must be black, got ${px.iframeField}`);
    assert.ok(
      !isBlack(px.background!),
      `control background must NOT be black (mask isn't over-covering), got ${px.background}`,
    );
    // The overflow SSN text that bled past its box must NOT be visible there —
    // the injected style clips it, so the bleed area reads as background (or is
    // itself masked), never credential text.
    assert.ok(
      isBlack(px.ssnBleed!) || px.ssnBleed === '255,255,255',
      `ssn overflow must be clipped/masked (black or background), got ${px.ssnBleed}`,
    );
  });
});
