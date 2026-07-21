import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('migration PR gate executes only the trusted base checker with production credentials', () => {
  const workflow = readFileSync(
    join(process.cwd(), '.github/workflows/check-migrations-applied.yml'),
    'utf8',
  );
  assert.match(workflow, /pull_request\.base\.sha/);
  assert.match(workflow, /path:\s*trusted/);
  assert.match(workflow, /path:\s*candidate/);
  assert.match(workflow, /working-directory:\s*trusted/);
  assert.match(workflow, /--migrations-dir=\.\.\/candidate\/supabase\/migrations/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.doesNotMatch(workflow, /working-directory:\s*candidate/);
});
