/** Sentry delivery claims must be released when the SMS was not sent. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'sentry-webhook', 'route.ts'),
  'utf8',
);

describe('Sentry webhook retry contract', () => {
  test('SMS failure deletes the event claim before returning 500', () => {
    const catchBlock = source.match(
      /catch \(e\) \{[\s\S]*?Twilio send failed([\s\S]*?)return err\(['"]twilio send failed/,
    )?.[1] ?? '';
    assert.ok(catchBlock, 'expected Twilio failure catch block');
    assert.match(catchBlock, /\.from\(['"]processed_sentry_webhooks['"]\)/);
    assert.match(catchBlock, /\.delete\(\)/);
    assert.match(catchBlock, /\.eq\(['"]event_id['"],\s*eventId\)/);
  });

  test('a merely claimed duplicate stays retryable until completion', () => {
    assert.match(source, /processing_state:\s*['"]claimed['"]/);
    assert.match(source, /metadata\?\.processing_state === ['"]claimed['"][\s\S]*status:\s*503/);
    assert.match(source, /processing_state:\s*['"]completed['"]/);
    assert.match(source, /markClaimCompleted\(['"]sms_sent['"]\)/);
  });
});
