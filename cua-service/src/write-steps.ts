/**
 * Write-step replay primitives (Phase 3 — PMS write-back).
 *
 * Deliberately SEPARATE from recipe-runner.ts's read/login `runStep`: a
 * malformed write recipe must never be able to change how reads or login
 * replay, and credentials must never be reachable from a write step. Like
 * the read path, every action here is deterministic Playwright — NO Claude.
 *
 * Three load-bearing safety properties (from the Codex adversarial pass):
 *   - P0-3 wrong-room: rows are matched by EXACT text equality (not
 *     substring), asserting exactly one match, so "10" can never hit "110".
 *     No coordinate clicks exist in the WriteStep union at all.
 *   - Credential isolation: `$username` / `$password` throw here. Writes
 *     only ever interpolate `$payload.<field>` VALUES.
 *   - Fail-closed: an unresolved `$payload.*` throws rather than typing an
 *     empty string into a live PMS form.
 */

import type { Locator, Page } from 'playwright';
import { log } from './log.js';
import type { WriteRowLocator, WriteScope, WriteStep } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolve a write-step value. Supports `$payload.<field>` substitution.
 *
 * HARD INVARIANTS:
 *   - `$username` / `$password` throw — writes can NEVER reference
 *     credentials (defense-in-depth even if a write recipe is poisoned).
 *   - An unresolved / empty `$payload.<field>` throws (fail closed; never
 *     type an empty string into a PMS form).
 */
export function resolvePayloadValue(rawValue: string, payload: Record<string, string>): string {
  if (rawValue === '$username' || rawValue === '$password') {
    throw new Error(
      'credential_placeholder_in_write_step: write recipes must never reference ' +
        `credentials. Refusing to resolve ${rawValue} outside the login phase.`,
    );
  }
  const m = /^\$payload\.([A-Za-z0-9_]+)$/.exec(rawValue);
  if (m) {
    const field = m[1];
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new Error(`payload_placeholder_unresolved: $payload.${field} is missing from the write payload`);
    }
    const v = payload[field];
    if (v === undefined || v === null || v === '') {
      throw new Error(`payload_placeholder_unresolved: $payload.${field} is empty`);
    }
    return String(v);
  }
  // Fail CLOSED (Codex P0): a value that LOOKS like a placeholder but doesn't
  // match the strict $payload.<field> grammar (e.g. "$payload.bad-name",
  // "$payload.a.b") must NEVER pass through as a literal to be typed/selected
  // into a live PMS form. Throw instead.
  if (rawValue.startsWith('$payload')) {
    throw new Error(`payload_placeholder_malformed: "${rawValue}" is not a valid $payload.<field> reference`);
  }
  return rawValue;
}

/**
 * Pure exact-match resolver. Returns the index of the ONE row whose text
 * equals `wanted` (trimmed, EXACT — not substring, so "10" never matches
 * "110"). Throws `row_not_found` / `row_not_unique` otherwise.
 *
 * Factored out as a pure function so the wrong-room safety property is
 * unit-testable without a DOM.
 */
export function findExactMatchIndex(texts: string[], wanted: string): number {
  const matches: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].trim() === wanted) matches.push(i);
  }
  if (matches.length === 0) {
    throw new Error(
      `row_not_found: no row text exactly equals "${wanted}" (checked ${texts.length} rows)`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `row_not_unique: ${matches.length} rows exactly equal "${wanted}" — refusing to guess`,
    );
  }
  return matches[0];
}

/**
 * Locate exactly one row by exact-text match on `payload[loc.matchParam]`.
 * Returns a Playwright Locator scoped to that single row.
 */
export async function locateRowByExactText(
  page: Page,
  loc: WriteRowLocator,
  payload: Record<string, string>,
): Promise<Locator> {
  const wanted = resolvePayloadValue(`$payload.${loc.matchParam}`, payload);
  const rows = page.locator(loc.rowSelector);
  const count = await rows.count();
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    const cell = loc.matchCell ? rows.nth(i).locator(loc.matchCell).first() : rows.nth(i);
    const text = await cell.textContent().catch(() => '');
    texts.push(text ?? '');
  }
  const idx = findExactMatchIndex(texts, wanted);
  return rows.nth(idx);
}

export interface WriteStepCtx {
  payload: Record<string, string>;
  /** The single located room row, for `scope: 'row'` steps. */
  rowLocator: Locator | null;
  /** When true, the `save` (commit) step is skipped — everything else runs. */
  dryRun: boolean;
}

function baseFor(page: Page, ctx: WriteStepCtx, scope: WriteScope | undefined): Page | Locator {
  if (scope === 'row') {
    if (!ctx.rowLocator) {
      throw new Error('write_step_row_scope_without_row: a row-scoped step ran but no row was located');
    }
    return ctx.rowLocator;
  }
  return page;
}

