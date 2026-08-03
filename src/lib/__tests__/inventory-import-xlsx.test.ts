// The .xlsx reader, exercised against workbooks built here.
//
// The fixtures are ZIPs assembled in memory rather than binaries committed to
// the repo: a checked-in .xlsx is opaque, and a test whose input nobody can
// read is a test nobody will maintain. Both ZIP storage modes are covered,
// because Excel uses deflate and many exporters use store.

import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { describe, test } from 'node:test';

import {
  columnIndexFromRef,
  decodeXmlText,
  excelSerialToDateString,
  readXlsxSheets,
  xlsxSheetsToText,
  XlsxReadError,
} from '@/lib/inventory-import/xlsx-text';

// ─── A minimal ZIP writer, so the fixtures are readable source ─────────────

interface ZipFile { name: string; data: Buffer }

function buildZip(files: ZipFile[], compress: boolean): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = f.data;
    const payload = compress ? deflateRawSync(raw) : raw;
    const method = compress ? 8 : 0;
    const crc = crc32(raw) >>> 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, payload);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);

    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, centralBuf, eocd]));
}

// ─── Workbook fixtures ────────────────────────────────────────────────────

interface SheetSpec { name: string; xml: string }

function workbook(sheets: SheetSpec[], opts: { shared?: string[]; styles?: string } = {}, compress = true) {
  const shared = opts.shared ?? [];
  const files: ZipFile[] = [
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<workbook><sheets>${sheets.map((s, i) =>
          `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<Relationships>${sheets.map((_, i) =>
          `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
      ),
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(s.xml) })),
  ];
  if (shared.length > 0) {
    files.push({
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(`<sst>${shared.map((v) => `<si><t>${v}</t></si>`).join('')}</sst>`),
    });
  }
  if (opts.styles) files.push({ name: 'xl/styles.xml', data: Buffer.from(opts.styles) });
  return buildZip(files, compress);
}

