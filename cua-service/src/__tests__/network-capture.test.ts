/**
 * Tests for network-capture.ts — passive capture of the page's underlying
 * data calls during a learn run.
 *
 * Fakes follow the screenshot-privacy.test.ts pattern: minimal objects that
 * record calls, cast `as unknown as Page`. The fake page/context both trap
 * any ACCESS to `.route` (passivity guard) and the emit helper mirrors real
 * Playwright ordering (context listener sees the same Response instance the
 * page would).
 */

import './_bootstrap-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Response } from 'playwright';
import { attachNetworkCapture } from '../network-capture.js';

// ─── Fakes ───────────────────────────────────────────────────────────────

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private listeners = new Map<string, Array<{ fn: Listener; once: boolean; orig: Listener }>>();

  private list(event: string): Array<{ fn: Listener; once: boolean; orig: Listener }> {
    let l = this.listeners.get(event);
    if (!l) {
      l = [];
      this.listeners.set(event, l);
    }
    return l;
  }

  on(event: string, fn: Listener): this {
    this.list(event).push({ fn, once: false, orig: fn });
    return this;
  }

  once(event: string, fn: Listener): this {
    this.list(event).push({ fn, once: true, orig: fn });
    return this;
  }

  off(event: string, fn: Listener): this {
    const l = this.listeners.get(event);
    if (l) {
      const i = l.findIndex((x) => x.orig === fn);
      if (i >= 0) l.splice(i, 1);
    }
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const x of [...(this.listeners.get(event) ?? [])]) {
      if (x.once) this.off(event, x.orig);
      x.fn(...args);
    }
  }

  count(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }
}

function trapRoute(obj: object, what: string): void {
  Object.defineProperty(obj, 'route', {
    get() {
      throw new Error(`${what}.route accessed — capture must stay passive`);
    },
  });
}

class FakeContext extends FakeEmitter {
  constructor() {
    super();
    trapRoute(this, 'context');
  }
}

class FakePage extends FakeEmitter {
  private readonly ctx: FakeContext;
  private pageUrl: string;

  constructor(ctx: FakeContext, url = 'https://pms.example.com/dashboard') {
    super();
    this.ctx = ctx;
    this.pageUrl = url;
    trapRoute(this, 'page');
  }

  url(): string {
    return this.pageUrl;
  }

  context(): FakeContext {
    return this.ctx;
  }
}

interface ResponseOpts {
  url: string;
  page: FakePage;
  status?: number;
  method?: string;
  resourceType?: string;
  headers?: Record<string, string>;
  requestHeaders?: Record<string, string>;
  postData?: string | null;
  serviceWorker?: unknown;
  frameThrows?: boolean;
  body?: string;
  text?: () => Promise<string>;
}

function makeResponse(opts: ResponseOpts): Response {
  const request = {
    resourceType: () => opts.resourceType ?? 'xhr',
    method: () => opts.method ?? 'GET',
    headers: () => opts.requestHeaders ?? {},
    postData: () => opts.postData ?? null,
    serviceWorker: () => opts.serviceWorker ?? null,
  };
  return {
    url: () => opts.url,
    status: () => opts.status ?? 200,
    headers: () => ({ 'content-type': 'application/json', ...(opts.headers ?? {}) }),
    request: () => request,
    frame: () => {
      if (opts.frameThrows) {
        throw new Error('Service Worker requests do not have an associated frame.');
      }
      return { page: () => opts.page };
    },
    text: opts.text ?? (async () => opts.body ?? '{"rows":[{"roomNumber":"204","status":"VC"}],"total":1}'),
  } as unknown as Response;
}

interface Harness {
  context: FakeContext;
  page: FakePage;
  emit: (r: Response) => void;
}

function createHarness(pageUrl?: string): Harness {
  const context = new FakeContext();
  const page = new FakePage(context, pageUrl);
  return {
    context,
    page,
    // Real Playwright dispatches the context event and then the page event
    // with the SAME Response instance — mirror that.
    emit: (r: Response) => {
      context.emit('response', r);
      page.emit('response', r);
    },
  };
}

