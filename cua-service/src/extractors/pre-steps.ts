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

export type PreStep =
  | { kind: 'click'; selector: string; timeoutMs?: number }
  | { kind: 'click_at'; x: number; y: number }
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
 *  hand-written knowledge files that bypass the adapter's derivation. */
const CREDENTIAL_SELECTOR_RE = /passw|pwd|secret|token|apikey|api[-_]key/i;

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
      case 'click':
        if (typeof s.selector !== 'string' || s.selector === '') return bad('selector');
        steps.push({ kind: 'click', selector: s.selector, ...(typeof s.timeoutMs === 'number' ? { timeoutMs: s.timeoutMs } : {}) });
        break;
      case 'click_at':
        if (typeof s.x !== 'number' || typeof s.y !== 'number') return bad('x/y');
        steps.push({ kind: 'click_at', x: s.x, y: s.y });
        break;
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

/** Replay validated pre-steps in order on the current page. */
export async function replayPreSteps(
  page: Page,
  steps: PreStep[],
  signal?: AbortSignal,
): Promise<ReplayResult> {
  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) {
      return { ok: false, failedStepIndex: i, failedStepKind: steps[i]!.kind, reason: 'aborted' };
    }
    const step = steps[i]!;
    try {
      switch (step.kind) {
        case 'click':
          await page.click(step.selector, { timeout: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
          break;
        case 'click_at':
          await page.mouse.click(step.x, step.y);
          break;
        case 'select':
          await page.selectOption(step.selector, step.value, { timeout: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
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
          await page.fill(step.selector, step.value, { timeout: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
          break;
        case 'type_text':
          if (isCredentialValue(step.value)) {
            log.warn('pre-steps: skipping type_text that references credentials (never replayed in extraction)', { stepIndex: i });
            break;
          }
          await page.keyboard.type(step.value);
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
