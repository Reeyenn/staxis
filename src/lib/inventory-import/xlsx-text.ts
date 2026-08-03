// ═══════════════════════════════════════════════════════════════════════════
// Minimal .xlsx reader — turn a workbook's bytes into a plain-text grid.
//
// WHY THIS EXISTS INSTEAD OF A DEPENDENCY
// The import flow's whole promise is "paste whatever you already have", and
// what a hotel already has is an Excel file. `src/lib/knowledge/extraction.ts`
// reads pdf / docx / csv / txt and stops there, so xlsx was the one gap between
// the promise and the product. SheetJS is ~1MB of vendored code that also
// writes files, styles them, and reads a dozen formats we will never accept;
// this reads ONE format, one direction, and nothing it produces is executed.
//
// A .xlsx is a ZIP of XML. Everything below is: read the ZIP central directory,
// inflate the four entries we care about, and pull cell values out with
// deliberately narrow regexes.
//
//   xl/workbook.xml            sheet names, in workbook order
//   xl/_rels/workbook.xml.rels rId → worksheet part (so tab order is right)
//   xl/sharedStrings.xml       the string pool most text cells point into
//   xl/styles.xml              number formats — the ONLY way to tell a date
//                              cell (45123) from the number 45123
//   xl/worksheets/sheetN.xml   the cells
//
// Output is a tab-separated grid per sheet, because that is what both the
// model and a human paste-into-a-box see, and it keeps a blank cell blank
// instead of silently shifting a row's columns left.
//
// Pure + dependency-free apart from node:zlib, so it unit-tests against a
// hand-built workbook with no fixture binaries in the repo.
// ═══════════════════════════════════════════════════════════════════════════

import { inflateRawSync } from 'node:zlib';

export interface XlsxSheet {
  name: string;
  /** Row-major grid. Ragged rows are padded to the sheet's widest row. */
  rows: string[][];
}

export class XlsxReadError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = 'XlsxReadError';
  }
}

/** Rows beyond this per sheet are dropped — an import review screen a person
 *  reads has a practical ceiling long before a spreadsheet's 1,048,576. */
export const XLSX_MAX_ROWS_PER_SHEET = 5_000;
/** Sheets beyond this are dropped (a monthly workbook is 12 plus a total). */
export const XLSX_MAX_SHEETS = 24;

// ── ZIP ────────────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function findEocd(buf: Buffer): number {
  // The end-of-central-directory record is 22 bytes plus an optional comment
  // of up to 64KB, so scan backwards from the end for its signature.
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readZipEntries(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEocd(buf);
  if (eocd < 0) {
    throw new XlsxReadError('not_a_zip', 'That file is not a readable Excel workbook.');
  }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) {
    // ZIP64. A hotel inventory sheet is never this big; refusing beats
    // guessing at offsets we did not parse.
    throw new XlsxReadError('zip64', 'That workbook is too large to read. Save it as CSV and try again.');
  }
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDIR_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.set(name, { name, method, compressedSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryText(buf: Buffer, entry: ZipEntry): string {
  const lo = entry.localHeaderOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOCAL_SIG) {
    throw new XlsxReadError('bad_entry', 'That workbook could not be opened. Re-save it and try again.');
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) {
    throw new XlsxReadError('truncated', 'That workbook looks truncated. Re-save it and try again.');
  }
  const raw = buf.subarray(start, end);
  if (entry.method === 0) return raw.toString('utf8');
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw).toString('utf8');
    } catch {
      throw new XlsxReadError('inflate_failed', 'That workbook could not be opened. Re-save it and try again.');
    }
  }
  throw new XlsxReadError('unsupported_compression', 'That workbook uses a compression we cannot read. Re-save it and try again.');
}

// ── XML ────────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

export function decodeXmlText(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    const named = NAMED_ENTITIES[body];
    return named ?? whole;
  });
}

