import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('vercel watchdog returns a failing HTTP status when doctor is red', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/api/cron/vercel-watchdog/route.ts'),
    'utf8',
  );
  const redBranch = source.slice(source.indexOf("status: 'red'"));
  assert.match(redBranch, /\{\s*requestId,\s*status:\s*503\s*\}/);
});
