// ═══════════════════════════════════════════════════════════════════════════
// Knowledge document text extraction + status machine.
//
// Turns an uploaded file's bytes into clean, searchable text — or an HONEST
// terminal status when we can't:
//
//   ready       — extracted clean text (whole document fits the index cap)
//   partial     — extracted, but truncated at the 100 KB index cap
//   failed      — extraction produced junk / threw (alpha-ratio heuristic)
//   unsupported — legacy .doc (a truly unreadable file type)
//   needs_ocr   — scanned/image PDF (no text layer) or an uploaded photo →
//                 route to the Fly vision-OCR worker (NON-terminal; the worker
//                 sets the doc to processing → ready/partial/failed).
//
// The state machine kills the failure modes the reviewers called out:
//   • no NULL-overload — every doc lands on a definite state, never a green
//     "searchable" badge it didn't earn;
//   • no infinite retry — terminal statuses are final; a "change" is a new
//     upload (new row), so we embed-once with no re-extraction debt.
//   • `needs_ocr` is NOT a DB status — it's an internal routing signal that
//     indexDocument turns into `processing` + a doc_ocr worker job.
//
// Pure-ish: takes bytes in, returns a result. The only I/O is the extraction
// libraries (unpdf / mammoth), which are deterministic for a given file. The
// readability/junk heuristics are exported for unit testing.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import type { ExtractionStatus } from './types';
import { isImageMime } from './types';

export type { ExtractionStatus };

/** Statuses that are FINAL — never re-extracted. */
export const TERMINAL_EXTRACTION_STATUSES: readonly ExtractionStatus[] = [
  'ready', 'partial', 'failed', 'unsupported',
];

/** Cap on stored/indexed text per document. Beyond this → `partial`. */
export const EXTRACTED_TEXT_MAX = 100_000;

/**
 * The status an extraction attempt resolves to. Adds `needs_ocr` on top of the
 * DB `ExtractionStatus` terminal set — a NON-DB routing marker meaning "this is
 * a scan/photo; hand it to the Fly vision-OCR worker." indexDocument maps it to
 * `processing` + a doc_ocr job (it never lands on the row as-is).
 */
export type ExtractionOutcomeStatus =
  | Exclude<ExtractionStatus, 'pending' | 'processing'>
  | 'needs_ocr';

export interface ExtractionOutcome {
  status: ExtractionOutcomeStatus;
  /** Clean extracted text (already capped), or null when not readable / OCR-bound. */
  text: string | null;
  /** Human-readable reason for failed/unsupported (shown to no one raw — used
   *  for the doc's extract_error + the EN/ES badge tooltip). */
  error: string | null;
  pageCount: number | null;
  /** True when text was truncated at the cap (→ status 'partial'). */
  truncated: boolean;
}

// ── MIME groups (mirror EXT_TO_MIME in core.ts) ──────────────────────────────
const MIME_TEXT = new Set(['text/plain', 'text/markdown', 'text/csv']);
const MIME_PDF = 'application/pdf';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_DOC = 'application/msword';

const NUL = String.fromCharCode(0);

/** Strip the NUL byte Postgres `text` rejects; collapse other control noise. */
function stripNul(s: string): string {
  return s.split(NUL).join(' ');
}

/** Count [A-Za-z0-9] + common accented letters — the "meaningful" characters
 *  that distinguish real text from a scanned-image PDF's empty/near-empty text
 *  layer. */
export function meaningfulCharCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127) n++;
  }
  return n;
}

/**
 * Junk guard: is this text mostly human-readable? Counts letters, digits,
 * whitespace, and common punctuation as "readable"; binary garbage, mojibake,
 * and U+FFFD replacement chars count against. Passes CSV (digits + commas) and
 * accented Spanish (high code points are allowed) while rejecting a mis-decoded
 * binary blob. Returns true when readable.
 */
export function isMostlyReadable(s: string): boolean {
  if (!s) return false;
  let readable = 0;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd) { total++; continue; }          // replacement char → not readable
    if (c === 9 || c === 10 || c === 13 || c === 32) { readable++; total++; continue; } // ws
    if (c < 32) { total++; continue; }                // other control → not readable
    if (c >= 127 && c <= 159) { total++; continue; }  // C1 controls → not readable
    readable++;
    total++;
  }
  if (total === 0) return false;
  return readable / total >= 0.85;
}

