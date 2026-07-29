import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import { supabase } from '@/lib/supabase';

type PortfolioAskModule = typeof import('@/components/agent/PortfolioAsk');

type FetchCall = {
  signal: AbortSignal | null;
  body: Record<string, unknown> | null;
};

type MountedAsk = {
  container: HTMLDivElement;
  root: Root;
  browser: ReturnType<typeof installBrowser>;
  ask(question: string): Promise<void>;
  clickAction(): Promise<void>;
};

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Node',
  'Event',
  'EventTarget',
  'MouseEvent',
  'InputEvent',
  'MutationObserver',
  'getComputedStyle',
] as const;

let modulePromise: Promise<PortfolioAskModule> | null = null;

function loadPortfolioAsk(): Promise<PortfolioAskModule> {
  if (modulePromise) return modulePromise;
  const nodeRequire = createRequire(import.meta.url);
  const extensions = nodeRequire.extensions as Record<
    string,
    (module: NodeModule, filename: string) => void
  >;
  const originalCssLoader = extensions['.css'];
  extensions['.css'] = (module) => { module.exports = {}; };
  modulePromise = import('@/components/agent/PortfolioAsk').finally(() => {
    if (originalCssLoader) extensions['.css'] = originalCssLoader;
    else delete extensions['.css'];
  });
  return modulePromise;
}

function installBrowser(): { restore(): void } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/portfolio',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();

  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function' && key === 'getComputedStyle'
      ? candidate.bind(dom.window)
      : candidate;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
  originals.set(actFlag, Object.getOwnPropertyDescriptor(globalThis, actFlag));
  Object.defineProperty(globalThis, actFlag, {
    configurable: true,
    writable: true,
    value: true,
  });

  return {
    restore() {
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    });
  }
  assert.fail(message);
}

function sseResponse(frame: string): Response {
  return new Response(new TextEncoder().encode(frame), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function installFetchPlans(
  context: TestContext,
  plans: Array<() => Response | Promise<Response>>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  context.mock.method(supabase.auth, 'getSession', async () => ({
    data: { session: null },
    error: null,
  }));
  context.mock.method(globalThis, 'fetch', async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { /* asserted by route */ }
    }
    calls.push({ signal: init?.signal ?? null, body });
    const next = plans.shift();
    assert.ok(next, 'PortfolioAsk issued an unexpected request');
    return next();
  });
  return calls;
}

async function mountAsk(context: TestContext): Promise<MountedAsk> {
  const browser = installBrowser();
  const { createRoot } = await import('react-dom/client');
  const { PortfolioAsk } = await loadPortfolioAsk();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <PortfolioAsk
        organizationId={ORGANIZATION_ID}
        organizationName="Company A"
        available
      />,
    );
    await flushMicrotasks();
  });

  context.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    browser.restore();
  });

  const clickAction = async () => {
    const button = container.querySelector('button');
    assert.ok(button, 'Ask action must render');
    assert.equal(button.disabled, false, 'Ask action must be enabled before clicking');
    await act(async () => {
      button.click();
      await flushMicrotasks();
    });
  };

  return {
    browser,
    container,
    root,
    async ask(question) {
      const input = container.querySelector('input');
      assert.ok(input, 'Ask input must render');
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      assert.ok(valueSetter, 'JSDOM input value setter must exist');
      await act(async () => {
        valueSetter.call(input, question);
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          data: question,
          inputType: 'insertText',
        }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await flushMicrotasks();
      });
      await clickAction();
    },
    clickAction,
  };
}