/** Concatenate every <t>…</t> inside a fragment (rich-text runs are split). */
function joinTextNodes(fragment: string): string {
  let out = '';
  const re = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    if (m[1] !== undefined) out += decodeXmlText(m[1]);
  }
  return out;
}

// ── Dates ──────────────────────────────────────────────────────────────────

// The built-in numFmtIds Excel reserves for dates and times. Anything else is
// a date only if its custom format code actually spells one.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function formatCodeIsDate(code: string): boolean {
  // Strip quoted literals and colour/condition blocks so "General" text like
  // [Red] or "day" can't be mistaken for a date token.
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[dmy]/i.test(stripped) && !/^[^dmy]*$/i.test(stripped);
}

/**
 * Excel's serial day number → YYYY-MM-DD.
 *
 * Excel's 1900 calendar pretends 1900 was a leap year, which is why the epoch
 * is 1899-12-30 and not -31: the phantom 29 February 1900 absorbs the extra
 * day. That fudge is exact from serial 61 (1 March 1900) onward and off by one
 * below it, so serials under 61 are refused rather than answered wrongly. That
 * costs nothing real — a hotel has no January 1900 inventory — and it also
 * throws out the far more likely reading, which is that a cell holding "3" is a
 * quantity somebody happened to style as a date.
 */
export const EXCEL_MIN_EXACT_SERIAL = 61;

export function excelSerialToDateString(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < EXCEL_MIN_EXACT_SERIAL || serial > 2_958_465) return null;
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

interface StyleTable {
  /** cellXfs index → true when that style paints the number as a date. */
  isDate: boolean[];
}

function parseStyles(xml: string): StyleTable {
  const customDateFmts = new Set<number>();
  const numFmtRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = numFmtRe.exec(xml)) !== null) {
    if (formatCodeIsDate(decodeXmlText(m[2]))) customDateFmts.add(Number(m[1]));
  }
  const isDate: boolean[] = [];
  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (cellXfsBlock) {
    const xfRe = /<xf\b([^>]*)(?:\/>|>[\s\S]*?<\/xf>)/g;
    let xf: RegExpExecArray | null;
    while ((xf = xfRe.exec(cellXfsBlock[1])) !== null) {
      const idMatch = /numFmtId="(\d+)"/.exec(xf[1]);
      const id = idMatch ? Number(idMatch[1]) : 0;
      isDate.push(BUILTIN_DATE_FORMATS.has(id) || customDateFmts.has(id));
    }
  }
  return { isDate };
}

// ── Cells ──────────────────────────────────────────────────────────────────

/** "BC12" → 54 (zero-based column index). Returns -1 when unparseable. */
export function columnIndexFromRef(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref.toUpperCase());
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, shared: string[], styles: StyleTable): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    if (rows.length >= XLSX_MAX_ROWS_PER_SHEET) break;
    const body = rowMatch[1] ?? '';
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(body)) !== null) {
      const attrs = cellMatch[1] ?? '';
      const inner = cellMatch[2] ?? '';
      const refMatch = /\br="([A-Za-z]+\d+)"/.exec(attrs);
      const colIdx = refMatch ? columnIndexFromRef(refMatch[1]) : cells.length;
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : 'n';
      const styleMatch = /\bs="(\d+)"/.exec(attrs);
      const styleIdx = styleMatch ? Number(styleMatch[1]) : -1;

      let value = '';
      if (type === 's') {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const idx = v ? Number(decodeXmlText(v[1])) : NaN;
        value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
      } else if (type === 'inlineStr') {
        value = joinTextNodes(inner);
      } else if (type === 'b') {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        value = v && v[1].trim() === '1' ? 'TRUE' : 'FALSE';
      } else if (type === 'e') {
        value = '';
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = v ? decodeXmlText(v[1]).trim() : '';
        const asDate = styleIdx >= 0 && styles.isDate[styleIdx] === true
          ? excelSerialToDateString(Number(raw))
          : null;
        value = asDate ?? raw;
      }

      const target = colIdx >= 0 ? colIdx : cells.length;
      // A sparse sheet omits empty cells entirely; pad so column N of one row
      // still lines up with column N of the next.
      while (cells.length < target) cells.push('');
      if (cells.length === target) cells.push(value);
      else cells[target] = value;
    }
    rows.push(cells);
  }
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Read a workbook's sheets. Throws XlsxReadError with a person-readable
 * message for every failure mode — nothing here should surface a stack.
 */
