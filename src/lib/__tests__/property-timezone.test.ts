import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  propertyTimezoneOrUTC,
  validPropertyTimezone,
} from '../property-timezone';

describe('property timezone resolution', () => {
  it('keeps a valid hotel timezone and uses deterministic UTC when unavailable', () => {
    assert.equal(validPropertyTimezone(' Pacific/Kiritimati '), 'Pacific/Kiritimati');
    assert.equal(validPropertyTimezone('Mars/Olympus'), null);
    assert.equal(propertyTimezoneOrUTC(null), 'UTC');
    assert.equal(propertyTimezoneOrUTC('Mars/Olympus'), 'UTC');
  });

  it('hydrates the property timezone and removes hotel-specific UI fallbacks', () => {
    const properties = readFileSync(join(process.cwd(), 'src/lib/db/properties.ts'), 'utf8');
    const shell = readFileSync(join(process.cwd(), 'src/app/inventory/_components/InventoryShell.tsx'), 'utf8');
    const reports = readFileSync(join(process.cwd(), 'src/app/settings/reports/page.tsx'), 'utf8');

    assert.match(properties, /alert_phone, timezone/);
    assert.doesNotMatch(shell, /activeProperty\?\.timezone \|\| 'America\/Chicago'/);
    assert.doesNotMatch(reports, /activeProperty\?\.timezone \|\| 'America\/Chicago'/);
  });
});
