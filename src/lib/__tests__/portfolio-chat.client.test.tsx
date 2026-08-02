import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test, type TestContext } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

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
  rerender(organizationId: string): Promise<void>;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function streamResponse(events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(new TextEncoder().encode(body), {
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

  const render = (nextOrganizationId: string) => {
    root.render(
      <PortfolioChat
        organizationId={nextOrganizationId}
        organizationName={nextOrganizationId === ORGANIZATION_A ? 'Company A' : 'Company B'}
        available
      />,
    );
  };
  await act(async () => {
    render(organizationId);
    await flushMicrotasks();
  });

  context.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    browser.restore();
  });

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
    async rerender(nextOrganizationId) {
      await act(async () => {
        render(nextOrganizationId);
        await flushMicrotasks();
      });
    },
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
      conversationId: null,
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
      () => jsonResponse({ error: 'Saved portfolio chats could not be loaded.' }, 503),
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
      () => (app.container.textContent ?? '').includes('Saved portfolio chats could not be loaded.'),
      'portfolio error did not render',
    );
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
    assert.equal(postCalls[1].body?.conversationId, null);
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
});