export function readXlsxSheets(bytes: Uint8Array): XlsxSheet[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readZipEntries(buf);

  const sharedXml = entries.has('xl/sharedStrings.xml')
    ? readEntryText(buf, entries.get('xl/sharedStrings.xml')!)
    : '';
  const shared: string[] = [];
  if (sharedXml) {
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(sharedXml)) !== null) shared.push(joinTextNodes(m[1] ?? ''));
  }

  const styles = entries.has('xl/styles.xml')
    ? parseStyles(readEntryText(buf, entries.get('xl/styles.xml')!))
    : { isDate: [] };

  // rId → part path, so we can name each worksheet with its real tab name.
  const relTarget = new Map<string, string>();
  if (entries.has('xl/_rels/workbook.xml.rels')) {
    const relsXml = readEntryText(buf, entries.get('xl/_rels/workbook.xml.rels')!);
    const relRe = /<Relationship\b[^>]*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = relRe.exec(relsXml)) !== null) {
      const id = /\bId="([^"]+)"/.exec(m[0]);
      const target = /\bTarget="([^"]+)"/.exec(m[0]);
      if (id && target) {
        const t = decodeXmlText(target[1]).replace(/^\/?xl\//, '').replace(/^\.\//, '');
        relTarget.set(id[1], `xl/${t}`);
      }
    }
  }

  const ordered: Array<{ name: string; part: string }> = [];
  if (entries.has('xl/workbook.xml')) {
    const wbXml = readEntryText(buf, entries.get('xl/workbook.xml')!);
    const sheetRe = /<sheet\b[^>]*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = sheetRe.exec(wbXml)) !== null) {
      const nameAttr = /\bname="([^"]*)"/.exec(m[0]);
      const ridAttr = /\br:id="([^"]+)"/.exec(m[0]) ?? /\bid="([^"]+)"/.exec(m[0]);
      const name = nameAttr ? decodeXmlText(nameAttr[1]) : `Sheet ${ordered.length + 1}`;
      const part = ridAttr ? relTarget.get(ridAttr[1]) : undefined;
      ordered.push({ name, part: part ?? `xl/worksheets/sheet${ordered.length + 1}.xml` });
    }
  }
  if (ordered.length === 0) {
    // No workbook part (or an unreadable one) — fall back to whatever
    // worksheet parts exist, in filename order.
    const parts = [...entries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort((a, b) => {
        const na = Number(/(\d+)/.exec(a)![1]);
        const nb = Number(/(\d+)/.exec(b)![1]);
        return na - nb;
      });
    for (const p of parts) ordered.push({ name: `Sheet ${ordered.length + 1}`, part: p });
  }

  const sheets: XlsxSheet[] = [];
  for (const { name, part } of ordered.slice(0, XLSX_MAX_SHEETS)) {
    const entry = entries.get(part);
    if (!entry) continue;
    sheets.push({ name, rows: parseSheet(readEntryText(buf, entry), shared, styles) });
  }
  if (sheets.length === 0) {
    throw new XlsxReadError('no_sheets', 'We could not find any sheets in that workbook.');
  }
  return sheets;
}

/** Render sheets as the tab-separated text the parser and the model both read. */
export function xlsxSheetsToText(sheets: readonly XlsxSheet[]): string {
  return sheets
    .map((s) => {
      const body = s.rows
        .map((r) => r.join('\t').replace(/\t+$/, ''))
        .filter((line) => line.trim().length > 0)
        .join('\n');
      return `### Sheet: ${s.name}\n${body}`;
    })
    .join('\n\n');
}
