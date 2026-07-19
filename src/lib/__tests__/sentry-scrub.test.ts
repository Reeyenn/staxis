/**
 * Tests for the Sentry PII scrubber. Pins the redaction surface covered
 * by `scrubSentryEvent` and `scrubString` from src/lib/sentry-scrub.ts.
 *
 * These tests focus on the 2026-05-22 hardening additions — Codex BLOCKER #2
 * (frame-locals + contexts/user recursion) and the new regex set
 * (long-JWT, OpenAI key NOT regex'd, base64-image, Anthropic key). They
 * complement (don't replace) any existing scrubber tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scrubString, scrubSentryEvent, scrubSentryTransaction } from '@/lib/sentry-scrub';
import type { ErrorEvent } from '@sentry/nextjs';
import type { TransactionEvent } from '@sentry/core';

describe('scrubString — value-regex pass', () => {
  test('redacts Anthropic API keys (sk-ant-api03-…)', () => {
    const k = 'sk-ant-api03-' + 'A'.repeat(95);
    const out = scrubString(`upstream failed with key ${k}`);
    assert.ok(out.includes('<anthropic-key>'));
    assert.ok(!out.includes('sk-ant-api03-'));
  });

  test('redacts service-role-shaped long JWTs', () => {
    // Three segments: 30+, 30+, 200+ chars.
    const seg1 = 'eyJ' + 'A'.repeat(40);
    const seg2 = 'B'.repeat(40);
    const seg3 = 'C'.repeat(220);
    const longJwt = `${seg1}.${seg2}.${seg3}`;
    const out = scrubString(`Authorization rejected: ${longJwt}`);
    assert.ok(out.includes('<long-jwt>'));
    assert.ok(!out.includes(seg3));
  });

  test('redacts shorter anon-key-shaped JWTs', () => {
    const seg1 = 'eyJ' + 'A'.repeat(15);
    const seg2 = 'B'.repeat(15);
    const seg3 = 'C'.repeat(15);
    const out = scrubString(`token=${seg1}.${seg2}.${seg3}`);
    assert.ok(out.includes('<jwt>'));
    assert.ok(!out.includes(seg2));
  });

  test('redacts base64-image data URIs', () => {
    const img = 'data:image/png;base64,' + 'A'.repeat(200);
    const out = scrubString(`got payload ${img} from upstream`);
    assert.ok(out.includes('<base64-image>'));
    assert.ok(!out.includes('AAAA'));
  });

  test('phone + email redaction still works alongside new patterns', () => {
    const out = scrubString('contact maria@hotel.com or +1-555-123-4567');
    assert.ok(out.includes('<email>'));
    assert.ok(out.includes('<phone>'));
  });

  test('redacts literal and encoded phone-pairing URL fragments', () => {
    const token = 'a'.repeat(64);
    const literal = scrubString(`https://getstaxis.com/phone-signin-entry.html#pair=${token}`);
    const encoded = scrubString(`url=https%3A%2F%2Fgetstaxis.com%2Fphone-signin-entry.html%23pair%3D${token}`);
    assert.equal(literal.includes(token), false);
    assert.equal(encoded.includes(token), false);
    assert.match(literal, /<phone-pairing-token>/);
    assert.match(encoded, /<phone-pairing-token>/);
  });

  test('redacts literal and encoded organization invitation paths', () => {
    const token = 'd'.repeat(64);
    const literal = scrubString(`https://getstaxis.com/company-invite/${token}`);
    const encoded = scrubString(`url=https%3A%2F%2Fgetstaxis.com%2Fcompany-invite%2F${token}`);
    assert.equal(literal.includes(token), false);
    assert.equal(encoded.includes(token), false);
    assert.match(literal, /<company-invite-token>/);
    assert.match(encoded, /<company-invite-token>/);
  });
});

describe('phone-pairing telemetry URL defense', () => {
  test('scrubs request.url on error events', () => {
    const token = 'b'.repeat(64);
    const event = {
      request: { url: `https://getstaxis.com/phone-signin-entry.html#pair=${token}` },
    } as ErrorEvent;
    const out = scrubSentryEvent(event)!;
    assert.equal(out.request?.url?.includes(token), false);
  });

  test('scrubs transaction request, name, description, and span data', () => {
    const token = 'c'.repeat(64);
    const event = {
      type: 'transaction',
      transaction: `/phone-signin-entry.html#pair=${token}`,
      request: { url: `https://getstaxis.com/phone-signin-entry.html#pair=${token}` },
      spans: [{ description: `pageload #pair=${token}`, data: { url: `#pair=${token}` } }],
    } as unknown as TransactionEvent;
    const out = scrubSentryTransaction(event)!;
    assert.equal(JSON.stringify(out).includes(token), false);
  });
});

describe('scrubSentryEvent — frame-locals recursion (Codex BLOCKER #2)', () => {
  test('redacts vars inside event.exception.values[*].stacktrace.frames[*]', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  function: 'doWork',
                  vars: {
                    apiKey: 'sk-ant-api03-' + 'A'.repeat(95),
                    user_email: 'maria@hotel.com',
                    phone: '+1-555-555-1234',
                  },
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const out = scrubSentryEvent(event);
    assert.ok(out !== null);
    const vars = (out!.exception!.values![0] as { stacktrace?: { frames?: Array<{ vars?: Record<string, unknown> }> } })
      .stacktrace!.frames![0].vars!;
    // The key `apiKey` is in PII_KEYS so the value is dropped wholesale.
    assert.equal(vars.apiKey, '<redacted>');
    // user_email value scrubs via EMAIL_RX.
    assert.equal(vars.user_email, '<email>');
    // phone key is in PII_KEYS — wholesale redact.
    assert.equal(vars.phone, '<redacted>');
  });

  test('redacts pre_context / post_context source lines in frames', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  function: 'sendSms',
                  pre_context: [
                    "  const to = '+1-555-123-4567';",
                  ],
                  context_line: '  await twilio.send({ to })',
                  post_context: [
                    "  // succeeded for maria@hotel.com",
                  ],
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const out = scrubSentryEvent(event);
    const fr = (out!.exception!.values![0] as { stacktrace?: { frames?: Array<{ pre_context?: string[]; post_context?: string[]; context_line?: string }> } })
      .stacktrace!.frames![0];
    assert.ok(fr.pre_context![0].includes('<phone>'));
    assert.ok(fr.post_context![0].includes('<email>'));
    assert.equal(fr.context_line, '  await twilio.send({ to })');
  });
});

describe('scrubSentryEvent — user + cookies surfaces', () => {
  test('strips username/email/ip_address from event.user, keeps id', () => {
    const event = {
      user: { id: 'u_42', username: 'maria', email: 'maria@hotel.com', ip_address: '10.0.0.1' },
    } as unknown as ErrorEvent;
    const out = scrubSentryEvent(event);
    const u = out!.user as Record<string, unknown>;
    assert.equal(u.id, 'u_42');
    assert.equal(u.username, '<redacted>');
    assert.equal(u.email, '<redacted>');
    assert.equal(u.ip_address, '<redacted>');
  });

  test('drops event.request.cookies wholesale', () => {
    const event = {
      request: { cookies: { staxis_session: 'abc.def.ghi', other: 'xyz' } },
    } as unknown as ErrorEvent;
    const out = scrubSentryEvent(event);
    const c = (out!.request as { cookies?: Record<string, string> }).cookies!;
    assert.equal(c.staxis_session, '<redacted>');
    assert.equal(c.other, '<redacted>');
  });
});

describe('scrubSentryEvent — field-name PII_KEYS additions', () => {
  test('redacts api_key / openai_key / anthropic_key field values', () => {
    const event = {
      extra: {
        api_key: 'sk-proj-totally-real',
        openai_key: 'sk-svcacct-xyz',
        anthropic_key: 'sk-ant-api03-' + 'A'.repeat(95),
        resend_key: 're_realtoken',
        elevenlabs_key: 'el_xyz',
        // Verify normal fields pass through.
        keep_me: 'something-non-sensitive',
      },
    } as unknown as ErrorEvent;
    const out = scrubSentryEvent(event);
    const e = out!.extra as Record<string, unknown>;
    assert.equal(e.api_key, '<redacted>');
    assert.equal(e.openai_key, '<redacted>');
    assert.equal(e.anthropic_key, '<redacted>');
    assert.equal(e.resend_key, '<redacted>');
    assert.equal(e.elevenlabs_key, '<redacted>');
    assert.equal(e.keep_me, 'something-non-sensitive');
  });
});
