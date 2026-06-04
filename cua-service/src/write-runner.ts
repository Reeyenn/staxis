/**
 * Write-runner core (Phase 3.1) — replay a signed write recipe against a
 * logged-in page and VERIFY the change actually landed. Deterministic
 * Playwright only — NO Claude.
 *
 * `executeWriteRecipe` is the pure, DB-free engine (testable against the
 * mock PMS). The DB-backed handler (gate flags, fail-closed signature
 * verify, load recipe, persist source='workflow' + echo, run under the
 * exclusive mutex) is wired in Phase 3.2 where its tables exist.
 *
 * Safety properties (Codex adversarial review):
 *   - Wrong-room (P0-3): rows located by EXACT text, one-match-asserted.
 *   - Verify-after-write: we NEVER claim success without confirming — an
 *     in-page assert AND an authoritative re-read (reload + re-assert).
 *   - Fail-closed: bad payload / session-expired / unverifiable -> ok:false,
 *     and the mock/real PMS is left untouched on any pre-commit failure.
 *   - Idempotent: a row already at the target short-circuits (safe retries).
 */

import type { Locator, Page } from 'playwright';
import { safeGoto } from './browser-utils/navigate.js';
import { log } from './log.js';
import { locateRowByExactText, resolvePayloadValue, runWriteStep } from './write-steps.js';
import type { WriteActionRecipe, WriteStep } from './types.js';

const PAGE_GOTO_TIMEOUT_MS = 30_000;
const LOGGED_IN_TIMEOUT_MS = 8_000;

export interface ExecuteWriteOpts {
  /** When true, replay everything EXCEPT the final Save (no mutation, no verify). */
  dryRun: boolean;
  /** Pin navigation to this host (the PMS domain). null = unpinned (login anchor). */
  allowedHost?: string | null;
  /** Test-only loopback allowance for the mock-PMS harness. Never set in prod. */
  allowLoopback?: boolean;
  /** Cancellation from the workflow timeout. Checked between phases/steps so a
   *  timed-out write stops promptly and releases the browser mutex. */
  signal?: AbortSignal;
}

export type ExecuteWriteResult =
  | { ok: true; verifiedVia: 'reread' | 'in_page' | 'idempotent' | 'dry_run' }
  | { ok: false; error: string; detail?: Record<string, unknown> };

type VerifySpec = NonNullable<WriteActionRecipe['verifyInPage']>;

/** Build a concrete assert_text step from a verify spec, resolving any
 *  $payload placeholders in equals/contains. */
function verifyStep(spec: VerifySpec, payload: Record<string, string>): WriteStep {
  return {
    kind: 'assert_text',
    selector: spec.selector,
    scope: spec.scope,
    equals: spec.equals !== undefined ? resolvePayloadValue(spec.equals, payload) : undefined,
    contains: spec.contains !== undefined ? resolvePayloadValue(spec.contains, payload) : undefined,
    timeoutMs: spec.timeoutMs,
  };
}

async function passesVerify(
  page: Page,
  rowLocator: Locator,
  spec: VerifySpec,
  payload: Record<string, string>,
): Promise<boolean> {
  try {
    await runWriteStep(page, verifyStep(spec, payload), { payload, rowLocator, dryRun: false });
    return true;
  } catch {
    return false;
  }
}