async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const DATA_BODY = JSON.stringify({
  reservations: [
    { guestId: 'g-1', guestName: 'John Smith', email: 'john@x.com', roomNumber: '204', arrivalDate: '2026-06-10', status: 'DUE_IN' },
    { guestId: 'g-2', guestName: 'Jane Doe', email: 'jane@y.com', roomNumber: '310', arrivalDate: '2026-06-11', status: 'DUE_IN' },
  ],
  total: 2,
});

function attach(h: Harness) {
  return attachNetworkCapture(h.page as unknown as Page);
}

// ─── Capture behavior ────────────────────────────────────────────────────

describe('network-capture — keeps real data calls', () => {
  test('captures a same-site JSON data response, redacted, shape intact', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({
      url: 'https://api.pms.example.com/api/arrivals?from=2026-06-10&to=2026-06-12',
      page: h.page,
      method: 'GET',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: DATA_BODY,
    }));
    await settle();
    const calls = handle.recent();
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.method, 'GET');
    assert.equal(c.status, 200);
    assert.equal(c.contentType, 'application/json'); // normalized bare type
    assert.ok(c.url.includes('from=2026-06-10'));
    const body = c.responseBody as { reservations: Array<Record<string, unknown>>; total: number };
    assert.equal(body.total, 2);
    assert.equal(body.reservations.length, 2);
    assert.equal(body.reservations[0].guestName, '<redacted:field>');
    assert.equal(body.reservations[0].roomNumber, '204');
    assert.equal(body.reservations[0].arrivalDate, '2026-06-10');
    handle.detach();
  });

  test('emitting the same Response on context AND page yields one entry', async () => {
    const h = createHarness();
    const handle = attach(h);
    const r = makeResponse({ url: 'https://pms.example.com/api/rooms', page: h.page, body: DATA_BODY });
    h.context.emit('response', r);
    h.context.emit('response', r); // double-fire too
    h.page.emit('response', r);
    await settle();
    assert.equal(handle.recent().length, 1);
    handle.detach();
  });

  test('cross-site call with an explicit JSON content-type is kept (separate API apex)', async () => {
    const h = createHarness('https://app.hotelbrand.com/dashboard');
    const handle = attach(h);
    h.emit(makeResponse({ url: 'https://api.pmsvendor.net/v2/roomstatus', page: h.page, body: DATA_BODY }));
    await settle();
    assert.equal(handle.recent().length, 1);
    handle.detach();
  });

  test('same-site text/plain with an XSSI prefix sniffs as JSON', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({
      url: 'https://pms.example.com/legacy/data',
      page: h.page,
      headers: { 'content-type': 'text/plain' },
      body: ")]}',\n" + DATA_BODY,
    }));
    await settle();
    assert.equal(handle.recent().length, 1);
    assert.equal((handle.recent()[0].responseBody as { total: number }).total, 2);
    handle.detach();
  });

  test('cross-site text/plain is NOT sniffed (same-site-only privilege)', async () => {
    const h = createHarness('https://app.hotelbrand.com/dashboard');
    const handle = attach(h);
    h.emit(makeResponse({
      url: 'https://cdn.thirdparty.net/blob',
      page: h.page,
      headers: { 'content-type': 'text/plain' },
      body: DATA_BODY,
    }));
    await settle();
    assert.equal(handle.recent().length, 0);
    handle.detach();
  });

  test('CSV responses are captured as redacted CSV strings', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({
      url: 'https://pms.example.com/export/arrivals',
      page: h.page,
      headers: { 'content-type': 'text/csv' },
      body: 'Guest Name,Room,Arrival Date\nJohn Smith,204,2026-06-10\n',
    }));
    await settle();
    const calls = handle.recent();
    assert.equal(calls.length, 1);
    const csv = calls[0].responseBody as string;
    assert.equal(typeof csv, 'string');
    assert.ok(!csv.includes('John'));
    assert.ok(csv.includes('Guest Name'));
    assert.ok(csv.includes('204'));
    handle.detach();
  });

  test('304 and XML responses are kept as endpoint signals with null bodies', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({ url: 'https://pms.example.com/api/cached', page: h.page, status: 304 }));
    h.emit(makeResponse({
      url: 'https://pms.example.com/jsf/partial',
      page: h.page,
      headers: { 'content-type': 'text/xml' },
      body: '<partial-response><changes/></partial-response>',
    }));
    await settle();
    const calls = handle.recent();
    assert.equal(calls.length, 2);
    for (const c of calls) assert.equal(c.responseBody, null);
    handle.detach();
  });

  test('a property named "Beacon" is not mistaken for beacon noise', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({ url: 'https://pms.example.com/hotels/beacon-hill/rooms', page: h.page, body: DATA_BODY }));
    await settle();
    assert.equal(handle.recent().length, 1);
    handle.detach();
  });

  test('service-worker responses (frame() throws) are still classified and captured', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({
      url: 'https://pms.example.com/api/sw-served',
      page: h.page,
      serviceWorker: {},
      frameThrows: true,
      body: DATA_BODY,
    }));
    await settle();
    assert.equal(handle.recent().length, 1);
    handle.detach();
  });

  test('popup responses are captured; unrelated pages are not', async () => {
    const h = createHarness();
    const handle = attach(h);
    const popup = new FakePage(h.context, 'https://pms.example.com/report-window');
    h.page.emit('popup', popup);
    const stranger = new FakePage(h.context, 'https://pms.example.com/other-tab');
    h.emit(makeResponse({ url: 'https://pms.example.com/api/popup-feed', page: popup, body: DATA_BODY }));
    h.emit(makeResponse({ url: 'https://pms.example.com/api/stranger-feed', page: stranger, body: DATA_BODY }));
    await settle();
    const urls = handle.recent().map((c) => c.url);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('popup-feed'));
    handle.detach();
  });
});

