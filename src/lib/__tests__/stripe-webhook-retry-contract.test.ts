/** Stripe billing updates must fail the webhook so Stripe can retry. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'stripe', 'webhook', 'route.ts'),
  'utf8',
);

describe('Stripe webhook retry contract', () => {
  test('all property-update errors throw instead of being acknowledged as no-ops', () => {
    const updateErrorBlock = source.match(
      /const \{ data, error \} = await q\.select[\s\S]*?if \(error\) \{([\s\S]*?)\n\s*\}\n\s*return \(data\?\.id/,
    )?.[1] ?? '';
    assert.ok(updateErrorBlock, 'expected updateProperty error block');
    assert.match(updateErrorBlock, /throw new Error/);
    assert.doesNotMatch(updateErrorBlock, /return null/);
  });

  test('handler failures release the dedupe claim and return 500', () => {
    assert.match(source, /\.from\(['"]stripe_processed_events['"]\)[\s\S]*?\.delete\(\)[\s\S]*?\.eq\(['"]event_id['"],\s*event\.id\)/);
    assert.match(source, /Handler error['"]?\s*\},\s*\{\s*status:\s*500/);
  });

  test('only completed claims are acknowledged as duplicates', () => {
    assert.match(source, /processing_state:\s*['"]claimed['"]/);
    assert.match(source, /metadata\?\.processing_state === ['"]claimed['"][\s\S]*status:\s*503/);
    assert.match(source, /processing_state:\s*['"]completed['"]/);
  });
});
