/**
 * Tests for response-redaction.ts — the privacy layer for captured network
 * bodies. The module is pure (zero imports), so no env bootstrap is needed;
 * a static test pins that purity (it's a security property: network-capture
 * stores nothing that didn't pass through this file).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  redactResponseBody,
  redactCsvText,
  redactUrl,
  redactHeaders,
  redactRequestBody,
  stripJsonGuards,
  __test__,
} from '../response-redaction.js';

const { classifyKey, scrubStringValue, isLuhnValid } = __test__;

describe('classifyKey — token precision (false-nuke pins)', () => {
  test('operational hotel fields stay plain despite embedded fragments', () => {
    // `cc` in occupancy/success, `pan` in company→mask is separate, `pin` in
    // shipping, `kin` in booking, `tax` in tax_amount — none may nuke.
    assert.equal(classifyKey('occupancy'), 'plain');
    assert.equal(classifyKey('occupancyPct'), 'plain');
    assert.equal(classifyKey('success'), 'plain');
    assert.equal(classifyKey('shipping'), 'plain');
    assert.equal(classifyKey('booking'), 'plain');
    assert.equal(classifyKey('tax_amount'), 'plain');
    assert.equal(classifyKey('accountNumber'), 'plain'); // folio/AR account — operational
    assert.equal(classifyKey('panel'), 'plain');
  });

  test('credential and payment keys nuke', () => {
    assert.equal(classifyKey('cvv'), 'nuke');
    assert.equal(classifyKey('cc'), 'nuke');
    assert.equal(classifyKey('iban'), 'nuke');
    assert.equal(classifyKey('cardNumber'), 'nuke');
    assert.equal(classifyKey('ccNum'), 'nuke');
    assert.equal(classifyKey('password'), 'nuke');
    assert.equal(classifyKey('sessionId'), 'nuke');
    assert.equal(classifyKey('tokenId'), 'nuke');
    assert.equal(classifyKey('authHeader'), 'nuke');
    assert.equal(classifyKey('bankAccountNumber'), 'nuke');
    assert.equal(classifyKey('pinCode'), 'nuke');
  });

  test('person/PII keys mask (string-only tier for person labels)', () => {
    assert.equal(classifyKey('guestName'), 'maskstring');
    assert.equal(classifyKey('fname'), 'maskstring');
    assert.equal(classifyKey('surname'), 'maskstring');
    assert.equal(classifyKey('guest'), 'maskstring'); // bare guest holds "Smith, John" in arrivals feeds
    assert.equal(classifyKey('housekeeperName'), 'maskstring');
    assert.equal(classifyKey('email'), 'mask');
    assert.equal(classifyKey('Phone Number'), 'mask');
    assert.equal(classifyKey('guestPhone'), 'mask'); // number-bearing wins over the string-only tier
    assert.equal(classifyKey('date_of_birth'), 'mask');
    assert.equal(classifyKey('loyaltyNumber'), 'mask');
    assert.equal(classifyKey('specialRequests'), 'mask');
    assert.equal(classifyKey('licensePlate'), 'mask');
    assert.equal(classifyKey('emergencyContact'), 'mask');
    assert.equal(classifyKey('ssnLast4'), 'nuke');
  });

  test('record IDs survive; value-bearing id-suffixed keys do not', () => {
    assert.equal(classifyKey('guestId'), 'plain');
    assert.equal(classifyKey('customerId'), 'plain');
    assert.equal(classifyKey('reservationUuid'), 'plain');
    assert.equal(classifyKey('emailId'), 'mask'); // sloppy APIs store the email here
    assert.equal(classifyKey('taxId'), 'mask'); // identity document, not a record id
    assert.equal(classifyKey('nationalId'), 'mask');
    assert.equal(classifyKey('idNumber'), 'mask');
  });

  test('structural labels are allowed; bare name is not', () => {
    assert.equal(classifyKey('roomTypeName'), 'allow');
    assert.equal(classifyKey('room_name'), 'allow');
    assert.equal(classifyKey('rateName'), 'allow');
    assert.equal(classifyKey('statusName'), 'allow');
    assert.equal(classifyKey('name'), 'maskstring');
    assert.equal(classifyKey('displayName'), 'maskstring');
  });
});

describe('value patterns', () => {
  test('Luhn validation', () => {
    assert.equal(isLuhnValid('4111111111111111'), true);
    assert.equal(isLuhnValid('4111111111111112'), false);
    assert.equal(isLuhnValid('123456789'), false); // too short
  });

  test('emails, SSNs, formatted phones, cards, tokens are scrubbed from strings', () => {
    const s = scrubStringValue(
      'guest john.smith@example.com ssn 123-45-6789 ph (832) 555-1234 alt 832-555-9999 ' +
        'card 4111 1111 1111 1111 jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwMTIifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c ' +
        'auth Bearer abcdefghijklmnopqrstuvwxyz123456',
    );
    assert.ok(!s.includes('john.smith@example.com'));
    assert.ok(!s.includes('123-45-6789'));
    assert.ok(!s.includes('(832) 555-1234'));
    assert.ok(!s.includes('832-555-9999'));
    assert.ok(!s.includes('4111 1111 1111 1111'));
    assert.ok(!s.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
    assert.ok(!s.includes('abcdefghijklmnopqrstuvwxyz123456'));
    assert.ok(s.includes('<redacted:email>'));
    assert.ok(s.includes('<redacted:ssn>'));
    assert.ok(s.includes('<redacted:phone>'));
    assert.ok(s.includes('<redacted:pan>'));
    assert.ok(s.includes('<redacted:jwt>') || s.includes('<redacted:bearer>'));
  });

  test('dates, room numbers, confirmation numbers and statuses survive', () => {
    for (const keep of ['2026-06-10', '2026-06-10T14:00:00Z', '06/10/2026', 'VACANT_CLEAN', '204', '8455123456', 'CONF-2026-0042']) {
      assert.equal(scrubStringValue(keep), keep);
    }
    // Room ranges must not look like phones.
    assert.equal(scrubStringValue('rooms 101-105 and 200-210'), 'rooms 101-105 and 200-210');
  });

  test('non-Luhn 16-digit numbers (long confirmation numbers) survive', () => {
    assert.equal(scrubStringValue('4111111111111112'), '4111111111111112');
  });
});

describe('redactResponseBody — shape preservation', () => {
  test('masks PII values but keeps keys, row count, dates, ids, statuses', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      guestId: `g-${i}`,
      guestName: 'John Smith',
      email: 'john@example.com',
      roomNumber: String(200 + i),
      arrivalDate: '2026-06-10',
      departureDate: '2026-06-12',
      status: 'DUE_IN',
      adults: 2,
      balance: 123.45,
    }));
    const out = redactResponseBody({ reservations: rows, total: 10 }) as {
      reservations: Array<Record<string, unknown>>;
      total: number;
    };
    assert.equal(out.total, 10);
    assert.equal(out.reservations.length, 10);
    for (let i = 0; i < 10; i++) {
      const r = out.reservations[i];
      assert.deepEqual(Object.keys(r), Object.keys(rows[i]));
      assert.equal(r.guestId, `g-${i}`);
      assert.equal(r.guestName, '<redacted:field>');
      assert.equal(r.email, '<redacted:field>');
      assert.equal(r.roomNumber, String(200 + i));
      assert.equal(r.arrivalDate, '2026-06-10');
      assert.equal(r.status, 'DUE_IN');
      assert.equal(r.adults, 2);
      assert.equal(r.balance, 123.45);
    }
  });

  test('container under a mask key recurses normally (dates/rooms inside guest survive)', () => {
    const out = redactResponseBody({
      guest: { name: 'Jane Doe', roomNumber: '310', arrivalDate: '2026-06-11', vip: true },
    }) as { guest: Record<string, unknown> };
    assert.equal(out.guest.name, '<redacted:field>');
    assert.equal(out.guest.roomNumber, '310');
    assert.equal(out.guest.arrivalDate, '2026-06-11');
    assert.equal(out.guest.vip, true);
  });

  test('nuke subtree masks every scalar but keeps structure, booleans, null', () => {
    const out = redactResponseBody({
      payment: {
        number: '4111111111111111',
        expiry: { month: 12, year: 2027 },
        approved: true,
        gateway: null,
      },
    }) as { payment: Record<string, unknown> };
    assert.equal(out.payment.number, '<redacted:masked>');
    assert.deepEqual(out.payment.expiry, { month: '<redacted:masked>', year: '<redacted:masked>' });
    assert.equal(out.payment.approved, true);
    assert.equal(out.payment.gateway, null);
  });

  test('a Luhn-valid card number arriving as a JSON number is masked under any key', () => {
    const out = redactResponseBody({ weirdField: 4111111111111111 }) as Record<string, unknown>;
    assert.equal(out.weirdField, '<redacted:pan>');
  });

  test('structural room/rate names survive while guest names are masked', () => {
    const out = redactResponseBody({
      roomTypeName: 'King Suite',
      rateName: 'AAA Discount',
      guestName: 'John Smith',
      name: 'Deluxe Double',
    }) as Record<string, unknown>;
    assert.equal(out.roomTypeName, 'King Suite');
    assert.equal(out.rateName, 'AAA Discount');
    assert.equal(out.guestName, '<redacted:field>');
    assert.equal(out.name, '<redacted:field>'); // bare name: conservative
  });

  test('null stays null even under sensitive keys; booleans pass', () => {
    const out = redactResponseBody({ email: null, phone: null, hasEmail: false }) as Record<string, unknown>;
    assert.equal(out.email, null);
    assert.equal(out.phone, null);
    assert.equal(out.hasEmail, false);
  });

  test('person-label keys mask strings but keep counts', () => {
    const out = redactResponseBody({
      guest: 'Smith, John',
      guests: 2,
      adults: 2,
      guestCount: 4,
      customer: 'Jane Doe',
    }) as Record<string, unknown>;
    assert.equal(out.guest, '<redacted:field>');
    assert.equal(out.guests, 2);
    assert.equal(out.adults, 2);
    assert.equal(out.guestCount, 4);
    assert.equal(out.customer, '<redacted:field>');
  });

  test('number-bearing PII keys mask numbers too', () => {
    const out = redactResponseBody({ phone: 8325551234, zip: 77001, loyaltyNumber: 12345678 }) as Record<string, unknown>;
    assert.equal(out.phone, '<redacted:field>');
    assert.equal(out.zip, '<redacted:field>');
    assert.equal(out.loyaltyNumber, '<redacted:field>');
  });

  test('bare first/last/given keys mask strings while last* timestamps survive', () => {
    const out = redactResponseBody({
      first: 'John',
      last: 'Smith',
      given: 'Jane',
      lastUpdated: '2026-06-10T12:00:00Z',
      lastCleaned: '2026-06-09',
      firstFloor: true,
    }) as Record<string, unknown>;
    assert.equal(out.first, '<redacted:field>');
    assert.equal(out.last, '<redacted:field>');
    assert.equal(out.given, '<redacted:field>');
    assert.equal(out.lastUpdated, '2026-06-10T12:00:00Z');
    assert.equal(out.lastCleaned, '2026-06-09');
    assert.equal(out.firstFloor, true);
  });
});

describe('redactResponseBody — robustness', () => {
  test('never mutates its input', () => {
    const input = {
      guestName: 'John Smith',
      nested: { email: 'j@x.com', rows: [{ phone: '(832) 555-1234' }] },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactResponseBody(input);
    assert.deepEqual(input, snapshot);
  });

  test('primitives and null/undefined pass through without throwing', () => {
    assert.equal(redactResponseBody(null), null);
    assert.equal(redactResponseBody(undefined), undefined);
    assert.equal(redactResponseBody(42), 42);
    assert.equal(redactResponseBody(true), true);
    assert.equal(redactResponseBody('plain text'), 'plain text');
  });

  test('cycles become markers, siblings survive', () => {
    const a: Record<string, unknown> = { rooms: 12 };
    a.self = a;
    const out = redactResponseBody(a) as Record<string, unknown>;
    assert.equal(out.rooms, 12);
    assert.equal(out.self, '<redacted:cycle>');
  });

  test('depth past 40 becomes a marker, never raw and never a throw', () => {
    let deep: Record<string, unknown> = { secretValue: 'leaf-PII' };
    for (let i = 0; i < 60; i++) deep = { child: deep };
    const out = JSON.stringify(redactResponseBody(deep));
    assert.ok(out.includes('<redacted:max_depth>'));
    assert.ok(!out.includes('leaf-PII'));
  });

  test('Dates become ISO strings; Map/Set/Buffer become markers', () => {
    const out = redactResponseBody({
      when: new Date('2026-06-10T00:00:00Z'),
      m: new Map([['a', 1]]),
      s: new Set([1]),
      b: Buffer.from('xyz'),
    }) as Record<string, unknown>;
    assert.equal(out.when, '2026-06-10T00:00:00.000Z');
    assert.equal(out.m, '<redacted:unsupported_type>');
    assert.equal(out.s, '<redacted:unsupported_type>');
    assert.equal(out.b, '<redacted:unsupported_type>');
  });

  test('a throwing getter masks just that field', () => {
    const o: Record<string, unknown> = { good: 1 };
    Object.defineProperty(o, 'bad', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const out = redactResponseBody(o) as Record<string, unknown>;
    assert.equal(out.good, 1);
    assert.equal(out.bad, '<redacted:error>');
  });

  test('__proto__ keys cannot pollute the output prototype', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "rooms": 3}');
    const out = redactResponseBody(parsed) as Record<string, unknown>;
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(out.rooms, 3);
  });
});

describe('redactUrl', () => {
  test('strips userinfo, masks sensitive param values, keeps dates and names of params', () => {
    const out = redactUrl('https://user:hunter2@pms.example.com/api/arrivals?guestName=John+Smith&from=2026-06-01&to=2026-06-07');
    assert.ok(!out.includes('user:hunter2'));
    assert.ok(!out.includes('John'));
    assert.ok(out.includes('guestName=<redacted:param>'));
    assert.ok(out.includes('from=2026-06-01'));
    assert.ok(out.includes('to=2026-06-07'));
    assert.ok(out.includes('/api/arrivals'));
  });

  test('scrubs PII embedded in path segments', () => {
    const out = redactUrl('https://pms.example.com/guests/jane.smith%40example.com/folio');
    assert.ok(!out.includes('jane.smith'));
    assert.ok(out.includes('folio'));
  });

  test('name segments after person-entity route tokens are masked; ids/dates survive', () => {
    const named = redactUrl('https://pms.example.com/guests/John%20Smith/folio');
    assert.ok(!named.includes('John'));
    assert.ok(named.includes('folio'));
    const byId = redactUrl('https://pms.example.com/guests/12345/folio');
    assert.ok(byId.includes('12345'));
    const byUuid = redactUrl('https://pms.example.com/customers/0f8fad5b-d9cb-469f-a165-70867728950e/notes');
    assert.ok(byUuid.includes('0f8fad5b-d9cb-469f-a165-70867728950e'));
    // Generic REST route words after a person token are not identifiers.
    assert.ok(redactUrl('https://pms.example.com/guests/search?from=2026-06-01').includes('/guests/search'));
    assert.ok(redactUrl('https://pms.example.com/users/list').includes('/users/list'));
    // Whitespace segments are data values anywhere in the path.
    const loose = redactUrl('https://pms.example.com/report/Jane%20Doe/details');
    assert.ok(!loose.includes('Jane'));
  });

  test('unparseable input becomes a marker, never raw', () => {
    assert.equal(redactUrl('::::not a url with jane@x.com::::'), '<redacted:unparseable_url>');
  });

  test('fragments are dropped (OAuth #access_token) and free-text search params masked', () => {
    const out = redactUrl('https://pms.example.com/callback?search=John+Smith&page=2#access_token=SECRETFRAG123');
    assert.ok(!out.includes('SECRETFRAG123'));
    assert.ok(!out.includes('access_token'));
    assert.ok(!out.includes('John'));
    assert.ok(out.includes('search=<redacted:param>'));
    assert.ok(out.includes('page=2'));
  });
});

describe('redactHeaders', () => {
  test('credential headers masked, referer query stripped, benign headers kept', () => {
    const out = redactHeaders({
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      cookie: 'sid=supersecret',
      'x-api-key': 'k-123',
      'x-csrf-token': 'tok',
      referer: 'https://pms.example.com/search?guest=John+Smith',
      accept: 'application/json',
      'content-type': 'application/json',
    });
    assert.equal(out.authorization, '<redacted:header>');
    assert.equal(out.cookie, '<redacted:header>');
    assert.equal(out['x-api-key'], '<redacted:header>');
    assert.equal(out['x-csrf-token'], '<redacted:header>');
    assert.equal(out.referer, 'https://pms.example.com/search');
    assert.equal(out.accept, 'application/json');
    assert.equal(out['content-type'], 'application/json');
  });

  test('PII-bearing custom header names are masked; referer paths are name-scrubbed', () => {
    const out = redactHeaders({
      'x-guest-name': 'John Smith',
      'x-user-email': 'j@x.com',
      referer: 'https://pms.example.com/guests/John%20Smith/folio?tab=1',
      'user-agent': 'Mozilla/5.0',
    });
    assert.equal(out['x-guest-name'], '<redacted:header>');
    assert.equal(out['x-user-email'], '<redacted:header>');
    assert.ok(!String(out.referer).includes('John'));
    assert.ok(!String(out.referer).includes('tab=1'));
    assert.equal(out['user-agent'], 'Mozilla/5.0');
  });
});

describe('redactRequestBody', () => {
  test('JSON bodies are recursively redacted with dates preserved', () => {
    const out = redactRequestBody('{"username":"bob","password":"hunter2","date":"2026-06-01"}', 'application/json');
    assert.ok(out !== null);
    assert.ok(!out.includes('hunter2'));
    assert.ok(!out.includes('bob'));
    assert.ok(out.includes('2026-06-01'));
    assert.ok(out.includes('password'));
  });

  test('urlencoded bodies mask sensitive param values only', () => {
    const out = redactRequestBody('guestName=John+Smith&from=2026-06-01&page=2', 'application/x-www-form-urlencoded');
    assert.ok(out !== null);
    assert.ok(!out.includes('John'));
    assert.ok(out.includes('guestName=<redacted:param>'));
    assert.ok(out.includes('from=2026-06-01'));
    assert.ok(out.includes('page=2'));
  });

  test('opaque bodies are fully masked; null passes through', () => {
    assert.equal(redactRequestBody(' binary-with-jane@x.com', 'multipart/form-data'), '<redacted:opaque_request_body>');
    assert.equal(redactRequestBody(null), null);
  });

  test('output is capped at 16KB', () => {
    const big = JSON.stringify({ rows: Array.from({ length: 5000 }, (_, i) => ({ v: `value-${i}` })) });
    const out = redactRequestBody(big, 'application/json');
    assert.ok(out !== null);
    assert.ok(out.length <= 16 * 1024 + '<redacted:truncated>'.length);
    assert.ok(out.endsWith('<redacted:truncated>'));
  });
});

describe('stripJsonGuards', () => {
  test('strips BOM and XSSI prefixes so legacy JSON parses', () => {
    assert.equal(stripJsonGuards('﻿{"a":1}'), '{"a":1}');
    assert.equal(stripJsonGuards(")]}',\n{\"a\":1}"), '{"a":1}');
    assert.equal(stripJsonGuards('while(1);{"a":1}'), '{"a":1}');
    assert.equal(stripJsonGuards('for(;;);[1,2]'), '[1,2]');
    assert.deepEqual(JSON.parse(stripJsonGuards(")]}',\n[{\"r\":204}]")), [{ r: 204 }]);
  });
});

describe('redactCsvText', () => {
  test('masks sensitive columns by header, preserves rows/dates/numbers exactly', () => {
    const csv =
      'Guest Name,Email,Room,Arrival Date,Status\n' +
      '"Smith, John",john@x.com,204,2026-06-10,Checked In\n' +
      ',,,,\n' +
      'Doe Jane,jane@y.com,310,2026-06-11,Due Out\n';
    const out = redactCsvText(csv);
    const lines = out.split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '');
    assert.equal(lines.length, 4); // header + 3 data rows (incl. the blank row)
    assert.equal(lines[0], 'Guest Name,Email,Room,Arrival Date,Status');
    assert.ok(!out.includes('Smith'));
    assert.ok(!out.includes('john@x.com'));
    assert.ok(!out.includes('Doe'));
    assert.ok(out.includes('204'));
    assert.ok(out.includes('2026-06-10'));
    assert.ok(out.includes('Checked In'));
    assert.equal(lines[2], ',,,,'); // blank row preserved verbatim
  });

  test('semicolon-delimited CSV is handled', () => {
    const out = redactCsvText('Name;Zimmer;Datum\nJohn Smith;204;2026-06-10\n');
    assert.ok(!out.includes('John'));
    assert.ok(out.includes('204'));
    assert.ok(out.includes('2026-06-10'));
  });

  test('BOM on the header row does not defeat column matching', () => {
    const out = redactCsvText('﻿Guest Name,Room\nJohn Smith,204\n');
    assert.ok(!out.includes('John'));
    assert.ok(out.includes('204'));
  });

  test('headerless CSV masks non-numeric/date cells and 10+-digit numerics', () => {
    const out = redactCsvText('204,2026-06-10,8325551234\n310,2026-06-11,John Smith\n');
    assert.ok(out.includes('204'));
    assert.ok(out.includes('310'));
    assert.ok(out.includes('2026-06-10'));
    assert.ok(!out.includes('8325551234')); // 10-digit numeric: could be a phone
    assert.ok(!out.includes('John'));
  });

  test('an all-text first row that shape-matches its data is NOT mistaken for a header', () => {
    // "John Smith,DUE_IN" would survive as a fake header otherwise.
    const out = redactCsvText('John Smith,DUE_IN\nJane Doe,DUE_OUT\n');
    assert.ok(!out.includes('John'));
    assert.ok(!out.includes('Jane'));
    // DUE_IN is shape-identical to JOHN_SMITH (all-caps + underscore, no
    // digit) — with no header to disambiguate, both must mask.
    assert.ok(!out.includes('DUE_IN'));
    assert.ok(!out.includes('JOHN_SMITH'));
    assert.equal(out.trim().split('\n').length, 2); // row count intact
  });

  test('headerless mode keeps UUIDs and digit-bearing room codes, masks all-caps names', () => {
    const out = redactCsvText('0f8fad5b-d9cb-469f-a165-70867728950e,101A,SMITH\n5c8fad5b-d9cb-469f-a165-708677289511,202B,JOHN_SMITH\n');
    assert.ok(out.includes('0f8fad5b-d9cb-469f-a165-70867728950e'));
    assert.ok(out.includes('101A'));
    assert.ok(out.includes('202B'));
    assert.ok(!out.includes('SMITH')); // also asserts JOHN_SMITH is gone
  });

  test('emails hiding in unmasked columns are still pattern-scrubbed', () => {
    const out = redactCsvText('Room,Notes2\n204,reach me at j@x.com\n');
    // "Notes2" → mask column; use a benign header to test the value scrub:
    const out2 = redactCsvText('Room,Status\n204,reach me at j@x.com\n');
    assert.ok(!out.includes('j@x.com'));
    assert.ok(!out2.includes('j@x.com'));
  });
});

describe('purity (security property)', () => {
  test('response-redaction.ts imports nothing', async () => {
    const src = await readFile(join(__dirname, '..', 'response-redaction.ts'), 'utf8');
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      assert.ok(!/^import\s/.test(t), `response-redaction.ts must stay import-free, found: ${t}`);
      assert.ok(!/\brequire\s*\(/.test(t), `response-redaction.ts must stay require-free, found: ${t}`);
    }
  });
});