describe('network-capture — drops noise', () => {
  const dropCases: Array<{ name: string; opts: Partial<ResponseOpts> & { url: string } }> = [
    { name: 'image resourceType', opts: { url: 'https://pms.example.com/logo', resourceType: 'image' } },
    { name: 'beacon/ping resourceType', opts: { url: 'https://pms.example.com/api/data', resourceType: 'ping' } },
    { name: 'OPTIONS preflight', opts: { url: 'https://pms.example.com/api/data', method: 'OPTIONS' } },
    { name: 'redirect status', opts: { url: 'https://pms.example.com/api/data', status: 302 } },
    { name: 'error status', opts: { url: 'https://pms.example.com/api/data', status: 500 } },
    { name: 'event-stream', opts: { url: 'https://pms.example.com/api/stream', headers: { 'content-type': 'text/event-stream' } } },
    { name: 'HTML page', opts: { url: 'https://pms.example.com/page', headers: { 'content-type': 'text/html' }, body: '<html></html>' } },
    { name: 'analytics host', opts: { url: 'https://www.google-analytics.com/g/collect?x=1' } },
    { name: 'session-replay host', opts: { url: 'https://rs.fullstory.com/rec/bundle' } },
    { name: 'payment gateway host', opts: { url: 'https://api.stripe.com/v1/tokens' } },
    { name: 'identity provider host', opts: { url: 'https://login.microsoftonline.com/common/oauth2/token' } },
    { name: 'feature-flag host', opts: { url: 'https://app.launchdarkly.com/sdk/evalx/abc/contexts' } },
    { name: 'extension scheme', opts: { url: 'chrome-extension://abcdef/data.json' } },
    { name: 'heartbeat path', opts: { url: 'https://pms.example.com/api/heartbeat' } },
    { name: 'health path', opts: { url: 'https://pms.example.com/health' } },
  ];

  for (const { name, opts } of dropCases) {
    test(`drops: ${name}`, async () => {
      const h = createHarness();
      const handle = attach(h);
      h.emit(makeResponse({ page: h.page, body: DATA_BODY, ...opts }));
      await settle();
      assert.equal(handle.recent().length, 0, `${name} should be dropped`);
      handle.detach();
    });
  }

  test('drops tiny acks but keeps the small dashboard-counts feed', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({ url: 'https://pms.example.com/api/ack1', page: h.page, body: '{"ok":true}' }));
    h.emit(makeResponse({ url: 'https://pms.example.com/api/ack2', page: h.page, body: '{"ok":true,"requestId":"abc"}' }));
    h.emit(makeResponse({ url: 'https://pms.example.com/api/empty', page: h.page, body: '[]' }));
    h.emit(makeResponse({ url: 'https://pms.example.com/api/counts', page: h.page, body: '{"arrivals":5,"departures":3,"inhouse":42}' }));
    await settle();
    const urls = handle.recent().map((c) => c.url);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('counts'));
    handle.detach();
  });

  test('declared-JSON that fails to parse keeps the endpoint with a null body (never raw)', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({ url: 'https://pms.example.com/api/broken', page: h.page, body: '{oops jane@x.com' }));
    await settle();
    const calls = handle.recent();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].responseBody, null);
    assert.ok(!JSON.stringify(calls).includes('jane@x.com'));
    handle.detach();
  });
});

