import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderReportCsv, renderReportXlsx } from '@/lib/reports/catalog/export';
import { formatCell } from '@/lib/reports/catalog/format';
import type { Bilingual, ReportColumn } from '@/lib/reports/catalog/types';

describe('report catalog bilingual export compatibility', () => {
  test('Bilingual keeps both required response fields', () => {
    const label: Bilingual = { en: 'Room', es: 'Habitación' };
    assert.deepEqual(Object.keys(label).sort(), ['en', 'es']);
  });

  test('lang=es selects Spanish headers in CSV and SpreadsheetML exports', () => {
    const columns: ReportColumn[] = [
      { key: 'room', label: { en: 'Room', es: 'Habitación' } },
      { key: 'count', label: { en: 'Count', es: 'Cantidad' }, kind: 'number' },
    ];
    const rows = [{ room: '101', count: 1234 }];

    const csv = String(renderReportCsv('rooms', columns, rows, 'es').body);
    assert.match(csv, /^\uFEFFHabitación,Cantidad\r\n/);
    assert.doesNotMatch(csv, /^\uFEFFRoom,Count/);

    const xlsx = String(renderReportXlsx('rooms', columns, rows, 'es').body);
    assert.match(xlsx, />Habitación<\/Data>/);
    assert.match(xlsx, />Cantidad<\/Data>/);
    assert.doesNotMatch(xlsx, />Room<\/Data>/);
  });

  test('lang remains part of cell-formatting behavior for external exports', () => {
    const at = '2026-07-24T19:40:00.000Z';
    assert.equal(formatCell(at, 'datetime', 'es'), new Date(at).toLocaleString('es-MX'));
    assert.equal(formatCell(at, 'datetime', 'en'), new Date(at).toLocaleString('en-US'));
  });
});