describe('PortfolioAsk terminal stream behavior', { concurrency: false }, () => {
  test('a stalled stream reaches a failed, retryable state and aborts its request', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    context.after(() => { context.mock.timers.reset(); });
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    const calls = installFetchPlans(context, [
      () => new Response(stalled, { status: 200 }),
    ]);
    const app = await mountAsk(context);
    const { PORTFOLIO_ASK_STREAM_INACTIVITY_MS } = await loadPortfolioAsk();

    await app.ask('Where should I focus?');
    await waitFor(() => calls.length === 1, 'portfolio request did not start');
    assert.match(app.container.textContent ?? '', /Reading your hotels/);

    await act(async () => {
      context.mock.timers.tick(PORTFOLIO_ASK_STREAM_INACTIVITY_MS);
      await flushMicrotasks();
    });

    assert.equal(calls[0].signal?.aborted, true);
    assert.equal(cancelled, true);
    assert.match(app.container.textContent ?? '', /could not answer just now/);
    assert.equal(app.container.querySelector('[aria-busy="true"]'), null);
    assert.equal(app.container.querySelector('button')?.textContent, 'Try again');
  });

  test('an empty completed stream fails instead of leaving Reading visible', async (context) => {
    installFetchPlans(context, [
      () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
      }), { status: 200 }),
    ]);
    const app = await mountAsk(context);

    await app.ask('What changed?');
    await waitFor(
      () => app.container.querySelector('button')?.textContent === 'Try again',
      'empty EOF did not publish a terminal failure',
    );

    assert.doesNotMatch(app.container.textContent ?? '', /Reading your hotels/);
    assert.match(app.container.textContent ?? '', /Nothing about your hotels changed/);
    assert.equal(app.container.querySelector('[aria-busy="true"]'), null);
  });

  test('the final JSON SSE frame is processed at EOF without a trailing delimiter', async (context) => {
    installFetchPlans(context, [
      () => sseResponse('data: {"type":"done","finalText":"North is fully staffed."}'),
    ]);
    const app = await mountAsk(context);

    await app.ask('How is staffing?');
    await waitFor(
      () => (app.container.textContent ?? '').includes('North is fully staffed.'),
      'the delimiter-free final frame was not rendered',
    );

    assert.equal(app.container.querySelector('button')?.textContent, 'Ask');
    assert.equal(app.container.querySelector('[aria-busy="true"]'), null);
    assert.doesNotMatch(app.container.textContent ?? '', /could not answer/);
  });

  test('retry owns a new stream and completed cleanup cannot fire a stale deadline', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    context.after(() => { context.mock.timers.reset(); });
    let firstCancelled = false;
    const calls = installFetchPlans(context, [
      () => new Response(new ReadableStream<Uint8Array>({
        cancel() { firstCancelled = true; },
      }), { status: 200 }),
      () => sseResponse('{"type":"done","finalText":"All clear after retry."}'),
    ]);
    const app = await mountAsk(context);
    const { PORTFOLIO_ASK_STREAM_INACTIVITY_MS } = await loadPortfolioAsk();

    await app.ask('Show my exceptions');
    await waitFor(() => calls.length === 1, 'first request did not start');
    await act(async () => {
      context.mock.timers.tick(PORTFOLIO_ASK_STREAM_INACTIVITY_MS);
      await flushMicrotasks();
    });
    assert.equal(app.container.querySelector('button')?.textContent, 'Try again');

    await app.clickAction();
    await waitFor(
      () => (app.container.textContent ?? '').includes('All clear after retry.'),
      'retry response did not replace the terminal failure',
    );
    assert.equal(calls.length, 2);
    assert.equal(firstCancelled, true);

    await act(async () => {
      context.mock.timers.tick(PORTFOLIO_ASK_STREAM_INACTIVITY_MS * 2);
      await flushMicrotasks();
    });
    assert.match(app.container.textContent ?? '', /All clear after retry/);
    assert.doesNotMatch(app.container.textContent ?? '', /could not answer/);
    assert.equal(calls.length, 2, 'deadline cleanup must not start another request');
  });

  test('partial or malformed EOF never presents a truncated answer as complete', async (context) => {
    installFetchPlans(context, [
      () => sseResponse('data: {"type":"text_delta","delta":"Only a partial"}\n\n'),
      () => sseResponse(
        'data: {"type":"text_delta","delta":"Another partial"}\n\n'
        + 'data: {not-json}',
      ),
    ]);
    const app = await mountAsk(context);

    await app.ask('First question');
    await waitFor(
      () => app.container.querySelector('button')?.textContent === 'Try again',
      'partial EOF did not become a retryable failure',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /Only a partial/);

    await app.ask('Second question');
    await waitFor(
      () => app.container.querySelector('button')?.textContent === 'Try again',
      'malformed final frame did not become a retryable failure',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /Another partial/);
  });

  test('error frames are sanitized and remain retryable', async (context) => {
    installFetchPlans(context, [
      () => sseResponse(
        'data: {"type":"error","message":"provider-key sk-secret database_column"}\n\n',
      ),
    ]);
    const app = await mountAsk(context);

    await app.ask('Show exceptions');
    await waitFor(
      () => app.container.querySelector('button')?.textContent === 'Try again',
      'error frame did not become retryable',
    );

    const text = app.container.textContent ?? '';
    assert.match(text, /could not answer just now/);
    assert.doesNotMatch(text, /provider-key|sk-secret|database_column/);
    assert.equal(app.container.querySelector('[aria-busy="true"]'), null);
  });

  test('retry after a production conversation id starts fresh instead of duplicating the turn', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    context.after(() => { context.mock.timers.reset(); });
    const first = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: {"type":"conversation_id","id":"${ORGANIZATION_ID}"}\n\n`,
        ));
      },
    });
    const calls = installFetchPlans(context, [
      () => new Response(first, { status: 200 }),
      () => sseResponse('{"type":"done","finalText":"Fresh retry answer."}'),
    ]);
    const app = await mountAsk(context);
    const { PORTFOLIO_ASK_STREAM_INACTIVITY_MS } = await loadPortfolioAsk();

    await app.ask('Show my exceptions');
    await waitFor(() => calls.length === 1, 'first request did not start');
    await act(async () => {
      context.mock.timers.tick(PORTFOLIO_ASK_STREAM_INACTIVITY_MS);
      await flushMicrotasks();
    });
    assert.equal(app.container.querySelector('button')?.textContent, 'Try again');

    await app.clickAction();
    await waitFor(
      () => (app.container.textContent ?? '').includes('Fresh retry answer.'),
      'fresh retry did not complete',
    );
    assert.equal(calls[0].body?.message, 'Show my exceptions');
    assert.equal(calls[0].body?.conversationId, undefined);
    assert.equal(calls[1].body?.message, 'Show my exceptions');
    assert.equal(
      calls[1].body?.conversationId,
      undefined,
      'a failed persisted turn must not be appended to again',
    );
  });

  test('same-company availability revocation aborts and clears an active answer', async (context) => {
    const stalled = new ReadableStream<Uint8Array>({});
    const calls = installFetchPlans(context, [
      () => new Response(stalled, { status: 200 }),
    ]);
    const app = await mountAsk(context);
    const { PortfolioAsk } = await loadPortfolioAsk();

    await app.ask('What needs attention?');
    await waitFor(() => calls.length === 1, 'portfolio request did not start');
    await act(async () => {
      app.root.render(
        <PortfolioAsk
          organizationId={ORGANIZATION_ID}
          organizationName="Company A"
          available={false}
          unavailableReason="company_setting_off"
        />,
      );
      await flushMicrotasks();
    });

    assert.equal(calls[0].signal?.aborted, true);
    assert.equal(app.container.querySelector('input'), null);
    assert.doesNotMatch(app.container.textContent ?? '', /Reading your hotels/);
    assert.match(app.container.textContent ?? '', /turned off/);
  });

  test('valid progress resets inactivity but cannot extend the absolute deadline', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    context.after(() => { context.mock.timers.reset(); });
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    });
    const calls = installFetchPlans(context, [
      () => new Response(stream, { status: 200 }),
    ]);
    const app = await mountAsk(context);
    const {
      PORTFOLIO_ASK_ABSOLUTE_MS,
      PORTFOLIO_ASK_STREAM_INACTIVITY_MS,
    } = await loadPortfolioAsk();

    await app.ask('Keep reading');
    await waitFor(() => calls.length === 1, 'portfolio request did not start');
    for (let index = 0; index < 2; index += 1) {
      await act(async () => {
        context.mock.timers.tick(PORTFOLIO_ASK_STREAM_INACTIVITY_MS - 1_000);
        streamController?.enqueue(new TextEncoder().encode(
          `data: {"type":"text_delta","delta":"progress-${index} "}\n\n`,
        ));
        await flushMicrotasks();
      });
      assert.equal(app.container.querySelector('button')?.textContent, 'Reading…');
    }

    await act(async () => {
      context.mock.timers.tick(PORTFOLIO_ASK_ABSOLUTE_MS);
      await flushMicrotasks();
    });
    assert.equal(calls[0].signal?.aborted, true);
    assert.equal(app.container.querySelector('button')?.textContent, 'Try again');
  });

  test('oversized answer frames fail closed', async (context) => {
    const { PORTFOLIO_ASK_MAX_ANSWER_CHARS } = await loadPortfolioAsk();
    installFetchPlans(context, [
      () => sseResponse(`data: ${JSON.stringify({
        type: 'text_delta',
        delta: 'x'.repeat(PORTFOLIO_ASK_MAX_ANSWER_CHARS + 1),
      })}\n\n`),
    ]);
    const app = await mountAsk(context);

    await app.ask('Export everything');
    await waitFor(
      () => app.container.querySelector('button')?.textContent === 'Try again',
      'oversized answer did not fail closed',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /x{200}/);
  });
});
