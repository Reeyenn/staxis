/** Compliance cron DB outages must fail visibly, never masquerade as zero work. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const anomaly = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'cron', 'compliance-anomaly-sweep', 'route.ts'),
  'utf8',
);
const reminders = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'cron', 'compliance-reminders', 'route.ts'),
  'utf8',
);

describe('compliance cron query-error handling', () => {
  test('anomaly sweep checks the resolved Supabase error', () => {
    assert.match(anomaly, /const \{ data, error \} = await supabaseAdmin[\s\S]{0,240}if \(error\) throw error/);
  });

  test('reminders checks both definition queries', () => {
    assert.match(reminders, /error: readingsErr[\s\S]{0,240}if \(readingsErr\) throw readingsErr/);
    assert.match(reminders, /error: pmErr[\s\S]{0,240}if \(pmErr\) throw pmErr/);
  });

  test('reminders refuses to send when timezone lookup fails', () => {
    assert.match(reminders, /if \(tzErr\)[\s\S]{0,420}status:\s*500/);
    assert.doesNotMatch(reminders, /tzById\.get\(id\)\s*\?\?/);
  });
});