export async function executeWriteRecipe(
  page: Page,
  recipe: WriteActionRecipe,
  rawPayload: Record<string, string>,
  opts: ExecuteWriteOpts,
): Promise<ExecuteWriteResult> {
  // 1. Payload validation — fail closed BEFORE touching the browser. Validate
  //    the ORIGINAL (internal) values against the recipe's param enums.
  for (const p of recipe.requiredParams) {
    const v = rawPayload[p];
    if (v === undefined || v === null || v === '') {
      return { ok: false, error: 'bad_payload', detail: { missing: p } };
    }
  }
  if (recipe.paramEnums) {
    for (const [k, allowed] of Object.entries(recipe.paramEnums)) {
      const v = rawPayload[k];
      if (v !== undefined && v !== '' && !allowed.includes(v)) {
        return { ok: false, error: 'bad_payload', detail: { badEnum: k, value: v } };
      }
    }
  }

  // Map internal values -> the PMS's on-screen strings (e.g. 'vacant_clean' ->
  // 'Clean') for the browser interaction + in-page verify. The caller's
  // original payload is untouched, so the handler still records the internal
  // value to pms_room_status_log / pms_sync_echo.
  const payload: Record<string, string> = recipe.valueMap
    ? Object.fromEntries(Object.entries(rawPayload).map(([k, v]) => [k, recipe.valueMap?.[v] ?? v]))
    : rawPayload;

  const gotoOpts = {
    allowedHost: opts.allowedHost ?? null,
    context: 'write-runner:goto',
    allowLoopback: opts.allowLoopback,
    timeoutMs: PAGE_GOTO_TIMEOUT_MS,
  };

  // 2. Navigate to the editable page.
  try {
    await safeGoto(page, recipe.pageUrl, gotoOpts);
  } catch (err) {
    return { ok: false, error: 'goto_failed', detail: { message: (err as Error).message } };
  }

  // 3. Session guard — fail closed if not on a logged-in page (Codex P1-6).
  if (recipe.loggedInSelector) {
    try {
      await page.waitForSelector(recipe.loggedInSelector, { timeout: LOGGED_IN_TIMEOUT_MS });
    } catch {
      return { ok: false, error: 'session_expired', detail: { loggedInSelector: recipe.loggedInSelector } };
    }
  }

  // 4. Locate exactly ONE row (exact text — wrong-room guard).
  let row: Locator;
  try {
    row = await locateRowByExactText(page, recipe.rowLocator, payload);
  } catch (err) {
    return { ok: false, error: 'row_locate_failed', detail: { message: (err as Error).message } };
  }

  if (opts.signal?.aborted) return { ok: false, error: 'aborted' };

  // 5a. Precondition — optional sanity guard against a stale overwrite (e.g.
  //     "only mark clean if currently dirty"). If declared and not met, refuse.
  if (recipe.precondition && !(await passesVerify(page, row, recipe.precondition, payload))) {
    return { ok: false, error: 'precondition_failed', detail: { selector: recipe.precondition.selector } };
  }

  // 5b. Idempotency short-circuit — if the row already shows the target, a
  //     retry (at-least-once delivery) must not re-mutate.
  if (!opts.dryRun && recipe.verifyInPage && (await passesVerify(page, row, recipe.verifyInPage, payload))) {
    return { ok: true, verifiedVia: 'idempotent' };
  }

  // 5c. Fail closed BEFORE mutating if the recipe is unverifiable. An
  //     unverifiable recipe must never replay the Save step — we'd mutate the
  //     PMS and still have to report failure (no way to confirm the change
  //     landed). A dry-run never mutates and never verifies, so it skips this.
  if (!opts.dryRun && !recipe.verifyInPage) {
    return { ok: false, error: 'no_verify_configured' };
  }

  // 6. Replay the edit steps.
  try {
    for (const step of recipe.steps) {
      if (opts.signal?.aborted) throw new Error('aborted');
      await runWriteStep(page, step, { payload, rowLocator: row, dryRun: opts.dryRun });
    }
  } catch (err) {
    return { ok: false, error: 'replay_failed', detail: { message: (err as Error).message } };
  }

  if (opts.dryRun) {
    return { ok: true, verifiedVia: 'dry_run' };
  }

  // The commit (Save) may have navigated the page; let it settle before we
  // re-locate for verification. `verifyInPage` is guaranteed present here — an
  // absent one fails closed at step 5c, before any mutation (this guard is a
  // type-narrowing no-op: step 5c already returned for the absent case).
  const verifyInPage = recipe.verifyInPage;
  if (!verifyInPage) return { ok: false, error: 'no_verify_configured' };
  await page.waitForLoadState('networkidle').catch(() => {});

  // 7. Layer 1 — in-page verify on a freshly-located row. When an authoritative
  //    re-read (Layer 2) follows, this is BEST-EFFORT: a Save that triggers a
  //    navigation can leave the page mid-transition, so a transient Layer-1
  //    miss must not fail the write — Layer 2 (a fresh reload) is the real
  //    gate (Codex P1, navigation-after-save race). When Layer 2 is disabled,
  //    Layer 1 becomes authoritative and MUST pass.
  let inPageOk = false;
  try {
    const row1 = await locateRowByExactText(page, recipe.rowLocator, payload);
    await runWriteStep(page, verifyStep(verifyInPage, payload), { payload, rowLocator: row1, dryRun: false });
    inPageOk = true;
  } catch (err) {
    log.warn('write-runner: in-page verify miss (relying on authoritative re-read)', {
      message: (err as Error).message,
    });
  }

  if (recipe.rereadAfterReload === false) {
    if (!inPageOk) return { ok: false, error: 'verify_in_page_failed' };
    return { ok: true, verifiedVia: 'in_page' };
  }

  // 8. Layer 2 — authoritative re-read: reload the page from the PMS and
  //    re-assert. Single-room scoped (never re-runs the full feed sweep).
  try {
    await safeGoto(page, recipe.pageUrl, gotoOpts);
    const row2 = await locateRowByExactText(page, recipe.rowLocator, payload);
    await runWriteStep(page, verifyStep(verifyInPage, payload), { payload, rowLocator: row2, dryRun: false });
  } catch (err) {
    return { ok: false, error: 'verify_reread_failed', detail: { message: (err as Error).message } };
  }

  return { ok: true, verifiedVia: 'reread' };
}
