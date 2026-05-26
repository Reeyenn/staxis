/**
 * Activity log export — CSV / XLSX / PDF rendering.
 *
 * Verifies:
 *   - CSV emits the standard header row + one row per event + RFC 4180
 *     escaping of quotes/commas/newlines.
 *   - SpreadsheetML XML round-trips XML metacharacters in cell values.
 *   - PDF buffer starts with %PDF and ends with %%EOF.
 *   - The truncation notice fires when truncated=true.
 *   - csvEscape + xmlEscape + escapePdfString in isolation.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  EXPORT_MAX_ROWS,
  csvEscape,
  escapePdfString,
  neutralizeFormula,
  renderCsv,
  renderPdf,
  renderXlsx,
  xmlEscape,
} from '../activity-log/export';
import type { ActivityLogRow } from '../activity-log/types';

function row(over: Partial<ActivityLogRow> = {}): ActivityLogRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    property_id: '00000000-0000-0000-0000-000000000010',
    occurred_at: '2026-05-25T10:00:00Z',
    event_category: 'housekeeping',
    event_type: 'cleaning_completed',
    actor_account_id: null,
    actor_name: 'Maria Lopez',
    actor_role: 'housekeeping',
    target_type: 'room',
    target_id: '305',
    target_label: 'Room 305',
    description: 'Maria Lopez finished cleaning room 305 (22 min)',
    source: 'housekeeper_app',
    source_event_id: null,
    metadata: {},
    created_at: '2026-05-25T10:00:00Z',
    ...over,
  };
}

describe('neutralizeFormula', () => {
  test('prepends apostrophe to formula starters', () => {
    assert.equal(neutralizeFormula('=cmd|\'/c calc\'!A1'), "'=cmd|'/c calc'!A1");
    assert.equal(neutralizeFormula('+evil()'), "'+evil()");
    assert.equal(neutralizeFormula('-evil()'), "'-evil()");
    assert.equal(neutralizeFormula('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(neutralizeFormula('\tevil'), "'\tevil");
    assert.equal(neutralizeFormula('\revil'), "'\revil");
  });
  test('passes safe values through', () => {
    assert.equal(neutralizeFormula('Maria Lopez'), 'Maria Lopez');
    assert.equal(neutralizeFormula('Room 305'), 'Room 305');
    assert.equal(neutralizeFormula(''), '');
  });
});

describe('csvEscape', () => {
  test('passes simple strings through', () => {
    assert.equal(csvEscape('Maria Lopez'), 'Maria Lopez');
  });
  test('quotes + doubles inner quotes', () => {
    assert.equal(csvEscape('She said "hi"'), '"She said ""hi"""');
  });
  test('quotes when value contains a comma', () => {
    assert.equal(csvEscape('Room 305, deep clean'), '"Room 305, deep clean"');
  });
  test('quotes when value contains a newline', () => {
    assert.equal(csvEscape('Line A\nLine B'), '"Line A\nLine B"');
  });
});

describe('renderCsv (formula injection)', () => {
  test('apostrophe-prefixes a description that starts with =', () => {
    const out = renderCsv([row({ description: '=cmd|\'/c calc\'!A1' })], false);
    const txt = String(out.body);
    // The neutralised cell starts with an apostrophe; no CSV quoting is
    // applied because the value has no commas/double-quotes/newlines.
    assert.match(txt, /,'=cmd/);
  });
  test('apostrophe-prefixes an actor name that starts with @', () => {
    const out = renderCsv([row({ actor_name: '@SUM(A:A)' })], false);
    const txt = String(out.body);
    assert.match(txt, /,'@SUM\(A:A\)/);
  });
});

describe('renderCsv', () => {
  test('emits header row + body row with correct columns', () => {
    const out = renderCsv([row()], false);
    assert.equal(out.contentType, 'text/csv; charset=utf-8');
    const txt = String(out.body);
    // Strip the UTF-8 BOM Excel needs for accented characters.
    const noBom = txt.replace(/^﻿/, '');
    const lines = noBom.split('\r\n');
    assert.equal(lines[0], 'When,Category,Type,Actor,Role,Target,Description,Source');
    assert.match(lines[1], /^2026-05-25T10:00:00Z,housekeeping,cleaning_completed,Maria Lopez,/);
    assert.equal(lines.length, 2);
  });

  test('starts with a UTF-8 BOM so Excel decodes UTF-8 correctly', () => {
    const out = renderCsv([row()], false);
    const txt = String(out.body);
    assert.equal(txt.charCodeAt(0), 0xFEFF);
  });

  test('appends truncation notice when flagged', () => {
    const out = renderCsv([row()], true);
    const txt = String(out.body);
    assert.ok(txt.includes(`# Truncated at ${EXPORT_MAX_ROWS} rows`));
  });

  test('escapes commas inside description', () => {
    const out = renderCsv([row({ description: 'Hello, World' })], false);
    const txt = String(out.body);
    assert.ok(txt.includes('"Hello, World"'));
  });
});

describe('xmlEscape', () => {
  test('handles all five XML metacharacters', () => {
    assert.equal(
      xmlEscape(`<a href="x">b & 'c'</a>`),
      '&lt;a href=&quot;x&quot;&gt;b &amp; &apos;c&apos;&lt;/a&gt;',
    );
  });
});

describe('renderXlsx (SpreadsheetML)', () => {
  test('produces XML with the magic mso-application processing instruction', () => {
    const out = renderXlsx([row()], false);
    const buf = out.body as Buffer;
    const txt = buf.toString('utf-8');
    assert.ok(txt.startsWith('<?xml '), 'starts with XML declaration');
    assert.ok(txt.includes('<?mso-application progid="Excel.Sheet"?>'));
    assert.ok(txt.includes('<Workbook'));
    assert.ok(txt.includes('Maria Lopez'));
    assert.equal(out.contentType.startsWith('application/vnd.ms-excel'), true);
  });

  test('XML-escapes ampersands in cell values', () => {
    const out = renderXlsx([row({ description: 'Tom & Jerry' })], false);
    const txt = (out.body as Buffer).toString('utf-8');
    assert.ok(txt.includes('Tom &amp; Jerry'));
  });
});

describe('escapePdfString', () => {
  test('escapes parens + backslashes', () => {
    assert.equal(escapePdfString('hello (world)'), 'hello \\(world\\)');
    assert.equal(escapePdfString('back\\slash'), 'back\\\\slash');
  });
});

describe('renderPdf', () => {
  test('produces a buffer that starts with %PDF and ends with %%EOF', () => {
    const out = renderPdf([row()], false);
    const buf = out.body as Buffer;
    const head = buf.slice(0, 4).toString('binary');
    const tail = buf.slice(buf.length - 5).toString('binary');
    assert.equal(head, '%PDF');
    assert.equal(tail, '%%EOF');
    assert.equal(out.contentType, 'application/pdf');
  });

  test('paginates large row sets without throwing', () => {
    const many = Array.from({ length: 200 }, (_, i) => row({ id: `${i}`, description: `Row ${i}` }));
    const out = renderPdf(many, true);
    const buf = out.body as Buffer;
    // Multi-page PDF should still validate.
    assert.equal(buf.slice(0, 4).toString('binary'), '%PDF');
    assert.equal(buf.slice(buf.length - 5).toString('binary'), '%%EOF');
  });
});
