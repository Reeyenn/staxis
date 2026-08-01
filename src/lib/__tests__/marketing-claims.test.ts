import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

const landing = readFileSync(
  path.join(process.cwd(), 'src/app/_components/MarketingLanding.tsx'),
  'utf8',
);
const metadata = readFileSync(
  path.join(process.cwd(), 'src/app/page.tsx'),
  'utf8',
);

describe('Public marketing claims', () => {
  test('does not advertise localization or Spanish operation', () => {
    assert.doesNotMatch(landing, /\bbilingual\b|\bSpanish\b|EN\s*\/\s*ES|in their language/i);
    assert.doesNotMatch(landing, /¡|gracias|\blista\b|\bvoy\b/i);
  });

  test('does not advertise unsupported voice automation', () => {
    assert.doesNotMatch(landing, /\bvoice (?:agent|copilot)\b|answering every (?:guest )?call|copilot you can talk to/i);
    assert.match(landing, /AI copilot you can message/);
  });

  test('keeps purchasing decisions human-owned', () => {
    const publicCopy = `${landing}\n${metadata}`;
    assert.doesNotMatch(publicCopy, /inventory that reorders itself|handled automatically|approve reorder|✓ ordered|reorders drafted before/i);
    assert.match(landing, /Review order list/);
    assert.match(landing, /Purchases and staffing changes stay with your team/);
    assert.match(metadata, /inventory alerts/);
  });
});