const sheetXml = (rows: string[][]): string => {
  const col = (i: number) => String.fromCharCode(65 + i);
  return `<worksheet><sheetData>${rows.map((cells, r) =>
    `<row r="${r + 1}">${cells.map((v, c) =>
      v === '' ? '' : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`,
  ).join('')}</sheetData></worksheet>`;
};

// ─── Tests ────────────────────────────────────────────────────────────────

describe('xlsx reading', () => {
  test('reads a deflated workbook, keeping the tab name', () => {
    const bytes = workbook([{ name: 'Count', xml: sheetXml([['Item', 'Qty'], ['Bath Towel', '12']]) }]);
    const sheets = readXlsxSheets(bytes);
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0].name, 'Count');
    assert.deepEqual(sheets[0].rows, [['Item', 'Qty'], ['Bath Towel', '12']]);
  });

  test('reads a stored (uncompressed) workbook too', () => {
    const bytes = workbook([{ name: 'Count', xml: sheetXml([['Soap', '9']]) }], {}, false);
    assert.deepEqual(readXlsxSheets(bytes)[0].rows, [['Soap', '9']]);
  });

  test('resolves shared strings, including multi-run rich text', () => {
    const files: ZipFile[] = [
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst><si><t>Bath </t><t>Towel</t></si><si><t>Soap</t></si></sst>') },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>'),
      },
    ];
    const sheets = readXlsxSheets(buildZip(files, true));
    assert.deepEqual(sheets[0].rows, [['Bath Towel', 'Soap']]);
  });

  test('an empty cell keeps its column, so nothing shifts left', () => {
    const xml = '<worksheet><sheetData><row r="1">'
      + '<c r="A1" t="inlineStr"><is><t>Towel</t></is></c>'
      // B1 omitted entirely, as a sparse sheet does
      + '<c r="C1" t="inlineStr"><is><t>12</t></is></c>'
      + '</row></sheetData></worksheet>';
    const sheets = readXlsxSheets(workbook([{ name: 'S', xml }]));
    assert.deepEqual(sheets[0].rows, [['Towel', '', '12']]);
  });

  test('a date-styled number reads as a date, not as 45123', () => {
    const styles = '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    const xml = '<worksheet><sheetData><row r="1">'
      + '<c r="A1" s="1"><v>46154</v></c>'
      + '<c r="B1" s="0"><v>46154</v></c>'
      + '</row></sheetData></worksheet>';
    const sheets = readXlsxSheets(workbook([{ name: 'S', xml }], { styles }));
    assert.equal(sheets[0].rows[0][0], '2026-05-12');
    assert.equal(sheets[0].rows[0][1], '46154');
  });

  test('a custom date format code is recognized as a date', () => {
    const styles = '<styleSheet>'
      + '<numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>'
      + '<cellXfs><xf numFmtId="164"/></cellXfs></styleSheet>';
    const xml = '<worksheet><sheetData><row r="1"><c r="A1" s="0"><v>46154</v></c></row></sheetData></worksheet>';
    assert.equal(readXlsxSheets(workbook([{ name: 'S', xml }], { styles }))[0].rows[0][0], '2026-05-12');
  });

  test('a text format code that merely mentions a colour is not a date', () => {
    const styles = '<styleSheet>'
      + '<numFmts><numFmt numFmtId="165" formatCode="[Red]#,##0"/></numFmts>'
      + '<cellXfs><xf numFmtId="165"/></cellXfs></styleSheet>';
    const xml = '<worksheet><sheetData><row r="1"><c r="A1" s="0"><v>46154</v></c></row></sheetData></worksheet>';
    assert.equal(readXlsxSheets(workbook([{ name: 'S', xml }], { styles }))[0].rows[0][0], '46154');
  });

  test('every tab of a monthly workbook is read, in workbook order', () => {
    const bytes = workbook([
      { name: 'March', xml: sheetXml([['Bath Towel', '120']]) },
      { name: 'April', xml: sheetXml([['Bath Towel', '96']]) },
      { name: 'May', xml: sheetXml([['Bath Towel', '140']]) },
    ]);
    const sheets = readXlsxSheets(bytes);
    assert.deepEqual(sheets.map((s) => s.name), ['March', 'April', 'May']);
    const text = xlsxSheetsToText(sheets);
    assert.match(text, /### Sheet: March/);
    assert.match(text, /### Sheet: May/);
    assert.match(text, /Bath Towel\t140/);
  });

  test('XML entities are decoded rather than shown raw', () => {
    const bytes = workbook([{ name: 'S', xml: sheetXml([['Coffee &amp; Tea', '4']]) }]);
    assert.equal(readXlsxSheets(bytes)[0].rows[0][0], 'Coffee & Tea');
    assert.equal(decodeXmlText('a &lt;b&gt; &#65; &#x42;'), 'a <b> A B');
  });

  test('a file that is not a workbook is refused with a sentence, not a stack', () => {
    assert.throws(
      () => readXlsxSheets(new Uint8Array(Buffer.from('this is a csv,not a zip'))),
      (e: unknown) => e instanceof XlsxReadError && /not a readable Excel workbook/.test(e.message),
    );
  });

  test('column references map to the right index past Z', () => {
    assert.equal(columnIndexFromRef('A1'), 0);
    assert.equal(columnIndexFromRef('Z9'), 25);
    assert.equal(columnIndexFromRef('AA1'), 26);
    assert.equal(columnIndexFromRef('BC12'), 54);
  });

  test('the Excel serial epoch accounts for the 1900 leap-year bug', () => {
    // Exact from 1 March 1900 onward, which is every date a hotel could hold.
    assert.equal(excelSerialToDateString(61), '1900-03-01');
    assert.equal(excelSerialToDateString(46154), '2026-05-12');
    assert.equal(excelSerialToDateString(46154 + 1), '2026-05-13');
  });

  test('a small number styled as a date is refused, not answered wrongly', () => {
    // Far more likely a quantity in a mis-styled column than a date in 1900.
    for (const serial of [0, 1, 12, 60, -5, Number.NaN]) {
      assert.equal(excelSerialToDateString(serial), null, `serial ${serial}`);
    }
  });
});
