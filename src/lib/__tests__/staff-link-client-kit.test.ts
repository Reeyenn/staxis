/**
 * Unit tests for the staff-link client kit (src/lib/staff-link-client.ts).
 *
 * This kit fronts the public no-login pages (/housekeeper/[id], /laundry/[id],
 * /engineer/[id]) where a silent mistake = empty pages for hotel staff (the
 * RLS bug class — bit this app 3 times). These tests pin:
 *
 *   1. The original exports (withStaffLinkToken / withStaffLinkTokenBody /
 *      getStaffLinkTokenFromUrl) keep their exact behaviour — other files
 *      import them today.
 *   2. buildStaffLinkUrl / staffGet inject pid + staffId + tok into GET urls
 *      exactly the way the pages hand-roll it today (encodeURIComponent,
 *      ? vs & separator, tok appended last).
 *   3. staffPost folds pid + staffId + tok into the JSON body via
 *      withStaffLinkTokenBody, with the link as source of truth over any
 *      caller-provided pid/staffId.
 *   4. opts.offline routes through the EXISTING enqueueIfOffline contract
 *      unchanged (body already carries tok so replays authenticate). A
 *      queued result passes through as-is (callers distinguish queued vs
 *      sent); a sent-while-online result is normalized to the direct-path
 *      shape (envelope unwrapped, ok = HTTP ok AND envelope ok, error =
 *      envelope error) so flipping an action to { offline: true } never
 *      changes what ok/data/error mean at the call site.
 *   5. Any non-/api/* path throws — the kit mechanically enforces the
 *      "public pages MUST go through /api routes" rule.
 *
 * useStaffLink itself is a React hook (browser only) — its pure parts
 * (staffIdFromPathname, getStaffLinkPidFromUrl, getStaffLinkTokenFromUrl)
 * are tested here; the useState/useEffect glue is not exercised under
 * node:test, mirroring how use-offline-sync's hook glue is handled.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getStaffLinkTokenFromUrl,
  getStaffLinkPidFromUrl,
  withStaffLinkToken,
  withStaffLinkTokenBody,
  staffIdFromPathname,
  buildStaffLinkUrl,
  staffGet,
  staffPost,
  type StaffLinkIdentity,
  type EnqueueIfOffline,
} from '@/lib/staff-link-client';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const PID = '11111111-1111-1111-1111-111111111111';
const STAFF = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TOK = 'raw-link-token-0000000000000000000000000000000000000000000000001';

const LINK: StaffLinkIdentity = { pid: PID, staffId: STAFF, token: TOK };
const TOKENLESS: StaffLinkIdentity = { pid: PID, staffId: STAFF, token: '' };

// ─── fetch stub ────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];
let nextResponse: () => Response;

beforeEach(() => {
  fetchCalls = [];
  nextResponse = () =>
    new Response(JSON.stringify({ ok: true, requestId: 'r1', data: null }), { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Original exports — behaviour pinned (other files import these) ───────

describe('withStaffLinkToken (existing contract)', () => {
  test('appends ?tok= when the url has no query', () => {
    assert.equal(withStaffLinkToken('/api/x', 'abc'), '/api/x?tok=abc');
  });

  test('appends &tok= when the url already has a query', () => {
    assert.equal(withStaffLinkToken('/api/x?a=1', 'abc'), '/api/x?a=1&tok=abc');
  });

  test('encodes the token', () => {
    assert.equal(withStaffLinkToken('/api/x', 'a b+c'), '/api/x?tok=a%20b%2Bc');
  });

  test('no-op when the token is empty (server then 401s — correct)', () => {
    assert.equal(withStaffLinkToken('/api/x', ''), '/api/x');
  });
});

describe('withStaffLinkTokenBody (existing contract)', () => {
  test('returns a shallow copy with tok set', () => {
    const body = { pid: PID, roomId: 'r1' };
    const out = withStaffLinkTokenBody(body, 'abc');
    assert.deepEqual(out, { pid: PID, roomId: 'r1', tok: 'abc' });
    assert.notEqual(out, body);
    assert.equal((body as { tok?: string }).tok, undefined, 'original not mutated');
  });

  test('no-op when the token is empty', () => {
    const body = { pid: PID };
    assert.equal(withStaffLinkTokenBody(body, ''), body);
  });
});

// ─── URL readers (window-derived) ──────────────────────────────────────────

describe('URL readers', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  test('reads tok + pid from location.search', () => {
    (globalThis as { window?: unknown }).window = {
      location: { search: `?pid=${PID}&tok=abc%20def` },
    };
    assert.equal(getStaffLinkTokenFromUrl(), 'abc def');
    assert.equal(getStaffLinkPidFromUrl(), PID);
  });

  test('absent params → empty token, null pid', () => {
    (globalThis as { window?: unknown }).window = { location: { search: '' } };
    assert.equal(getStaffLinkTokenFromUrl(), '');
    assert.equal(getStaffLinkPidFromUrl(), null);
  });

  test('no window (SSR) → safe defaults, no throw', () => {
    delete (globalThis as { window?: unknown }).window;
    assert.equal(getStaffLinkTokenFromUrl(), '');
    assert.equal(getStaffLinkPidFromUrl(), null);
  });

  test('legacy ?token= (magic-link param) is NOT the staff-link token', () => {
    (globalThis as { window?: unknown }).window = {
      location: { search: '?token=magic-link-hash&pid=x' },
    };
    assert.equal(getStaffLinkTokenFromUrl(), '');
  });
});

describe('staffIdFromPathname', () => {
  test('extracts the [id] segment from the three public page shapes', () => {
    assert.equal(staffIdFromPathname(`/housekeeper/${STAFF}`), STAFF);
    assert.equal(staffIdFromPathname(`/laundry/${STAFF}`), STAFF);
    assert.equal(staffIdFromPathname(`/engineer/${STAFF}`), STAFF);
  });

  test('tolerates a trailing slash', () => {
    assert.equal(staffIdFromPathname(`/housekeeper/${STAFF}/`), STAFF);
  });

  test('decodes percent-encoding like the route param does', () => {
    assert.equal(staffIdFromPathname('/housekeeper/a%20b'), 'a b');
  });

  test('bare / → null (matches the pages\' incomplete-link guard)', () => {
    assert.equal(staffIdFromPathname('/'), null);
    assert.equal(staffIdFromPathname(''), null);
  });
});

// ─── buildStaffLinkUrl ─────────────────────────────────────────────────────

describe('buildStaffLinkUrl', () => {
  test('injects pid + staffId then tok, matching the hand-rolled page urls', () => {
    assert.equal(
      buildStaffLinkUrl('/api/housekeeper/rooms', LINK),
      `/api/housekeeper/rooms?pid=${PID}&staffId=${STAFF}&tok=${TOK}`,
    );
  });

  test('appends extra params, encoded, before the token', () => {
    assert.equal(
      buildStaffLinkUrl('/api/housekeeper/reservations', LINK, { date: '2026-07-10' }),
      `/api/housekeeper/reservations?pid=${PID}&staffId=${STAFF}&date=2026-07-10&tok=${TOK}`,
    );
    assert.equal(
      buildStaffLinkUrl('/api/x', { pid: 'a b', staffId: 'c&d', token: '' }, { q: 'e=f' }),
      '/api/x?pid=a%20b&staffId=c%26d&q=e%3Df',
    );
  });

  test('skips null/undefined extra params', () => {
    assert.equal(
      buildStaffLinkUrl('/api/x', TOKENLESS, { a: null, b: undefined, c: 0, d: false }),
      `/api/x?pid=${PID}&staffId=${STAFF}&c=0&d=false`,
    );
  });

  test('uses & when the path already carries a query', () => {
    assert.equal(
      buildStaffLinkUrl('/api/housekeeper/checklist/deep?v=2', LINK),
      `/api/housekeeper/checklist/deep?v=2&pid=${PID}&staffId=${STAFF}&tok=${TOK}`,
    );
  });

  test('tokenless link → no tok param (server 401s, the honest failure)', () => {
    assert.equal(
      buildStaffLinkUrl('/api/housekeeper/me', TOKENLESS),
      `/api/housekeeper/me?pid=${PID}&staffId=${STAFF}`,
    );
  });

  test('missing pid/staffId are omitted rather than sent as literal "null"', () => {
    assert.equal(
      buildStaffLinkUrl('/api/x', { pid: null, staffId: null, token: 'tk' }),
      '/api/x?tok=tk',
    );
  });

  test('refuses any non-/api path (RLS bug-class enforcement)', () => {
    assert.throws(() => buildStaffLinkUrl('/admin/rooms', LINK), /\/api\//);
    assert.throws(() => buildStaffLinkUrl('api/rooms', LINK), /\/api\//);
    assert.throws(() => buildStaffLinkUrl('https://evil.example/api/rooms', LINK), /\/api\//);
  });
});

// ─── staffGet ──────────────────────────────────────────────────────────────

describe('staffGet', () => {
  test('fetches the built url and unwraps the standard envelope', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ ok: true, requestId: 'r', data: { rooms: [1, 2] } }), {
        status: 200,
      });
    const res = await staffGet<{ rooms: number[] }>('/api/housekeeper/rooms', LINK);
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].url,
      `/api/housekeeper/rooms?pid=${PID}&staffId=${STAFF}&tok=${TOK}`,
    );
    assert.deepEqual(res, { ok: true, status: 200, data: { rooms: [1, 2] }, error: null });
  });

  test('HTTP 200 with envelope ok:false → ok:false', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ ok: false, requestId: 'r', error: 'nope' }), { status: 200 });
    const res = await staffGet('/api/housekeeper/rooms', LINK);
    assert.equal(res.ok, false);
    assert.equal(res.status, 200);
    assert.equal(res.data, null);
    assert.equal(res.error, 'nope');
  });

  test('401 surfaces via status for the tokenless-link guard', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ ok: false, requestId: 'r', error: 'unauthorized' }), {
        status: 401,
      });
    const res = await staffGet('/api/housekeeper/me', TOKENLESS);
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
  });

  test('non-JSON body → ok:false without throwing', async () => {
    nextResponse = () => new Response('<html>gateway error</html>', { status: 200 });
    const res = await staffGet('/api/housekeeper/rooms', LINK);
    assert.equal(res.ok, false);
    assert.equal(res.data, null);
  });

  test('network error → { ok:false, status:0, error:"network" }, never throws', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const res = await staffGet('/api/housekeeper/rooms', LINK);
    assert.deepEqual(res, { ok: false, status: 0, data: null, error: 'network' });
  });

  test('refuses non-/api paths', async () => {
    await assert.rejects(() => staffGet('/housekeeper/rooms', LINK), /\/api\//);
    assert.equal(fetchCalls.length, 0, 'nothing fetched');
  });
});

// ─── staffPost — direct path ───────────────────────────────────────────────

describe('staffPost (direct)', () => {
  test('POSTs JSON with pid + staffId + tok folded into the body', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ ok: true, requestId: 'r', data: { saved: true } }), {
        status: 200,
      });
    const res = await staffPost('/api/housekeeper/start-clean', LINK, { roomId: 'r1' });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, '/api/housekeeper/start-clean');
    assert.equal(fetchCalls[0].init?.method, 'POST');
    assert.deepEqual(fetchCalls[0].init?.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      roomId: 'r1',
      pid: PID,
      staffId: STAFF,
      tok: TOK,
    });
    assert.deepEqual(res, {
      ok: true,
      queued: false,
      status: 200,
      data: { saved: true },
      error: null,
    });
  });

  test('link is the source of truth — caller pid/staffId in body are overwritten', async () => {
    await staffPost('/api/housekeeper/start-clean', LINK, {
      pid: 'stale-pid',
      staffId: 'stale-staff',
      roomId: 'r1',
    });
    const sent = JSON.parse(String(fetchCalls[0].init?.body)) as Record<string, unknown>;
    assert.equal(sent.pid, PID);
    assert.equal(sent.staffId, STAFF);
  });

  test('tokenless link → body carries no tok (server 401s)', async () => {
    await staffPost('/api/housekeeper/start-clean', TOKENLESS, { roomId: 'r1' });
    const sent = JSON.parse(String(fetchCalls[0].init?.body)) as Record<string, unknown>;
    assert.equal('tok' in sent, false);
  });

  test('server error envelope → ok:false with status + error', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ ok: false, requestId: 'r', error: 'room not found' }), {
        status: 404,
      });
    const res = await staffPost('/api/housekeeper/start-clean', LINK, { roomId: 'bad' });
    assert.equal(res.ok, false);
    assert.equal(res.queued, false);
    assert.equal(res.status, 404);
    assert.equal(res.error, 'room not found');
  });

  test('HTTP 200 with envelope ok:false → ok:false (matches guardedPost)', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ ok: false, requestId: 'r' }), { status: 200 });
    const res = await staffPost('/api/housekeeper/start-clean', LINK, { roomId: 'r1' });
    assert.equal(res.ok, false);
  });

  test('network error → { ok:false, queued:false, status:0 }, never throws', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const res = await staffPost('/api/housekeeper/start-clean', LINK, { roomId: 'r1' });
    assert.deepEqual(res, { ok: false, queued: false, status: 0, data: null, error: 'network' });
  });

  test('refuses non-/api paths', async () => {
    await assert.rejects(
      () => staffPost('https://evil.example/api/x', LINK, {}),
      /\/api\//,
    );
    assert.equal(fetchCalls.length, 0);
  });
});

// ─── staffPost — offline routing ───────────────────────────────────────────

describe('staffPost (offline routing)', () => {
  test('routes through enqueueIfOffline with the token-injected body, result unchanged', async () => {
    const calls: Array<{ endpoint: string; body: Record<string, unknown>; label: string }> = [];
    const queuedResult = { ok: true, queued: true, data: { actionId: 'a1', queued: true } };
    const enqueueIfOffline: EnqueueIfOffline = async (opts) => {
      calls.push(opts);
      return queuedResult;
    };

    const res = await staffPost(
      '/api/housekeeper/add-note',
      LINK,
      { roomId: 'r1', noteText: 'towel low' },
      { offline: true, enqueueIfOffline, label: 'Note · room r1' },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, '/api/housekeeper/add-note');
    assert.equal(calls[0].label, 'Note · room r1');
    // tok must be IN the queued body so an offline replay authenticates.
    assert.deepEqual(calls[0].body, {
      roomId: 'r1',
      noteText: 'towel low',
      pid: PID,
      staffId: STAFF,
      tok: TOK,
    });
    assert.equal(res, queuedResult, 'result passes through unchanged');
    assert.equal(fetchCalls.length, 0, 'kit does not fetch — enqueueIfOffline owns the send');
  });

  test('sent-while-online success is normalized to the direct-path shape (envelope unwrapped)', async () => {
    // enqueueIfOffline returns the RAW response JSON as `data` when it sends
    // online — staffPost must unwrap it so r.data is the payload, exactly
    // like the direct (non-offline) path.
    const enqueueIfOffline: EnqueueIfOffline = async () => ({
      ok: true,
      queued: false,
      data: { ok: true, requestId: 'r', data: { saved: true } },
      status: 200,
    });
    const res = await staffPost(
      '/api/housekeeper/mark-for-inspection',
      LINK,
      { roomId: 'r1', clear: false },
      { offline: true, enqueueIfOffline },
    );
    assert.deepEqual(res, {
      ok: true,
      queued: false,
      status: 200,
      data: { saved: true },
      error: null,
    });
  });

  test('sent-while-online rejection surfaces the envelope error, ok:false (queued:false)', async () => {
    const enqueueIfOffline: EnqueueIfOffline = async () => ({
      ok: false,
      queued: false,
      data: { ok: false, requestId: 'r', error: 'room not found' },
      status: 400,
    });
    const res = await staffPost(
      '/api/housekeeper/mark-for-inspection',
      LINK,
      { roomId: 'bad', clear: false },
      { offline: true, enqueueIfOffline },
    );
    assert.deepEqual(res, {
      ok: false,
      queued: false,
      status: 400,
      data: null,
      error: 'room not found',
    });
  });

  test('sent-while-online HTTP 200 with envelope ok:false → ok:false (matches direct path)', async () => {
    const enqueueIfOffline: EnqueueIfOffline = async () => ({
      ok: true, // HTTP-level ok — the envelope still says no
      queued: false,
      data: { ok: false, requestId: 'r', error: 'stale action' },
      status: 200,
    });
    const res = await staffPost(
      '/api/housekeeper/mark-for-inspection',
      LINK,
      { roomId: 'r1', clear: false },
      { offline: true, enqueueIfOffline },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, 'stale action');
  });

  test('sent-while-online non-envelope data → ok:false, data null, no throw', async () => {
    const enqueueIfOffline: EnqueueIfOffline = async () => ({
      ok: true,
      queued: false,
      data: null, // e.g. gateway returned non-JSON
      status: 200,
    });
    const res = await staffPost(
      '/api/housekeeper/mark-for-inspection',
      LINK,
      { roomId: 'r1', clear: false },
      { offline: true, enqueueIfOffline },
    );
    assert.deepEqual(res, { ok: false, queued: false, status: 200, data: null, error: null });
  });

  test('label defaults to the path when not supplied', async () => {
    let seenLabel = '';
    const enqueueIfOffline: EnqueueIfOffline = async (opts) => {
      seenLabel = opts.label;
      return { ok: true, queued: true };
    };
    await staffPost('/api/housekeeper/add-note', LINK, { roomId: 'r1' }, {
      offline: true,
      enqueueIfOffline,
    });
    assert.equal(seenLabel, '/api/housekeeper/add-note');
  });

  test('offline:true without enqueueIfOffline throws loudly (caller wiring bug)', async () => {
    await assert.rejects(
      () => staffPost('/api/housekeeper/add-note', LINK, { roomId: 'r1' }, { offline: true }),
      /enqueueIfOffline/,
    );
    assert.equal(fetchCalls.length, 0);
  });
});
