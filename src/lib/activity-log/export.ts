/**
 * Activity log export — CSV / XLSX / PDF.
 *
 * - CSV: standard RFC 4180.
 * - Excel: SpreadsheetML 2003 XML (a single .xml file Excel opens
 *   natively). We avoid the modern XLSX format because that's a ZIP
 *   container we'd have to hand-roll without an extra dependency. The
 *   SpreadsheetML route is universally readable by Excel + Google Sheets
 *   + LibreOffice, and crucially needs no third-party package.
 * - PDF: hand-rolled minimal one-stream-per-page document so we don't
 *   pull in pdfkit just for a tabular export.
 *
 * The list-API caps page size at 200; export bypasses pagination but
 * still caps at EXPORT_MAX_ROWS so a deeply-zoomed-out filter can't OOM
 * the lambda. The user sees a "result truncated" line in the file if
 * they hit the cap.
 */

import type { ActivityLogRow } from './types';

export const EXPORT_MAX_ROWS = 10_000;

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

const EXPORT_HEADERS = [
  'When',
  'Category',
  'Type',
  'Actor',
  'Role',
  'Target',
  'Description',
  'Source',
] as const;

export interface ExportPayload {
  body: Buffer | string;
  contentType: string;
  filename: string;
}

function toRowArray(r: ActivityLogRow): string[] {
  return [
    r.occurred_at,
    r.event_category,
    r.event_type,
    r.actor_name ?? '',
    r.actor_role ?? '',
    r.target_label ?? r.target_id ?? '',
    r.description,
    r.source,
  ].map(neutralizeFormula);
}

/**
 * Prepend an apostrophe to any cell value that starts with a character
 * Excel/LibreOffice/Sheets treat as a formula introducer. Without this,
 * a malicious staff name like `=cmd|'/c calc'!A1` would execute on open
 * — CWE-1236. Mirrors OWASP's recommended CSV-injection mitigation.
 *
 * (Codex adversarial review #4.)
 */
export function neutralizeFormula(value: string): string {
  if (!value) return value;
  const first = value.charAt(0);
  if (first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r') {
    return "'" + value;
  }
  return value;
}

/** Escape a CSV cell per RFC 4180. */
export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function renderCsv(rows: ActivityLogRow[], truncated: boolean): ExportPayload {
  const lines: string[] = [];
  lines.push(EXPORT_HEADERS.map(csvEscape).join(','));
  for (const r of rows) {
    lines.push(toRowArray(r).map(csvEscape).join(','));
  }
  if (truncated) {
    lines.push(`# Truncated at ${EXPORT_MAX_ROWS} rows — narrow your filters to see the rest.`);
  }
  // Prepend a UTF-8 BOM so Excel (Windows + Mac) correctly detects the
  // encoding and renders accented characters. Without the BOM, Excel
  // treats CSV as CP-1252 by default, mangling "María" → "MarÃ­a".
  const BOM = '﻿';
  return {
    body: BOM + lines.join('\r\n'),
    contentType: 'text/csv; charset=utf-8',
    filename: filenameFor('csv'),
  };
}

/** Escape XML text — & < > " '. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderXlsx(rows: ActivityLogRow[], truncated: boolean): ExportPayload {
  const headerCells = EXPORT_HEADERS.map(
    (h) => `<Cell><Data ss:Type="String">${xmlEscape(h)}</Data></Cell>`,
  ).join('');

  const bodyRows = rows
    .map((r) => {
      const cells = toRowArray(r)
        .map((v) => `<Cell><Data ss:Type="String">${xmlEscape(v ?? '')}</Data></Cell>`)
        .join('');
      return `<Row>${cells}</Row>`;
    })
    .join('');

  const truncatedRow = truncated
    ? `<Row><Cell><Data ss:Type="String">${xmlEscape(`Truncated at ${EXPORT_MAX_ROWS} rows — narrow your filters to see the rest.`)}</Data></Cell></Row>`
    : '';

  const xml =
    `<?xml version="1.0"?>\n` +
    `<?mso-application progid="Excel.Sheet"?>\n` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
    `<Worksheet ss:Name="Activity Log">` +
    `<Table>` +
    `<Row>${headerCells}</Row>` +
    bodyRows +
    truncatedRow +
    `</Table>` +
    `</Worksheet>` +
    `</Workbook>`;

  return {
    body: Buffer.from(xml, 'utf-8'),
    // Excel opens this XML directly. We use application/vnd.ms-excel so
    // browsers prompt the user to save with Excel as the default app.
    contentType: 'application/vnd.ms-excel; charset=utf-8',
    // The file is SpreadsheetML XML — .xls is the only extension Excel
    // recognises for this format. We pass that out even when the user
    // asked for xlsx — Excel converts on save if they want true .xlsx.
    filename: filenameFor('xls'),
  };
}

/**
 * Minimal PDF renderer — single-page-per-N-rows simple table. Built
 * without an extra dependency by hand-rolling a tiny PDF. Good enough
 * for the audit / compliance "give me a paper trail" use case.
 */
export function renderPdf(rows: ActivityLogRow[], truncated: boolean): ExportPayload {
  const buf = buildSimplePdf(rows, truncated);
  return {
    body: buf,
    contentType: 'application/pdf',
    filename: filenameFor('pdf'),
  };
}

