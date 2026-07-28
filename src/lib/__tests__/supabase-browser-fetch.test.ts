import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { RequestTimeoutError } from '@/lib/fetch-deadline';
import { createSupabaseBrowserFetch } from '@/lib/supabase-browser-fetch';

function abortAwarePending(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_, reject) => {
      const timer = setInterval(() => {
        if (init?.signal?.aborted) {
          clearInterval(timer);
          reject(init.signal.reason);
        }
      }, 2);
    });
  }) as typeof fetch;
}

describe('Supabase browser transport deadlines', () => {
  test('a hung refresh-token POST terminates and a later attempt can succeed', async () => {
    let shouldHang = true;
    const pendingFetch = abortAwarePending();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (shouldHang) return pendingFetch(input, init);
      return new Response(JSON.stringify({ access_token: 'fresh' }), { status: 200 });
    }) as typeof fetch;
    const boundedFetch = createSupabaseBrowserFetch({ authTimeoutMs: 25, fetchImpl });
    const url = 'https://project.supabase.co/auth/v1/token?grant_type=refresh_token';

    await assert.rejects(
      boundedFetch(url, { method: 'POST', body: '{}' }),
      (error: Error) => error instanceof RequestTimeoutError,
    );

    shouldHang = false;
    const retry = await boundedFetch(url, { method: 'POST', body: '{}' });
    assert.equal(retry.status, 200, 'timeout must not poison the next auth attempt');
  });

  test('a hung PostgREST GET terminates', async () => {
    const boundedFetch = createSupabaseBrowserFetch({
      readTimeoutMs: 25,
      fetchImpl: abortAwarePending(),
    });
    await assert.rejects(
      boundedFetch('https://project.supabase.co/rest/v1/inventory_items?select=id'),
      (error: Error) => error instanceof RequestTimeoutError,
    );
  });

  test('hung audited navigation read RPCs terminate and a later retry can succeed', async () => {
    let shouldHang = true;
    const pendingFetch = abortAwarePending();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (shouldHang) return pendingFetch(input, init);
      return new Response(JSON.stringify([{ total_rooms: 12 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const boundedFetch = createSupabaseBrowserFetch({ readTimeoutMs: 25, fetchImpl });
    const urls = [
      'https://project.supabase.co/rest/v1/rpc/today_room_work_v1',
      'https://project.supabase.co/rest/v1/rpc/today_property_counts_v1',
      'https://project.supabase.co/rest/v1/rpc/staxis_list_inventory_delivery_corrections',
    ];

    for (const url of urls) {
      await assert.rejects(
        boundedFetch(url, { method: 'POST', body: '{}' }),
        (error: Error) => error instanceof RequestTimeoutError,
      );
    }

    shouldHang = false;
    const retry = await boundedFetch(urls[0], { method: 'POST', body: '{}' });
    assert.equal(retry.status, 200, 'one timed-out read RPC must not poison the next attempt');
  });

  test('PostgREST mutations, unlisted RPCs, and Storage downloads keep caller-owned budgets', async () => {
    const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), signal: init?.signal });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const boundedFetch = createSupabaseBrowserFetch({
      authTimeoutMs: 25,
      readTimeoutMs: 25,
      fetchImpl,
    });

    await boundedFetch('https://project.supabase.co/rest/v1/inventory_items', {
      method: 'POST',
      body: '{}',
    });
    await boundedFetch('https://project.supabase.co/rest/v1/rpc/apply_inventory_adjustment', {
      method: 'POST',
      body: '{}',
    });
    await boundedFetch('https://project.supabase.co/storage/v1/object/large/report.pdf');

    assert.equal(calls.length, 3);
    assert.equal(calls[0].signal, undefined, 'database write must not receive an implicit deadline');
    assert.equal(calls[1].signal, undefined, 'unlisted RPC must remain caller-owned because it may mutate');
    assert.equal(calls[2].signal, undefined, 'large Storage read must not receive an implicit deadline');
  });

  test('bounded reads still honor a caller-provided abort', async () => {
    const caller = new AbortController();
    const boundedFetch = createSupabaseBrowserFetch({
      readTimeoutMs: 200,
      fetchImpl: abortAwarePending(),
    });
    const pending = boundedFetch(
      'https://project.supabase.co/rest/v1/staff?select=id',
      { signal: caller.signal },
    );
    caller.abort(new DOMException('route changed', 'AbortError'));
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  });
});
