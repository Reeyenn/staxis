/**
 * Learn-time downloaded-file parser (feature/cua-report-handling).
 *
 * When the vision mapper clicks a feed's "Submit / Generate / Export"
 * button and the PMS responds by DOWNLOADING a file instead of rendering
 * an inline table, the mapper is normally blind to the result — it sees no
 * page change, re-clicks Submit, and trips the loop detector. This parser
 * lets the LEARN loop read the downloaded bytes so the model can see the
 * headers + a sample row and emit its column map.
 *
 * This is LEARN-TIME ONLY. The deterministic DOWNLOAD REPLAY path already
 * exists (recipe-adapter.ts csv branch → extractors/csv-download.ts); this
 * does NOT touch it.
 *
 * v1 scope: CSV ONLY. The CSV parse logic is REUSED from csv-download.ts
 * (the proven parser) rather than duplicated. Excel (.xlsx/.xls) and PDF
 * return { ok:false, reason } — no xlsx / pdf-parse dependency is added —
 * so the agent abstains and the feed parks for a human follow-up rather
 * than committing a wrong map.
 *
 * Format detection is by the download's suggested filename extension, with
 * a content sniff fallback (a CSV served with no/odd extension still
 * parses; a binary Excel/PDF blob with a misleading .csv name is caught by
 * the magic-byte sniff and rejected).
 */

import type { Download } from 'playwright';
import { log } from '../log.js';
import { parseCsv } from './csv-download.js';

export type DownloadFormat = 'csv' | 'xlsx' | 'pdf' | 'unknown';

export interface DownloadParseResult {
  ok: boolean;
  headers: string[];
  rows: Array<Record<string, string>>;
  format: DownloadFormat;
  reason?: string;
}

/**
 * Parse a Playwright Download captured during the learn loop.
 *
 * Best-effort + total: never throws (a learn-time parse failure must
 * surface as { ok:false } so the agent abstains, not crash the mapper).
 * Excel / PDF are recognized and explicitly declined in v1.
 */
export async function parseDownloadedFile(download: Download): Promise<DownloadParseResult> {
  const suggested = safeSuggestedFilename(download);
  const ext = extensionOf(suggested);

  // Read the bytes once. We need them for both the magic-byte sniff and the
  // CSV parse. A read failure is a clean abstain, not a throw.
  let buf: Buffer;
  try {
    const stream = await download.createReadStream();
    if (!stream) {
      return { ok: false, headers: [], rows: [], format: 'unknown', reason: 'download stream unavailable' };
    }
    buf = await streamToBuffer(stream);
  } catch (err) {
    return {
      ok: false,
      headers: [],
      rows: [],
      format: 'unknown',
      reason: `failed to read download: ${(err as Error).message}`,
    };
  }

  const sniffed = sniffFormat(buf);

  // Format resolution. The magic-byte sniff WINS over the extension so a
  // binary file with a misleading name is never mis-parsed:
  //   - sniff says xlsx/pdf      → decline (v1 unsupported), regardless of name.
  //   - sniff says unknown (NUL  → binary) → decline even if named .csv.
  //   - sniff says csv (textual) → trust a csv/tsv/txt extension; else 'csv'.
  // Excel / PDF are recognized by extension too (a valid file the sniff
  // couldn't fingerprint) and declined in v1 (no xlsx / pdf-parse dependency).
  const format: DownloadFormat =
    sniffed === 'xlsx' || ext === 'xlsx' || ext === 'xls'
      ? 'xlsx'
      : sniffed === 'pdf' || ext === 'pdf'
        ? 'pdf'
        : sniffed === 'unknown'
          ? 'unknown' // binary content (NUL bytes) — never parse as CSV
          : ext === 'csv' || ext === 'tsv' || ext === 'txt'
            ? 'csv'
            : sniffed; // textual sniff with no/odd extension → 'csv'

  if (format === 'xlsx' || format === 'pdf') {
    log.info('download-parser: format not yet supported — abstaining', {
      suggested,
      format,
    });
    return {
      ok: false,
      headers: [],
      rows: [],
      format,
      reason: 'format not yet supported',
    };
  }

  if (format === 'unknown') {
    return {
      ok: false,
      headers: [],
      rows: [],
      format: 'unknown',
      reason: `unrecognized download format (filename "${suggested}")`,
    };
  }

  // CSV (or TSV). Tab delimiter when the extension or first line says so.
  const text = buf.toString('utf8');
  const delimiter = ext === 'tsv' || looksTabDelimited(text) ? '\t' : ',';
  const parsed = parseCsv(text, delimiter);
  if (parsed.header.length === 0 || parsed.rows.length === 0) {
    return {
      ok: false,
      headers: parsed.header,
      rows: parsed.rows,
      format: 'csv',
      reason: 'CSV parse produced empty result',
    };
  }

  return { ok: true, headers: parsed.header, rows: parsed.rows, format: 'csv' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function safeSuggestedFilename(download: Download): string {
  try {
    return download.suggestedFilename() || '';
  } catch {
    return '';
  }
}

function extensionOf(filename: string): string {
  const m = /\.([a-z0-9]+)\s*$/i.exec(filename.trim());
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * Magic-byte sniff. Catches a binary file served with a misleading
 * extension. Returns 'csv' when the bytes look like plain text, so a CSV
 * with no/odd extension still parses.
 */
function sniffFormat(buf: Buffer): DownloadFormat {
  if (buf.length === 0) return 'unknown';
  // PDF: %PDF
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'pdf';
  }
  // XLSX (zip): PK\x03\x04 ; legacy XLS (OLE2): D0 CF 11 E0
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return 'xlsx';
  }
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    return 'xlsx';
  }
  // Heuristic text check: a NUL byte in the first KB strongly implies binary.
  const probe = buf.subarray(0, Math.min(buf.length, 1024));
  if (probe.includes(0x00)) return 'unknown';
  return 'csv';
}

function looksTabDelimited(text: string): boolean {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.includes('\t') && !firstLine.includes(',');
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