function filenameFor(ext: 'csv' | 'xls' | 'xlsx' | 'pdf'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `activity-log-${ts}.${ext}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Hand-rolled PDF.
// ───────────────────────────────────────────────────────────────────────────
// We're not pulling in pdfkit/pdf-lib just for a tabular export. The PDF
// spec is forgiving enough that a hand-rolled file with Helvetica + a
// stream of text-positioning operators renders correctly in every PDF
// reader on the planet. Format reference: PDF 1.4, sections 3.4.4 + 7.6.
// ───────────────────────────────────────────────────────────────────────────

interface PageOpts {
  pageW: number; pageH: number; marginX: number; marginY: number;
  lineH: number; fontSize: number; headerFontSize: number;
  headerGap: number; title: string;
}

function buildSimplePdf(rows: ActivityLogRow[], truncated: boolean): Buffer {
  const PAGE_W = 612;   // US Letter, portrait, in points
  const PAGE_H = 792;
  const MARGIN_X = 36;
  const MARGIN_Y = 36;
  const LINE_H = 11;
  const FONT_SIZE = 8;
  const HEADER_FONT_SIZE = 14;
  const HEADER_GAP = 24;

  const usableLines = Math.max(1, Math.floor((PAGE_H - 2 * MARGIN_Y - HEADER_GAP) / LINE_H));

  const lines: string[] = [];
  lines.push(`When | Category | Type | Actor | Target | Description | Source`);
  for (const r of rows) {
    const arr = toRowArray(r);
    lines.push(`${arr[0]} | ${arr[1]} | ${arr[2]} | ${arr[3]} | ${arr[5]} | ${arr[6]} | ${arr[7]}`);
  }
  if (truncated) {
    lines.push(`Truncated at ${EXPORT_MAX_ROWS} rows — narrow your filters to see the rest.`);
  }

  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += usableLines) {
    pages.push(lines.slice(i, i + usableLines));
  }
  if (pages.length === 0) pages.push(['(no events)']);

  // Build PDF object list. Object numbering is 1-based.
  // Layout:
  //   1   Font
  //   2   Pages (kids list)
  //   3,4,…   alternating Page + Content streams
  //   last    Catalog
  const objects: string[] = [];
  const fontObj = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const FONT_ID = 1;
  objects.push(fontObj);                  // id 1
  objects.push('');                        // id 2 placeholder for Pages
  const PAGES_ID = 2;

  const pageIds: number[] = [];
  for (const lineGroup of pages) {
    const content = buildPageContent(lineGroup, {
      pageW: PAGE_W, pageH: PAGE_H, marginX: MARGIN_X, marginY: MARGIN_Y,
      lineH: LINE_H, fontSize: FONT_SIZE, headerFontSize: HEADER_FONT_SIZE,
      headerGap: HEADER_GAP, title: 'Activity Log',
    });
    objects.push(`<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}\nendstream`);
    const contentId = objects.length;
    objects.push(
      `<< /Type /Page /Parent ${PAGES_ID} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${FONT_ID} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const pageId = objects.length;
    pageIds.push(pageId);
  }

  objects[PAGES_ID - 1] =
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

  objects.push(`<< /Type /Catalog /Pages ${PAGES_ID} 0 R >>`);
  const catalogId = objects.length;

  return assemblePdf(objects, catalogId);
}

function assemblePdf(objects: string[], catalogId: number): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.from('%PDF-1.4\n', 'binary');
  chunks.push(header);

  const offsets: number[] = [];
  let cursor = header.length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(cursor);
    const block = Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`, 'binary');
    chunks.push(block);
    cursor += block.length;
  }

  const xrefOffset = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  xref += `startxref\n${xrefOffset}\n%%EOF`;
  chunks.push(Buffer.from(xref, 'binary'));

  return Buffer.concat(chunks);
}

function buildPageContent(lines: string[], o: PageOpts): string {
  const topY = o.pageH - o.marginY;
  const parts: string[] = [];
  parts.push('BT');
  parts.push(`/F1 ${o.headerFontSize} Tf`);
  parts.push(`${o.marginX} ${topY - o.headerFontSize} Td`);
  parts.push(`(${escapePdfString(o.title)}) Tj`);
  parts.push('ET');

  parts.push('BT');
  parts.push(`/F1 ${o.fontSize} Tf`);
  parts.push(`${o.marginX} ${topY - o.headerGap - o.fontSize} Td`);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) parts.push(`0 -${o.lineH} Td`);
    parts.push(`(${escapePdfString(lines[i])}) Tj`);
  }
  parts.push('ET');
  return parts.join('\n');
}

export function escapePdfString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // The content stream is latin1-encoded, so any code point above U+00FF would
    // be truncated to one byte and render as garbage — corrupting the audit/
    // compliance paper trail. The activity_log trigger writes em/en-dashes into
    // routine English descriptions; map those to a hyphen, and any other
    // non-Latin-1 char to '?', so output stays valid Latin-1 and /Length
    // self-consistent. (Audit fix 2026-06-18.)
    .replace(/[–—]/g, '-')
    .replace(/[Ā-￿]/g, '?');
}
