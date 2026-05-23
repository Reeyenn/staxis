/**
 * CSV download extractor.
 *
 * Used for Choice Advantage's Housekeeping Check-off List report — and
 * for any PMS that produces tabular data via a CSV button on a report
 * page. Sequence:
 *
 *   1. Navigate to the report page (if feedSpec.url is set).
 *   2. Optionally tick a "CSV" checkbox / select a "CSV" option.
 *   3. Set up a download listener.
 *   4. Click the "submit / generate" button.
 *   5. Await the download, read its bytes, parse as CSV.
 *
 * Returns the parsed rows as Array<Record<header, value>>. CSV header
 * normalization is intentionally LOOSE — the caller (per-PMS normalizer)
 * decides how to map header names to canonical fields.
 *
 * Selectors used (all optional, set per knowledge file):
 *   - selectors.preStepClick[]:  list of selectors clicked in order before download
 *                                 (e.g. open the report link, set room range)
 *   - selectors.csvCheckbox:     checkbox to enable CSV output
 *   - selectors.downloadButton:  the button that triggers the download
 *
 * extra.csvDelimiter ('comma'|'tab') defaults to comma.
 * extra.expectedHeaderColumns?: string[] — if set, an exact match must be
 *   present in the parsed header (catches PMS schema drift).
 */

import type { Page, Download } from 'playwright';
import { log } from '../log.js';
import { safeGoto } from '../browser-utils/navigate.js';
import type { FeedSpec } from '../knowledge-file.js';

export interface CsvDownloadOptions {
  page: Page;
  feedSpec: FeedSpec;
  allowedHost: string;
  signal?: AbortSignal;
}

export interface CsvDownloadResult {
  ok: boolean;
  header: string[];
  rows: Array<Record<string, string>>;
  raw?: string;
  reason?: string;
}

const DOWNLOAD_TIMEOUT_MS = 60_000;

export async function extractCsvDownload(opts: CsvDownloadOptions): Promise<CsvDownloadResult> {
  const { page, feedSpec, allowedHost, signal } = opts;

  if (feedSpec.url) {
    try {
      await safeGoto(page, feedSpec.url, {
        allowedHost,
        context: 'extractor:csv_download:goto',
      });
    } catch (err) {
      return { ok: false, header: [], rows: [], reason: `navigate failed: ${(err as Error).message}` };
    }
  }

  if (signal?.aborted) return { ok: false, header: [], rows: [], reason: 'aborted' };

  // Pre-step clicks (open report, set filters, etc.).
  const preStepClicks = (feedSpec.extra?.preStepClick as string[] | undefined) ?? [];
  for (const sel of preStepClicks) {
    try {
      await page.click(sel, { timeout: 10_000 });
    } catch (err) {
      return {
        ok: false,
        header: [],
        rows: [],
        reason: `pre-step click failed for "${sel}": ${(err as Error).message}`,
      };
    }
    if (signal?.aborted) return { ok: false, header: [], rows: [], reason: 'aborted' };
  }

  // CSV format selection.
  const csvCheckbox = feedSpec.selectors?.csvCheckbox;
  if (csvCheckbox) {
    try {
      await page.check(csvCheckbox, { timeout: 5_000 });
    } catch (err) {
      log.warn('extractor:csv_download: csvCheckbox check failed (continuing)', {
        selector: csvCheckbox,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Set up the download listener BEFORE clicking the submit button —
  // race-free way to capture a Playwright download.
  const downloadButton = feedSpec.selectors?.downloadButton;
  if (!downloadButton) {
    return { ok: false, header: [], rows: [], reason: 'feedSpec missing selectors.downloadButton' };
  }

  let download: Download;
  try {
    [download] = await Promise.all([
      page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }),
      page.click(downloadButton, { timeout: 10_000 }),
    ]);
  } catch (err) {
    return {
      ok: false,
      header: [],
      rows: [],
      reason: `download did not arrive: ${(err as Error).message}`,
    };
  }

  if (signal?.aborted) return { ok: false, header: [], rows: [], reason: 'aborted' };

  let csvText: string;
  try {
    const stream = await download.createReadStream();
    if (!stream) {
      return { ok: false, header: [], rows: [], reason: 'download stream unavailable' };
    }
    csvText = await streamToString(stream);
  } catch (err) {
    return {
      ok: false,
      header: [],
      rows: [],
      reason: `failed to read download: ${(err as Error).message}`,
    };
  }

  const delimiter = (feedSpec.extra?.csvDelimiter as string | undefined) === 'tab' ? '\t' : ',';
  const parsed = parseCsv(csvText, delimiter);
  if (parsed.header.length === 0 || parsed.rows.length === 0) {
    return {
      ok: false,
      header: parsed.header,
      rows: parsed.rows,
      raw: csvText.slice(0, 500),
      reason: 'CSV parse produced empty result',
    };
  }

  // Schema-drift check.
  const expected = feedSpec.extra?.expectedHeaderColumns as string[] | undefined;
  if (expected && expected.length > 0) {
    const headerSet = new Set(parsed.header.map((h) => h.toLowerCase()));
    const missing = expected.filter((c) => !headerSet.has(c.toLowerCase()));
    if (missing.length > 0) {
      return {
        ok: false,
        header: parsed.header,
        rows: parsed.rows,
        raw: csvText.slice(0, 500),
        reason: `CSV schema drift: missing columns [${missing.join(', ')}]`,
      };
    }
  }

  return { ok: true, header: parsed.header, rows: parsed.rows, raw: csvText };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Minimal CSV parser. Handles quoted fields (RFC 4180-ish):
 *   - "foo,bar" stays one field
 *   - "she said ""hi""" becomes: she said "hi"
 *   - Newlines inside quotes preserved
 *
 * Not full RFC 4180 — doesn't handle multi-line embedded CRLFs well —
 * but covers what Choice Advantage produces.
 */
function parseCsv(
  text: string,
  delimiter: string,
): { header: string[]; rows: Array<Record<string, string>> } {
  const allLines = parseLines(text, delimiter);
  if (allLines.length === 0) return { header: [], rows: [] };

  const header = allLines[0]!.map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < allLines.length; i++) {
    const fields = allLines[i]!;
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]!] = (fields[j] ?? '').trim();
    }
    rows.push(row);
  }
  return { header, rows };
}

function parseLines(text: string, delimiter: string): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        current.push(field);
        field = '';
      } else if (ch === '\n') {
        current.push(field);
        out.push(current);
        current = [];
        field = '';
      } else if (ch === '\r') {
        // skip — handled by next \n
      } else {
        field += ch;
      }
    }
  }
  if (field !== '' || current.length > 0) {
    current.push(field);
    out.push(current);
  }
  return out.filter((row) => row.some((f) => f.trim() !== ''));
}