describe('network-capture — memory caps', () => {
  test('oversize bodies (declared or read) become null-body entries', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({
      url: 'https://pms.example.com/api/huge-declared',
      page: h.page,
      headers: { 'content-length': String(10 * 1024 * 1024) },
    }));
    h.emit(makeResponse({
      url: 'https://pms.example.com/api/huge-chunked',
      page: h.page,
      body: '{"pad":"' + 'x'.repeat(600 * 1024) + '"}',
    }));
    await settle();
    const calls = handle.recent();
    assert.equal(calls.length, 2);
    for (const c of calls) assert.equal(c.responseBody, null);
    handle.detach();
  });

  test('a polling endpoint with cache-busters occupies ONE slot, latest body wins', async () => {
    const h = createHarness();
    const handle = attach(h);
    for (let i = 0; i < 5; i++) {
      h.emit(makeResponse({
        url: `https://pms.example.com/api/roomstatus?_=${1718000000 + i}`,
        page: h.page,
        body: JSON.stringify({ rooms: [{ roomNumber: '204', status: `S${i}` }] }),
      }));
      await settle(2);
    }
    const calls = handle.recent();
    assert.equal(calls.length, 1);
    const body = calls[0].responseBody as { rooms: Array<{ status: string }> };
    assert.equal(body.rooms[0].status, 'S4');
    handle.detach();
  });

  test('same endpoint with different POST bodies stays distinct (report?type=A vs B)', async () => {
    const h = createHarness();
    const handle = attach(h);
    for (const type of ['arrivals', 'departures']) {
      h.emit(makeResponse({
        url: 'https://pms.example.com/api/report',
        page: h.page,
        method: 'POST',
        postData: JSON.stringify({ type, ts: 1718000000 }),
        requestHeaders: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: type, rows: [{ roomNumber: '204' }] }),
      }));
      await settle(2);
    }
    assert.equal(handle.recent().length, 2);
    handle.detach();
  });

  test('buffer is capped at 50 unique endpoints, least-recently-updated evicted', async () => {
    const h = createHarness();
    const handle = attach(h);
    for (let i = 0; i < 55; i++) {
      h.emit(makeResponse({
        url: `https://pms.example.com/api/feed-${i}`,
        page: h.page,
        body: JSON.stringify({ rows: [{ n: i, roomNumber: '204' }] }),
      }));
      await settle(2);
    }
    const calls = handle.recent();
    assert.equal(calls.length, 50);
    const urls = calls.map((c) => c.url).join(' ');
    assert.ok(urls.includes('feed-54'));
    assert.ok(urls.includes('feed-5'));
    assert.ok(!urls.includes('feed-0?') && !urls.includes('feed-0 ') && !calls.some((c) => c.url.endsWith('feed-0')));
    assert.ok(!calls.some((c) => c.url.endsWith('feed-4')));
    handle.detach();
  });

  test('read concurrency is bounded: overflow past the pending queue buffers null-body entries', async () => {
    const h = createHarness();
    const handle = attach(h);
    // 4 in-flight + 32 queued = 36 held; the remaining 4 of 40 must not
    // queue unboundedly — they fall back to null-body entries immediately.
    for (let i = 0; i < 40; i++) {
      h.emit(makeResponse({
        url: `https://pms.example.com/api/slow-${i}`,
        page: h.page,
        text: () => new Promise<string>(() => {}),
      }));
    }
    await settle();
    const calls = handle.recent();
    assert.equal(calls.length, 4);
    for (const c of calls) assert.equal(c.responseBody, null);
    handle.detach();
  });

  test('a hanging body read times out and the call is skipped', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const h = createHarness();
      const handle = attach(h);
      h.emit(makeResponse({
        url: 'https://pms.example.com/api/comet',
        page: h.page,
        text: () => new Promise<string>(() => {}),
      }));
      await settle();
      t.mock.timers.tick(10_001);
      await settle();
      assert.equal(handle.recent().length, 0);
      handle.detach();
    } finally {
      t.mock.timers.reset();
    }
  });
});

