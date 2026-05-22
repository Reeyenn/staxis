/**
 * Regression guards for src/app/api/sms-reply/route.ts that the route
 * never persists inbound-SMS body content to webhook_log.
 *
 * Comms-voice audit P2 (2026-05-22). The pre-audit route wrote the full
 * inbound `text` and a 500-char `rawBodyPreview` on every webhook hit.
 * A housekeeper texting personal medical or employment info had that
 * content sitting in the database indefinitely. After the audit, only
 * stage, classification, length, redacted phone, and Twilio MessageSid
 * survive — incident reconstruction must go through Twilio's console.
 *
 * Why a static check instead of a behavior test: logHit() is a private
 * function inside the route module. Exercising the full POST handler
 * would require mocking six modules (signature verification, dedup,
 * rate limit, staff lookup, conf lookup, hotel lookup). The static
 * regression check below catches the failure modes that actually matter:
 *
 *   1. No `text:` key passed to logHit() — would leak the raw reply.
 *   2. No `rawBodyPreview:` key — would leak the raw form body.
 *
 * Both patterns existed in the pre-audit code. If they reappear (someone
 * copies an old log line, or merges an old branch), this test fails.
 *
 * False-positive risks (and why they're acceptable):
 *
 *   - Could match a comment that happens to mention those tokens. We
 *     scope the search to the function body around `logHit(` calls.
 *   - Could match a different `text:` key (e.g. in TwiML XML). The
 *     route doesn't have any such legitimate key today.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE_PATH = join(
  process.cwd(),
  'src/app/api/sms-reply/route.ts',
);

const routeSource = readFileSync(ROUTE_PATH, 'utf-8');

describe('sms-reply webhook_log PII minimization', () => {
  test('logHit calls do NOT include `text:` key (would persist message body)', () => {
    // Find every logHit({ ... }) block and check for `text:` inside.
    //
    // The regex below is intentionally broad: it captures `logHit({` and
    // everything up to the matching `})` on the same logical block. We
    // then assert the captured argument does NOT contain a bare `text:`
    // key (allowing `textLen:` which IS what we want).
    const logHitRe = /logHit\(\s*\{([\s\S]*?)\}\s*\)/g;
    const offenders: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = logHitRe.exec(routeSource)) !== null) {
      const args = match[1];
      // Match `text:` but NOT `textLen:` and NOT `hasText:`.
      // Negative lookahead: `text` followed by `:` but not preceded by a
      // word character (avoid matching `subText:`) and not followed by
      // `Len:` / `Class:` etc.
      if (/(^|[^a-zA-Z])text\s*:\s*[^L]/.test(args)) {
        offenders.push(args.trim().slice(0, 200));
      }
    }
    assert.equal(
      offenders.length,
      0,
      `logHit calls must not persist raw \`text:\` to webhook_log. Found ${offenders.length} offender(s):\n` +
        offenders.map(o => `  - ${o}`).join('\n'),
    );
  });

  test('logHit calls do NOT include `rawBodyPreview:` key', () => {
    assert.ok(
      !/rawBodyPreview\s*:/.test(routeSource),
      'Route must not write rawBodyPreview to webhook_log — that field used to leak the full inbound form body.',
    );
  });

  test('the canonical `received` log stage uses textLen instead of text', () => {
    // Find the `stage: 'received'` block and assert it has textLen but not text.
    const receivedBlockRe = /stage:\s*'received'[\s\S]*?\}\s*\)/;
    const m = receivedBlockRe.exec(routeSource);
    assert.ok(m, 'expected to find a logHit call with stage: received');
    const block = m![0];
    assert.ok(
      /textLen\s*:/.test(block),
      '`received` log stage must include textLen (length only, no body content)',
    );
    assert.ok(
      !/(^|[^a-zA-Z])text\s*:\s*[^L]/.test(block),
      '`received` log stage must NOT include text (the raw body)',
    );
  });

  test('STOP and START handlers log with replyClass + textLen, not raw text', () => {
    const optOutBlockRe = /stage:\s*'opt_out_request'[\s\S]*?\}\s*\)/;
    const optInBlockRe = /stage:\s*'opt_in_request'[\s\S]*?\}\s*\)/;
    const out = optOutBlockRe.exec(routeSource);
    const inb = optInBlockRe.exec(routeSource);
    assert.ok(out, 'STOP detection must log a `opt_out_request` stage');
    assert.ok(inb, 'START detection must log a `opt_in_request` stage');
    for (const block of [out![0], inb![0]]) {
      assert.ok(
        /replyClass\s*:/.test(block),
        `opt-out/in log stage must record replyClass: \n${block}`,
      );
      assert.ok(
        !/(^|[^a-zA-Z])text\s*:\s*[^L]/.test(block),
        `opt-out/in log stage must NOT record raw text: \n${block}`,
      );
    }
  });

  test('after_lookup log uses replyClass instead of free-form reply', () => {
    const afterLookupRe = /stage:\s*'after_lookup'[\s\S]*?\}\s*\)/;
    const m = afterLookupRe.exec(routeSource);
    assert.ok(m, 'expected to find after_lookup logHit');
    const block = m![0];
    assert.ok(
      /replyClass\s*:/.test(block),
      'after_lookup log must use replyClass (not raw normalised reply text)',
    );
    // The pre-audit code logged `reply` directly which is the full
    // normalise()'d input — guard against regression.
    assert.ok(
      !/(?:^|[\s,({])reply\s*:\s*reply\b/.test(block),
      'after_lookup log must NOT log the raw reply string',
    );
  });
});