/** Apply the index cap, deciding ready vs partial. */
function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= EXTRACTED_TEXT_MAX) return { text, truncated: false };
  // Cut on a whitespace boundary near the cap so we don't split mid-word.
  const slice = text.slice(0, EXTRACTED_TEXT_MAX);
  const lastSpace = slice.lastIndexOf(' ');
  return { text: lastSpace > EXTRACTED_TEXT_MAX - 500 ? slice.slice(0, lastSpace) : slice, truncated: true };
}

function ok(text: string, pageCount: number | null): ExtractionOutcome {
  const { text: capped, truncated } = capText(text);
  return {
    status: truncated ? 'partial' : 'ready',
    text: capped,
    error: truncated ? 'Document is large — only the first part is searchable.' : null,
    pageCount,
    truncated,
  };
}

function fail(error: string): ExtractionOutcome {
  return { status: 'failed', text: null, error, pageCount: null, truncated: false };
}
function unsupported(error: string): ExtractionOutcome {
  return { status: 'unsupported', text: null, error, pageCount: null, truncated: false };
}
/** Route to the Fly vision-OCR worker (scanned PDF / photo). NON-terminal —
 *  indexDocument turns this into `processing` + a doc_ocr job. */
function needsOcr(error: string): ExtractionOutcome {
  return { status: 'needs_ocr', text: null, error, pageCount: null, truncated: false };
}

/**
 * Extract searchable text from an uploaded document's bytes.
 * `mime` is the server-resolved Content-Type (from the file extension at
 * presign time), so it's trustworthy here.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  mime: string,
): Promise<ExtractionOutcome> {
  // Legacy .doc — the binary OLE format unpdf/mammoth don't read.
  if (mime === MIME_DOC) {
    return unsupported('Legacy .doc files can\'t be read — re-save as .docx or PDF and re-upload.');
  }

  // Uploaded photo / scan image (jpg/png/webp) — no text layer to parse here.
  // Route straight to the Fly vision-OCR worker, which transcribes it.
  if (isImageMime(mime)) {
    return needsOcr('Reading this photo with AI — text search will be ready shortly.');
  }

  // Plain text / markdown / csv — decode UTF-8.
  if (MIME_TEXT.has(mime)) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return fail('The file couldn\'t be read as text.');
    }
    text = stripNul(text).trim();
    if (meaningfulCharCount(text) < 1) return fail('The file had no readable text.');
    if (!isMostlyReadable(text)) return fail('The file didn\'t look like readable text.');
    return ok(text, null);
  }

  // Word .docx — mammoth raw text.
  if (mime === MIME_DOCX) {
    let text: string;
    let pageCount: number | null = null;
    try {
      const res = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      text = stripNul(res.value ?? '').trim();
    } catch {
      return fail('Couldn\'t read this Word file. Re-save it and try again.');
    }
    if (meaningfulCharCount(text) < 1) return fail('No readable text found in this Word file.');
    if (!isMostlyReadable(text)) return fail('The Word file didn\'t contain readable text.');
    return ok(text, pageCount);
  }

  // PDF — unpdf (pdf.js under the hood). Text PDFs only; scanned image PDFs
  // have no text layer → routed to `unsupported` for the OCR follow-up.
  if (mime === MIME_PDF) {
    let text: string;
    let totalPages: number | null = null;
    try {
      const pdf = await getDocumentProxy(bytes);
      const res = await extractText(pdf, { mergePages: true });
      totalPages = typeof res.totalPages === 'number' ? res.totalPages : null;
      text = stripNul(Array.isArray(res.text) ? res.text.join('\n') : (res.text ?? '')).trim();
    } catch {
      return fail('Couldn\'t read this PDF. It may be corrupt or password-protected.');
    }
    // A scanned/photo PDF has (near) zero embedded text. Route it to the Fly
    // vision-OCR worker rather than dead-ending as `unsupported`. (A PDF whose
    // text layer reads as junk — not empty — is still `failed`, below.)
    if (meaningfulCharCount(text) < 16) {
      return needsOcr('This looks like a scanned PDF — reading it with AI, text search will be ready shortly.');
    }
    if (!isMostlyReadable(text)) return fail('The PDF\'s text couldn\'t be read cleanly.');
    return ok(text, totalPages);
  }

  // Anything else slipped past presign's allow-list.
  return unsupported('This file type can\'t be read for search.');
}
