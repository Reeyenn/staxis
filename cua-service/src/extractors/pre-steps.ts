/**
 * Pre-extraction step replay (Chat 1 plumbing).
 *
 * Some feeds need interaction BEFORE the data is reachable — the canonical
 * case is a csv_download feed where the mapper recorded a click-sequence to
 * open the report, set options, and generate the export. recipe-adapter
 * translates those recorded RecipeSteps into this module's `PreStep` shape
 * (carried on `source.extra.preSteps`) and the extractor replays them in
 * order on the already-navigated page.
 *
 * Deliberately NO navigation step here: every navigation in cua-service
 * must flow through safeGoto (Pattern B CI guard) — the extractor navigates
 * to feedSpec.url first, then replays these on that page.
 *
 * Security stance (matches recipe-runner's allowCredentialPlaceholders:false
 * and write-steps.ts): a fill/type_text whose value references $username or
 * $password is NEVER replayed — extraction must not be able to type real
 * credentials anywhere. Such steps are skipped with a warning (the adapter
 * already drops them; this is defense-in-depth for hand-written files).
 */

import type { Page } from 'playwright';
import { log } from '../log.js';
import type { LearnedDateFormat } from '../types.js';
import { renderDatePlaceholders } from './date-template.js';

export type PreStep =
  | { kind: 'click'; selector: string; roleName?: { role: string; name: string }; timeoutMs?: number }
  | { kind: 'click_at'; x: number; y: number; roleName?: { role: string; name: string } }
  | { kind: 'select'; selector: string; value: string; timeoutMs?: number }
  | { kind: 'fill'; selector: string; value: string; timeoutMs?: number }
  | { kind: 'type_text'; value: string }
  | { kind: 'press_key'; key: string }
  | { kind: 'wait_for'; selector: string; timeoutMs?: number }
  | { kind: 'wait_ms'; ms: number };

export interface ReplayResult {
  ok: boolean;
  /** Index + kind of the step that failed (when ok=false). */
  failedStepIndex?: number;
  failedStepKind?: string;
  reason?: string;
}

const DEFAULT_STEP_TIMEOUT_MS = 10_000;
/** Defensive caps — a degenerate/poisoned step list must not stall a poll. */
const MAX_PRE_STEPS = 50;
const MAX_WAIT_MS = 30_000;

function isCredentialValue(value: string): boolean {
  return value.includes('$username') || value.includes('$password');
}

/** Mirror of recipe-adapter's CREDENTIAL_SELECTOR_RE — defense-in-depth for
 *  hand-written knowledge files that bypass the adapter's derivation.
 *  `token(?![a-z0-9])` avoids false-positives on benign compounds like
 *  '#tokenizedSearch' while still catching '#csrf-token'/'#csrf_token'. */
const CREDENTIAL_SELECTOR_RE = /passw|pwd|secret|api[-_]?key|token(?![a-z0-9])/i;

/** Validate an optional roleName {role,name} off a raw step object. */
function parseRoleName(s: Record<string, unknown>): { role: string; name: string } | undefined {
  const rn = s.roleName as { role?: unknown; name?: unknown } | undefined;
  if (rn && typeof rn.role === 'string' && rn.role !== '' && typeof rn.name === 'string' && rn.name !== '') {
    return { role: rn.role, name: rn.name };
  }
  return undefined;
}

/**
 * Click a recorded target durably. Prefers the ARIA role+accessible-name the
 * mapper recorded (survives viewport size, data volume, banners, and per-tenant
 * chrome — a family recipe is replayed across every hotel), falling back to a
 * css selector, then to the recorded pixel coordinate. Raw-pixel-only was the
 * old behavior and the prime cross-PMS drift source.
 */
async function clickRecorded(
  page: Page,
  target: { roleName?: { role: string; name: string }; selector?: string; x?: number; y?: number },
  timeoutMs: number,
): Promise<void> {
  if (target.roleName?.name) {
    try {
      await page
        .getByRole(target.roleName.role as Parameters<Page['getByRole']>[0], { name: target.roleName.name, exact: false })
        .first()
        .click({ timeout: timeoutMs });
      return;
    } catch {
      // fall through to selector / coordinate
    }
  }
  if (target.selector) {
    await page.click(target.selector, { timeout: timeoutMs });
    return;
  }
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    await page.mouse.click(target.x, target.y);
    return;
  }
  throw new Error('clickRecorded: no roleName, selector, or coordinate to click');
}

/** Best-effort settle after an interaction that may navigate. A menu click that
 *  swaps the page must finish loading before the next click/scrape; an in-page
 *  click leaves networkidle already satisfied so this returns fast. Bounded so a
 *  chatty page can't stall the poll. */
async function settleAfterClick(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
}

/**
 * Parse an untyped `extra.preSteps` payload (jsonb from the knowledge file)
 * into validated PreSteps. Malformed entries make the WHOLE list invalid —
 * a half-replayed interaction sequence would leave the page in an unknown
 * state, worse than failing loudly.
 */
