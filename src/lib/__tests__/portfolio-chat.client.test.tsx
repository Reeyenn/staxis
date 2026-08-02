import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import { __setPortfolioStreamLimitsForTesting } from '@/components/agent/useAgentChat';
import { supabase } from '@/lib/supabase';

const ORGANIZATION_A = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION_B = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

type FetchCall = {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
};

type MountedChat = {
  container: HTMLDivElement;
  root: Root;
  ask(question: string): Promise<void>;
  rerender(organizationId: string, available?: boolean): Promise<void>;
  setAvailable(available: boolean): Promise<void>;
  unmount(): Promise<void>;
};

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLSelectElement',
  'Node',
  'Event',
  'EventTarget',
  'CustomEvent',
  'MouseEvent',
  'InputEvent',
  'MutationObserver',
  'getComputedStyle',
] as const;

let modulePromise: Promise<typeof import('@/components/agent/PortfolioChat')> | null = null;

function loadPortfolioChat(): Promise<typeof import('@/components/agent/PortfolioChat')> {
  if (modulePromise) return modulePromise;
  const nodeRequire = createRequire(import.meta.url);
  const extensions = nodeRequire.extensions as Record<
    string,
    (module: NodeModule, filename: string) => void
  >;
  const originalCssLoader = extensions['.css'];
  extensions['.css'] = (module) => { module.exports = {}; };
  modulePromise = import('@/components/agent/PortfolioChat').finally(() => {
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

async function waitFor(
  predicate: () => boolean,
  message: string,
  delayMs = 0,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await flushMicrotasks();
      if (delayMs > 0) await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
      else await new Promise<void>((resolve) => { setImmediate(resolve); });
    });
  }
  assert.fail(message);
}

async function waitMs(durationMs: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => { setTimeout(resolve, durationMs); });
    await flushMicrotasks();
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function streamResponse(events: readonly Record<string, unknown>[]): Response {
  return rawStreamResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

function rawStreamResponse(body: string): Response {
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function stalledBodyResponse(onCancel: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    cancel() {
      onCancel();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function delayedStreamResponse(
  events: readonly Record<string, unknown>[],
  delayMs: number,
): Response {
  const chunks = events.map((event) => new TextEncoder().encode(
    `data: ${JSON.stringify(event)}\n\n`,
  ));
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
          controller.enqueue(chunk);
        }
        controller.close();
      } catch {
        // The test intentionally exercises reader cancellation mid-stream.
      }
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function activeScope(organizationId: string): Record<string, unknown> {
  return {
    organizationId,
    organizationName: organizationId === ORGANIZATION_A ? 'Company A' : 'Company B',
    selectorLabel: 'All hotels',
    selectedHotelCount: 1,
    authorizedHotelCount: 1,
    hotelNames: ['Hotel A'],
    hotelNamesOmitted: 0,
    coverage: { reported: 1, total: 1, omitted: 0 },
  };
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
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    const next = plans.shift();
    assert.ok(next, `unexpected fetch: ${String(input)}`);
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body,
      signal: init?.signal ?? null,
    });
    return next();
  });
  return calls;
}

function shortPortfolioLimits(
  context: TestContext,
  overrides: Partial<{
    inactivityMs: number;
    absoluteMs: number;
    maxFrameChars: number;
    maxAnswerChars: number;
  }> = {},
): void {
  __setPortfolioStreamLimitsForTesting({
    inactivityMs: 25,
    absoluteMs: 150,
    maxFrameChars: 4096,
    maxAnswerChars: 64,
    ...overrides,
  });
  context.after(() => { __setPortfolioStreamLimitsForTesting(); });
}

