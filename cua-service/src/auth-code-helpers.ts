/**
 * Auth-code inbox read/write helpers for the CUA worker (migration 0274).
 *
 * The robot logs each hotel into Choice's PMS via Okta SSO, which forces MFA.
 * We standardize on Okta's emailed one-time code: the code lands in an inbox
 * we control (Cloudflare Email Routing → /api/pms-inbox/inbound → pms_auth_codes)
 * and the robot reads it here — so unattended re-login needs no human.
 *
 * Source-agnostic by design: `recordAuthCode` takes a `source` ('email' today,
 * 'sms' later) and `fetchLatestAuthCode` reads whichever arrived, so an SMS
 * factor can be added without touching callers.
 *
 * NOT wired into the live Okta login recipe in this task. Plug-ready call site
 * (session-driver.ts, after detectMfaPrompt / before pauseForMfa):
 *
 *   const code = await fetchLatestAuthCode(propertyId, { notBefore: loginStartedAt });
 *   if (code) { await page.fill('input[name*="code" i]', code); ... }
 *   else { await pauseForMfa({ propertyId, ... }); }
 *
 * Single-use is enforced server-side by the claim_pms_auth_code() RPC
 * (atomic UPDATE ... FOR UPDATE SKIP LOCKED), so two concurrent fetchers can
 * never get the same code and a consumed code is never returned again — even
 * if the subsequent Okta submit fails.
 *
 * The `db` parameter defaults to the shared service-role client and exists so
 * these helpers are unit-testable with an injected fake (no mock framework).
 *
 * Log hygiene: NEVER log the code itself — only its length. (log.ts redacts by
 * key/pattern, but a 6-digit code matches neither, so it must never be passed.)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from './log.js';
import type { FetchAuthCodeOptions, RecordAuthCodeInput } from './types.js';

/**
 * Lazily resolve the shared service-role client. Dynamic-imported (not a
 * top-level import) so unit tests — which always inject a fake `db` — never
 * trigger createClient(), whose RealtimeClient throws on Node < 22 without a
 * `ws` transport. Production callers omit `db` and get the singleton (the
 * module caches it after first import).
 */
async function defaultClient(): Promise<SupabaseClient> {
  const { supabase } = await import('./supabase.js');
  return supabase;
}

const DEFAULT_MAX_AGE_SECONDS = 180;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Store a one-time code (source-agnostic). The email path is normally written
 * by the Next.js webhook; this exists for the future SMS path and for tests.
 * A duplicate (unique raw_ref) is treated as success — idempotent re-delivery.
 */
export async function recordAuthCode(
  input: RecordAuthCodeInput,
  db?: SupabaseClient,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = db ?? (await defaultClient());
  const { error } = await client.from('pms_auth_codes').insert({
    property_id: input.propertyId,
    email_to: input.emailTo,
    source: input.source ?? 'email',
    code: input.code,
    sender: input.sender ?? null,
    subject: input.subject ?? null,
    raw_ref: input.rawRef ?? null,
  });

  if (error) {
    // 23505 = unique_violation on raw_ref → a duplicate delivery of the same
    // message. The code is already stored; treat as success.
    if ((error as { code?: string }).code === '23505') {
      log.info('auth-code-helpers: duplicate code ignored (raw_ref dedup)', {
        propertyId: input.propertyId,
      });
      return { ok: true };
    }
    log.error('auth-code-helpers: recordAuthCode insert failed', {
      propertyId: input.propertyId,
      err: error.message,
    });
    return { ok: false, error: error.message };
  }

  log.info('auth-code-helpers: recorded code', {
    propertyId: input.propertyId,
    source: input.source ?? 'email',
    codeLen: input.code.length,
  });
  return { ok: true };
}

/**
 * Poll for and atomically consume the newest unconsumed, non-expired code for
 * a property. Returns the code, or null on timeout. Single-use: the claimed
 * row is marked consumed and will never be returned again.
 */
export async function fetchLatestAuthCode(
  propertyId: string,
  opts: FetchAuthCodeOptions = {},
  db?: SupabaseClient,
): Promise<string | null> {
  const client = db ?? (await defaultClient());
  const maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const notBefore = opts.notBefore ?? null;
  const deadline = Date.now() + timeoutMs;
  let polls = 0;

  log.info('auth-code-helpers: waiting for auth code', {
    propertyId,
    maxAgeSeconds,
    timeoutMs,
    pollMs,
  });

  for (;;) {
    polls += 1;
    const { data, error } = await client.rpc('claim_pms_auth_code', {
      p_property_id: propertyId,
      p_max_age_seconds: maxAgeSeconds,
      p_not_before: notBefore,
    });

    if (error) {
      // Transient DB error — log and keep polling until the deadline rather
      // than aborting a login on one hiccup.
      log.warn('auth-code-helpers: claim rpc errored', {
        propertyId,
        err: error.message,
      });
    } else {
      const rows = (Array.isArray(data) ? data : data ? [data] : []) as Array<{
        id?: string;
        code?: string;
      }>;
      const code = rows[0]?.code;
      if (typeof code === 'string' && code.length > 0) {
        log.info('auth-code-helpers: claimed code', {
          propertyId,
          polls,
          codeLen: code.length,
        });
        return code;
      }
    }

    // Stop if the next sleep would run past the deadline (guarantees ≥1 attempt).
    if (Date.now() + pollMs >= deadline) {
      log.warn('auth-code-helpers: timed out waiting for auth code', {
        propertyId,
        polls,
        timeoutMs,
      });
      return null;
    }
    await sleep(pollMs);
  }
}
