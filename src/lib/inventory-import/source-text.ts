// ═══════════════════════════════════════════════════════════════════════════
// "Paste whatever you already have" — one door for five kinds of file.
//
// Everything a manager might hand us collapses into one of two shapes before
// the model ever sees it:
//
//   TEXT   xlsx, csv, tsv, txt, markdown, docx, and text-layer PDFs. Read
//          locally, for free, deterministically. No provider call, no spend.
//   VISION photos and scanned PDFs with no text layer. These need Claude to
//          look at them, and they are the only path that costs anything.
//
// Preferring the free path is not just thrift. A spreadsheet read as text is
// read EXACTLY — every cell, in order, with blanks preserved — while the same
// sheet photographed and described is read approximately. When we can be exact,
// we are exact, and the model's only job is deciding which column is which.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { extractDocumentText } from '@/lib/knowledge/extraction';
import { readXlsxSheets, XlsxReadError, xlsxSheetsToText } from './xlsx-text';

/** How the manager gave it to us. Recorded on the batch. */
export type ImportSourceKind = 'xlsx' | 'csv' | 'text' | 'pdf' | 'photo';

/** Mirrors the invoice scanner's PDF ceiling, which mirrors Vercel's body cap. */
export const IMPORT_MAX_DECODED_BYTES = 4 * 1024 * 1024;

/** Text handed to the model. Longer sheets are cut with the cut declared. */
export const IMPORT_MAX_TEXT_CHARS = 120_000;

export const IMPORT_IMAGE_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
] as const;
export type ImportImageMime = typeof IMPORT_IMAGE_MIME_TYPES[number];

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';

export class ImportSourceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ImportSourceError';
  }
}

export type ImportSource =
  | { readAs: 'text'; sourceKind: ImportSourceKind; text: string; truncated: boolean }
  | { readAs: 'vision'; sourceKind: ImportSourceKind; base64: string; mediaType: ImportImageMime | 'application/pdf' };

/** Filename extension → the mime we treat it as. The browser's own type is
 *  unreliable for spreadsheets (Windows reports xlsx as octet-stream), so the
 *  extension wins for the formats where it matters. */
export function mimeForFileName(fileName: string, declaredMime?: string | null): string {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase() ?? '';
  switch (ext) {
    case 'xlsx': case 'xlsm': return XLSX_MIME;
    case 'xls': return XLS_MIME;
    case 'csv': return 'text/csv';
    case 'tsv': case 'txt': return 'text/plain';
    case 'md': return 'text/markdown';
    case 'pdf': return 'application/pdf';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default: return (declaredMime ?? '').trim() || 'application/octet-stream';
  }
}

function sourceKindForMime(mime: string): ImportSourceKind {
  if (mime === XLSX_MIME || mime === XLS_MIME) return 'xlsx';
  if (mime === 'text/csv') return 'csv';
  if (mime === 'application/pdf') return 'pdf';
  if ((IMPORT_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) return 'photo';
  return 'text';
}

function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= IMPORT_MAX_TEXT_CHARS) return { text, truncated: false };
  const slice = text.slice(0, IMPORT_MAX_TEXT_CHARS);
  const lastNewline = slice.lastIndexOf('\n');
  return {
    text: lastNewline > IMPORT_MAX_TEXT_CHARS - 2_000 ? slice.slice(0, lastNewline) : slice,
    truncated: true,
  };
}

/** Text a manager typed or pasted straight into the box. No file, no spend. */
export function pastedTextSource(raw: string): ImportSource {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new ImportSourceError('nothing_to_read', 'There was nothing in the box to read.');
  }
  const { text, truncated } = capText(trimmed);
  return { readAs: 'text', sourceKind: 'text', text, truncated };
}

/**
 * Decide how a file gets read, and read it when it can be read locally.
 *
 * Throws ImportSourceError with a sentence a person can act on. Nothing here
 * spends money: the vision branch only DECIDES that vision is needed.
 */
export async function readImportSource(args: {
  fileName: string;
  declaredMime?: string | null;
  bytes: Uint8Array;
}): Promise<ImportSource> {
  const { fileName, bytes } = args;
  if (bytes.byteLength === 0) {
    throw new ImportSourceError('nothing_to_read', 'That file was empty.');
  }
  if (bytes.byteLength > IMPORT_MAX_DECODED_BYTES) {
    throw new ImportSourceError(
      'file_too_big',
      'That file is larger than 4 MB. Save it as a CSV, or split it, and try again.',
    );
  }

  const mime = mimeForFileName(fileName, args.declaredMime);
  const sourceKind = sourceKindForMime(mime);

  // ── Excel ───────────────────────────────────────────────────────────────
  if (mime === XLSX_MIME) {
    let text: string;
    try {
      text = xlsxSheetsToText(readXlsxSheets(bytes));
    } catch (e) {
      if (e instanceof XlsxReadError) throw new ImportSourceError(e.reason, e.message);
      throw new ImportSourceError('file_unreadable', 'We could not read that workbook. Save it as a CSV and try again.');
    }
    if (!text.replace(/### Sheet:.*/g, '').trim()) {
      throw new ImportSourceError('file_no_text', 'That workbook had no rows we could read.');
    }
    const capped = capText(text);
    return { readAs: 'text', sourceKind, text: capped.text, truncated: capped.truncated };
  }

  // The old binary .xls format is a different container entirely, and the one
  // thing every version of Excel can still do is Save As CSV.
  if (mime === XLS_MIME) {
    throw new ImportSourceError(
      'file_type_unsupported',
      'That is an older Excel file. Open it, choose Save As, pick CSV or Excel Workbook, and upload that.',
    );
  }

  // ── Photos: straight to vision, no local read to attempt ────────────────
  if ((IMPORT_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) {
    return {
      readAs: 'vision',
      sourceKind: 'photo',
      base64: Buffer.from(bytes).toString('base64'),
      mediaType: mime as ImportImageMime,
    };
  }

  // ── Everything else goes through the shared document reader ─────────────
  // csv / txt / md / docx / pdf. A scanned PDF comes back `needs_ocr`, which is
  // exactly the signal to spend on vision instead of guessing.
  const outcome = await extractDocumentText(bytes, mime);
  if (outcome.status === 'needs_ocr') {
    if (mime !== 'application/pdf') {
      throw new ImportSourceError('file_unreadable', 'We could not read that file.');
    }
    return {
      readAs: 'vision',
      sourceKind: 'pdf',
      base64: Buffer.from(bytes).toString('base64'),
      mediaType: 'application/pdf',
    };
  }
  if (outcome.status === 'unsupported') {
    throw new ImportSourceError('file_type_unsupported', outcome.error ?? 'We cannot read that kind of file.');
  }
  if (outcome.status === 'failed' || !outcome.text) {
    throw new ImportSourceError('file_unreadable', outcome.error ?? 'We could not read that file.');
  }
  const capped = capText(outcome.text);
  return {
    readAs: 'text',
    sourceKind,
    text: capped.text,
    truncated: capped.truncated || outcome.truncated,
  };
}
