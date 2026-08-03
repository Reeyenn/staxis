// Which door a file goes through, and what it costs.
//
// The routing decision is the one with money attached: a spreadsheet read as
// text is free, exact and deterministic, while the same sheet sent to vision
// costs a few cents and comes back approximate. So "did this take the free
// path" is a behaviour worth pinning, not an implementation detail.

import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { describe, test } from 'node:test';

import {
  ImportSourceError,
  mimeForFileName,
  pastedTextSource,
  readImportSource,
  IMPORT_MAX_DECODED_BYTES,
} from '@/lib/inventory-import/source-text';

function bytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

/** The smallest thing that reads as a workbook: one sheet, one cell. */
function tinyWorkbook(): Uint8Array {
  const files = [
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Bath Towel</t></is></c><c r="B1" t="inlineStr"><is><t>12</t></is></c></row></sheetData></worksheet>'),
    },
  ];
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const payload = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, payload);
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
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

describe('mime resolution leans on the extension, not the browser', () => {
  test('a spreadsheet is a spreadsheet even when Windows says octet-stream', () => {
    assert.equal(
      mimeForFileName('June count.xlsx', 'application/octet-stream'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  test('recognizes the shapes people upload', () => {
    assert.equal(mimeForFileName('list.csv'), 'text/csv');
    assert.equal(mimeForFileName('list.CSV'), 'text/csv');
    assert.equal(mimeForFileName('scan.pdf'), 'application/pdf');
    assert.equal(mimeForFileName('shelf.JPG'), 'image/jpeg');
    assert.equal(mimeForFileName('notes.txt'), 'text/plain');
  });

  test('falls back to what the browser said when the name says nothing', () => {
    assert.equal(mimeForFileName('noextension', 'image/png'), 'image/png');
    assert.equal(mimeForFileName('noextension'), 'application/octet-stream');
  });
});

describe('choosing the free path over the paid one', () => {
  test('a workbook is read locally, with no provider call', async () => {
    const source = await readImportSource({ fileName: 'June.xlsx', bytes: tinyWorkbook() });
    assert.equal(source.readAs, 'text');
    assert.equal(source.sourceKind, 'xlsx');
    assert.match(source.text, /Bath Towel/);
    assert.match(source.text, /### Sheet: S/);
  });

  test('a CSV is read locally too', async () => {
    const source = await readImportSource({
      fileName: 'count.csv',
      bytes: bytes('Item,Qty\nBath Towel,12\n'),
    });
    assert.equal(source.readAs, 'text');
    assert.equal(source.sourceKind, 'csv');
    assert.match(source.text, /Bath Towel,12/);
  });

  test('a photo is the one thing that must go to vision', async () => {
    // A real PNG header; validation past this point belongs to vision-extract.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512),
    ]);
    const source = await readImportSource({ fileName: 'shelf.png', bytes: new Uint8Array(png) });
    assert.equal(source.readAs, 'vision');
    assert.equal(source.sourceKind, 'photo');
    assert.equal(source.mediaType, 'image/png');
  });

  test('pasted text costs nothing and needs no file', () => {
    const source = pastedTextSource('Bath Towel\t12\nHand Soap\t9');
    assert.equal(source.readAs, 'text');
    assert.equal(source.sourceKind, 'text');
    assert.match(source.text, /Hand Soap/);
  });
});

describe('refusals a person can act on', () => {
  test('an empty box is refused with a sentence', () => {
    assert.throws(
      () => pastedTextSource('   '),
      (e: unknown) => e instanceof ImportSourceError && e.code === 'nothing_to_read',
    );
  });

  test('an oversized file is refused before anything is decoded', async () => {
    await assert.rejects(
      readImportSource({
        fileName: 'huge.csv',
        bytes: new Uint8Array(IMPORT_MAX_DECODED_BYTES + 1),
      }),
      (e: unknown) => e instanceof ImportSourceError
        && e.code === 'file_too_big'
        && /4 MB/.test(e.message)
        && !/—/.test(e.message),
    );
  });

  test('an empty file is refused', async () => {
    await assert.rejects(
      readImportSource({ fileName: 'empty.csv', bytes: new Uint8Array(0) }),
      (e: unknown) => e instanceof ImportSourceError && e.code === 'nothing_to_read',
    );
  });

  test('the old binary .xls is refused with the fix, not with a shrug', async () => {
    await assert.rejects(
      readImportSource({ fileName: 'old.xls', bytes: bytes('anything') }),
      (e: unknown) => e instanceof ImportSourceError
        && e.code === 'file_type_unsupported'
        && /Save As/.test(e.message),
    );
  });

  test('a file pretending to be a workbook is refused readably', async () => {
    await assert.rejects(
      readImportSource({ fileName: 'fake.xlsx', bytes: bytes('Item,Qty\nTowel,4') }),
      (e: unknown) => e instanceof ImportSourceError && !/—/.test(e.message),
    );
  });

  test('no refusal message carries an em dash', async () => {
    const attempts: Array<() => Promise<unknown>> = [
      () => readImportSource({ fileName: 'old.xls', bytes: bytes('x') }),
      () => readImportSource({ fileName: 'fake.xlsx', bytes: bytes('nope') }),
      () => readImportSource({ fileName: 'empty.csv', bytes: new Uint8Array(0) }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), (e: unknown) => {
        assert.ok(e instanceof ImportSourceError);
        assert.doesNotMatch(e.message, /—/);
        return true;
      });
    }
  });
});