describe('network-capture — handle lifecycle', () => {
  test('recent() is most-recently-updated first and bodies are frozen', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({ url: 'https://pms.example.com/api/first', page: h.page, body: DATA_BODY }));
    await settle(2);
    h.emit(makeResponse({ url: 'https://pms.example.com/api/second', page: h.page, body: DATA_BODY }));
    await settle(2);
    const calls = handle.recent();
    assert.ok(calls[0].url.includes('second'));
    assert.ok(calls[1].url.includes('first'));
    assert.ok(Object.isFrozen(calls[0].responseBody));
    assert.ok(Object.isFrozen((calls[0].responseBody as { reservations: unknown }).reservations));
    assert.throws(() => {
      (calls[0].responseBody as Record<string, unknown>).injected = true;
    });
    handle.detach();
  });

  test('detach() stops capture, is idempotent, and keeps the buffer readable', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.emit(makeResponse({ url: 'https://pms.example.com/api/before', page: h.page, body: DATA_BODY }));
    await settle();
    handle.detach();
    handle.detach(); // idempotent
    assert.equal(h.context.count('response'), 0);
    assert.equal(h.page.count('popup'), 0);
    h.emit(makeResponse({ url: 'https://pms.example.com/api/after', page: h.page, body: DATA_BODY }));
    await settle();
    const urls = handle.recent().map((c) => c.url);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('before'));
  });

  test('an in-flight body read that resolves after detach() is not buffered', async () => {
    const h = createHarness();
    const handle = attach(h);
    let resolveText!: (s: string) => void;
    h.emit(makeResponse({
      url: 'https://pms.example.com/api/inflight',
      page: h.page,
      text: () => new Promise<string>((resolve) => {
        resolveText = resolve;
      }),
    }));
    await settle();
    handle.detach();
    resolveText(DATA_BODY);
    await settle();
    assert.equal(handle.recent().length, 0);
  });

  test('page close auto-detaches', async () => {
    const h = createHarness();
    const handle = attach(h);
    h.page.emit('close');
    h.emit(makeResponse({ url: 'https://pms.example.com/api/late', page: h.page, body: DATA_BODY }));
    await settle();
    assert.equal(handle.recent().length, 0);
    assert.equal(h.context.count('response'), 0);
    handle.detach(); // still idempotent after auto-detach
  });
});

