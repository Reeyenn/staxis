import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  propertyTimezoneOrUTC,
  validPropertyTimezone,
} from '../property-timezone';
import { fromPropertyRow, PROPERTY_COLS } from '../db-mappers';

describe('property timezone resolution', () => {
  it('keeps a valid hotel timezone and uses deterministic UTC when unavailable', () => {
    assert.equal(validPropertyTimezone(' Pacific/Kiritimati '), 'Pacific/Kiritimati');
    assert.equal(validPropertyTimezone('Mars/Olympus'), null);
    assert.equal(propertyTimezoneOrUTC(null), 'UTC');
    assert.equal(propertyTimezoneOrUTC('Mars/Olympus'), 'UTC');
  });

  // Was a grep for `alert_phone, timezone` in src/lib/db/properties.ts, which
  // broke the day the column list moved next to its mapper in db-mappers.ts
  // (the app-shell read became a server route so a company hat could resolve)
  // without anything about the timezone changing. Asked of the pair instead: the
  // hotel's timezone must be REQUESTED from Postgres and must SURVIVE the map.
  // That is the actual guarantee, and it fails if either half drops the column.
  it('hydrates the property timezone', () => {
    assert.ok(
      PROPERTY_COLS.split(',').map((c) => c.trim()).includes('timezone'),
      'the property read stopped asking Postgres for the hotel timezone',
    );
    assert.equal(fromPropertyRow({ id: 'p1', timezone: 'Pacific/Kiritimati' }).timezone, 'Pacific/Kiritimati');
    assert.equal(fromPropertyRow({ id: 'p1' }).timezone, null, 'a missing timezone must be null, never invented');
  });

  it('removes hotel-specific UI fallbacks', () => {
    const shell = readFileSync(join(process.cwd(), 'src/app/inventory/_components/InventoryShell.tsx'), 'utf8');
    const reports = readFileSync(join(process.cwd(), 'src/app/settings/reports/page.tsx'), 'utf8');

    assert.doesNotMatch(shell, /activeProperty\?\.timezone \|\| 'America\/Chicago'/);
    assert.doesNotMatch(reports, /activeProperty\?\.timezone \|\| 'America\/Chicago'/);
  });
});
