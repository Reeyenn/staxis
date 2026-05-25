/**
 * One-off benchmark — CDP snapshot vs legacy Playwright DOM_SCRIPT.
 *
 * Run with: tsx cua-service/scripts/bench-cdp-snapshot.ts
 *
 * Boots Chromium against a few representative pages and prints timing for
 * each path. Delete after the CDP refactor lands; this exists only to back
 * the speedup claim in the PR description.
 */

import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env BEFORE importing modules that pull env.ts at module-init.
loadEnv({ path: join(__dirname, '..', '..', '.env.local'), override: true });

const DOM_SCRIPT = readFileSync(
  join(__dirname, '..', 'src', 'browser-utils', 'dom.js'),
  'utf-8',
);

interface BenchResult {
  url: string;
  cdpMs: number;
  legacyMs: number;
  cdpYamlLines: number;
  legacyYamlLines: number;
  cdpSpeedupPct: number;
}

async function bench(url: string): Promise<BenchResult> {
  const { chromium } = await import('playwright');
  const { captureCDPSnapshot } = await import('../src/cdp-snapshot.js');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(750);

    // Warm both paths so the timing run isn't biased by first-call costs.
    await captureCDPSnapshot(page);
    await page.evaluate(`(() => { ${DOM_SCRIPT}; return window.__generateAccessibilityTree(''); })()`);

    // Run each side 3 times and take the median so we don't get fooled by a
    // single slow GC tick.
    const cdpRuns: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await captureCDPSnapshot(page);
      cdpRuns.push(Date.now() - t0);
    }
    cdpRuns.sort((a, b) => a - b);
    const cdpMs = cdpRuns[1];
    const cdp = await captureCDPSnapshot(page);

    const legacyRuns: number[] = [];
    let tree: { pageContent?: string } = {};
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      tree = (await page.evaluate(
        `(() => { ${DOM_SCRIPT}; return window.__generateAccessibilityTree(''); })()`,
      )) as { pageContent?: string };
      legacyRuns.push(Date.now() - t0);
    }
    legacyRuns.sort((a, b) => a - b);
    const legacyMs = legacyRuns[1];

    const cdpYaml = 'error' in cdp ? '' : cdp.pageContent;
    const legacyYaml = tree.pageContent ?? '';
    const cdpYamlLines = cdpYaml.split('\n').length;
    const legacyYamlLines = legacyYaml.split('\n').length;
    const cdpSpeedupPct = legacyMs > 0 ? Math.round((1 - cdpMs / legacyMs) * 100) : 0;
    if (!('error' in cdp)) {
      console.log(`    [cdp breakdown] fetch=${cdp.fetchMs}ms render=${cdp.renderMs}ms`);
    }
    return { url, cdpMs, legacyMs, cdpYamlLines, legacyYamlLines, cdpSpeedupPct };
  } finally {
    await ctx.close();
    await browser.close();
  }
}

async function main(): Promise<void> {
  const urls = [
    'https://example.com',
    'https://en.wikipedia.org/wiki/Hotel',
    'https://news.ycombinator.com',
    'https://stackoverflow.com/questions/tagged/javascript',
    'https://github.com/microsoft/playwright/issues',
  ];

  console.log('| URL | CDP (ms) | Legacy (ms) | CDP speedup | CDP lines | Legacy lines |');
  console.log('|---|---|---|---|---|---|');
  for (const url of urls) {
    try {
      const r = await bench(url);
      console.log(`| ${r.url} | ${r.cdpMs} | ${r.legacyMs} | ${r.cdpSpeedupPct}% | ${r.cdpYamlLines} | ${r.legacyYamlLines} |`);
    } catch (err) {
      console.log(`| ${url} | FAIL | FAIL | - | - | - | (${(err as Error).message})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
