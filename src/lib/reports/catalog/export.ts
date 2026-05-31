/**
 * Generic report export — CSV + Excel (SpreadsheetML).
 *
 * Generalizes the activity-log export (src/lib/activity-log/export.ts) to any
 * report's columns + rows. Reuses that module's hardened escapers so we keep
 * the same RFC-4180 / formula-injection / XML-escape protections (no new deps).
 */

import { csvEscape, neutralizeFormula, xmlEscape } from '@/lib/activity-log/export';
import { formatCell } from './format';
import type { ReportColumn, ReportRow } from './types';

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportPayload {
  body: Buffer | string;
  contentType: string;
  filename: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'report';
}

function filenameFor(reportKey: string, ext: 'csv' | 'xls'): string {
  const ts = new Date().toISOString().slice(0, 10);
  return `${slug(reportKey)}-${ts}.${ext}`;
}

/** Format every cell to its display string (matching the on-screen table). */
function toCells(columns: ReportColumn[], row: ReportRow, lang: 'en' | 'es'): string[] {
  return columns.map((c) => neutralizeFormula(formatCell(row[c.key], c.kind, lang)));
}

export function renderReportCsv(
  reportKey: string,
  columns: ReportColumn[],
  rows: ReportRow[],
  lang: 'en' | 'es' = 'en',
): ExportPayload {
  const lines: string[] = [];
  lines.push(columns.map((c) => csvEscape(c.label[lang])).join(','));
  for (const r of rows) {
    lines.push(toCells(columns, r, lang).map(csvEscape).join(','));
  }
  // UTF-8 BOM so Excel detects encoding (matches activity-log export).
  const BOM = '﻿';
  return {
    body: BOM + lines.join('\r\n'),
    contentType: 'text/csv; charset=utf-8',
    filename: filenameFor(reportKey, 'csv'),
  };
}

export function renderReportXlsx(
  reportKey: string,
  columns: ReportColumn[],
  rows: ReportRow[],
  lang: 'en' | 'es' = 'en',
): ExportPayload {
  const headerCells = columns
    .map((c) => `<Cell><Data ss:Type="String">${xmlEscape(c.label[lang])}</Data></Cell>`)
    .join('');
  const bodyRows = rows
    .map((r) => {
      const cells = toCells(columns, r, lang)
        .map((v) => `<Cell><Data ss:Type="String">${xmlEscape(v ?? '')}</Data></Cell>`)
        .join('');
      return `<Row>${cells}</Row>`;
    })
    .join('');

  const xml =
    `<?xml version="1.0"?>\n` +
    `<?mso-application progid="Excel.Sheet"?>\n` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
    `<Worksheet ss:Name="Report">` +
    `<Table>` +
    `<Row>${headerCells}</Row>` +
    bodyRows +
    `</Table>` +
    `</Worksheet>` +
    `</Workbook>`;

  return {
    body: Buffer.from(xml, 'utf-8'),
    contentType: 'application/vnd.ms-excel; charset=utf-8',
    filename: filenameFor(reportKey, 'xls'),
  };
}

export function renderReportExport(
  format: ExportFormat,
  reportKey: string,
  columns: ReportColumn[],
  rows: ReportRow[],
  lang: 'en' | 'es' = 'en',
): ExportPayload {
  return format === 'xlsx'
    ? renderReportXlsx(reportKey, columns, rows, lang)
    : renderReportCsv(reportKey, columns, rows, lang);
}