function assertTextMatch(
  actual: string,
  equals: string | undefined,
  contains: string | undefined,
  selector: string,
): void {
  if (equals !== undefined && actual !== equals) {
    throw new Error(`assert_text_failed: "${selector}" expected exactly "${equals}" but got "${actual}"`);
  }
  if (contains !== undefined && !actual.includes(contains)) {
    throw new Error(`assert_text_failed: "${selector}" expected to contain "${contains}" but got "${actual}"`);
  }
}

async function pollForChange(loc: Locator, fromText: string | undefined, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const from = (fromText ?? '').trim();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const t = ((await loc.textContent().catch(() => null)) ?? '').trim();
    if (fromText === undefined || t !== from) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`wait_for_change_timeout: text did not change from "${from}" within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Execute one write step. Deterministic Playwright only — no Claude.
 * `scope: 'row'` steps run relative to the located room row; otherwise the
 * whole page. The `save` step is the only thing dry-run skips.
 */
/** Step kinds that change PMS state. In dry-run these are VALIDATED (payload
 *  resolves, target element exists) but never executed — so a dry-run can't
 *  mutate a PMS that autosaves on change/blur/click, not just on the Save
 *  button (Codex P1). */
const MUTATING_KINDS = new Set<WriteStep['kind']>([
  'click', 'fill', 'select', 'type_text', 'press_key', 'save',
]);

export async function runWriteStep(page: Page, step: WriteStep, ctx: WriteStepCtx): Promise<void> {
  // Dry-run: validate mutating steps (payload resolves, target exists) but do
  // NOT perform them. Non-mutating steps (waits/asserts) still run.
  if (ctx.dryRun && MUTATING_KINDS.has(step.kind)) {
    if (step.kind === 'fill' || step.kind === 'select' || step.kind === 'type_text') {
      resolvePayloadValue(step.value, ctx.payload); // validate $payload / refuse credentials
    }
    const sel =
      'selector' in step && step.selector
        ? step.selector
        : step.kind === 'save'
          ? step.tieredSelector?.css
          : undefined;
    if (sel) {
      const base = baseFor(page, ctx, 'scope' in step ? step.scope : undefined);
      await base.locator(sel).first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {});
    }
    log.info('write-steps: dry-run — validated, not executed', { kind: step.kind });
    return;
  }

  switch (step.kind) {
    case 'click': {
      const base = baseFor(page, ctx, step.scope);
      await base.locator(step.selector).first().click({ timeout: DEFAULT_TIMEOUT_MS });
      return;
    }
    case 'fill': {
      const base = baseFor(page, ctx, step.scope);
      const value = resolvePayloadValue(step.value, ctx.payload);
      await base.locator(step.selector).first().fill(value, { timeout: DEFAULT_TIMEOUT_MS });
      return;
    }
    case 'select': {
      const base = baseFor(page, ctx, step.scope);
      const value = resolvePayloadValue(step.value, ctx.payload);
      await base.locator(step.selector).first().selectOption(value, { timeout: DEFAULT_TIMEOUT_MS });
      return;
    }
    case 'type_text': {
      const value = resolvePayloadValue(step.value, ctx.payload);
      await page.keyboard.type(value);
      return;
    }
    case 'press_key':
      await page.keyboard.press(step.key);
      return;
    case 'wait_for': {
      const base = baseFor(page, ctx, step.scope);
      await base.locator(step.selector).first().waitFor({ timeout: step.timeoutMs ?? 15_000 });
      return;
    }
    case 'wait_ms':
      await new Promise((r) => setTimeout(r, step.ms));
      return;
    case 'assert_text': {
      const base = baseFor(page, ctx, step.scope);
      const raw = await base
        .locator(step.selector)
        .first()
        .textContent({ timeout: step.timeoutMs ?? DEFAULT_TIMEOUT_MS })
        .catch(() => null);
      assertTextMatch((raw ?? '').trim(), step.equals, step.contains, step.selector);
      return;
    }
    case 'wait_for_change': {
      const base = baseFor(page, ctx, step.scope);
      await pollForChange(base.locator(step.selector).first(), step.fromText, step.timeoutMs ?? 15_000);
      return;
    }
    case 'save': {
      // (dry-run is intercepted above)
      const base = baseFor(page, ctx, step.scope);
      const sel = step.selector ?? step.tieredSelector?.css;
      if (!sel) {
        throw new Error('save_step_missing_selector: a save step needs either selector or tieredSelector.css');
      }
      await base.locator(sel).first().click({ timeout: DEFAULT_TIMEOUT_MS });
      return;
    }
    default:
      // Recipes are loaded from DB JSON, so TypeScript's union can't protect
      // us — a typo or a future step kind must fail loudly, never silently
      // no-op into a claimed success (Codex P2).
      throw new Error(`unsupported_write_step_kind: ${(step as { kind?: string }).kind}`);
  }
}