async function mountChat(
  context: TestContext,
  organizationId = ORGANIZATION_A,
): Promise<MountedChat> {
  const browser = installBrowser();
  const { createRoot } = await import('react-dom/client');
  const { PortfolioChat } = await loadPortfolioChat();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let currentAvailable = true;
  let currentOrganizationId = organizationId;
  let cleaned = false;

  const render = (nextOrganizationId: string, available = currentAvailable) => {
    currentOrganizationId = nextOrganizationId;
    currentAvailable = available;
    root.render(
      <PortfolioChat
        organizationId={nextOrganizationId}
        organizationName={nextOrganizationId === ORGANIZATION_A ? 'Company A' : 'Company B'}
        available={currentAvailable}
      />,
    );
  };
  await act(async () => {
    render(organizationId);
    await flushMicrotasks();
  });

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await act(async () => { root.unmount(); });
    container.remove();
    browser.restore();
  };
  context.after(cleanup);

  return {
    container,
    root,
    async ask(question) {
      const input = container.querySelector('input');
      assert.ok(input, 'portfolio chat input must render');
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
      const form = container.querySelector('form');
      assert.ok(form, 'portfolio chat composer must render');
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      assert.ok(submit, 'portfolio chat composer must expose a submit button');
      await act(async () => {
        submit.click();
        await flushMicrotasks();
      });
    },
    async rerender(nextOrganizationId, available = currentAvailable) {
      await act(async () => {
        render(nextOrganizationId, available);
        await flushMicrotasks();
      });
    },
    async setAvailable(available) {
      await act(async () => {
        render(currentOrganizationId, available);
        await flushMicrotasks();
      });
    },
    unmount: cleanup,
  };
}

