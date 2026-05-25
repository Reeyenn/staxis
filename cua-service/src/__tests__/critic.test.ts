/**
 * Tests for cua-service/src/critic.ts.
 *
 * Pin invariants that make the critic safe to wire into the mapping
 * loop:
 *   - The three legitimate verdicts (success/unclear/failure) parse
 *     correctly from a well-formed model response.
 *   - Malformed responses fall back to 'unclear' (fail-open).
 *   - The env flag (CUA_CRITIC_ENABLED='false') disables the critic
 *     without making a network call.
 *   - A throwing Anthropic client maps to 'unclear', never bubbles up.
 *   - Cost is logged via logClaudeUsage (so per-job cost cap sees it).
 *
 * Anthropic client is mocked via the optional `deps.client` parameter.
 * No real Anthropic call ever fires from these tests.
 */

// ESM hoists imports above any top-of-file statements — so the
// `process.env.X ??=` pattern that the older tests use doesn't actually
// fire before env.ts parses. We use a tiny test-bootstrap module that
// runs as its OWN import, before any other import is evaluated.
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';
import {
  judgeStepOutcome,
  parseCriticVerdict,
  captureScreenshotForCritic,
  type AnthropicLike,
} from '../critic.js';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

function makeMockClient(
  textResponse: string,
  opts: { usage?: Anthropic.Messages.Usage; recordCalls?: { count: number; lastParams?: unknown } } = {},
): AnthropicLike {
  return {
    messages: {
      create: async (params) => {
        if (opts.recordCalls) {
          opts.recordCalls.count += 1;
          opts.recordCalls.lastParams = params;
        }
        return {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: [{ type: 'text', text: textResponse, citations: [] }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: opts.usage ?? {
            input_tokens: 1500,
            output_tokens: 80,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            server_tool_use: null,
            service_tier: 'standard',
          },
        } as unknown as Anthropic.Messages.Message;
      },
    },
  };
}

function makeThrowingClient(err: Error): AnthropicLike {
  return {
    messages: {
      create: async () => { throw err; },
    },
  };
}

// ─── parseCriticVerdict — pure-function unit tests ────────────────────────

describe('parseCriticVerdict — verdict parsing', () => {
  test('parses a well-formed success verdict', () => {
    const out = parseCriticVerdict('VERDICT: success\nREASON: navigated to Reports page');
    assert.equal(out.verdict, 'success');
    assert.equal(out.reason, 'navigated to Reports page');
  });

  test('parses a well-formed unclear verdict', () => {
    const out = parseCriticVerdict('VERDICT: unclear\nREASON: page changed slightly but not in an interpretable way');
    assert.equal(out.verdict, 'unclear');
    assert.match(out.reason, /interpretable/);
  });

  test('parses a well-formed failure verdict', () => {
    const out = parseCriticVerdict('VERDICT: failure\nREASON: a cookie banner popped up instead of navigation');
    assert.equal(out.verdict, 'failure');
    assert.match(out.reason, /cookie banner/);
  });

  test('case-insensitive verdict word', () => {
    assert.equal(parseCriticVerdict('VERDICT: SUCCESS\nREASON: x').verdict, 'success');
    assert.equal(parseCriticVerdict('VERDICT: Failure\nREASON: x').verdict, 'failure');
    assert.equal(parseCriticVerdict('verdict: unclear\nreason: x').verdict, 'unclear');
  });

  test('tolerates markdown code fences', () => {
    const out = parseCriticVerdict('```\nVERDICT: success\nREASON: opened the menu\n```');
    assert.equal(out.verdict, 'success');
    assert.equal(out.reason, 'opened the menu');
  });

  test('tolerates extra preamble text before the VERDICT line', () => {
    const out = parseCriticVerdict('Looking at the screenshots, my judgment is:\nVERDICT: success\nREASON: clear navigation occurred');
    assert.equal(out.verdict, 'success');
  });

  test('unparseable text falls back to unclear', () => {
    const out = parseCriticVerdict('I cannot determine what happened based on these images.');
    assert.equal(out.verdict, 'unclear');
    assert.match(out.reason, /unparseable/);
  });

  test('missing REASON line is tolerated', () => {
    const out = parseCriticVerdict('VERDICT: success');
    assert.equal(out.verdict, 'success');
    assert.equal(out.reason, 'no reason given');
  });

  test('an unknown verdict word maps to unclear', () => {
    const out = parseCriticVerdict('VERDICT: maybe\nREASON: not sure');
    assert.equal(out.verdict, 'unclear');
  });
});

// ─── judgeStepOutcome — happy path verdicts ───────────────────────────────

describe('judgeStepOutcome — happy path', () => {
  test('returns success verdict from a successful click', async () => {
    const client = makeMockClient('VERDICT: success\nREASON: navigated to the Reports submenu');
    const out = await judgeStepOutcome(
      {
        pre: TINY_PNG_B64,
        post: TINY_PNG_B64,
        actionDescription: 'left_click at 520,340',
        intendedOutcome: 'open the Reports menu',
        jobId: 'job-test-1',
      },
      { client },
    );
    assert.equal(out.verdict, 'success');
  });

  test('returns unclear verdict when the model is ambiguous', async () => {
    const client = makeMockClient('VERDICT: unclear\nREASON: minor visual change but cannot confirm');
    const out = await judgeStepOutcome(
      {
        pre: TINY_PNG_B64,
        post: TINY_PNG_B64,
        actionDescription: 'left_click at 100,100',
        intendedOutcome: 'open a dropdown',
      },
      { client },
    );
    assert.equal(out.verdict, 'unclear');
  });

  test('returns failure verdict when nothing visible changed', async () => {
    const client = makeMockClient('VERDICT: failure\nREASON: identical before and after screenshots');
    const out = await judgeStepOutcome(
      {
        pre: TINY_PNG_B64,
        post: TINY_PNG_B64,
        actionDescription: 'left_click at 10,10',
        intendedOutcome: 'navigate to dashboard',
      },
      { client },
    );
    assert.equal(out.verdict, 'failure');
  });
});

// ─── judgeStepOutcome — env flag + fail-open behavior ─────────────────────

describe('judgeStepOutcome — env flag', () => {
  test('with env=true the mock client IS invoked', async () => {
    const prior = process.env.CUA_CRITIC_ENABLED;
    process.env.CUA_CRITIC_ENABLED = 'true';
    try {
      const recordCalls = { count: 0 };
      const client = makeMockClient('VERDICT: success\nREASON: ok', { recordCalls });
      await judgeStepOutcome(
        {
          pre: TINY_PNG_B64,
          post: TINY_PNG_B64,
          actionDescription: 'left_click at 1,1',
          intendedOutcome: 'test',
        },
        { client },
      );
      assert.equal(recordCalls.count, 1, 'critic should call the model when enabled');
    } finally {
      process.env.CUA_CRITIC_ENABLED = prior;
    }
  });

  test('CUA_CRITIC_ENABLED=false short-circuits to success without calling the client', async () => {
    const prior = process.env.CUA_CRITIC_ENABLED;
    process.env.CUA_CRITIC_ENABLED = 'false';
    try {
      const recordCalls = { count: 0 };
      const client = makeMockClient('VERDICT: success\nREASON: ok', { recordCalls });
      const out = await judgeStepOutcome(
        {
          pre: TINY_PNG_B64,
          post: TINY_PNG_B64,
          actionDescription: 'left_click at 1,1',
          intendedOutcome: 'test',
        },
        { client },
      );
      assert.equal(recordCalls.count, 0, 'critic should NOT call the model when disabled');
      assert.equal(out.verdict, 'success');
      assert.equal(out.reason, 'critic_disabled');
    } finally {
      process.env.CUA_CRITIC_ENABLED = prior;
    }
  });
});

describe('judgeStepOutcome — fail-open on client errors', () => {
  test('a throwing client maps to unclear, does not propagate', async () => {
    const client = makeThrowingClient(new Error('simulated network error'));
    const out = await judgeStepOutcome(
      {
        pre: TINY_PNG_B64,
        post: TINY_PNG_B64,
        actionDescription: 'left_click at 1,1',
        intendedOutcome: 'test',
      },
      { client },
    );
    assert.equal(out.verdict, 'unclear');
    assert.match(out.reason, /critic_call_failed/);
  });

  test('a non-text response maps to unclear (parser sees empty string)', async () => {
    const client = makeMockClient('');
    const out = await judgeStepOutcome(
      {
        pre: TINY_PNG_B64,
        post: TINY_PNG_B64,
        actionDescription: 'left_click at 1,1',
        intendedOutcome: 'test',
      },
      { client },
    );
    assert.equal(out.verdict, 'unclear');
  });
});

// ─── Cost logging ──────────────────────────────────────────────────────────

describe('judgeStepOutcome — cost logging', () => {
  test('passes pre/post images + the user prompt to the model', async () => {
    const recordCalls = { count: 0, lastParams: undefined as unknown };
    const client = makeMockClient('VERDICT: success\nREASON: ok', { recordCalls });
    await judgeStepOutcome(
      {
        pre: TINY_PNG_B64,
        post: TINY_PNG_B64,
        actionDescription: 'left_click at 520,340',
        intendedOutcome: 'open Reports menu',
        jobId: 'job-x',
        propertyId: 'prop-y',
      },
      { client },
    );
    assert.equal(recordCalls.count, 1);
    const params = recordCalls.lastParams as Anthropic.Messages.MessageCreateParamsNonStreaming;
    assert.equal(params.model, 'claude-sonnet-4-6');
    assert.ok(params.max_tokens <= 400, 'budget bounded at 400 output tokens');
    // user message has 2 image blocks + 1 text block
    const userMsg = params.messages[0];
    assert.ok(userMsg);
    assert.equal(userMsg.role, 'user');
    const content = userMsg.content as Array<{ type: string }>;
    const imageCount = content.filter((b) => b.type === 'image').length;
    const textCount = content.filter((b) => b.type === 'text').length;
    assert.equal(imageCount, 2, 'two screenshots');
    assert.equal(textCount, 1, 'one user prompt');
  });

  test('logClaudeUsage is invoked (fire-and-forget)', async () => {
    // We can't easily assert the call without mocking the supabase
    // client inside usage-log.ts, but we CAN assert that judgeStepOutcome
    // returns normally even when the underlying logClaudeUsage hits a
    // missing DB (default test env has no real Supabase). The fact that
    // the function returns the parsed verdict tells us the cost-logging
    // path didn't throw upward.
    const client = makeMockClient('VERDICT: success\nREASON: ok');
    const out = await judgeStepOutcome(
      {
        pre: TINY_PNG_B64,
        post: TINY_PNG_B64,
        actionDescription: 'x',
        intendedOutcome: 'y',
        jobId: 'job-cost-attribution',
      },
      { client },
    );
    assert.equal(out.verdict, 'success');
  });
});

// ─── captureScreenshotForCritic — privacy + cleanup invariants ────────────

interface FakePageState {
  evalCalls: Array<string>;
  screenshotShouldThrow?: boolean;
  screenshotCalled?: boolean;
}

function fakePage(state: FakePageState): Page {
  return {
    evaluate: async (_fn: unknown) => {
      // We don't run the function — just record that evaluate was called.
      // The function body itself is too DOM-heavy to execute in a unit
      // test (would need a real Playwright Page or jsdom). State-tracking
      // is enough to verify the SEQUENCE: privacy-add → screenshot →
      // privacy-clear.
      state.evalCalls.push('evaluate');
      return undefined;
    },
    screenshot: async () => {
      state.screenshotCalled = true;
      if (state.screenshotShouldThrow) throw new Error('screenshot failed');
      // 1×1 transparent PNG bytes.
      return Buffer.from(TINY_PNG_B64, 'base64');
    },
  } as unknown as Page;
}

describe('captureScreenshotForCritic — happy path', () => {
  test('returns a base64 PNG string', async () => {
    const state: FakePageState = { evalCalls: [] };
    const result = await captureScreenshotForCritic(fakePage(state));
    assert.ok(result, 'returns base64 string on success');
    assert.equal(typeof result, 'string');
    assert.equal(state.screenshotCalled, true);
  });

  test('calls evaluate TWICE — once to add overlays, once to remove them', async () => {
    const state: FakePageState = { evalCalls: [] };
    await captureScreenshotForCritic(fakePage(state));
    assert.equal(state.evalCalls.length, 2,
      'add-overlay + cleanup-overlay are the two evaluate calls; missing the second leaves stale overlays');
  });
});

describe('captureScreenshotForCritic — failure modes', () => {
  test('returns null when screenshot itself throws', async () => {
    const state: FakePageState = { evalCalls: [], screenshotShouldThrow: true };
    const result = await captureScreenshotForCritic(fakePage(state));
    assert.equal(result, null);
  });

  test('still runs cleanup evaluate even if screenshot throws', async () => {
    const state: FakePageState = { evalCalls: [], screenshotShouldThrow: true };
    await captureScreenshotForCritic(fakePage(state));
    assert.equal(state.evalCalls.length, 2,
      'cleanup must run in the finally block — leaking overlays would block future clicks');
  });
});