describe('network-capture — no unredacted data escapes', () => {
  test('PII planted in url/headers/post body/response body/error never appears in recent(), stdout or stderr', async () => {
    const PII = [
      'secret.guest@example.com',
      'supersecrettoken123',
      'SECRETBEARERTOKEN',
      'SECRETCOOKIE',
      'SECRETPASS',
      'Secret Guest',
      '4111111111111111',
      '123-45-6789',
      'SECRETERRSTRING',
    ];
    const written: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const rejections: unknown[] = [];
    const trap = (e: unknown): void => {
      rejections.push(e);
    };
    process.on('unhandledRejection', trap);
    (process.stdout as unknown as { write: (c: unknown, ...rest: unknown[]) => boolean }).write = (
      c: unknown, ...rest: unknown[]
    ) => {
      written.push(String(c));
      return origOut(c as never, ...(rest as never[]));
    };
    (process.stderr as unknown as { write: (c: unknown, ...rest: unknown[]) => boolean }).write = (
      c: unknown, ...rest: unknown[]
    ) => {
      written.push(String(c));
      return origErr(c as never, ...(rest as never[]));
    };
    try {
      const h = createHarness();
      const handle = attach(h);
      h.emit(makeResponse({
        url: 'https://pms.example.com/api/guests?email=secret.guest%40example.com&token=supersecrettoken123&from=2026-06-01',
        page: h.page,
        method: 'POST',
        requestHeaders: {
          authorization: 'Bearer SECRETBEARERTOKEN1234567890',
          cookie: 'sid=SECRETCOOKIE',
          'content-type': 'application/json',
          referer: 'https://pms.example.com/search?guest=Secret+Guest',
        },
        postData: '{"password":"SECRETPASS","guestName":"Secret Guest","date":"2026-06-01"}',
        body: JSON.stringify({
          rows: [{
            guestName: 'Secret Guest',
            email: 'secret.guest@example.com',
            phone: '(832) 555-1234',
            card: '4111111111111111',
            ssn: '123-45-6789',
            roomNumber: '204',
            arrivalDate: '2026-06-10',
          }],
        }),
      }));
      // A read that rejects with a PII-bearing error message.
      h.emit(makeResponse({
        url: 'https://pms.example.com/api/failing',
        page: h.page,
        text: () => Promise.reject(new Error('fetch failed https://pms.example.com/x?ssn=123-45-6789 SECRETERRSTRING')),
      }));
      await settle(6);
      handle.detach(); // also exercises the detach log line
      await settle(2);

      const serialized = JSON.stringify(handle.recent());
      const logged = written.join('');
      for (const lit of PII) {
        assert.ok(!serialized.includes(lit), `recent() leaked: ${lit}`);
        assert.ok(!logged.includes(lit), `stdout/stderr leaked: ${lit}`);
      }
      // Positive checks: the captured call is still useful to the mapper.
      const calls = handle.recent();
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes('from=2026-06-01'));
      const body = calls[0].responseBody as { rows: Array<Record<string, unknown>> };
      assert.equal(body.rows.length, 1);
      assert.equal(body.rows[0].roomNumber, '204');
      assert.equal(body.rows[0].arrivalDate, '2026-06-10');
      assert.equal(rejections.length, 0, 'a handler rejection escaped — it would flow to Sentry with raw URLs');
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origOut;
      (process.stderr as unknown as { write: unknown }).write = origErr;
      process.off('unhandledRejection', trap);
    }
  });
});

describe('network-capture — static invariants', () => {
  test('source never routes, never writes to stdout/stderr, never uses console', async () => {
    const src = await readFile(join(__dirname, '..', 'network-capture.ts'), 'utf8');
    const offenders: string[] = [];
    const FORBIDDEN = ['.route(', 'routeFromHAR', 'process.stdout', 'process.stderr', 'console.'];
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const f of FORBIDDEN) {
        if (line.includes(f)) offenders.push(`${i + 1}: ${t} (${f})`);
      }
    });
    assert.deepEqual(offenders, []);
  });

  test('source never calls log.error (it forwards to Sentry)', async () => {
    const src = await readFile(join(__dirname, '..', 'network-capture.ts'), 'utf8');
    const offenders = src.split('\n').filter((line) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      return t.includes('log.error') || t.includes('log.warn');
    });
    assert.deepEqual(offenders, [], 'log.error/log.warn are forbidden in network-capture.ts');
  });
});
