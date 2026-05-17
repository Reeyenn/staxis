/**
 * Tests for requireSession + the embedded classifySessionFailure logic
 * in src/lib/api-auth.ts.
 *
 * The "invalid session token" loop we just rooted-out in commit d241bf5
 * lived entirely in this code path: a malformed JWT vs an expired one vs
 * a project-mismatch one all need DIFFERENT client recoveries (refresh,
 * sign-out, "ops fix needed"). This test file pins the failure-code
 * classification so the next time someone tweaks the JWT logic they get
 * a red diff instead of a silent regression.
 *
 * Strategy: monkey-patch supabaseAdmin.auth.getUser so we never hit the
 * network. The api-auth module imports supabaseAdmin as a named import
 * but the underlying object is a singleton — methods replaced on the
 * singleton are observed by the api-auth helpers.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Test-time mocking infrastructure ────────────────────────────────────
//
// Supabase getUser returns the supabase-js shape:
//   { data: { user: null | User }, error: null | { message, status, name } }

type GetUserResult = Awaited<ReturnType<typeof supabaseAdmin.auth.getUser>>;
type GetUserFn = typeof supabaseAdmin.auth.getUser;

const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
let nextGetUser: (token: string) => Promise<GetUserResult> | GetUserResult;
let getUserCalls: string[] = [];

beforeEach(() => {
  getUserCalls = [];
  nextGetUser = async () => ({ data: { user: null }, error: null }) as unknown as GetUserResult;
  supabaseAdmin.auth.getUser = (async (token: string) => {
    getUserCalls.push(token);
    return await nextGetUser(token);
  }) as unknown as GetUserFn;
});

afterEach(() => {
  supabaseAdmin.auth.getUser = originalGetUser;
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function reqWith(authHeader: string | null): NextRequest {
  const init: { headers?: Record<string, string> } = {};
  if (authHeader !== null) init.headers = { authorization: authHeader };
  return new Request('https://staxis.test/api/example', init) as unknown as NextRequest;
}

/**
 * Build a syntactically-valid JWT with the given payload claims. The
 * signature is a placeholder — we never verify it; the supabaseAdmin
 * mock decides accept/reject. classifySessionFailure does call
 * decodeJwtClaimsUnverified though, so the payload must be parseable.
 */
function mintJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-signature-placeholder`;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('requireSession — header parsing', () => {
  test('missing Authorization header → 401 missing_token', async () => {
    const result = await requireSession(reqWith(null));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 401);
      const body = await result.response.json();
      assert.equal(body.code, 'missing_token');
    }
  });

  test('Authorization header without Bearer prefix → 401 missing_token', async () => {
    const result = await requireSession(reqWith('not-a-bearer-token'));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'missing_token');
    }
  });

  test('valid Bearer header reaches supabaseAdmin.auth.getUser', async () => {
    nextGetUser = async () => ({
      data: { user: { id: 'user-abc', email: 'a@b.com' } },
      error: null,
    } as unknown as GetUserResult);
    const jwt = mintJwt({ sub: 'user-abc', exp: Math.floor(Date.now() / 1000) + 3600 });
    await requireSession(reqWith(`Bearer ${jwt}`));
    assert.equal(getUserCalls.length, 1);
    assert.equal(getUserCalls[0], jwt);
  });
});

describe('requireSession — failure classification', () => {
  test('non-JWT token (not 3 parts) → token_malformed', async () => {
    nextGetUser = async () => ({
      data: { user: null },
      error: { message: 'invalid token', status: 400, name: 'AuthApiError' },
    } as unknown as GetUserResult);
    const result = await requireSession(reqWith('Bearer this.is_not_a_jwt'));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'token_malformed');
      assert.equal(result.response.status, 401);
    }
  });

  test('JWT with exp in the past → token_expired', async () => {
    nextGetUser = async () => ({
      data: { user: null },
      error: { message: 'JWT expired', status: 401, name: 'AuthApiError' },
    } as unknown as GetUserResult);
    const expiredJwt = mintJwt({
      sub: 'user-abc',
      exp: Math.floor(Date.now() / 1000) - 60, // 1 minute ago
      iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
    });
    const result = await requireSession(reqWith(`Bearer ${expiredJwt}`));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'token_expired');
    }
  });

  test('Supabase error message "jwt expired" → token_expired (fallback path)', async () => {
    // Some Supabase paths return the error without us being able to decode
    // exp from claims — make sure the message-based fallback still classifies
    // correctly.
    nextGetUser = async () => ({
      data: { user: null },
      error: { message: 'JWT expired', status: 401, name: 'AuthApiError' },
    } as unknown as GetUserResult);
    const noExpJwt = mintJwt({
      sub: 'user-abc',
      iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
    });
    const result = await requireSession(reqWith(`Bearer ${noExpJwt}`));
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'token_expired');
    }
  });

  test('JWT issued by a different Supabase project → project_mismatch', async () => {
    // The env-var drift footgun: a Vercel deploy points at project A but
    // user's saved session was issued by project B. Auth claims an "invalid
    // token" but the actionable signal is that ops/infra needs to look.
    const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://this-project.supabase.co';
    try {
      nextGetUser = async () => ({
        data: { user: null },
        error: { message: 'invalid claim: missing sub', status: 401, name: 'AuthApiError' },
      } as unknown as GetUserResult);
      const wrongProjectJwt = mintJwt({
        sub: 'user-abc',
        iss: 'https://other-project.supabase.co/auth/v1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const result = await requireSession(reqWith(`Bearer ${wrongProjectJwt}`));
      assert.equal(result.ok, false);
      if (!result.ok) {
        const body = await result.response.json();
        assert.equal(body.code, 'project_mismatch');
      }
    } finally {
      if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
    }
  });

  test('Supabase returns "user not found" error → user_not_found', async () => {
    nextGetUser = async () => ({
      data: { user: null },
      error: { message: 'User not found', status: 404, name: 'AuthApiError' },
    } as unknown as GetUserResult);
    const jwt = mintJwt({
      sub: 'user-deleted',
      iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await requireSession(reqWith(`Bearer ${jwt}`));
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'user_not_found');
    }
  });

  test('No error but data.user is null → user_not_found', async () => {
    // Some races / revoked sessions return no error but no user either.
    nextGetUser = async () => ({
      data: { user: null },
      error: null,
    } as unknown as GetUserResult);
    const jwt = mintJwt({
      sub: 'user-abc',
      iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await requireSession(reqWith(`Bearer ${jwt}`));
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'user_not_found');
    }
  });

  test('Supabase 5xx → auth_unavailable (transient — do NOT sign user out)', async () => {
    nextGetUser = async () => ({
      data: { user: null },
      error: { message: 'service unavailable', status: 503, name: 'AuthApiError' },
    } as unknown as GetUserResult);
    const jwt = mintJwt({
      sub: 'user-abc',
      iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await requireSession(reqWith(`Bearer ${jwt}`));
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'auth_unavailable');
    }
  });

  test('Supabase throws → 500 auth_unavailable (no sign-out, transient)', async () => {
    nextGetUser = async () => { throw new Error('socket hangup'); };
    const jwt = mintJwt({
      sub: 'user-abc',
      iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await requireSession(reqWith(`Bearer ${jwt}`));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 500);
      const body = await result.response.json();
      assert.equal(body.code, 'auth_unavailable');
    }
  });
});

describe('requireSession — happy path', () => {
  test('valid session → ok:true with userId and email', async () => {
    nextGetUser = async () => ({
      data: { user: { id: 'user-real-id', email: 'mario@hotel.com' } },
      error: null,
    } as unknown as GetUserResult);
    const jwt = mintJwt({
      sub: 'user-real-id',
      iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await requireSession(reqWith(`Bearer ${jwt}`));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.userId, 'user-real-id');
      assert.equal(result.email, 'mario@hotel.com');
    }
  });

  test('valid session with no email → ok:true with email=null', async () => {
    // Some auth flows (magic link with phone, anonymous, etc.) leave email
    // null. The helper must surface null rather than coercing to ''.
    nextGetUser = async () => ({
      data: { user: { id: 'user-no-email', email: undefined } },
      error: null,
    } as unknown as GetUserResult);
    const jwt = mintJwt({
      sub: 'user-no-email',
      iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await requireSession(reqWith(`Bearer ${jwt}`));
    if (result.ok) {
      assert.equal(result.email, null);
    }
  });
});