describe('shared portfolio chat behavior', { concurrency: false }, () => {
  test('uses the portfolio route, carries its conversation id, and renders the verified scope', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => streamResponse([
        { type: 'conversation_id', id: CONVERSATION_ID },
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'text_delta', delta: 'Company A is current.' },
        { type: 'done', finalText: 'Company A is current.' },
      ]),
      () => jsonResponse({ data: { conversations: [{
        id: CONVERSATION_ID,
        title: 'Current hotels',
        updatedAt: '2026-08-01T12:00:00.000Z',
        conversationKind: 'portfolio',
        organizationId: ORGANIZATION_A,
      }] } }),
      () => streamResponse([
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'text_delta', delta: 'The follow-up is saved.' },
        { type: 'done', finalText: 'The follow-up is saved.' },
      ]),
      () => jsonResponse({ data: { conversations: [{
        id: CONVERSATION_ID,
        title: 'Current hotels',
        updatedAt: '2026-08-01T12:00:00.000Z',
        conversationKind: 'portfolio',
        organizationId: ORGANIZATION_A,
      }] } }),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');

    await app.ask('How are my hotels doing?');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Company A is current.'),
      'portfolio answer did not render',
    );
    const postCalls = calls.filter((call) => call.method === 'POST');
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].url, '/api/agent/portfolio');
    assert.deepEqual(postCalls[0].body, {
      organizationId: ORGANIZATION_A,
      message: 'How are my hotels doing?',
    });
    assert.match(app.container.textContent ?? '', /Company A · Scope: Hotel A/);
    assert.equal(app.container.querySelector('[role="log"]')?.getAttribute('aria-label'), 'Portfolio conversation');
    assert.equal(app.container.querySelector('select')?.value, CONVERSATION_ID);

    await app.ask('What should I check next?');
    await waitFor(
      () => (app.container.textContent ?? '').includes('The follow-up is saved.'),
      'portfolio follow-up did not render',
    );
    const followUp = calls.filter((call) => call.method === 'POST')[1];
    assert.equal(followUp.body?.conversationId, CONVERSATION_ID);
  });

  test('shows a retryable error and retries the failed question in a fresh conversation', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => jsonResponse({ error: 'database password and provider stack: do not render' }, 503),
      () => streamResponse([
        { type: 'conversation_id', id: CONVERSATION_ID },
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'text_delta', delta: 'Recovered.' },
        { type: 'done', finalText: 'Recovered.' },
      ]),
      () => jsonResponse({ data: { conversations: [] } }),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Try this again');
    await waitFor(
      () => (app.container.textContent ?? '').includes(
        'Staxis could not answer just now. Nothing about your hotels changed.',
      ),
      'portfolio error did not render',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /database password|provider stack/);
    assert.doesNotMatch(app.container.textContent ?? '', /Try this again/);
    const retry = app.container.querySelector<HTMLButtonElement>('[role="alert"] button');
    assert.ok(retry, 'portfolio error must expose a retry action');
    await act(async () => {
      retry.click();
      await flushMicrotasks();
    });
    await waitFor(
      () => (app.container.textContent ?? '').includes('Recovered.'),
      'portfolio retry did not render its answer',
    );
    const postCalls = calls.filter((call) => call.method === 'POST');
    assert.equal(postCalls.length, 2);
    assert.equal(Object.hasOwn(postCalls[1].body ?? {}, 'conversationId'), false);
    assert.equal(postCalls[1].body?.message, 'Try this again');
  });

  test('aborts an in-flight turn and masks its text when the company changes', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => new Promise<Response>(() => {}),
      () => jsonResponse({ data: { conversations: [] } }),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Keep this answer private to Company A');
    await waitFor(() => calls.length === 2, 'portfolio turn did not start');
    await app.rerender(ORGANIZATION_B);
    await waitFor(() => calls[1].signal?.aborted === true, 'company switch did not abort the active turn');
    assert.doesNotMatch(app.container.textContent ?? '', /Keep this answer private to Company A/);
  });

  test('fails stalled response headers with a bounded retryable error', async (context) => {
    shortPortfolioLimits(context, { inactivityMs: 20, absoluteMs: 70 });
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => new Promise<Response>(() => {}),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Stall before headers');
    await waitFor(() => calls.length === 2, 'portfolio request did not start');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'stalled headers did not become retryable',
      5,
    );
    assert.equal(calls[1].signal?.aborted, true);
    assert.doesNotMatch(app.container.textContent ?? '', /provider|database|stack/i);
  });

  test('cancels a stalled response body and clears its partial state', async (context) => {
    shortPortfolioLimits(context, { inactivityMs: 20, absoluteMs: 100 });
    let readerCancelled = false;
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => stalledBodyResponse(() => { readerCancelled = true; }),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Stall after headers');
    await waitFor(() => calls.length === 2, 'portfolio request did not start');
    await waitFor(
      () => readerCancelled && (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'stalled body was not cancelled and failed',
      5,
    );
    assert.doesNotMatch(app.container.textContent ?? '', /Reading your hotels…/);
  });

  test('resets inactivity only on valid progress and cleans the guard after done', async (context) => {
    shortPortfolioLimits(context, { inactivityMs: 70, absoluteMs: 250 });
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => delayedStreamResponse([
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'text_delta', delta: 'Progress stays alive.' },
        { type: 'done', finalText: 'Progress stays alive.' },
      ], 30),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Keep reading');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Progress stays alive.'),
      'valid progress did not reset inactivity',
      5,
    );
    await waitMs(120);
    assert.equal(calls[1].signal?.aborted, false);
    assert.doesNotMatch(app.container.textContent ?? '', /Staxis could not answer just now/);
  });

  test('enforces the absolute deadline even while valid progress arrives', async (context) => {
    shortPortfolioLimits(context, { inactivityMs: 100, absoluteMs: 45 });
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => delayedStreamResponse([
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'text_delta', delta: 'Still reading.' },
        { type: 'done', finalText: 'Still reading.' },
      ], 20),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Do not run forever');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'absolute deadline did not fail the turn',
      5,
    );
    assert.equal(calls[1].signal?.aborted, true);
    assert.doesNotMatch(app.container.textContent ?? '', /Still reading\./);
  });

  test('rejects oversized frames and multi-frame answers before exposure', async (context) => {
    shortPortfolioLimits(context, { maxFrameChars: 40, maxAnswerChars: 5 });
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => rawStreamResponse(`data: ${'x'.repeat(80)}\n\n`),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Oversized frame');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'oversized frame did not fail',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /xxxxxxxx/);
  });

  test('rejects a multi-frame answer that exceeds the total answer cap', async (context) => {
    shortPortfolioLimits(context, { maxAnswerChars: 5 });
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => streamResponse([
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'text_delta', delta: 'abc' },
        { type: 'text_delta', delta: 'de' },
        { type: 'text_delta', delta: 'f' },
        { type: 'done', finalText: 'abcdef' },
      ]),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Oversized answer');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'multi-frame answer cap did not fail',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /abcdef/);
  });

  test('requires scope and an explicit done at EOF', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => streamResponse([
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'text_delta', delta: 'Partial answer.' },
      ]),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Missing terminal');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'EOF without done did not fail',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /Partial answer\./);
    assert.equal(app.container.querySelector('[data-active-scope="true"]'), null);
  });

  test('rejects a missing scope or empty terminal answer', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => streamResponse([{ type: 'done', finalText: '' }]),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Empty terminal');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'empty terminal did not fail',
    );
    assert.equal(app.container.querySelector('[data-active-scope="true"]'), null);
  });

  test('rejects duplicate terminal events instead of presenting a completed answer', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => streamResponse([
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'done', finalText: 'Only once.' },
        { type: 'done', finalText: 'Twice is invalid.' },
      ]),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Duplicate terminal');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'duplicate terminal did not fail',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /Only once\.|Twice is invalid\./);
  });

  test('rejects text that arrives before the verified scope', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => streamResponse([
        { type: 'text_delta', delta: 'Before scope' },
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'done', finalText: 'Before scope' },
      ]),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Text before scope');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'text before scope did not fail',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /Before scope/);
  });

  test('rejects malformed frames without exposing their payload', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => rawStreamResponse('data: {not valid json}\n\n'),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Malformed frame');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'malformed frame did not fail',
    );
  });

  test('rejects unknown frames without exposing their payload', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => streamResponse([
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'provider_stack_dump', message: 'secret database payload' },
      ]),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Unknown frame');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'unknown frame did not fail',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /secret database payload|provider_stack_dump/);
  });

  test('sanitizes an SSE server error and offers a fresh retry', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => streamResponse([
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'error', message: 'postgres://secret stack trace' },
      ]),
      () => streamResponse([
        { type: 'active_scope', scope: activeScope(ORGANIZATION_A) },
        { type: 'done', finalText: 'Fresh retry succeeded.' },
      ]),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Retry after server error');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'SSE error did not become bounded',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /postgres|stack trace/);
    const retry = app.container.querySelector<HTMLButtonElement>('[role="alert"] button');
    assert.ok(retry);
    await act(async () => {
      retry.click();
      await flushMicrotasks();
    });
    await waitFor(
      () => (app.container.textContent ?? '').includes('Fresh retry succeeded.'),
      'fresh retry did not complete',
    );
    const posts = calls.filter(call => call.method === 'POST');
    assert.equal(Object.hasOwn(posts[1].body ?? {}, 'conversationId'), false);
  });

  test('sanitizes a thrown provider or network error in portfolio mode', async (context) => {
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => Promise.reject(new Error('provider stack and database details')),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Thrown error');
    await waitFor(
      () => (app.container.textContent ?? '').includes('Staxis could not answer just now.'),
      'thrown error did not become bounded',
    );
    assert.doesNotMatch(app.container.textContent ?? '', /provider stack|database details/);
  });

  test('availability off cancels and clears the turn, then reloads cleanly on', async (context) => {
    shortPortfolioLimits(context, { inactivityMs: 100, absoluteMs: 200 });
    let readerCancelled = false;
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => stalledBodyResponse(() => { readerCancelled = true; }),
      () => jsonResponse({ data: { conversations: [] } }),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Only Company A can see this');
    await waitFor(() => calls.length === 2, 'portfolio turn did not start');
    await app.setAvailable(false);
    await waitFor(() => readerCancelled && calls[1].signal?.aborted === true, 'availability off did not cancel');
    assert.match(app.container.textContent ?? '', /not available for Company A/i);
    assert.doesNotMatch(app.container.textContent ?? '', /Only Company A can see this/);
    await app.setAvailable(true);
    await waitFor(() => calls.length === 3, 'availability on did not reload saved chats');
    assert.doesNotMatch(app.container.textContent ?? '', /Only Company A can see this|Staxis could not answer just now/);
  });

  test('unmount cancels the active portfolio reader and cleans its timers', async (context) => {
    shortPortfolioLimits(context, { inactivityMs: 20, absoluteMs: 80 });
    let readerCancelled = false;
    const calls = installFetchPlans(context, [
      () => jsonResponse({ data: { conversations: [] } }),
      () => stalledBodyResponse(() => { readerCancelled = true; }),
    ]);
    const app = await mountChat(context);
    await waitFor(() => calls.length === 1, 'saved conversation probe did not complete');
    await app.ask('Unmount this turn');
    await waitFor(() => calls.length === 2, 'portfolio turn did not start');
    await app.unmount();
    assert.equal(calls[1].signal?.aborted, true);
    assert.equal(readerCancelled, true);
  });
});