export function parsePreSteps(raw: unknown): { ok: true; steps: PreStep[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, steps: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: 'preSteps is not an array' };
  if (raw.length > MAX_PRE_STEPS) {
    return { ok: false, reason: `preSteps has ${raw.length} steps; cap is ${MAX_PRE_STEPS}` };
  }
  const steps: PreStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || typeof s.kind !== 'string') {
      return { ok: false, reason: `preSteps[${i}] is not a step object` };
    }
    const bad = (field: string) => ({ ok: false as const, reason: `preSteps[${i}] (${s.kind}) missing/invalid "${field}"` });
    switch (s.kind) {
      case 'click': {
        if (typeof s.selector !== 'string' || s.selector === '') return bad('selector');
        const rn = parseRoleName(s);
        steps.push({ kind: 'click', selector: s.selector, ...(rn ? { roleName: rn } : {}), ...(typeof s.timeoutMs === 'number' ? { timeoutMs: s.timeoutMs } : {}) });
        break;
      }
      case 'click_at': {
        if (typeof s.x !== 'number' || typeof s.y !== 'number') return bad('x/y');
        const rn = parseRoleName(s);
        steps.push({ kind: 'click_at', x: s.x, y: s.y, ...(rn ? { roleName: rn } : {}) });
        break;
      }
      case 'select':
        if (typeof s.selector !== 'string' || s.selector === '') return bad('selector');
        if (typeof s.value !== 'string') return bad('value');
        steps.push({ kind: 'select', selector: s.selector, value: s.value });
        break;
      case 'fill':
        if (typeof s.selector !== 'string' || s.selector === '') return bad('selector');
        if (typeof s.value !== 'string') return bad('value');
        steps.push({ kind: 'fill', selector: s.selector, value: s.value });
        break;
      case 'type_text':
        if (typeof s.value !== 'string') return bad('value');
        steps.push({ kind: 'type_text', value: s.value });
        break;
      case 'press_key':
        if (typeof s.key !== 'string' || s.key === '') return bad('key');
        steps.push({ kind: 'press_key', key: s.key });
        break;
      case 'wait_for':
        if (typeof s.selector !== 'string' || s.selector === '') return bad('selector');
        steps.push({ kind: 'wait_for', selector: s.selector, ...(typeof s.timeoutMs === 'number' ? { timeoutMs: s.timeoutMs } : {}) });
        break;
      case 'wait_ms':
        if (typeof s.ms !== 'number' || s.ms < 0) return bad('ms');
        steps.push({ kind: 'wait_ms', ms: Math.min(s.ms, MAX_WAIT_MS) });
        break;
      default:
        return { ok: false, reason: `preSteps[${i}] has unknown kind "${s.kind}"` };
    }
  }
  return { ok: true, steps };
}

export interface ReplayOptions {
  signal?: AbortSignal;
  /** Learned PMS date format + hotel TZ — lets fill/select/type_text values
   *  carry {today}/{date} placeholders (a report date-range filter recorded
   *  on mapping day must re-render each poll, same stale-date guard as
   *  fetch-api). Raw substitution, no percent-encoding: the value is typed
   *  into a form field, not spliced into a URL. */
  learnedFormat?: LearnedDateFormat;
  timezone?: string;
  /** Injectable clock (tests). Defaults to the real current time. */
  now?: Date;
}

/** Replay validated pre-steps in order on the current page. */
export async function replayPreSteps(
  page: Page,
  steps: PreStep[],
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const { signal } = opts;
  // ONE clock for the whole sequence — a replay straddling local midnight
  // must not type yesterday's date in one field and today's in the next.
  const now = opts.now ?? new Date();
  const renderValue = (raw: string): string =>
    renderDatePlaceholders(raw, {
      context: 'json',
      learnedFormat: opts.learnedFormat,
      timezone: opts.timezone,
      now,
    });
  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) {
      return { ok: false, failedStepIndex: i, failedStepKind: steps[i]!.kind, reason: 'aborted' };
    }
    const step = steps[i]!;
    try {
      switch (step.kind) {
        case 'click':
          await clickRecorded(page, { roleName: step.roleName, selector: step.selector }, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
          await settleAfterClick(page);
          break;
        case 'click_at':
          await clickRecorded(page, { roleName: step.roleName, x: step.x, y: step.y }, DEFAULT_STEP_TIMEOUT_MS);
          await settleAfterClick(page);
          break;
        case 'select':
          // Credential check on the RAW value first, render after — a
          // placeholder must never mask a recorded secret.
          await page.selectOption(step.selector, renderValue(step.value), { timeout: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
          break;
        case 'fill':
          if (isCredentialValue(step.value)) {
            log.warn('pre-steps: skipping fill that references credentials (never replayed in extraction)', { stepIndex: i });
            break;
          }
          if (CREDENTIAL_SELECTOR_RE.test(step.selector)) {
            log.warn('pre-steps: skipping fill into a credential-looking field', { stepIndex: i, selector: step.selector });
            break;
          }
          await page.fill(step.selector, renderValue(step.value), { timeout: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
          break;
        case 'type_text':
          if (isCredentialValue(step.value)) {
            log.warn('pre-steps: skipping type_text that references credentials (never replayed in extraction)', { stepIndex: i });
            break;
          }
          await page.keyboard.type(renderValue(step.value));
          break;
        case 'press_key':
          await page.keyboard.press(step.key);
          break;
        case 'wait_for':
          await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
          break;
        case 'wait_ms':
          await page.waitForTimeout(Math.min(step.ms, MAX_WAIT_MS));
          break;
      }
    } catch (err) {
      return {
        ok: false,
        failedStepIndex: i,
        failedStepKind: step.kind,
        reason: `pre-step ${i} (${step.kind}) failed: ${(err as Error).message}`,
      };
    }
  }
  return { ok: true };
}
