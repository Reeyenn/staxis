/**
 * Tests for scraper/page-helpers.js
 *
 * Run: node --test scraper/__tests__/page-helpers.test.js
 *
 * Or all scraper tests at once: node --test scraper/__tests__
 *
 * No test framework dependency — uses Node's built-in node:test (>=v18).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isExecutionContextDestroyed,
  safeEval,
  settlePage,
} = require('../page-helpers');

describe('isExecutionContextDestroyed', () => {
  test('matches the canonical Playwright message', () => {
    assert.equal(
      isExecutionContextDestroyed(new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')),
      true,
    );
  });

  test('matches the present-tense variant', () => {
    assert.equal(
      isExecutionContextDestroyed(new Error('Execution context is destroyed')),
      true,
    );
  });

  test('does not match unrelated errors', () => {
    assert.equal(isExecutionContextDestroyed(new Error('timeout exceeded')), false);
    assert.equal(isExecutionContextDestroyed(new Error('page closed')), false);
    assert.equal(isExecutionContextDestroyed(new Error('selector not found')), false);
  });

  test('handles non-Error inputs', () => {
    assert.equal(isExecutionContextDestroyed(null), false);
    assert.equal(isExecutionContextDestroyed(undefined), false);
    assert.equal(isExecutionContextDestroyed('Execution context was destroyed'), true);
  });
});

describe('safeEval', () => {
  test('returns the result on first attempt when there is no error', async () => {
    // Mimic Playwright's page.evaluate signature: it calls fn with the
    // varargs passed to evaluate (which are the safeEval extra args).
    const fakePage = {
      evaluate: async (fn, ...args) => fn(...args),
    };
    const result = await safeEval(fakePage, (n) => n + 1, 41);
    assert.equal(result, 42);
  });

  test('retries on Execution context destroyed and succeeds on retry', async () => {
    let calls = 0;
    const fakePage = {
      evaluate: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Execution context was destroyed, most likely because of a navigation');
        return 'ok';
      },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
    };
    const result = await safeEval(fakePage, () => 'noop');
    assert.equal(calls, 2);
    assert.equal(result, 'ok');
  });

  test('does NOT retry on unrelated errors', async () => {
    let calls = 0;
    const fakePage = {
      evaluate: async () => {
        calls += 1;
        throw new Error('selector not found');
      },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
    };
    await assert.rejects(
      safeEval(fakePage, () => 'noop'),
      /selector not found/,
    );
    assert.equal(calls, 1);
  });

  test('throws after max attempts when context destruction is persistent', async () => {
    let calls = 0;
    const fakePage = {
      evaluate: async () => {
        calls += 1;
        throw new Error('Execution context was destroyed');
      },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
    };
    await assert.rejects(safeEval(fakePage, () => 'noop'), /Execution context was destroyed/);
    assert.equal(calls, 3); // MAX_ATTEMPTS = 3
  });
});

describe('settlePage', () => {
  test('calls waitForLoadState twice with load and networkidle', async () => {
    const calls = [];
    const fakePage = {
      waitForLoadState: async (state, opts) => {
        calls.push({ state, timeout: opts?.timeout });
      },
    };
    await settlePage(fakePage);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].state, 'load');
    assert.equal(calls[1].state, 'networkidle');
  });

  test('swallows timeouts on each waitForLoadState call', async () => {
    const fakePage = {
      waitForLoadState: async () => {
        throw new Error('Timeout 15000ms exceeded');
      },
    };
    // Should not throw — settlePage is supposed to be tolerant.
    await settlePage(fakePage);
  });
});
